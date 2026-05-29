/**
 * src/main/ipc/video.ts — video + system control-plane handlers (EXPORT spine,
 * plan E.5). Fills the trunk stub flagged TODO at integration.
 *
 * Wires:
 *   - the `export` JobRunner registration (the streaming export path: the
 *     renderer drives live progress via `jobs.start('export', …)` and obtains
 *     the per-job MessagePort out-of-band — the PROVEN streaming-job port path,
 *     identical to transcribe/model-download; PRD §6.5/§6.9 / §10.2).
 *   - EXPORT_CLIP — the control-plane convenience entry (PRD §10.1). Returns the
 *     resolved output path; the actual encode streams over the job port (a
 *     MessagePort cannot ride `invoke`, so progress is NOT returned here — same
 *     pattern as MODEL_DOWNLOAD).
 *   - SHOW_SAVE_DIALOG — `dialog.showSaveDialog` (PRD §10.1 system:save-dialog).
 *   - OPEN_FOLDER — reveal an exported file / open a folder (PRD §10.1
 *     system:open-folder) via `shell.showItemInFolder` / `shell.openPath`.
 *
 * The trunk previously left only a binary-free fake-mode IMPORT_VIDEO handler
 * (gated on OPENCLIP_FAKE_TRANSCRIBE) for the Wave-1 E2E; that path is preserved.
 */

import { dialog, shell } from 'electron'
import { statSync } from 'node:fs'
import { IPCChannels } from '@shared/channels'
import type { ImportVideoResult } from '@shared/channels'
import type { IpcContext } from './index'
import { registerRunner, hasRunner } from '@main/services/sidecar-manager'
import { exportRunner } from '@main/services/jobs/export-runner'

export function registerVideoHandlers(ctx: IpcContext): void {
  // Plug the streaming export runner into the sidecar's JOB_RUNNERS registry
  // (startup seam, E.4). Guarded so a test re-import doesn't throw.
  if (!hasRunner('export')) registerRunner('export', exportRunner)

  // ── System: save dialog (PRD §10.1) ──────────────────────────────────────
  // Ask the user where to write the exported clip. Returns { canceled, filePath }.
  ctx.ipcMain.handle(
    IPCChannels.SHOW_SAVE_DIALOG,
    async (
      _e,
      req: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }
    ): Promise<{ canceled: boolean; filePath?: string }> => {
      const win = ctx.getMainWindow()
      const options: Electron.SaveDialogOptions = {
        title: 'Export Clip',
        defaultPath: req?.defaultPath,
        filters: req?.filters ?? [{ name: 'MP4 Video', extensions: ['mp4'] }],
        properties: ['createDirectory']
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      return { canceled: result.canceled, filePath: result.filePath || undefined }
    }
  )

  // ── System: open / reveal folder (PRD §10.1) ─────────────────────────────
  // If `path` is a directory, open it; otherwise reveal the file in its folder
  // (the export UX hands the output FILE path — "open folder" reveals the clip).
  ctx.ipcMain.handle(IPCChannels.OPEN_FOLDER, async (_e, req: { path: string }): Promise<void> => {
    let isDir = false
    try {
      isDir = statSync(req.path).isDirectory()
    } catch {
      isDir = false
    }
    if (isDir) {
      await shell.openPath(req.path)
    } else {
      shell.showItemInFolder(req.path)
    }
  })

  // ── EXPORT_CLIP (control-plane entry, PRD §10.1) ─────────────────────────
  // Parity/correlation entry. The real encode runs as a streaming `export` job
  // (renderer uses jobs.start('export', …) for live progress); the per-job
  // MessagePort is delivered out-of-band over JOB_PORT, never over invoke. This
  // returns the resolved output path so a caller can correlate the result.
  ctx.ipcMain.handle(
    IPCChannels.EXPORT_CLIP,
    async (
      _e,
      req: { projectId: string; clipId: string; outputPath: string }
    ): Promise<{ outputPath: string }> => {
      return { outputPath: req.outputPath }
    }
  )

  // ── Fake-sidecar mode (plan E.10) ────────────────────────────────────────
  // A fixed, schema-valid SourceVideo so the integration E2E can import without
  // ffprobe / a real file. (Real IMPORT_VIDEO/IMPORT_FROM_URL belong to a later
  // import track; only the export-relevant channels above are wired here.)
  if (process.env.OPENCLIP_FAKE_TRANSCRIBE) {
    ctx.ipcMain.handle(
      IPCChannels.IMPORT_VIDEO,
      (_e, req: { filePath: string }): ImportVideoResult => ({
        sourceVideo: {
          path: req.filePath,
          duration: 240,
          resolution: { width: 1920, height: 1080 },
          fps: 30,
          format: 'mp4'
        }
      })
    )
  }
}
