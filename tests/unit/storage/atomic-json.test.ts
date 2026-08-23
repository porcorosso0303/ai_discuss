import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
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
    await expect(
      store.write('config/password.json', z.unknown(), {
        nested: { databasePassword: 'must-not-land-on-disk-either' }
      })
    ).rejects.toThrow(/sensitive/i)
    await expect(store.write('config/nan.json', z.unknown(), { value: Number.NaN })).rejects.toThrow(
      /finite/i
    )
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
})
