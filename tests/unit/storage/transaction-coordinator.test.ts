import { describe, expect, it } from 'vitest'

import { runKeyedTransaction } from '../../../src/main/storage/transaction-coordinator'

describe('runKeyedTransaction', () => {
  it('does not block a different root and releases rejected queues', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = runKeyedTransaction('/root-a', 'repo', async () => await held)
    let differentFinished = false
    await runKeyedTransaction('/root-b', 'repo', async () => {
      differentFinished = true
    })
    expect(differentFinished).toBe(true)
    release()
    await first

    await expect(
      runKeyedTransaction('/root-a', 'repo', async () => {
        throw new Error('expected failure')
      })
    ).rejects.toThrow('expected failure')
    await expect(runKeyedTransaction('/root-a', 'repo', async () => 'recovered')).resolves.toBe(
      'recovered'
    )
  })
})
