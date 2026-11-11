// Exposes a small, explicit API to the renderer. The renderer has no Node access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  pickImage: (opts) => ipcRenderer.invoke('pick-image', opts),
  scan: (root, extraDirs) => ipcRenderer.invoke('scan', root, extraDirs),
  libLoad: (root) => ipcRenderer.invoke('lib-load', root),
  libSave: (root, state) => ipcRenderer.invoke('lib-save', root, state),
  libSaveSync: (root, state) => ipcRenderer.sendSync('lib-save-sync', root, state),
  thumbSave: (root, modelPath, bytes) => ipcRenderer.invoke('thumb-save', root, modelPath, bytes),
  thumbsClear: (root) => ipcRenderer.invoke('thumbs-clear', root),
  copy: (text) => ipcRenderer.invoke('clipboard', text),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  configGet: () => ipcRenderer.invoke('config-get'),
  configSet: (patch) => ipcRenderer.invoke('config-set', patch),
  exists: (p) => ipcRenderer.invoke('exists', p),
  capture: (file) => ipcRenderer.invoke('capture', file),
  quit: () => ipcRenderer.invoke('quit'),
  // Absolute path of a file dropped from the OS (File.path was removed in Electron 32).
  pathForFile: (file) => webUtils.getPathForFile(file),
});
