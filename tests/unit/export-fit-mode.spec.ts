/**
 * tests/unit/export-fit-mode.spec.ts — letterbox / blurred-bar fit, and the
 * aspect ratio the user can finally choose (FEAT-bd87vz).
 *
 * Two gaps, both of which cost the user content:
 *
 *  - The ONLY fit strategies were centre-crop and face-crop. `cropExpr` had no
 *    pad branch, so a source that was ALREADY portrait or square got cropped
 *    when it should have been letterboxed — silently cutting frame content
 *    away. PRD Appendix A (docs/prd.md:885) has documented the missing command
 *    since the spec was written.
 *  - PRD §6.5 promises 1:1 and 4:5 to the user, but single-clip export read
 *    `settings.aspectRatio`, a field with NO UI writer anywhere. It was
 *    permanently '9:16'.
 *
 * The load-bearing assertion here is the FIRST one: `fill` must stay
 * byte-identical. Everything downstream of the export builder — three argv
 * paths, a golden test, the split/vstack graph — depends on the historical
 * chain, and a fit feature that quietly perturbs the default export is a far
 * worse bug than the one it fixes.
 */

import { describe, expect, it } from 'vitest'
import {
  buildVf,
  exportClipArgs,
  exportClipArgsMultiRange,
  fitChain,
  outputDimensions,
  type FitMode
} from '@main/services/ffmpeg-export'
import type { AspectRatio } from '@shared/schema'

const RATIOS: AspectRatio[] = ['9:16', '1:1', '4:5', '16:9']

const BASE = {
  sourcePath: '/tmp/in.mp4',
  outputPath: '/tmp/out.mp4',
  startTime: 10,
  endTime: 20,
  aspectRatio: '9:16' as AspectRatio,
  quality: '1080p' as const
}

/** The `-vf` value from an argv, whichever flag carried it. */
function graphOf(argv: string[]): string {
  const i = argv.indexOf('-vf')
  if (i >= 0) return argv[i + 1]
  const j = argv.indexOf('-filter_complex')
  return j >= 0 ? argv[j + 1] : ''
}

describe('fill is untouched — the historical chain, exactly', () => {
  it('produces the same node pair with fitMode absent, undefined or "fill"', () => {
    for (const ratio of RATIOS) {
      const absent = fitChain({ aspectRatio: ratio })
      expect(fitChain({ aspectRatio: ratio, fitMode: 'fill' })).toBe(absent)
      const { width, height } = outputDimensions(ratio)
      expect(absent.endsWith(`,scale=${width}:${height}`), ratio).toBe(true)
      expect(absent.startsWith('crop='), ratio).toBe(true)
    }
  })

  it('leaves the whole argv byte-identical', () => {
    // The golden argv test guards the default export; this guards that ADDING
    // the option cannot perturb it.
    expect(exportClipArgs({ ...BASE, fitMode: 'fill' })).toEqual(exportClipArgs(BASE))
  })

  it('still lets a reframe plan replace the crop', () => {
    const chain = fitChain({
      aspectRatio: '9:16',
      fitMode: 'fill',
      reframePlan: { mode: 'static', cropW: 608, cropH: 1080, cropX: 100 }
    })
    expect(chain).toBe('crop=608:1080:x=100:y=0,scale=1080:1920')
  })
})

describe('letterbox — the command PRD Appendix A already documented', () => {
  it('scales to FIT and pads, centred', () => {
    // decrease (not increase) is the whole difference between letterboxing and
    // cropping; the pad offsets centre what is left.
    expect(fitChain({ aspectRatio: '9:16', fitMode: 'letterbox' })).toBe(
      'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2'
    )
  })

  it('uses each ratio’s real output size', () => {
    for (const ratio of RATIOS) {
      const { width, height } = outputDimensions(ratio)
      const chain = fitChain({ aspectRatio: ratio, fitMode: 'letterbox' })
      expect(chain, ratio).toContain(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`
      )
      expect(chain, ratio).toContain(`pad=${width}:${height}:`)
    }
  })

  it('never crops — that is the entire point', () => {
    for (const ratio of RATIOS) {
      expect(fitChain({ aspectRatio: ratio, fitMode: 'letterbox' }), ratio).not.toContain('crop=')
    }
  })

  it('ignores a reframe plan rather than pretending to honour it', () => {
    // There is no crop left to move inside a letterboxed frame.
    expect(
      fitChain({
        aspectRatio: '9:16',
        fitMode: 'letterbox',
        reframePlan: { mode: 'static', cropW: 608, cropH: 1080, cropX: 100 }
      })
    ).toBe(fitChain({ aspectRatio: '9:16', fitMode: 'letterbox' }))
  })
})

describe('blur — the fit social audiences actually expect', () => {
  const chain = fitChain({ aspectRatio: '9:16', fitMode: 'blur' })

  it('forks the frame into a COVER background and a FIT foreground', () => {
    expect(chain).toContain('split=2[ocbg][ocfg]')
    // Background covers (increase + crop); foreground fits (decrease). Getting
    // these the same way round produces either a cropped result or black bars
    // with a blurred smear in them.
    expect(chain).toContain('force_original_aspect_ratio=increase,crop=1080:1920,gblur=')
    expect(chain).toContain('[ocfg]scale=1080:1920:force_original_aspect_ratio=decrease[ocfgs]')
    expect(chain).toContain('[ocbgb][ocfgs]overlay=(W-w)/2:(H-h)/2')
  })

  it('ends its final sub-chain UNLABELED, so callers can append to it', () => {
    // Every caller composes by appending `,<node>` or `[label]`. A trailing
    // label here would produce an unparseable graph in all four argv paths.
    expect(chain.split(';').pop()!.endsWith(']')).toBe(false)
  })

  it('uses labels that cannot collide with the logo/subtitle labels', () => {
    for (const reserved of ['[v]', '[vbase]', '[vov]', '[logo]', '[a]']) {
      expect(chain, reserved).not.toContain(reserved)
    }
  })
})

describe('composition: the fit chain survives every downstream node', () => {
  it('appends subtitles to the FINAL sub-chain, not across a `;`', () => {
    // `,` between two `;`-separated chains is invalid — this is the exact way a
    // multi-chain fit mode breaks a graph that a single-node one never would.
    for (const mode of ['fill', 'letterbox', 'blur'] as FitMode[]) {
      const vf = buildVf({ aspectRatio: '9:16', fitMode: mode, assPath: '/tmp/c.ass' })
      expect(vf.split(';').pop(), mode).toContain(',subtitles=/tmp/c.ass')
      expect(vf, mode).not.toContain(';,')
    }
  })

  it('threads through the plain -vf export path', () => {
    const argv = exportClipArgs({ ...BASE, fitMode: 'letterbox' })
    expect(graphOf(argv)).toContain('pad=1080:1920')
  })

  it('threads through the LOGO filter_complex path, still ending in [v]', () => {
    const argv = exportClipArgs({ ...BASE, fitMode: 'blur', logoPath: '/tmp/logo.png' })
    const graph = graphOf(argv)
    expect(graph).toContain('split=2[ocbg][ocfg]')
    expect(graph).toContain('[vbase]')
    expect(graph).toContain('[v]')
    expect(argv).toContain('-map')
  })

  it('threads through the jump-cut path, with select AFTER the fit', () => {
    const argv = exportClipArgsMultiRange({
      ...BASE,
      fitMode: 'letterbox',
      keepRanges: [
        [10, 12],
        [15, 20]
      ]
    })
    const graph = graphOf(argv)
    expect(graph).toContain('pad=1080:1920')
    expect(graph.indexOf('pad=')).toBeLessThan(graph.indexOf('select='))
    // …and the fit already scaled, so no second scale is tacked on the end.
    expect(graph).not.toContain('setpts=N/FRAME_RATE/TB,scale=')
  })

  it('keeps the jump-cut FILL ordering exactly as the openclip-dwu invariant requires', () => {
    // crop BEFORE select, so a `pan` xExpr sees the uncompressed source `t`.
    const graph = graphOf(
      exportClipArgsMultiRange({
        ...BASE,
        keepRanges: [
          [10, 12],
          [15, 20]
        ]
      })
    )
    expect(graph.indexOf('crop=')).toBeLessThan(graph.indexOf('select='))
    expect(graph).toContain('setpts=N/FRAME_RATE/TB,scale=1080:1920')
  })
})
