import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

const transactions = new Map<string, Promise<void>>()

const rootKey = async (root: string): Promise<string> => {
  const resolved = resolve(root)
  const normalized = await realpath(resolved).catch(async (error: unknown) => {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
    return resolve(await realpath(dirname(resolved)), basename(resolved))
  })
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
