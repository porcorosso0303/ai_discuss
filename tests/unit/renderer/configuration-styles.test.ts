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
