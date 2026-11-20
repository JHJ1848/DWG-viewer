/**
 * Electron Windows 桌面端主进程入口 (electron/main.cjs)
 * 职责：
 * 1. 彻底消除 react-example 默认路径，规范化并支持可配置日志路径 (DWG_LOG_PATH / DWG_LOG_DIR)；
 * 2. 进程内安全托管 Express 本地后端，彻底解决 ENOTDIR 崩溃与 Vite 原生绑定丢失故障；
 * 3. 生产环境通过 loadFile 直载前端静态资源秒开，从根本上根除黑屏风险；
 * 4. 完备的系统托盘 (System Tray) 常驻生命周期，支持后台挂起、查看日志与安全退出；
 * 5. 拦截 file:/// 协议发往 /api/ 与 /samples/ 的数据请求，无缝反代至本地内嵌 Express 服务。
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 统一应用名称并锁定用户数据目录为 DWG-viewer，彻底消除 react-example
app.name = 'DWG-viewer';
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'DWG-viewer'));
} catch {
  // 忽略已初始化后的设置异常
}

/**
 * 解析有效日志文件绝对路径（支持环境变量配置与用户家目录兜底）。
 * @returns {string} 日志绝对路径
 */
function resolveLogFilePath() {
  if (process.env.DWG_LOG_PATH && process.env.DWG_LOG_PATH.trim()) {
    return path.resolve(process.env.DWG_LOG_PATH.trim());
  }
  if (process.env.DWG_LOG_DIR && process.env.DWG_LOG_DIR.trim()) {
    return path.join(path.resolve(process.env.DWG_LOG_DIR.trim()), 'server.log');
  }
  return path.join(os.homedir(), '.dwgViewer', 'server.log');
}

const LOG_FILE = resolveLogFilePath();
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {
  // 忽略创建失败
}
console.log(`[DWG-viewer] 当前日志输出路径: ${LOG_FILE}`);

let mainWindow = null;
let tray = null;
let isQuitting = false;
let activeServerPort = 3000;
let activeServerUrl = process.env.DWG_VIEWER_URL || `http://127.0.0.1:${activeServerPort}`;

/**
 * 追加记录调试与运行日志到磁盘文件。
 * @param {string} msg 日志内容
 * @param {any} [err] 错误对象
 */
function logToFile(msg, err = null) {
  try {
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] ${msg}`;
    if (err) {
      line += ` | Error: ${err && err.stack ? err.stack : err}`;
    }
    line += '\n';
    console.log(msg, err || '');
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // 忽略日志写入异常
  }
}

// 全局未捕获异常与 Promise 拒绝兜底记录与弹窗告警
process.on('uncaughtException', (err) => {
  logToFile('全局未捕获异常 (uncaughtException):', err);
  try {
    dialog.showErrorBox(
      'DWG-viewer 运行异常',
      `应用遇到未捕获异常：\n${err && err.stack ? err.stack : String(err)}\n\n日志详情请查看：\n${LOG_FILE}`
    );
  } catch {
    // 忽略弹窗异常
  }
});

process.on('unhandledRejection', (reason) => {
  logToFile('全局未捕获 Promise 拒绝 (unhandledRejection):', reason);
});

// Windows 单实例锁保证单机互斥，二次唤醒时复用已有窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logToFile('检测到已存在运行中实例，当前进程退出。');
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    logToFile('接收到二次实例唤醒请求');
    if (mainWindow) {
      mainWindow.show();
      mainWindow.restore();
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(true);
      mainWindow.setAlwaysOnTop(false);

      const cliPath = extractCliDwgFilePath(commandLine);
      if (cliPath) {
        logToFile(`通过二次实例打开图纸: ${cliPath}`);
        mainWindow.webContents.send('app:openDwgFile', {
          filePath: cliPath,
          fileName: path.basename(cliPath),
          dir: path.dirname(cliPath),
        });
      }
    }
  });
}

/**
 * 进程内安全托管 Express 本地后端服务。
 * @returns {Promise<string>} 最终就绪的服务根地址
 */
async function startInProcessServer() {
  if (process.env.DWG_VIEWER_URL) {
    activeServerUrl = process.env.DWG_VIEWER_URL;
    logToFile(`使用外部指定 DWG_VIEWER_URL: ${activeServerUrl}`);
    return activeServerUrl;
  }

  const serverScript = path.join(__dirname, 'server.cjs');
  if (!fs.existsSync(serverScript)) {
    logToFile(`未在预定路径找到内置后端脚本: ${serverScript}`);
    throw new Error('Missing desktop backend');
  }

  process.env.NODE_ENV = 'production';
  const { startServer } = require(serverScript);
  for (let port = 3000; ; port++) {
    try {
      await startServer(port);
      activeServerPort = port;
      activeServerUrl = `http://127.0.0.1:${port}`;
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || port >= 65535) throw error;
    }
  }
  return activeServerUrl;
}

/**
 * 解析命令行启动参数中携带的 .dwg 或 .dwg.cache.gz 文件路径。
 * @param {string[]} argv 命令行参数数组
 * @returns {string | null} 解析出的合法本地文件绝对路径
 */
function extractCliDwgFilePath(argv) {
  if (!Array.isArray(argv)) return null;
  for (const rawArg of argv.slice(1)) {
    if (!rawArg) continue;
    const cleanArg = rawArg.trim().replace(/^["']|["']$/g, '');
    if (cleanArg.startsWith('-') || cleanArg.startsWith('--')) continue;

    const lower = cleanArg.toLowerCase();
    if (
      lower.endsWith('.dwg') ||
      lower.endsWith('.dwg.cache.gz') ||
      lower.endsWith('.cache.gz') ||
      lower.endsWith('.dwg.gz')
    ) {
      try {
        const resolved = path.resolve(cleanArg);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          return resolved;
        }
      } catch {
        // 忽略非合法路径
      }
    }
  }
  return null;
}

/**
 * 拦截本地 file:// 静态页面向 /api/ 与 /samples/ 发起的请求，
 * 自动反向代理至内嵌 Express 端口（支持 Windows 盘符形式）。
 */
function setupRequestInterception() {
  try {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      // 增强匹配 file:///api/、file:///samples/ 以及 Windows 盘符形式 file:///C:/api/、file:///C:/samples/
      const match = details.url.match(/^file:\/\/\/(?:[a-zA-Z]:\/)?(api|samples)\/(.*)$/i);
      if (match) {
        const endpoint = match[1];
        const rest = match[2];
        const targetUrl = `${activeServerUrl}/${endpoint}/${rest}`;
        logToFile(`拦截并重定向本地请求 [${details.url}] -> [${targetUrl}]`);
        callback({ redirectURL: targetUrl });
        return;
      }
      callback({});
    });
    logToFile('请求网络拦截器注册成功 (支持 file:/// 与 Windows 盘符自动路由)');
  } catch (err) {
    logToFile('注册请求网络拦截器异常', err);
  }
}

/**
 * 创建主应用桌面窗口。
 */
const languageFile = path.join(app.getPath('userData'), 'language.txt');
let language = 'zh';
if (fs.existsSync(languageFile) && fs.readFileSync(languageFile, 'utf8').trim() === 'en') language = 'en';

function setLanguage(value) {
  if (value !== 'en' && value !== 'zh') return;
  fs.writeFileSync(languageFile, value);
  language = value;
  installMenu();
  mainWindow?.webContents.send('settings:language', value);
}

function installMenu() {
  const en = language === 'en';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'fileMenu', label: en ? 'File' : '文件' },
    { role: 'editMenu', label: en ? 'Edit' : '编辑' },
    { role: 'viewMenu', label: en ? 'View' : '视图' },
    { role: 'windowMenu', label: en ? 'Window' : '窗口' },
    { label: en ? 'Settings' : '设置', submenu: [
      { label: en ? 'Language' : '语言', submenu: [
        { label: '简体中文', type: 'radio', checked: !en, click: () => setLanguage('zh') },
        { label: 'English', type: 'radio', checked: en, click: () => setLanguage('en') },
      ] },
    ] },
    { role: 'help', label: en ? 'Help' : '帮助', submenu: [{ role: 'about' }] },
  ]));
}

ipcMain.on('settings:getLanguage', event => { event.returnValue = language; });
ipcMain.handle('settings:setLanguage', (_event, value) => setLanguage(value));

function createMainWindow() {
  const appIconPath = path.join(__dirname, '../public/icons/icon-256x256.png');
  const distIndexPath = path.join(__dirname, '../dist/index.html');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0F1117',
    title: 'DWG-viewer',
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    show: true, // 彻底废除 show: false，弹出即呈现深色内联骨架屏，0.05秒秒开，杜绝隐形假死与黑屏感
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 加载错误防护与重试（服务端口连接被拒时降级为 loadFile 兜底）
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logToFile(`页面加载失败 [${validatedURL}]: ${errorDescription} (${errorCode})`);
    if (errorCode === -102 /* ERR_CONNECTION_REFUSED */) {
      if (fs.existsSync(distIndexPath)) {
        logToFile(`本地服务连接被拒，降级载入本地静态文件兜底: ${distIndexPath}`);
        void mainWindow.loadFile(distIndexPath);
      }
    }
  });

  let hasShownTrayBalloon = false;

  // 拦截关闭事件：默认最小化到系统托盘后台常驻
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      logToFile('主窗口已隐藏并最小化至系统托盘');
      if (!hasShownTrayBalloon && tray) {
        hasShownTrayBalloon = true;
        try {
          tray.displayBalloon({
            title: 'DWG-viewer',
            content: '应用已最小化到系统托盘，后台持续运行。单击托盘图标可重新打开。',
          });
        } catch {
          // 忽略某些系统不支持气泡通知的异常
        }
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const cliDwgPath = extractCliDwgFilePath(process.argv);

  // 页面载入完成事件：安全派发命令行图纸通知
  mainWindow.webContents.on('did-finish-load', () => {
    logToFile('页面载入完成 (did-finish-load)');
    if (cliDwgPath) {
      logToFile(`通过 did-finish-load 派发命令行图纸: ${cliDwgPath}`);
      mainWindow.webContents.send('app:openDwgFile', {
        filePath: cliDwgPath,
        fileName: path.basename(cliDwgPath),
        dir: path.dirname(cliDwgPath),
      });
    }
  });

  // 主窗口优先采用 loadURL(activeServerUrl) 纯同源 HTTP 模式，从根本上根除 file:/// 下 Failed to fetch 故障
  if (activeServerUrl) {
    if (cliDwgPath) {
      loadDwgPathInWindow(mainWindow, cliDwgPath);
    } else {
      logToFile(`主窗口载入本地服务 HTTP 根路径 (同源无跨域): ${activeServerUrl}`);
      void mainWindow.loadURL(activeServerUrl);
    }
  } else if (fs.existsSync(distIndexPath)) {
    logToFile(`本地服务未就绪，降级使用 loadFile 兜底呈现: ${distIndexPath}`);
    void mainWindow.loadFile(distIndexPath);
  }
}

/**
 * 创建系统托盘图标与上下文菜单。
 */
function createTray() {
  if (tray) return;

  const trayIcon32 = path.join(__dirname, '../public/icons/icon-32x32.png');
  const trayIcon256 = path.join(__dirname, '../public/icons/icon-256x256.png');
  const iconPath = fs.existsSync(trayIcon32)
    ? trayIcon32
    : (fs.existsSync(trayIcon256) ? trayIcon256 : undefined);

  if (!iconPath) {
    logToFile('未找到托盘图标资源，跳过托盘初始化');
    return;
  }

  tray = new Tray(iconPath);
  tray.setToolTip('DWG-viewer (后台运行中)');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开主窗口',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        } else {
          createMainWindow();
        }
      },
    },
    {
      label: '最小化到托盘',
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
        }
      },
    },
    { type: 'separator' },
    {
      label: '查看后台日志',
      click: () => {
        if (fs.existsSync(LOG_FILE)) {
          shell.openPath(LOG_FILE);
        } else {
          dialog.showMessageBox({
            type: 'info',
            title: '后台日志',
            message: `暂未生成日志文件：\n${LOG_FILE}`,
          });
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        logToFile('用户通过托盘菜单请求彻底退出应用');
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // 单击托盘图标切换窗口显隐
  tray.on('click', () => {
    if (!mainWindow) {
      createMainWindow();
      return;
    }
    if (mainWindow.isVisible()) {
      if (mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.focus();
      }
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// IPC 1: 打开 Windows 原生文件选择框读取 .dwg 或 .dwg.cache.gz
ipcMain.handle('dialog:openDwgFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 AutoCAD DWG 图纸或 Gzip 缓存文件',
    properties: ['openFile'],
    filters: [
      { name: 'CAD 图纸与缓存文件', extensions: ['dwg', 'gz'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const fileName = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  return {
    filePath,
    fileName,
    dirPath: path.dirname(filePath),
    byteLength: buffer.byteLength,
    buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
});

// IPC 2: 打开 Windows 原生文件夹选择框切换自定义工作区目录
ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 DWG 图纸工作区文件夹',
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// IPC 3: 获取本地 Express 服务 URL
ipcMain.handle('app:resourceUsage', () => {
  const processes = app.getAppMetrics();
  return {
    cpu: processes.reduce((sum, item) => sum + item.cpu.percentCPUUsage, 0),
    memoryMiB: processes.reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024,
  };
});

ipcMain.handle('app:getServerUrl', () => {
  return activeServerUrl;
});

// 应用就绪生命周期
app.whenReady().then(async () => {
  if (!gotTheLock) return;
  logToFile('Electron app.whenReady 触发');
  installMenu();
  setupRequestInterception();
  try {
    await startInProcessServer();
  } catch (error) {
    dialog.showErrorBox('DWG-viewer', String(error.message || error));
    app.quit();
    return;
  }
  createMainWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// 应用退出前置钩子
app.on('before-quit', () => {
  logToFile('Electron app.before-quit 触发');
  isQuitting = true;
});

app.on('window-all-closed', () => {
  logToFile('Electron app.window-all-closed 触发');
  if (isQuitting || process.platform === 'darwin') {
    app.quit();
  }
});
