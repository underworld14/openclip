import { describe, expect, it } from 'vitest'
import { APP_NAME, APP_VERSION } from '@shared'

describe('scaffold: shared contract barrel + @shared alias', () => {
  it('exposes app metadata through the @shared alias', () => {
    expect(APP_NAME).toBe('OpenClip Desktop')
    expect(APP_VERSION).toBe('2.0.0')
  })
})
