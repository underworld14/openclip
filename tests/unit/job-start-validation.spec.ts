/**
 * job-start-validation.spec.ts — validateJobStart parses the inbound JOB_START payload
 * at the main-process trust boundary (audit fix openclip-qki): kind + the
 * security-sensitive params (paths, ids, url, model, aspect, times) must be the right
 * shape before they reach sidecar.startJob → spawn/fs. A hostile/buggy renderer payload
 * is rejected with a typed INPUT_INVALID rather than forwarded.
 */
import { describe, it, expect } from 'vitest'
import { validateJobStart } from '@main/ipc/job-start-validation'

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
