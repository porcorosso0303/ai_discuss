import { contextBridge, ipcRenderer } from 'electron'

export interface AppApi {
  getVersion: () => Promise<string>
}

const appApi: AppApi = Object.freeze({
  getVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>
})

contextBridge.exposeInMainWorld('app', appApi)
