export interface SseEvent {
  data: string
  event?: string
  id?: string
  retry?: number
}

export interface SseParserOptions {
  signal?: AbortSignal
  maxLineLength?: number
  maxEventLength?: number
  maxBufferLength?: number
}

const DEFAULT_MAX_LINE_LENGTH = 256 * 1024
const DEFAULT_MAX_EVENT_LENGTH = 1024 * 1024
const DEFAULT_MAX_BUFFER_LENGTH = 512 * 1024

export class SseLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SseLimitError'
  }
}

interface EventFields {
  data: string[]
  event?: string
  id?: string
  retry?: number
  length: number
}

const emptyFields = (): EventFields => ({ data: [], length: 0 })

const positiveInteger = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('SSE parser limits must be positive safe integers')
  }
  return value
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted', 'AbortError')

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  options: SseParserOptions = {}
): AsyncGenerator<SseEvent> {
  const { signal } = options
  if (signal?.aborted) throw abortReason(signal)

  const maxLineLength = positiveInteger(options.maxLineLength, DEFAULT_MAX_LINE_LENGTH)
  const maxEventLength = positiveInteger(options.maxEventLength, DEFAULT_MAX_EVENT_LENGTH)
  const maxBufferLength = positiveInteger(options.maxBufferLength, DEFAULT_MAX_BUFFER_LENGTH)
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fields = emptyFields()
  let atStart = true
  let terminated = false
  let completed = false
  let cancellation: Promise<void> | undefined

  const pending: SseEvent[] = []

  const dispatch = (): void => {
    if (fields.data.length === 0) {
      fields = emptyFields()
      return
    }

    const event: SseEvent = { data: fields.data.join('\n') }
    if (fields.event !== undefined && fields.event !== '') event.event = fields.event
    if (fields.id !== undefined && !fields.id.includes('\0')) event.id = fields.id
    if (fields.retry !== undefined) event.retry = fields.retry
    fields = emptyFields()

    if (event.data === '[DONE]') {
      terminated = true
      return
    }
    pending.push(event)
  }

  const processLine = (line: string): void => {
    if (line.length > maxLineLength) {
      throw new SseLimitError(`SSE line limit exceeded (${maxLineLength} characters)`)
    }
    if (line === '') {
      dispatch()
      return
    }

    fields.length += line.length
    if (fields.length > maxEventLength) {
      throw new SseLimitError(`SSE event limit exceeded (${maxEventLength} characters)`)
    }
    if (line.startsWith(':')) return

    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'data':
        fields.data.push(value)
        break
      case 'event':
        fields.event = value
        break
      case 'id':
        if (!value.includes('\0')) fields.id = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) {
          const retry = Number(value)
          if (Number.isSafeInteger(retry)) fields.retry = retry
        }
        break
    }
  }

  const drain = (endOfStream: boolean): void => {
    let consumed = 0
    let cursor = 0

    while (cursor < buffer.length && !terminated) {
      const character = buffer[cursor]
      if (character !== '\r' && character !== '\n') {
        cursor += 1
        continue
      }
      if (character === '\r' && cursor + 1 === buffer.length && !endOfStream) break

      processLine(buffer.slice(consumed, cursor))
      if (character === '\r' && buffer[cursor + 1] === '\n') cursor += 1
      cursor += 1
      consumed = cursor
    }

    buffer = buffer.slice(consumed)
    if (terminated) {
      buffer = ''
      return
    }

    if (endOfStream && buffer !== '') {
      processLine(buffer)
      buffer = ''
    }
    if (buffer.length > maxLineLength) {
      throw new SseLimitError(`SSE line limit exceeded (${maxLineLength} characters)`)
    }
  }

  const onAbort = (): void => {
    const reason = abortReason(signal as AbortSignal)
    cancellation = reader.cancel(reason).then(
      () => undefined,
      () => undefined
    )
  }

  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (!terminated) {
      if (signal?.aborted) throw abortReason(signal)
      const { done, value } = await reader.read()
      if (signal?.aborted) throw abortReason(signal)

      if (done) {
        let tail = decoder.decode()
        if (atStart && tail !== '') {
          atStart = false
          if (tail.startsWith('\uFEFF')) tail = tail.slice(1)
        }
        buffer += tail
        if (buffer.length > maxBufferLength) {
          throw new SseLimitError(
            `SSE buffer limit exceeded (${maxBufferLength} characters)`
          )
        }
        drain(true)
        if (!terminated) dispatch()
        while (pending.length > 0) yield pending.shift() as SseEvent
        completed = true
        return
      }

      let text = decoder.decode(value, { stream: true })
      if (atStart && text !== '') {
        atStart = false
        if (text.startsWith('\uFEFF')) text = text.slice(1)
      }
      buffer += text
      if (buffer.length > maxBufferLength) {
        throw new SseLimitError(
          `SSE buffer limit exceeded (${maxBufferLength} characters)`
        )
      }
      drain(false)
      while (pending.length > 0) yield pending.shift() as SseEvent
    }
    if (terminated) await reader.cancel().catch(() => undefined)
    completed = true
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (signal?.aborted && cancellation !== undefined) await cancellation
    if (!completed && !signal?.aborted) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
}
