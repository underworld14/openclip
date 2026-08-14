/**
 * GeneratePreflightDialog — the configuration surface behind "Generate Clips"
 * (FEAT-n762y6, PRD §6.3).
 *
 * "Auto Generate Clips" used to be a single button with no configuration at all:
 * style pinned to `'all'` with no picker, no length preset, no way to target the
 * search, no way to analyse only part of a long source, and no Regenerate. Two
 * PRD §6.3 acceptance criteria were unreachable from the UI.
 *
 * THE DESIGN RULE, borrowed from OpusClip's submit panel: nothing here is
 * mandatory. Every field opens defaulted, so the primary button is pressable the
 * instant the panel appears — this is an options panel, never a form.
 *
 * All of the logic (defaults, clamps, the range slice, the style→caption nudge)
 * lives in `@shared/generate-preflight`, pure and unit-tested without a DOM.
 * This file is widgets.
 */

import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  CLIP_LENGTH_PRESETS,
  CLIP_STYLE_OPTIONS,
  MAX_CLIPS,
  MAX_CUSTOM_PROMPT_LENGTH,
  applyLengthPreset,
  normalizePreflight,
  parseKeywords,
  preflightCost,
  preflightSummary,
  sliceSegmentsToRange,
  type PreflightConfig
} from '@shared/generate-preflight'
import { formatCostEstimate } from '@shared/token-estimate'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import type { TranscriptSegment } from '@shared/schema'
import { formatSeconds } from '@renderer/components/format-time'

export interface GeneratePreflightDialogProps {
  open: boolean
  /** Source duration, for the timeframe bounds. */
  duration: number
  /** Where the panel opens from — defaults for a first run, last values for a Regenerate. */
  initial: PreflightConfig
  /**
   * The transcript being analysed, so the panel can say how much speech the
   * chosen window actually contains (and refuse a window holding none).
   */
  segments: TranscriptSegment[]
  onCancel: () => void
  onGenerate: (config: PreflightConfig) => void
}

export function GeneratePreflightDialog({
  open,
  duration,
  initial,
  segments,
  onCancel,
  onGenerate
}: GeneratePreflightDialogProps): React.JSX.Element {
  const [config, setConfig] = useState<PreflightConfig>(initial)
  // The keyword field is raw text while being typed — parsing on every keystroke
  // would eat the comma the moment the user pressed it.
  const [keywordText, setKeywordText] = useState(initial.keywords.join(', '))
  const [useRange, setUseRange] = useState(initial.range !== null)

  // NOTE: seeded once, from `initial`, at mount. The caller renders this dialog
  // only while it is open, so every open is a fresh mount and Regenerate shows
  // the LAST run's values. Re-seeding from an effect instead would fight the
  // user's own edits on every parent re-render.

  const range = config.range ?? { start: 0, end: duration }
  const normalized = normalizePreflight(
    { ...config, keywords: parseKeywords(keywordText), range: useRange ? range : null },
    duration
  )
  /**
   * A window containing no speech can only produce an empty result — and it
   * would still cost a provider round-trip on the user's own key, then report
   * "no clips found" as though the video were the problem. Caught here, where
   * the fix is to drag the window rather than to wonder.
   */
  const segmentsInWindow = sliceSegmentsToRange(segments, normalized.range).length
  const emptyWindow = segmentsInWindow === 0

  /**
   * What this run will cost (FEAT-56bxyh). PRD §16 requires it and nothing showed
   * it: on BYOK the user pays per press, and this app's whole pitch is "cheap,
   * because we only send text" — a number is how that claim gets made.
   *
   * Prices come from the model list the settings store already holds. Providers
   * that publish none get the TOKEN count and "price unknown" rather than
   * nothing, because half an estimate still beats a mystery.
   */
  const model = useSettingsStore((s) => s.settings.model)
  const models = useSettingsStore((s) => s.models)
  const price = models.find((m) => m.id === model)
  const cost = preflightCost(normalized, segments, {
    pricePerMTokIn: price?.pricePerMTokIn,
    pricePerMTokOut: price?.pricePerMTokOut
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="app-no-drag max-w-lg" data-testid="generate-preflight">
        <DialogHeader>
          <DialogTitle>Generate clips</DialogTitle>
          <DialogDescription>
            Everything below is optional — press Generate to use these defaults.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          {/* ── How many ──────────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="preflight-count">Number of clips</Label>
            <Input
              id="preflight-count"
              data-testid="preflight-count"
              type="number"
              min={1}
              max={MAX_CLIPS}
              className="w-24"
              value={config.numClips}
              onChange={(e) =>
                setConfig((c) => ({ ...c, numClips: Number(e.target.value) || c.numClips }))
              }
            />
          </div>

          {/* ── How long ──────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <Label>Clip length</Label>
            <div className="flex flex-wrap gap-2">
              {CLIP_LENGTH_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  size="sm"
                  variant={config.lengthPreset === preset.id ? 'default' : 'outline'}
                  data-testid={`preflight-length-${preset.id}`}
                  aria-pressed={config.lengthPreset === preset.id}
                  onClick={() => setConfig((c) => applyLengthPreset(c, preset.id))}
                >
                  {preset.label}
                </Button>
              ))}
              {/* Shown only when the project carries bounds matching no bucket —
                so a 20-70s project doesn't silently get snapped to a preset. */}
              {config.lengthPreset === 'custom' && (
                <span
                  data-testid="preflight-length-custom"
                  className="self-center text-xs text-muted-foreground"
                >
                  Custom · {config.minDuration}–{config.maxDuration}s
                </span>
              )}
            </div>
          </div>

          {/* ── What kind ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <Label>Style</Label>
            <div className="flex flex-wrap gap-2">
              {CLIP_STYLE_OPTIONS.map((opt) => (
                <Button
                  key={opt.id}
                  type="button"
                  size="sm"
                  variant={config.clipStyle === opt.id ? 'default' : 'outline'}
                  data-testid={`preflight-style-${opt.id}`}
                  aria-pressed={config.clipStyle === opt.id}
                  title={opt.hint}
                  onClick={() => setConfig((c) => ({ ...c, clipStyle: opt.id }))}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground" data-testid="preflight-style-hint">
              {CLIP_STYLE_OPTIONS.find((o) => o.id === config.clipStyle)?.hint}
            </p>
          </div>

          {/* ── What about ────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="preflight-keywords">Keywords (optional)</Label>
            <Input
              id="preflight-keywords"
              data-testid="preflight-keywords"
              placeholder="pricing, hiring, burnout"
              value={keywordText}
              onChange={(e) => setKeywordText(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="preflight-prompt">What are you looking for? (optional)</Label>
            <textarea
              id="preflight-prompt"
              data-testid="preflight-prompt"
              rows={2}
              maxLength={MAX_CUSTOM_PROMPT_LENGTH}
              placeholder="The moments where they disagree about remote work"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={config.customPrompt}
              onChange={(e) => setConfig((c) => ({ ...c, customPrompt: e.target.value }))}
            />
          </div>

          {/* ── Which part ────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="preflight-range-toggle"
                checked={useRange}
                onChange={(e) => {
                  setUseRange(e.target.checked)
                  setConfig((c) => ({
                    ...c,
                    range: e.target.checked ? (c.range ?? { start: 0, end: duration }) : null
                  }))
                }}
              />
              Only analyse part of the video
            </label>
            {useRange && (
              <div className="flex items-center gap-2">
                <Input
                  data-testid="preflight-range-start"
                  type="number"
                  min={0}
                  max={duration}
                  className="w-28"
                  aria-label="Analysis start, seconds"
                  value={range.start}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      range: { start: Number(e.target.value) || 0, end: range.end }
                    }))
                  }
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  data-testid="preflight-range-end"
                  type="number"
                  min={0}
                  max={duration}
                  className="w-28"
                  aria-label="Analysis end, seconds"
                  value={range.end}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      range: { start: range.start, end: Number(e.target.value) || 0 }
                    }))
                  }
                />
                <span className="text-xs text-muted-foreground">of {formatSeconds(duration)}</span>
              </div>
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground" data-testid="preflight-summary">
          {preflightSummary(normalized, duration)}
        </p>
        {!emptyWindow && (
          <p className="text-xs text-muted-foreground" data-testid="preflight-cost">
            {formatCostEstimate(cost, model || undefined)}
          </p>
        )}
        {emptyWindow && (
          <p className="text-xs text-destructive" data-testid="preflight-empty-window">
            {normalized.range
              ? 'No transcript in that window — widen it or turn the timeframe off.'
              : 'No transcript yet — transcribe the video first.'}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} data-testid="preflight-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => onGenerate(normalized)}
            disabled={emptyWindow}
            data-testid="preflight-submit"
          >
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default GeneratePreflightDialog
