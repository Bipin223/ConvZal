const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('desktopAPI', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  convertVideo: (options) => ipcRenderer.invoke('native-convert', options),
  readOutput: (outputPath) => ipcRenderer.invoke('read-output', outputPath),
  onConvertProgress: (callback) => {
    const listener = (_event, seconds) => callback(seconds)
    ipcRenderer.on('native-convert-progress', listener)
    return () => ipcRenderer.removeListener('native-convert-progress', listener)
  },
})
