import type { AiDebatesApi } from '../../../preload'

declare global {
  interface Window {
    readonly aiDebates: AiDebatesApi
  }
}

export {}
