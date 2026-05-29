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
import {
  formatTimecode,
  clipViewModel,
  sortClipsForSidebar,
  type ClipViewModel
} from '@renderer/components/clipView'
import { providerLabel, keyStatusLabel } from '@renderer/components/settingsView'
import { clipsFixture } from '../fixtures/contract'
import type { Clip } from '@shared/schema'

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
})

describe('sortClipsForSidebar', () => {
  const mk = (id: string, score: number): Clip => ({
    ...clipsFixture[0],
    id,
    viralityScore: score
  })

  it('orders by virality score descending', () => {
    const vms: ClipViewModel[] = sortClipsForSidebar([mk('a', 3), mk('b', 9), mk('c', 6)])
    expect(vms.map((v) => v.id)).toEqual(['b', 'c', 'a'])
  })

  it('returns an empty array for no clips', () => {
    expect(sortClipsForSidebar([])).toEqual([])
  })
})

describe('SettingsPanel presentation helpers', () => {
  it('labels each provider', () => {
    expect(providerLabel('openai')).toBe('OpenAI')
    expect(providerLabel('anthropic')).toBe('Anthropic')
    expect(providerLabel('google')).toBe('Google Gemini')
    expect(providerLabel('ollama')).toBe('Ollama (local)')
  })

  it('summarizes key status without ever exposing the key', () => {
    expect(keyStatusLabel({ provider: 'openai', hasKey: false })).toBe('No key set')
    expect(keyStatusLabel({ provider: 'openai', hasKey: true, last4: 'ABCD' })).toBe(
      'Key set ••••ABCD'
    )
  })
})
