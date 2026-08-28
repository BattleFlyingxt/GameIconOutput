// 渲染层 ⇄ 主进程的安全桥:只暴露保存文件与打开目录两个能力
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iconApp', {
  saveFiles: (files) => ipcRenderer.invoke('icon-app:save-files', files),
  showInFolder: (filePath) => ipcRenderer.invoke('icon-app:show-in-folder', filePath)
});
