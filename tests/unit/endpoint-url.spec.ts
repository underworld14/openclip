/**
 * tests/unit/endpoint-url.spec.ts — validation of the ONE user-supplied AI
 * endpoint (FEAT-bysdwg).
 *
 * The rules here are deliberately permissive about WHERE (localhost is the
 * primary use case, so no SSRF allow-list) and strict about SHAPE. Both halves
 * are load-bearing and easy to "tidy" into breakage, so both are pinned.
 */

import { describe, expect, it } from 'vitest'
import {
  endpointFingerprint,
  isInsecureHttpEndpoint,
  isSafeEndpointUrl,
  normalizeBaseUrl,
  safeHost
} from '@shared/endpoint-url'

describe('normalizeBaseUrl', () => {
  it('trims and strips trailing slashes only', () => {
    expect(normalizeBaseUrl('  http://localhost:1234/v1  ')).toBe('http://localhost:1234/v1')
    expect(normalizeBaseUrl('http://localhost:1234/v1///')).toBe('http://localhost:1234/v1')
  })

  it('NEVER adds or removes a /v1 segment', () => {
    // LM Studio/vLLM/Groq want /v1; LiteLLM does not. Guessing would make the
    // stored URL and the URL that actually works disagree.
    expect(normalizeBaseUrl('http://localhost:4000')).toBe('http://localhost:4000')
    expect(normalizeBaseUrl('https://api.groq.com/openai/v1')).toBe(
      'https://api.groq.com/openai/v1'
    )
  })

  it('treats blank as unset', () => {
    expect(normalizeBaseUrl('')).toBeUndefined()
    expect(normalizeBaseUrl('   ')).toBeUndefined()
    expect(normalizeBaseUrl(undefined)).toBeUndefined()
  })
})

describe('isSafeEndpointUrl', () => {
  it('accepts the endpoints this feature exists for', () => {
    for (const url of [
      'http://localhost:1234/v1',
      'http://127.0.0.1:8000/v1',
      'http://192.168.1.50:11434/v1',
      'http://gpu-box.local:8000',
      'https://api.groq.com/openai/v1',
      'https://gateway.corp.example/openai/v1'
    ]) {
      expect(isSafeEndpointUrl(url), url).toBe(true)
    }
  })

  it('rejects shapes that can only be a mistake or a trap', () => {
    for (const url of [
      'ftp://example.com/v1', // not http(s)
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://user:hunter2@gateway.corp/v1', // would persist a password in plaintext settings.json
      'https://api.example.com/v1?api-key=abc', // breaks `${base}/models`
      'https://api.example.com/v1#frag',
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'https://metadata.google.internal/v1',
      'not a url',
      ''
    ]) {
      expect(isSafeEndpointUrl(url), url).toBe(false)
    }
  })
})

describe('isInsecureHttpEndpoint', () => {
  it('warns only for plain HTTP that leaves this machine or LAN', () => {
    expect(isInsecureHttpEndpoint('http://localhost:1234/v1')).toBe(false)
    expect(isInsecureHttpEndpoint('http://127.0.0.1:1234')).toBe(false)
    expect(isInsecureHttpEndpoint('http://192.168.0.10:8000')).toBe(false)
    expect(isInsecureHttpEndpoint('http://10.1.2.3:8000')).toBe(false)
    expect(isInsecureHttpEndpoint('http://box.local:8000')).toBe(false)
    expect(isInsecureHttpEndpoint('https://api.groq.com/openai/v1')).toBe(false)
    // The key would cross a network in cleartext.
    expect(isInsecureHttpEndpoint('http://api.example.com/v1')).toBe(true)
  })
})

describe('safeHost', () => {
  it('returns host:port and never the path, so error copy cannot quote one back', () => {
    expect(safeHost('http://localhost:1234/v1')).toBe('localhost:1234')
    expect(safeHost('https://api.groq.com/openai/v1')).toBe('api.groq.com')
    expect(safeHost('nonsense')).toBe('')
  })
})

describe('endpointFingerprint (key ↔ endpoint binding)', () => {
  it('is the ORIGIN, so adding /v1 does not invalidate a saved key', () => {
    expect(endpointFingerprint('http://localhost:1234')).toBe(
      endpointFingerprint('http://localhost:1234/v1')
    )
  })

  it('changes when the host, port or scheme changes', () => {
    const local = endpointFingerprint('http://localhost:1234/v1')
    expect(endpointFingerprint('http://localhost:4321/v1')).not.toBe(local)
    expect(endpointFingerprint('http://other-host:1234/v1')).not.toBe(local)
    expect(endpointFingerprint('https://localhost:1234/v1')).not.toBe(local)
  })

  it('is empty for an unset or unparseable URL', () => {
    expect(endpointFingerprint(undefined)).toBe('')
    expect(endpointFingerprint('nonsense')).toBe('')
  })
})
