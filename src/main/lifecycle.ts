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
  registerIpcHandlers: () => void
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
  let shutdownStarted = false
  let allowQuit = false

  const disposeAndQuit = async (): Promise<void> => {
    if (shutdownStarted) return
    shutdownStarted = true
    try {
      await disposeApplication()
    } catch (error) {
      logger.error('Failed to close application services', error)
    } finally {
      allowQuit = true
      app.quit()
    }
  }

  const quitAfterFailure = async (message: string, error: unknown): Promise<void> => {
    logger.error(message, error)
    await disposeAndQuit()
  }

  try {
    onBeforeQuit((event) => {
      if (allowQuit) return
      event.preventDefault()
      void disposeAndQuit()
    })

    onWindowAllClosed(() => {
      if (platform !== 'darwin') {
        app.quit()
      }
    })

    await app.whenReady()
    registerIpcHandlers()
    await createWindow()

    onActivate(() => {
      if (getAllWindows().length === 0) {
        void createWindow().catch((error: unknown) => {
          void quitAfterFailure('Failed to create an application window', error)
        })
      }
    })
  } catch (error) {
    await quitAfterFailure('Failed to start the application', error)
  }
}
