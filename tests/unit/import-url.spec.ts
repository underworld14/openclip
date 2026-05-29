/**
 * tests/unit/import-url.spec.ts — the unified smart-import URL branch (F.4):
 * `isUrl` detection + `runUrlDownload` driving the `url-download` streaming job
 * over the mock bridge + fake-port harness (same headless pattern as
 * import-pipeline.spec). Proves progress/partial stream and the final file path
 * resolves, and that a terminal error throws (no silent hang).
 */

import { describe, expect, it } from 'vitest'
import { isUrl, runUrlDownload } from '@renderer/components/import-pipeline'
import { createMockOpenclip } from '../mocks/openclip'

describe('isUrl', () => {
  it('detects http(s) URLs and rejects file paths', () => {
    expect(isUrl('https://youtu.be/M5XbNdzPuDQ')).toBe(true)
    expect(isUrl('http://example.com/v.mp4')).toBe(true)
    expect(isUrl('  https://x.test/v  ')).toBe(true) // trimmed
    expect(isUrl('/Users/me/Movies/clip.mp4')).toBe(false)
    expect(isUrl('clip.mp4')).toBe(false)
    expect(isUrl('ftp://nope')).toBe(false)
  })
})

describe('runUrlDownload: url-download job over the port', () => {
  it('streams progress + partial and resolves the downloaded file path', async () => {
    const openclip = createMockOpenclip()
    const progresses: number[] = []

    const result = await runUrlDownload({
      bridge: openclip,
      url: 'https://youtu.be/M5XbNdzPuDQ',
      onProgress: (pct) => progresses.push(pct)
    })

    expect(result.filePath).toMatch(/\.mp4$/)
    expect(result.bytes).toBeGreaterThan(0)
    // The default mock script emits a partial (pct 10) + progress 0/100 + done.
    expect(progresses.some((p) => p > 0)).toBe(true)
    expect(progresses).toContain(100)
  })

  it('throws a pipeline error on a terminal job error (no silent hang)', async () => {
    const openclip = createMockOpenclip({
      scripts: {
        'url-download': {
          steps: [
            { t: 'progress', pct: 5, stage: 'downloading' },
            { t: 'error', code: 'SIDECAR_CRASH', message: 'yt-dlp failed', retriable: true }
          ]
        }
      }
    })

    await expect(
      runUrlDownload({ bridge: openclip, url: 'https://youtu.be/M5XbNdzPuDQ' })
    ).rejects.toThrow(/yt-dlp failed|SIDECAR_CRASH/)
  })
})
