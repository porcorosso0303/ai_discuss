import { describe, expect, it, vi } from 'vitest'

import { runCredentialedLiveEntry } from './live-test-gate'

describe('credentialed live test gate', () => {
  it('skips without entering the live callback when only the credential exists', async () => {
    const enter = vi.fn()

    const result = await runCredentialedLiveEntry(
      { RUN_KIMI_LIVE_TEST: undefined, KIMI_API_KEY: 'present-but-not-authorized' },
      'RUN_KIMI_LIVE_TEST',
      'KIMI_API_KEY',
      enter
    )

    expect(result).toBe('skipped')
    expect(enter).not.toHaveBeenCalled()
  })

  it.each([undefined, '', '   '])(
    'fails with a fixed message when opted in with credential %j',
    async (apiKey) => {
      const enter = vi.fn()

      await expect(runCredentialedLiveEntry(
        { RUN_DEEPSEEK_LIVE_TEST: '1', DEEPSEEK_API_KEY: apiKey },
        'RUN_DEEPSEEK_LIVE_TEST',
        'DEEPSEEK_API_KEY',
        enter
      )).rejects.toThrow(
        'RUN_DEEPSEEK_LIVE_TEST=1 requires a non-empty DEEPSEEK_API_KEY'
      )
      expect(enter).not.toHaveBeenCalled()
    }
  )

  it('enters the live callback only when both opt-in and credential are present', async () => {
    const enter = vi.fn(async (apiKey: string) => apiKey.length)

    const result = await runCredentialedLiveEntry(
      { RUN_KIMI_LIVE_TEST: '1', KIMI_API_KEY: 'test-key' },
      'RUN_KIMI_LIVE_TEST',
      'KIMI_API_KEY',
      enter
    )

    expect(result).toBe('ran')
    expect(enter).toHaveBeenCalledOnce()
    expect(enter).toHaveBeenCalledWith('test-key')
  })
})
