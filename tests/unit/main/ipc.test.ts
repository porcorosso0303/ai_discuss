import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { registerDesktopIpc } from '../../../src/main/ipc/register-ipc'
import { IPC_CHANNELS, IPC_INVOKE_CHANNELS } from '../../../src/shared/ipc'

function harness(development = false) {
  const handlers = new Map<string, (event: any, input: unknown) => Promise<unknown>>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (event: any, input: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }
  const services = {
    invoke: vi.fn(async (channel: string) => channel === IPC_CHANNELS.appGetVersion ? '0.1.0' : {})
  }
  const log = { error: vi.fn().mockResolvedValue(undefined) }
  const rendererPath = '/opt/ai-debates/out/renderer/index.html'
  const runtime = development
    ? { isDevelopment: true, rendererUrl: 'http://localhost:5173/' }
    : { isDevelopment: false, rendererPath }
  const registration = registerDesktopIpc({
    ipcMain,
    services,
    log,
    runtime: runtime as
      | { isDevelopment: true; rendererUrl: string }
      | { isDevelopment: false; rendererPath: string }
  })
  const trustedUrl = development
    ? 'http://localhost:5173/'
    : pathToFileURL(rendererPath).toString()
  const sender = {
    mainFrame: { url: trustedUrl },
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  }
  const event = { sender, senderFrame: sender.mainFrame }
  return { event, handlers, ipcMain, log, registration, sender, services, trustedUrl }
}

describe('desktop IPC registration', () => {
  it('registers only declared invoke channels and parses both boundaries', async () => {
    const h = harness()
    expect([...h.handlers.keys()]).toEqual(IPC_INVOKE_CHANNELS)
    await expect(h.handlers.get(IPC_CHANNELS.appGetVersion)?.(h.event, {})).resolves.toBe('0.1.0')
    await expect(
      h.handlers.get(IPC_CHANNELS.appGetVersion)?.(h.event, { secretKey: 'must-not-enter' })
    ).rejects.toThrow('桌面请求失败')
    expect(h.services.invoke).toHaveBeenCalledTimes(1)

    h.services.invoke.mockResolvedValueOnce({ invalid: true })
    await expect(h.handlers.get(IPC_CHANNELS.appGetVersion)?.(h.event, {})).rejects.toThrow(
      '桌面请求失败'
    )
  })

  it('rejects subframes and renderer origins not used by the app window', async () => {
    const h = harness(true)
    const handler = h.handlers.get(IPC_CHANNELS.appGetVersion)!
    await expect(handler({ ...h.event, senderFrame: { url: h.trustedUrl } }, {})).rejects.toThrow(
      '桌面请求失败'
    )
    h.sender.mainFrame.url = 'http://localhost:5174/'
    await expect(handler(h.event, {})).rejects.toThrow('桌面请求失败')
    h.sender.mainFrame.url = 'http://localhost.evil.test:5173/'
    await expect(handler(h.event, {})).rejects.toThrow('桌面请求失败')
    expect(h.services.invoke).not.toHaveBeenCalled()
  })

  it('validates events and sends only to a still-trusted live main frame', () => {
    const h = harness()
    const event = {
      id: 'event-1', sessionId: 'session-1', createdAt: new Date().toISOString(),
      type: 'state-changed' as const, state: 'running' as const
    }
    expect(h.registration.sendEvent(h.sender, IPC_CHANNELS.debateEvent, event)).toBe(true)
    expect(h.sender.send).toHaveBeenCalledWith(IPC_CHANNELS.debateEvent, event)
    const invalidEvent = { ...event, apiKey: 'x' } as unknown as typeof event
    expect(h.registration.sendEvent(h.sender, IPC_CHANNELS.debateEvent, invalidEvent)).toBe(false)
    h.sender.mainFrame.url = 'https://evil.test/'
    expect(h.registration.sendEvent(h.sender, IPC_CHANNELS.debateEvent, event)).toBe(false)
    h.sender.isDestroyed.mockReturnValue(true)
    expect(h.registration.sendEvent(h.sender, IPC_CHANNELS.debateEvent, event)).toBe(false)
  })

  it('does not stack handlers and dispose is idempotent', () => {
    const h = harness()
    h.registration.dispose()
    h.registration.dispose()
    expect(h.ipcMain.removeHandler).toHaveBeenCalledTimes(IPC_INVOKE_CHANNELS.length)
  })
})
