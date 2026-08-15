/**
 * tests/unit/ai-providers-meta.spec.ts — per-provider FACTS about where to
 * get a key and roughly what it costs (EPIC-k83ghw / FEAT-rmgkee), shown in
 * the Settings AI tab. Distinct from ai-providers.spec.ts, which covers the
 * structured-output TRANSPORT adapters.
 */

import { describe, expect, it } from 'vitest'
import { providerKeyUrl, providerCostHint } from '@shared/ai-providers'
import { AIProvider } from '@shared/schema'

describe('providerKeyUrl', () => {
  it('points each keyed provider at its real key-management page', () => {
    expect(providerKeyUrl('openai')).toBe('https://platform.openai.com/api-keys')
    expect(providerKeyUrl('anthropic')).toBe('https://console.anthropic.com/settings/keys')
    expect(providerKeyUrl('openrouter')).toBe('https://openrouter.ai/keys')
  })

  it('is undefined for ollama (no key at all) and custom (no ONE page to send someone to)', () => {
    expect(providerKeyUrl('ollama')).toBeUndefined()
    expect(providerKeyUrl('custom')).toBeUndefined()
  })

  it('every URL is a plain https link, safe to render as an external anchor', () => {
    for (const provider of AIProvider.options) {
      const url = providerKeyUrl(provider)
      if (url) expect(url).toMatch(/^https:\/\//)
    }
  })
})

describe('providerCostHint', () => {
  it('gives every KEYED provider a hint — the AC1 gap this ticket closes', () => {
    for (const provider of ['openai', 'anthropic', 'google', 'openrouter'] as const) {
      expect(providerCostHint(provider)).toBeTruthy()
    }
  })

  it('says nothing for ollama (free) — the cost hint is not the right place for that message', () => {
    expect(providerCostHint('ollama')).toBeUndefined()
  })

  it('never states an exact dollar figure — a hedged, qualitative hint that will not go stale', () => {
    for (const provider of AIProvider.options) {
      const hint = providerCostHint(provider)
      if (hint) expect(hint).not.toMatch(/\$\d/)
    }
  })
})
