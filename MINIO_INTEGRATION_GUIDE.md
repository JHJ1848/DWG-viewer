# CADLight 在线预览器 — 3种 DWG 图纸读取方式与 MinIO S3 直连指南

> **架构概览**：CADLight 在线预览器提供清晰、独立的 **3 种 DWG 图纸读取方式**，并已移除旧版 Spring Boot 代理及 `satoken` 依赖，全面升级为原生 **AWS S3 Signature V4 (AccessKey + SecretKey)** 签名直连架构。

---

## 一、3 种 DWG 图纸读取方式

顶栏集成了 **「三合一文件读取切换器」**，可在以下 3 种模式间一键切换：

### 方式 1：项目内置图纸 (`public/samples/` 目录)
- **后端扫描接口**：`GET /api/samples`
- **工作机制**：服务端自动扫描项目 `public/samples/` 目录下的所有 `.dwg` / `.dwg.cache.gz` 文件并按体积升序排列。
- **前端交互**：切换到「内置图纸」标签后，下拉列表展示 `public/samples/` 下的全部图纸、文件大小及是否已命中双层 Gzip 缓存（`⚡ Gzip` 徽标），支持一键刷新目录与点选秒开。

### 方式 2：MinIO S3 原生直连 (`路径 + AccessKey`)
- **后端接口**：
  - 状态与桶列表扫描：`GET /api/minio/status?prefix=dwg/`
  - 流式签名读取：`GET /api/minio/stream?path={bucket}/{objectKey}`
- **默认直连配置**：
  | 配置项 | 环境变量名 | 默认值 |
  | :--- | :--- | :--- |
  | **MinIO Endpoint** | `MINIO_ENDPOINT` | 空 |
  | **Access Key (公钥)** | `MINIO_ACCESS_KEY` | 空 |
  | **Secret Key (密钥)** | `MINIO_SECRET_KEY` | 空 |
  | **默认存储桶 (Bucket)** | `MINIO_BUCKET` | 空 |
- **动态密钥与路径切换**：
  - 点击「MinIO 直连」栏右侧的 **`AccessKey`** 按钮可展开配置面板，实时查看或修改 `Endpoint`、`Access Key`、`Secret Key`、`Bucket`，并点击「测试连通 & 刷新列表」。
  - `/api/minio/status` 与 `/api/minio/stream` 均支持通过请求头（`x-minio-endpoint`、`x-minio-access-key`、`x-minio-secret-key`、`x-minio-bucket`）或同名 Query 参数动态传入自定义凭证。

### 方式 3：本地文件上传 (`点击选择 / 拖拽上传`)
- **支持格式**：AutoCAD `.dwg` 原始二进制图纸，或本工具导出的 `.dwg.cache.gz` 压缩缓存包。
- **前端交互**：切换到「本地上传」标签点击上传按钮，或在任意模式下直接将本机文件拖拽至 WebGL 画布区域即可直接解析渲染。

---

## 二、多形态 MinIO 地址智能归一化 (`resolveMinioDwgUrl`)

在输入框或通过 URL 参数 `?url=...` 传入以下任意形态的地址时，`src/utils/dwgValidation.ts` 中的 `resolveMinioDwgUrl()` 会自动将其归一化为 `/api/minio/stream?path=...`：

1. **MinIO 相对对象路径**：
   - 输入：`drawings/dwg/sample.dwg` 或 `dwg/sample.dwg`
   - 归一化结果：`/api/minio/stream?path=drawings%2Fdwg%2Fsample.dwg`
2. **MinIO Console 控制台网页地址（端口 9090）**：
   - 输入：`http://storage.example.invalid:9090/browser/drawings/dwg%2Fsample.dwg`
   - 归一化结果：自动提取 `bucket` 与解码后的 `objectKey`，转换为 `/api/minio/stream?path=...`。
3. **MinIO S3 未签名直连地址（端口 9000）**：
   - 输入：`http://storage.example.invalid:9000/drawings/dwg/01.dwg`
   - 归一化结果：`/api/minio/stream?path=drawings%2Fdwg%2F01.dwg`（若已含 `X-Amz-Signature=` 预签名参数则直接原样请求）。
