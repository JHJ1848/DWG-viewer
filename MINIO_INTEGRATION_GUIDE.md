# CADLight 在线预览器 — 农田质量抽检系统 MinIO 接口对接与使用指南

> **对接目标**：支持 CADLight 核心引擎（WebAssembly + Worker + Three.js）直接加载并解析农田工程质量抽检系统 MinIO 库中归档的各类 DWG 图纸（如 `01俄洛镇格巴村总平图.dwg`、`0-2里土平整图集.dwg` 等）。

---

## 一、核心接口清单与请求规范

当前后端服务为 Spring Boot 架构，已提供稳定可靠的 MinIO 代理下载与预签名接口。

### 1. 核心接口 A：后端文件流直接代理（推荐首选，彻底免除 CORS 跨域问题）

- **后端服务基础地址**：`http://192.168.81.163:9008`
- **请求路由**：`GET /api/minio/get_file`
- **请求方法**：`GET`
- **查询参数 (Query Parameters)**：
  | 参数名 | 类型 | 必填 | 说明 |
  | :--- | :--- | :--- | :--- |
  | **`path`** | `String` | **是** | MinIO 存储路径，格式严格为 `{bucketName}/{objectKey}`。<br>• 示例：`nonglintu/dwg/01俄洛镇格巴村总平图.dwg`<br>• 注意：路径含中文与斜杠，建议使用标准 URL 编码。 |
  | **`preview`** | `Boolean`| 否 | 传 `true`，显式声明为在线预览模式。 |
  | **`inline`** | `Boolean` | 否 | 传 `true`，响应头 `Content-Disposition` 将置为 `inline`，直接由浏览器以流式方式接收。 |

- **鉴权请求头 (Headers)**：
  - **`satoken: <用户登录Token>`**  
    > ⚠️ **关键注意**：系统采用 **Sa-Token** 权限框架，鉴权请求头的 Key 是 **`satoken`**（全小写），**不是**标准的 `Authorization: Bearer ...`。

- **响应格式**：
  - 二进制字节流 `application/octet-stream`（或对应 MIME）；
  - 响应头包含真实 **`Content-Length`**，用于前端通过 `ReadableStream` 实时计算下载进度百分比与传输速率。

---

### 2. 核心接口 B：获取 MinIO 预签名/临时直链（大文件直连备选方案）

- **请求路由**：`GET /api/minio/get_file_url`
- **请求参数**：`path={bucketName}/{objectKey}`，如 `path=nonglintu/dwg/01俄洛镇格巴村总平图.dwg`
- **鉴权请求头**：`satoken: <用户登录Token>`
- **响应体**：纯文本字符串 URL（带预签名凭证的 MinIO S3 直连地址 `http://minio-test.adas.com:9000/...`）。若 MinIO 端开启了 CORS，可直接 fetch 该地址。

---

## 二、关键避坑点：MinIO Console 控制台 URL 智能转换

### 1. 问题分析
在实际业务场景中，业务人员或开发人员经常直接从浏览器中复制 MinIO 控制台（Console，默认端口 9090）的网页地址：  
`http://minio-test.adas.com:9090/browser/nonglintu/dwg%2F01%E4%BF%84%E6%B4%9B%E9%95%87%E6%A0%BC%E5%B7%B4%E6%9D%91%E6%80%BB%E5%B9%B3%E5%9B%BE.dwg`

> ⚠️ **高危陷阱**：该地址是 MinIO Console 的单页应用（SPA）前端页面路由，若直接通过 `fetch(url)` 请求，服务端返回的是一段 HTML 页面代码（`<!doctype html>...`），而不是 DWG 二进制文件，会导致 `dwgValidation.ts` 报文件头签名错误（未检测到 `AC10xx`）！

### 2. 智能转换实现代码（请直接集成到你的 URL 解析模块中）

```typescript
/**
 * 将任意形态的 MinIO URL 或路径，智能归一化为后端可调用的代理流路径
 * @param inputUrl 用户输入的地址或 MinIO 控制台路径
 * @param apiBaseUrl 后端服务基础路径（若配置了 Vite Proxy，通常为 '' 或 '/api'）
 */
export function resolveMinioDwgUrl(inputUrl: string, apiBaseUrl = ''): string {
  const trimmed = (inputUrl || '').trim();
  if (!trimmed) return '';

  // 1. 匹配并提取 MinIO Console 路径：:9090/browser/:bucket/:encodedObjectKey
  const consoleMatch = trimmed.match(/(?:https?:\/\/[^/]+:9090)?\/browser\/([^/]+)\/(.+)$/);
  if (consoleMatch) {
    const bucket = consoleMatch[1];
    // 解码 dwg%2F01... 为 dwg/01...
    const objectKey = decodeURIComponent(consoleMatch[2]);
    const fullPath = `${bucket}/${objectKey}`;
    return `${apiBaseUrl}/api/minio/get_file?path=${encodeURIComponent(fullPath)}&preview=true&inline=true`;
  }

  // 2. 匹配纯相对路径（如 nonglintu/dwg/01.dwg 或 /nonglintu/dwg/01.dwg）
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    const cleanPath = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    return `${apiBaseUrl}/api/minio/get_file?path=${encodeURIComponent(cleanPath)}&preview=true&inline=true`;
  }

  // 3. 已是完整 HTTP API 地址，直接返回
  return trimmed;
}
```

---

## 三、前端 Fetch 加载实现示例（带 satoken 鉴权与进度监听）

在你的 `src/core/dwgViewerEngine.ts` 或对应加载函数中按如下方式使用：

```typescript
/**
 * 通过 MinIO 代理流加载 DWG 二进制数据
 */
export async function fetchDwgBinary(
  rawUrl: string,
  satoken?: string,
  onProgress?: (percent: number, loaded: number, total: number) => void
): Promise<ArrayBuffer> {
  const targetUrl = resolveMinioDwgUrl(rawUrl);

  const headers: Record<string, string> = {};
  if (satoken) {
    headers['satoken'] = satoken; // 注入 Sa-Token 鉴权头
  }

  const response = await fetch(targetUrl, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(`获取 DWG 失败: HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length')) || 0;
  if (!response.body || contentLength === 0) {
    // 降级全量返回
    return await response.arrayBuffer();
  }

  // 流式读取以支持下载进度感知
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      receivedBytes += value.length;
      if (onProgress && contentLength > 0) {
        const pct = Math.min(100, Math.round((receivedBytes / contentLength) * 100));
        onProgress(pct, receivedBytes, contentLength);
      }
    }
  }

  // 合并 chunks
  const fullBuffer = new Uint8Array(receivedBytes);
  let position = 0;
  for (const chunk of chunks) {
    fullBuffer.set(chunk, position);
    position += chunk.length;
  }

  return fullBuffer.buffer;
}
```

---

## 四、关于测试所需的 satoken 凭证

当前后端系统所有接口均受 Sa-Token 校验拦截。若你在当前 Demo 环境中本地启动（如 `localhost:3000`）联调测试真实的 MinIO 图纸下载，**可随时向用户申请提供一个有效可用的 `satoken`**，用户已明确表示可以协助提供有效 Token！
