/**
 * tests/unit/sidecar-errors.spec.ts — the sidecar (ffmpeg/whisper-cli/yt-dlp)
 * failure classifier (EPIC-k83ghw / BUG-whdqsc). Mirrors `ai-errors.spec.ts`'s
 * shape for the provider side: every pattern the ticket names gets a plain,
 * actionable sentence, and nothing falls through to a raw stderr dump.
 */

import { describe, expect, it } from 'vitest'
import { describeSidecarFailure } from '@main/services/sidecar-errors'

/** The real shape ffmpeg-core.ts / whisper-spawn.ts throw on a non-zero exit. */
function rawExit(binary: string, code: number, stderrTail: string): Error {
  return new Error(`${binary} exited with code ${code}\n${stderrTail}`)
}

describe('describeSidecarFailure: disk / filesystem', () => {
  it('a full disk during export produces a plain-language message (BUG-whdqsc AC1)', () => {
    const err = rawExit(
      'ffmpeg',
      1,
      '[libx264 @ 0x600002a1c000] frame= 42\nav_interleaved_write_frame(): No space left on device\n'
    )
    const f = describeSidecarFailure(err)
    expect(f.code).toBe('SIDECAR_CRASH')
    expect(f.message).toBe('Your disk is full. Free up some space and try again.')
    expect(f.message).not.toMatch(/libx264|0x600/)
  })

  it('a read-only destination maps to a permission message', () => {
    const f = describeSidecarFailure(new Error('open /Volumes/Locked/out.mp4: Permission denied'))
    expect(f.message).toMatch(/doesn't have permission/i)
  })

  it('an unplugged source volume maps to a reconnect message', () => {
    const f = describeSidecarFailure(
      rawExit('ffmpeg', 1, '/Volumes/SD/src.mov: Input/output error\n')
    )
    expect(f.message).toMatch(/disconnected/i)
  })

  it('a missing/moved input maps to a "could not be found" message', () => {
    const f = describeSidecarFailure(
      new Error('ffmpeg: /Users/me/Movies/gone.mp4: No such file or directory')
    )
    expect(f.message).toMatch(/couldn't be found/i)
    expect(f.retriable).toBe(false)
  })
})

describe('describeSidecarFailure: memory', () => {
  it('an out-of-memory failure maps to the OUT_OF_MEMORY code with a model-downgrade hint', () => {
    const f = describeSidecarFailure(
      rawExit('whisper-cli', 1, 'ggml_metal_graph_compute: error: out of memory\n')
    )
    expect(f.code).toBe('OUT_OF_MEMORY')
    expect(f.message).toMatch(/smaller whisper model/i)
  })
})

describe('describeSidecarFailure: format / codec', () => {
  it('an unsupported/corrupt input maps to a format message', () => {
    const f = describeSidecarFailure(
      rawExit('ffmpeg', 1, 'Invalid data found when processing input\n')
    )
    expect(f.message).toMatch(/format isn't supported|corrupted/i)
  })

  it('a hardware-encoder failure (already retried on CPU) suggests a restart', () => {
    const f = describeSidecarFailure(new Error('VideoToolbox session could not be created'))
    expect(f.message).toMatch(/restarting openclip/i)
  })
})

describe('describeSidecarFailure: yt-dlp (BUG-whdqsc scope note — the 403 screenshot)', () => {
  it('HTTP 403 (the exact reproduced screenshot text) maps to a plain sentence', () => {
    const f = describeSidecarFailure(
      new Error('unable to download video data: HTTP Error 403: Forbidden')
    )
    expect(f.message).toBe(
      'This video refused the download. It may be region-locked, private, or the platform is temporarily blocking automated downloads.'
    )
    expect(f.message).not.toMatch(/HTTP Error|403/)
  })

  it('HTTP 429 / rate limiting maps to a wait-and-retry message', () => {
    expect(describeSidecarFailure(new Error('HTTP Error 429: Too Many Requests')).message).toMatch(
      /too many download attempts/i
    )
  })

  it('"Video unavailable" and "Private video" map to distinct plain sentences', () => {
    expect(describeSidecarFailure(new Error('ERROR: Video unavailable')).message).toMatch(
      /unavailable/i
    )
    expect(describeSidecarFailure(new Error('ERROR: Private video')).message).toMatch(/private/i)
  })

  it('age-restriction ("Sign in to confirm your age") maps to a plain sentence', () => {
    expect(describeSidecarFailure(new Error('Sign in to confirm your age')).message).toMatch(
      /age-restricted/i
    )
  })
})

describe('describeSidecarFailure: network', () => {
  it('a DNS/connection failure maps to a network message', () => {
    expect(describeSidecarFailure(new Error('getaddrinfo ENOTFOUND example.com')).message).toMatch(
      /internet connection/i
    )
  })
})

describe("describeSidecarFailure: cancellation is NOT this module's job", () => {
  it('is unaffected by a cancellation-shaped message — the manager never calls this for CANCELLED', () => {
    // Documents the boundary: sidecar-manager.ts checks `controller.signal.aborted`
    // BEFORE calling this classifier, so a genuine cancel never reaches it. This
    // just proves the classifier doesn't accidentally special-case the word.
    const f = describeSidecarFailure(new Error('ffmpeg aborted'))
    expect(f.code).toBe('SIDECAR_CRASH')
  })
})

describe('describeSidecarFailure: unrecognised shape (BUG-whdqsc AC2)', () => {
  it('falls back to a short generic message — NEVER the raw stderr tail', () => {
    const err = rawExit(
      'ffmpeg',
      1,
      Array.from({ length: 50 }, (_, i) => `[libx264 @ 0x${i}] some encoder log line`).join('\n')
    )
    const f = describeSidecarFailure(err)
    expect(f.message).toBe(
      "OpenClip couldn't finish processing this video. Try again, or try a different file."
    )
    expect(f.message.length).toBeLessThan(200)
    expect(f.message).not.toMatch(/libx264|exited with code/)
  })

  it('a plain non-Error thrown value does not crash the classifier', () => {
    expect(() => describeSidecarFailure('a string, not an Error')).not.toThrow()
    expect(() => describeSidecarFailure(undefined)).not.toThrow()
  })
})
