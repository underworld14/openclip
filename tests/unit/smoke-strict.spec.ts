/**
 * smoke-strict.spec.ts — guard the real-binary smoke layer against SILENT disablement
 * (audit fix openclip-g2w).
 *
 * The `@serial` smokes self-skip when their binaries/fixtures are absent so a bare
 * `npm test` stays green on any checkout. The cost: a fixture/binary loss in an
 * environment that SHOULD run them (a CI runner, a release machine) quietly disables the
 * ENTIRE real-binary layer with no red — a skip is indistinguishable from a pass in the
 * summary. When `OPENCLIP_REQUIRE_SMOKES` is set this guard FAILS if the prerequisites are
 * missing, turning a silent skip into a loud failure. `npm run test:smoke` runs the suite
 * with the flag set, so a dedicated (required) CI job can treat a skipped smoke layer as a
 * failure.
 */
import { describe, it, expect } from 'vitest'
import { ffmpegAvailable } from '../harness/fixtures'

const STRICT = !!process.env.OPENCLIP_REQUIRE_SMOKES

describe.skipIf(!STRICT)(
  'smoke prerequisites — strict (OPENCLIP_REQUIRE_SMOKES, openclip-g2w)',
  () => {
    it('the real FFmpeg binary is invokable so the ffmpeg/libass @serial smokes do NOT skip', () => {
      expect(
        ffmpegAvailable(),
        'FFmpeg is not invokable → every ffmpeg / libass / reframe / extract @serial smoke ' +
          'would silently SKIP, disabling the real-binary regression layer. Run ' +
          'scripts/bundle-binaries.mjs (seeds build/ffmpeg-cache), `brew install ffmpeg`, or ' +
          'set OPENCLIP_FFMPEG to a libass-enabled build.'
      ).toBe(true)
    })
  }
)
