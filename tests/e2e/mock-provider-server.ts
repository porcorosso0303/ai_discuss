import { createServer, type Server, type ServerResponse } from 'node:http'

export type MockScenario = 'agree' | 'concede' | 'continue' | 'pause' | 'fail-first'

export interface ProviderRequestRecord {
  provider: 'kimi' | 'deepseek'
  authorization?: string
  body?: Record<string, unknown>
}

const readBody = async (request: NodeJS.ReadableStream): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

const sendSse = async (
  response: ServerResponse,
  provider: 'kimi' | 'deepseek',
  reply: string,
  delayMs: number
): Promise<void> => {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  const midpoint = Math.max(1, Math.floor(reply.length / 2))
  const fragments = [reply.slice(0, midpoint), reply.slice(midpoint)]
  for (const [index, content] of fragments.entries()) {
    const chunk = provider === 'kimi'
      ? { id: 'kimi-e2e', object: 'chat.completion.chunk', created: 1, model: 'kimi-k3', choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), content }, finish_reason: null }] }
      : { id: 'deepseek-e2e', object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), content }, finish_reason: null }], usage: null }
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  if (provider === 'kimi') {
    response.write(`data: ${JSON.stringify({ id: 'kimi-e2e', object: 'chat.completion.chunk', created: 1, model: 'kimi-k3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify({ id: 'deepseek-e2e', object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'deepseek-e2e', object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 4 } })}\n\n`)
  }
  response.write('data: [DONE]\n\n')
  response.end()
}

export class MockProviderServer {
  private server?: Server
  private scenario: MockScenario = 'agree'
  private chatCount = 0
  readonly requests: ProviderRequestRecord[] = []
  baseUrl = ''

  setScenario(scenario: MockScenario): void {
    this.scenario = scenario
    this.chatCount = 0
    this.requests.length = 0
  }

  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      const provider = request.url?.startsWith('/kimi/') ? 'kimi' : 'deepseek'
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(provider === 'kimi'
          ? { object: 'list', data: [{ id: 'kimi-k3', object: 'model', created: 1, owned_by: 'e2e', supports_reasoning: true, context_length: 128000 }] }
          : { object: 'list', data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'e2e' }] }))
        return
      }
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end()
        return
      }
      const body = await readBody(request)
      this.requests.push({ provider, authorization: request.headers.authorization, body })
      const call = ++this.chatCount
      if (this.scenario === 'fail-first' && call === 1) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'scripted failure' } }))
        return
      }
      const status = this.scenario === 'concede' && call === 1
        ? 'concede'
        : this.scenario === 'agree' && call <= 2 ? 'agree' : 'continue'
      const speech = this.scenario === 'concede' ? '我承认对方获胜。'
        : status === 'agree' ? `第${call}位辩手同意这一结论。` : `第${call}轮继续论证。`
      await sendSse(response, provider, JSON.stringify({ speech, status }), this.scenario === 'pause' && call === 1 ? 180 : 0)
    })
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Mock server did not bind TCP')
    this.baseUrl = `http://127.0.0.1:${address.port}`
  }

  async close(): Promise<void> {
    if (this.server === undefined) return
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()))
    this.server = undefined
  }
}
