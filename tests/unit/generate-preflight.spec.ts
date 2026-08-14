/**
 * tests/unit/generate-preflight.spec.ts — the Generate pre-flight config
 * (FEAT-n762y6).
 *
 * "Auto Generate Clips" was a single button with NO configuration surface. Two
 * PRD §6.3 acceptance criteria were therefore unreachable: the clip-style
 * presets had no picker anywhere (`clipStyle` was pinned to `'all'`), and
 * "regenerate with a different prompt/style" had no affordance. There was also
 * no way to analyse only part of a long source — a 3-hour stream had to be sent
 * whole, on a key the user pays for.
 *
 * The properties pinned here are the ones a UI change could quietly break:
 *
 *  - EVERY field is defaulted, so the primary button is pressable on open. This
 *    is the whole design rule; a config that can be incomplete is a form.
 *  - The range SLICE is what makes the feature save money. If it stopped
 *    slicing, the panel would still look like it worked.
 *  - Clamps hold at the dialog boundary as well as at the runner's, and a
 *    `max < min` asks for a set that cannot exist.
 */

import { describe, expect, it } from 'vitest'
import {
  CLIP_LENGTH_PRESETS,
  CLIP_STYLE_OPTIONS,
  MAX_CLIPS,
  MAX_CUSTOM_PROMPT_LENGTH,
  MAX_KEYWORDS,
  applyLengthPreset,
  captionTemplateForStyle,
  clampRange,
  defaultPreflight,
  normalizePreflight,
  parseKeywords,
  preflightSummary,
  preflightToProjectSettings,
  presetIdForBounds,
  rangeCoversAll,
  sliceSegmentsToRange,
  type PreflightConfig
} from '@shared/generate-preflight'
import { buildGenerateClipsRequest } from '@renderer/components/generateClips'
import { projectFixture, settingsFixture } from '../fixtures/contract'
import { ClipStyle, type Project, type TranscriptSegment } from '@shared/schema'

const seg = (start: number, end: number, text = 'x'): TranscriptSegment => ({
  id: `s${start}`,
  start,
  end,
  text,
  confidence: 0.9
})

function project(over: Partial<Project['settings']> = {}, duration = 600): Project {
  return {
    ...projectFixture,
    sourceVideo: { ...projectFixture.sourceVideo, duration },
    settings: { ...projectFixture.settings, ...over }
  }
}

const base = (over: Partial<PreflightConfig> = {}): PreflightConfig => ({
  numClips: 5,
  lengthPreset: 'auto',
  minDuration: 15,
  maxDuration: 90,
  clipStyle: 'all',
  keywords: [],
  customPrompt: '',
  range: null,
  ...over
})

describe('defaultPreflight: nothing is mandatory', () => {
  it('fills every field from what the app already knows', () => {
    const cfg = defaultPreflight(project(), settingsFixture)
    // The design rule: the panel opens submittable. A single undefined here
    // would make the primary button conditional on the user filling something.
    for (const key of [
      'numClips',
      'lengthPreset',
      'minDuration',
      'maxDuration',
      'clipStyle',
      'keywords',
      'customPrompt'
    ] as const) {
      expect(cfg[key], key).toBeDefined()
    }
    // range is the one deliberate null: "the whole video" is the default.
    expect(cfg.range).toBeNull()
  })

  it('takes bounds and style from the PROJECT, count from app Settings', () => {
    const cfg = defaultPreflight(
      project({ clipStyle: 'funny', minDuration: 30, maxDuration: 60 }),
      { ...settingsFixture, maxClips: 8 }
    )
    expect(cfg.clipStyle).toBe('funny')
    expect(cfg.minDuration).toBe(30)
    expect(cfg.maxDuration).toBe(60)
    expect(cfg.numClips).toBe(8)
  })

  it('restores the last run — this is what makes Regenerate pre-filled', () => {
    const cfg = defaultPreflight(
      project({
        clipStyle: 'educational',
        generateKeywords: ['pricing', 'hiring'],
        generatePrompt: 'the parts about remote work',
        generateRange: { start: 60, end: 300 }
      } as Partial<Project['settings']>),
      settingsFixture
    )
    expect(cfg.keywords).toEqual(['pricing', 'hiring'])
    expect(cfg.customPrompt).toBe('the parts about remote work')
    expect(cfg.range).toEqual({ start: 60, end: 300 })
  })

  it('survives a hand-edited or older .ocproj with junk in those keys', () => {
    // ProjectSettings is a looseObject, so these round-trip as `unknown` and a
    // file from any source can hold anything. A throw here is a project that
    // cannot be opened at all.
    const cfg = defaultPreflight(
      project({
        generateKeywords: ['ok', 42, null],
        generatePrompt: { not: 'a string' },
        generateRange: 'nope'
      } as unknown as Partial<Project['settings']>),
      settingsFixture
    )
    expect(cfg.keywords).toEqual(['ok'])
    expect(cfg.customPrompt).toBe('')
    expect(cfg.range).toBeNull()
  })
})

describe('length presets', () => {
  it('exposes Auto plus OpusClip’s three buckets', () => {
    expect(CLIP_LENGTH_PRESETS.map((p) => p.id)).toEqual(['auto', 'short', 'medium', 'long'])
  })

  it('never proposes a sub-5-second clip, whatever the label says', () => {
    // A 0-second "clip" is not short-form video, it is a mis-read timestamp —
    // and the floor is the only thing between the user and exporting one.
    for (const preset of CLIP_LENGTH_PRESETS) {
      expect(preset.minDuration, preset.id).toBeGreaterThanOrEqual(5)
      expect(preset.maxDuration, preset.id).toBeGreaterThan(preset.minDuration)
    }
  })

  it('applyLengthPreset carries the bucket’s bounds', () => {
    const cfg = applyLengthPreset(base(), 'medium')
    expect(cfg).toMatchObject({ lengthPreset: 'medium', minDuration: 30, maxDuration: 60 })
  })

  it('reports CUSTOM for bounds matching no bucket', () => {
    // Snapping 20-70 to the nearest preset would silently rewrite the user's
    // own configuration the first time they opened the panel.
    expect(presetIdForBounds(20, 70)).toBe('custom')
    expect(presetIdForBounds(15, 90)).toBe('auto')
    expect(presetIdForBounds(60, 90)).toBe('long')
  })
})

describe('style presets', () => {
  it('offers a picker entry for every ClipStyle the schema allows', () => {
    // The gap this ticket exists for: six of these had no UI at all.
    expect(CLIP_STYLE_OPTIONS.map((o) => o.id).sort()).toEqual([...ClipStyle.options].sort())
  })

  it('nudges a caption template per style (one decision, coordinated effects)', () => {
    expect(captionTemplateForStyle('motivational')).toBe('hormozi')
    expect(captionTemplateForStyle('all')).toBe('default')
    for (const opt of CLIP_STYLE_OPTIONS) {
      expect(opt.captionTemplateId, opt.id).toBeTruthy()
      expect(opt.hint.length, opt.id).toBeGreaterThan(10)
    }
  })
})

describe('parseKeywords', () => {
  it('splits on commas AND newlines, trimming', () => {
    expect(parseKeywords('pricing, hiring\nburnout')).toEqual(['pricing', 'hiring', 'burnout'])
  })

  it('de-duplicates case-insensitively but keeps the first spelling', () => {
    // Echoing the user's own casing back is what makes the chips read as theirs.
    expect(parseKeywords('Pricing, pricing, PRICING')).toEqual(['Pricing'])
  })

  it('drops empties and caps the list', () => {
    expect(parseKeywords(' , ,, ')).toEqual([])
    const many = parseKeywords(
      Array.from({ length: MAX_KEYWORDS + 10 }, (_, i) => `kw${i}`).join(',')
    )
    expect(many).toHaveLength(MAX_KEYWORDS)
  })
})

describe('clampRange / rangeCoversAll', () => {
  it('clamps into [0, duration]', () => {
    expect(clampRange({ start: -50, end: 9999 }, 600)).toEqual({ start: 0, end: 600 })
  })

  it('rejects an inverted or sub-second range rather than sending nonsense', () => {
    expect(clampRange({ start: 300, end: 100 }, 600)).toBeNull()
    expect(clampRange({ start: 100, end: 100.5 }, 600)).toBeNull()
  })

  it('recognises a full-coverage range', () => {
    expect(rangeCoversAll(null, 600)).toBe(true)
    expect(rangeCoversAll({ start: 0, end: 600 }, 600)).toBe(true)
    expect(rangeCoversAll({ start: 10, end: 600 }, 600)).toBe(false)
  })
})

describe('normalizePreflight: the dialog clamps too, not only the runner', () => {
  it('clamps the clip count to 1..MAX_CLIPS', () => {
    expect(normalizePreflight(base({ numClips: 0 }), 600).numClips).toBe(1)
    expect(normalizePreflight(base({ numClips: 9999 }), 600).numClips).toBe(MAX_CLIPS)
    expect(normalizePreflight(base({ numClips: 4.7 }), 600).numClips).toBe(4)
  })

  it('widens a max below the min instead of asking for an impossible set', () => {
    const cfg = normalizePreflight(base({ minDuration: 60, maxDuration: 20 }), 600)
    expect(cfg.maxDuration).toBe(60)
  })

  it('truncates an over-long custom prompt', () => {
    const cfg = normalizePreflight(base({ customPrompt: 'x'.repeat(9999) }), 600)
    expect(cfg.customPrompt).toHaveLength(MAX_CUSTOM_PROMPT_LENGTH)
  })

  it('drops a full-coverage range so it matches a plain whole-video run', () => {
    // Otherwise "analyse everything" would miss the cache against an identical
    // earlier run that simply never opened the panel.
    expect(normalizePreflight(base({ range: { start: 0, end: 600 } }), 600).range).toBeNull()
    expect(normalizePreflight(base({ range: { start: 60, end: 300 } }), 600).range).toEqual({
      start: 60,
      end: 300
    })
  })
})

describe('sliceSegmentsToRange: the part that actually saves the money', () => {
  const SEGMENTS = [seg(0, 10, 'a'), seg(10, 20, 'b'), seg(55, 65, 'c'), seg(100, 110, 'd')]

  it('returns everything untouched when there is no range', () => {
    expect(sliceSegmentsToRange(SEGMENTS, null)).toBe(SEGMENTS)
  })

  it('keeps only the segments overlapping the window, straddlers included', () => {
    // A segment straddling the start is speech inside the chosen window; dropping
    // it would hand the model a transcript that begins mid-sentence.
    expect(sliceSegmentsToRange(SEGMENTS, { start: 60, end: 105 }).map((s) => s.text)).toEqual([
      'c',
      'd'
    ])
  })

  it('excludes a segment that merely touches the boundary', () => {
    expect(sliceSegmentsToRange([seg(0, 60, 'a')], { start: 60, end: 100 })).toEqual([])
  })
})

describe('preflightToProjectSettings: what Regenerate reads back', () => {
  it('round-trips through defaultPreflight', () => {
    const cfg = normalizePreflight(
      base({
        clipStyle: 'storytelling',
        minDuration: 30,
        maxDuration: 60,
        keywords: ['pricing'],
        customPrompt: 'find the pricing debate',
        range: { start: 60, end: 300 }
      }),
      600
    )
    const restored = defaultPreflight(
      project(preflightToProjectSettings(cfg) as Partial<Project['settings']>),
      settingsFixture
    )
    expect(restored.clipStyle).toBe('storytelling')
    expect(restored.minDuration).toBe(30)
    expect(restored.maxDuration).toBe(60)
    expect(restored.keywords).toEqual(['pricing'])
    expect(restored.customPrompt).toBe('find the pricing debate')
    expect(restored.range).toEqual({ start: 60, end: 300 })
    // …and the bucket is recovered, so the right button is lit on reopen.
    expect(restored.lengthPreset).toBe('medium')
  })
})

describe('preflightSummary: what the panel promises', () => {
  it('names the count, the bounds and the style', () => {
    expect(preflightSummary(base({ numClips: 3, clipStyle: 'funny' }), 600)).toBe(
      '3 clips · 15–90s · funny'
    )
  })

  it('singularises one clip', () => {
    expect(preflightSummary(base({ numClips: 1 }), 600)).toContain('1 clip ·')
  })

  it('mentions the window, the keywords and the prompt when set', () => {
    const s = preflightSummary(
      base({ range: { start: 65, end: 3725 }, keywords: ['a'], customPrompt: 'x' }),
      7200
    )
    expect(s).toContain('1:05–1:02:05')
    expect(s).toContain('1 keyword(s)')
    expect(s).toContain('custom prompt')
  })
})

describe('buildGenerateClipsRequest: the panel reaches the wire', () => {
  const PROJECT = {
    ...project({}, 600),
    transcript: {
      language: 'en',
      segments: [seg(0, 10, 'a'), seg(100, 110, 'b'), seg(300, 310, 'c')],
      words: []
    }
  }

  it('reproduces the pre-panel behaviour exactly when no config is passed', () => {
    const req = buildGenerateClipsRequest(PROJECT, settingsFixture)
    expect(req.segments).toHaveLength(3)
    expect(req.clipStyle).toBe(PROJECT.settings.clipStyle)
    // Absent, not empty — an untargeted run must produce the request (and so the
    // cache key) it always did.
    expect(req.range).toBeUndefined()
    expect(req.keywords).toBeUndefined()
    expect(req.customPrompt).toBeUndefined()
  })

  it('SLICES the segments to the window before they leave the machine', () => {
    const req = buildGenerateClipsRequest(
      PROJECT,
      settingsFixture,
      base({ range: { start: 90, end: 200 } })
    )
    // The whole point: the other two segments are never sent, so the user is not
    // billed for the parts of the video they did not ask about.
    expect(req.segments.map((s) => s.text)).toEqual(['b'])
    expect(req.range).toEqual({ start: 90, end: 200 })
  })

  it('carries style, count, bounds and targeting', () => {
    const req = buildGenerateClipsRequest(
      PROJECT,
      settingsFixture,
      base({
        clipStyle: 'controversial',
        numClips: 7,
        minDuration: 30,
        maxDuration: 60,
        keywords: ['pricing'],
        customPrompt: 'the disagreement'
      })
    )
    expect(req).toMatchObject({
      clipStyle: 'controversial',
      numClips: 7,
      minDuration: 30,
      maxDuration: 60,
      keywords: ['pricing'],
      customPrompt: 'the disagreement'
    })
  })

  it('normalizes on the way out, so a bad panel value cannot reach the provider', () => {
    const req = buildGenerateClipsRequest(PROJECT, settingsFixture, base({ numClips: 9999 }))
    expect(req.numClips).toBe(MAX_CLIPS)
  })
})
