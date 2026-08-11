import { join } from 'node:path'

import { app, BrowserWindow, ipcMain } from 'electron'

import { createAppWindow } from './create-window'

const preloadPath = join(__dirname, '../preload/index.js')
const windowRuntime = {
  isDevelopment: !app.isPackaged,
  rendererUrl: process.env.ELECTRON_RENDERER_URL
}

function registerIpcHandlers(): void {
  ipcMain.handle('app:get-version', () => app.getVersion())
}

app.whenReady().then(async () => {
  registerIpcHandlers()
  await createAppWindow(preloadPath, BrowserWindow, windowRuntime)

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createAppWindow(preloadPath, BrowserWindow, windowRuntime)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
