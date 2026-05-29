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
import { urlDownloadRunner } from '@main/services/jobs/url-download-runner'
import { probeVideo } from '@main/utils/ffprobe'

export function registerVideoHandlers(ctx: IpcContext): void {
  // Plug the streaming export runner into the sidecar's JOB_RUNNERS registry
  // (startup seam, E.4). Guarded so a test re-import doesn't throw.
  if (!hasRunner('export')) registerRunner('export', exportRunner)
  // F.4: the URL/YouTube import streams via jobs.start('url-download', …). The
  // renderer half (import-pipeline URL branch) is built by a later agent; expose
  // the runner now. Guarded so a test re-import doesn't throw.
  if (!hasRunner('url-download')) registerRunner('url-download', urlDownloadRunner)

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

  // ── System: open dialog (F.3 unified import) ─────────────────────────────
  // Native file picker for "Choose file…" on the welcome/import screen. The
  // picker scope is HARD-CODED to a single video file (G.7 least-privilege): we
  // deliberately IGNORE renderer-supplied properties/filters so a misbehaving
  // renderer can't coax the user into picking a directory or a non-video file the
  // import flow doesn't expect. Returns { canceled, filePaths }.
  ctx.ipcMain.handle(
    IPCChannels.SHOW_OPEN_DIALOG,
    async (): Promise<{ canceled: boolean; filePaths: string[] }> => {
      const win = ctx.getMainWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Import Video',
        properties: ['openFile'],
        filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { canceled: result.canceled, filePaths: result.filePaths ?? [] }
    }
  )

  // ── System: directory picker (Part K, batch export Step 4) ───────────────
  // Choose ONE output folder for "Export all". Hard-scoped server-side to a
  // directory (G.7 least-privilege): renderer-supplied options are IGNORED so a
  // misbehaving renderer can't coax the user into picking a file/other path.
  ctx.ipcMain.handle(
    IPCChannels.SHOW_DIRECTORY_DIALOG,
    async (): Promise<{ canceled: boolean; dirPath?: string }> => {
      const win = ctx.getMainWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Choose export folder',
        properties: ['openDirectory', 'createDirectory']
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { canceled: result.canceled, dirPath: result.filePaths?.[0] }
    }
  )

  // ── System: image picker (Part K, brand kit Step 5) ──────────────────────
  // Pick a single PNG logo (alpha needed for a clean overlay). Hard-scoped to a
  // single PNG file server-side (G.7 least-privilege); renderer options ignored.
  ctx.ipcMain.handle(
    IPCChannels.SHOW_IMAGE_DIALOG,
    async (): Promise<{ canceled: boolean; filePaths: string[] }> => {
      const win = ctx.getMainWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Choose logo (PNG)',
        properties: ['openFile'],
        filters: [{ name: 'PNG Image', extensions: ['png'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { canceled: result.canceled, filePaths: result.filePaths ?? [] }
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

  // ── Import / probe (PRD §6.1: validate format + read metadata via ffprobe) ──
  // In fake-sidecar mode (plan E.10) return a fixed, schema-valid SourceVideo so
  // the integration E2E can import without a real media file. Otherwise probe
  // the real file with the bundled ffprobe — the prod packaged-app path the
  // Gate-D smoke exercises (binary resolved from Contents/Resources).
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
  } else {
    ctx.ipcMain.handle(
      IPCChannels.IMPORT_VIDEO,
      async (_e, req: { filePath: string }): Promise<ImportVideoResult> => ({
        sourceVideo: await probeVideo(req.filePath)
      })
    )
  }
}
