import { statSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'

export interface ResolveCodexBinaryPathOptions {
  isPackaged: boolean
  resourcesPath: string
  env?: Readonly<Record<string, string | undefined>>
}

const isAbsoluteForHostOrWindows = (path: string): boolean =>
  isAbsolute(path) || win32.isAbsolute(path)

export const resolveCodexBinaryPath = ({
  isPackaged,
  resourcesPath,
  env = process.env
}: ResolveCodexBinaryPathOptions): string => {
  const override = !isPackaged ? env.CODEX_BIN : undefined
  const candidate = override ?? join(resourcesPath, 'bin', 'codex.exe')
  if (candidate.includes('\0') || !isAbsoluteForHostOrWindows(candidate)) {
    throw new Error('Codex binary path must be an absolute file path')
  }
  let status
  try {
    status = statSync(candidate)
  } catch {
    throw new Error('Codex binary is unavailable')
  }
  if (!status.isFile()) throw new Error('Codex binary path is not a file')
  return candidate
}
