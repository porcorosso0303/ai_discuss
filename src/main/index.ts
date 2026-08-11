import { join } from 'node:path'

import { app, BrowserWindow, ipcMain } from 'electron'

import { createAppWindow } from './create-window'
import { startApplication } from './lifecycle'

const preloadPath = join(__dirname, '../preload/index.js')
const windowRuntime = {
  isDevelopment: !app.isPackaged,
  rendererUrl: process.env.ELECTRON_RENDERER_URL
}

function registerIpcHandlers(): void {
  ipcMain.handle('app:get-version', () => app.getVersion())
}

void startApplication({
  app,
  createWindow: () => createAppWindow(preloadPath, BrowserWindow, windowRuntime),
  getAllWindows: () => BrowserWindow.getAllWindows(),
  logger: console,
  onActivate: (listener) => app.on('activate', listener),
  onWindowAllClosed: (listener) => app.on('window-all-closed', listener),
  platform: process.platform,
  registerIpcHandlers
})
