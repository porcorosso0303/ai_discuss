import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const checkedExtensions = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.mts', '.ts', '.tsx', '.yaml', '.yml'
])
const maxSourceBytes = 2 * 1024 * 1024
const roots = ['.github', 'docs', 'scripts', 'src', 'tests']
const rootFiles = [
  'CHANGELOG.md', 'README.md', 'electron-builder.yml', 'electron.vite.config.ts',
  'package.json', 'playwright.config.ts', 'tsconfig.json', 'tsconfig.node.json'
]

const sourceFiles = [...rootFiles]
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (entry.isFile() && checkedExtensions.has(extname(path))) sourceFiles.push(path)
  }
}
for (const root of roots) {
  if (statSync(root).isDirectory()) visit(root)
}
sourceFiles.sort()

const failures = []
for (const path of sourceFiles) {
  const bytes = readFileSync(path)
  if (bytes.length > maxSourceBytes) {
    failures.push(`${path}: source file exceeds ${maxSourceBytes} bytes`)
    continue
  }
  if (bytes.includes(0)) failures.push(`${path}: contains a NUL byte`)
  const content = bytes.toString('utf8')
  if (content !== '' && !content.endsWith('\n')) failures.push(`${path}: missing final newline`)
  content.split('\n').forEach((line, index) => {
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?: |$)/u.test(line)) {
      failures.push(`${path}:${index + 1}: unresolved merge marker`)
    }
    if (/[\t ]+$/u.test(line)) failures.push(`${path}:${index + 1}: trailing whitespace`)
  })
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`Checked ${sourceFiles.length} source files.\n`)
}
