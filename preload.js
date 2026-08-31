// 渲染层 ⇄ 主进程的安全桥:暴露保存文件、打开目录与应用版本号
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iconApp', {
  saveFiles: (files) => ipcRenderer.invoke('icon-app:save-files', files),
  showInFolder: (filePath) => ipcRenderer.invoke('icon-app:show-in-folder', filePath),
  version: () => ipcRenderer.invoke('icon-app:version')
});
