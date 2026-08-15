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
 * Deliberately NON-THROWING per tool: `paths.ts` CAN throw when it cannot locate
 * a binary (the dev PATH-lookup branches do), and one missing sidecar must not
 * blank the entire readiness bar — the whole point is telling the user *which*
 * piece is missing. But the PACKAGED-build branches never throw at all — they
 * end in an unconditional `join(process.resourcesPath, …)` with no existence
 * check — so a damaged install (a sidecar stripped by AV/quarantine, an
 * incomplete copy off the dmg) used to report every chip green regardless
 * (EPIC-k83ghw / BUG-phta04). `probe()` now stats the resolved path itself
 * rather than trusting the resolver's silence.
 *
 * The other `system:*` handlers (dialogs, open-folder, check-update) live in
 * `ipc/video.ts` for historical reasons; this file is registered separately in
 * HANDLER_REGISTRARS rather than growing that one further.
 */

import { existsSync } from 'node:fs'
import { app, Notification } from 'electron'
import { IPCChannels } from '@shared/channels'
import type { PreflightResult, PreflightTool } from '@shared/channels'
import { ffmpegPath, ffprobePath, whisperCliPath, ytDlpPath } from '@main/utils/paths'
import { encoderBackend } from '@main/services/encoder-probe'
import type { IpcContext } from './index'

/**
 * Run one resolver, mapping a throw, an empty result, or a path that does not
 * actually exist on disk to `{ok:false}`.
 */
function probe(resolve: () => string): PreflightTool {
  try {
    const path = resolve()
    if (!path || !path.trim() || !existsSync(path)) return { ok: false }
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
      ytDlp: probe(ytDlpPath),
      // PRD §14: report the encoder exports will actually use. Cached per
      // process, so the one-frame probe runs at most once (FEAT-5hnsby).
      encoder: encoderBackend()
    })
  )

  /**
   * Tell the OS a long job finished (EPIC-zpa1nd / FEAT-ckxz8d), so the user can
   * genuinely walk away from a ten-minute transcription or a batch export.
   *
   * SUPPRESSED WHEN FOCUSED, decided here rather than in the renderer: the main
   * process is the only side that actually knows whether the window has focus,
   * and notifying someone who is watching the progress bar finish is noise.
   *
   * The dock badge is macOS-only (`app.dock` is undefined elsewhere) and is
   * cleared the next time the window is focused — a badge that outlives the
   * user's attention is just a stuck dot.
   */
  ctx.ipcMain.handle(
    IPCChannels.SYSTEM_NOTIFY,
    (_e, req: { title: string; body: string }): { delivered: boolean } => {
      const win = ctx.getMainWindow()
      if (win?.isFocused()) return { delivered: false }
      if (!Notification.isSupported()) return { delivered: false }

      new Notification({ title: req.title, body: req.body }).show()

      const dock = app.dock
      if (dock) {
        dock.setBadge('•')
        win?.once('focus', () => dock.setBadge(''))
      }
      return { delivered: true }
    }
  )
}
