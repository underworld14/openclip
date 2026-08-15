/**
 * tests/unit/ai-errors.spec.ts — the seam every provider failure leaves main
 * through (FEAT-bysdwg).
 *
 * This is a SECRET-ECHO boundary: provider 401 bodies routinely quote the
 * submitted key back, the OpenAI SDK builds its error message from the response
 * body verbatim, and for a custom endpoint that body is chosen by a server we do
 * not control. The redaction was previously only exercised indirectly, through
 * handlers whose canned copy would have passed even if it were a no-op.
 */

import { describe, expect, it } from 'vitest'
import {
  describeProviderFailure,
  humanTransportError,
  MAX_PROVIDER_ERROR_CHARS,
  redactSecrets
} from '@main/services/ai-errors'

describe('redactSecrets', () => {
  it('strips key-shaped tokens from every provider we speak to', () => {
    const text =
      'bad key sk-proj-AbCdEf0123456789, or sk-ant-api03-XyZ987654321, or sk-or-v1-QQQQQQQQ'
    const out = redactSecrets(text)
    expect(out).not.toMatch(/sk-proj-AbCdEf/)
    expect(out).not.toMatch(/sk-ant-api03/)
    expect(out).not.toMatch(/sk-or-v1/)
    expect(out).toContain('[redacted]')
  })

  it('strips the ACTUAL key even when it looks like nothing in particular', () => {
    // The only check that works for a gateway with a bespoke key format — which
    // is the whole point of supporting arbitrary endpoints.
    const key = 'corp-gateway-token-8f3a2b'
    const out = redactSecrets(`401 Unauthorized: token ${key} is not valid`, key)
    expect(out).not.toContain(key)
    expect(out).toContain('[redacted]')
  })

  it('ignores a suspiciously short "key" rather than blanking real words', () => {
    expect(redactSecrets('the model is not available', 'abc')).toBe('the model is not available')
  })

  it('caps the length, so a hostile endpoint cannot paste a wall of text into the UI', () => {
    const out = redactSecrets('x'.repeat(5000))
    expect(out.length).toBeLessThanOrEqual(MAX_PROVIDER_ERROR_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
  })

  it('leaves ordinary prose alone', () => {
    const msg = 'Could not reach the server on port 1234'
    expect(redactSecrets(msg, null)).toBe(msg)
  })
})

describe('humanTransportError', () => {
  it('redacts the key in the unrecognised-error branch, where the body is quoted', () => {
    // This branch deliberately quotes the server so a self-hosted user has a
    // clue — which makes it the one branch that MUST redact.
    const key = 'sk-local-0123456789'
    const msg = humanTransportError(
      new Error(`418 {"error":"teapot; key ${key} refused"}`),
      'custom',
      'local-model',
      'http://localhost:1234/v1',
      key
    )
    expect(msg).not.toContain(key)
    expect(msg).toContain('Server said:')
    expect(msg.length).toBeLessThanOrEqual(MAX_PROVIDER_ERROR_CHARS + 120)
  })

  it('names the endpoint host rather than the enum id', () => {
    const msg = humanTransportError(
      new Error('fetch failed: ECONNREFUSED'),
      'custom',
      'local-model',
      'http://localhost:1234/v1'
    )
    expect(msg).toContain('localhost:1234')
    expect(msg).not.toMatch(/^custom /)
  })

  it('never quotes the full URL, which can carry more than a host', () => {
    const msg = humanTransportError(
      new Error('some unrecognised failure'),
      'custom',
      'm',
      'http://localhost:1234/very/telling/path'
    )
    expect(msg).not.toContain('/very/telling/path')
  })
})

describe('describeProviderFailure', () => {
  const args = { provider: 'custom' as const, model: 'local-model', baseUrl: 'http://h:1/v1' }

  it('types a rejected key as non-retriable API_AUTH', () => {
    // Retrying a rejected key just fails again — it used to surface as
    // SIDECAR_CRASH with the raw body attached.
    const f = describeProviderFailure(new Error('401 Incorrect API key provided: sk-bad12345'), {
      ...args,
      apiKey: 'sk-bad12345'
    })
    expect(f.code).toBe('API_AUTH')
    expect(f.retriable).toBe(false)
    expect(f.message).not.toContain('sk-bad12345')
  })

  it('types a quota failure as retriable API_RATE_LIMIT', () => {
    const f = describeProviderFailure(new Error('429 rate_limit_exceeded'), args)
    expect(f.code).toBe('API_RATE_LIMIT')
    expect(f.retriable).toBe(true)
  })

  it('falls back to a retriable crash for anything unrecognised', () => {
    const f = describeProviderFailure(new Error('something odd'), args)
    expect(f.code).toBe('SIDECAR_CRASH')
    expect(f.retriable).toBe(true)
  })
})
