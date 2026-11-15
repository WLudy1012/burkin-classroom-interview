const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('digitalHuman', Object.freeze({
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  cloneVoice: () => ipcRenderer.invoke('voice:clone'),
  checkPendingVoice: () => ipcRenderer.invoke('voice:check-pending'),
  previewVoice: (data) => ipcRenderer.invoke('voice:preview', data),
  status: () => ipcRenderer.invoke('runtime:status'),
  startSession: () => ipcRenderer.invoke('runtime:start'),
  sendVoice: (audioBase64, mode) => ipcRenderer.invoke('runtime:voice', { audioBase64, mode }),
  sendText: (text, mode) => ipcRenderer.invoke('runtime:text', { text, mode }),
  resetSession: () => ipcRenderer.invoke('runtime:reset'),
  openWebUI: () => ipcRenderer.invoke('web:open'),
  toggleFullscreen: () => ipcRenderer.invoke('window:fullscreen'),
  onRuntimeEvent: (listener) => {
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('runtime:event', handler);
    return () => ipcRenderer.removeListener('runtime:event', handler);
  },
}));
