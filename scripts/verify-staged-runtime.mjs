import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyStagedRuntime } from './lib/release-verification.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'))
const expectedVersion = packageJson.devDependencies?.['@openai/codex']
const result = await verifyStagedRuntime({ root: repositoryRoot, expectedVersion })
console.log(`Verified staged Codex ${result.manifest.codexVersion} and credential helper (PE x64)`)
