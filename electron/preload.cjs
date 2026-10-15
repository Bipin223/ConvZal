const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('desktopAPI', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  convertVideo: (options) => ipcRenderer.invoke('native-convert', options),
  cancelConvert: (requestId) => ipcRenderer.invoke('native-convert-cancel', requestId),
  readOutput: (outputPath) => ipcRenderer.invoke('read-output', outputPath),
  onConvertProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('native-convert-progress', listener)
    return () => ipcRenderer.removeListener('native-convert-progress', listener)
  },

  // Filesystem browser
  listDirectory: (targetPath, includeNonVideo) => ipcRenderer.invoke('fs:list', targetPath, includeNonVideo),
  pickFile: () => ipcRenderer.invoke('fs:pick-file'),
  pickFolder: () => ipcRenderer.invoke('fs:pick-folder'),
  statPath: (targetPath) => ipcRenderer.invoke('fs:stat', targetPath),
  probeMedia: (targetPath) => ipcRenderer.invoke('media:probe', targetPath),
  saveAs: (sourcePath, suggestedName) => ipcRenderer.invoke('fs:save-as', sourcePath, suggestedName),

  // Shell integration
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),
  showItemInFolder: (targetPath) => ipcRenderer.invoke('shell:show-item', targetPath),

  appInfo: () => ipcRenderer.invoke('app:info'),
})
