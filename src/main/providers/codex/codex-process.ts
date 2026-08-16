import { spawn } from 'node:child_process'

import { buildCodexChildEnv, prepareCodexHome } from './codex-config'
import { CodexJsonRpcClient, type CodexJsonRpcClientOptions } from './jsonrpc-client'
import type { CodexProcessTransport } from './jsonrpc-client'
import { resolveCodexBinaryPath, type ResolveCodexBinaryPathOptions } from './codex-path'

export interface StartCodexAppServerOptions extends ResolveCodexBinaryPathOptions {
  clientVersion: string
  codexHome: string
  rpc?: CodexJsonRpcClientOptions
  hostEnv?: Readonly<NodeJS.ProcessEnv>
  spawnProcess?: CodexSpawnProcess
}

interface CodexSpawnOptions {
  shell: false
  windowsHide: true
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
}

export type CodexSpawnProcess = (
  command: string,
  args: readonly string[],
  options: CodexSpawnOptions
) => CodexProcessTransport

const EXPECTED_CODEX_VERSION = /^codex-cli 0\.147\.0\r?\n?$/u
const MAX_VERSION_OUTPUT_BYTES = 1_024
const VERSION_TIMEOUT_MS = 5_000

const verifyCodexVersion = async (
  command: string,
  options: CodexSpawnOptions,
  spawnProcess: CodexSpawnProcess
): Promise<void> => {
  let child: CodexProcessTransport
  try {
    child = spawnProcess(command, ['--version'], options)
  } catch {
    throw new Error('Unable to verify the Codex binary version')
  }

  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    let outputBytes = 0
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      child.stdout.off('data', handleStdout)
      child.stdout.off('error', fail)
      child.stderr.off('data', handleStderr)
      child.stderr.off('error', fail)
      child.off('error', fail)
      child.off('close', handleClose)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve()
      else {
        child.kill()
        reject(error)
      }
    }
    const fail = (): void => finish(new Error('Unable to verify the Codex binary version'))
    const reserveOutput = (chunk: Buffer | string): boolean => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > MAX_VERSION_OUTPUT_BYTES) {
        fail()
        return false
      }
      return true
    }
    const handleStdout = (chunk: Buffer | string): void => {
      if (reserveOutput(chunk)) stdout += chunk.toString()
    }
    const handleStderr = (chunk: Buffer | string): void => {
      reserveOutput(chunk)
    }
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (
        code === 0 &&
        signal === null &&
        EXPECTED_CODEX_VERSION.test(stdout)
      ) {
        finish()
      } else {
        fail()
      }
    }
    const timeout = setTimeout(fail, VERSION_TIMEOUT_MS)
    child.stdout.on('data', handleStdout)
    child.stdout.once('error', fail)
    child.stderr.on('data', handleStderr)
    child.stderr.once('error', fail)
    child.once('error', fail)
    child.once('close', handleClose)
    try {
      child.stdin.end()
    } catch {
      fail()
    }
  })
}

export const codexSpawnSpec = (options: StartCodexAppServerOptions) => ({
  command: resolveCodexBinaryPath(options),
  args: ['app-server', '--strict-config'] as ['app-server', '--strict-config'],
  options: {
    shell: false as const,
    windowsHide: true as const,
    env: buildCodexChildEnv(options.codexHome, options.hostEnv),
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe']
  }
})

export const startCodexAppServer = async (
  options: StartCodexAppServerOptions
): Promise<CodexJsonRpcClient> => {
  await prepareCodexHome(options.codexHome)
  const spec = codexSpawnSpec(options)
  const spawnProcess: CodexSpawnProcess =
    options.spawnProcess ??
    ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
  await verifyCodexVersion(spec.command, spec.options, spawnProcess)
  const child = spawnProcess(spec.command, spec.args, spec.options)
  const client = new CodexJsonRpcClient(child, options.rpc)
  try {
    await client.initialize({
      name: 'ai_debates',
      title: 'AI Debates',
      version: options.clientVersion
    })
    return client
  } catch (error) {
    await client.dispose()
    throw error instanceof Error ? error : new Error('Codex App Server failed to start')
  }
}
