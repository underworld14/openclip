// @vitest-environment jsdom
/**
 * tests/unit/preview-fitmode.spec.tsx — the preview actually shows the
 * chosen framing (EPIC-k83ghw / BUG-t19z5j).
 *
 * Before this, `fitMode` was read by nothing in PreviewPlayer: "Fit (bars)"
 * and "Fit (blur)" changed nothing on screen, and the export then produced a
 * DIFFERENT picture than what was shown. The split-screen tile MATH is
 * covered declaratively in preview-crop.spec.ts (`coverFitTransform`); this
 * file pins the INTEGRATION — which mode renders which CSS on the real
 * `<video>` elements — without depending on jsdom's non-existent layout
 * engine for actual pixel measurements.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { installRendererEnv } from '../harness/renderer-env'
import { useProjectStore } from '@renderer/stores/projectStore'
import { PreviewPlayer } from '@renderer/components/PreviewPlayer'
import { projectFixture, clipFixture } from '../fixtures/contract'

const SOURCE = { width: 1920, height: 1080 }

function seed(fitMode?: 'fill' | 'letterbox' | 'blur'): void {
  useProjectStore.setState({
    currentProject: {
      ...projectFixture,
      sourceVideo: { ...projectFixture.sourceVideo, path: '/tmp/v.mp4', resolution: SOURCE },
      settings: { ...projectFixture.settings, fitMode }
    },
    clips: [
      {
        ...clipFixture,
        id: 'c1',
        startTime: 0,
        endTime: 20,
        editedStart: undefined,
        editedEnd: undefined
      }
    ],
    selectedClipId: 'c1',
    playhead: 0,
    reframeMode: 'off',
    reframePlan: null,
    reframePlanFor: null,
    reframePlanLoading: false,
    reframePlanError: null
  })
}

beforeEach(() => {
  installRendererEnv()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('fitMode: fill (default) — unchanged from before this ticket', () => {
  it('renders the historical translateX centre-crop, and hides the shadow layer', () => {
    seed('fill')
    render(<PreviewPlayer />)
    const video = screen.getByTestId('preview-video') as HTMLVideoElement
    expect(video.style.transform).toContain('translateX')
    expect(video.style.objectFit).toBe('')
    const shadowWrapper = screen.getByTestId('preview-video-shadow').parentElement as HTMLElement
    expect(shadowWrapper.style.display).toBe('none')
  })
})

describe('fitMode: letterbox', () => {
  it('sizes the video with object-fit: contain instead of cropping', () => {
    seed('letterbox')
    render(<PreviewPlayer />)
    const video = screen.getByTestId('preview-video') as HTMLVideoElement
    expect(video.style.objectFit).toBe('contain')
    expect(video.style.width).toBe('100%')
    expect(video.style.height).toBe('100%')
    // No centre-crop transform left over from the fill branch.
    expect(video.style.transform).toBe('')
    const shadowWrapper = screen.getByTestId('preview-video-shadow').parentElement as HTMLElement
    expect(shadowWrapper.style.display).toBe('none')
  })
})

describe('fitMode: blur', () => {
  it('shows a blurred COVER background behind a contain-fit foreground', () => {
    seed('blur')
    render(<PreviewPlayer />)
    const foreground = screen.getByTestId('preview-video') as HTMLVideoElement
    expect(foreground.style.objectFit).toBe('contain')

    const background = screen.getByTestId('preview-video-shadow') as HTMLVideoElement
    expect(background.style.objectFit).toBe('cover')
    expect(background.style.filter).toContain('blur')
    // Scaled up past `cover` so the blur never samples the (already
    // cropped-away) source edge and shows a hard seam.
    expect(background.style.transform).toContain('scale')

    const backgroundWrapper = background.parentElement as HTMLElement
    expect(backgroundWrapper.style.display).not.toBe('none')
    // Background paints behind the foreground.
    const foregroundWrapper = foreground.parentElement as HTMLElement
    expect(Number(foregroundWrapper.style.zIndex)).toBeGreaterThan(
      Number(backgroundWrapper.style.zIndex)
    )
  })
})

describe('reframeMode: split (frame not yet measured — jsdom has no real layout)', () => {
  it('degrades gracefully to the fill-style centre crop rather than NaN/undefined styles', () => {
    // ResizeObserver is stubbed as a no-op in the test harness (jsdom has no
    // layout engine to actually observe), so `frameSize` never populates —
    // exactly the "before the first measurement" case the component must
    // handle safely on every real mount too.
    seed('fill')
    useProjectStore.setState({ reframeMode: 'split' })
    render(<PreviewPlayer />)
    const video = screen.getByTestId('preview-video') as HTMLVideoElement
    // Falls through to the historical transform — no NaN, no crash, nothing
    // visually broken while waiting for the first real measurement.
    expect(video.style.transform).toContain('translateX')
    expect(video.style.transform).not.toContain('NaN')
  })
})

describe('reframeMode: split, WITH a measured frame (real ResizeObserver callback)', () => {
  const realFrameSize = { width: 400, height: 711 } // ~9:16

  // The shared harness stubs ResizeObserver as a no-op (jsdom has no layout
  // engine to drive a REAL one) — this file-local mock fires its callback
  // once with a concrete size so the split-tile MATH (already proven
  // correct in preview-crop.spec.ts) is exercised end-to-end through the
  // component too, not just the pure function in isolation.
  let originalRO: typeof globalThis.ResizeObserver
  beforeEach(() => {
    originalRO = globalThis.ResizeObserver
    class FiringResizeObserver {
      #cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.#cb = cb
      }
      observe(): void {
        this.#cb(
          [{ contentRect: realFrameSize } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        )
      }
      unobserve(): void {
        // no-op
      }
      disconnect(): void {
        // no-op
      }
    }
    globalThis.ResizeObserver = FiringResizeObserver as unknown as typeof ResizeObserver
  })
  afterEach(() => {
    globalThis.ResizeObserver = originalRO
  })

  it('renders two REAL (non-degenerate) tiles, each sized/positioned by coverFitTransform', async () => {
    seed('fill')
    const bridge = (window as unknown as { openclip: { video: { planReframe: unknown } } }).openclip
    bridge.video.planReframe = (async () => ({
      plan: {
        mode: 'split',
        regions: [
          { cropX: 0, cropY: 0, cropW: 960, cropH: 1080 },
          { cropX: 960, cropY: 0, cropW: 960, cropH: 1080 }
        ]
      }
    })) as never
    useProjectStore.setState({ reframeMode: 'split' })
    render(<PreviewPlayer />)
    await waitFor(() => expect(useProjectStore.getState().reframePlan?.mode).toBe('split'))

    const top = screen.getByTestId('preview-video') as HTMLVideoElement
    const bottom = screen.getByTestId('preview-video-shadow') as HTMLVideoElement
    const topWrapper = top.parentElement as HTMLElement
    const bottomWrapper = bottom.parentElement as HTMLElement

    // Two stacked, non-overlapping, non-hidden tiles.
    expect(topWrapper.style.display).not.toBe('none')
    expect(bottomWrapper.style.display).not.toBe('none')
    expect(topWrapper.style.top).toBe('0px')
    expect(bottomWrapper.style.top).toBe('50%')
    expect(topWrapper.style.height).toBe('50%')

    // Each video is sized/positioned by the SAME coverFitTransform this
    // suite pins independently — never zero, never NaN.
    for (const v of [top, bottom]) {
      expect(v.style.width).not.toBe('')
      expect(v.style.width).not.toContain('NaN')
      expect(Number.parseFloat(v.style.width)).toBeGreaterThan(0)
      expect(Number.parseFloat(v.style.height)).toBeGreaterThan(0)
      expect(v.style.transform).toContain('translate(')
    }
  })
})
