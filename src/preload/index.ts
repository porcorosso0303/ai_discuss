import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC_CHANNELS,
  ipcEventContracts,
  ipcInvokeContracts,
  type IpcEventChannel,
  type IpcEventMap,
  type IpcInvokeChannel,
  type IpcRequestMap,
  type IpcResponseMap
} from '../shared/ipc'

async function invoke<Channel extends IpcInvokeChannel>(
  channel: Channel,
  request: IpcRequestMap[Channel]
): Promise<IpcResponseMap[Channel]> {
  let parsedRequest: unknown
  try {
    parsedRequest = ipcInvokeContracts[channel].request.parse(request)
  } catch {
    throw new Error('请求参数无效')
  }
  let response: unknown
  try {
    response = await ipcRenderer.invoke(channel, parsedRequest)
  } catch {
    throw new Error('桌面服务暂时不可用')
  }
  try {
    return ipcInvokeContracts[channel].response.parse(response) as IpcResponseMap[Channel]
  } catch {
    throw new Error('桌面服务返回了无效数据')
  }
}

function subscribe<Channel extends IpcEventChannel>(
  channel: Channel,
  listener: (payload: IpcEventMap[Channel]) => void
): () => void {
  const bridgeListener = (_event: unknown, payload: unknown): void => {
    const result = ipcEventContracts[channel].safeParse(payload)
    if (result.success) listener(result.data as IpcEventMap[Channel])
  }
  ipcRenderer.on(channel, bridgeListener)
  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    ipcRenderer.removeListener(channel, bridgeListener)
  }
}

const appApi = Object.freeze({ getVersion: () => invoke(IPC_CHANNELS.appGetVersion, {}) })
const configApi = Object.freeze({
  listRoles: () => invoke(IPC_CHANNELS.configListRoles, {}),
  saveRole: (request: IpcRequestMap[typeof IPC_CHANNELS.configSaveRole]) =>
    invoke(IPC_CHANNELS.configSaveRole, request),
  deleteRole: (request: IpcRequestMap[typeof IPC_CHANNELS.configDeleteRole]) =>
    invoke(IPC_CHANNELS.configDeleteRole, request)
})
const credentialsApi = Object.freeze({
  setProviderSecret: (request: IpcRequestMap[typeof IPC_CHANNELS.credentialsSetProviderSecret]) =>
    invoke(IPC_CHANNELS.credentialsSetProviderSecret, request),
  deleteProviderSecret: (request: IpcRequestMap[typeof IPC_CHANNELS.credentialsDeleteProviderSecret]) =>
    invoke(IPC_CHANNELS.credentialsDeleteProviderSecret, request),
  hasProviderSecret: (request: IpcRequestMap[typeof IPC_CHANNELS.credentialsHasProviderSecret]) =>
    invoke(IPC_CHANNELS.credentialsHasProviderSecret, request)
})
const openAIApi = Object.freeze({
  getAuthStatus: () => invoke(IPC_CHANNELS.openAIGetAuthStatus, {}),
  startLogin: () => invoke(IPC_CHANNELS.openAIStartLogin, {}),
  logout: () => invoke(IPC_CHANNELS.openAILogout, {}),
  onAuthChanged: (listener: (payload: IpcEventMap[typeof IPC_CHANNELS.openAIAuthChanged]) => void) =>
    subscribe(IPC_CHANNELS.openAIAuthChanged, listener)
})
const providersApi = Object.freeze({
  discoverCapabilities: (request: IpcRequestMap[typeof IPC_CHANNELS.providerDiscoverCapabilities]) =>
    invoke(IPC_CHANNELS.providerDiscoverCapabilities, request),
  testConnection: (request: IpcRequestMap[typeof IPC_CHANNELS.providerTestConnection]) =>
    invoke(IPC_CHANNELS.providerTestConnection, request)
})
const debateApi = Object.freeze({
  start: (request: IpcRequestMap[typeof IPC_CHANNELS.debateStart]) => invoke(IPC_CHANNELS.debateStart, request),
  recover: (request: IpcRequestMap[typeof IPC_CHANNELS.debateRecover]) => invoke(IPC_CHANNELS.debateRecover, request),
  pause: (request: IpcRequestMap[typeof IPC_CHANNELS.debatePause]) => invoke(IPC_CHANNELS.debatePause, request),
  resume: (request: IpcRequestMap[typeof IPC_CHANNELS.debateResume]) => invoke(IPC_CHANNELS.debateResume, request),
  stop: (request: IpcRequestMap[typeof IPC_CHANNELS.debateStop]) => invoke(IPC_CHANNELS.debateStop, request),
  retryCurrentTurn: (request: IpcRequestMap[typeof IPC_CHANNELS.debateRetryCurrentTurn]) =>
    invoke(IPC_CHANNELS.debateRetryCurrentTurn, request),
  onEvent: (listener: (payload: IpcEventMap[typeof IPC_CHANNELS.debateEvent]) => void) =>
    subscribe(IPC_CHANNELS.debateEvent, listener)
})
const historyApi = Object.freeze({
  list: (request: IpcRequestMap[typeof IPC_CHANNELS.historyList]) => invoke(IPC_CHANNELS.historyList, request),
  get: (request: IpcRequestMap[typeof IPC_CHANNELS.historyGet]) => invoke(IPC_CHANNELS.historyGet, request),
  delete: (request: IpcRequestMap[typeof IPC_CHANNELS.historyDelete]) => invoke(IPC_CHANNELS.historyDelete, request),
  clear: () => invoke(IPC_CHANNELS.historyClear, {})
})
const exportApi = Object.freeze({
  markdown: (request: IpcRequestMap[typeof IPC_CHANNELS.exportMarkdown]) =>
    invoke(IPC_CHANNELS.exportMarkdown, request)
})

export const aiDebatesApi = Object.freeze({
  app: appApi,
  config: configApi,
  credentials: credentialsApi,
  openAI: openAIApi,
  providers: providersApi,
  debate: debateApi,
  history: historyApi,
  export: exportApi
})

export type AiDebatesApi = typeof aiDebatesApi

contextBridge.exposeInMainWorld('aiDebates', aiDebatesApi)
