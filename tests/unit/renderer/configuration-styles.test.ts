import { readFile } from 'node:fs/promises'

import { expect, it } from 'vitest'

it('provides a 320px-safe single-column configuration layout', async () => {
  const css = await readFile(new URL('../../../src/renderer/src/styles/components.css', import.meta.url), 'utf8')
  const compact = css.match(/@media\s*\(max-width:\s*640px\)[\s\S]*$/)?.[0] ?? ''
  expect(compact).toMatch(/\.desktop-shell\s*\{[^}]*grid-template:/)
  expect(compact).toMatch(/\.field-grid\s*\{[^}]*grid-template-columns:\s*1fr/)
  expect(compact).toMatch(/\.configuration-page\s*\{[^}]*padding-inline:/)
  expect(compact).toMatch(/\.sidebar\s*\{[^}]*border-bottom:/)
})

it('provides distinct debate columns, visible focus, and a compact 320px layout without gradients', async () => {
  const css = await readFile(new URL('../../../src/renderer/src/styles/components.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.debate-columns\s*\{[^}]*grid-template-columns:\s*repeat\(2/)
  expect(css).toMatch(/\.debate-column\.role-a\s*\{[^}]*border-top-color:\s*var\(--cyan\)/)
  expect(css).toMatch(/\.debate-column\.role-b\s*\{[^}]*border-top-color:\s*var\(--orange\)/)
  expect(css).toMatch(/\.debate-controls[^}]*button:focus-visible/)
  const compact = css.match(/@media\s*\(max-width:\s*640px\)[\s\S]*$/)?.[0] ?? ''
  expect(compact).toMatch(/\.debate-columns\s*\{[^}]*grid-template-columns:\s*1fr/)
  expect(css).not.toMatch(/gradient\s*\(/i)
})
