// 渲染层 ⇄ 主进程的安全桥:暴露保存文件、打开目录、版本号与本地配置
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iconApp', {
  saveFiles: (files, opts) => ipcRenderer.invoke('icon-app:save-files', files, opts),
  showInFolder: (filePath) => ipcRenderer.invoke('icon-app:show-in-folder', filePath),
  version: () => ipcRenderer.invoke('icon-app:version'),
  getConfig: () => ipcRenderer.invoke('icon-app:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('icon-app:set-config', patch),
  openExternal: (url) => ipcRenderer.invoke('icon-app:open-external', url)
});
