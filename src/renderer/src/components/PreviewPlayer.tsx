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

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { useProjectStore } from '@renderer/stores/projectStore'
import { useBrandStore, activeBrand } from '@renderer/stores/brandStore'
import { resolveBounds } from '@shared/clip-bounds'
import { cropXAt } from '@shared/reframe-plan'
import { sourceMediaUrl } from '@renderer/components/source-media'
import { formatTime } from '@renderer/components/timeline-math'
import { resolveEffectiveCaptionStyle } from '@renderer/components/captionPresets'
import { brandCaptionOverride } from '@renderer/components/brandKit'
import { cssAspectRatio, coverFitTransform } from '@renderer/components/preview-crop'
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
  const frameRef = useRef<HTMLDivElement>(null)
  /**
   * A SECOND, non-interactive `<video>` element, reused for whichever of the
   * two modes needs it (they are mutually exclusive by the app's own design —
   * reframe composes only with `fitMode: 'fill'`): the blurred COVER
   * background layer under `fitMode: 'blur'`, or the second (bottom) tile
   * under `reframeMode: 'split'` (EPIC-k83ghw / BUG-t19z5j). Kept in lockstep
   * with the primary video below rather than driven independently, so there
   * is exactly one source of playback truth.
   */
  const shadowVideoRef = useRef<HTMLVideoElement>(null)

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
  /**
   * How a source that does not match the target aspect is fitted
   * (EPIC-k83ghw / BUG-t19z5j) — previously read by nothing here: the preview
   * always centre-cropped regardless of this, so picking "Fit (bars)" or
   * "Fit (blur)" changed nothing on screen and the export then produced a
   * DIFFERENT picture than what was shown, most confusingly for a source that
   * was already portrait/square and got cropped when it should not have been.
   */
  const fitMode = currentProject?.settings.fitMode ?? 'fill'
  // Part K — preview the active brand's caption colors/font + the auto-emoji source.
  const brands = useBrandStore((s) => s.brands)
  const brandLoaded = useBrandStore((s) => s.loaded)
  const loadBrands = useBrandStore((s) => s.load)
  useEffect(() => {
    if (!brandLoaded) void loadBrands()
  }, [brandLoaded, loadBrands])

  const sourceVideo = currentProject?.sourceVideo ?? null
  const src = sourceMediaUrl(sourceVideo?.path ?? null)

  /**
   * A moved, renamed, deleted, or unplugged-drive source used to fail totally
   * silently: no `onError` handler, so the project reopened looking normal
   * (clips, transcript, timeline all present) while the preview was just a
   * black rectangle and every export died with a raw ffmpeg error further
   * downstream (EPIC-k83ghw / BUG-4c3gj3).
   *
   * Tracked as WHICH `src` last failed, not a bare boolean: comparing that
   * against the CURRENT `src` during render clears the banner the instant the
   * source changes (a different project, or a successful relink) with no
   * effect needed at all — an effect that just calls setState on every `src`
   * change is exactly the synchronous-setState-in-effect pattern React (and
   * this repo's lint config) warns against.
   */
  const [erroredSrc, setErroredSrc] = useState<string | null>(null)
  const sourceMissing = erroredSrc !== null && erroredSrc === src
  const [relinking, setRelinking] = useState(false)

  const handleLocateVideo = useCallback(async (): Promise<void> => {
    setRelinking(true)
    try {
      const res = await window.openclip.system.openDialog({})
      if (res.canceled || !res.filePaths[0]) return
      const { sourceVideo: probed } = await window.openclip.video.import({
        filePath: res.filePaths[0]
      })
      const current = useProjectStore.getState().currentProject?.sourceVideo
      useProjectStore.getState().setSource({ ...probed, appOwned: current?.appOwned ?? false })
      setErroredSrc(null)
      toast.success('Video relinked')
    } catch (e) {
      toast.error('Could not relink the video', {
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setRelinking(false)
    }
  }, [])

  const clip = clips.find((c) => c.id === selectedClipId) ?? clips[0] ?? null
  const bounds = useMemo(
    () =>
      clip ? resolveBounds(clip) : sourceVideo ? { start: 0, end: sourceVideo.duration } : null,
    [clip, sourceVideo]
  )

  const aspect = aspectOverride ?? currentProject?.settings.aspectRatio ?? '9:16'

  /**
   * The auto-reframe plan, and where its crop sits right now (FEAT-kzej8t).
   *
   * This is what turns auto-reframe from an invisible switch into something the
   * user can judge: the preview follows the same crop the export will burn, so
   * a plan that locked onto the wrong speaker is obvious BEFORE paying for an
   * encode rather than after.
   */
  const reframePlan = useProjectStore((s) => s.reframePlan)
  const reframePlanError = useProjectStore((s) => s.reframePlanError)
  const loadReframePlan = useProjectStore((s) => s.loadReframePlan)
  useEffect(() => {
    if (reframeMode === 'off' || !clip || !sourceVideo || !currentProject || !bounds) return
    void loadReframePlan({
      projectId: currentProject.id,
      clipId: clip.id,
      sourcePath: sourceVideo.path,
      startTime: bounds.start,
      endTime: bounds.end,
      sourceResolution: sourceVideo.resolution,
      aspectRatio: aspect
    })
    // Depend on VALUES (clip id, bounds start/end), not object identity
    // (BUG-44fgyv self-review follow-up). `clips` is a whole-array store
    // selector, so it — and every clip object `clip`/`bounds` derive from —
    // gets a NEW reference on every `setClips` call, including
    // `regeneratePosterFrames`'s background poster-frame regeneration pass
    // (BUG-08sb0x), which updates one clip's `thumbnailPath` at a time while
    // the actual clip/bounds/aspect the reframe request cares about are
    // unchanged. Depending on the objects re-fired this effect on every
    // completed poster grab — not just the selected clip's — aborting and
    // restarting a (possibly still-running) reframe analysis each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    reframeMode,
    clip?.id,
    sourceVideo,
    currentProject,
    bounds?.start,
    bounds?.end,
    aspect,
    loadReframePlan
  ])

  /**
   * Horizontal offset for the `<video>`, in PERCENT of the source width.
   *
   * The element is height-filled and centred, so the default `translateX(-50%)`
   * shows the middle column. A plan's crop window has its own left edge, so the
   * offset is the difference between the window's centre and the frame's,
   * expressed against the element's own width — which is what `translateX(%)`
   * resolves against.
   */
  /**
   * The MANUAL crop override, when the user has dragged one (FEAT-kzej8t).
   *
   * The ticket's title complaint: auto-reframe was "un-overridable". When the
   * detector locked onto the wrong speaker there was no recourse but to switch
   * reframing off and accept a centre crop. Dragging the preview sets a fixed
   * crop for the clip, which the export honours (and which skips detection).
   */
  const manualCropX = clip?.reframeCropX
  const updateClip = useProjectStore((s) => s.updateClip)
  const [dragging, setDragging] = useState(false)

  /** The crop window width the override uses — the same one the runner derives. */
  const cropW = useMemo(() => {
    if (!sourceVideo) return 0
    const [aw, ah] = aspect.split(':').map(Number)
    return Math.round(((sourceVideo.resolution.height * aw) / ah / 2) * 2) / 1
  }, [sourceVideo, aspect])

  const reframeShiftPct = useMemo(() => {
    if (reframeMode === 'off' || !sourceVideo) return 0
    // A manual override wins over the computed plan, in the preview exactly as
    // it does in the export.
    if (typeof manualCropX === 'number' && cropW > 0) {
      const centre = manualCropX + cropW / 2
      return -((centre - sourceVideo.resolution.width / 2) / sourceVideo.resolution.width) * 100
    }
    if (!reframePlan) return 0
    const cropX = cropXAt(reframePlan, Math.max(0, playhead - (bounds?.start ?? 0)))
    if (cropX === null) return 0
    const planW = reframePlan.mode === 'split' ? 0 : reframePlan.cropW
    if (!(planW > 0)) return 0
    const windowCentre = cropX + planW / 2
    return -((windowCentre - sourceVideo.resolution.width / 2) / sourceVideo.resolution.width) * 100
  }, [reframeMode, reframePlan, sourceVideo, playhead, bounds, manualCropX, cropW])

  /**
   * The frame's rendered CSS pixel size, tracked live (EPIC-k83ghw /
   * BUG-t19z5j). Only `fitMode: 'blur'` and `reframeMode: 'split'` need real
   * pixel values — the single center-crop transform above stays
   * percentage-only and byte-identical for the historical `fill`+`off` case.
   * A face-cluster region's aspect ratio is not generally the tile's own (see
   * `clusterTileRegion`), so cover-fitting it composes correctly only in
   * absolute px, not nested CSS percentages.
   */
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      setFrameSize({ width: box.width, height: box.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** True in either of the two modes that need the second (shadow) video. */
  const isSplitActive =
    fitMode === 'fill' && reframeMode === 'split' && reframePlan?.mode === 'split'
  const isBlurActive = fitMode === 'blur'
  const shadowVideoNeeded = isSplitActive || isBlurActive

  /** The two split-screen tiles' size+position, or null outside split mode. */
  const splitTiles = useMemo(() => {
    if (!isSplitActive || !sourceVideo || reframePlan?.mode !== 'split' || !(frameSize.width > 0)) {
      return null
    }
    const tile = { width: frameSize.width, height: frameSize.height / 2 }
    const [top, bottom] = reframePlan.regions
    return {
      top: coverFitTransform(sourceVideo.resolution, top, tile),
      bottom: coverFitTransform(sourceVideo.resolution, bottom, tile)
    }
  }, [isSplitActive, sourceVideo, reframePlan, frameSize])

  // The shadow video mirrors the primary one's position and play state — it
  // never drives `playhead`/`isPlaying` itself, so there is exactly one
  // source of playback truth — and only while actually needed, so it is not
  // silently decoding (and burning CPU) in `fill`/`letterbox` mode. A
  // generous 0.1s deadband avoids fighting its own decode; unlike the
  // primary video's sync effect this runs regardless of `isPlaying` since the
  // shadow never emits its own `timeupdate` feedback.
  useEffect(() => {
    const shadow = shadowVideoRef.current
    if (!shadow || !shadowVideoNeeded) return
    if (Math.abs(shadow.currentTime - playhead) > 0.1) shadow.currentTime = playhead
  }, [playhead, shadowVideoNeeded])
  useEffect(() => {
    const shadow = shadowVideoRef.current
    if (!shadow || !src) return
    if (isPlaying && shadowVideoNeeded) void shadow.play().catch(() => {})
    else shadow.pause()
  }, [isPlaying, src, shadowVideoNeeded])

  /**
   * Drag horizontally to place the crop.
   *
   * The pointer's x within the FRAME maps to the crop window's centre in source
   * pixels — so the frame you are looking at is the frame you get. Clamped to the
   * source so the window can never hang off the edge.
   */
  const onCropPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (reframeMode === 'off' || !clip || !sourceVideo || !(cropW > 0)) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    applyCropFromPointer(e)
  }

  const applyCropFromPointer = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!clip || !sourceVideo || !(cropW > 0)) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const centre = frac * sourceVideo.resolution.width
    const x = Math.round(
      Math.min(Math.max(0, centre - cropW / 2), sourceVideo.resolution.width - cropW)
    )
    updateClip(clip.id, { reframeCropX: x })
  }
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

  /**
   * The primary and shadow video LAYERS' wrapper+video styles for the current
   * mode (EPIC-k83ghw / BUG-t19z5j). Both layers are ALWAYS rendered in the
   * SAME tree position across every mode (only their styles change) — a mode
   * switch must restyle the existing `<video>` elements, not swap which JSX
   * branch contains them, or React would remount them and the user would
   * lose playback position on every framing change.
   */
  const { primary, shadow } = useMemo((): {
    primary: { wrapper: CSSProperties; video: CSSProperties }
    shadow: { wrapper: CSSProperties; video: CSSProperties }
  } => {
    if (isSplitActive && splitTiles) {
      const tileWrapper: CSSProperties = {
        position: 'absolute',
        left: 0,
        width: '100%',
        height: '50%',
        overflow: 'hidden'
      }
      const tileVideo = (t: (typeof splitTiles)['top']): CSSProperties => ({
        position: 'absolute',
        top: 0,
        left: 0,
        width: `${t.width}px`,
        height: `${t.height}px`,
        transform: `translate(${t.translateX}px, ${t.translateY}px)`
      })
      return {
        primary: { wrapper: { ...tileWrapper, top: 0 }, video: tileVideo(splitTiles.top) },
        shadow: { wrapper: { ...tileWrapper, top: '50%' }, video: tileVideo(splitTiles.bottom) }
      }
    }
    if (isBlurActive) {
      return {
        primary: {
          wrapper: { position: 'absolute', inset: 0, zIndex: 1 },
          video: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain'
          }
        },
        shadow: {
          // The blurred COVER background, mirroring the export's `scale=…
          // force_original_aspect_ratio=increase,crop=…,gblur=` chain. Scaled
          // up 10% past `cover` so blur sampling never reaches the (already
          // cropped-away) source edge and shows a hard line.
          wrapper: { position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden' },
          video: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(20px)',
            transform: 'scale(1.1)'
          }
        }
      }
    }
    if (fitMode === 'letterbox') {
      return {
        primary: {
          wrapper: { position: 'absolute', inset: 0 },
          video: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain'
          }
        },
        shadow: { wrapper: { display: 'none' }, video: {} }
      }
    }
    // fill (default) — the historical centre-crop transform, byte-identical.
    return {
      primary: {
        wrapper: { position: 'absolute', inset: 0 },
        video: {
          position: 'absolute',
          height: '100%',
          width: 'auto',
          maxWidth: 'none',
          left: '50%',
          // The extra shift is the auto-reframe crop (FEAT-kzej8t); it is 0
          // with reframe off, leaving the historical centre-crop transform
          // byte-for-byte unchanged.
          transform: `translateX(calc(-50% + ${reframeShiftPct.toFixed(3)}%))`
        }
      },
      shadow: { wrapper: { display: 'none' }, video: {} }
    }
  }, [isSplitActive, splitTiles, isBlurActive, fitMode, reframeShiftPct])

  return (
    <div data-testid="preview-player" className="flex flex-col gap-2">
      {/* The aspect-cropped frame: container-type drives caption `cqw` font sizing. */}
      <div className="flex w-full items-center justify-center">
        <div
          ref={frameRef}
          data-testid="preview-frame"
          // Dragging places the reframe crop by hand (FEAT-kzej8t). Only armed
          // while reframing is on; otherwise the frame behaves exactly as before.
          onPointerDown={onCropPointerDown}
          onPointerMove={(e) => dragging && applyCropFromPointer(e)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          className={`relative h-[60vh] max-h-[640px] overflow-hidden rounded-md bg-black ${
            reframeMode !== 'off' ? 'cursor-ew-resize' : ''
          }`}
          style={{ aspectRatio: cssAspectRatio(aspect), containerType: 'inline-size' }}
        >
          {src ? (
            <>
              {/* The shadow layer — the split-screen BOTTOM tile, or the blurred
                COVER background under `fitMode: 'blur'` (EPIC-k83ghw /
                BUG-t19z5j). Rendered BEFORE the primary layer so it sits behind
                it in paint order regardless of the wrapper's own `zIndex`
                (belt and braces); hidden (not unmounted) outside those two
                modes so switching modes never remounts/reloads it. */}
              <div style={shadow.wrapper}>
                <video
                  ref={shadowVideoRef}
                  data-testid="preview-video-shadow"
                  src={src}
                  style={shadow.video}
                  muted
                  preload="metadata"
                />
              </div>
              <div style={primary.wrapper}>
                <video
                  ref={videoRef}
                  data-testid="preview-video"
                  src={src}
                  style={primary.video}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onError={() => setErroredSrc(src)}
                  preload="metadata"
                />
              </div>
              {sourceMissing && (
                <div
                  data-testid="preview-source-missing"
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 px-6 text-center text-sm text-white"
                >
                  <p className="font-medium">This project&apos;s video could not be found</p>
                  <p className="text-xs text-white/70">
                    It may have been moved, renamed, or is on a drive that is not connected.
                  </p>
                  <Button
                    size="sm"
                    className="mt-1"
                    disabled={relinking}
                    onClick={() => void handleLocateVideo()}
                    data-testid="preview-locate-video"
                  >
                    {relinking ? 'Locating…' : 'Locate video…'}
                  </Button>
                </div>
              )}
              {showCaptions && active && (
                <div
                  data-testid="preview-captions"
                  style={captionContainerStyle(captionStyle, aspect)}
                >
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
              {/* The badge now reports what auto-reframe IS DOING, not merely
                that it is switched on — and names a detection failure instead
                of degrading to a centre crop in silence (FEAT-kzej8t). */}
              {reframeMode !== 'off' && (
                <span
                  data-testid="reframe-badge"
                  data-reframe-state={
                    typeof manualCropX === 'number'
                      ? 'manual'
                      : (reframePlanError?.reason ?? (reframePlan ? reframePlan.mode : 'pending'))
                  }
                  title={reframePlanError?.message}
                  className={`absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] ${
                    reframePlanError?.reason === 'detect-failed'
                      ? 'bg-amber-600/90 text-white'
                      : 'bg-black/70 text-white/90'
                  }`}
                >
                  {typeof manualCropX === 'number'
                    ? 'Manual crop'
                    : reframePlanError?.reason === 'detect-failed'
                      ? 'Face detection failed — centre crop'
                      : reframePlanError?.reason === 'no-face'
                        ? 'No face found — centre crop'
                        : reframePlan?.mode === 'pan'
                          ? 'Following speaker'
                          : reframePlan?.mode === 'split'
                            ? 'Split screen'
                            : reframePlan?.mode === 'static'
                              ? 'Locked on speaker'
                              : 'Analysing…'}
                </span>
              )}
              {/* Undo the override. Without a way back, one stray drag would
                permanently pin the crop with no sign of how to restore the
                detector's own choice (FEAT-kzej8t). */}
              {reframeMode !== 'off' && typeof manualCropX === 'number' && clip && (
                <button
                  type="button"
                  data-testid="reframe-clear-manual"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => updateClip(clip.id, { reframeCropX: undefined })}
                  className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/90 hover:bg-black/90"
                >
                  Reset crop
                </button>
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
            // BUG-qcvhcn: was h-1 (4px) — a hairline that was hard to see and
            // harder to grab precisely. Not a full custom-track redesign (that
            // would be needed to GUARANTEE a 24px pointer target per WCAG
            // 2.5.8 — out of scope here), but a real, low-risk improvement.
            className="h-2 flex-1 cursor-pointer accent-primary"
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
