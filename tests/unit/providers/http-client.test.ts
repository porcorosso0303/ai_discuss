import { describe, expect, it, vi } from 'vitest'

import {
  HttpResponseError,
  fetchJson,
  streamSse
} from '../../../src/main/providers/http/http-client'
import {
  HttpNetworkError,
  HttpStatusError
} from '../../../src/main/providers/http/retry-policy'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = []
  for await (const value of iterable) result.push(value)
  return result
}

describe('fetchJson', () => {
  it('uses the injected fetch and forwards request init including headers and signal', async () => {
    const controller = new AbortController()
    const init: RequestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer request-secret', 'Content-Type': 'application/json' },
      body: '{"request":true}',
      signal: controller.signal
    }
    const fetchImpl = vi.fn(async () =>
      new Response('{"models":["one"]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    const result = await fetchJson<{ models: string[] }>(
      'https://api.example.test/models',
      init,
      { fetch: fetchImpl }
    )

    expect(result).toEqual({ models: ['one'] })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.test/models', init)
  })

  it.each([
    new Response(null, { status: 204 }),
    new Response('  \r\n ', { status: 200 })
  ])('returns undefined for a successful response with no JSON body', async (response) => {
    const fetchImpl = vi.fn(async () => response)

    await expect(fetchJson('https://api.example.test/empty', {}, { fetch: fetchImpl })).resolves
      .toBeUndefined()
  })

  it('throws a typed bounded status error with Retry-After and a redacted body', async () => {
    const secret = 'response-secret'
    const fetchImpl = vi.fn(async () =>
      new Response(
        `Authorization: Bearer ${secret}\napi_key=second-secret\n${'x'.repeat(500)}`,
        {
          status: 429,
          headers: { 'Retry-After': '1.5' }
        }
      )
    )

    const error = await fetchJson('https://api.example.test/fail', {}, {
      fetch: fetchImpl,
      maxErrorBodyLength: 96
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(HttpStatusError)
    expect(error).toMatchObject({ status: 429, retryAfter: '1.5' })
    expect((error as HttpStatusError).responseBody?.length).toBeLessThanOrEqual(96)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain('second-secret')
    expect((error as Error).message.length).toBeLessThan(200)
  })

  it('wraps a fetch transport rejection in a typed network error without leaking its message', async () => {
    const cause = new TypeError('socket failed with api_key=transport-secret')
    const fetchImpl = vi.fn(async () => {
      throw cause
    })

    const error = await fetchJson('https://api.example.test/models', {}, {
      fetch: fetchImpl
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(HttpNetworkError)
    expect((error as Error).cause).toBe(cause)
    expect((error as Error).message).not.toContain('transport-secret')
  })

  it('preserves an abort rejection exactly and does not wrap it as a network error', async () => {
    const reason = new DOMException('user cancelled', 'AbortError')
    const fetchImpl = vi.fn(async () => {
      throw reason
    })

    await expect(
      fetchJson('https://api.example.test/models', {}, { fetch: fetchImpl })
    ).rejects.toBe(reason)
  })

  it('uses a generic bounded parse error that does not echo an invalid JSON body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('invalid response-secret JSON', { status: 200 })
    )

    const error = await fetchJson('https://api.example.test/models', {}, {
      fetch: fetchImpl
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(HttpResponseError)
    expect((error as Error).message).not.toContain('response-secret')
    expect((error as Error).message.length).toBeLessThan(200)
  })
})

describe('streamSse', () => {
  it('checks the response and parses SSE from a real chunked Response body', async () => {
    const bytes = encode('data: 你好\n\ndata: [DONE]\n\ndata: ignored\n\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      }
    })
    const response = new Response(body, { status: 200 })
    const fetchImpl = vi.fn(async () => response)
    const init: RequestInit = { headers: { Accept: 'text/event-stream' } }

    await expect(
      collect(streamSse('https://api.example.test/chat', init, { fetch: fetchImpl }))
    ).resolves.toEqual([{ data: '你好' }])
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.test/chat', init)
    expect(response.body?.locked).toBe(false)
  })

  it('throws the same typed status error for a non-success streaming response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('x-api-key=stream-error-secret', {
        status: 503,
        headers: { 'Retry-After': '2' }
      })
    )

    const error = await collect(
      streamSse('https://api.example.test/chat', {}, { fetch: fetchImpl })
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(HttpStatusError)
    expect(error).toMatchObject({ status: 503, retryAfter: '2' })
    expect(JSON.stringify(error)).not.toContain('stream-error-secret')
  })

  it('throws a clear response error when a successful response has no body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))

    await expect(
      collect(streamSse('https://api.example.test/chat', {}, { fetch: fetchImpl }))
    ).rejects.toBeInstanceOf(HttpResponseError)
  })

  it('passes AbortSignal through fetch and the SSE reader, preserving the abort reason', async () => {
    const controller = new AbortController()
    let markPulled: (() => void) | undefined
    const pulled = new Promise<void>((resolve) => {
      markPulled = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      pull() {
        markPulled?.()
        return new Promise(() => undefined)
      }
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }))
    const init: RequestInit = { signal: controller.signal }
    const result = collect(
      streamSse('https://api.example.test/chat', init, { fetch: fetchImpl })
    )
    const reason = new DOMException('stop stream', 'AbortError')

    await pulled
    controller.abort(reason)

    await expect(result).rejects.toBe(reason)
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.test/chat', init)
    expect(body.locked).toBe(false)
  })
})
