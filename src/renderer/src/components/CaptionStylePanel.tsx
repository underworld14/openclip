/**
 * CaptionStylePanel — the caption template gallery as LIVE THUMBNAILS, next to
 * the preview (FEAT-0s2tnc, PRD §6.5).
 *
 * The gallery was 13 `<button>`s in a row, each described only by a raw HTML
 * `title` attribute, buried inside the Export dialog. "Hormozi", "MrBeast",
 * "Beast Pop", "Captionate" mean nothing without seeing them — the most visible
 * differentiator the app has was picked from a list of names, in a modal the
 * user only opens once they have already decided everything else.
 *
 * Each thumbnail now renders the SAME three real words from the user's own
 * transcript in that template's font, fill, outline and highlight — the same
 * `caption-css` helpers that drive the PreviewPlayer overlay, so a thumbnail and
 * the preview cannot disagree. No ffmpeg: this is CSS over text.
 *
 * `captionTemplateId` stays on project settings, so the export and the preview
 * keep agreeing about what gets burned.
 */

import { useMemo } from 'react'
import { useProjectStore } from '@renderer/stores/projectStore'
import { CAPTION_PRESETS, type CaptionPreset } from '@renderer/components/captionPresets'
import { captionContainerStyle, captionWordStyle } from '@renderer/components/caption-css'
import { sampleActiveIndex, sampleCaptionWords } from '@renderer/components/captionSample'
import { DEFAULT_CAPTION_STYLE } from '@shared/caption-layout'
import type { CaptionStyle } from '@shared/schema'

/** The "no template" entry — the app default, shown as a real thumbnail too. */
const DEFAULT_ENTRY: CaptionPreset = {
  id: '',
  name: 'Default',
  description: 'The app default caption style',
  style: DEFAULT_CAPTION_STYLE
}

function Thumbnail(props: {
  preset: CaptionPreset
  words: string[]
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { preset, words, active } = props
  const style: CaptionStyle = preset.style
  const activeIndex = sampleActiveIndex(words.length)
  return (
    <button
      type="button"
      data-testid="caption-template-thumb"
      data-template-id={preset.id}
      data-active={active}
      aria-pressed={active}
      aria-label={`Caption template: ${preset.name}. ${preset.description}`}
      onClick={props.onSelect}
      className={`flex w-40 shrink-0 flex-col gap-1 rounded-md border p-1 text-left transition-colors ${
        active ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-accent'
      }`}
    >
      {/*
        A CROP of the caption band, not the whole 9:16 frame.

        The tile's width represents the full 1080-px export canvas, so
        `captionContainerStyle`'s `cqw` sizing puts the text at its exact
        relative scale — this is a crop, never a rescale. What is cut away is
        the empty video above and below the captions. Showing the whole 9:16
        frame at a width that fits in a strip rendered the text at ~6px, which is
        faithful and completely illegible: it would have made a gallery whose
        entire purpose is "you can finally SEE the difference" show thirteen
        indistinguishable grey smudges.

        `container-type: inline-size` is what makes the `cqw` units resolve,
        exactly as the PreviewPlayer frame does.
      */}
      <div
        data-testid="caption-template-frame"
        className="relative h-14 w-full overflow-hidden rounded bg-neutral-800"
        style={{ containerType: 'inline-size' }}
      >
        <div
          data-testid="caption-template-line"
          style={{
            ...captionContainerStyle(style),
            // The band IS the crop, so the preset's top/middle/bottom placement
            // has nothing to place against here — centre it and let the styling
            // (font, fill, outline, highlight) be the only variable on show.
            top: '50%',
            bottom: 'auto',
            transform: 'translateY(-50%)'
          }}
        >
          {words.map((word, i) => (
            <span
              key={`${word}-${i}`}
              data-testid="caption-template-word"
              data-word-active={i === activeIndex}
              style={captionWordStyle(style, { active: i === activeIndex })}
            >
              {word}
              {i < words.length - 1 ? ' ' : ''}
            </span>
          ))}
        </div>
      </div>
      <span className="truncate px-0.5 text-[10px] text-muted-foreground">{preset.name}</span>
    </button>
  )
}

export function CaptionStylePanel(): React.JSX.Element | null {
  const currentProject = useProjectStore((s) => s.currentProject)
  const transcript = useProjectStore((s) => s.transcript)
  const setProjectSettings = useProjectStore((s) => s.setProjectSettings)

  const words = useMemo(() => sampleCaptionWords(transcript?.words), [transcript?.words])
  const entries = useMemo(() => [DEFAULT_ENTRY, ...CAPTION_PRESETS], [])

  // Nothing to configure without a project; the editor shell handles the rest.
  if (!currentProject) return null
  const selected = currentProject.settings.captionTemplateId ?? ''

  return (
    <div className="flex flex-col gap-1.5" data-testid="caption-style-panel">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Caption style
        </span>
        {/* The words on screen ARE the user's, and saying so is what makes the
          thumbnails read as a preview of their video rather than as stock art. */}
        <span className="text-[10px] text-muted-foreground" data-testid="caption-style-source">
          {transcript?.words?.length ? 'from your transcript' : 'sample text'}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {entries.map((preset) => (
          <Thumbnail
            key={preset.id || 'default'}
            preset={preset}
            words={words}
            active={selected === preset.id}
            onSelect={() => setProjectSettings({ captionTemplateId: preset.id })}
          />
        ))}
      </div>
    </div>
  )
}

export default CaptionStylePanel
