import { describe, expect, it, vi } from 'vitest'

import {
  HttpNetworkError,
  HttpStatusError,
  withRetry
} from '../../../src/main/providers/http/retry-policy'

describe('withRetry', () => {
  it('bounds and redacts messages exposed by typed HTTP errors', () => {
    const error = new HttpNetworkError(
      `Authorization: Bearer constructor-secret\n${'x'.repeat(2_000)}`
    )

    expect(error.message).not.toContain('constructor-secret')
    expect(error.message.length).toBeLessThanOrEqual(1_024)
  })

  it('uses at most three total attempts and rethrows the final original error', async () => {
    const errors = [
      new HttpNetworkError('network one'),
      new HttpNetworkError('network two'),
      new HttpNetworkError('network three')
    ]
    const operation = vi.fn(async ({ attempt }: { attempt: number }) => {
      throw errors[attempt - 1]
    })
    const sleep = vi.fn(async () => undefined)

    await expect(
      withRetry(operation, { sleep, random: () => 0, baseDelayMs: 100 })
    ).rejects.toBe(errors[2])
    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('passes one-based attempt and the same AbortSignal to each operation', async () => {
    const controller = new AbortController()
    const calls: Array<{ attempt: number; signal?: AbortSignal }> = []

    const result = await withRetry(
      async (context) => {
        calls.push(context)
        if (context.attempt < 2) throw new HttpNetworkError('temporary')
        return 'ok'
      },
      { signal: controller.signal, sleep: async () => undefined }
    )

    expect(result).toBe('ok')
    expect(calls).toEqual([
      { attempt: 1, signal: controller.signal },
      { attempt: 2, signal: controller.signal }
    ])
  })

  it.each([429, 500, 503, 599])('retries HTTP %s status errors', async (status) => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        if (calls === 1) throw new HttpStatusError(status)
        return 'recovered'
      },
      { sleep: async () => undefined }
    )

    expect(result).toBe('recovered')
    expect(calls).toBe(2)
  })

  it.each([
    new HttpStatusError(400),
    new HttpStatusError(401),
    new HttpStatusError(403),
    new HttpStatusError(404),
    new Error('HTTP 503 in an arbitrary message'),
    { status: 503 },
    new TypeError('programming type error')
  ])('does not retry an unapproved error: %#', async (error) => {
    const operation = vi.fn(async () => {
      throw error
    })
    const sleep = vi.fn(async () => undefined)

    await expect(withRetry(operation, { sleep })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('does not retry an AbortError', async () => {
    const error = new DOMException('stopped', 'AbortError')
    const operation = vi.fn(async () => {
      throw error
    })

    await expect(withRetry(operation)).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('does not call the operation when the signal is already aborted', async () => {
    const controller = new AbortController()
    const reason = new DOMException('already stopped', 'AbortError')
    controller.abort(reason)
    const operation = vi.fn(async () => 'never')

    await expect(withRetry(operation, { signal: controller.signal })).rejects.toBe(reason)
    expect(operation).not.toHaveBeenCalled()
  })

  it('uses Retry-After delta-seconds before exponential backoff', async () => {
    const sleep = vi.fn(async () => undefined)
    let calls = 0

    await withRetry(
      async () => {
        calls += 1
        if (calls === 1) {
          throw new HttpStatusError(429, undefined, { retryAfter: '1.25' })
        }
        return 'ok'
      },
      { sleep, random: () => 0, baseDelayMs: 9999 }
    )

    expect(sleep).toHaveBeenCalledWith(1250, undefined)
  })

  it('supports HTTP-date Retry-After and treats a past date as zero', async () => {
    const now = Date.parse('2026-08-13T00:00:00.000Z')
    const delays: number[] = []
    let calls = 0

    await withRetry(
      async () => {
        calls += 1
        if (calls === 1) {
          throw new HttpStatusError(503, undefined, {
            retryAfter: 'Wed, 12 Aug 2026 23:59:59 GMT'
          })
        }
        if (calls === 2) {
          throw new HttpStatusError(503, undefined, {
            retryAfter: 'Thu, 13 Aug 2026 00:00:02 GMT'
          })
        }
        return 'ok'
      },
      {
        now: () => now,
        sleep: async (delay) => {
          delays.push(delay)
        }
      }
    )

    expect(delays).toEqual([0, 2000])
  })

  it('falls back for invalid Retry-After and applies jittered exponential delays', async () => {
    const delays: number[] = []
    let calls = 0

    await withRetry(
      async () => {
        calls += 1
        if (calls < 3) {
          throw new HttpStatusError(500, undefined, { retryAfter: 'not-a-date' })
        }
        return 'ok'
      },
      {
        baseDelayMs: 100,
        random: () => 0.5,
        sleep: async (delay) => {
          delays.push(delay)
        }
      }
    )

    expect(delays).toEqual([75, 150])
  })

  it('clamps malformed jitter and hostile Retry-After values to bounded delays', async () => {
    const delays: number[] = []
    let calls = 0

    await withRetry(
      async () => {
        calls += 1
        if (calls === 1) throw new HttpNetworkError('offline')
        if (calls === 2) {
          throw new HttpStatusError(503, undefined, { retryAfter: '999999999' })
        }
        return 'ok'
      },
      {
        baseDelayMs: 100,
        maxDelayMs: 5_000,
        random: () => Number.POSITIVE_INFINITY,
        sleep: async (delay) => {
          delays.push(delay)
        }
      }
    )

    expect(delays).toEqual([75, 5_000])
  })

  it('passes the signal to sleep and checks cancellation after sleeping', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled in sleep', 'AbortError')
    const operation = vi.fn(async () => {
      throw new HttpNetworkError('offline')
    })
    const sleep = vi.fn(async (_delay: number, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      controller.abort(reason)
    })

    await expect(withRetry(operation, { signal: controller.signal, sleep })).rejects.toBe(
      reason
    )
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('propagates a sleep rejection and does not create another attempt', async () => {
    const sleepError = new Error('timer failed')
    const operation = vi.fn(async () => {
      throw new HttpNetworkError('offline')
    })

    await expect(
      withRetry(operation, {
        sleep: async () => {
          throw sleepError
        }
      })
    ).rejects.toBe(sleepError)
    expect(operation).toHaveBeenCalledTimes(1)
  })
})
