import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LogService } from '../../../src/main/storage/log-service'
import { createTempDirectory, removeTempDirectories } from '../../helpers/temp-directories'

describe('LogService', () => {
  afterEach(removeTempDirectories)

  it('writes bounded, structured, single-line daily logs with CRLF-safe messages', async () => {
    const root = await createTempDirectory('log-service-')
    const service = new LogService(root, {
      clock: () => new Date('2026-08-16T12:34:56.000Z')
    })

    await service.info('first line\r\nforged line', { turn: 2 })

    const text = await readFile(join(root, 'logs/app-2026-08-16.log'), 'utf8')
    const physicalLines = text.trimEnd().split('\n')
    expect(physicalLines).toHaveLength(1)
    expect(JSON.parse(physicalLines[0]!)).toEqual({
      timestamp: '2026-08-16T12:34:56.000Z',
      level: 'info',
      message: 'first line\r\nforged line',
      context: { turn: 2 }
    })
  })

  it('redacts secrets and drops reasoning and raw payload fields without invoking accessors', async () => {
    const root = await createTempDirectory('log-service-redact-')
    const service = new LogService(root, {
      clock: () => new Date('2026-08-16T12:34:56.000Z')
    })
    const context = {
      headers: { Authorization: 'Bearer raw-auth', 'x-api-key': 'raw-key' },
      nested: { refreshToken: 'raw-token' },
      databasePassword: 'raw-password',
      clientSecret: 'raw-client-secret',
      reasoning: 'private chain of thought',
      reasoningContent: 'private reasoning variant',
      rawPayload: { content: 'private provider body' },
      rawProviderPayload: { content: 'private raw provider body' }
    }
    Object.defineProperty(context, 'trap', {
      enumerable: true,
      get: () => {
        throw new Error('getter executed')
      }
    })

    await service.error(
      new Error('request token=raw-error-token client_secret=raw-error-secret'),
      context
    )

    const text = await readFile(join(root, 'logs/app-2026-08-16.log'), 'utf8')
    expect(text).not.toContain('raw-auth')
    expect(text).not.toContain('raw-key')
    expect(text).not.toContain('raw-token')
    expect(text).not.toContain('raw-error-token')
    expect(text).not.toContain('raw-error-secret')
    expect(text).not.toContain('raw-password')
    expect(text).not.toContain('raw-client-secret')
    expect(text).not.toContain('private chain of thought')
    expect(text).not.toContain('private reasoning variant')
    expect(text).not.toContain('private provider body')
    expect(text).not.toContain('private raw provider body')
    expect(text).not.toContain('rawPayload')
    expect(text).not.toContain('reasoning')
    expect(text).toContain('[REDACTED]')
    const record = JSON.parse(text) as { message: string }
    expect(() => JSON.parse(record.message)).not.toThrow()
  })

  it('redacts unicode credential labels in object keys and message text', async () => {
    const root = await createTempDirectory('log-service-unicode-redact-')
    const service = new LogService(root, {
      clock: () => new Date('2026-08-16T12:34:56.000Z')
    })

    await service.info('ＡＰＩ ＫＥＹ: visible-string-secret', {
      deep: [{ 'client\u200b secret': 'visible-object-secret' }]
    })

    const text = await readFile(join(root, 'logs/app-2026-08-16.log'), 'utf8')
    expect(text).not.toContain('visible-string-secret')
    expect(text).not.toContain('visible-object-secret')
    expect(text).toContain('[REDACTED]')
    const record = JSON.parse(text) as {
      context: { deep: Array<Record<string, unknown>> }
    }
    expect(record.context.deep[0]?.['client\u200b secret']).toBe('[REDACTED]')
  })

  it('schema-validates the structured level before writing', async () => {
    const root = await createTempDirectory('log-service-schema-')
    const service = new LogService(root)

    await expect(service.log('fatal' as never, 'must not write')).rejects.toThrow()
    expect(await readFile(join(root, 'logs'), 'utf8').catch(() => null)).toBeNull()
  })

  it('serializes concurrent appends and never grows beyond the configured file bound', async () => {
    const root = await createTempDirectory('log-service-bounds-')
    const service = new LogService(root, {
      clock: () => new Date('2026-08-16T12:34:56.000Z'),
      maxEntryBytes: 180,
      maxFileBytes: 360
    })

    await Promise.all(Array.from({ length: 20 }, (_, index) => service.info(`entry-${index}`)))

    const bytes = await readFile(join(root, 'logs/app-2026-08-16.log'))
    expect(bytes.byteLength).toBeLessThanOrEqual(360)
    for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})
