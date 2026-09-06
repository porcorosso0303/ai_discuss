import { isAbsolute, win32 } from 'node:path'

export interface WindowRuntime {
  isDevelopment: boolean
  rendererUrl?: string
  rendererPath?: string
}

export type DesktopIpcRuntime =
  | { isDevelopment: true; rendererUrl: string }
  | { isDevelopment: false; rendererPath: string }

const trustedDevelopmentHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
const trustedDevelopmentProtocols = new Set(['http:', 'https:'])

export function getTrustedDevelopmentUrl(rendererUrl: string | undefined): string | undefined {
  if (rendererUrl === undefined || rendererUrl === '') return undefined
  try {
    const url = new URL(rendererUrl)
    return trustedDevelopmentProtocols.has(url.protocol) &&
      trustedDevelopmentHosts.has(url.hostname) &&
      url.port === '5173' &&
      url.username === '' &&
      url.password === ''
      ? rendererUrl
      : undefined
  } catch {
    return undefined
  }
}

export function requireAbsoluteRendererPath(rendererPath: string): string {
  if (
    rendererPath.includes('\0') ||
    (!isAbsolute(rendererPath) && !win32.isAbsolute(rendererPath))
  ) {
    throw new Error('Renderer path must be absolute')
  }
  return rendererPath
}

export interface ResolveDesktopRuntimeOptions {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  rendererPath: string
}

export function resolveDesktopRuntime({
  isPackaged,
  env,
  rendererPath
}: ResolveDesktopRuntimeOptions): { window: WindowRuntime; ipc: DesktopIpcRuntime } {
  const fileRuntime = {
    isDevelopment: false as const,
    rendererPath: requireAbsoluteRendererPath(rendererPath)
  }
  if (isPackaged) return { window: fileRuntime, ipc: fileRuntime }
  const rendererUrl = getTrustedDevelopmentUrl(env.ELECTRON_RENDERER_URL)
  if (rendererUrl === undefined) return { window: fileRuntime, ipc: fileRuntime }
  const developmentRuntime = { isDevelopment: true as const, rendererUrl }
  return { window: developmentRuntime, ipc: developmentRuntime }
}
