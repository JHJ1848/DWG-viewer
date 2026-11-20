export interface ElectronOpenedDwgFile {
  filePath: string;
  fileName: string;
  dirPath: string;
  byteLength: number;
  buffer: ArrayBuffer;
}

export interface ElectronBridgeAPI {
  resourceUsage: () => Promise<{ cpu: number; memoryMiB: number }>;
  language: 'zh' | 'en';
  setLanguage: (value: 'zh' | 'en') => Promise<void>;
  onLanguage: (callback: (value: 'zh' | 'en') => void) => () => void;
  isElectron: boolean;
  platform: string;
  /** 打开原生文件对话框选择 .dwg 或 .dwg.cache.gz 文件 */
  openDwgFileDialog: () => Promise<ElectronOpenedDwgFile | null>;
  /** 打开原生文件夹对话框选择自定义 DWG 工作区目录 */
  selectDirectory: () => Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI?: ElectronBridgeAPI;
  }
}
