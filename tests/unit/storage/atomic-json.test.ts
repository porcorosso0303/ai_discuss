import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { AtomicJsonStore } from '../../../src/main/storage/atomic-json'
import { createTempDirectory, removeTempDirectories } from '../../helpers/temp-directories'

const valueSchema = z.strictObject({ value: z.string() })

describe('AtomicJsonStore', () => {
  afterEach(removeTempDirectories)

  it('writes through a unique sibling temp file and atomically replaces the last good value', async () => {
    const root = await createTempDirectory('atomic-json-')
    const store = new AtomicJsonStore(root)

    await store.write('config/settings.json', valueSchema, { value: 'old' })
    await store.write('config/settings.json', valueSchema, { value: 'new' })

    expect(await store.read('config/settings.json', valueSchema)).toEqual({ value: 'new' })
    expect(JSON.parse(await readFile(join(root, 'config/settings.json'), 'utf8'))).toEqual({
      value: 'new'
    })
  })

  it('ignores a crashed writer temp file and preserves the last good target', async () => {
    const root = await createTempDirectory('atomic-json-crash-')
    const store = new AtomicJsonStore(root)
    await store.write('config/settings.json', valueSchema, { value: 'last-good' })
    await writeFile(join(root, 'config/.settings.json.crashed.tmp'), '{"value":"partial')

    expect(await store.read('config/settings.json', valueSchema)).toEqual({ value: 'last-good' })
  })

  it('rejects traversal, symlink components, accessors, non-finite values, and nested secrets', async () => {
    const root = await createTempDirectory('atomic-json-security-')
    const outside = await createTempDirectory('atomic-json-outside-')
    const store = new AtomicJsonStore(root)
    await mkdir(join(root, 'config'), { recursive: true })
    await symlink(outside, join(root, 'linked'), 'dir')

    await expect(store.write('../escape.json', valueSchema, { value: 'x' })).rejects.toThrow()
    await expect(store.write('linked/escape.json', valueSchema, { value: 'x' })).rejects.toThrow()

    const accessor = Object.create(null) as Record<string, unknown>
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'secret' })
    await expect(store.write('config/accessor.json', valueSchema, accessor)).rejects.toThrow(
      /accessor/i
    )

    await expect(
      store.write('config/secret.json', z.unknown(), {
        nested: { api_key: 'must-not-land-on-disk' }
      })
    ).rejects.toThrow(/sensitive/i)
    for (const key of [
      'ａｐｉ＿ｋｅｙ',
      'API KEY',
      'openai.api key',
      'client\u200b secret',
      'private key'
    ]) {
      const error = await store
        .write('config/unicode-secret.json', z.unknown(), {
          nested: [{ [key]: 'never-write' }]
        })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toMatch(/sensitive/i)
      expect(String(error)).not.toContain(key)
      expect(String(error)).not.toContain('never-write')
    }
    await expect(
      store.write('config/password.json', z.unknown(), {
        nested: { databasePassword: 'must-not-land-on-disk-either' }
      })
    ).rejects.toThrow(/sensitive/i)
    await expect(store.write('config/nan.json', z.unknown(), { value: Number.NaN })).rejects.toThrow(
      /finite/i
    )
  })

  it('preserves public string content byte-for-byte through JSON round trips', async () => {
    const root = await createTempDirectory('atomic-json-public-content-')
    const store = new AtomicJsonStore(root)
    const schema = z.strictObject({ topic: z.string(), speech: z.string() })
    const value = {
      topic: 'token: democracy / authorization: philosophical',
      speech: 'passwordless systems are not passwords; client_secret is a debate term'
    }

    await store.write('public.json', schema, value)

    expect(await store.read('public.json', schema)).toEqual(value)
    expect(JSON.parse(await readFile(join(root, 'public.json'), 'utf8'))).toEqual(value)
  })

  it('enforces bounded input and returns independent parsed values', async () => {
    const root = await createTempDirectory('atomic-json-bounds-')
    const store = new AtomicJsonStore(root, { maxBytes: 64 })
    await store.write('value.json', valueSchema, { value: 'ok' })

    const first = await store.read('value.json', valueSchema)
    expect(first).toEqual({ value: 'ok' })
    if (first) first.value = 'mutated'
    expect(await store.read('value.json', valueSchema)).toEqual({ value: 'ok' })

    await writeFile(join(root, 'oversized.json'), Buffer.alloc(65, 0x61))
    await expect(store.read('oversized.json', z.unknown())).rejects.toThrow(/large/i)
  })

  it('creates a shared first parent safely across store instances', async () => {
    const root = join(await createTempDirectory('atomic-json-parent-'), 'new-root')
    const first = new AtomicJsonStore(root)
    const second = new AtomicJsonStore(root)

    await Promise.all([
      first.write('shared/first.json', valueSchema, { value: 'first' }),
      second.write('shared/second.json', valueSchema, { value: 'second' })
    ])

    expect(await first.read('shared/first.json', valueSchema)).toEqual({ value: 'first' })
    expect(await second.read('shared/second.json', valueSchema)).toEqual({ value: 'second' })
  })

  it('fails closed when a checked parent is replaced before temp creation', async () => {
    const root = await createTempDirectory('atomic-json-parent-swap-')
    const outside = await createTempDirectory('atomic-json-parent-swap-outside-')
    await mkdir(join(root, 'config'))
    let swapped = false
    const store = new AtomicJsonStore(root, {
      filesystemHook: async (stage) => {
        if (stage !== 'before-temp-open' || swapped) return
        swapped = true
        await rename(join(root, 'config'), join(root, 'config-original'))
        await symlink(outside, join(root, 'config'), 'dir')
      }
    })

    await expect(
      store.write('config/settings.json', valueSchema, { value: 'blocked' })
    ).rejects.toThrow(/directory|identity|symlink/i)
    expect(await readFile(join(outside, 'settings.json'), 'utf8').catch(() => null)).toBeNull()
    expect(
      await readFile(join(outside, '.settings.json.attacker.tmp'), 'utf8').catch(() => null)
    ).toBeNull()
  })

  it('does not clean up through a replaced parent after creating its temp file', async () => {
    const root = await createTempDirectory('atomic-json-cleanup-swap-')
    const outside = await createTempDirectory('atomic-json-cleanup-swap-outside-')
    await mkdir(join(root, 'config'))
    await writeFile(join(outside, 'settings.json'), 'outside-sentinel')
    let swapped = false
    const store = new AtomicJsonStore(root, {
      filesystemHook: async (stage) => {
        if (stage !== 'before-rename' || swapped) return
        swapped = true
        await rename(join(root, 'config'), join(root, 'config-original'))
        await symlink(outside, join(root, 'config'), 'dir')
      }
    })

    await expect(
      store.write('config/settings.json', valueSchema, { value: 'blocked' })
    ).rejects.toThrow(/directory|identity|symlink/i)
    expect(await readFile(join(outside, 'settings.json'), 'utf8')).toBe('outside-sentinel')
    expect((await readdir(join(root, 'config-original'))).some((name) => name.endsWith('.tmp'))).toBe(
      true
    )
  })
})
