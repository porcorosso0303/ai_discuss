import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parse } from 'yaml'
import { describe, expect, test } from 'vitest'

import { assertBuilderConfig } from '../../../scripts/lib/release-verification.mjs'

const root = resolve(import.meta.dirname, '../../..')

describe('Windows portable packaging configuration', () => {
  test('packages only the built app and stages both x64 runtime executables', async () => {
    const config = parse(await readFile(resolve(root, 'electron-builder.yml'), 'utf8'))
    expect(() => assertBuilderConfig(config)).not.toThrow()
    expect(config.directories?.output).toBe('dist')
    expect(config.files).toEqual(expect.arrayContaining(['out/**/*', 'package.json']))
    expect(config.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'resources/bin/codex.exe', to: 'bin/codex.exe' }),
      expect.objectContaining({ from: 'resources/bin/credential-helper.exe', to: 'bin/credential-helper.exe' }),
      expect.objectContaining({ from: 'resources/bin/codex-runtime-manifest.json', to: 'bin/codex-runtime-manifest.json' })
    ]))
  })

  test('exposes deterministic stage, build, and verification scripts', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
    expect(pkg.devDependencies['@openai/codex']).toBe('0.147.0')
    expect(pkg.scripts).toMatchObject({
      lint: 'node scripts/lint-source.mjs',
      'build:credential-helper': 'node scripts/build-credential-helper.mjs',
      'stage:codex': 'node scripts/stage-codex-runtime.mjs',
      'verify:staged-runtime': 'node scripts/verify-staged-runtime.mjs',
      'dist:win': 'npm run build && electron-builder --win portable --x64',
      'verify:artifact': 'node scripts/verify-artifact.mjs'
    })
  })

  test('Windows CI executes the release pipeline in order and uploads the verified executable', async () => {
    const workflow = parse(await readFile(resolve(root, '.github/workflows/windows-build.yml'), 'utf8'))
    const steps = workflow.jobs?.build?.steps ?? []
    const commands = steps.flatMap((step: { run?: string }) => step.run ? [step.run] : [])
    expect(commands).toEqual([
      'npm ci',
      'npm run build:credential-helper',
      'npm run stage:codex',
      'npm run verify:staged-runtime',
      'npm test',
      'npm run typecheck',
      'npm run lint',
      'npm run test:e2e',
      'npm run dist:win',
      'npm run verify:artifact',
      'Get-FileHash dist/AI-Debates-Portable-x64.exe -Algorithm SHA256'
    ])
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uses: 'actions/upload-artifact@v4',
        with: expect.objectContaining({ path: 'dist/AI-Debates-Portable-x64.exe' })
      })
    ]))
  })
})
