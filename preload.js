const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  signIn: () => ipcRenderer.invoke('drive:signin'),
  getStatus: () => ipcRenderer.invoke('drive:status'),
  loadData: () => ipcRenderer.invoke('drive:load'),
  saveData: (data) => ipcRenderer.invoke('drive:save', data),
});
