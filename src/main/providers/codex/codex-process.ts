import { spawn } from 'node:child_process'

import { CodexJsonRpcClient, type CodexJsonRpcClientOptions } from './jsonrpc-client'
import { resolveCodexBinaryPath, type ResolveCodexBinaryPathOptions } from './codex-path'

export interface StartCodexAppServerOptions extends ResolveCodexBinaryPathOptions {
  clientVersion: string
  rpc?: CodexJsonRpcClientOptions
  envForChild?: NodeJS.ProcessEnv
}

export const codexSpawnSpec = (options: StartCodexAppServerOptions) => ({
  command: resolveCodexBinaryPath(options),
  args: ['app-server'] as ['app-server'],
  options: {
    shell: false as const,
    windowsHide: true,
    env: options.envForChild ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe']
  }
})

export const startCodexAppServer = async (
  options: StartCodexAppServerOptions
): Promise<CodexJsonRpcClient> => {
  const spec = codexSpawnSpec(options)
  const child = spawn(spec.command, spec.args, spec.options)
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
    throw error
  }
}
