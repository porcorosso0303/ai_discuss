import { describe, expect, it, vi } from 'vitest'

import { startApplication } from '../../../src/main/lifecycle'

type AppEvent = 'activate' | 'window-all-closed' | 'before-quit'

function createLifecycleHarness() {
  const listeners = new Map<AppEvent, () => void>()
  const app = {
    quit: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined)
  }
  const createWindow = vi.fn().mockResolvedValue(undefined)
  const getAllWindows = vi.fn((): unknown[] => [])
  const logger = { error: vi.fn() }
  const onActivate = vi.fn((listener: () => void) => {
    listeners.set('activate', listener)
  })
  const onWindowAllClosed = vi.fn((listener: () => void) => {
    listeners.set('window-all-closed', listener)
  })
  const onBeforeQuit = vi.fn((listener: (event: { preventDefault(): void }) => void) => {
    listeners.set('before-quit', listener as () => void)
  })
  const registerIpcHandlers = vi.fn()
  const disposeApplication = vi.fn().mockResolvedValue(undefined)

  return {
    app,
    createWindow,
    getAllWindows,
    listeners,
    logger,
    onActivate,
    onBeforeQuit,
    onWindowAllClosed,
    registerIpcHandlers,
    disposeApplication
  }
}

describe('application lifecycle', () => {
  it('registers lifecycle handlers and recreates the window on activate', async () => {
    const harness = createLifecycleHarness()

    await startApplication({ ...harness, platform: 'win32' })

    expect(harness.registerIpcHandlers).toHaveBeenCalledOnce()
    expect(harness.createWindow).toHaveBeenCalledOnce()
    expect(harness.listeners.get('activate')).toBeTypeOf('function')
    expect(harness.listeners.get('window-all-closed')).toBeTypeOf('function')

    harness.listeners.get('activate')?.()
    await vi.waitFor(() => expect(harness.createWindow).toHaveBeenCalledTimes(2))

    harness.listeners.get('window-all-closed')?.()
    expect(harness.app.quit).toHaveBeenCalledOnce()
  })

  it('prevents quit once, awaits idempotent disposal, then quits without a loop', async () => {
    const harness = createLifecycleHarness()
    let release!: () => void
    harness.disposeApplication.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    await startApplication({ ...harness, platform: 'win32' })
    const preventDefault = vi.fn()
    const beforeQuit = harness.listeners.get('before-quit') as unknown as (event: { preventDefault(): void }) => void

    beforeQuit({ preventDefault })
    beforeQuit({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(harness.disposeApplication).toHaveBeenCalledOnce()
    expect(harness.app.quit).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce())

    beforeQuit({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(harness.app.quit).toHaveBeenCalledOnce()
  })

  it('does not register IPC or create a window when quit is requested before readiness', async () => {
    const harness = createLifecycleHarness()
    let ready!: () => void
    harness.app.whenReady.mockReturnValueOnce(new Promise<void>((resolve) => { ready = resolve }))
    const starting = startApplication({ ...harness, platform: 'win32' })
    const beforeQuit = harness.listeners.get('before-quit') as unknown as
      (event: { preventDefault(): void }) => void
    beforeQuit({ preventDefault: vi.fn() })
    ready()
    await starting

    expect(harness.registerIpcHandlers).not.toHaveBeenCalled()
    expect(harness.createWindow).not.toHaveBeenCalled()
    expect(harness.disposeApplication).toHaveBeenCalledOnce()
    expect(harness.app.quit).toHaveBeenCalledOnce()
  })

  it('does not create a window when quit begins during IPC registration', async () => {
    const harness = createLifecycleHarness()
    harness.registerIpcHandlers.mockImplementationOnce(() => {
      const beforeQuit = harness.listeners.get('before-quit') as unknown as
        (event: { preventDefault(): void }) => void
      beforeQuit({ preventDefault: vi.fn() })
    })

    await startApplication({ ...harness, platform: 'win32' })

    expect(harness.createWindow).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(harness.disposeApplication).toHaveBeenCalledOnce())
  })

  it('waits for asynchronous IPC registration and still honors quit before window creation', async () => {
    const harness = createLifecycleHarness()
    let finishRegistration!: () => void
    harness.registerIpcHandlers.mockReturnValueOnce(
      new Promise<void>((resolve) => { finishRegistration = resolve })
    )
    const starting = startApplication({ ...harness, platform: 'win32' })
    await vi.waitFor(() => expect(harness.registerIpcHandlers).toHaveBeenCalledOnce())
    const beforeQuit = harness.listeners.get('before-quit') as unknown as
      (event: { preventDefault(): void }) => void
    beforeQuit({ preventDefault: vi.fn() })
    finishRegistration()
    await starting

    expect(harness.createWindow).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(harness.disposeApplication).toHaveBeenCalledOnce())
  })

  it('does not install activate recreation after quit begins during initial window creation', async () => {
    const harness = createLifecycleHarness()
    harness.createWindow.mockImplementationOnce(async () => {
      const beforeQuit = harness.listeners.get('before-quit') as unknown as
        (event: { preventDefault(): void }) => void
      beforeQuit({ preventDefault: vi.fn() })
    })

    await startApplication({ ...harness, platform: 'win32' })

    expect(harness.onActivate).not.toHaveBeenCalled()
    expect(harness.disposeApplication).toHaveBeenCalledOnce()
  })

  it('logs and quits when initial window creation fails without rejecting startup', async () => {
    const harness = createLifecycleHarness()
    const error = new Error('initial renderer load failed')
    harness.createWindow.mockRejectedValueOnce(error)

    await expect(
      startApplication({ ...harness, platform: 'win32' })
    ).resolves.toBeUndefined()

    expect(harness.logger.error).toHaveBeenCalledWith(
      'Failed to start the application',
      error
    )
    expect(harness.disposeApplication).toHaveBeenCalledOnce()
    expect(harness.app.quit).toHaveBeenCalledOnce()
  })

  it('logs and quits when window recreation fails without an unhandled rejection', async () => {
    const harness = createLifecycleHarness()
    const error = new Error('restored renderer load failed')
    harness.createWindow.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error)

    await startApplication({ ...harness, platform: 'win32' })
    harness.listeners.get('activate')?.()

    await vi.waitFor(() => {
      expect(harness.logger.error).toHaveBeenCalledWith(
        'Failed to create an application window',
        error
      )
      expect(harness.app.quit).toHaveBeenCalledOnce()
    })
  })
})
