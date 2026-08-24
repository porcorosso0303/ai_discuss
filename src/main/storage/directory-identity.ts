import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { runKeyedTransaction } from './transaction-coordinator'

export type FilesystemMutationStage =
  | 'before-temp-open'
  | 'before-target-open'
  | 'before-rename'
  | 'before-unlink'
  | 'before-directory-open'
  | 'before-mkdir'
  | 'before-file-cap-check'
  | 'before-file-write'
  | 'after-target-close'

export type FilesystemMutationHook = (
  stage: FilesystemMutationStage,
  target: string
) => void | Promise<void>

interface DirectoryIdentity {
  path: string
  canonicalPath: string
  device: number
  inode: number
}

const comparablePath = (path: string): string =>
  process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path

const directoryChain = (leaf: string, anchor?: string): string[] => {
  const resolvedLeaf = resolve(leaf)
  const resolvedAnchor = anchor === undefined ? undefined : resolve(anchor)
  const reversed: string[] = []
  let current = resolvedLeaf
  while (true) {
    reversed.push(current)
    if (resolvedAnchor !== undefined && comparablePath(current) === comparablePath(resolvedAnchor)) {
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (
    resolvedAnchor !== undefined &&
    comparablePath(reversed.at(-1) ?? '') !== comparablePath(resolvedAnchor)
  ) {
    throw new TypeError('Directory identity anchor is not an ancestor')
  }
  return reversed.reverse()
}

const inspectDirectory = async (path: string): Promise<DirectoryIdentity> => {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError('Guarded path must be a non-symlink directory')
  }
  return {
    path,
    canonicalPath: await realpath(path),
    device: info.dev,
    inode: info.ino
  }
}

const sameIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  comparablePath(left.canonicalPath) === comparablePath(right.canonicalPath) &&
  left.device === right.device &&
  left.inode === right.inode

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const assertCanonicalDirectory = async (path: string): Promise<void> => {
  const identity = await inspectDirectory(path)
  if (comparablePath(identity.canonicalPath) !== comparablePath(path)) {
    throw new TypeError('Guarded directory must use its canonical non-symlink path')
  }
}

export const initializeGuardedDirectory = async (
  directory: string,
  options: { hook?: FilesystemMutationHook } = {}
): Promise<void> => {
  const target = resolve(directory)
  await runKeyedTransaction(target, 'guarded-directory-initialization', async () => {
    const missing: string[] = []
    let existing = target
    while (true) {
      try {
        await assertCanonicalDirectory(existing)
        break
      } catch (error) {
        if (!isMissing(error)) throw error
        const parent = dirname(existing)
        if (parent === existing) throw error
        missing.unshift(existing)
        existing = parent
      }
    }

    let guard = await DirectoryIdentityGuard.capture(existing, { hook: options.hook })
    for (const path of missing) {
      await guard.before('before-mkdir', path)
      await mkdir(path, { mode: 0o700 }).catch((error) => {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        ) {
          throw error
        }
      })
      await guard.after()
      await assertCanonicalDirectory(path)
      guard = await DirectoryIdentityGuard.capture(path, { hook: options.hook })
    }
    await guard.verify()
  })
}

export class DirectoryIdentityGuard {
  private constructor(
    private readonly identities: DirectoryIdentity[],
    private readonly hook?: FilesystemMutationHook
  ) {}

  static async capture(
    directory: string,
    options: { anchor?: string; hook?: FilesystemMutationHook } = {}
  ): Promise<DirectoryIdentityGuard> {
    const identities: DirectoryIdentity[] = []
    for (const path of directoryChain(directory, options.anchor)) {
      identities.push(await inspectDirectory(path))
    }
    return new DirectoryIdentityGuard(identities, options.hook)
  }

  async verify(): Promise<void> {
    for (const expected of this.identities) {
      const actual = await inspectDirectory(expected.path)
      if (!sameIdentity(expected, actual)) {
        throw new TypeError('Guarded directory identity changed during filesystem operation')
      }
    }
  }

  async before(stage: FilesystemMutationStage, target: string): Promise<void> {
    await this.verify()
    await this.hook?.(stage, target)
    await this.verify()
  }

  async after(): Promise<void> {
    await this.verify()
  }

  async cleanupIfAnchored(): Promise<boolean> {
    try {
      await this.verify()
      return true
    } catch {
      return false
    }
  }
}
