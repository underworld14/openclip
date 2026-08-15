/**
 * job-start-validation.spec.ts — validateJobStart parses the inbound JOB_START payload
 * at the main-process trust boundary (audit fix openclip-qki): kind + the
 * security-sensitive params (paths, ids, url, model, aspect, times) must be the right
 * shape before they reach sidecar.startJob → spawn/fs. A hostile/buggy renderer payload
 * is rejected with a typed INPUT_INVALID rather than forwarded.
 */
import { describe, it, expect } from 'vitest'
import { validateJobStart } from '@main/ipc/job-start-validation'
import { AIProvider } from '@shared/schema'
import type { JobKind } from '@shared/jobs'

describe('validateJobStart (openclip-qki)', () => {
  it('accepts a well-formed transcribe payload', () => {
    const out = validateJobStart({
      kind: 'transcribe',
      params: { projectId: 'p1', wavPath: '/tmp/a.wav', model: 'base' }
    })
    expect(out.kind).toBe('transcribe')
  })

  it('accepts an export payload and passes through non-sensitive caption data', () => {
    const out = validateJobStart({
      kind: 'export',
      params: {
        projectId: 'p1',
        clipId: 'c1',
        sourcePath: '/src/in.mp4',
        outputPath: '/out/clip.mp4',
        startTime: 1,
        endTime: 5,
        aspectRatio: '9:16',
        captions: { words: [], keywords: ['x'] } // extra data is allowed through
      }
    })
    expect(out.kind).toBe('export')
    expect((out.params as { captions?: unknown }).captions).toBeDefined()
  })

  it('rejects an unrecognised fitMode rather than silently centre-cropping', () => {
    // `fitMode` selects the FILTERGRAPH, so it is spawn-affecting in exactly the
    // way `forceCpu` selects the encoder (FEAT-bd87vz). Waved through by
    // `looseObject`, a junk value falls to `fitChain`'s `fill` default and the
    // user gets a cropped export instead of an error.
    const base = {
      projectId: 'p1',
      clipId: 'c1',
      sourcePath: '/src/in.mp4',
      outputPath: '/out/clip.mp4',
      startTime: 1,
      endTime: 5,
      aspectRatio: '9:16' as const
    }
    for (const fitMode of ['letterbox', 'blur', 'fill'] as const) {
      expect(validateJobStart({ kind: 'export', params: { ...base, fitMode } }).kind).toBe('export')
    }
    expect(() =>
      validateJobStart({ kind: 'export', params: { ...base, fitMode: 'stretch' } })
    ).toThrow(/INPUT_INVALID/)
    // …and absent stays valid: it means `fill`, the historical behaviour.
    expect(validateJobStart({ kind: 'export', params: base }).kind).toBe('export')
  })

  it('rejects an unknown job kind', () => {
    expect(() => validateJobStart({ kind: 'rm-rf', params: {} })).toThrow(/INPUT_INVALID/)
  })

  // EPIC-k83ghw / BUG-sg6kqg: adding `extract-audio` to `JobKind` (jobs.ts) but
  // forgetting this SEPARATE, hand-maintained `KIND` enum meant every real
  // extract-audio job was rejected as INPUT_INVALID at the trust boundary — a
  // renderer-visible break the type system cannot catch (this file's own
  // `paramsByKind` is a plain object literal, not derived from `JobKind`). Caught
  // by the vertical-slice E2E, not typecheck. This structural check makes the
  // NEXT job kind fail loudly here instead of only at runtime (mirrors the
  // `generate-clips` provider-drift lesson below).
  it('every JobKind has a params validator (structural drift guard)', () => {
    const kinds: JobKind[] = [
      'extract-audio',
      'transcribe',
      'export',
      'model-download',
      'url-download',
      'generate-clips'
    ]
    for (const kind of kinds) {
      // A garbage `params` value always fails ITS kind's params schema — the
      // point here is WHICH message comes back. "expected one of" is the
      // envelope-level KIND rejection (this kind has no validator entry, the
      // exact bug this guard exists for); a per-kind "params:" message proves
      // the kind was recognised and its own validator ran.
      let message = ''
      try {
        validateJobStart({ kind, params: 'not-an-object' })
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).not.toMatch(/expected one of/)
      expect(message).toContain(`JOB_START ${kind} params:`)
    }
  })

  it('accepts a well-formed extract-audio payload', () => {
    const out = validateJobStart({
      kind: 'extract-audio',
      params: { projectId: 'p1', sourcePath: '/src/in.mp4' }
    })
    expect(out.kind).toBe('extract-audio')
  })

  it('rejects extract-audio with a path-escaping projectId or an empty sourcePath', () => {
    expect(() =>
      validateJobStart({
        kind: 'extract-audio',
        params: { projectId: '../../victim', sourcePath: '/src/in.mp4' }
      })
    ).toThrow(/INPUT_INVALID/)
    expect(() =>
      validateJobStart({ kind: 'extract-audio', params: { projectId: 'p1', sourcePath: '' } })
    ).toThrow(/INPUT_INVALID/)
  })

  it('rejects missing/empty security-sensitive paths', () => {
    expect(() =>
      validateJobStart({ kind: 'transcribe', params: { projectId: 'p1', model: 'base' } })
    ).toThrow(/INPUT_INVALID/)
    expect(() =>
      validateJobStart({
        kind: 'export',
        params: {
          projectId: 'p1',
          clipId: 'c1',
          sourcePath: '',
          outputPath: '/o.mp4',
          startTime: 0,
          endTime: 1,
          aspectRatio: '9:16'
        }
      })
    ).toThrow(/INPUT_INVALID/)
  })

  it('rejects non-finite times and a bad aspect ratio', () => {
    const base = {
      projectId: 'p1',
      clipId: 'c1',
      sourcePath: '/s.mp4',
      outputPath: '/o.mp4',
      aspectRatio: '9:16' as const
    }
    expect(() =>
      validateJobStart({ kind: 'export', params: { ...base, startTime: Number.NaN, endTime: 1 } })
    ).toThrow(/INPUT_INVALID/)
    expect(() =>
      validateJobStart({
        kind: 'export',
        params: { ...base, startTime: 0, endTime: 1, aspectRatio: '3:2' }
      })
    ).toThrow(/INPUT_INVALID/)
  })

  it('rejects a non-http(s) url and a bad whisper model', () => {
    expect(() =>
      validateJobStart({ kind: 'url-download', params: { url: 'file:///etc/passwd' } })
    ).toThrow(/INPUT_INVALID/)
    expect(() => validateJobStart({ kind: 'model-download', params: { model: 'gpt' } })).toThrow(
      /INPUT_INVALID/
    )
  })
})

// ── FEAT-bysdwg: generate-clips had NO coverage here, and its provider list was
// a hand-copied duplicate of the schema enum — so a provider added to the schema
// was accepted everywhere except at this boundary, at runtime only.
describe('validateJobStart: generate-clips provider', () => {
  const base = {
    projectId: 'p1',
    model: 'local-model',
    segments: [],
    numClips: 5,
    durationSeconds: 120
  }

  it('accepts every provider the schema enum offers', () => {
    for (const provider of AIProvider.options) {
      expect(() =>
        validateJobStart({ kind: 'generate-clips', params: { ...base, provider } })
      ).not.toThrow()
    }
  })

  it('still rejects a provider that is not in the enum', () => {
    expect(() =>
      validateJobStart({ kind: 'generate-clips', params: { ...base, provider: 'gpt' } })
    ).toThrow(/INPUT_INVALID/)
  })

  it('still rejects a projectId that would escape the temp root', () => {
    expect(() =>
      validateJobStart({
        kind: 'generate-clips',
        params: { ...base, provider: 'openai', projectId: '../../victim' }
      })
    ).toThrow(/INPUT_INVALID/)
  })
})
