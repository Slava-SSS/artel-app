const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('api:getConfig'),

  // Database
  getData: () => ipcRenderer.invoke('api:getData'),
  getProjectFiles: (projectName) => ipcRenderer.invoke('api:getProjectFiles', projectName),
  addCategory: (categoryName) => ipcRenderer.invoke('api:addCategory', categoryName),
  linkFile: (data) => ipcRenderer.invoke('api:linkFile', data),
  addProject: (data) => ipcRenderer.invoke('api:addProject', data),

  // File operations
  openFile: (filePath) => ipcRenderer.invoke('api:openFile', filePath),
  getThumbnail: (filePath) => ipcRenderer.invoke('api:getThumbnail', filePath),
  getEmbeddedThumbnail: (filePath) => ipcRenderer.invoke('api:getEmbeddedThumbnail', filePath),
  getFileIcon: (filePath) => ipcRenderer.invoke('api:getFileIcon', filePath),
  getWindowsPreview: (filePath) => ipcRenderer.invoke('api:getWindowsPreview', filePath),
  getViewerData: (filePath) => ipcRenderer.invoke('api:getViewerData', filePath),
  getPDFPath: (filePath) => ipcRenderer.invoke('api:getPDFPath', filePath),
  getImageAsDataURL: (filePath) => ipcRenderer.invoke('api:getImageAsDataURL', filePath),
  showContextMenu: (filePath) => ipcRenderer.invoke('api:showContextMenu', filePath),
  renameFile: (data) => ipcRenderer.invoke('api:renameFile', data),

  // Refresh
  refreshProjects: () => ipcRenderer.invoke('api:refreshProjects'),
  saveStructure: (content) => ipcRenderer.invoke('saveStructure', content),

  // Telegram Bot
  telegramNewOrder: (order) => ipcRenderer.invoke('telegram:newOrder', order),
  telegramGetOrders: () => ipcRenderer.invoke('telegram:getOrders'),
  telegramSync: () => ipcRenderer.invoke('telegram:sync'),

  // Events
  onProjectsRefreshed: (callback) =>
    ipcRenderer.on('projects-refreshed', () => callback()),
  onNewOrder: (callback) =>
    ipcRenderer.on('new-order', (_, order) => callback(order)),
  onNewOrderTelegram: (callback) =>
    ipcRenderer.on('new-order-telegram', (_, order) => callback(order)),
  onLog: (callback) =>
    ipcRenderer.on('log', (_, logEntry) => callback(logEntry)),
});
