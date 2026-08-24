import { join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

import { createAppWindow, getTrustedDevelopmentUrl } from './create-window'
import { registerDesktopIpc, type DesktopIpcRegistration } from './ipc/register-ipc'
import { startApplication } from './lifecycle'
import { createProductionDesktopServices, type DesktopServices } from './services'

const preloadPath = join(__dirname, '../preload/index.js')
const rendererPath = join(__dirname, '../renderer/index.html')
const developmentRendererUrl = getTrustedDevelopmentUrl(process.env.ELECTRON_RENDERER_URL)
const windowRuntime = {
  isDevelopment: !app.isPackaged,
  rendererUrl: process.env.ELECTRON_RENDERER_URL
}
let services: DesktopServices | undefined
let ipcRegistration: DesktopIpcRegistration | undefined

function registerIpcHandlers(): void {
  let nextRegistration: DesktopIpcRegistration | undefined
  const production = createProductionDesktopServices({
    app,
    resourcesPath: process.resourcesPath,
    env: process.env,
    dialog: { showSaveDialog: (options) => dialog.showSaveDialog(options) },
    openExternal: (url) => shell.openExternal(url),
    emit: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        nextRegistration?.sendEvent(window.webContents, channel, payload)
      }
    }
  })
  try {
    nextRegistration = registerDesktopIpc({
      ipcMain,
      services: production.services,
      log: production.log,
      runtime: developmentRendererUrl === undefined
        ? { isDevelopment: false, rendererPath }
        : { isDevelopment: true, rendererUrl: developmentRendererUrl }
    })
    services = production.services
    ipcRegistration = nextRegistration
  } catch (error) {
    void production.services.dispose()
    throw error
  }
}

async function disposeApplication(): Promise<void> {
  ipcRegistration?.dispose()
  ipcRegistration = undefined
  const current = services
  services = undefined
  await current?.dispose()
}

void startApplication({
  app,
  createWindow: () => createAppWindow(preloadPath, BrowserWindow, windowRuntime),
  getAllWindows: () => BrowserWindow.getAllWindows(),
  logger: console,
  onActivate: (listener) => app.on('activate', listener),
  onBeforeQuit: (listener) => app.on('before-quit', listener),
  onWindowAllClosed: (listener) => app.on('window-all-closed', listener),
  platform: process.platform,
  registerIpcHandlers,
  disposeApplication
})
