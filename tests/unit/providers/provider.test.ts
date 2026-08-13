import { describe, expect, it } from 'vitest'

import { ProviderRetryableError } from '../../../src/main/providers/provider'

describe('ProviderRetryableError', () => {
  it('retains only bounded redacted Retry-After metadata without a cause', () => {
    const secret = 'provider-retry-secret'
    const error = new ProviderRetryableError('temporary failure', {
      retryAfter: `Bearer ${secret} ${'x'.repeat(300)}`
    })

    expect(error.retryAfter).toBeDefined()
    expect(error.retryAfter?.length).toBeLessThanOrEqual(128)
    expect(error.retryAfter).not.toContain(secret)
    expect(error.cause).toBeUndefined()
  })
})
