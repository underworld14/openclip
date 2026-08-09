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
import { ffmpegAvailable, videotoolboxAvailable } from '../harness/fixtures'

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

    // The GPU-path smokes (ffmpeg-export / ass-captions burn) guard on whether ffmpeg can
    // actually ENCODE with h264_videotoolbox, so they self-skip instead of dying where it
    // is missing or unusable. That guard is itself a silent-skip risk on the platform that
    // ships the HW-encode path: a Mac whose ffmpeg lost VideoToolbox would quietly drop
    // the whole default-encoder layer. So assert it — but NOT on CI.
    //
    // GitHub's macos-14 runners are VMs with no hardware video-encode session: the encoder
    // is listed and then fails to open with `cannot create compression session: -12903`
    // (run 31294181503). No change in this repo can give a VM a HW encoder, so requiring
    // it there would pin CI red forever. On a developer's or a release Mac — where losing
    // VideoToolbox IS a real, fixable regression — this stays loud.
    it.skipIf(process.platform !== 'darwin' || !!process.env.CI)(
      'this Mac can encode with h264_videotoolbox so the GPU-path @serial smokes do NOT skip',
      () => {
        expect(
          videotoolboxAvailable(),
          'This Mac cannot encode with h264_videotoolbox → the default (non-forceCpu) export ' +
            '+ caption-burn @serial smokes silently SKIP, leaving the shipped HW-encode path ' +
            'untested. Check OPENCLIP_FFMPEG / the ffmpeg-static build.'
        ).toBe(true)
      }
    )
  }
)
