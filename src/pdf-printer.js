'use strict';
const {BrowserWindow} = require('electron');

// Use exactly the same printer in the app and in the Windows CI smoke test.
async function printReport(html) {
  const window = new BrowserWindow({
    show:false, width:850, height:1100,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}
  });
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await window.webContents.printToPDF({pageSize:'A4',printBackground:true});
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}
module.exports = {printReport};
