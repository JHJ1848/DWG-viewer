# CADLight DWG 预览核心 — 技术路线、项目结构与各文件职责分工

> 本文档与根目录 `README.md` 同步维护，专门用于梳理当前 DWG 在线预览项目的技术架构、全链路数据流、目录结构与各文件模块职责分工，方便整包下载后直接查阅与交接。

---

## 一、DWG 预览整体技术路线（四层架构）

本项目采用 **“纯浏览器端 WebAssembly 二进制解码 + Web Worker 多线程异步转换 + Three.js WebGL 硬件加速二维渲染”** 的技术路线，无需后端安装 AutoCAD 或商业转换服务即可直接解析原始 `.dwg` 二进制文件（支持 R13 ~ AutoCAD 2018+ 即 `AC1012` ~ `AC1032`）。

### 全链路数据流转过程

```text
[数据源: MinIO 预签名 URL / Spring 文件流 / 本地 .dwg 文件]
       │
       ▼ 1. 读取二进制流 (ArrayBuffer) + 校验文件头前6字节 (AC10xx)
[主线程: DwgViewerEngine (dwgViewerEngine.ts)]
       │
       ▼ 2. 零拷贝移交后台线程 (Web Worker)
[Worker 线程: libredwgParserWorker.ts + libredwg-web.wasm]
       ├─ (a) LibreDwg.dwg_read_data()：C/WASM 层解码 DWG 原始二进制字节流
       ├─ (b) instance.convertEx(dwg)：提取为纯 JSON 结构的中间数据 (DwgDatabase)
       └─ (c) normalizeDwgDatabaseFor2DPreview()：归一化修复（拍平测绘高程 Z=0、开启非打印网格图层、修复闭合多段线与样条顶点）
       │
       ▼ 3. 返回结构化中间数据 (result.database)
[转换与内存数据库层: @mlightcad/libredwg-converter + @mlightcad/data-model]
       ├─ 将 JSON 中间数据构建为标准 CAD 内存文档树 (AcDbDatabase)
       ├─ 解析图层表 (LAYER)、线型表 (LTYPE)、文字样式 (STYLE)、块表记录 (BLOCK_RECORD)
       └─ 异步加载匹配 CAD 矢量字体 (.shx / 中文字体) 并通过 mtext-renderer-worker 排版富文本
       │
       ▼ 4. 几何离散化与 GPU 批次合并渲染
[渲染与交互层: @mlightcad/cad-simple-viewer + @mlightcad/three-renderer + Three.js]
       ├─ 将直线、圆弧、多段线、样条曲线、填充、块引用转换为 Three.js BufferGeometry
       ├─ 自动检测并切换至有效空间（若图纸保存在空布局页则自动切回 Model 模型空间）
       ├─ 执行智能聚簇居中 (zoomToSmartExtents)，过滤远离主图的坐标原点/飞点
       └─ 提供 WebGL 视口原生交互（鼠标滚轮缩放、拖拽平移）
```

---

## 二、项目完整目录结构

```text
├── index.html                        # 页面入口 HTML
├── package.json                      # 依赖与构建脚本配置
├── vite.config.ts                    # Vite 构建与打包配置
├── README.md                         # 综合交接与迁移指南
├── ARCHITECTURE_AND_HANDOVER.md      # 技术路线、目录结构与文件分工专项说明（本文件）
├── public/                           # 【静态资源层】编译后原样映射至站点根目录 "/"
│   ├── wasm/
│   │   └── libredwg-web.wasm         # LibreDWG C 语言编译出的 WebAssembly 核心解码库
│   ├── workers/
│   │   └── mtext-renderer-worker.js  # MTEXT 多行文本与 SHX 矢量字体几何排版 Worker
│   ├── fonts/                        # CAD 矢量字体库 (.shx / 中文字体，解决中文乱码与问号)
│   ├── templates/                    # CAD 视图默认空白初始化模板
│   └── samples/                      # 内置示例图纸 (canteen.dwg)
└── src/                              # 【核心源码层】
    ├── main.tsx                      # React 挂载入口
    ├── index.css                     # Tailwind 全局基础样式
    ├── App.tsx                       # 极简 UI 外壳（地址输入栏、上传按钮、全屏视口容器）
    ├── core/
    │   └── dwgViewerEngine.ts        # 【核心】框架无关的 DWG 预览引擎类（可直接迁入 Vue）
    ├── workers/
    │   └── libredwgParserWorker.ts   # 【核心】DWG 解析 Web Worker（含等高线/网格线归一化修复）
    └── utils/
        ├── dwgValidation.ts          # DWG 二进制文件头校验与 MinIO URL 文件名提取工具
        └── dwgValidation.test.ts     # 校验与 URL 解析工具的单元测试
```

---

## 三、各文件与模块的具体职责分工

### 1. 核心业务源码 (`src/`)

| 文件路径 | 角色定位 | 具体职责分工 |
| :--- | :--- | :--- |
| **`src/core/dwgViewerEngine.ts`** | **无框架依赖的核心引擎类**（迁移核心） | 1. **`mount(container)`**：在传入的任意 DOM 容器上初始化 `@mlightcad/cad-simple-viewer` 单例（关闭冗余命令行/编辑工具栏，绑定 WASM Worker 与字体路径）。<br>2. **`loadFromUrl(url, options)`**：通过 `fetch` 拉取 MinIO 预签名地址或带 `Authorization` Header 的 Spring Boot 文件流，转为 `ArrayBuffer` 后交由解析管线渲染。<br>3. **`loadFromBuffer(fileName, buffer)`**：校验文件头后调用 `docManager.openDocument` 异步解码并渲染图纸。<br>4. **`ensureModelSpaceActive()`**：自动识别“保存在空白布局页（Paper Space）的总平图”，自动切换回包含完整图元的模型空间（Model Space）。<br>5. **`fitToView()`**：调用智能聚簇包围盒算法（`zoomToSmartExtents`），自动排除测绘图中远离主图的 `(0,0)` 原点飞点并居中展示。 |
| **`src/workers/libredwgParserWorker.ts`** | **后台解码与数据归一化 Worker**（迁移核心） | 1. 运行在独立 Web Worker 线程，加载 `/wasm/libredwg-web.wasm` 解码 DWG 原始字节流，避免大文件（50~100MB）阻塞浏览器主线程。<br>2. 调用 `instance.convertEx(dwg)` 生成纯 JSON 结构的 `result.database`（**这也是后续做中间数据持久化缓存的切入点**）。<br>3. **`normalizeDwgDatabaseFor2DPreview()`**：针对二维工程预览进行数据修正：<br>　• 将所有图层 `plotFlag` 置为 `1`，解决 CAD 中设为“不打印”的坐标网格线、辅助轴线被默认隐藏的问题；<br>　• 将所有图元与块内顶点的 `elevation` / `z` 坐标统一拍平至 `0`，解决带真实海拔（如 `Z > 500m`）的测绘等高线超出正交相机远裁剪面（`far=1000`）被整条裁切的问题；<br>　• 修正 `LWPOLYLINE` 闭合标志位（`512 -> 1`）与 `POLYLINE2D` 样条控制点过滤问题。 |
| **`src/utils/dwgValidation.ts`** | **二进制校验与 URL 工具**（迁移核心） | 1. **`inspectDwgHeader(buffer)`**：读取文件前 6 个字节签名（如 `AC1015`、`AC1027`、`AC1032`），校验是否为真实 AutoCAD DWG 二进制流并识别版本。<br>2. **`extractFileNameFromUrl(url)`**：从带签名参数的 MinIO 预签名 URL 或 Spring 下载地址中提取干净的 `.dwg` 文件名。<br>3. **`validateDwgFileName()` / `formatByteSize()`**：后缀校验与文件体积格式化。 |
| **`src/App.tsx`** | **极简预览界面壳** | 1. 提供顶部操作栏：MinIO / 内部 URL 输入框、**「加载地址」**按钮、**「居中复位」**按钮、**「上传 DWG」**按钮。<br>2. 支持解析浏览器地址栏 `?url=` / `?minioUrl=` 参数自动加载远程图纸。<br>3. 监听 `window.addEventListener('message')`，支持作为 `<iframe>` 嵌入现有系统时接收父页面发来的 `LOAD_DWG_URL` 或 `LOAD_DWG_BUFFER` 指令。 |

### 2. 静态资源目录 (`public/`)

| 目录/文件路径 | 为什么必需 | 职责说明 |
| :--- | :--- | :--- |
| **`public/wasm/libredwg-web.wasm`** | **必需** | LibreDWG C 源码编译而成的 WebAssembly 二进制模块，`libredwgParserWorker.ts` 启动时会从 `/wasm/libredwg-web.wasm` 加载它来执行底层字节解码。 |
| **`public/workers/mtext-renderer-worker.js`** | **必需** | 负责在后台线程解析 CAD 复杂多行文本（`MTEXT`）转义符并将矢量字形三角化为 WebGL 网格。 |
| **`public/fonts/`** | **必需** | 存放 CAD 标准 `.shx` 字体及中文字体文件；若缺失此目录，图纸中的中文说明、高程标注、轴号会无法渲染或显示为问号。 |
| **`public/templates/`** | **必需** | `@mlightcad/cad-simple-viewer` 初始化文档管理器时的基础空模板文件。 |
| **`public/samples/`** | 可选 | 内置演示用的两个标准 `.dwg` 样本文件，迁移到生产环境后可按需删除。 |

### 3. 核心第三方依赖包分工 (`package.json`)

```bash
# 核心依赖清单：
npm install @mlightcad/cad-simple-viewer@^1.7.6 \
            @mlightcad/data-model@^1.15.11 \
            @mlightcad/libredwg-converter@^3.15.11 \
            @mlightcad/libredwg-web@^0.8.1 \
            @mlightcad/three-renderer@^1.7.6 \
            @mlightcad/mtext-parser@^1.5.5 \
            @mlightcad/mtext-renderer@^0.13.5 \
            @velipso/polybool@^2.0.11 \
            lodash-es@^4.18.1 \
            three@^0.186.1
```
- **`@mlightcad/libredwg-converter`**：桥接转换器，负责调度 `libredwgParserWorker.ts` 并将 `DwgDatabase` 转换为引擎内部实体模型。
- **`@mlightcad/data-model`**：CAD 内存数据库模型（提供 `AcDbDatabase`、图层表、块表、布局管理器及各类二维/三维图元数据结构）。
- **`@mlightcad/three-renderer` & `three`**：基于 Three.js WebGL 的 CAD 二维正交相机渲染器，负责将海量 CAD 线段、圆弧、文字合并批次（Batching）交由 GPU 高帧率绘制。
- **`@mlightcad/cad-simple-viewer`**：顶层文档与视口控制器（`AcApDocManager`），管理画布生命周期、鼠标滚轮缩放、拖拽平移与智能聚簇居中。

---

## 四、50MB+ 超大 DWG 防卡死与防移动端 OOM 崩溃核心保障机制

针对 50MB~70MB+ 巨型图纸（如 66MB 工程图平图、52MB 总平图，包含 10 万 ~ 20 万+ 图元）在浏览器中的加载稳定性，系统实施了四大防御机制：

### 1. 协作式让出 (`cooperativeYield: true`) 与动态自适应分片 (`calculateAdaptiveChunkSize`)
- **致命痛点**：若关闭协作式让出（`cooperativeYield: false`）或硬编码大 Chunk（如 5000），SDK 将在单个 JS 同步宏任务中跑满 30~50 秒，完全独占浏览器主线程，触发桌面端 Chrome 报“页面无响应”；同时阻断了 V8 引擎增量垃圾回收（GC），手机端瞬间突破 1.5GB 内存上限发生 OOM 闪退。
- **防御策略**：
  - 强制开启 `cooperativeYield: true` 与 `progressiveRendering: true`；
  - 动态计算分片：巨型图纸（>=15MB 或 >=15,000 图元）使用 `minimumChunkSize: 200`，中型图纸使用 300，小型图纸使用 1000；
  - 驱动底座每处理 200 个实体后主动调用 `accmYieldToUi()` 让出主线程，确保 60fps 心跳刷新和 V8 增量 GC 及时回收临时对象。

### 2. 原生 C++ 数据流直解与零拷贝解压加速 (`decompressGzipToEnvelope`)
- **致命痛点**：旧版采用 JavaScript 逐块拼接（`leftover += decoder.decode(...)`），在 300MB+ JSON 巨型流下引发经典 $O(N^2)$ 二次字符串复制灾难，累积产生 ~800GB 瞬时字符串垃圾，单解压一步就霸占主线程整整 71 秒！
- **提速方案**：
  - 采用浏览器原生 C++ `new Response(decompressedStream).text()` 直接管道直解，彻底剔除 5,000+ 次 JavaScript 微任务 Promise 轮询；
  - 配合 NDJSON 索引切块与协作式让出（每 25 个块主动让出微任务），将 40MB Gzip（解压后 301MB JSON）解压耗时从 **71 秒骤降至 1.85 秒**（提速 38 倍）；
  - 按钮文案由口语化的“秒开”全面规范命名为工程标准的**「快速载入」**与**「极速加载」**。


### 3. WASM 解析与 Gzip 缓存持久化异步解耦
- WASM 解码完成后，绝不在渲染前阻塞执行 Gzip 压缩（超大图纸压缩需 2~3 秒）；
- 优先立即将 CAD 数据库交付 `openDocument()` 启动渲染，利用 `setTimeout` 将 Gzip 压缩生成与服务端/IndexedDB 同步转入空闲微任务后台执行。

### 4. UI 进度条双分支流感知
- 明确划分 **`[⚡ Gzip 极速秒开模式]`** 与 **`[⚙️ DWG ➜ JSON 全量分析模式]`**，节点与徽标清晰反馈当前执行管线。

### 5. 样图库同名匹配优先法则 (Same-name Matching Rule)
- 样图库下拉菜单及 `loadFromUrl` 统一接入同名匹配法则（`findGzipCacheByFileName`）；
- 若 L1 (IndexedDB) 或 L2 (服务端共享池) 存在与选中 DWG 同名的 Gzip 缓存记录，下拉项即刻点亮 `⚡ Gzip` 徽标；
- 点击后自动绕过数十兆的原始 DWG 网络下载与 WASM 二进制解码，直接调用 `loadFromCachedFingerprint` 瞬时载入图纸。

### 6. iOS 与移动端内核级 Jetsam 防闪退机制（字节级流式直通与显存收敛）
- **物理机制剖析**：
  - iOS WebKit（Safari / 微信内置浏览器等）强制单网页 WebContent 进程常驻物理内存（RSS）不得超过 **1.0GB ~ 1.2GB**（由 iOS 内核级 Jetsam 机制强杀 `SIGKILL 9`，表现为点击大图后 1~2 秒内瞬间白屏且无任何 JS Console 报错）。
  - 66MB DWG 解压后产生 316.2MB JSON（含中文字符）。若调用 `new Response(decompressedStream).text()`，WebKit 会在 C++ 层累积 316MB `SharedBuffer`，并在 JavaScriptCore 分配一个 **600MB+ 的 16-bit UTF-16 (`UChar`) 连续大字符串**，在 `text.split('\n')` 完成前瞬间突破 950MB+，叠加已有图纸内存直接触发 Jetsam 强杀。
- **根治落地策略**：
  1. **字节级换行符 (`0x0A`) 流式解码器 (`decompressGzipToEnvelope`)**：废除 `Response.text()` 一次性大字符串分配，直接从 `DecompressionStream` 的 `reader.read()` 读取 `Uint8Array` 分块，使用原生 `chunk.indexOf(10, startOffset)` 在字节流中切分 `\n`（`0x0A`），单块内整行通过 `subarray` 零拷贝切片，每次仅对单行（~1MB）执行 `TextDecoder.decode` 与反序列化，使解压阶段的字符串/缓冲瞬时峰值从 **950MB+ 降至 < 4MB**。
  2. **网络流直通与移动端 IndexedDB 大包豁免 (`dwgLocalCacheStore.ts`)**：
     - 移动端回退拉取服务端 L2 缓存时，直接将 `res.body` (`ReadableStream`) 管道直通传入 `decompressGzipToEnvelope`，免去 `await res.arrayBuffer()` 的 41MB 连续内存分配；
     - 移动端禁止向 `memoryStore` 写入 `gzBytes`，且对 >10MB 的 `.gz` 跳过写入本地 IndexedDB（规避 WebKit Structured Clone 跨进程 IPC 翻倍拷贝），`listGzipCacheEntries` 改用 `openCursor()` 游标扫描并立即置空 `gzBytes`。
  3. **切换大图前预清空旧场景 (`releasePreviousSceneBeforeLoad`)**：在加载新图纸前主动调用 `curView.abortConversion()` 与 `curView._scene.clear()` 并让出 25ms，先行释放上一张图纸占用的 ~200MB 内存与显存。
  4. **WebGL Canvas 像素比上限收敛与 Resize 守护**：
     - 移动端与防御模式下将 Three.js `pixelRatio` 锁定在 `1.25`（物理像素缩减 5.95 倍，4x MSAA 帧缓冲显存降低 83.2%），并在 `window` `resize` 时持续守护防止 iOS 地址栏收起重置 DPR。
  5. **按 45ms 时间片协作式让出与 UI 双模开关**：
     - 解压循环按真实时间片（每 45ms 让出 `8ms`）刷新 UI 进度，兼顾加载速度与主线程响应；顶部提供 `[🛡️ 防闪退模式]` 显式开关。

### 7. 大地坐标与离散图元智能聚焦防御 (Statistical Cluster Framing)
- **痛点现象**：
  - 加载如 66MB `large-drawing.dwg` 等大地测量或市政工程图纸时，图纸被拉得极远，主体图层在视口左侧缩成一个极小的点。
- **根因分析**：
  1. **DWG 文件头脏数据**：AutoCAD 在头变量 `$EXTMAX` 中残留了 异常范围的包围盒，且图层 `"0"` 中存在离散孤点/异常图元；而真实图纸主体集中在一个小得多的范围内，两者相距数万公里。
  2. **SDK `applyInitialZoom` 缺陷**：SDK 在图元转换完成时，优先无脑读取脏 `$EXTMAX` 并调用 `zoomTo(extents)`，将视口拉至几万公里高空覆盖全图。
  3. **SDK `resolveSmartFitBox` 容差过大**：SDK 内部硬编码了 `1e10` (100亿) 的离散容差，无法剔除 6500 万级别的孤立图层。
- **解决方案与实现**（[`src/core/dwgViewerEngine.ts`](src/core/dwgViewerEngine.ts#L1435-L1570)）：
  1. **中位数统计聚簇 (Median Center & Span)**：提取所有非空图层包围盒，计算其几何中心与跨度的中位数；动态剔除偏离主体坐标系超限的极端异常图层（如成功剔除图层 `"0"`，保留其余 27 个主体图层）。
  2. **Three-Renderer 契约盒**：构造具备内部写入属性的 `getSize` 与 `getCenter` Vector 包装盒，无缝驱动底层 `zoomTo(targetBox, 1.08)`。
  3. **阻断 SDK 异步覆写**：注册 `markLayoutAsInitialized` 并向 `_externallyFramedLayouts` 登记当前布局，防止 SDK 内部定时器回弹重置视口。
  4. **异步分批监听自适应**：在图元流式转换完全排空后自动补齐一次精细聚焦，实现开图即居中。
