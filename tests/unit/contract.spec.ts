/**
 * tests/unit/contract.spec.ts — repo-wide contract drift detection (plan E.7
 * #3): every canonical fixture is re-validated against the LIVE Zod schemas in
 * `@shared/schema`. If a frozen schema and its fixture drift, this fails.
 */

import { describe, expect, it } from 'vitest'
import {
  WordTimestamp,
  TranscriptSegment,
  Transcript,
  Caption,
  CaptionStyle,
  Clip,
  Project,
  Settings,
  ClipSchema,
  SourceVideo,
  ExportRecord,
  BrandTemplate,
  GenerateTitlesResultSchema,
  EnhanceCaptionsResultSchema
} from '@shared/schema'
import {
  wordTimestampFixture,
  transcriptSegmentsFixture,
  transcriptFixture,
  captionFixture,
  captionStyleFixture,
  clipFixture,
  projectFixture,
  settingsFixture,
  customEndpointSettingsFixture,
  clipSchemaFixture,
  sourceVideoFixture,
  exportRecordFixture,
  captionStyleRichFixture,
  brandTemplateFixture,
  projectWithBrandFixture
} from '../fixtures/contract'

describe('contract fixtures validate against the frozen Zod schemas', () => {
  it('WordTimestamp', () => {
    expect(WordTimestamp.parse(wordTimestampFixture)).toEqual(wordTimestampFixture)
  })

  it('TranscriptSegment[]', () => {
    for (const seg of transcriptSegmentsFixture) {
      expect(TranscriptSegment.parse(seg)).toEqual(seg)
    }
  })

  it('Transcript', () => {
    expect(Transcript.parse(transcriptFixture)).toEqual(transcriptFixture)
  })

  it('CaptionStyle + Caption', () => {
    expect(CaptionStyle.parse(captionStyleFixture)).toEqual(captionStyleFixture)
    expect(Caption.parse(captionFixture)).toEqual(captionFixture)
  })

  it('Clip (with editedStart/editedEnd)', () => {
    expect(Clip.parse(clipFixture)).toEqual(clipFixture)
    expect(clipFixture.editedStart).toBeTypeOf('number')
    expect(clipFixture.editedEnd).toBeTypeOf('number')
  })

  it('SourceVideo + ExportRecord', () => {
    expect(SourceVideo.parse(sourceVideoFixture)).toEqual(sourceVideoFixture)
    expect(ExportRecord.parse(exportRecordFixture)).toEqual(exportRecordFixture)
  })

  it('Project (top-level .ocproj)', () => {
    expect(Project.parse(projectFixture)).toEqual(projectFixture)
  })

  it('Settings', () => {
    expect(Settings.parse(settingsFixture)).toEqual(settingsFixture)
  })

  it('Settings with a custom endpoint (exercises the baseUrl refine)', () => {
    expect(Settings.parse(customEndpointSettingsFixture)).toEqual(customEndpointSettingsFixture)
    // …and the refine is live, not decorative.
    expect(
      Settings.safeParse({ ...customEndpointSettingsFixture, baseUrl: 'javascript:alert(1)' })
        .success
    ).toBe(false)
  })

  it('AI ClipSchema (strict — additionalProperties:false)', () => {
    expect(ClipSchema.parse(clipSchemaFixture)).toEqual(clipSchemaFixture)
  })

  it('ClipSchema rejects extra properties (strictObject)', () => {
    const bad = {
      ...clipSchemaFixture,
      clips: [{ ...clipSchemaFixture.clips[0], unexpected_field: true }]
    }
    expect(ClipSchema.safeParse(bad).success).toBe(false)
  })

  // ── AI title/caption generation outputs (openclip-xgk) — strictObject like ClipSchema ──
  it('GenerateTitlesResultSchema parses valid options and rejects extra props', () => {
    const ok = {
      options: [{ title: 'A bold claim', hook: 'You wont believe', psychology: 'curiosity gap' }]
    }
    expect(GenerateTitlesResultSchema.parse(ok)).toEqual(ok)
    expect(
      GenerateTitlesResultSchema.safeParse({
        options: [{ ...ok.options[0], extra: 1 }]
      }).success
    ).toBe(false)
  })

  it('EnhanceCaptionsResultSchema parses rewrite + emoji shapes and rejects extra props', () => {
    const rewrite = {
      enhanced_captions: [{ start_time: 0, end_time: 1.5, text: 'Hello there' }]
    }
    expect(EnhanceCaptionsResultSchema.parse(rewrite)).toEqual(rewrite)
    const withEmoji = { ...rewrite, emoji_map: { fire: '🔥', love: '❤️' } }
    expect(EnhanceCaptionsResultSchema.parse(withEmoji)).toEqual(withEmoji)
    expect(
      EnhanceCaptionsResultSchema.safeParse({
        enhanced_captions: [{ start_time: 0, end_time: 1, text: 'x', extra: true }]
      }).success
    ).toBe(false)
  })

  // ── Part K (caption template gallery + brand kit) — additive-optional fields ──
  it('CaptionStyle accepts the Part-K optional fields (keyword/emoji/per-word)', () => {
    expect(CaptionStyle.parse(captionStyleRichFixture)).toEqual(captionStyleRichFixture)
  })

  it('BrandTemplate (with logo placement + brand caption style)', () => {
    expect(BrandTemplate.parse(brandTemplateFixture)).toEqual(brandTemplateFixture)
  })

  it('Project validates WITH the Part-K fields (brand + captionTemplateId)', () => {
    expect(Project.parse(projectWithBrandFixture)).toEqual(projectWithBrandFixture)
  })

  it('back-compat: a pre-Part-K Project (no brand / no captionTemplateId) still validates', () => {
    const parsed = Project.parse(projectFixture)
    expect(parsed).toEqual(projectFixture)
    expect(parsed.activeBrandId).toBeUndefined()
    expect(parsed.brandTemplate).toBeUndefined()
    expect(parsed.settings.captionTemplateId).toBeUndefined()
    // and a pre-Part-K CaptionStyle (no keyword/emoji fields) is unchanged
    expect(CaptionStyle.parse(captionStyleFixture)).toEqual(captionStyleFixture)
  })
})

// ── Onboarding contract additions (EPIC-xzzpty) ──────────────────────────────
// These three channels back the first-run experience: a readiness probe, a
// pre-flight "does this key/model actually work" check, and reclaiming model
// disk. They are asserted here because the preload bridge and the test mock are
// both DERIVED from ChannelMap — adding a channel silently widens the public
// surface, so the contract test is the place that must notice.
describe('first-run onboarding channels are on the frozen contract', () => {
  it('declares the three new channels', async () => {
    const { IPCChannels } = await import('@shared/channels')
    expect(IPCChannels.SYSTEM_PREFLIGHT).toBe('system:preflight')
    expect(IPCChannels.AI_TEST_CONNECTION).toBe('ai:test-connection')
    expect(IPCChannels.MODEL_DELETE).toBe('model:delete')
  })

  it('derives them onto the preload bridge as camelCased methods', async () => {
    const { buildSystemApi } = await import('@preload/api/system')
    const { buildAiApi } = await import('@preload/api/ai')
    const { buildModelApi } = await import('@preload/api/model')
    expect(typeof buildSystemApi().preflight).toBe('function')
    expect(typeof buildAiApi().testConnection).toBe('function')
    expect(typeof buildModelApi().delete).toBe('function')
  })
})
