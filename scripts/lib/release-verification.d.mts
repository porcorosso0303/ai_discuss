import type { LockedCodexRuntime } from './codex-stage.mjs'

export function assertPeX64(buffer: Buffer, label: string): void
export function assertBuilderConfig(config: unknown): void
export function assertAsarContents(entries: string[]): void

export interface StagedRuntimeResult {
  codexPath: string
  helperPath: string
  manifest: LockedCodexRuntime & { binarySha256: string; schemaVersion?: number }
}

export function verifyStagedRuntime(options: {
  root: string
  expectedVersion: string
  platform?: NodeJS.Platform
}): Promise<StagedRuntimeResult>

export function verifyArtifact(options: { root: string }): Promise<{
  artifactPath: string
  size: number
  sha256: string
}>
