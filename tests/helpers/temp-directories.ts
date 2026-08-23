import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directories = new Set<string>()

export const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.add(directory)
  return directory
}

export const removeTempDirectories = async (): Promise<void> => {
  const pending = [...directories]
  directories.clear()
  await Promise.all(pending.map((directory) => rm(directory, { recursive: true, force: true })))
}
