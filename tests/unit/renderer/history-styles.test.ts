import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('history page styles', () => {
  it('uses a 320px list/detail layout, a modal overlay, and a single-column narrow layout', async () => {
    const css = await readFile('src/renderer/src/styles/components.css', 'utf8')
    expect(css).toMatch(/\.history-layout\s*\{[^}]*grid-template-columns:\s*320px\s+minmax\(0,\s*1fr\)/s)
    expect(css).toMatch(/\.confirm-overlay\s*\{[^}]*position:\s*fixed/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.history-layout\s*\{[^}]*grid-template-columns:\s*1fr/s)
  })
})
