import { describe, expect, it, vi } from 'vitest'

import { startApplication } from '../../../src/main/lifecycle'

type AppEvent = 'activate' | 'window-all-closed'

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
  const registerIpcHandlers = vi.fn()

  return {
    app,
    createWindow,
    getAllWindows,
    listeners,
    logger,
    onActivate,
    onWindowAllClosed,
    registerIpcHandlers
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
