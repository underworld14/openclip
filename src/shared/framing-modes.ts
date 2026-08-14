/**
 * src/shared/framing-modes.ts — ONE named control for how a clip is framed
 * (FEAT-kzej8t).
 *
 * The export panel had two unrelated controls that secretly interacted: a fit
 * picker (Fill / Fit / Fit+blur) and a reframe dropdown (Off / Follow speaker /
 * Split-screen). Choosing "Fit" and "Follow speaker" together asked for
 * something that cannot exist — there is no crop left to move inside a
 * letterboxed frame — so the panel had to grow a warning explaining that one of
 * the user's two choices would be ignored.
 *
 * A warning that a control does nothing is a design telling on itself. Merging
 * them makes the impossible combination UNREPRESENTABLE, which is the version
 * that needs no warning at all.
 *
 * The names follow Kapwing's ("Fit to Center" / "Fill and Crop" / "Speaker
 * Focus") and OpusClip's (Fill / Fit / Split), because those are the words users
 * arrive already knowing.
 */

export type FramingModeId = 'fill' | 'letterbox' | 'blur' | 'follow' | 'split'

export interface FramingMode {
  id: FramingModeId
  label: string
  /** One line on what it does, for the picker. */
  hint: string
  /** The `fitMode` this implies on the export job. */
  fitMode: 'fill' | 'letterbox' | 'blur'
  /** The `reframe` this implies on the export job. */
  reframe: 'off' | 'auto' | 'split'
}

export const FRAMING_MODES: readonly FramingMode[] = [
  {
    id: 'fill',
    label: 'Fill',
    hint: 'Crop the middle of the frame to fit the canvas.',
    fitMode: 'fill',
    reframe: 'off'
  },
  {
    id: 'follow',
    label: 'Follow speaker',
    hint: 'Track the speaker’s face and pan the crop to keep them in frame.',
    fitMode: 'fill',
    reframe: 'auto'
  },
  {
    id: 'split',
    label: 'Split screen',
    hint: 'Two speakers, stacked — one above the other.',
    fitMode: 'fill',
    reframe: 'split'
  },
  {
    id: 'letterbox',
    label: 'Fit (bars)',
    hint: 'Show the whole frame, padded with black bars.',
    fitMode: 'letterbox',
    reframe: 'off'
  },
  {
    id: 'blur',
    label: 'Fit (blur)',
    hint: 'Show the whole frame over a blurred copy of itself.',
    fitMode: 'blur',
    reframe: 'off'
  }
]

/** The mode by id, defaulting to Fill for an unknown one. */
export function framingMode(id: FramingModeId): FramingMode {
  return FRAMING_MODES.find((m) => m.id === id) ?? FRAMING_MODES[0]
}

/**
 * Recover the mode from a persisted `(fitMode, reframe)` pair.
 *
 * Projects saved before this control existed hold the two fields separately, and
 * a pair the merged control can no longer produce — `letterbox` + `auto`, say —
 * still has to open as SOMETHING. It resolves to the fit, because that is the
 * half the export actually honoured: `fitChain` ignores a reframe plan in any
 * non-fill mode, and the runner skips the analysis entirely. So this reports
 * what the project was really doing, not what it appeared to ask for.
 */
export function framingModeFor(
  fitMode: 'fill' | 'letterbox' | 'blur' | undefined,
  reframe: 'off' | 'auto' | 'split' | undefined
): FramingModeId {
  const fit = fitMode ?? 'fill'
  if (fit !== 'fill') return fit
  if (reframe === 'auto') return 'follow'
  if (reframe === 'split') return 'split'
  return 'fill'
}
