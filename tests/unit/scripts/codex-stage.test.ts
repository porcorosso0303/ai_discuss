import { createHash } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  assertRegistryTarball,
  resolveLockedCodexRuntime,
  verifyIntegrity
} from '../../../scripts/lib/codex-stage.mjs'

describe('Codex runtime staging', () => {
  test('resolves the exact Windows x64 artifact from package-lock v3', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        'node_modules/@openai/codex': { version: '0.147.0' },
        'node_modules/@openai/codex-win32-x64': {
          version: '0.147.0-win32-x64',
          resolved: 'https://registry.npmjs.org/@openai/codex/-/codex-0.147.0-win32-x64.tgz',
          integrity: 'sha512-abc',
          optional: true
        }
      }
    }

    expect(resolveLockedCodexRuntime(lock, '0.147.0')).toEqual({
      package: '@openai/codex-win32-x64',
      packageVersion: '0.147.0-win32-x64',
      codexVersion: '0.147.0',
      resolved: 'https://registry.npmjs.org/@openai/codex/-/codex-0.147.0-win32-x64.tgz',
      integrity: 'sha512-abc'
    })
  })

  test('rejects mismatched versions, missing integrity, and non-registry URLs', () => {
    const base = {
      lockfileVersion: 3,
      packages: {
        'node_modules/@openai/codex': { version: '0.147.0' },
        'node_modules/@openai/codex-win32-x64': {
          version: '0.146.0-win32-x64',
          resolved: 'http://example.test/codex.tgz',
          optional: true
        }
      }
    }
    expect(() => resolveLockedCodexRuntime(base, '0.147.0')).toThrow(/version/i)
    expect(() => assertRegistryTarball('http://registry.npmjs.org/file.tgz')).toThrow(/HTTPS/i)
    expect(() => assertRegistryTarball('https://example.test/file.tgz')).toThrow(/registry\.npmjs\.org/i)
  })

  test('checks npm Subresource Integrity bytes', () => {
    const bytes = Buffer.from('official artifact')
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    expect(() => verifyIntegrity(bytes, integrity)).not.toThrow()
    expect(() => verifyIntegrity(Buffer.from('tampered'), integrity)).toThrow(/integrity/i)
  })
})
