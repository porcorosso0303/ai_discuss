import { redactString } from './redaction'
import {
  HttpError,
  HttpNetworkError,
  HttpStatusError
} from './retry-policy'
import {
  parseSse,
  type SseEvent,
  type SseParserOptions
} from './sse-parser'

export { HttpError, HttpNetworkError, HttpStatusError } from './retry-policy'

const DEFAULT_MAX_ERROR_BODY_LENGTH = 2_048
const MAX_RETRY_AFTER_LENGTH = 128

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

export interface HttpClientDependencies {
  fetch?: FetchLike
  maxErrorBodyLength?: number
  sse?: Omit<SseParserOptions, 'signal'>
}

export class HttpResponseError extends HttpError {
  constructor(message = 'HTTP response could not be processed', options?: ErrorOptions) {
    super('HttpResponseError', message, options)
  }
}

interface ReadBodyResult {
  text: string
  truncated: boolean
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted', 'AbortError')

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortReason(signal)
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

const errorBodyLimit = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_MAX_ERROR_BODY_LENGTH
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError('maxErrorBodyLength must be a positive safe integer')
  }
  return resolved
}

const readBody = async (
  response: Response,
  signal: AbortSignal | undefined,
  maximum?: number
): Promise<ReadBodyResult> => {
  if (response.body === null) return { text: '', truncated: false }
  throwIfAborted(signal)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let truncated = false
  let completed = false
  let cancellation: Promise<void> | undefined

  const append = (value: string): void => {
    if (maximum === undefined) {
      text += value
      return
    }
    const remaining = maximum + 1 - text.length
    if (remaining > 0) text += value.slice(0, remaining)
    if (value.length > remaining || text.length > maximum) truncated = true
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
    while (!truncated) {
      throwIfAborted(signal)
      const { done, value } = await reader.read()
      throwIfAborted(signal)
      if (done) {
        append(decoder.decode())
        completed = true
        break
      }
      append(decoder.decode(value, { stream: true }))
    }

    if (truncated) {
      await reader.cancel().catch(() => undefined)
      completed = true
      text = text.slice(0, maximum)
    }
    return { text, truncated }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (signal?.aborted && cancellation !== undefined) await cancellation
    if (!completed && !signal?.aborted) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const executeFetch = async (
  input: string | URL | Request,
  init: RequestInit,
  fetchImpl: FetchLike
): Promise<Response> => {
  const signal = init.signal ?? undefined
  throwIfAborted(signal)
  try {
    return await fetchImpl(input, init)
  } catch (error) {
    if (isAbortError(error)) throw error
    if (signal?.aborted) {
      if (error === signal.reason) throw error
      throw abortReason(signal)
    }
    throw new HttpNetworkError('HTTP network request failed', { cause: error })
  }
}

const readTransportBody = async (
  response: Response,
  signal: AbortSignal | undefined,
  maximum?: number
): Promise<ReadBodyResult> => {
  try {
    return await readBody(response, signal, maximum)
  } catch (error) {
    if (isAbortError(error)) throw error
    if (signal?.aborted) {
      if (error === signal.reason) throw error
      throw abortReason(signal)
    }
    throw new HttpNetworkError('HTTP response body could not be read', { cause: error })
  }
}

const statusError = async (
  response: Response,
  signal: AbortSignal | undefined,
  maximum: number
): Promise<HttpStatusError> => {
  const body = await readTransportBody(response, signal, maximum)
  const safeBody = redactString(
    body.truncated ? `${body.text}…` : body.text,
    { maxLength: maximum }
  )
  const retryAfter = response.headers.get('retry-after')?.slice(0, MAX_RETRY_AFTER_LENGTH)
  return new HttpStatusError(response.status, undefined, {
    retryAfter,
    responseBody: safeBody === '' ? undefined : safeBody
  })
}

export const fetchJson = async <T = unknown>(
  input: string | URL | Request,
  init: RequestInit = {},
  dependencies: HttpClientDependencies = {}
): Promise<T | undefined> => {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const signal = init.signal ?? undefined
  const response = await executeFetch(input, init, fetchImpl)

  if (!response.ok) {
    throw await statusError(response, signal, errorBodyLimit(dependencies.maxErrorBodyLength))
  }
  if (response.status === 204) return undefined

  const { text } = await readTransportBody(response, signal)
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new HttpResponseError('HTTP response contained invalid JSON', { cause: error })
  }
}

export async function* streamSse(
  input: string | URL | Request,
  init: RequestInit = {},
  dependencies: HttpClientDependencies = {}
): AsyncGenerator<SseEvent> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const signal = init.signal ?? undefined
  const response = await executeFetch(input, init, fetchImpl)

  if (!response.ok) {
    throw await statusError(response, signal, errorBodyLimit(dependencies.maxErrorBodyLength))
  }
  if (response.body === null) {
    throw new HttpResponseError('HTTP streaming response did not include a body')
  }

  yield* parseSse(response.body, { ...dependencies.sse, signal })
}
