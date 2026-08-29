import { createHash, timingSafeEqual } from 'node:crypto'

const WIN_PACKAGE_PATH = 'node_modules/@openai/codex-win32-x64'

export function assertRegistryTarball(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Codex runtime lockfile resolved URL is invalid')
  }
  if (url.protocol !== 'https:') throw new Error('Codex runtime tarball must use HTTPS')
  if (url.hostname !== 'registry.npmjs.org') {
    throw new Error('Codex runtime tarball must come from registry.npmjs.org')
  }
  return url
}

export function resolveLockedCodexRuntime(lock, expectedVersion) {
  if (lock?.lockfileVersion !== 3 || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json must use lockfileVersion 3')
  }
  if (lock.packages['node_modules/@openai/codex']?.version !== expectedVersion) {
    throw new Error(`@openai/codex must be locked to ${expectedVersion}`)
  }
  const runtime = lock.packages[WIN_PACKAGE_PATH]
  if (!runtime || runtime.version !== `${expectedVersion}-win32-x64`) {
    throw new Error(`Windows x64 Codex runtime version must be ${expectedVersion}-win32-x64`)
  }
  if (typeof runtime.resolved !== 'string') throw new Error('Codex runtime resolved URL is missing')
  assertRegistryTarball(runtime.resolved)
  if (typeof runtime.integrity !== 'string' || !runtime.integrity.startsWith('sha512-')) {
    throw new Error('Codex runtime SHA-512 integrity is missing')
  }
  return {
    package: '@openai/codex-win32-x64',
    packageVersion: runtime.version,
    codexVersion: expectedVersion,
    resolved: runtime.resolved,
    integrity: runtime.integrity
  }
}

export function verifyIntegrity(bytes, integrity) {
  const separator = integrity.indexOf('-')
  if (separator < 1) throw new Error('Unsupported npm integrity value')
  const algorithm = integrity.slice(0, separator)
  if (algorithm !== 'sha512') throw new Error(`Unsupported npm integrity algorithm: ${algorithm}`)
  const expected = Buffer.from(integrity.slice(separator + 1), 'base64')
  const actual = createHash(algorithm).update(bytes).digest()
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Downloaded Codex runtime failed npm integrity verification')
  }
}
