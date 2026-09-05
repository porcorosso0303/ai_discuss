import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LogService } from '../../../src/main/storage/log-service'
import { createTempDirectory, removeTempDirectories } from '../../helpers/temp-directories'

const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

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
    const secondService = new LogService(root, {
      clock: () => new Date('2026-08-16T12:34:56.000Z'),
      maxEntryBytes: 180,
      maxFileBytes: 360
    })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? service : secondService).info(`entry-${index}`)
      )
    )

    const bytes = await readFile(join(root, 'logs/app-2026-08-16.log'))
    expect(bytes.byteLength).toBeLessThanOrEqual(360)
    for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it.runIf(process.platform === 'win32')(
    'case-folds Windows log path aliases into the same file-cap queue',
    async () => {
      const root = await createTempDirectory('log-service-windows-case-')
      const options = {
        clock: () => new Date('2026-08-16T12:34:56.000Z'),
        maxEntryBytes: 180,
        maxFileBytes: 360
      }
      const first = new LogService(root.toLocaleLowerCase('en-US'), options)
      const second = new LogService(root.toLocaleUpperCase('en-US'), options)

      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 === 0 ? first : second).info(`entry-${index}`)
        )
      )

      expect((await readFile(join(root, 'logs/app-2026-08-16.log'))).byteLength).toBeLessThanOrEqual(
        360
      )
    }
  )

  it('creates a missing nested log root safely across service instances', async () => {
    const base = await createTempDirectory('log-service-missing-root-')
    const root = join(base, 'nested', 'app-data')
    const options = { clock: () => new Date('2026-08-16T12:34:56.000Z') }

    await Promise.all([
      new LogService(root, options).info('first'),
      new LogService(root, options).info('second')
    ])

    const text = await readFile(join(root, 'logs/app-2026-08-16.log'), 'utf8')
    expect(text).toContain('first')
    expect(text).toContain('second')
  })

  it('does not create any external directory through a symlinked missing-root ancestor', async () => {
    const base = await createTempDirectory('log-service-root-ancestor-')
    const outside = await createTempDirectory('log-service-root-ancestor-outside-')
    await symlink(outside, join(base, 'redirect'), directoryLinkType)
    const root = join(base, 'redirect', 'created-outside', 'app-data')

    await expect(new LogService(root).info('must-not-escape')).rejects.toThrow(
      /canonical|directory|symlink/i
    )
    expect(await lstat(join(outside, 'created-outside')).catch(() => null)).toBeNull()
  })

  it('recovers the shared missing-root initializer after a rejected creation', async () => {
    const base = await createTempDirectory('log-service-root-recovery-')
    const root = join(base, 'new-root')
    let rejected = false
    const failing = new LogService(root, {
      filesystemHook: (stage) => {
        if (stage === 'before-mkdir' && !rejected) {
          rejected = true
          throw new Error('injected directory rejection')
        }
      }
    })

    await expect(failing.info('first')).rejects.toThrow(/injected directory rejection/i)
    await expect(new LogService(root).info('second')).resolves.toBeUndefined()
  })

  it('revalidates the logs parent inside the cross-instance write queue', async () => {
    const root = await createTempDirectory('log-service-queued-parent-')
    const outside = await createTempDirectory('log-service-queued-parent-outside-')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    let firstOpen = true
    const options = {
      clock: () => new Date('2026-08-16T12:34:56.000Z'),
      filesystemHook: async (stage: string) => {
        if (stage === 'before-target-open' && firstOpen) {
          firstOpen = false
          entered()
          await blocked
        }
      }
    }
    const firstService = new LogService(root, options)
    const secondService = new LogService(root, options)
    const first = firstService.info('first')
    await firstEntered
    const second = secondService.info('external-marker')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await rename(join(root, 'logs'), join(root, 'logs-original'))
    await symlink(outside, join(root, 'logs'), directoryLinkType)
    release()

    await expect(first).rejects.toThrow(/directory|identity|symlink/i)
    await expect(second).rejects.toThrow(/directory|identity|symlink/i)
    expect(await readFile(join(outside, 'app-2026-08-16.log'), 'utf8').catch(() => '')).not.toContain(
      'external-marker'
    )
  })

  it('detects parent replacement immediately before append and after close', async () => {
    for (const trigger of ['before-file-write', 'after-target-close'] as const) {
      const root = await createTempDirectory(`log-service-${trigger}-`)
      const outside = await createTempDirectory(`log-service-${trigger}-outside-`)
      let swapped = false
      const service = new LogService(root, {
        clock: () => new Date('2026-08-16T12:34:56.000Z'),
        filesystemHook: async (stage) => {
          if (stage !== trigger || swapped) return
          swapped = true
          await rename(join(root, 'logs'), join(root, 'logs-original'))
          await symlink(outside, join(root, 'logs'), directoryLinkType)
        }
      })

      await expect(service.info(`marker-${trigger}`)).rejects.toThrow(
        /directory|identity|symlink|EPERM|operation not permitted/i
      )
      expect(
        await readFile(join(outside, 'app-2026-08-16.log'), 'utf8').catch(() => '')
      ).not.toContain(`marker-${trigger}`)
    }
  })

  it('revalidates the logs directory before taking the file-cap early return', async () => {
    const root = await createTempDirectory('log-service-cap-parent-')
    const outside = await createTempDirectory('log-service-cap-parent-outside-')
    await mkdir(join(root, 'logs'))
    await writeFile(join(root, 'logs/app-2026-08-16.log'), Buffer.alloc(256, 0x61))
    let swapped = false
    const service = new LogService(root, {
      clock: () => new Date('2026-08-16T12:34:56.000Z'),
      maxEntryBytes: 128,
      maxFileBytes: 256,
      filesystemHook: async (stage) => {
        if (stage !== 'before-file-cap-check' || swapped) return
        swapped = true
        await rename(join(root, 'logs'), join(root, 'logs-original'))
        await symlink(outside, join(root, 'logs'), directoryLinkType)
      }
    })

    await expect(service.info('must-not-follow-cap-symlink')).rejects.toThrow(
      /directory|identity|symlink/i
    )
    expect(await readFile(join(outside, 'app-2026-08-16.log'), 'utf8').catch(() => '')).toBe('')
  })
})
