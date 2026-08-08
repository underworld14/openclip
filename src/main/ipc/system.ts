/**
 * src/main/ipc/system.ts — the SYSTEM_PREFLIGHT handler (FEAT-c5a15c).
 *
 * `utils/paths.ts` has always resolved every sidecar binary (ffmpeg, ffprobe,
 * whisper-cli, yt-dlp) across dev and packaged layouts — it just never reported
 * the outcome to anyone. The consequence was that a missing binary first became
 * visible as a raw spawn error partway through an import, long after the user had
 * committed to the flow. This channel makes that state readable up front so the
 * renderer can show a red chip before anything is started.
 *
 * Deliberately NON-THROWING per tool: `paths.ts` throws when it cannot locate a
 * binary, and one missing sidecar must not blank the entire readiness bar — the
 * whole point is telling the user *which* piece is missing.
 *
 * The other `system:*` handlers (dialogs, open-folder, check-update) live in
 * `ipc/video.ts` for historical reasons; this file is registered separately in
 * HANDLER_REGISTRARS rather than growing that one further.
 */

import { IPCChannels } from '@shared/channels'
import type { PreflightResult, PreflightTool } from '@shared/channels'
import { ffmpegPath, ffprobePath, whisperCliPath, ytDlpPath } from '@main/utils/paths'
import type { IpcContext } from './index'

/** Run one resolver, mapping both a throw and an empty result to `{ok:false}`. */
function probe(resolve: () => string): PreflightTool {
  try {
    const path = resolve()
    if (!path || !path.trim()) return { ok: false }
    return { ok: true, path }
  } catch {
    return { ok: false }
  }
}

export function registerSystemPreflightHandler(ctx: IpcContext): void {
  ctx.ipcMain.handle(
    IPCChannels.SYSTEM_PREFLIGHT,
    (): PreflightResult => ({
      ffmpeg: probe(ffmpegPath),
      ffprobe: probe(ffprobePath),
      whisperCli: probe(whisperCliPath),
      ytDlp: probe(ytDlpPath)
    })
  )
}
