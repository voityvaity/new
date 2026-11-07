'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  create: (payload) => ipcRenderer.invoke('live:create', payload),
  hangupLive: (payload = {}) => ipcRenderer.invoke('live:hangup',payload),
  requestLiveClose: (reason='manual') => ipcRenderer.invoke('live:request-close',{reason}),
  confirmLiveClosed: (payload) => ipcRenderer.invoke('live:confirmed-close',payload),
  markLiveTransportLost: (sessionId) => ipcRenderer.invoke('live:transport-lost',{sessionId}),
  getLiveStatus: () => ipcRenderer.invoke('live:get-status'),
  acknowledgeUnknownLive: () => ipcRenderer.invoke('live:acknowledge-unknown'),
  onCloseRequest: (callback) => {
    const listener = (_event,payload) => callback(payload);
    ipcRenderer.on('live:close-request',listener);
    return () => ipcRenderer.removeListener('live:close-request',listener);
  },
  onUnconfirmedClose: (callback) => {
    const listener = (_event,payload) => callback(payload);
    ipcRenderer.on('live:unconfirmed',listener);
    return () => ipcRenderer.removeListener('live:unconfirmed',listener);
  },
  onWindowCloseRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('live:window-close-request',listener);
    return () => ipcRenderer.removeListener('live:window-close-request',listener);
  },
  finishWindowClose: () => ipcRenderer.invoke('live:window-close-ready'),
  onGradeClosePending: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('grade:close-pending',listener);
    return () => ipcRenderer.removeListener('grade:close-pending',listener);
  },
  grade: (payload) => ipcRenderer.invoke('interview:grade', payload),
  copyText: (text) => ipcRenderer.invoke('ui:copy-text',{text}),
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
