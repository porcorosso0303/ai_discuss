const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 30_000
const HARD_MAX_DELAY_MS = 120_000
const MAX_ERROR_MESSAGE_LENGTH = 1_024

export abstract class HttpError extends Error {
  protected constructor(name: string, message: string, options?: ErrorOptions) {
    super(redactString(message, { maxLength: MAX_ERROR_MESSAGE_LENGTH }), options)
    this.name = name
  }
}

export class HttpStatusError extends HttpError {
  readonly status: number
  readonly retryAfter?: string
  readonly responseBody?: string

  constructor(
    status: number,
    message = `HTTP request failed with status ${status}`,
    options: { retryAfter?: string; responseBody?: string; cause?: unknown } = {}
  ) {
    super('HttpStatusError', message, { cause: options.cause })
    this.status = status
    this.retryAfter = options.retryAfter
    this.responseBody = options.responseBody
  }
}

export class HttpNetworkError extends HttpError {
  constructor(message = 'HTTP network request failed', options: { cause?: unknown } = {}) {
    super('HttpNetworkError', message, { cause: options.cause })
  }
}

export interface RetryContext {
  attempt: number
  signal?: AbortSignal
}

export type RetryOperation<T> = (context: RetryContext) => Promise<T>
export type RetrySleep = (delayMs: number, signal?: AbortSignal) => Promise<void>

export interface RetryOptions {
  signal?: AbortSignal
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  random?: () => number
  now?: () => number
  sleep?: RetrySleep
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted', 'AbortError')

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortReason(signal)
}

const defaultSleep: RetrySleep = (delayMs, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }

    const timer = setTimeout(finish, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortReason(signal as AbortSignal))
    }
    function finish(): void {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const boundedPositive = (
  value: number | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER
): number => {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Retry delays must be finite non-negative numbers')
  }
  return Math.min(value, maximum)
}

const attempts = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_MAX_ATTEMPTS
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > DEFAULT_MAX_ATTEMPTS) {
    throw new RangeError('maxAttempts must be an integer from 1 through 3')
  }
  return resolved
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

const isRetryable = (
  error: unknown
): error is HttpNetworkError | HttpStatusError =>
  error instanceof HttpNetworkError ||
  (error instanceof HttpStatusError &&
    (error.status === 429 || (error.status >= 500 && error.status <= 599)))

const retryAfterDelay = (
  value: string | undefined,
  now: number
): number | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed)
    if (Number.isFinite(seconds)) return seconds * 1_000
    return undefined
  }

  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

const normalizedRandom = (random: () => number): number => {
  const value = random()
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

const retryDelay = (
  error: HttpNetworkError | HttpStatusError,
  failedAttempt: number,
  options: Required<Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random' | 'now'>>
): number => {
  const headerDelay =
    error instanceof HttpStatusError
      ? retryAfterDelay(error.retryAfter, options.now())
      : undefined
  const exponential = options.baseDelayMs * 2 ** (failedAttempt - 1)
  const jittered = exponential * (0.5 + normalizedRandom(options.random) * 0.5)
  const selected = headerDelay ?? jittered
  return Math.min(options.maxDelayMs, Math.max(0, selected))
}

export const withRetry = async <T>(
  operation: RetryOperation<T>,
  options: RetryOptions = {}
): Promise<T> => {
  const maxAttempts = attempts(options.maxAttempts)
  const maxDelayMs = boundedPositive(
    options.maxDelayMs,
    DEFAULT_MAX_DELAY_MS,
    HARD_MAX_DELAY_MS
  )
  const resolved = {
    baseDelayMs: boundedPositive(options.baseDelayMs, DEFAULT_BASE_DELAY_MS),
    maxDelayMs,
    random: options.random ?? Math.random,
    now: options.now ?? Date.now
  }
  const sleep = options.sleep ?? defaultSleep

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal)
    try {
      return await operation({ attempt, signal: options.signal })
    } catch (error) {
      if (
        options.signal?.aborted ||
        isAbortError(error) ||
        !isRetryable(error) ||
        attempt === maxAttempts
      ) {
        throw error
      }

      const delay = retryDelay(error, attempt, resolved)
      throwIfAborted(options.signal)
      await sleep(delay, options.signal)
      throwIfAborted(options.signal)
    }
  }

  throw new Error('Retry loop exhausted unexpectedly')
}
import { redactString } from './redaction'
