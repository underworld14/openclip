/**
 * src/main/ipc/project.ts — project persistence handlers (T-Persist, E.3/E.4).
 *
 * Wires SAVE_PROJECT / LOAD_PROJECT / LIST_PROJECTS / DELETE_PROJECT (PRD §10.1)
 * to the pure `project-store` service. The projects directory is resolved ONCE
 * here from trunk-frozen `utils/paths.ts` (`projectsDir()` — the only place
 * `app.getPath('userData')` is touched), then injected into the store so the
 * store itself stays Electron-free and unit-testable (plan E.3).
 *
 * This is the only project-domain registrar the frozen `HANDLER_REGISTRARS`
 * registry (`ipc/index.ts`) invokes; it owns exactly these four channels and
 * touches no other track's surface (E.4 one-writer-per-file).
 */

import type { IpcContext } from './index'
import { IPCChannels } from '@shared/channels'
import type { ChannelReq, ChannelRes } from '@shared/channels'
import { projectsDir, mediaDir, tempRootFor } from '@main/utils/paths'
import {
  patchProject,
  saveProject,
  loadProject,
  listProjects,
  deleteProject
} from '@main/services/project-store'
import { deleteProjectMedia } from '@main/services/media-store'
import { serializeTranscript, subtitleExtension } from '@shared/subtitle-export'
import { assertSafePathArg } from '@main/utils/safe-arg'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function registerProjectHandlers(ctx: IpcContext): void {
  const { ipcMain } = ctx

  // project:save — persist a Project to <userData>/projects/<id>.ocproj, bumping
  // updatedAt (an explicit/auto save means the doc changed). Returns the path.
  ipcMain.handle(
    IPCChannels.SAVE_PROJECT,
    async (
      _e,
      req: ChannelReq<IPCChannels.SAVE_PROJECT>
    ): Promise<ChannelRes<IPCChannels.SAVE_PROJECT>> => {
      const { path } = await saveProject(projectsDir(), req.project, { touchUpdatedAt: true })
      return { path }
    }
  )

  // project:save-patch — persist ONLY what changed (BUG-g6zq2t). Autosave uses
  // this for the overwhelmingly common edit (clips, and nothing else), so the
  // transcript's word array never crosses the contextBridge for a clip approval.
  ipcMain.handle(
    IPCChannels.SAVE_PROJECT_PATCH,
    async (
      _e,
      req: ChannelReq<IPCChannels.SAVE_PROJECT_PATCH>
    ): Promise<ChannelRes<IPCChannels.SAVE_PROJECT_PATCH>> => {
      const { path } = await patchProject(projectsDir(), req, { touchUpdatedAt: true })
      return { path }
    }
  )

  // transcript:export — write the transcript as SRT / VTT / plain text
  // (FEAT-vwvgs0). PRD §6.2 lists this as an acceptance criterion and the whole
  // tree had zero matches for srt/vtt: the app could burn captions into pixels
  // but could not hand the user the data.
  //
  // Main does the SERIALIZING, not just the write. The renderer supplies a
  // transcript and a format; it cannot ask for arbitrary bytes at an arbitrary
  // path, and the extension is enforced here.
  ipcMain.handle(
    IPCChannels.EXPORT_TRANSCRIPT,
    async (
      _e,
      req: ChannelReq<IPCChannels.EXPORT_TRANSCRIPT>
    ): Promise<ChannelRes<IPCChannels.EXPORT_TRANSCRIPT>> => {
      const text = serializeTranscript(req.transcript, req.format, req.clip)
      const ext = `.${subtitleExtension(req.format)}`
      const path = req.outputPath.toLowerCase().endsWith(ext)
        ? req.outputPath
        : `${req.outputPath}${ext}`
      assertSafePathArg(path, 'outputPath')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text, 'utf8')
      return { path }
    }
  )

  // project:load — read + JSON.parse + Zod re-validate (rejects tampered/older
  // files with a typed ProjectStoreError that propagates over IPC — PRD §12.3).
  ipcMain.handle(
    IPCChannels.LOAD_PROJECT,
    async (
      _e,
      req: ChannelReq<IPCChannels.LOAD_PROJECT>
    ): Promise<ChannelRes<IPCChannels.LOAD_PROJECT>> => {
      const project = await loadProject(projectsDir(), req.id)
      // Grant the project's source path so the openclip-media:// scheme may serve
      // it to the preview <video> (audit fix openclip-8tx). Residual risk: a
      // tampered .ocproj naming an arbitrary path is granted here, but the bytes
      // only feed a media decoder — accepted vs. breaking file-import-from-anywhere
      // (documented in media-protocol.ts installMediaProtocolHandler).
      ctx.mediaAccess.grant(project.sourceVideo.path)
      return project
    }
  )

  // project:list — recent-projects metadata for the Dashboard (newest first).
  ipcMain.handle(
    IPCChannels.LIST_PROJECTS,
    async (): Promise<ChannelRes<IPCChannels.LIST_PROJECTS>> => {
      return listProjects(projectsDir())
    }
  )

  // project:delete — idempotent removal of a .ocproj file. Also reclaims the
  // project's OWNED media dir <userData>/media/<id>/ (Part H) AND its per-project
  // TEMP cache <temp>/openclip/<id>/ — the content-addressed WAV extract plus any
  // clip poster frames (BUG-08sb0x): `sweepOrphanTemp`'s launch sweep deliberately
  // PRESERVES `cache/` forever (it's a cache keyed by content, not scratch), so
  // without this a deleted project's cache lived on disk indefinitely — ~115 MB
  // per source hour, never reclaimed by anything. Both are best-effort, so a
  // media/temp-rm failure never fails the project delete (the launch sweep is the
  // backstop for temp; media has no backstop but this only ever touches
  // media/<id>/ and openclip/<id>/ — a file-import original (outside mediaDir,
  // appOwned:false) is structurally unreachable either way).
  ipcMain.handle(
    IPCChannels.DELETE_PROJECT,
    async (
      _e,
      req: ChannelReq<IPCChannels.DELETE_PROJECT>
    ): Promise<ChannelRes<IPCChannels.DELETE_PROJECT>> => {
      try {
        return await deleteProject(projectsDir(), req.id)
      } finally {
        await deleteProjectMedia(req.id, mediaDir()).catch((err) => {
          console.error(`[media] failed to reclaim media for project ${req.id}:`, err)
        })
        // `tempRootFor` is a PLAIN function — it throws SYNCHRONOUSLY on an unsafe
        // id, before `rm()` is even called, so a bare `.catch()` on the `rm(...)`
        // promise would never run and the throw would escape this `finally`
        // (silently replacing whatever the `try` block above did — a real
        // Node/JS footgun). An explicit try/catch is required here, unlike the
        // `deleteProjectMedia` call above (an `async function`, whose internal
        // throw is already a rejected promise `.catch()` can see).
        try {
          await rm(tempRootFor(req.id), { recursive: true, force: true })
        } catch (err) {
          console.error(`[temp] failed to reclaim temp cache for project ${req.id}:`, err)
        }
      }
    }
  )
}
