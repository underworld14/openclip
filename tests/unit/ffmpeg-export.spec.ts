/**
 * tests/unit/ffmpeg-export.spec.ts — pure arg-building for the frame-accurate
 * cut + 9:16 reframe + re-encode (EXPORT spine, plan E.5 / PRD §6.5/§6.9), plus
 * the export JobRunner glue against an injected fake export service (no binary).
 *
 * The argv strings are LOAD-BEARING (they map 1:1 to the verified ffmpeg command
 * proven empirically on ffmpeg-static), so we assert them exactly. The real
 * binary is exercised separately by `ffmpeg-export.serial.spec.ts` (ffprobe).
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportClipArgs,
  exportClipArgsMultiRange,
  exportClipArgsSplit,
  exportClip,
  codecArgs,
  thumbnailArgs,
  buildVf,
  cropExpr,
  outputDimensions,
  videoBitrate,
  escapeFilterPath,
  type ExportArgsOptions
} from '@main/services/ffmpeg-export'
import { createExportRunner } from '@main/services/jobs/export-runner'
import type { JobParams } from '@shared/jobs'
import type { JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import type { ReframePlan } from '@shared/reframe-plan'

const base: ExportArgsOptions = {
  sourcePath: '/src/in.mp4',
  outputPath: '/out/clip.mp4',
  startTime: 30,
  endTime: 58.5,
  aspectRatio: '9:16',
  quality: '1080p'
}

describe('outputDimensions', () => {
  it('maps each aspect ratio to its 1080-family output size', () => {
    expect(outputDimensions('9:16')).toEqual({ width: 1080, height: 1920 })
    expect(outputDimensions('1:1')).toEqual({ width: 1080, height: 1080 })
    expect(outputDimensions('4:5')).toEqual({ width: 1080, height: 1350 })
    expect(outputDimensions('16:9')).toEqual({ width: 1920, height: 1080 })
  })
})

describe('cropExpr / buildVf', () => {
  it('uses the PRD §6.5 / Appendix A center-crop for 9:16', () => {
    expect(cropExpr('9:16')).toBe('crop=ih*9/16:ih')
  })

  it('builds crop,scale for a plain 9:16 export (no captions)', () => {
    expect(buildVf({ aspectRatio: '9:16' })).toBe('crop=ih*9/16:ih,scale=1080:1920')
  })

  it('appends the subtitles node LAST when an ass is given (caption-burn seam)', () => {
    const vf = buildVf({ aspectRatio: '9:16', assPath: '/t/c.ass', fontsDir: '/t/fonts' })
    expect(vf).toBe('crop=ih*9/16:ih,scale=1080:1920,subtitles=/t/c.ass:fontsdir=/t/fonts')
  })

  it('escapes filtergraph-special chars in a subtitles path', () => {
    expect(escapeFilterPath('/a b/c:d.ass')).toBe('/a b/c\\:d.ass')
    const vf = buildVf({ aspectRatio: '9:16', assPath: '/Vol:1/x.ass' })
    expect(vf).toContain('subtitles=/Vol\\:1/x.ass')
  })
})

describe('buildVf with a reframePlan (Part J auto-reframe)', () => {
  it('falls back to the center-crop when reframePlan is null (golden unchanged)', () => {
    expect(buildVf({ aspectRatio: '9:16', reframePlan: null })).toBe(
      'crop=ih*9/16:ih,scale=1080:1920'
    )
  })

  it('replaces the center-crop with a static face-centered crop=W:H:x=INT:y=0', () => {
    const plan: ReframePlan = { mode: 'static', cropW: 608, cropH: 1080, cropX: 240 }
    expect(buildVf({ aspectRatio: '9:16', reframePlan: plan })).toBe(
      'crop=608:1080:x=240:y=0,scale=1080:1920'
    )
  })

  it('single-quotes the pan xExpr so its commas stay literal to the filtergraph', () => {
    const plan: ReframePlan = {
      mode: 'pan',
      cropW: 608,
      cropH: 1080,
      xExpr: 'max(0,min(1312,200+50*t))',
      cropX: 240
    }
    expect(buildVf({ aspectRatio: '9:16', reframePlan: plan })).toBe(
      "crop=608:1080:x='max(0,min(1312,200+50*t))':y=0,scale=1080:1920"
    )
  })

  it('still appends the subtitles burn AFTER the reframe crop+scale (caption seam)', () => {
    const plan: ReframePlan = { mode: 'static', cropW: 608, cropH: 1080, cropX: 240 }
    const vf = buildVf({
      aspectRatio: '9:16',
      reframePlan: plan,
      assPath: '/t/c.ass',
      fontsDir: '/t/fonts'
    })
    expect(vf).toBe('crop=608:1080:x=240:y=0,scale=1080:1920,subtitles=/t/c.ass:fontsdir=/t/fonts')
  })

  it('falls back to the center-crop for a split plan (split is rendered by filter_complex)', () => {
    const plan: ReframePlan = {
      mode: 'split',
      regions: [
        { cropX: 0, cropY: 0, cropW: 960, cropH: 540 },
        { cropX: 960, cropY: 0, cropW: 960, cropH: 540 }
      ]
    }
    expect(buildVf({ aspectRatio: '9:16', reframePlan: plan })).toBe(
      'crop=ih*9/16:ih,scale=1080:1920'
    )
  })
})

describe('videoBitrate', () => {
  it('targets 8M for 1080p and 5M for 720p', () => {
    expect(videoBitrate('1080p')).toBe('8M')
    expect(videoBitrate('720p')).toBe('5M')
  })
})

describe('exportClipArgs (the verified command)', () => {
  it('puts -ss BEFORE -i and -to as a DURATION (end - start) after -i', () => {
    const args = exportClipArgs(base)
    const ssIdx = args.indexOf('-ss')
    const iIdx = args.indexOf('-i')
    const toIdx = args.indexOf('-to')
    expect(ssIdx).toBeGreaterThan(-1)
    expect(ssIdx).toBeLessThan(iIdx) // -ss precedes -i (fast seek + re-encode)
    expect(toIdx).toBeGreaterThan(iIdx) // -to follows -i (relative duration)
    expect(args[ssIdx + 1]).toBe('30')
    expect(args[toIdx + 1]).toBe('28.5') // 58.5 - 30, NOT the absolute end
  })

  it('emits the full videotoolbox re-encode argv (NOT -c copy)', () => {
    expect(exportClipArgs(base)).toEqual([
      '-hide_banner',
      '-y',
      '-ss',
      '30',
      '-i',
      '/src/in.mp4',
      '-to',
      '28.5',
      '-vf',
      'crop=ih*9/16:ih,scale=1080:1920',
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      '8M',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:2',
      '-nostats',
      '/out/clip.mp4'
    ])
    // Must NOT stream-copy — re-encode is required for a frame-accurate cut+crop.
    expect(exportClipArgs(base)).not.toContain('copy')
  })

  it('uses libx264 -crf 18 when forceCpu (GPU fallback, PRD §14)', () => {
    const args = exportClipArgs({ ...base, forceCpu: true })
    expect(args).toContain('libx264')
    expect(args).toContain('-crf')
    expect(args[args.indexOf('-crf') + 1]).toBe('18')
    expect(args).not.toContain('h264_videotoolbox')
  })

  it('threads an ass path into the filtergraph (caption-burn seam)', () => {
    const args = exportClipArgs({ ...base, assPath: '/t/c.ass', fontsDir: '/t/fonts' })
    expect(args[args.indexOf('-vf') + 1]).toBe(
      'crop=ih*9/16:ih,scale=1080:1920,subtitles=/t/c.ass:fontsdir=/t/fonts'
    )
  })

  it('threads a static/pan reframePlan crop into the single -vf (Part J)', () => {
    const staticArgs = exportClipArgs({
      ...base,
      reframePlan: { mode: 'static', cropW: 608, cropH: 1080, cropX: 240 }
    })
    expect(staticArgs[staticArgs.indexOf('-vf') + 1]).toBe(
      'crop=608:1080:x=240:y=0,scale=1080:1920'
    )
    const panArgs = exportClipArgs({
      ...base,
      reframePlan: { mode: 'pan', cropW: 608, cropH: 1080, xExpr: 'min(1312,200+50*t)', cropX: 240 }
    })
    expect(panArgs[panArgs.indexOf('-vf') + 1]).toBe(
      "crop=608:1080:x='min(1312,200+50*t)':y=0,scale=1080:1920"
    )
    // The cut is still the single -ss/-to (the crop reads source t).
    expect(staticArgs.indexOf('-ss')).toBeLessThan(staticArgs.indexOf('-i'))
    expect(staticArgs[staticArgs.indexOf('-to') + 1]).toBe('28.5')
  })

  it('throws on a non-positive span (caller surfaces INPUT_INVALID)', () => {
    expect(() => exportClipArgs({ ...base, startTime: 40, endTime: 40 })).toThrow(/non-positive/)
    expect(() => exportClipArgs({ ...base, startTime: 40, endTime: 10 })).toThrow(/non-positive/)
  })
})

describe('exportClipArgsMultiRange (Part I.4 jump-cuts)', () => {
  const keepRanges: [number, number][] = [
    [30, 40],
    [44, 58.5]
  ]

  it('seeks with -ss/-t and selects CLIP-RELATIVE kept spans, crop BEFORE select', () => {
    const args = exportClipArgsMultiRange({ ...base, keepRanges })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // -ss/-t rebase to clip-relative time; keep ranges are start-subtracted
    // (30→0, 40→10, 44→14, 58.5→28.5). Crop (center here) runs BEFORE select.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-ss') + 1]).toBe('30')
    // duration = 58.5 - 30 = 28.5, plus the 0.5s inclusive-boundary slack. `-t` is
    // an INPUT option here so it bounds demuxing (BUG-ery7v7); see demuxWindow().
    expect(args[args.indexOf('-t') + 1]).toBe('29')
    expect(fc).toContain(
      "[0:v]crop=ih*9/16:ih,select='between(t,0,10)+between(t,14,28.5)',setpts=N/FRAME_RATE/TB,scale=1080:1920[v]"
    )
    expect(fc).toContain("[0:a]aselect='between(t,0,10)+between(t,14,28.5)',asetpts=N/SR/TB[a]")
    expect(args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '[a]']))
    expect(args.at(-1)).toBe('/out/clip.mp4')
  })

  it('appends the subtitles burn (compressed-timeline .ass) as the last video node', () => {
    const args = exportClipArgsMultiRange({
      ...base,
      keepRanges,
      assPath: '/t/c.ass',
      fontsDir: '/t/fonts'
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('scale=1080:1920,subtitles=/t/c.ass:fontsdir=/t/fonts[v]')
  })

  it('throws without keep ranges (use the single-range path instead)', () => {
    expect(() => exportClipArgsMultiRange({ ...base })).toThrow(/keepRanges/)
  })

  it('composes a PAN crop BEFORE select so the clip-relative xExpr survives the jump-cut (Part J)', () => {
    // Crop-before-select means the pan `xExpr` reads each frame's UNcompressed
    // clip-relative `t` (correct), THEN select/setpts compress the survivors — so
    // the speaker-follow pan is preserved even while removing silences.
    const args = exportClipArgsMultiRange({
      ...base,
      keepRanges,
      reframePlan: { mode: 'pan', cropW: 608, cropH: 1080, xExpr: 'min(1312,200+50*t)', cropX: 240 }
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain(
      "[0:v]crop=608:1080:x='min(1312,200+50*t)':y=0,select='between(t,0,10)+between(t,14,28.5)',setpts=N/FRAME_RATE/TB,scale=1080:1920[v]"
    )
  })

  it('composes a static reframe crop BEFORE select in the multi-range chain (Part J)', () => {
    const args = exportClipArgsMultiRange({
      ...base,
      keepRanges,
      reframePlan: { mode: 'static', cropW: 608, cropH: 1080, cropX: 240 }
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain(
      "[0:v]crop=608:1080:x=240:y=0,select='between(t,0,10)+between(t,14,28.5)',setpts=N/FRAME_RATE/TB,scale=1080:1920[v]"
    )
  })
})

describe('exportClipArgsSplit (Part J 2-up split-screen)', () => {
  const splitPlan: ReframePlan = {
    mode: 'split',
    regions: [
      { cropX: 0, cropY: 0, cropW: 960, cropH: 540 },
      { cropX: 960, cropY: 0, cropW: 960, cropH: 540 }
    ]
  }

  it('bounds the encode with -ss/-t (NOT the whole source) and cover-fits each tile', () => {
    const args = exportClipArgsSplit({ ...base, reframePlan: splitPlan })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // CRITICAL (review fix): the split MUST be bounded to the clip span — without
    // -ss/-t it re-encoded the ENTIRE source. base is [30, 58.5] → -ss 30 -t 28.5.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-ss') + 1]).toBe('30')
    expect(args[args.indexOf('-t') + 1]).toBe('28.5') // no select chain ⇒ no slack
    expect(fc).toContain('[0:v]split=2[l][r]')
    // Cover-fit: scale up preserving aspect → center-crop to the tile (no stretch).
    expect(fc).toContain(
      '[l]crop=960:540:x=0:y=0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[lv]'
    )
    expect(fc).toContain(
      '[r]crop=960:540:x=960:y=0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[rv]'
    )
    expect(fc).toContain('[lv][rv]vstack=inputs=2[v]')
    // No jump-cut ⇒ audio mapped straight from 0:a (no aselect chain).
    expect(fc).not.toContain('aselect')
    expect(args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '0:a']))
    expect(args.at(-1)).toBe('/out/clip.mp4')
  })

  it('burns the subtitles AFTER the vstack (caption-burn order)', () => {
    const args = exportClipArgsSplit({
      ...base,
      reframePlan: splitPlan,
      assPath: '/t/c.ass',
      fontsDir: '/t/fonts'
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('[lv][rv]vstack=inputs=2,subtitles=/t/c.ass:fontsdir=/t/fonts[v]')
  })

  it('folds jump-cut select/setpts before the split and aselect on the audio', () => {
    const args = exportClipArgsSplit({
      ...base,
      reframePlan: splitPlan,
      keepRanges: [
        [30, 40],
        [44, 58.5]
      ]
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // Clip-relative keep ranges (start-subtracted) on the -ss-rebased timeline.
    expect(fc).toContain(
      "[0:v]select='between(t,0,10)+between(t,14,28.5)',setpts=N/FRAME_RATE/TB,split=2[l][r]"
    )
    expect(fc).toContain("[0:a]aselect='between(t,0,10)+between(t,14,28.5)',asetpts=N/SR/TB[a]")
    expect(args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '[a]']))
  })

  it('throws when the plan is not a split', () => {
    expect(() =>
      exportClipArgsSplit({
        ...base,
        reframePlan: { mode: 'static', cropW: 608, cropH: 1080, cropX: 0 }
      })
    ).toThrow(/split/)
    expect(() => exportClipArgsSplit({ ...base })).toThrow(/split/)
  })
})

describe('`-t` is an INPUT option so a frame-dropping filtergraph cannot read to EOF (BUG-ery7v7)', () => {
  // `select`/`aselect` DROP frames and `setpts` re-stamps the survivors, so the
  // OUTPUT timeline never reaches `duration`. An output-side `-t` therefore never
  // fires and ffmpeg demuxes the source to EOF: measured 17,880 video frames read
  // for a 30s clip instead of 953, for a byte-identical file. `-t` must bind to the
  // SOURCE input (i.e. sit before the first `-i`) so demuxing stops at the clip end.
  const keepRanges: [number, number][] = [
    [30, 40],
    [44, 58.5]
  ]

  it('multi-range: -t precedes the source -i, with slack for the inclusive boundary', () => {
    const args = exportClipArgsMultiRange({ ...base, keepRanges })
    expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'))
    // duration 28.5 + 0.5s slack. The slack is REQUIRED: an input-side `-t` bounds
    // demuxing EXCLUSIVELY, while `between(t,a,b)` is INCLUSIVE, so a bare `-t 28.5`
    // drops the frame at exactly t=28.5. Verified against real ffmpeg: `-t 29`
    // reproduces the pre-fix output byte-for-byte (same md5); `-t 28.5` is one frame
    // short. The read stays bounded either way.
    expect(args[args.indexOf('-t') + 1]).toBe('29')
  })

  it('split-screen: -t precedes the source -i', () => {
    const splitPlan: ReframePlan = {
      mode: 'split',
      regions: [
        { cropX: 0, cropY: 0, cropW: 960, cropH: 540 },
        { cropX: 960, cropY: 0, cropW: 960, cropH: 540 }
      ]
    }
    const args = exportClipArgsSplit({ ...base, keepRanges, reframePlan: splitPlan })
    expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-t') + 1]).toBe('29')
  })

  it('multi-range with a logo: -t still binds to the SOURCE input, not the logo input', () => {
    const args = exportClipArgsMultiRange({
      ...base,
      keepRanges,
      logoPath: '/brand/logo.png',
      logoPosition: 'top-right',
      logoScale: 0.2,
      logoMargin: 24
    })
    // Two `-i` in this argv. `-t` must precede BOTH, i.e. the first one.
    expect(args.filter((a) => a === '-i')).toHaveLength(2)
    expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'))
  })
})

describe('logo overlay (Part K — brand kit)', () => {
  const logoBase: ExportArgsOptions = { ...base, logoPath: '/logo.png' }
  const countInputs = (args: string[]): number => args.filter((a) => a === '-i').length

  it('no logo ⇒ single-range argv is byte-identical (still -vf, one input)', () => {
    const args = exportClipArgs(base)
    expect(args).toContain('-vf')
    expect(args).not.toContain('-filter_complex')
    expect(countInputs(args)).toBe(1)
    expect(args.join(' ')).not.toContain('overlay')
  })

  it('single cut WITH a logo switches to filter_complex + 2nd -i + -map [v]/0:a', () => {
    expect(exportClipArgs(logoBase)).toEqual([
      '-hide_banner',
      '-y',
      '-ss',
      '30',
      '-i',
      '/src/in.mp4',
      '-i',
      '/logo.png',
      '-to',
      '28.5',
      '-filter_complex',
      '[0:v]crop=ih*9/16:ih,scale=1080:1920[vbase];' +
        '[1:v]scale=194:-1[logo];' +
        '[vbase][logo]overlay=W-w-48:H-h-48[v]',
      '-map',
      '[v]',
      '-map',
      '0:a',
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      '8M',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:2',
      '-nostats',
      '/out/clip.mp4'
    ])
  })

  it('overlay sits AFTER scale and BEFORE the subtitles burn', () => {
    const args = exportClipArgs({ ...logoBase, assPath: '/t/c.ass', fontsDir: '/t/fonts' })
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(
      '[0:v]crop=ih*9/16:ih,scale=1080:1920[vbase];' +
        '[1:v]scale=194:-1[logo];' +
        '[vbase][logo]overlay=W-w-48:H-h-48[vov];' +
        '[vov]subtitles=/t/c.ass:fontsdir=/t/fonts[v]'
    )
  })

  it('pins the logo to each corner with the margin inset', () => {
    const xy = (position: ExportArgsOptions['logoPosition']): string => {
      const a = exportClipArgs({ ...logoBase, logoPosition: position })
      return a[a.indexOf('-filter_complex') + 1]
    }
    expect(xy('top-left')).toContain('overlay=48:48[v]')
    expect(xy('top-right')).toContain('overlay=W-w-48:48[v]')
    expect(xy('bottom-left')).toContain('overlay=48:H-h-48[v]')
    expect(xy('bottom-right')).toContain('overlay=W-w-48:H-h-48[v]')
  })

  it('scales the logo to round(logoScale * outputWidth) with a custom margin', () => {
    const args = exportClipArgs({ ...logoBase, logoScale: 0.25, logoMargin: 20 })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('[1:v]scale=270:-1[logo]') // round(0.25 * 1080)
    expect(fc).toContain('overlay=W-w-20:H-h-20[v]')
  })

  it('multi-range WITH a logo overlays after scale, keeps the aselect audio chain', () => {
    const args = exportClipArgsMultiRange({
      ...logoBase,
      keepRanges: [
        [30, 40],
        [44, 58.5]
      ]
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(countInputs(args)).toBe(2)
    expect(fc).toContain(
      "[0:v]crop=ih*9/16:ih,select='between(t,0,10)+between(t,14,28.5)'," +
        'setpts=N/FRAME_RATE/TB,scale=1080:1920[vbase];' +
        '[1:v]scale=194:-1[logo];[vbase][logo]overlay=W-w-48:H-h-48[v]'
    )
    expect(fc).toContain("[0:a]aselect='between(t,0,10)+between(t,14,28.5)',asetpts=N/SR/TB[a]")
    expect(args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '[a]']))
  })

  it('split WITH a logo overlays AFTER the vstack and before subtitles', () => {
    const splitPlan: ReframePlan = {
      mode: 'split',
      regions: [
        { cropX: 0, cropY: 0, cropW: 960, cropH: 540 },
        { cropX: 960, cropY: 0, cropW: 960, cropH: 540 }
      ]
    }
    const args = exportClipArgsSplit({ ...logoBase, reframePlan: splitPlan })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(countInputs(args)).toBe(2)
    expect(fc).toContain(
      '[lv][rv]vstack=inputs=2[vbase];' +
        '[1:v]scale=194:-1[logo];' +
        '[vbase][logo]overlay=W-w-48:H-h-48[v]'
    )
    expect(args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '0:a']))
  })

  it('no logo ⇒ multi-range and split graphs contain no overlay / 2nd input', () => {
    const kr: [number, number][] = [
      [30, 40],
      [44, 58.5]
    ]
    const mr = exportClipArgsMultiRange({ ...base, keepRanges: kr })
    expect(countInputs(mr)).toBe(1)
    expect(mr[mr.indexOf('-filter_complex') + 1]).not.toContain('overlay')
    const sp = exportClipArgsSplit({
      ...base,
      reframePlan: {
        mode: 'split',
        regions: [
          { cropX: 0, cropY: 0, cropW: 960, cropH: 540 },
          { cropX: 960, cropY: 0, cropW: 960, cropH: 540 }
        ]
      }
    })
    expect(countInputs(sp)).toBe(1)
    expect(sp[sp.indexOf('-filter_complex') + 1]).not.toContain('overlay')
  })
})

describe('thumbnailArgs', () => {
  it('grabs a single reframed frame (-vframes 1) at the given time', () => {
    expect(
      thumbnailArgs({
        sourcePath: '/src/in.mp4',
        outputPath: '/out/thumb.jpg',
        atTime: 31.2,
        aspectRatio: '9:16'
      })
    ).toEqual([
      '-hide_banner',
      '-y',
      '-ss',
      '31.2',
      '-i',
      '/src/in.mp4',
      '-vframes',
      '1',
      '-vf',
      'crop=ih*9/16:ih,scale=1080:1920',
      '/out/thumb.jpg'
    ])
  })
})

describe('codecArgs: pix_fmt + quality-aware CPU CRF (audit fixes openclip-ucs/ixa/6fz)', () => {
  it('pins -pix_fmt yuv420p on BOTH the videotoolbox and the libx264 branch (openclip-ucs)', () => {
    const gpu = codecArgs({ quality: '1080p' })
    expect(gpu).toContain('h264_videotoolbox')
    expect(gpu.slice(gpu.indexOf('-pix_fmt'))).toEqual(['-pix_fmt', 'yuv420p'])
    const cpu = codecArgs({ quality: '1080p', forceCpu: true })
    expect(cpu).toContain('libx264')
    expect(cpu.slice(cpu.indexOf('-pix_fmt'))).toEqual(['-pix_fmt', 'yuv420p'])
  })

  it('forceCpu maps quality to a CRF so 720p is not encoded near-1080p (openclip-ixa)', () => {
    const cpu720 = exportClipArgs({ ...base, quality: '720p', forceCpu: true })
    expect(cpu720[cpu720.indexOf('-crf') + 1]).toBe('23')
    const cpu1080 = exportClipArgs({ ...base, quality: '1080p', forceCpu: true })
    expect(cpu1080[cpu1080.indexOf('-crf') + 1]).toBe('18')
  })

  it('every export argv carries -pix_fmt yuv420p across all three builders', () => {
    expect(exportClipArgs(base)).toContain('yuv420p')
    expect(
      exportClipArgsMultiRange({
        ...base,
        keepRanges: [
          [30, 40],
          [44, 58.5]
        ]
      })
    ).toContain('yuv420p')
    expect(
      exportClipArgsSplit({
        ...base,
        reframePlan: {
          mode: 'split',
          regions: [
            { cropX: 0, cropY: 0, cropW: 960, cropH: 540 },
            { cropX: 960, cropY: 0, cropW: 960, cropH: 540 }
          ]
        }
      })
    ).toContain('yuv420p')
  })
})

describe('option-injection guard on path args (audit fix openclip-6l6)', () => {
  it('exportClipArgs refuses an outputPath that begins with a dash', () => {
    expect(() => exportClipArgs({ ...base, outputPath: '-y' })).toThrow(/outputPath/)
  })
})

describe('escapeFilterPath: full filtergraph special-char set (audit fix openclip-5ir/uas)', () => {
  it('backslash-escapes : , ; [ ] and the quote so a bracketed/comma path cannot split the graph', () => {
    // A perfectly ordinary macOS path with brackets, a comma and a colon.
    const p = '/Users/x/My [Clips]/a, b/clip:1.ass'
    const esc = escapeFilterPath(p)
    expect(esc).toBe('/Users/x/My \\[Clips\\]/a\\, b/clip\\:1.ass')
    // Embedded in a -vf, none of the filtergraph separators survive UN-escaped: every
    // [ ] , ; : in the value is preceded by a backslash.
    const vf = buildVf({ aspectRatio: '9:16', assPath: p })
    const valueStart = vf.indexOf('subtitles=') + 'subtitles='.length
    const value = vf.slice(valueStart)
    for (const i in [...value]) {
      const ch = value[i]
      if (',;[]:'.includes(ch)) {
        expect(value[Number(i) - 1]).toBe('\\')
      }
    }
  })

  it('escapes the backslash FIRST so added escapes are not double-escaped', () => {
    expect(escapeFilterPath('a\\b')).toBe('a\\\\b')
  })
})

describe('exportClipArgsSplit honours the chosen aspect ratio (audit fix openclip-omd)', () => {
  const splitPlan: ReframePlan = {
    mode: 'split',
    regions: [
      { cropX: 0, cropY: 0, cropW: 960, cropH: 540 },
      { cropX: 960, cropY: 0, cropW: 960, cropH: 540 }
    ]
  }

  it('derives the tile size from outputDimensions(aspect) for 4:5 (1080×675 tiles → 1080×1350)', () => {
    const args = exportClipArgsSplit({ ...base, aspectRatio: '4:5', reframePlan: splitPlan })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // 4:5 → 1080×1350 output ⇒ each tile is 1080×675.
    expect(fc).toContain('scale=1080:675:force_original_aspect_ratio=increase,crop=1080:675')
    expect(fc).not.toContain('scale=1080:960') // no longer the hard-coded 9:16 tile
  })

  it('keeps the 9:16 tiles (1080×960) when the aspect is 9:16 (golden unchanged)', () => {
    const args = exportClipArgsSplit({ ...base, aspectRatio: '9:16', reframePlan: splitPlan })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960')
  })
})

describe('exportClip writes the output atomically (audit fix openclip-8dg)', () => {
  it('encodes to a sibling temp and renames onto outputPath only on success (no leftover)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-export-'))
    const out = join(dir, 'clip.mp4')
    try {
      const fakeRun = async (o: { args: string[] }): Promise<{ code: number; stderr: string }> => {
        const target = o.args[o.args.length - 1]
        expect(target).not.toBe(out) // ffmpeg writes to a temp, NOT the user's path
        writeFileSync(target, 'MP4')
        return { code: 0, stderr: '' }
      }
      const res = await exportClip({ ...base, outputPath: out, runFfmpeg: fakeRun })
      expect(res.outputPath).toBe(out)
      expect(existsSync(out)).toBe(true)
      expect(readdirSync(dir)).toEqual(['clip.mp4']) // no leftover .part temp
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves NO truncated file at outputPath when the encode fails/cancels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-export-'))
    const out = join(dir, 'clip.mp4')
    try {
      const fakeRun = async (o: { args: string[] }): Promise<never> => {
        writeFileSync(o.args[o.args.length - 1], 'PARTIAL') // killed mid-encode
        throw new Error('ffmpeg aborted')
      }
      await expect(exportClip({ ...base, outputPath: out, runFfmpeg: fakeRun })).rejects.toThrow(
        /aborted/
      )
      expect(existsSync(out)).toBe(false) // user's folder never shows a broken clip
      expect(readdirSync(dir)).toEqual([]) // the temp partial is cleaned too
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ============================================================================
// export-runner glue (injected fake export service — no real ffmpeg)
// ============================================================================

function fakeEmitter(): { emit: JobEmitter<'export'>; events: unknown[] } {
  const events: unknown[] = []
  const emit: JobEmitter<'export'> = {
    progress: (pct, stage, etaMs) => events.push({ t: 'progress', pct, stage, etaMs }),
    partial: (data) => events.push({ t: 'partial', data }),
    done: (result) => events.push({ t: 'done', result }),
    error: (code, message, retriable) => events.push({ t: 'error', code, message, retriable })
  }
  return { emit, events }
}

function fakeCtx(): JobRunnerContext {
  return { signal: new AbortController().signal, trackPid: () => {}, jobId: 'export-test-1' }
}

const params: JobParams['export'] = {
  projectId: 'p1',
  clipId: 'clip-1',
  sourcePath: '/src/in.mp4',
  startTime: 30,
  endTime: 58.5,
  aspectRatio: '9:16',
  outputPath: '/out/clip.mp4',
  quality: '1080p'
}

describe('createExportRunner', () => {
  it('registers the encode child PID via ctx.trackPid (audit fix openclip-a00)', async () => {
    const tracked: number[] = []
    const exportClip = vi.fn(async (o: { onSpawn?: (pid: number) => void }) => {
      o.onSpawn?.(4242) // the real exportClip forwards ffmpeg's child.pid here
      return { outputPath: '/out/clip.mp4', width: 1080, height: 1920, durationMs: 1000 }
    })
    const runner = createExportRunner({ exportClip })
    const ctx: JobRunnerContext = {
      signal: new AbortController().signal,
      trackPid: (pid) => tracked.push(pid),
      jobId: 'export-test-pid'
    }
    await runner(params, fakeEmitter().emit, ctx)
    expect(tracked).toContain(4242) // kill-on-quit now has an OS-level backstop for export
  })

  it('streams 0→100 progress and returns the export result', async () => {
    const exportClip = vi.fn(async (o: { onProgress?: (p: number) => void }) => {
      o.onProgress?.(50)
      return { outputPath: '/out/clip.mp4', width: 1080, height: 1920, durationMs: 28_500 }
    })
    const runner = createExportRunner({ exportClip })
    const { emit, events } = fakeEmitter()

    const result = await runner(params, emit, fakeCtx())

    expect(result).toEqual({
      outputPath: '/out/clip.mp4',
      width: 1080,
      height: 1920,
      durationMs: 28_500
    })
    // It passed the resolved span + aspect through to the export service.
    expect(exportClip).toHaveBeenCalledWith(
      expect.objectContaining({
        startTime: 30,
        endTime: 58.5,
        aspectRatio: '9:16',
        outputPath: '/out/clip.mp4',
        quality: '1080p'
      })
    )
    // Emitted at least an initial, a mid (50), and a final (100) progress.
    const pcts = events
      .filter((e): e is { t: 'progress'; pct: number } => (e as { t: string }).t === 'progress')
      .map((e) => e.pct)
    expect(pcts).toContain(0)
    expect(pcts).toContain(50)
    expect(pcts).toContain(100)
  })

  it('only resolves fontsdir when burning captions (assPath set)', async () => {
    const exportClip = vi.fn(async () => ({
      outputPath: '/out/clip.mp4',
      width: 1080,
      height: 1920,
      durationMs: 1000
    }))
    const fontsDir = vi.fn(() => '/fonts')
    const runner = createExportRunner({ exportClip, fontsDir })

    await runner(params, fakeEmitter().emit, fakeCtx())
    expect(fontsDir).not.toHaveBeenCalled()
    expect(exportClip).toHaveBeenLastCalledWith(expect.objectContaining({ fontsDir: undefined }))

    await runner({ ...params, assPath: '/t/c.ass' }, fakeEmitter().emit, fakeCtx())
    expect(fontsDir).toHaveBeenCalled()
    expect(exportClip).toHaveBeenLastCalledWith(
      expect.objectContaining({ assPath: '/t/c.ass', fontsDir: '/fonts' })
    )
  })

  it('propagates a service failure (manager maps it to a typed error)', async () => {
    const runner = createExportRunner({
      exportClip: async () => {
        throw new Error('ffmpeg exited with code 1')
      }
    })
    await expect(runner(params, fakeEmitter().emit, fakeCtx())).rejects.toThrow(/code 1/)
  })
})
