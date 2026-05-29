/**
 * tests/fixtures/contract/index.ts — canonical, schema-VALID instances of every
 * frozen contract shape (plan E.7 drift detection: "one per Clip /
 * TranscriptSegment[] / Project / each JobEvent incl. per-kind partials").
 *
 * `contract.spec.ts` re-validates each of these against the live Zod schemas in
 * `@shared/schema`; the mock bridge (`tests/mocks/openclip.ts`) returns these
 * canned values. Authored once in the trunk; re-pulled at `contracts-v1` for
 * the media-derived (provisional) shapes.
 */

import type {
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
import type {
  JobEvent,
  JobEventFor,
  JobResult,
  JobPartial,
  ApiKeyStatus,
  ModelStatus
} from '@shared'

// ── Source video ────────────────────────────────────────────────────────────
export const sourceVideoFixture: SourceVideo = {
  path: '/tmp/openclip/sample.mp4',
  duration: 240,
  resolution: { width: 1920, height: 1080 },
  fps: 30,
  format: 'mp4'
}

// ── Word / segment / transcript (FINALIZED at contracts-v1 — Stage-4 smoke) ───
export const wordTimestampFixture: WordTimestamp = {
  word: 'hello',
  start: 1.2,
  end: 1.45,
  confidence: 0.98
}

export const transcriptSegmentsFixture: TranscriptSegment[] = [
  { id: 'seg-1', start: 0, end: 3.2, text: 'Welcome to the show.', confidence: 0.97 },
  { id: 'seg-2', start: 3.2, end: 7.8, text: 'Today we discuss something wild.', confidence: 0.95 }
]

export const transcriptFixture: Transcript = {
  language: 'en',
  segments: transcriptSegmentsFixture,
  words: [
    { word: 'Welcome', start: 0, end: 0.5, confidence: 0.99 },
    { word: 'to', start: 0.5, end: 0.7, confidence: 0.99 },
    { word: 'the', start: 0.7, end: 0.9, confidence: 0.98 },
    { word: 'show.', start: 0.9, end: 1.4, confidence: 0.97 }
  ]
}

// ── Caption / style ──────────────────────────────────────────────────────────
export const captionStyleFixture: CaptionStyle = {
  fontFamily: 'Inter',
  fontSize: 48,
  fontColor: '#FFFFFF',
  backgroundColor: '#000000',
  position: 'bottom',
  animation: 'pop',
  highlightCurrentWord: true,
  emojiEnabled: false
}

export const captionFixture: Caption = {
  start: 0,
  end: 3.2,
  text: 'Welcome to the show.',
  words: transcriptFixture.words,
  style: captionStyleFixture
}

// ── Clip ─────────────────────────────────────────────────────────────────────
export const clipFixture: Clip = {
  id: 'clip-1',
  startTime: 12.5,
  endTime: 41.0,
  title: 'The wildest take of the year',
  hook: 'You will not believe what was said next.',
  viralityScore: 9,
  clipType: 'hook',
  keywords: ['wild', 'take', 'hot'],
  status: 'suggested',
  editedStart: 13.0,
  editedEnd: 40.0,
  captions: [captionFixture],
  thumbnailPath: '/tmp/openclip/thumb-1.jpg'
}

export const clipsFixture: Clip[] = [clipFixture]

// ── Export record ────────────────────────────────────────────────────────────
export const exportRecordFixture: ExportRecord = {
  id: 'exp-1',
  clipId: 'clip-1',
  outputPath: '/Users/me/Movies/clip-1.mp4',
  exportedAt: 1_716_900_000_000,
  width: 1080,
  height: 1920,
  format: 'mp4'
}

// ── Project (top-level .ocproj) ──────────────────────────────────────────────
export const projectFixture: Project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Demo Podcast Ep. 1',
  createdAt: 1_716_800_000_000,
  updatedAt: 1_716_900_000_000,
  sourceVideo: sourceVideoFixture,
  transcript: transcriptFixture,
  clips: clipsFixture,
  settings: {
    targetPlatform: 'tiktok',
    aspectRatio: '9:16',
    clipStyle: 'all',
    maxClips: 5,
    minDuration: 15,
    maxDuration: 90
  },
  exportHistory: [exportRecordFixture]
}

// ── App-global Settings ──────────────────────────────────────────────────────
export const settingsFixture: Settings = {
  aiProvider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: undefined,
  whisperModel: 'base',
  language: undefined,
  aspectRatio: '9:16',
  maxClips: 5,
  minDuration: 15,
  maxDuration: 90,
  forceCpu: false,
  telemetryOptIn: false
}

// ── AI ClipSchema (LLM structured output) ────────────────────────────────────
export const clipSchemaFixture: ClipSchema = {
  clips: [
    {
      start_time: 12.5,
      end_time: 41.0,
      title: 'The wildest take of the year',
      hook: 'You will not believe what was said next.',
      virality_score: 9,
      clip_type: 'hook',
      keywords: ['wild', 'take'],
      suggested_caption: 'This take broke the internet',
      hashtags: ['#viral', '#hottake']
    }
  ],
  analysis: {
    total_duration: 240,
    clips_found: 1,
    best_clip_index: 0,
    overall_virality_potential: 'high'
  }
}

// ── Control-plane status shapes ──────────────────────────────────────────────
export const apiKeyStatusFixture: ApiKeyStatus = {
  provider: 'openai',
  hasKey: true,
  last4: 'ab12'
}

export const modelStatusFixture: ModelStatus[] = [
  {
    model: 'base',
    installed: true,
    path: '/Users/me/.../models/ggml-base.bin',
    bytes: 147_000_000
  },
  { model: 'small', installed: false }
]

// ── JobEvents — one per variant, plus per-kind result/partial ─────────────────
export const jobEventProgressFixture: JobEvent = { t: 'progress', pct: 42, stage: 'transcribing' }
export const jobEventDoneFixture: JobEvent = { t: 'done', result: { ok: true } }
export const jobEventErrorFixture: JobEvent = {
  t: 'error',
  code: 'CANCELLED',
  message: 'job cancelled',
  retriable: false
}

export const transcribeResultFixture: JobResult['transcribe'] = {
  language: 'en',
  segments: transcriptSegmentsFixture,
  words: transcriptFixture.words
}
export const exportResultFixture: JobResult['export'] = {
  outputPath: '/Users/me/Movies/clip-1.mp4',
  width: 1080,
  height: 1920,
  durationMs: 28_500
}
export const modelDownloadResultFixture: JobResult['model-download'] = {
  model: 'base',
  path: '/Users/me/.../models/ggml-base.bin',
  bytes: 147_000_000
}

export const transcribePartialFixture: JobPartial['transcribe'] = {
  // Finalized at contracts-v1: per-word stream + any sentence that just closed.
  words: transcriptFixture.words,
  segments: [transcriptSegmentsFixture[0]]
}
export const modelDownloadPartialFixture: JobPartial['model-download'] = {
  receivedBytes: 50_000_000,
  totalBytes: 147_000_000
}

/** A typed per-kind transcribe done event (incl. provisional partial above). */
export const transcribeDoneFixture: JobEventFor<'transcribe'> = {
  t: 'done',
  result: transcribeResultFixture
}
