import { pathToFileURL } from 'node:url'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  IPC_INVOKE_CHANNELS,
  ipcEventContracts,
  ipcInvokeContracts,
  type IpcEventChannel,
  type IpcEventMap,
  type IpcInvokeChannel
} from '../../shared/ipc'

export interface DesktopIpcServicePort {
  invoke(channel: IpcInvokeChannel, request: unknown): Promise<unknown>
}

export interface DesktopIpcLogPort {
  error(error: unknown, context?: unknown): Promise<void> | void
}

export type DesktopIpcRuntime =
  | { isDevelopment: true; rendererUrl: string }
  | { isDevelopment: false; rendererPath: string }

export interface RegisterDesktopIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  services: DesktopIpcServicePort
  log: DesktopIpcLogPort
  runtime: DesktopIpcRuntime
}

export interface DesktopIpcRegistration {
  dispose(): void
  sendEvent<Channel extends IpcEventChannel>(
    target: TrustedWebContents,
    channel: Channel,
    payload: IpcEventMap[Channel]
  ): boolean
}

interface TrustedWebContents {
  isDestroyed(): boolean
  readonly mainFrame: { readonly url: string }
  send(channel: string, payload: unknown): void
}

const activeRegistrations = new WeakMap<object, () => void>()

const expectedRendererUrl = (runtime: DesktopIpcRuntime): string =>
  runtime.isDevelopment
    ? new URL(runtime.rendererUrl).href
    : pathToFileURL(runtime.rendererPath).href

const isTrustedWebContents = (
  sender: Pick<TrustedWebContents, 'isDestroyed' | 'mainFrame'>,
  expectedUrl: string
): boolean => {
  if (sender.isDestroyed()) return false
  try {
    return new URL(sender.mainFrame.url).href === expectedUrl
  } catch {
    return false
  }
}

const safeFailure = (): Error => {
  const error = new Error('桌面请求失败')
  Object.defineProperty(error, 'code', { value: 'DESKTOP_REQUEST_FAILED', enumerable: true })
  return error
}

export function registerDesktopIpc({
  ipcMain,
  services,
  log,
  runtime
}: RegisterDesktopIpcDependencies): DesktopIpcRegistration {
  const previous = activeRegistrations.get(ipcMain as object)
  previous?.()
  const expectedUrl = expectedRendererUrl(runtime)
  let disposed = false

  const recordFailure = (error: unknown, channel: IpcInvokeChannel): void => {
    try {
      void Promise.resolve(log.error(error, { boundary: 'ipc', channel })).catch(() => undefined)
    } catch {
      // Logging must never leak or replace the fixed IPC failure.
    }
  }

  for (const channel of IPC_INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<unknown> => {
      try {
        if (
          disposed ||
          event.senderFrame === null ||
          event.senderFrame !== event.sender.mainFrame ||
          !isTrustedWebContents(event.sender, expectedUrl)
        ) {
          throw new Error('Untrusted renderer')
        }
        const request = ipcInvokeContracts[channel].request.parse(raw)
        const response = await services.invoke(channel, request)
        return ipcInvokeContracts[channel].response.parse(response)
      } catch (error) {
        recordFailure(error, channel)
        throw safeFailure()
      }
    })
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const channel of IPC_INVOKE_CHANNELS) ipcMain.removeHandler(channel)
    if (activeRegistrations.get(ipcMain as object) === dispose) {
      activeRegistrations.delete(ipcMain as object)
    }
  }
  activeRegistrations.set(ipcMain as object, dispose)

  return {
    dispose,
    sendEvent: (target, channel, payload): boolean => {
      if (disposed || !isTrustedWebContents(target, expectedUrl)) return false
      const result = ipcEventContracts[channel].safeParse(payload)
      if (!result.success) return false
      try {
        target.send(channel, result.data)
        return true
      } catch {
        return false
      }
    }
  }
}
