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
const DEFAULT_MAX_JSON_BODY_BYTES = 8 * 1024 * 1024
const MAX_RETRY_AFTER_LENGTH = 128
const BODY_PART_BATCH_SIZE = 1_024

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

export interface HttpClientDependencies {
  fetch?: FetchLike
  maxErrorBodyLength?: number
  maxJsonBodyBytes?: number
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

const jsonBodyLimit = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_MAX_JSON_BODY_BYTES
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError('maxJsonBodyBytes must be a positive safe integer')
  }
  return resolved
}

const readBody = async (
  response: Response,
  signal: AbortSignal | undefined,
  maximum?: number,
  maximumIsBytes = false
): Promise<ReadBodyResult> => {
  if (response.body === null) return { text: '', truncated: false }
  throwIfAborted(signal)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const textSegments: string[] = []
  let pendingTextParts: string[] = []
  let textLength = 0
  let bytesRead = 0
  let truncated = false
  let completed = false
  let cancellation: Promise<void> | undefined

  const storeText = (value: string): void => {
    pendingTextParts.push(value)
    if (pendingTextParts.length >= BODY_PART_BATCH_SIZE) {
      textSegments.push(pendingTextParts.join(''))
      pendingTextParts = []
    }
  }

  const append = (value: string): void => {
    if (maximum === undefined) {
      storeText(value)
      return
    }
    const remaining = maximum + 1 - textLength
    if (remaining > 0) {
      const part = value.slice(0, remaining)
      storeText(part)
      textLength += part.length
    }
    if (value.length > remaining || textLength > maximum) truncated = true
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
        const tail = decoder.decode()
        if (tail !== '') append(tail)
        completed = true
        break
      }
      if (maximumIsBytes) {
        if (maximum !== undefined && value.byteLength > maximum - bytesRead) {
          truncated = true
          continue
        }
        bytesRead += value.byteLength
      }
      const decoded = decoder.decode(value, { stream: true })
      if (decoded !== '') append(decoded)
    }

    if (truncated) {
      await reader.cancel().catch(() => undefined)
      completed = true
    }
    if (pendingTextParts.length > 0) textSegments.push(pendingTextParts.join(''))
    return { text: textSegments.join(''), truncated }
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
  maximum?: number,
  maximumIsBytes = false
): Promise<ReadBodyResult> => {
  try {
    return await readBody(response, signal, maximum, maximumIsBytes)
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
  const maxJsonBodyBytes = jsonBodyLimit(dependencies.maxJsonBodyBytes)
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const signal = init.signal ?? undefined
  const response = await executeFetch(input, init, fetchImpl)

  if (!response.ok) {
    throw await statusError(response, signal, errorBodyLimit(dependencies.maxErrorBodyLength))
  }
  if (response.status === 204) return undefined

  const { text, truncated } = await readTransportBody(
    response,
    signal,
    maxJsonBodyBytes,
    true
  )
  if (truncated) {
    throw new HttpResponseError('HTTP JSON response body was too large')
  }
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
