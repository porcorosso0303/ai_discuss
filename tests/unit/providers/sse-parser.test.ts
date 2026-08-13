import { describe, expect, it, vi } from 'vitest'

import {
  SseLimitError,
  parseSse
} from '../../../src/main/providers/http/sse-parser'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

const streamFromChunks = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = []
  for await (const value of iterable) values.push(value)
  return values
}

describe('parseSse', () => {
  it('decodes arbitrary byte boundaries including split UTF-8 code points', async () => {
    const bytes = encode('data: 你好\n\n')
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte))

    await expect(collect(parseSse(streamFromChunks(chunks)))).resolves.toEqual([
      { data: '你好' }
    ])
  })

  it('handles LF, CRLF, lone CR, and a CRLF split across chunks', async () => {
    const chunks = [
      encode('\uFEFFdata: one\r'),
      encode('\ndata: two\rdata: three\n\ndata: next\r\r')
    ]

    await expect(collect(parseSse(streamFromChunks(chunks)))).resolves.toEqual([
      { data: 'one\ntwo\nthree' },
      { data: 'next' }
    ])
  })

  it('joins data fields, accepts empty data, and keeps metadata out of data', async () => {
    const stream = streamFromChunks([
      encode(
        ': comment\n' +
          'event: message\n' +
          'id: evt-1\n' +
          'retry: 1500\n' +
          'unknown: ignored\n' +
          'data:first\n' +
          'data: second\n' +
          'data:\n\n'
      )
    ])

    await expect(collect(parseSse(stream))).resolves.toEqual([
      {
        data: 'first\nsecond\n',
        event: 'message',
        id: 'evt-1',
        retry: 1500
      }
    ])
  })

  it('ignores invalid retry and id fields while preserving a valid empty event field', async () => {
    const stream = streamFromChunks([
      encode('event:\nid: bad\u0000id\nretry: -1\ndata: ok\n\n')
    ])

    await expect(collect(parseSse(stream))).resolves.toEqual([{ data: 'ok' }])
  })

  it('flushes consecutive events and the final event without a trailing blank line', async () => {
    const stream = streamFromChunks([
      encode('data: first\n\ndata: second\n\ndata: final')
    ])

    await expect(collect(parseSse(stream))).resolves.toEqual([
      { data: 'first' },
      { data: 'second' },
      { data: 'final' }
    ])
  })

  it('stops only for an event whose complete data is exactly [DONE]', async () => {
    const stream = streamFromChunks([
      encode(
        'data: ordinary [DONE] text\n\n' +
          'data: [DONE]\n\n' +
          'data: must not be yielded\n\n'
      )
    ])

    await expect(collect(parseSse(stream))).resolves.toEqual([
      { data: 'ordinary [DONE] text' }
    ])
  })

  it('cancels an upstream stream that remains open after [DONE]', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('data: [DONE]\n\n'))
      },
      cancel() {
        cancelled = true
      }
    })

    await expect(collect(parseSse(stream))).resolves.toEqual([])
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  it('honors an early DONE marker before limiting trailing bytes in the same chunk', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode(`data: first\n\ndata: [DONE]\n\n${'x'.repeat(1024)}`))
      },
      cancel() {
        cancelled = true
      }
    })

    await expect(
      collect(
        parseSse(stream, {
          maxLineLength: 32,
          maxEventLength: 64,
          maxBufferLength: 64
        })
      )
    ).resolves.toEqual([{ data: 'first' }])
    expect(cancelled).toBe(true)
  })

  it('accepts one large transport chunk containing many bounded events', async () => {
    const payload = Array.from({ length: 100 }, (_, index) => `data: ${index}\n\n`).join(
      ''
    )

    const events = await collect(
      parseSse(streamFromChunks([encode(payload)]), {
        maxLineLength: 32,
        maxEventLength: 64,
        maxBufferLength: 64
      })
    )

    expect(events).toHaveLength(100)
    expect(events.at(0)).toEqual({ data: '0' })
    expect(events.at(-1)).toEqual({ data: '99' })
  })

  it('checks an already-aborted signal before acquiring a reader', async () => {
    const reason = new DOMException('cancelled first', 'AbortError')
    const controller = new AbortController()
    controller.abort(reason)
    const getReader = vi.fn(() => {
      throw new Error('must not acquire')
    })
    const stream = { getReader } as unknown as ReadableStream<Uint8Array>

    await expect(collect(parseSse(stream, { signal: controller.signal }))).rejects.toBe(
      reason
    )
    expect(getReader).not.toHaveBeenCalled()
  })

  it('cancels an active reader and rejects with the original abort reason', async () => {
    const abortController = new AbortController()
    let cancelledWith: unknown
    let markPulled: (() => void) | undefined
    const pulled = new Promise<void>((resolve) => {
      markPulled = resolve
    })
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        markPulled?.()
        return new Promise(() => undefined)
      },
      cancel(reason) {
        cancelledWith = reason
      }
    })
    const reason = new DOMException('user stopped', 'AbortError')
    const result = collect(parseSse(stream, { signal: abortController.signal }))

    await pulled
    abortController.abort(reason)

    await expect(result).rejects.toBe(reason)
    expect(cancelledWith).toBe(reason)
    expect(stream.locked).toBe(false)
  })

  it('releases the reader lock after normal completion', async () => {
    const stream = streamFromChunks([encode('data: done\n\n')])

    await collect(parseSse(stream))

    expect(stream.locked).toBe(false)
  })

  it.each([
    {
      name: 'line',
      input: 'data: too-long-without-a-newline',
      options: { maxLineLength: 8, maxEventLength: 100, maxBufferLength: 100 }
    },
    {
      name: 'event',
      input: 'data: 12345\ndata: 67890\n\n',
      options: { maxLineLength: 100, maxEventLength: 8, maxBufferLength: 100 }
    },
    {
      name: 'buffer',
      input: 'data: buffered',
      options: { maxLineLength: 100, maxEventLength: 100, maxBufferLength: 8 }
    }
  ])('rejects a $name that exceeds configured memory limits', async ({ input, options }) => {
    const result = collect(parseSse(streamFromChunks([encode(input)]), options))

    await expect(result).rejects.toBeInstanceOf(SseLimitError)
    await expect(result).rejects.toThrow(/limit/i)
  })
})
