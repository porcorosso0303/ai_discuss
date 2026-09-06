import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyArtifact } from './lib/release-verification.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await verifyArtifact({ root: repositoryRoot })
console.log(`Verified ${result.artifactPath}`)
console.log(`Size: ${result.size} bytes`)
console.log(`SHA-256: ${result.sha256}`)
