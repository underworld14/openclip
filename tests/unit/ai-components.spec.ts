/**
 * tests/unit/ai-components.spec.ts — pure presentational helpers used by the
 * ClipCard / ClipSidebar / SettingsPanel components (T-AI, plan E.3).
 *
 * The vitest env is `node` (no jsdom), so we test the LOAD-BEARING pure logic
 * the components render from — timecode formatting, the clip view-model, sidebar
 * sorting, and the provider/key-status presentation — rather than DOM output.
 * The components themselves are thin wrappers over these (and over the stores,
 * covered in ai-stores.spec.ts). This keeps the rendering logic unit-tested
 * without pulling in a DOM renderer.
 */

import { describe, expect, it } from 'vitest'
import { formatTimecode, clipViewModel, sortClipsForSidebar } from '@renderer/components/clipView'
import {
  providerLabel,
  keyStatusLabel,
  PROVIDERS,
  filterModels,
  partitionRecommended,
  formatModelPrice,
  LANGUAGES,
  languageLabel,
  resolveDefaultModel
} from '@renderer/components/settingsView'
import { clipsFixture } from '../fixtures/contract'
import type { Clip } from '@shared/schema'
import type { ModelInfo } from '@shared/channels'

describe('formatTimecode', () => {
  it('formats seconds as M:SS', () => {
    expect(formatTimecode(0)).toBe('0:00')
    expect(formatTimecode(5)).toBe('0:05')
    expect(formatTimecode(75)).toBe('1:15')
    expect(formatTimecode(3661)).toBe('61:01')
  })
})

describe('clipViewModel (drives ClipCard rendering)', () => {
  it('derives title, score, and the displayed time range', () => {
    const vm = clipViewModel(clipsFixture[0])
    expect(vm.title).toBe('The wildest take of the year')
    expect(vm.score).toBe(9)
    // editedStart/editedEnd override startTime/endTime in the displayed range
    expect(vm.range).toBe('0:13 – 0:40')
  })

  it('falls back to startTime/endTime when no edits exist', () => {
    const clip: Clip = { ...clipsFixture[0], editedStart: undefined, editedEnd: undefined }
    const vm = clipViewModel(clip)
    expect(vm.range).toBe('0:12 – 0:41')
  })

  it('exposes approve/reject affordances based on status', () => {
    const suggested = clipViewModel({ ...clipsFixture[0], status: 'suggested' })
    expect(suggested.canApprove).toBe(true)
    expect(suggested.canReject).toBe(true)
    const approved = clipViewModel({ ...clipsFixture[0], status: 'approved' })
    expect(approved.isApproved).toBe(true)
  })

  it('exposes the 4-D virality total + bars + hook type when present (Part I)', () => {
    const vm = clipViewModel(clipsFixture[0]) // fixture: total 90, hookType statement
    expect(vm.viralityTotal).toBe(90)
    expect(vm.hookType).toBe('statement')
    expect(vm.viralityBars?.map((b) => b.label)).toEqual(['Hook', 'Engage', 'Value', 'Share'])
    expect(vm.viralityBars?.[0]).toMatchObject({ score: 24, ratio: 24 / 25 })
  })

  it('omits the breakdown for an old clip with no virality field', () => {
    const old: Clip = { ...clipsFixture[0], virality: undefined, hookType: undefined }
    const vm = clipViewModel(old)
    expect(vm.viralityTotal).toBeUndefined()
    expect(vm.viralityBars).toBeUndefined()
    expect(vm.score).toBe(9) // 1-10 headline still renders
  })
})

describe('sortClipsForSidebar', () => {
  const mk = (id: string, score: number): Clip => ({
    ...clipsFixture[0],
    id,
    viralityScore: score
  })

  it('orders clips by virality score descending (returns sorted Clip[], openclip-0hp/don)', () => {
    const sorted: Clip[] = sortClipsForSidebar([mk('a', 3), mk('b', 9), mk('c', 6)])
    expect(sorted.map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('returns an empty array for no clips', () => {
    expect(sortClipsForSidebar([])).toEqual([])
  })
})

describe('SettingsPanel presentation helpers', () => {
  it('labels each provider (incl. OpenRouter, Part H)', () => {
    expect(providerLabel('openai')).toBe('OpenAI')
    expect(providerLabel('anthropic')).toBe('Anthropic')
    expect(providerLabel('google')).toBe('Google Gemini')
    expect(providerLabel('ollama')).toBe('Ollama (local)')
    expect(providerLabel('openrouter')).toBe('OpenRouter')
    expect(PROVIDERS).toContain('openrouter')
  })

  it('summarizes key status without ever exposing the key', () => {
    expect(keyStatusLabel({ provider: 'openai', hasKey: false })).toBe('No key set')
    expect(keyStatusLabel({ provider: 'openai', hasKey: true, last4: 'ABCD' })).toBe(
      'Key set ••••ABCD'
    )
  })
})

describe('model-picker helpers (Part H — OpenRouter)', () => {
  const mk = (over: Partial<ModelInfo> & { id: string }): ModelInfo => ({
    name: over.id,
    supportsStructured: true,
    recommended: false,
    ...over
  })
  const models: ModelInfo[] = [
    mk({ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', recommended: true }),
    mk({ id: 'openai/gpt-5', name: 'GPT-5', recommended: true }),
    mk({ id: 'meta/llama', name: 'Llama', description: 'open weights' })
  ]

  it('filterModels matches id/name/description case-insensitively; empty → all', () => {
    expect(filterModels(models, '').length).toBe(3)
    expect(filterModels(models, 'claude').map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4.5'])
    expect(filterModels(models, 'GPT').map((m) => m.id)).toEqual(['openai/gpt-5'])
    expect(filterModels(models, 'open weights').map((m) => m.id)).toEqual(['meta/llama'])
  })

  it('partitionRecommended splits on the recommended flag, preserving order', () => {
    const { recommended, others } = partitionRecommended(models)
    expect(recommended.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-5'])
    expect(others.map((m) => m.id)).toEqual(['meta/llama'])
  })

  it('formatModelPrice formats both prices, Free for $0, blank when unknown', () => {
    expect(formatModelPrice(mk({ id: 'a', pricePerMTokIn: 3, pricePerMTokOut: 15 }))).toBe(
      '$3.00 / $15.00 per 1M'
    )
    expect(formatModelPrice(mk({ id: 'b', pricePerMTokIn: 0, pricePerMTokOut: 0 }))).toBe('Free')
    expect(formatModelPrice(mk({ id: 'c' }))).toBe('')
  })
})

describe('transcription language helpers (Part I — cross-language)', () => {
  it('LANGUAGES leads with Auto-detect (empty code) and includes Indonesian', () => {
    expect(LANGUAGES[0]).toEqual({ code: '', label: 'Auto-detect' })
    expect(LANGUAGES.find((l) => l.code === 'id')?.label).toBe('Indonesian')
  })

  it('languageLabel maps undefined/empty → Auto-detect, known → label, unknown → uppercased code', () => {
    expect(languageLabel(undefined)).toBe('Auto-detect')
    expect(languageLabel('')).toBe('Auto-detect')
    expect(languageLabel('  ')).toBe('Auto-detect')
    expect(languageLabel('id')).toBe('Indonesian')
    expect(languageLabel('en')).toBe('English')
    expect(languageLabel('sw')).toBe('SW') // unknown ISO code rendered verbatim, uppercased
  })
})

// ── Per-provider defaults + model resolution (FEAT-6v92dk) ──────────────────
describe('PROVIDERS no longer offers a dead end (FEAT-et1gxc)', () => {
  it('drops Google, which the transport hard-throws on', () => {
    expect(PROVIDERS).not.toContain('google')
    // `custom` is last on purpose: it is the advanced option (FEAT-bysdwg).
    expect(PROVIDERS).toEqual(['openai', 'anthropic', 'ollama', 'openrouter', 'custom'])
  })

  it('names every offered provider — an unnamed one would render blank', () => {
    for (const provider of PROVIDERS) expect(providerLabel(provider)).toBeTruthy()
    expect(providerLabel('custom')).toBe('Custom (OpenAI-compatible)')
  })
})

describe('resolveDefaultModel (FEAT-6v92dk)', () => {
  const models: ModelInfo[] = [
    { id: 'z-first', name: 'Z', supportsStructured: true, recommended: false },
    { id: 'rec-1', name: 'R1', supportsStructured: true, recommended: true },
    { id: 'claude-opus-5', name: 'Opus 5', supportsStructured: true, recommended: false }
  ]

  it('prefers the curated seed when the provider has one and the catalogue lists it', () => {
    expect(resolveDefaultModel('anthropic', models)).toBe('claude-opus-5')
  })

  it('IGNORES a seed the live catalogue does not list — the seed is a fallback, not an override', () => {
    // Otherwise a stale hardcoded id outlives the provider's own catalogue,
    // which is exactly the failure this module exists to avoid (BUG-2smqpv).
    const withoutSeed: ModelInfo[] = [
      { id: 'claude-haiku-4-5', name: 'Haiku', supportsStructured: true, recommended: true }
    ]
    expect(resolveDefaultModel('anthropic', withoutSeed)).toBe('claude-haiku-4-5')
  })

  it('falls back to the first RECOMMENDED entry when there is no curated seed', () => {
    expect(resolveDefaultModel('openrouter', models)).toBe('rec-1')
  })

  it('auto-picks NOTHING from an unranked catalogue rather than guessing', () => {
    // Picking `models[0]` off an alphabetically-sorted OpenAI catalogue selected
    // gpt-3.5-turbo, which cannot do strict json_schema — so readiness turned
    // GREEN in front of a guaranteed 400. An empty field is honest: the picker
    // is right there and readiness says "Choose a model in Settings."
    const plain: ModelInfo[] = [
      { id: 'gpt-3.5-turbo', name: 'a', supportsStructured: true, recommended: false },
      { id: 'gpt-5', name: 'b', supportsStructured: true, recommended: false }
    ]
    expect(resolveDefaultModel('openai', plain)).toBe('')
  })

  it('still returns the curated seed when the catalogue could not be fetched', () => {
    // A dead network must not leave the field empty — that is the whole bug.
    expect(resolveDefaultModel('anthropic', [])).toBe('claude-opus-5')
  })

  it('returns empty for a provider with no seed and no catalogue, rather than inventing an id', () => {
    expect(resolveDefaultModel('ollama', [])).toBe('')
  })
})
