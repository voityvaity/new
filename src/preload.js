'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  create: (payload) => ipcRenderer.invoke('live:create', payload),
  grade: (payload) => ipcRenderer.invoke('interview:grade', payload),
  saveDraft: (payload) => ipcRenderer.invoke('interview:draft', payload),
  chooseReportsFolder: () => ipcRenderer.invoke('reports:choose-folder'),
  openReportsFolder: () => ipcRenderer.invoke('reports:open-folder'),
  clear: () => ipcRenderer.invoke('interview:clear'),
  getPrefs: () => ipcRenderer.invoke('settings:get'),
  savePrefs: (settings) => ipcRenderer.invoke('settings:save',settings),
  clearSavedKey: () => ipcRenderer.invoke('settings:clear-key')
});
