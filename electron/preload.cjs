/**
 * Electron 安全预加载桥接脚本 (electron/preload.cjs)
 * 职责：
 * 1. 向渲染进程暴露受控的 window.electronAPI 接口；
 * 2. 注入应用服务端口获取能力 (getServerUrl) 与命令行图纸关联监听 (onOpenDwgFile)；
 * 3. 增强类型与调用容错，保障文件选择与工作区切换原生能力稳定。
 */
const { contextBridge, ipcRenderer } = require('electron');

let cachedServerUrl = 'http://127.0.0.1:3000';
ipcRenderer.invoke('app:getServerUrl').then((url) => {
  if (url) cachedServerUrl = url;
}).catch(() => {});

contextBridge.exposeInMainWorld('electronAPI', {
  resourceUsage: () => ipcRenderer.invoke('app:resourceUsage'),
  language: ipcRenderer.sendSync('settings:getLanguage'),
  setLanguage: value => ipcRenderer.invoke('settings:setLanguage', value),
  onLanguage: callback => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('settings:language', handler);
    return () => ipcRenderer.removeListener('settings:language', handler);
  },
  isElectron: true,
  platform: process.platform,
  /**
   * 调用原生文件对话框选择并读取本地 .dwg / .dwg.cache.gz 文件
   */
  openDwgFileDialog: async () => {
    try {
      return await ipcRenderer.invoke('dialog:openDwgFile');
    } catch (err) {
      console.error('[Preload] openDwgFileDialog error:', err);
      return null;
    }
  },
  /**
   * 调用原生文件夹对话框选择自定义工作区目录
   */
  selectDirectory: async () => {
    try {
      return await ipcRenderer.invoke('dialog:selectDirectory');
    } catch (err) {
      console.error('[Preload] selectDirectory error:', err);
      return null;
    }
  },
  /**
   * 获取本地内嵌 Express 服务基础 URL (如 http://127.0.0.1:3000)
   */
  getServerUrl: async () => {
    try {
      const url = await ipcRenderer.invoke('app:getServerUrl');
      if (url) cachedServerUrl = url;
      return cachedServerUrl;
    } catch {
      return cachedServerUrl;
    }
  },
  /**
   * 监听来自主进程的命令行/双击打开图纸通知
   */
  onOpenDwgFile: (callback) => {
    if (typeof callback === 'function') {
      ipcRenderer.on('app:openDwgFile', (_event, data) => callback(data));
    }
  },
});
