import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'

export const AI_DEBATES_CODEX_CONFIG = `forced_login_method = "chatgpt"
default_permissions = "ai-debates"
web_search = "disabled"

[history]
persistence = "none"

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false

[features]
shell_tool = false
unified_exec = false
apps = false
multi_agent = false
hooks = false
goals = false
skill_mcp_dependency_install = false
shell_snapshot = false

[permissions.ai-debates.filesystem]
":root" = "deny"
":minimal" = "read"

[permissions.ai-debates.filesystem.":workspace_roots"]
"." = "read"

[permissions.ai-debates.network]
enabled = false
`

const comparablePath = (path: string): string => {
  const result = normalize(path)
  return process.platform === 'win32' ? result.toLowerCase() : result
}

const validateAbsolutePath = (path: string): void => {
  if (path.includes('\0') || !isAbsolute(path)) {
    throw new Error('Codex home must be an absolute directory path')
  }
}

const ensureRealDirectoryWithoutSymlinks = async (path: string): Promise<void> => {
  const status = await lstat(path)
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('Codex home must be an app-owned directory')
  }
  const actual = await realpath(path)
  if (comparablePath(actual) !== comparablePath(resolve(path))) {
    throw new Error('Codex home cannot contain symbolic links')
  }
}

export const prepareCodexHome = async (codexHome: string): Promise<void> => {
  validateAbsolutePath(codexHome)
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  await ensureRealDirectoryWithoutSymlinks(codexHome)

  const configPath = join(codexHome, 'config.toml')
  try {
    const status = await lstat(configPath)
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error('Codex configuration path is unsafe')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporaryPath = join(
    codexHome,
    `.config.toml.ai-debates-${randomBytes(12).toString('hex')}.tmp`
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(AI_DEBATES_CODEX_CONFIG, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, configPath)
    await access(configPath, constants.R_OK)
    if ((await readFile(configPath, 'utf8')) !== AI_DEBATES_CODEX_CONFIG) {
      throw new Error('Codex configuration verification failed')
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error instanceof Error ? error : new Error('Codex configuration installation failed')
  }
}

const CHILD_ENV_ALLOWLIST = [
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL'
] as const

export const buildCodexChildEnv = (
  codexHome: string,
  hostEnv: Readonly<NodeJS.ProcessEnv> = process.env
): NodeJS.ProcessEnv => {
  validateAbsolutePath(codexHome)
  const result: NodeJS.ProcessEnv = { CODEX_HOME: codexHome }
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = hostEnv[key]
    if (value !== undefined) result[key] = value
  }
  return result
}
