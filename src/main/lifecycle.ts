interface LifecycleApp {
  quit: () => void
  whenReady: () => Promise<unknown>
}

export interface ApplicationLifecycleDependencies {
  app: LifecycleApp
  createWindow: () => Promise<unknown>
  getAllWindows: () => readonly unknown[]
  logger: Pick<Console, 'error'>
  onActivate: (listener: () => void) => unknown
  onWindowAllClosed: (listener: () => void) => unknown
  platform: NodeJS.Platform
  registerIpcHandlers: () => void
}

export async function startApplication({
  app,
  createWindow,
  getAllWindows,
  logger,
  onActivate,
  onWindowAllClosed,
  platform,
  registerIpcHandlers
}: ApplicationLifecycleDependencies): Promise<void> {
  const quitAfterFailure = (message: string, error: unknown): void => {
    logger.error(message, error)
    app.quit()
  }

  try {
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
          quitAfterFailure('Failed to create an application window', error)
        })
      }
    })
  } catch (error) {
    quitAfterFailure('Failed to start the application', error)
  }
}
