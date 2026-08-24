import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS } from '../../../src/shared/ipc'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener
  }
}))

describe('preload aiDebates API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  async function exposedApi(): Promise<Record<string, any>> {
    await import('../../../src/preload/index')
    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce()
    const [namespace, api] = electron.exposeInMainWorld.mock.calls[0]
    expect(namespace).toBe('aiDebates')
    return api
  }

  it('exposes only the grouped, deeply frozen desktop API', async () => {
    const api = await exposedApi()

    expect(Reflect.ownKeys(api)).toEqual([
      'app', 'config', 'credentials', 'openAI', 'providers', 'debate', 'history', 'export'
    ])
    expect(Reflect.ownKeys(api.debate)).toEqual([
      'start', 'pause', 'resume', 'stop', 'retryCurrentTurn', 'onEvent'
    ])
    expect(Reflect.ownKeys(api.openAI)).toEqual([
      'getAuthStatus', 'startLogin', 'logout', 'onAuthChanged'
    ])
    expect(Object.isFrozen(api)).toBe(true)
    for (const value of Object.values(api)) expect(Object.isFrozen(value)).toBe(true)
    expect(JSON.stringify(api)).not.toMatch(/invoke|send|shell|openExternal|url|path/i)
  })

  it('constructs strict requests and validates responses in preload', async () => {
    electron.invoke.mockResolvedValueOnce('0.1.0')
    const api = await exposedApi()
    await expect(api.app.getVersion()).resolves.toBe('0.1.0')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.appGetVersion, {})

    electron.invoke.mockResolvedValueOnce({ version: 'secret-shaped-invalid-response' })
    await expect(api.app.getVersion()).rejects.toThrow('桌面服务返回了无效数据')
  })

  it('filters invalid event payloads and unsubscribes exactly once', async () => {
    const api = await exposedApi()
    const listener = vi.fn()
    const unsubscribe = api.openAI.onAuthChanged(listener)
    const [, bridgeListener] = electron.on.mock.calls[0]

    bridgeListener({ sender: 'must-not-be-exposed' }, { status: 'signed-in', accountLabel: 'Plus' })
    bridgeListener({}, { status: 'signed-in', token: 'forbidden' })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ status: 'signed-in', accountLabel: 'Plus' })

    unsubscribe()
    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledTimes(1)
    expect(electron.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.openAIAuthChanged,
      bridgeListener
    )
  })
})
