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
  ExportRecord
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
  clipSchemaFixture,
  sourceVideoFixture,
  exportRecordFixture
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
})
