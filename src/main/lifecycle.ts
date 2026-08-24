interface LifecycleApp {
  quit: () => void
  whenReady: () => Promise<unknown>
}

interface BeforeQuitEvent {
  preventDefault(): void
}

export interface ApplicationLifecycleDependencies {
  app: LifecycleApp
  createWindow: () => Promise<unknown>
  getAllWindows: () => readonly unknown[]
  logger: Pick<Console, 'error'>
  onActivate: (listener: () => void) => unknown
  onBeforeQuit: (listener: (event: BeforeQuitEvent) => void) => unknown
  onWindowAllClosed: (listener: () => void) => unknown
  platform: NodeJS.Platform
  registerIpcHandlers: () => void | Promise<void>
  disposeApplication: () => Promise<void>
}

export async function startApplication({
  app,
  createWindow,
  getAllWindows,
  logger,
  onActivate,
  onBeforeQuit,
  onWindowAllClosed,
  platform,
  registerIpcHandlers,
  disposeApplication
}: ApplicationLifecycleDependencies): Promise<void> {
  let shutdownRequested = false
  let allowQuit = false
  let shutdownPromise: Promise<void> | undefined
  let registrationBarrier: Promise<void> | undefined

  const disposeAndQuit = (): Promise<void> => {
    shutdownRequested = true
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      const barrier = registrationBarrier
      if (barrier !== undefined) await barrier.catch(() => undefined)
      try {
        await disposeApplication()
      } catch (error) {
        logger.error('Failed to close application services', error)
      } finally {
        allowQuit = true
        app.quit()
      }
    })()
    return shutdownPromise
  }

  const quitAfterFailure = async (message: string, error: unknown): Promise<void> => {
    logger.error(message, error)
    await disposeAndQuit()
  }

  const finishShutdownIfRequested = async (): Promise<boolean> => {
    if (!shutdownRequested) return false
    await shutdownPromise
    return true
  }

  try {
    onBeforeQuit((event) => {
      if (allowQuit) return
      shutdownRequested = true
      event.preventDefault()
      void disposeAndQuit()
    })

    onWindowAllClosed(() => {
      if (platform !== 'darwin') {
        app.quit()
      }
    })

    await app.whenReady()
    if (await finishShutdownIfRequested()) return
    let releaseRegistration!: () => void
    registrationBarrier = new Promise<void>((resolve) => { releaseRegistration = resolve })
    try {
      await registerIpcHandlers()
    } finally {
      releaseRegistration()
      registrationBarrier = undefined
    }
    if (await finishShutdownIfRequested()) return
    await createWindow()
    if (await finishShutdownIfRequested()) return

    onActivate(() => {
      if (shutdownRequested) return
      const windows = getAllWindows()
      if (shutdownRequested) return
      if (windows.length === 0) {
        void createWindow().catch((error: unknown) => {
          if (shutdownRequested) return
          void quitAfterFailure('Failed to create an application window', error)
        })
      }
    })
  } catch (error) {
    await quitAfterFailure('Failed to start the application', error)
  }
}
