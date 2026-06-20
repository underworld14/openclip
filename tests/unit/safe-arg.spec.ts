/**
 * safe-arg.spec.ts — assertSafePathArg guards the spawn boundary against option
 * injection: ffmpeg/ffprobe/whisper-cli parse any argv token starting with '-' as
 * a FLAG (there is no shell, so this is option injection, not shell injection).
 * A path argument that begins with '-' is always malformed/hostile (real paths are
 * absolute) and must be rejected before it reaches spawn() (audit fix openclip-6l6).
 */
import { describe, it, expect } from 'vitest'
import { assertSafePathArg } from '@main/utils/safe-arg'

describe('assertSafePathArg', () => {
  it('returns absolute paths unchanged', () => {
    expect(assertSafePathArg('/Users/me/videos/clip.mp4')).toBe('/Users/me/videos/clip.mp4')
  })

  it('returns a leading-dash basename unchanged when it lives under an absolute dir', () => {
    expect(assertSafePathArg('/tmp/out/-y.mp4')).toBe('/tmp/out/-y.mp4')
  })

  it('rejects a path that begins with a dash (option injection)', () => {
    expect(() => assertSafePathArg('-y')).toThrow(/must not begin with '-'/)
    expect(() => assertSafePathArg('-protocol_whitelist,file', 'sourcePath')).toThrow(/sourcePath/)
  })

  it('rejects empty / non-string input', () => {
    expect(() => assertSafePathArg('')).toThrow()
    expect(() => assertSafePathArg(undefined as unknown as string)).toThrow()
  })
})
