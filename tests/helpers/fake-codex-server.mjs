import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_CODEX_MODE ?? 'normal'
const transcript = process.env.FAKE_CODEX_TRANSCRIPT
let initialized = false
let threadCounter = 0
let turnCounter = 0

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const record = (value) => {
  if (transcript) appendFileSync(transcript, `${JSON.stringify(value)}\n`, 'utf8')
}

if (mode === 'oversized') process.stdout.write(`${'x'.repeat(2048)}\n`)
if (mode === 'malformed') process.stdout.write('{not-json}\n')
if (mode === 'stderr') process.stderr.write(`Bearer ${process.env.FAKE_SECRET ?? 'secret'} ${'x'.repeat(2048)}`)

const input = createInterface({ input: process.stdin })
process.stdin.resume()

input.on('line', (line) => {
  const message = JSON.parse(line)
  record(message)

  if (message.method === 'initialize') {
    initialized = true
    if (mode === 'exit') return process.exit(17)
    return send({
      id: message.id,
      result: {
        userAgent: 'fake-codex/0.147.0',
        codexHome: '/private/codex-home',
        platformFamily: 'unix',
        platformOs: 'linux'
      }
    })
  }
  if (message.method === 'initialized') return
  if (!initialized) return send({ id: message.id, error: { code: -32002, message: 'Not initialized' } })

  if (message.method === 'never/respond') return
  if (message.method === 'server/error') {
    return send({ id: message.id, error: { code: 429, message: `secret:${process.env.FAKE_SECRET}` } })
  }
  if (message.method === 'slow') {
    return setTimeout(() => send({ id: message.id, result: { value: 'slow' } }), 20)
  }
  if (message.method === 'fast') return send({ id: message.id, result: { value: 'fast' } })
  if (message.method === 'emit/notification') {
    send({ method: 'test/notification', params: { value: 7 } })
    return send({ id: message.id, result: {} })
  }
  if (message.method === 'emit/server-request') {
    send({ id: 9001, method: 'item/commandExecution/requestApproval', params: { command: ['evil'] } })
    return send({ id: message.id, result: {} })
  }
  if (message.method === 'account/read') {
    return send({
      id: message.id,
      result: {
        account: { type: 'chatgpt', email: 'private@example.com', planType: 'plus' },
        requiresOpenaiAuth: true
      }
    })
  }
  if (message.method === 'account/login/start') {
    const loginId = 'login-1'
    send({
      id: message.id,
      result: {
        type: 'chatgpt',
        loginId,
        authUrl: process.env.FAKE_AUTH_URL ?? 'https://auth.openai.com/oauth/authorize?private=yes'
      }
    })
    return setTimeout(
      () => send({
        method: 'account/login/completed',
        params: {
          loginId,
          success: mode !== 'login-failed',
          error: mode === 'login-failed' ? 'private upstream login detail' : null,
          onboardingEntrypoint: null
        }
      }),
      5
    )
  }
  if (message.method === 'account/login/cancel') {
    return send({ id: message.id, result: { status: 'canceled' } })
  }
  if (message.method === 'account/logout') return send({ id: message.id, result: {} })
  if (message.method === 'model/list') {
    const isSecond = message.params?.cursor === 'page-2'
    const makeModel = (id, isDefault = false) => ({
      id,
      model: id,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: id.toUpperCase(),
      description: 'fake',
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'fast' },
        { reasoningEffort: 'high', description: 'careful' }
      ],
      defaultReasoningEffort: 'low',
      inputModalities: ['text'],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault
    })
    const data = isSecond ? [makeModel('gpt-second')] : [makeModel('gpt-test', true)]
    if (mode === 'duplicate-models' && isSecond) data[0] = makeModel('gpt-test')
    if (mode === 'malformed-catalog') data[0].unknown = true
    return send({
      id: message.id,
      result: { data, nextCursor: isSecond ? null : 'page-2' }
    })
  }
  if (message.method === 'thread/start') {
    threadCounter += 1
    const thread = {
      id: `thread-${threadCounter}`,
      sessionId: `thread-${threadCounter}`,
      forkedFromId: null,
      parentThreadId: null,
      preview: '',
      ephemeral: true,
      section: null,
      sectionEnteredAt: null,
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
      status: { type: 'idle' },
      path: null,
      cwd: message.params.cwd,
      cliVersion: '0.147.0',
      source: { custom: 'ai_debates' },
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: []
    }
    return send({
      id: message.id,
      result: {
        thread,
        model: message.params.model,
        modelProvider: 'openai',
        serviceTier: null,
        cwd: message.params.cwd,
        instructionSources: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: null
      }
    })
  }
  if (message.method === 'turn/start') {
    turnCounter += 1
    const turnId = `turn-${turnCounter}`
    send({
      id: message.id,
      result: {
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          status: 'inProgress',
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null
        }
      }
    })
    queueMicrotask(() => {
      send({ method: 'item/reasoning/textDelta', params: { threadId: message.params.threadId, turnId, delta: 'SECRET_REASONING' } })
      send({ method: 'item/agentMessage/delta', params: { threadId: 'wrong-thread', turnId, itemId: 'wrong', delta: 'WRONG' } })
      if (mode === 'malformed-delta') {
        send({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId, itemId: 'msg', delta: 7 } })
      } else if (mode === 'oversized-delta') {
        send({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId, itemId: 'msg', delta: 'x'.repeat(200001) } })
      } else if (mode !== 'empty-turn') {
        send({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId, itemId: 'msg', delta: '{"speech":"回应",' } })
      }
      if (mode === 'crash-active') return process.exit(19)
      setTimeout(() => {
        if (!['empty-turn', 'malformed-delta', 'oversized-delta'].includes(mode)) {
          send({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId, itemId: 'msg', delta: '"status":"continue"}' } })
        }
        const status = mode === 'turn-failed' ? 'failed' : mode === 'turn-interrupted' ? 'interrupted' : 'completed'
        if (mode === 'out-of-order') {
          send({
            method: 'turn/completed',
            params: {
              threadId: message.params.threadId,
              turn: {
                id: 'wrong-turn',
                items: [],
                itemsView: 'full',
                status: 'completed',
                error: null,
                startedAt: 1,
                completedAt: 2,
                durationMs: 1
              }
            }
          })
        }
        const completion = {
          method: 'turn/completed',
          params: {
            threadId: message.params.threadId,
            turn: {
              id: turnId,
              items: [],
              itemsView: 'full',
              status,
              error: status === 'failed' ? { message: 'private error', codexErrorInfo: null, additionalDetails: null } : null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1
            }
          }
        }
        send(completion)
        if (mode === 'duplicate-completion') send(completion)
      }, 25)
    })
    return
  }
  if (message.method === 'turn/interrupt') return send({ id: message.id, result: {} })

  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
})
