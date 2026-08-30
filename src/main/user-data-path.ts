import { isAbsolute, win32 } from 'node:path'

interface UserDataPathApp {
  setPath(name: 'userData', path: string): void
}

const isAbsoluteForHostOrWindows = (path: string): boolean =>
  isAbsolute(path) || win32.isAbsolute(path)

export function configureWindowsUserDataPath(
  app: UserDataPathApp,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') return false
  const localAppData = env.LOCALAPPDATA
  if (
    localAppData === undefined ||
    localAppData.includes('\0') ||
    !isAbsoluteForHostOrWindows(localAppData)
  ) {
    return false
  }
  app.setPath('userData', win32.join(localAppData, 'AI Debates'))
  return true
}
