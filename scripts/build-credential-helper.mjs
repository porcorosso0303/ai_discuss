import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = resolve(repositoryRoot, 'native', 'credential-helper')
const outputFile = resolve(repositoryRoot, 'resources', 'bin', 'credential-helper.exe')

mkdirSync(dirname(outputFile), { recursive: true })
execFileSync('go', ['build', '-trimpath', '-o', outputFile, '.'], {
  cwd: sourceDirectory,
  env: {
    ...process.env,
    GOOS: 'windows',
    GOARCH: 'amd64',
    CGO_ENABLED: '0'
  },
  stdio: 'inherit',
  windowsHide: true
})
