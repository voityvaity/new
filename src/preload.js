'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  create: (payload) => ipcRenderer.invoke('live:create', payload),
  grade: (payload) => ipcRenderer.invoke('interview:grade', payload),
  saveDraft: (payload) => ipcRenderer.invoke('interview:draft', payload),
  endInterview: (payload) => ipcRenderer.invoke('interview:end', payload),
  listReports: () => ipcRenderer.invoke('reports:list'),
  exportReport: (id) => ipcRenderer.invoke('reports:export', {id}),
  chooseReportsFolder: () => ipcRenderer.invoke('reports:choose-folder'),
  openReportsFolder: () => ipcRenderer.invoke('reports:open-folder'),
  clear: () => ipcRenderer.invoke('interview:clear'),
  getPrefs: () => ipcRenderer.invoke('settings:get'),
  savePrefs: (settings) => ipcRenderer.invoke('settings:save',settings),
  clearSavedKey: () => ipcRenderer.invoke('settings:clear-key')
});
