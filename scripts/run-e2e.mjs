import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const cli = resolve('node_modules/@playwright/test/cli.js')
const forwarded = process.argv.slice(2)
const playwright = process.platform === 'win32'
  ? [process.execPath, [cli, 'test', ...forwarded]]
  : ['xvfb-run', ['-a', process.execPath, cli, 'test', ...forwarded]]
const result = spawnSync(playwright[0], playwright[1], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  shell: false
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
