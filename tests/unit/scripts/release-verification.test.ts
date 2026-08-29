import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPackage } from '@electron/asar'
import { describe, expect, test } from 'vitest'

import {
  assertAsarContents,
  assertBuilderConfig,
  assertPeX64,
  assertPortableExecutable,
  verifyArtifact,
  verifyStagedRuntime
} from '../../../scripts/lib/release-verification.mjs'

function pe(machine = 0x8664): Buffer {
  const buffer = Buffer.alloc(256)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(0x80, 0x3c)
  buffer.write('PE\0\0', 0x80, 'binary')
  buffer.writeUInt16LE(machine, 0x84)
  return buffer
}

function portablePe(machine: 0x14c | 0x8664 = 0x14c): Buffer {
  const buffer = Buffer.alloc(1024)
  const peOffset = 0x80
  const optionalSize = machine === 0x14c ? 0xe0 : 0xf0
  const optionalOffset = peOffset + 24
  const sectionOffset = optionalOffset + optionalSize
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(peOffset, 0x3c)
  buffer.write('PE\0\0', peOffset, 'binary')
  buffer.writeUInt16LE(machine, peOffset + 4)
  buffer.writeUInt16LE(1, peOffset + 6)
  buffer.writeUInt16LE(optionalSize, peOffset + 20)
  buffer.writeUInt16LE(machine === 0x14c ? 0x10b : 0x20b, optionalOffset)
  buffer.writeUInt32LE(512, optionalOffset + 60)
  buffer.write('.text\0\0\0', sectionOffset, 'binary')
  buffer.writeUInt32LE(64, sectionOffset + 16)
  buffer.writeUInt32LE(512, sectionOffset + 20)
  return buffer
}

describe('release verification', () => {
  test('accepts only PE x64 executables', () => {
    expect(() => assertPeX64(pe(), 'codex.exe')).not.toThrow()
    expect(() => assertPeX64(pe(0x14c), 'codex.exe')).toThrow(/x64/i)
    expect(() => assertPeX64(Buffer.from('not-an-exe'), 'codex.exe')).toThrow(/PE/i)
  })

  test('accepts a structurally valid NSIS-like PE32 portable executable', () => {
    expect(() => assertPortableExecutable(portablePe(), 'portable artifact')).not.toThrow()
    expect(() => assertPortableExecutable(portablePe(0x8664), 'portable artifact')).not.toThrow()
  })

  test('rejects malformed, truncated, or unsupported portable executable headers and sections', () => {
    const onlyMz = Buffer.alloc(64)
    onlyMz.write('MZ')

    const truncatedHeaders = portablePe().subarray(0, 400)
    const invalidMachine = portablePe()
    invalidMachine.writeUInt16LE(0xaa64, 0x84)
    const invalidMagic = portablePe()
    invalidMagic.writeUInt16LE(0x999, 0x98)
    const shortOptionalHeader = portablePe()
    shortOptionalHeader.writeUInt16LE(0x40, 0x80 + 20)
    const invalidSection = portablePe()
    invalidSection.writeUInt32LE(900, 0x80 + 24 + 0xe0 + 20)
    invalidSection.writeUInt32LE(200, 0x80 + 24 + 0xe0 + 16)

    for (const invalid of [
      Buffer.from('not an executable'),
      onlyMz,
      truncatedHeaders,
      invalidMachine,
      invalidMagic,
      shortOptionalHeader,
      invalidSection
    ]) {
      expect(() => assertPortableExecutable(invalid, 'portable artifact')).toThrow(/portable artifact/i)
    }
  })

  test('requires portable x64 asInvoker builder settings and exact filename', () => {
    const valid = {
      asar: true,
      artifactName: 'AI-Debates-Portable-x64.exe',
      files: ['out/**/*', 'package.json'],
      extraResources: [
        { from: 'resources/bin/codex.exe', to: 'bin/codex.exe' },
        { from: 'resources/bin/credential-helper.exe', to: 'bin/credential-helper.exe' },
        { from: 'resources/bin/codex-runtime-manifest.json', to: 'bin/codex-runtime-manifest.json' }
      ],
      win: {
        requestedExecutionLevel: 'asInvoker',
        target: [{ target: 'portable', arch: ['x64'] }]
      }
    }
    expect(() => assertBuilderConfig(valid)).not.toThrow()

    for (const invalid of [
      { ...valid, artifactName: 'AI-Debates.exe' },
      { ...valid, asar: false },
      { ...valid, win: { ...valid.win, requestedExecutionLevel: 'requireAdministrator' } },
      { ...valid, win: { ...valid.win, target: [{ target: 'nsis', arch: ['x64'] }] } },
      { ...valid, win: { ...valid.win, target: [{ target: 'portable', arch: ['ia32'] }] } },
      { ...valid, extraResources: valid.extraResources.slice(1) },
      { ...valid, files: ['**/*'] }
    ]) {
      expect(() => assertBuilderConfig(invalid)).toThrow()
    }
  })

  test('rejects secrets, test fixtures, source maps, and a missing package main in asar', () => {
    expect(() =>
      assertAsarContents([
        '/package.json',
        '/out/main/index.js',
        '/out/renderer/index.html',
        '/node_modules/zod/src/v3/tests/string.test.ts'
      ])
    ).not.toThrow()

    for (const forbidden of [
      '/.env',
      '/out/main/index.js.map',
      '/tests/fixtures/provider-key.json',
      '/out/fixture-secret.txt'
    ]) {
      expect(() => assertAsarContents(['/package.json', '/out/main/index.js', forbidden])).toThrow(
        /forbidden/i
      )
    }
    expect(() => assertAsarContents(['/package.json'])).toThrow(/main/i)
  })

  test('staged runtime fails clearly when binaries are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-debates-runtime-'))
    try {
      await expect(verifyStagedRuntime({ root, expectedVersion: '0.147.0' })).rejects.toThrow(
        /codex\.exe.*missing/i
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('staged runtime validates both binaries, fixed version, and binary hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-debates-runtime-'))
    try {
      const bin = join(root, 'resources', 'bin')
      await mkdir(bin, { recursive: true })
      await writeFile(join(bin, 'codex.exe'), pe())
      await writeFile(join(bin, 'credential-helper.exe'), pe())
      await writeFile(
        join(bin, 'codex-runtime-manifest.json'),
        JSON.stringify({
          package: '@openai/codex-win32-x64',
          packageVersion: '0.147.0-win32-x64',
          codexVersion: '0.147.0',
          integrity: 'sha512-test',
          binarySha256: 'wrong'
        })
      )

      await expect(verifyStagedRuntime({ root, expectedVersion: '0.147.0' })).rejects.toThrow(
        /SHA-256/i
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('verifies the portable artifact, unpacked runtimes, builder config, and asar contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-debates-artifact-'))
    try {
      const dist = join(root, 'dist')
      const unpacked = join(dist, 'win-unpacked')
      const bin = join(unpacked, 'resources', 'bin')
      const appSource = join(root, 'app-source')
      const codex = pe()
      const artifact = portablePe()
      await mkdir(bin, { recursive: true })
      await mkdir(join(appSource, 'out', 'main'), { recursive: true })
      await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@openai/codex': '0.147.0' } }))
      await writeFile(join(root, 'electron-builder.yml'), [
        'asar: true',
        'artifactName: AI-Debates-Portable-x64.exe',
        'files:',
        '  - out/**/*',
        '  - package.json',
        'extraResources:',
        '  - from: resources/bin/codex.exe',
        '    to: bin/codex.exe',
        '  - from: resources/bin/credential-helper.exe',
        '    to: bin/credential-helper.exe',
        '  - from: resources/bin/codex-runtime-manifest.json',
        '    to: bin/codex-runtime-manifest.json',
        'win:',
        '  requestedExecutionLevel: asInvoker',
        '  target:',
        '    - target: portable',
        '      arch: [x64]'
      ].join('\n'))
      await writeFile(join(dist, 'AI-Debates-Portable-x64.exe'), artifact)
      await writeFile(join(bin, 'codex.exe'), codex)
      await writeFile(join(bin, 'credential-helper.exe'), pe())
      await writeFile(join(bin, 'codex-runtime-manifest.json'), JSON.stringify({
        package: '@openai/codex-win32-x64',
        packageVersion: '0.147.0-win32-x64',
        codexVersion: '0.147.0',
        integrity: 'sha512-test',
        binarySha256: createHash('sha256').update(codex).digest('hex')
      }))
      await writeFile(join(appSource, 'package.json'), JSON.stringify({ main: 'out/main/index.js' }))
      await writeFile(join(appSource, 'out', 'main', 'index.js'), 'console.log("app")')
      await createPackage(appSource, join(unpacked, 'resources', 'app.asar'))

      await expect(verifyArtifact({ root })).resolves.toMatchObject({
        artifactPath: join(dist, 'AI-Debates-Portable-x64.exe'),
        size: artifact.length,
        sha256: createHash('sha256').update(artifact).digest('hex')
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
