/**
 * src/main/services/sidecar-errors.ts — the ONE place a sidecar (ffmpeg /
 * whisper-cli / yt-dlp) failure becomes text a user may see (EPIC-k83ghw /
 * BUG-whdqsc). The companion to `ai-errors.ts`'s `humanTransportError` for
 * the OTHER half of the app's failure surface.
 *
 * WHY IT EXISTS. `ffmpeg-core.ts` and `whisper-spawn.ts` both throw
 * `"<binary> exited with code <n>\n<up to 2KB of stderr>"` on a non-zero exit —
 * useful for a developer, meaningless for the content creator it reaches
 * verbatim in a failure toast and an OS notification. The one actionable
 * phrase (e.g. "No space left on device") is buried in the middle of a wall of
 * `[libx264 @ 0x…]` encoder log lines. yt-dlp's failures are already reduced
 * to a single `ERROR:` line by `url-download.ts`'s `ytdlpErrorMessage`, but
 * that line is still yt-dlp's own technical wording (`HTTP Error 403:
 * Forbidden`), not something a non-technical user can act on.
 *
 * This is the SINGLE chokepoint for all three: `sidecar-manager.ts`'s generic
 * job-failure catch runs every unclassified runner throw through
 * `describeSidecarFailure` before it ever reaches the job's `error` event, so
 * every job kind (transcribe, export, extract-audio, url-download,
 * model-download) is covered without each runner classifying its own errors.
 * `generate-clips` is the one exception: it already throws a classified
 * `JobError` via `ai-errors.describeProviderFailure`, which the manager checks
 * FIRST and this module never sees.
 */

/** Terminal job codes a sidecar failure can map to (see `@shared/jobs`). */
export interface SidecarFailure {
  code: 'SIDECAR_CRASH' | 'OUT_OF_MEMORY'
  message: string
  retriable: boolean
}

const GENERIC_FAILURE: SidecarFailure = {
  code: 'SIDECAR_CRASH',
  message: "OpenClip couldn't finish processing this video. Try again, or try a different file.",
  retriable: true
}

/**
 * Map a raw sidecar (ffmpeg/whisper-cli/yt-dlp) failure to a plain sentence a
 * non-technical user can act on. Order matters: more specific patterns are
 * checked first so a message that happens to contain several substrings
 * (e.g. a permission error mentioning a path) resolves to the most useful one.
 *
 * Deliberately does NOT fall back to quoting the raw message (unlike
 * `ai-errors.humanTransportError`, which quotes an unrecognised PROVIDER body
 * because that is often the user's only diagnostic clue about their own
 * server). ffmpeg/whisper stderr is verbose internal logging, not a message
 * meant for a reader — quoting it would just relocate the wall of text this
 * ticket exists to remove, so an unrecognised shape gets the generic fallback
 * and nothing else.
 */
export function describeSidecarFailure(err: unknown): SidecarFailure {
  const raw = err instanceof Error ? err.message : String(err)

  // ── Disk / filesystem ──────────────────────────────────────────────────
  if (/no space left on device|ENOSPC/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message: 'Your disk is full. Free up some space and try again.',
      retriable: true
    }
  }
  if (/permission denied|EACCES|read-only file system|EROFS/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message:
        "OpenClip doesn't have permission to write there. Choose a different folder, or check that the destination isn't read-only.",
      retriable: true
    }
  }
  if (
    /input\/output error|EIO|device not configured|resource busy|volume.*(ejected|not mounted)/i.test(
      raw
    )
  ) {
    return {
      code: 'SIDECAR_CRASH',
      message: 'The source drive appears to have been disconnected. Reconnect it and try again.',
      retriable: true
    }
  }
  if (/enoent|no such file or directory/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message:
        "The source file couldn't be found — it may have been moved, renamed, or deleted since you started.",
      retriable: false
    }
  }

  // ── Memory ─────────────────────────────────────────────────────────────
  if (/out of memory|cannot allocate memory|ENOMEM|bad_alloc|failed to allocate/i.test(raw)) {
    return {
      code: 'OUT_OF_MEMORY',
      message:
        'Ran out of memory while processing this video. Try a smaller whisper model in Settings, or close other apps and try again.',
      retriable: true
    }
  }

  // ── Format / codec ─────────────────────────────────────────────────────
  if (
    /invalid data found when processing input|moov atom not found|unknown encoder|encoder not found|could not find codec parameters/i.test(
      raw
    )
  ) {
    return {
      code: 'SIDECAR_CRASH',
      message: "This file's format isn't supported, or the file is corrupted.",
      retriable: false
    }
  }
  if (/videotoolbox|hardware encoder/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message:
        'The hardware video encoder failed, even after retrying on the CPU. Try restarting OpenClip.',
      retriable: true
    }
  }

  // ── yt-dlp (already reduced to one ERROR: line by ytdlpErrorMessage) ──
  if (/http error 403|forbidden/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message:
        'This video refused the download. It may be region-locked, private, or the platform is temporarily blocking automated downloads.',
      retriable: true
    }
  }
  if (/http error 429|too many requests|rate.?limit/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message: 'Too many download attempts right now. Wait a few minutes and try again.',
      retriable: true
    }
  }
  if (/video unavailable/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message: 'That video is unavailable — it may have been removed or made private.',
      retriable: false
    }
  }
  if (/private video/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message: "That video is private and can't be downloaded.",
      retriable: false
    }
  }
  if (/sign in to confirm your age|age.?restrict/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message: "That video is age-restricted and can't be downloaded without signing in.",
      retriable: false
    }
  }

  // ── Network ────────────────────────────────────────────────────────────
  if (/econnrefused|enotfound|eai_again|network|getaddrinfo|etimedout|timeout/i.test(raw)) {
    return {
      code: 'SIDECAR_CRASH',
      message: 'Could not reach the network. Check your internet connection and try again.',
      retriable: true
    }
  }

  return GENERIC_FAILURE
}
