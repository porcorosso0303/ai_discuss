import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

const transactions = new Map<string, Promise<void>>()

const rootKey = async (root: string): Promise<string> => {
  const resolved = resolve(root)
  const missingSegments: string[] = []
  let existing = resolved
  let normalized: string
  while (true) {
    try {
      normalized = resolve(await realpath(existing), ...missingSegments)
      break
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error
      }
      const parent = dirname(existing)
      if (parent === existing) throw error
      missingSegments.unshift(basename(existing))
      existing = parent
    }
  }
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export const runKeyedTransaction = async <T>(
  root: string,
  namespace: string,
  operation: () => Promise<T>
): Promise<T> => {
  const key = `${await rootKey(root)}\0${namespace}`
  const previous = transactions.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(operation)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  transactions.set(key, tail)
  try {
    return await run
  } finally {
    if (transactions.get(key) === tail) transactions.delete(key)
  }
}
