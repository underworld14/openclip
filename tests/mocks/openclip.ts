/**
 * tests/mocks/openclip.ts — `createMockOpenclip()`: a schema-VALID, in-memory
 * `OpenClipBridge` for renderer-side tests (plan E.2 "the single mock surface,
 * typed as the contract"; E.7 drift detection #5 preload-parity).
 *
 * It is typed as the derived `OpenClipBridge`, so it CANNOT silently diverge
 * from the real preload surface — `preload-parity.spec.ts` asserts the two
 * expose identical method sets. Control-plane methods return canned contract
 * fixtures; `jobs.start()` is MessageChannel-driven (a real Node MessageChannel
 * playing a `JobScript` via the fake harness) so `useJob` can be exercised
 * end-to-end against a real port.
 */

import { MessageChannel } from 'node:worker_threads'
import { IPCChannels } from '@shared/channels'
import type { OpenClipBridge } from '@preload/index'
import type { JobKind, JobParams, JobsAPI } from '@shared/jobs'
import { driveScriptOverChannel, type JobScript } from '../harness/fake-utility-process'
import {
  projectFixture,
  settingsFixture,
  clipSchemaFixture,
  apiKeyStatusFixture,
  modelStatusFixture,
  transcribeResultFixture,
  transcribePartialFixture
} from '../fixtures/contract'

// ============================================================================
// Method-name derivation (mirrors src/preload/api/_invoke.toMethodName) — kept
// here so the mock has no `electron` import; parity is asserted by the spec.
// ============================================================================

function toMethodName(channelValue: string, prefix: string): string {
  const rest = channelValue.slice(prefix.length + 1)
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
  const camelHyphen = (s: string): string =>
    s
      .split('-')
      .map((part, i) => (i === 0 ? part : cap(part)))
      .join('')
  return rest
    .split(':')
    .map((seg, i) => (i === 0 ? camelHyphen(seg) : cap(camelHyphen(seg))))
    .join('')
}

/** Canned responses keyed by channel value. */
const CANNED: Partial<Record<string, unknown>> = {
  [IPCChannels.IMPORT_VIDEO]: { sourceVideo: projectFixture.sourceVideo },
  [IPCChannels.IMPORT_FROM_URL]: { sourceVideo: projectFixture.sourceVideo },
  [IPCChannels.AUDIO_EXTRACT]: { wavPath: '/tmp/openclip/p1/j1/audio.16k.wav' },
  [IPCChannels.EXPORT_CLIP]: { outputPath: '/Users/me/Movies/clip-1.mp4' },
  [IPCChannels.GENERATE_CLIPS]: clipSchemaFixture,
  [IPCChannels.GENERATE_TITLES]: { options: [] },
  [IPCChannels.ENHANCE_CAPTIONS]: { enhanced_captions: [] },
  [IPCChannels.SAVE_PROJECT]: { path: '/Users/me/.../projects/p1.ocproj' },
  [IPCChannels.LOAD_PROJECT]: projectFixture,
  [IPCChannels.LIST_PROJECTS]: [
    {
      id: projectFixture.id,
      name: projectFixture.name,
      updatedAt: projectFixture.updatedAt,
      path: '/p1.ocproj'
    }
  ],
  [IPCChannels.DELETE_PROJECT]: { deleted: true },
  [IPCChannels.GET_SETTINGS]: settingsFixture,
  [IPCChannels.SET_SETTINGS]: settingsFixture,
  [IPCChannels.GET_API_KEY_STATUS]: apiKeyStatusFixture,
  [IPCChannels.SET_API_KEY]: apiKeyStatusFixture,
  [IPCChannels.MODEL_STATUS]: modelStatusFixture,
  [IPCChannels.MODEL_DOWNLOAD]: { jobId: 'model-1', port: null },
  [IPCChannels.OPEN_FOLDER]: undefined,
  [IPCChannels.SHOW_SAVE_DIALOG]: { canceled: false, filePath: '/Users/me/Movies/clip-1.mp4' },
  [IPCChannels.CHECK_UPDATE]: { updateAvailable: false }
}

function buildMockNamespace(prefix: string): Record<string, (req?: unknown) => Promise<unknown>> {
  const out: Record<string, (req?: unknown) => Promise<unknown>> = {}
  for (const value of Object.values(IPCChannels)) {
    if (typeof value !== 'string') continue
    if (!value.startsWith(`${prefix}:`)) continue
    if (value === IPCChannels.JOB_START || value === IPCChannels.JOB_CANCEL) continue
    out[toMethodName(value, prefix)] = async () => CANNED[value]
  }
  return out
}

// ============================================================================
// Per-kind default scripts (terminal `done`) so jobs.start resolves to done.
// ============================================================================

const DEFAULT_SCRIPTS: { [K in JobKind]: JobScript<K> } = {
  transcribe: {
    steps: [
      { t: 'progress', pct: 10, stage: 'extracting' },
      { t: 'progress', pct: 60, stage: 'transcribing' },
      { t: 'partial', data: transcribePartialFixture },
      { t: 'done', result: transcribeResultFixture }
    ]
  },
  export: {
    steps: [
      { t: 'progress', pct: 50, stage: 'encoding' },
      {
        t: 'done',
        result: {
          outputPath: '/Users/me/Movies/clip-1.mp4',
          width: 1080,
          height: 1920,
          durationMs: 28_500
        }
      }
    ]
  },
  'model-download': {
    steps: [
      { t: 'partial', data: { receivedBytes: 50_000_000, totalBytes: 147_000_000 } },
      { t: 'progress', pct: 100, stage: 'downloading' },
      { t: 'done', result: { model: 'base', path: '/models/ggml-base.bin', bytes: 147_000_000 } }
    ]
  }
}

export interface MockOptions {
  /** Override the scripted JobEvent stream a kind plays back. */
  scripts?: Partial<{ [K in JobKind]: JobScript<K> }>
}

/**
 * A mock JobsAPI driven by a real Node MessageChannel. `start()` resolves with
 * `{ jobId, port }` where `port` is one end of a channel; the other end plays
 * the kind's script through `driveScriptOverChannel`. The returned `port` is
 * cast to the DOM `MessagePort` the contract types (Node's MessagePort is
 * structurally compatible for the message-event consumption useJob does).
 */
function buildMockJobs(opts: MockOptions): JobsAPI {
  return {
    async start<K extends JobKind>(
      kind: K,
      _params: JobParams[K]
    ): Promise<{ jobId: string; port: MessagePort }> {
      void _params
      const { port1, port2 } = new MessageChannel()
      const script = (opts.scripts?.[kind] ?? DEFAULT_SCRIPTS[kind]) as JobScript<K>
      const jobId = `${kind}-mock-1`
      port1.start()
      // Drive the script on the next tick so the consumer can attach first.
      queueMicrotask(() => {
        void driveScriptOverChannel(port2, script, { jobId })
      })
      return { jobId, port: port1 as unknown as MessagePort }
    },
    async cancel(_jobId: string): Promise<void> {
      void _jobId
    }
  }
}

/**
 * Build a fully-typed mock `OpenClipBridge`. The returned object's method set is
 * derived from the SAME channel enum the real preload uses, guaranteeing parity
 * (asserted in `preload-parity.spec.ts`).
 */
export function createMockOpenclip(opts: MockOptions = {}): OpenClipBridge {
  return {
    video: buildMockNamespace('video') as OpenClipBridge['video'],
    audio: buildMockNamespace('audio') as OpenClipBridge['audio'],
    ai: buildMockNamespace('ai') as OpenClipBridge['ai'],
    project: buildMockNamespace('project') as OpenClipBridge['project'],
    settings: buildMockNamespace('settings') as OpenClipBridge['settings'],
    model: buildMockNamespace('model') as OpenClipBridge['model'],
    jobs: buildMockJobs(opts)
  }
}
