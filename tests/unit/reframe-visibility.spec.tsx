// @vitest-environment jsdom
/**
 * tests/unit/reframe-visibility.spec.tsx — auto-reframe is something you can SEE
 * (FEAT-kzej8t).
 *
 * It was an invisible on/off switch. The preview's crop was CSS-only and did not
 * change at all when reframing was on — it just showed a badge reading
 * "Auto-reframe on export". So the user could not see the face-follow, could not
 * tell it had locked onto the wrong speaker, and found out only after paying for
 * an export. Detection failure degraded to a centre crop in silence (each pass
 * wrapped in its own try/catch), which made "the ONNX model is missing" and
 * "this clip has no faces" indistinguishable — and both look exactly like the
 * feature doing nothing.
 *
 * Four things are pinned:
 *
 *  1. `cropXAt` interpolates the pan the way the burn does. A preview that
 *     stepped where the export slides would misrepresent the one thing it exists
 *     to show.
 *  2. The preview element actually MOVES, and does not when reframing is off.
 *  3. The badge names the state — following, locked, no face, or failed.
 *  4. The impossible framing combination is unrepresentable, not warned about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { installRendererEnv } from '../harness/renderer-env'
import { useProjectStore } from '@renderer/stores/projectStore'
import { PreviewPlayer } from '@renderer/components/PreviewPlayer'
import { Timeline } from '@renderer/components/Timeline'
import { cropXAt, type ReframePlan } from '@shared/reframe-plan'
import { FRAMING_MODES, framingMode, framingModeFor } from '@shared/framing-modes'
import { projectFixture, clipFixture } from '../fixtures/contract'

const SOURCE = { width: 1920, height: 1080 }

const PAN: ReframePlan = {
  mode: 'pan',
  cropW: 608,
  cropH: 1080,
  xExpr: 'ignored-by-the-preview',
  cropX: 656,
  keyframes: [
    { t: 0, x: 100 },
    { t: 10, x: 1100 }
  ]
}

const STATIC: ReframePlan = { mode: 'static', cropW: 608, cropH: 1080, cropX: 300 }

function seed(over: Partial<Parameters<typeof useProjectStore.setState>[0]> = {}): void {
  useProjectStore.setState({
    currentProject: {
      ...projectFixture,
      sourceVideo: { ...projectFixture.sourceVideo, path: '/tmp/v.mp4', resolution: SOURCE }
    },
    // `editedStart`/`editedEnd` cleared explicitly: `clipFixture` ships a trim,
    // and `resolveBounds` would then put this clip at 13-40s — so a playhead of
    // 10 lands BEFORE the clip and every pan position clamps to the first
    // keyframe, making the preview look stuck when it is working correctly.
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
    // Reset the plan fields explicitly: the store is a module singleton, and a
    // leftover `reframePlanLoading: true` from a previous test makes
    // `loadReframePlan` return early — every later test would then silently
    // assert against a stale plan.
    reframePlan: null,
    reframePlanFor: null,
    reframePlanLoading: false,
    reframePlanError: null,
    ...over
  })
}

beforeEach(() => {
  installRendererEnv()
  seed()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('cropXAt: where the crop sits at a moment', () => {
  it('is the fixed position for a static plan, at any time', () => {
    expect(cropXAt(STATIC, 0)).toBe(300)
    expect(cropXAt(STATIC, 999)).toBe(300)
  })

  it('INTERPOLATES between pan keyframes', () => {
    // The burn slides (`buildLinearPanExpr` lerps). A preview that stepped would
    // misrepresent the motion it exists to show.
    expect(cropXAt(PAN, 0)).toBe(100)
    expect(cropXAt(PAN, 5)).toBe(600)
    expect(cropXAt(PAN, 10)).toBe(1100)
  })

  it('clamps outside the keyframe range rather than extrapolating', () => {
    expect(cropXAt(PAN, -5)).toBe(100)
    expect(cropXAt(PAN, 99)).toBe(1100)
  })

  it('returns null for a split plan — two tiles, not one window', () => {
    expect(
      cropXAt(
        {
          mode: 'split',
          regions: [
            { cropX: 0, cropY: 0, cropW: 100, cropH: 100 },
            { cropX: 100, cropY: 0, cropW: 100, cropH: 100 }
          ]
        },
        1
      )
    ).toBeNull()
  })

  it('falls back to cropX for a pan with no keyframes', () => {
    // A plan deserialised from a cache entry written before keyframes existed.
    const legacy: ReframePlan = { ...PAN, keyframes: undefined }
    expect(cropXAt(legacy, 5)).toBe(656)
  })

  it('returns null for no plan at all', () => {
    expect(cropXAt(null, 1)).toBeNull()
    expect(cropXAt(undefined, 1)).toBeNull()
  })

  it('takes the later position across coincident keyframes (a cut)', () => {
    const cut: ReframePlan = {
      ...PAN,
      keyframes: [
        { t: 0, x: 100 },
        { t: 5, x: 100 },
        { t: 5, x: 900 }
      ]
    }
    expect(cropXAt(cut, 5)).toBe(900)
  })
})

describe('the preview MOVES with the plan', () => {
  const shiftOf = (): string => (screen.getByTestId('preview-video') as HTMLElement).style.transform

  /**
   * Render with a stubbed plan FETCH, not a seeded store value.
   *
   * The component asks main for the plan on mount, so a directly-seeded
   * `reframePlan` is overwritten the moment that resolves — a test that seeded
   * it would be racing the very code path under test.
   */
  async function renderWithPlan(plan: ReframePlan | null, mode: 'auto' | 'split'): Promise<void> {
    window.openclip.video.planReframe = (async () => ({ plan })) as never
    useProjectStore.setState({ reframeMode: mode })
    render(<PreviewPlayer />)
    await waitFor(() => expect(useProjectStore.getState().reframePlan).toEqual(plan))
  }

  it('is the plain centre crop when reframing is off', () => {
    // The historical transform, unchanged — reframing off must cost nothing.
    useProjectStore.setState({ reframeMode: 'off', reframePlan: null })
    render(<PreviewPlayer />)
    expect(shiftOf()).toContain('-50% + 0.000%')
  })

  it('shifts toward the plan’s crop window', async () => {
    // cropX 300 + cropW/2 = 604; frame centre 960; (604-960)/1920 = -18.5%,
    // negated → the element moves right so the crop window is what you see.
    await renderWithPlan(STATIC, 'auto')
    await waitFor(() => expect(shiftOf()).toContain('18.542%'))
  })

  it('FOLLOWS the playhead through a pan', async () => {
    await renderWithPlan(PAN, 'auto')
    await waitFor(() => expect(shiftOf()).toContain('28.958%'))
    const atStart = shiftOf()
    await act(async () => {
      useProjectStore.setState({ playhead: 10 })
    })
    // The whole point: the crop is somewhere else ten seconds in. `waitFor`
    // because PreviewPlayer also syncs the <video> element's currentTime on the
    // same state, so the render that matters is not always the first one.
    await waitFor(() => expect(shiftOf()).not.toBe(atStart))
    // …and it is the position the plan says, not just "different".
    expect(shiftOf()).toContain('-23.125%')
  })

  it('does not shift for a split plan', async () => {
    await renderWithPlan(
      {
        mode: 'split',
        regions: [
          { cropX: 0, cropY: 0, cropW: 960, cropH: 1080 },
          { cropX: 960, cropY: 0, cropW: 960, cropH: 1080 }
        ]
      },
      'split'
    )
    expect(shiftOf()).toContain('-50% + 0.000%')
  })
})

describe('the badge says what is happening', () => {
  const state = (): string | null =>
    screen.getByTestId('reframe-badge').getAttribute('data-reframe-state')

  it('is absent entirely when reframing is off', () => {
    useProjectStore.setState({ reframeMode: 'off' })
    render(<PreviewPlayer />)
    expect(screen.queryByTestId('reframe-badge')).toBeNull()
  })

  it('reports the plan’s mode', async () => {
    window.openclip.video.planReframe = (async () => ({ plan: PAN })) as never
    useProjectStore.setState({ reframeMode: 'auto' })
    render(<PreviewPlayer />)
    await waitFor(() => expect(state()).toBe('pan'))
    expect(screen.getByTestId('reframe-badge').textContent).toMatch(/following/i)
  })

  it('distinguishes NO FACE from DETECTION FAILURE', async () => {
    // These used to be indistinguishable: both silently became a centre crop, so
    // a missing ONNX model looked exactly like a clip with nobody in it.
    window.openclip.video.planReframe = (async () => ({ plan: null, reason: 'no-face' })) as never
    useProjectStore.setState({ reframeMode: 'auto' })
    const { unmount } = render(<PreviewPlayer />)
    await waitFor(() => expect(state()).toBe('no-face'))
    expect(screen.getByTestId('reframe-badge').textContent).toMatch(/no face/i)
    unmount()

    seed()
    window.openclip.video.planReframe = (async () => ({
      plan: null,
      reason: 'detect-failed',
      message: 'onnx model missing'
    })) as never
    useProjectStore.setState({ reframeMode: 'auto' })
    render(<PreviewPlayer />)
    await waitFor(() => expect(state()).toBe('detect-failed'))
    expect(screen.getByTestId('reframe-badge').textContent).toMatch(/failed/i)
    // The cause is available, not buried in a log the user will never read.
    expect(screen.getByTestId('reframe-badge').getAttribute('title')).toBe('onnx model missing')
  })

  it('says it is still working while the plan is being computed', () => {
    // A never-settling fetch: the badge must not read as "no face" while the
    // analysis is simply still running.
    window.openclip.video.planReframe = (() => new Promise(() => {})) as never
    useProjectStore.setState({ reframeMode: 'auto' })
    render(<PreviewPlayer />)
    expect(state()).toBe('pending')
  })
})

describe('the plan is fetched, once, and refetched when it changes', () => {
  it('asks main for the plan when reframing is on', async () => {
    // The request is captured rather than read off `mock.calls`, whose element
    // type vitest widens to `never[]` for a zero-arg fn signature.
    const seen: { clipId: string; mode: string }[] = []
    window.openclip.video.planReframe = (async (req: { clipId: string; mode: string }) => {
      seen.push(req)
      return { plan: STATIC }
    }) as never
    useProjectStore.setState({ reframeMode: 'auto' })
    render(<PreviewPlayer />)
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ clipId: 'c1', mode: 'auto' })
    await waitFor(() => expect(useProjectStore.getState().reframePlan).toEqual(STATIC))
  })

  it('does NOT ask when reframing is off', () => {
    const planReframe = vi.fn(async () => ({ plan: null }))
    window.openclip.video.planReframe = planReframe as never
    useProjectStore.setState({ reframeMode: 'off' })
    render(<PreviewPlayer />)
    expect(planReframe).not.toHaveBeenCalled()
  })

  it('reports a rejected IPC as a detection failure rather than swallowing it', async () => {
    window.openclip.video.planReframe = (async () => {
      throw new Error('sidecar gone')
    }) as never
    useProjectStore.setState({ reframeMode: 'auto' })
    render(<PreviewPlayer />)
    await waitFor(() =>
      expect(useProjectStore.getState().reframePlanError?.reason).toBe('detect-failed')
    )
    expect(useProjectStore.getState().reframePlanError?.message).toContain('sidecar gone')
  })

  it('drops the plan when the MODE changes — auto and split are different plans', () => {
    useProjectStore.setState({ reframeMode: 'auto', reframePlan: STATIC, reframePlanFor: 'x' })
    act(() => {
      useProjectStore.getState().setReframeMode('split')
    })
    expect(useProjectStore.getState().reframePlan).toBeNull()
    expect(useProjectStore.getState().reframePlanFor).toBeNull()
  })
})

describe('the timeline shows WHERE the crop moves', () => {
  /**
   * Seeded directly here, and the plan FETCH is not involved: the Timeline is a
   * pure consumer of `reframePlan`, and PreviewPlayer (which owns the fetch) is
   * not mounted in these renders.
   */
  const seedPlan = (plan: ReframePlan | null): void => {
    useProjectStore.setState({ reframeMode: 'auto', reframePlan: plan, reframePlanFor: 'seeded' })
  }

  it('draws a dot per pan keyframe', () => {
    // The computed plan was invisible: reframing was either on or off, with no
    // way to see where the crop swings or when.
    seedPlan({
      mode: 'pan',
      cropW: 608,
      cropH: 1080,
      xExpr: 'x',
      cropX: 656,
      keyframes: [
        { t: 0, x: 100 },
        { t: 5, x: 600 },
        { t: 10, x: 1100 }
      ]
    })
    render(<Timeline />)
    expect(screen.getAllByTestId('reframe-keyframe')).toHaveLength(3)
  })

  it('positions each dot at its clip-relative time on the SOURCE timeline', () => {
    // The plan's times are clip-relative; the track is source-absolute. Drawing
    // them without rebasing would put every dot in the wrong place on a trimmed
    // clip — and look plausible on an untrimmed one.
    useProjectStore.setState({
      clips: [
        {
          ...clipFixture,
          id: 'c1',
          startTime: 10,
          endTime: 30,
          editedStart: undefined,
          editedEnd: undefined
        }
      ],
      selectedClipId: 'c1'
    })
    seedPlan({
      mode: 'pan',
      cropW: 608,
      cropH: 1080,
      xExpr: 'x',
      cropX: 656,
      keyframes: [{ t: 5, x: 600 }]
    })
    render(<Timeline />)
    const dot = screen.getByTestId('reframe-keyframe')
    // Source duration 3600 (projectFixture); t=5 within a clip starting at 10s
    // is 15s absolute → 15/3600 = 0.4167%.
    const left = Number.parseFloat(dot.style.left)
    expect(left).toBeCloseTo((15 / projectFixture.sourceVideo.duration) * 100, 3)
  })

  it('draws nothing for a static or split plan, or none at all', () => {
    for (const plan of [
      { mode: 'static', cropW: 608, cropH: 1080, cropX: 300 } as ReframePlan,
      null
    ]) {
      seedPlan(plan)
      const { unmount } = render(<Timeline />)
      expect(screen.queryAllByTestId('reframe-keyframe')).toHaveLength(0)
      unmount()
    }
  })

  it('omits a keyframe that falls outside the trimmed clip', () => {
    // A trim can move the bounds inside a plan computed for a wider span; a dot
    // drawn past the OUT point would claim the crop moves somewhere it never plays.
    useProjectStore.setState({
      clips: [
        {
          ...clipFixture,
          id: 'c1',
          startTime: 0,
          endTime: 6,
          editedStart: undefined,
          editedEnd: undefined
        }
      ],
      selectedClipId: 'c1'
    })
    seedPlan({
      mode: 'pan',
      cropW: 608,
      cropH: 1080,
      xExpr: 'x',
      cropX: 656,
      keyframes: [
        { t: 1, x: 100 },
        { t: 50, x: 900 }
      ]
    })
    render(<Timeline />)
    expect(screen.getAllByTestId('reframe-keyframe')).toHaveLength(1)
  })
})

describe('one framing control, not two that fight', () => {
  it('offers the named modes', () => {
    expect(FRAMING_MODES.map((m) => m.id)).toEqual(['fill', 'follow', 'split', 'letterbox', 'blur'])
  })

  it('makes the impossible combination UNREPRESENTABLE', () => {
    // "Fit" + "Follow speaker" asks for a crop to move inside a letterboxed
    // frame, which has none. The old panel allowed it and then warned that one
    // of the user's two choices would be ignored.
    for (const m of FRAMING_MODES) {
      if (m.fitMode !== 'fill') expect(m.reframe, m.id).toBe('off')
      if (m.reframe !== 'off') expect(m.fitMode, m.id).toBe('fill')
    }
  })

  it('recovers the mode from a project’s two persisted fields', () => {
    expect(framingModeFor('fill', 'off')).toBe('fill')
    expect(framingModeFor('fill', 'auto')).toBe('follow')
    expect(framingModeFor('fill', 'split')).toBe('split')
    expect(framingModeFor('letterbox', 'off')).toBe('letterbox')
    expect(framingModeFor('blur', 'off')).toBe('blur')
    expect(framingModeFor(undefined, undefined)).toBe('fill')
  })

  it('resolves a legacy IMPOSSIBLE pair to what the export really did', () => {
    // `fitChain` ignores a reframe plan in any non-fill mode and the runner
    // skips the analysis, so the fit is the half that was actually honoured.
    expect(framingModeFor('letterbox', 'auto')).toBe('letterbox')
    expect(framingModeFor('blur', 'split')).toBe('blur')
  })

  it('gives every mode a hint', () => {
    for (const m of FRAMING_MODES) expect(framingMode(m.id).hint.length, m.id).toBeGreaterThan(10)
  })
})
