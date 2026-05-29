/**
 * src/main/services/jobs/transcribe-runner.ts — the `transcribe` JobRunner
 * (T-Media, E.3). Registered with the sidecar via `registerRunner('transcribe',
 * …)` from `ipc/transcribe.ts` so `JOB_START('transcribe', …)` spawns whisper-cli
 * and streams progress + per-word/segment partials over the per-job MessagePort
 * (PRD §6.2 / §10.2).
 *
 * The runner is the thin glue between the frozen `JobRunner<'transcribe'>`
 * contract and the spawn service (`whisper-spawn.runWhisper`) + the model
 * presence check. It is built via a factory with INJECTED dependencies so it is
 * unit-testable without the real binary (PRD §18); `createTranscribeRunner()`
 * with no args uses the real services.
 *
 * Live partials (PRD §6.2 "searchable sidebar while it transcribes"): each word
 * decoded on stdout is emitted as a `partial` carrying only what is NEW since
 * the previous partial — the word, plus any sentence that just CLOSED on
 * terminal punctuation (the JobPartial['transcribe'] shape, finalized at
 * contracts-v1). The authoritative segment grouping + confidences come from the
 * terminal JSON parse in `runWhisper` (the `done` result).
 */

import type { TranscriptSegment, WordTimestamp } from '@shared/schema'
import type { JobResult, JobParams, WhisperModelSize } from '@shared/jobs'
import type { JobRunner, JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import { runWhisper, type RunWhisperOptions } from '@main/services/whisper-spawn'
import { groupSegments } from '@main/services/whisper-parse'
import type { ParsedTranscript } from '@main/services/whisper-parse'
import { modelFilePath } from '@main/utils/paths'
import { isModelInstalled as defaultIsModelInstalled } from '@main/services/model-manager'

// ============================================================================
// Injectable dependencies (real defaults; tests pass fakes)
// ============================================================================

export interface TranscribeRunnerDeps {
  /** Resolve the absolute ggml model path for a size. */
  resolveModelPath?: (model: string) => string
  /** Whether the model is present on disk (first-transcribe gate, PRD §13). */
  isModelInstalled?: (model: WhisperModelSize) => boolean
  /** The whisper spawn driver (injected for tests). */
  runWhisper?: (opts: RunWhisperOptions) => Promise<ParsedTranscript>
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Build the `transcribe` runner. Streams progress (0..100) and per-word partials
 * as whisper decodes, returning the parsed transcript as the `done` result. A
 * missing model throws (the manager maps it to a typed error — never a hang).
 */
export function createTranscribeRunner(deps: TranscribeRunnerDeps = {}): JobRunner<'transcribe'> {
  const resolveModelPath = deps.resolveModelPath ?? modelFilePath
  const isModelInstalled = deps.isModelInstalled ?? defaultIsModelInstalled
  const whisper = deps.runWhisper ?? runWhisper

  return async (
    params: JobParams['transcribe'],
    emit: JobEmitter<'transcribe'>,
    ctx: JobRunnerContext
  ): Promise<JobResult['transcribe']> => {
    if (!isModelInstalled(params.model)) {
      throw new Error(
        `whisper model "${params.model}" is not installed — download it first (PRD §13)`
      )
    }

    emit.progress(0, 'transcribing')

    // Live sentence buffer: accumulate decoded words; when one closes a sentence
    // (terminal punctuation), emit it as a `segment` partial and reset. Grouping
    // reuses the frozen `groupSegments` so live + final segments stay consistent.
    let openSentence: WordTimestamp[] = []
    let liveSegSeq = 0
    const closeSentenceIfDone = (word: WordTimestamp): TranscriptSegment[] => {
      openSentence.push(word)
      if (!isSentenceClosed(word.word)) return []
      const [closed] = groupSegments(openSentence) // exactly one (it just closed)
      openSentence = []
      return closed ? [{ ...closed, id: `seg-live-${liveSegSeq++}` }] : []
    }

    const parsed = await whisper({
      model: resolveModelPath(params.model),
      wavPath: params.wavPath,
      outBase: tempOutBase(ctx.jobId, params.wavPath),
      language: params.language,
      signal: ctx.signal,
      onSpawn: (pid) => ctx.trackPid(pid),
      onProgress: (pct) => emit.progress(pct, 'transcribing'),
      onWord: (word) => {
        const segments = closeSentenceIfDone(word)
        emit.partial({ words: [word], segments })
      }
    })

    emit.progress(100, 'transcribing')
    // An explicitly requested language is authoritative over whisper's detected/
    // omitted label (Part I): the user chose it AND it was passed as `-l`, so the
    // transcript is in that language regardless of what the JSON reports.
    const requested = params.language?.trim()
    const language = requested ? requested : parsed.language
    return { language, segments: parsed.segments, words: parsed.words }
  }
}

/** Whether a word's trimmed text ends a sentence (mirrors whisper-parse). */
function isSentenceClosed(word: string): boolean {
  return /[.!?…]["')\]]?$/.test(word.trim())
}

/**
 * Whisper writes `<base>.json` next to `<base>`. We co-locate the JSON with the
 * WAV (already inside the job's scratch dir per PRD §17) using the WAV path's
 * directory + the jobId, so the per-job `finally` sweep reclaims it.
 */
function tempOutBase(jobId: string, wavPath: string): string {
  const dir = wavPath.slice(0, Math.max(0, wavPath.lastIndexOf('/')))
  return `${dir || '.'}/transcribe-${jobId}`
}

// ============================================================================
// E2E fake-sidecar runner (plan E.10): when OPENCLIP_FAKE_TRANSCRIBE is set, the
// startup runner streams a FIXED transcript over the real job MessagePort
// without a whisper binary or installed model — the "fake-sidecar harness
// emitting a fixed transcript" the vertical-slice E2E drives. Unit tests use the
// pure factory directly and are unaffected.
// ============================================================================

const FIXED_TRANSCRIPT: JobResult['transcribe'] = {
  language: 'en',
  segments: [
    { id: 'seg-0', start: 0.05, end: 1.24, text: 'Hello world!', confidence: 0.7 },
    {
      id: 'seg-1',
      start: 1.24,
      end: 4.64,
      text: 'This is a test of the OpenClip transcription pipeline.',
      confidence: 0.8
    }
  ],
  words: [
    { word: 'Hello', start: 0.05, end: 0.47, confidence: 0.94 },
    { word: 'world!', start: 0.47, end: 1.24, confidence: 0.5 },
    { word: 'This', start: 1.24, end: 1.46, confidence: 0.9 }
  ]
}

/** A binary-free runner that streams `FIXED_TRANSCRIPT` (E2E fake sidecar). */
export function createFixedTranscribeRunner(
  fixed: JobResult['transcribe'] = FIXED_TRANSCRIPT
): JobRunner<'transcribe'> {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15))
  return async (_params, emit): Promise<JobResult['transcribe']> => {
    // Yield to the event loop between emits so the renderer's port consumer
    // attaches before events stream (mirrors the async real whisper runner).
    await tick()
    emit.progress(10, 'transcribing')
    await tick()
    emit.partial({ words: [fixed.words[0]], segments: [] })
    emit.progress(60, 'transcribing')
    await tick()
    emit.partial({ words: fixed.words.slice(1), segments: [fixed.segments[0]] })
    await tick()
    emit.progress(100, 'transcribing')
    return fixed
  }
}

/** The default runner: env-stubbed fake for E2E, else the real whisper services. */
export const transcribeRunner: JobRunner<'transcribe'> = process.env.OPENCLIP_FAKE_TRANSCRIBE
  ? createFixedTranscribeRunner()
  : createTranscribeRunner()
