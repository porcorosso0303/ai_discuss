export interface LockedCodexRuntime {
  package: '@openai/codex-win32-x64'
  packageVersion: string
  codexVersion: string
  resolved: string
  integrity: string
}

export function assertRegistryTarball(value: string): URL
export function resolveLockedCodexRuntime(lock: unknown, expectedVersion: string): LockedCodexRuntime
export function verifyIntegrity(bytes: Uint8Array, integrity: string): void
