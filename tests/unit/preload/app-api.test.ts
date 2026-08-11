import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn().mockResolvedValue('0.1.0')
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electron.exposeInMainWorld
  },
  ipcRenderer: {
    invoke: electron.invoke
  }
}))

describe('preload app API', () => {
  it('exposes only app.getVersion through contextBridge', async () => {
    await import('../../../src/preload/index')

    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce()
    const [namespace, api] = electron.exposeInMainWorld.mock.calls[0] as [
      string,
      { getVersion: () => Promise<string> }
    ]

    expect(namespace).toBe('app')
    expect(Reflect.ownKeys(api)).toEqual(['getVersion'])
    expect(Object.isFrozen(api)).toBe(true)
    await expect(api.getVersion()).resolves.toBe('0.1.0')
    expect(electron.invoke).toHaveBeenCalledWith('app:get-version')
  })
})
