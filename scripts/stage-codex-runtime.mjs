import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { assertPeX64 } from './lib/release-verification.mjs'
import { resolveLockedCodexRuntime, verifyIntegrity } from './lib/codex-stage.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function findFiles(root, filename, matches = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await findFiles(path, filename, matches)
    else if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) matches.push(path)
  }
  return matches
}

async function atomicWrite(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(temporary, bytes, { mode: 0o755 })
  await rename(temporary, path)
}

export async function stageCodexRuntime({
  root = repositoryRoot,
  fetchImpl = globalThis.fetch,
  extract = async (archive, destination) => {
    await execFileAsync('tar', ['-xzf', archive, '-C', destination], { windowsHide: true })
  }
} = {}) {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const expectedVersion = packageJson.devDependencies?.['@openai/codex']
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion ?? '')) {
    throw new Error('@openai/codex must be an exact semver devDependency')
  }
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const source = resolveLockedCodexRuntime(lock, expectedVersion)
  const response = await fetchImpl(source.resolved, { redirect: 'error' })
  if (!response.ok) throw new Error(`Failed to download Codex runtime: HTTP ${response.status}`)
  const tarball = Buffer.from(await response.arrayBuffer())
  verifyIntegrity(tarball, source.integrity)

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ai-debates-codex-'))
  try {
    const archive = join(temporaryRoot, 'runtime.tgz')
    const extracted = join(temporaryRoot, 'extracted')
    await mkdir(extracted)
    await writeFile(archive, tarball)
    await extract(archive, extracted)
    const matches = await findFiles(extracted, 'codex.exe')
    if (matches.length !== 1) {
      throw new Error(`Official Windows runtime must contain exactly one codex.exe; found ${matches.length}`)
    }
    const binary = await readFile(matches[0])
    assertPeX64(binary, 'official codex.exe')

    const destination = join(root, 'resources', 'bin')
    await mkdir(destination, { recursive: true })
    await atomicWrite(join(destination, 'codex.exe'), binary)
    const manifest = {
      schemaVersion: 1,
      package: source.package,
      packageVersion: source.packageVersion,
      codexVersion: source.codexVersion,
      resolved: source.resolved,
      integrity: source.integrity,
      binarySha256: createHash('sha256').update(binary).digest('hex')
    }
    await atomicWrite(
      join(destination, 'codex-runtime-manifest.json'),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    )
    return manifest
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await stageCodexRuntime()
  console.log(`Staged codex.exe ${manifest.codexVersion} (${manifest.binarySha256})`)
}
