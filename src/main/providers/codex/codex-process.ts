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
  const child =
    options.spawnProcess?.(spec.command, spec.args, spec.options) ??
    spawn(spec.command, spec.args, spec.options)
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
