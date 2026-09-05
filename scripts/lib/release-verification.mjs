import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { listPackage } from '@electron/asar'
import { parse } from 'yaml'

const execFileAsync = promisify(execFile)

export function assertPeX64(buffer, label) {
  if (buffer.length < 0x86 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${label} is not a valid PE executable`)
  }
  const peOffset = buffer.readUInt32LE(0x3c)
  if (
    peOffset < 0x40 ||
    peOffset + 6 > buffer.length ||
    buffer.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    throw new Error(`${label} has an invalid PE header`)
  }
  if (buffer.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error(`${label} must be a PE x64 executable`)
  }
}

export function assertPortableExecutable(buffer, label) {
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${label} is not a valid PE executable`)
  }

  const peOffset = buffer.readUInt32LE(0x3c)
  const coffEnd = peOffset + 24
  if (
    peOffset < 0x40 ||
    coffEnd > buffer.length ||
    buffer.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    throw new Error(`${label} has an invalid PE header`)
  }

  const machine = buffer.readUInt16LE(peOffset + 4)
  const sectionCount = buffer.readUInt16LE(peOffset + 6)
  const optionalSize = buffer.readUInt16LE(peOffset + 20)
  const optionalOffset = coffEnd
  if ((machine !== 0x14c && machine !== 0x8664) || sectionCount < 1 || sectionCount > 96) {
    throw new Error(`${label} has an unsupported PE machine or section count`)
  }
  const minimumOptionalSize = machine === 0x14c ? 0xe0 : 0xf0
  if (optionalSize < minimumOptionalSize || optionalOffset + optionalSize > buffer.length) {
    throw new Error(`${label} has a truncated optional PE header`)
  }

  const optionalMagic = buffer.readUInt16LE(optionalOffset)
  if (
    (machine === 0x14c && optionalMagic !== 0x10b) ||
    (machine === 0x8664 && optionalMagic !== 0x20b)
  ) {
    throw new Error(`${label} has an invalid PE optional header`)
  }

  const sectionTable = optionalOffset + optionalSize
  const sectionTableEnd = sectionTable + sectionCount * 40
  if (sectionTableEnd > buffer.length) {
    throw new Error(`${label} has a truncated PE section table`)
  }

  const sizeOfHeaders = buffer.readUInt32LE(optionalOffset + 60)
  if (sizeOfHeaders < sectionTableEnd || sizeOfHeaders > buffer.length) {
    throw new Error(`${label} has an invalid PE header size`)
  }

  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTable + index * 40
    const rawSize = buffer.readUInt32LE(section + 16)
    const rawOffset = buffer.readUInt32LE(section + 20)
    if (rawSize > 0 && (rawOffset < sizeOfHeaders || rawOffset > buffer.length - rawSize)) {
      throw new Error(`${label} has an invalid PE section range`)
    }
  }
}

export function assertBuilderConfig(config) {
  if (config.asar !== true) throw new Error('electron-builder asar must be enabled')
  if (config.artifactName !== 'AI-Debates-Portable-x64.exe') {
    throw new Error('portable artifact filename must be AI-Debates-Portable-x64.exe')
  }
  const win = config.win ?? {}
  if (win.requestedExecutionLevel !== 'asInvoker') {
    throw new Error('Windows release must not request administrator privileges')
  }
  const targets = Array.isArray(win.target) ? win.target : []
  const portable = targets.find((target) => target?.target === 'portable')
  if (!portable || !Array.isArray(portable.arch) || portable.arch.length !== 1 || portable.arch[0] !== 'x64') {
    throw new Error('Windows target must be portable x64 only')
  }
  const files = Array.isArray(config.files) ? config.files : []
  if (files.length !== 2 || !files.includes('out/**/*') || !files.includes('package.json')) {
    throw new Error('release files must contain only built output and package.json')
  }
  const resources = Array.isArray(config.extraResources) ? config.extraResources : []
  for (const expected of [
    ['resources/bin/codex.exe', 'bin/codex.exe'],
    ['resources/bin/credential-helper.exe', 'bin/credential-helper.exe'],
    ['resources/bin/codex-runtime-manifest.json', 'bin/codex-runtime-manifest.json']
  ]) {
    if (!resources.some((entry) => entry?.from === expected[0] && entry?.to === expected[1])) {
      throw new Error(`release is missing extra resource ${expected[0]}`)
    }
  }
}

export function assertAsarContents(entries) {
  const normalized = entries.map((entry) => entry.replaceAll('\\', '/'))
  const forbidden = normalized.find((entry) => {
    const lower = entry.toLowerCase()
    return (
      /(^|\/)\.env(?:\.|$)/.test(lower) ||
      lower.endsWith('.map') ||
      /^\/tests?(\/|$)/.test(lower) ||
      /fixture[^/]*(?:key|secret)|(?:key|secret)[^/]*fixture/.test(lower)
    )
  })
  if (forbidden) throw new Error(`asar contains forbidden release file: ${forbidden}`)
  if (!normalized.includes('/package.json')) throw new Error('asar is missing package.json')
  if (!normalized.includes('/out/main/index.js')) throw new Error('asar is missing package main out/main/index.js')
}

async function requiredFile(path, label) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`${label} is missing: ${path}`)
    throw error
  }
}

export async function verifyStagedRuntime({ root, expectedVersion, platform = process.platform }) {
  const bin = join(root, 'resources', 'bin')
  const codexPath = join(bin, 'codex.exe')
  const helperPath = join(bin, 'credential-helper.exe')
  const codexBytes = await requiredFile(codexPath, 'codex.exe')
  const helperBytes = await requiredFile(helperPath, 'credential-helper.exe')
  assertPeX64(codexBytes, 'codex.exe')
  assertPeX64(helperBytes, 'credential-helper.exe')

  const manifestBytes = await requiredFile(
    join(bin, 'codex-runtime-manifest.json'),
    'Codex runtime manifest'
  )
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new Error('Codex runtime manifest is not valid JSON')
  }
  if (
    manifest.package !== '@openai/codex-win32-x64' ||
    manifest.packageVersion !== `${expectedVersion}-win32-x64` ||
    manifest.codexVersion !== expectedVersion ||
    typeof manifest.integrity !== 'string' ||
    !manifest.integrity.startsWith('sha512-')
  ) {
    throw new Error(`Codex runtime manifest must pin official version ${expectedVersion}`)
  }
  const digest = createHash('sha256').update(codexBytes).digest('hex')
  if (manifest.binarySha256 !== digest) throw new Error('codex.exe SHA-256 does not match manifest')

  if (platform === 'win32') {
    const { stdout } = await execFileAsync(codexPath, ['--version'], { windowsHide: true, timeout: 30_000 })
    if (stdout.trim() !== `codex-cli ${expectedVersion}`) {
      throw new Error(`codex.exe reported unexpected version: ${stdout.trim()}`)
    }
  }
  return { codexPath, helperPath, manifest }
}

/**
 * @param {{ root: string, platform?: NodeJS.Platform }} options
 */
export async function verifyArtifact({ root, platform = process.platform }) {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const expectedVersion = packageJson.devDependencies?.['@openai/codex']
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion ?? '')) {
    throw new Error('@openai/codex must be pinned to an exact version')
  }

  const builderConfig = parse(await readFile(join(root, 'electron-builder.yml'), 'utf8'))
  assertBuilderConfig(builderConfig)

  const artifactPath = join(root, 'dist', 'AI-Debates-Portable-x64.exe')
  const artifact = await requiredFile(artifactPath, 'portable artifact')
  assertPortableExecutable(artifact, 'portable artifact')

  const unpackedRoot = join(root, 'dist', 'win-unpacked')
  await verifyStagedRuntime({ root: unpackedRoot, expectedVersion, platform })
  const asarPath = join(unpackedRoot, 'resources', 'app.asar')
  await requiredFile(asarPath, 'app.asar')
  assertAsarContents(listPackage(asarPath, { isPack: false }))

  const metadata = await stat(artifactPath)
  return {
    artifactPath,
    size: metadata.size,
    sha256: createHash('sha256').update(artifact).digest('hex')
  }
}
