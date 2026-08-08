/**
 * PreviewPlayer — WYSIWYG preview (Part K, Step 3). HTML5 `<video>` scrubbing of
 * the SOURCE (over the privileged `openclip-media://` scheme), now CSS-CROPPED to
 * the target aspect column and overlaid with LIVE karaoke captions in the selected
 * template — so the preview shows (approximately) what the export will burn,
 * instead of the raw letterboxed source.
 *
 * Crop: the frame is an aspect-ratio box with `overflow:hidden`; the video fills
 * the frame HEIGHT and is centered horizontally (`left:50%` + `translateX(-50%)`),
 * which is exactly a horizontal center-crop for any source aspect (matches the
 * static export `crop`). Face-follow ('auto'/'split') is computed at export time
 * in the main process (YuNet), so the preview shows the center-crop framing plus
 * an "auto-reframe on export" badge (LOCKED decision — no proxy render, no IPC).
 *
 * Captions: `useKaraokeCaption` reuses the SAME shared layout + annotation the
 * burn uses, so line breaks / keyword emphasis / emoji match. DOM `currentTime`
 * isn't frame-accurate, so the active word uses a ~100ms tolerance (approximation;
 * the burn is libass-exact). Transport / seek / playhead-sync are unchanged.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useProjectStore } from '@renderer/stores/projectStore'
import { useBrandStore, activeBrand } from '@renderer/stores/brandStore'
import { resolveBounds } from '@shared/clip-bounds'
import { sourceMediaUrl } from '@renderer/components/source-media'
import { formatTime } from '@renderer/components/timeline-math'
import { resolveEffectiveCaptionStyle } from '@renderer/components/captionPresets'
import { brandCaptionOverride } from '@renderer/components/brandKit'
import { cssAspectRatio } from '@renderer/components/preview-crop'
import {
  captionContainerStyle,
  captionWordStyle,
  captionWordAnimationClass
} from '@renderer/components/caption-css'
import { useKaraokeCaption } from '@renderer/components/useKaraokeCaption'
import { Button } from '@renderer/components/ui/button'
import { Play, Pause } from 'lucide-react'

export function PreviewPlayer(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)

  const currentProject = useProjectStore((s) => s.currentProject)
  const clips = useProjectStore((s) => s.clips)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setPlaying = useProjectStore((s) => s.setPlaying)
  const setPlayhead = useProjectStore((s) => s.setPlayhead)
  const playhead = useProjectStore((s) => s.playhead)
  const transcript = useProjectStore((s) => s.transcript)
  // Part K: shared preview/compose selection (single source with ExportPanel).
  const aspectOverride = useProjectStore((s) => s.aspectOverride)
  const reframeMode = useProjectStore((s) => s.reframeMode)
  const captionsPreviewEnabled = useProjectStore((s) => s.captionsPreviewEnabled)
  // Part K — preview the active brand's caption colors/font + the auto-emoji source.
  const brands = useBrandStore((s) => s.brands)
  const brandLoaded = useBrandStore((s) => s.loaded)
  const loadBrands = useBrandStore((s) => s.load)
  useEffect(() => {
    if (!brandLoaded) void loadBrands()
  }, [brandLoaded, loadBrands])

  const sourceVideo = currentProject?.sourceVideo ?? null
  const src = sourceMediaUrl(sourceVideo?.path ?? null)

  const clip = clips.find((c) => c.id === selectedClipId) ?? clips[0] ?? null
  const bounds = useMemo(
    () =>
      clip ? resolveBounds(clip) : sourceVideo ? { start: 0, end: sourceVideo.duration } : null,
    [clip, sourceVideo]
  )

  const aspect = aspectOverride ?? currentProject?.settings.aspectRatio ?? '9:16'
  const captionTemplateId = currentProject?.settings.captionTemplateId ?? ''
  const autoEmoji = currentProject?.settings.autoEmoji ?? 'off'
  const brand = activeBrand(brands, currentProject?.activeBrandId)
  const captionStyle = useMemo(
    () =>
      resolveEffectiveCaptionStyle(captionTemplateId, {
        // The AI emoji map isn't fetched in the preview, so 'ai' previews as the
        // LOCAL dictionary (a representative proxy; the export uses the AI map).
        autoEmoji: autoEmoji === 'ai' ? 'local' : autoEmoji,
        brand: brandCaptionOverride(brand)
      }),
    [captionTemplateId, autoEmoji, brand]
  )
  const words = useMemo(
    () => transcript?.words ?? currentProject?.transcript.words ?? [],
    [transcript, currentProject]
  )

  // Live active caption line at the current playhead (rebased + annotated like the burn).
  const active = useKaraokeCaption({
    words,
    clipStart: bounds?.start ?? 0,
    clipEnd: bounds?.end ?? 0,
    style: captionStyle,
    playhead,
    keywords: clip?.keywords
  })
  const showCaptions = captionsPreviewEnabled && words.length > 0 && active !== null

  // On clip change, seek to the IN point (unchanged behaviour).
  useEffect(() => {
    const v = videoRef.current
    if (!v || !bounds) return
    if (Math.abs(v.currentTime - bounds.start) > 0.05) {
      v.currentTime = bounds.start
    }
    setPlayhead(bounds.start)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id, bounds?.start])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !src) return
    if (isPlaying) void v.play().catch(() => setPlaying(false))
    else v.pause()
  }, [isPlaying, src, setPlaying])

  // Seek the video when the playhead is moved EXTERNALLY (the seek bar below, or a
  // timeline click) while PAUSED (openclip-3p3). During playback the video drives the
  // playhead via handleTimeUpdate, so we only sync when paused — otherwise this would
  // fight playback. The 50ms deadband avoids a feedback loop with handleTimeUpdate.
  useEffect(() => {
    const v = videoRef.current
    if (!v || isPlaying) return
    if (Math.abs(v.currentTime - playhead) > 0.05) v.currentTime = playhead
  }, [playhead, isPlaying])

  const handleTimeUpdate = useCallback((): void => {
    const v = videoRef.current
    if (!v) return
    if (bounds && v.currentTime >= bounds.end) {
      v.pause()
      v.currentTime = bounds.end
      setPlaying(false)
      setPlayhead(bounds.end)
      return
    }
    setPlayhead(v.currentTime)
  }, [bounds, setPlaying, setPlayhead])

  const togglePlay = useCallback((): void => {
    const v = videoRef.current
    if (!v || !bounds) return
    if (!isPlaying && v.currentTime >= bounds.end - 0.01) {
      v.currentTime = bounds.start
    }
    setPlaying(!isPlaying)
  }, [bounds, isPlaying, setPlaying])

  return (
    <div data-testid="preview-player" className="flex flex-col gap-2">
      {/* The aspect-cropped frame: container-type drives caption `cqw` font sizing. */}
      <div className="flex w-full items-center justify-center">
        <div
          data-testid="preview-frame"
          className="relative h-[60vh] max-h-[640px] overflow-hidden rounded-md bg-black"
          style={{ aspectRatio: cssAspectRatio(aspect), containerType: 'inline-size' }}
        >
          {src ? (
            <>
              <video
                ref={videoRef}
                data-testid="preview-video"
                src={src}
                // Center-crop: fill the frame height, center horizontally, clip sides.
                style={{
                  position: 'absolute',
                  height: '100%',
                  width: 'auto',
                  maxWidth: 'none',
                  left: '50%',
                  transform: 'translateX(-50%)'
                }}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                preload="metadata"
              />
              {showCaptions && active && (
                <div data-testid="preview-captions" style={captionContainerStyle(captionStyle)}>
                  {active.words.map((w, i) => {
                    // Per-word reveal animation on the CURRENT word only (openclip-4v1);
                    // re-key it ('on' suffix) so React remounts and replays the CSS
                    // animation each time the playhead reaches a new word.
                    const animClass = captionWordAnimationClass(
                      captionStyle,
                      i === active.activeIndex
                    )
                    return (
                      <span
                        key={animClass ? `w${i}-on` : `w${i}`}
                        className={animClass}
                        style={captionWordStyle(captionStyle, {
                          // Every already-spoken word stays filled, not just the current one
                          // (openclip-cgw): the libass burn's karaoke (\k) fill is cumulative —
                          // each word turns the highlight color as the playhead passes it and
                          // STAYS, so the preview must highlight i<=activeIndex to match. Gated
                          // on highlightCurrentWord (openclip-r7k): when off, no word lights up,
                          // matching the burn's Primary==Secondary collapse.
                          active: captionStyle.highlightCurrentWord && i <= active.activeIndex,
                          keyword: w.isKeyword
                        })}
                      >
                        {i > 0 ? ' ' : ''}
                        {/* Honor emojiPosition like the burn (openclip-ejk): 'before' puts the
                          auto-emoji ahead of the word, otherwise it trails. */}
                        {captionStyle.emojiPosition === 'before' && w.emoji ? `${w.emoji} ` : ''}
                        {w.word}
                        {captionStyle.emojiPosition !== 'before' && w.emoji ? ` ${w.emoji}` : ''}
                      </span>
                    )
                  })}
                </div>
              )}
              {reframeMode !== 'off' && (
                <span
                  data-testid="reframe-badge"
                  className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/90"
                >
                  Auto-reframe on export
                </span>
              )}
            </>
          ) : (
            <span
              className="flex h-full w-full items-center justify-center text-sm text-white/60"
              data-testid="preview-empty"
            >
              No source video — import a video to preview.
            </span>
          )}
        </div>
      </div>

      {/* Transport + readout (PRD §6.6: play/pause + current-time display). */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button
          size="icon"
          variant="secondary"
          aria-label={isPlaying ? 'Pause' : 'Play'}
          data-testid="preview-playpause"
          disabled={!src || !bounds}
          onClick={togglePlay}
        >
          {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <span data-testid="preview-time" className="tabular-nums">
          {formatTime(playhead)}
        </span>
        {/* Scrub bar (openclip-3p3): drag to seek within the clip span. onChange sets the
            video frame directly AND the store playhead (which the timeline mirrors). */}
        {bounds && (
          <input
            type="range"
            data-testid="preview-seek"
            aria-label="Seek"
            min={bounds.start}
            max={bounds.end}
            step={0.05}
            value={Math.min(Math.max(playhead, bounds.start), bounds.end)}
            disabled={!src}
            onChange={(e) => {
              const t = Number(e.target.value)
              const v = videoRef.current
              if (v) v.currentTime = t
              setPlayhead(t)
            }}
            className="h-1 flex-1 cursor-pointer accent-primary"
          />
        )}
        {bounds && (
          <span data-testid="preview-span" className="tabular-nums">
            clip {formatTime(bounds.start)} – {formatTime(bounds.end)} (
            {formatTime(bounds.end - bounds.start)})
          </span>
        )}
      </div>
    </div>
  )
}

export default PreviewPlayer
