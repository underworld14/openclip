/**
 * src/main/index.ts — the main-process entry (TRUNK, frozen seam).
 *
 * Responsibilities:
 *   - Create the BrowserWindow with the FULL security baseline (PRD §12.2):
 *     contextIsolation: true, sandbox: true, nodeIntegration: false, plus a
 *     strict CSP installed on every response (no eval / no inline script).
 *   - Build the single `IpcContext` (DI seam) and loop `HANDLER_REGISTRARS`
 *     (E.4) so each fan-out track fills only its own `ipc/<domain>.ts`.
 *   - Wire the streaming-job control plane: JOB_START (invoke → {jobId}) opens a
 *     MessageChannelMain, drives the SidecarManager on port1, and transfers port2
 *     to the renderer out-of-band over JOB_PORT; JOB_CANCEL is plain invoke.
 *   - Install the sidecar kill-on-quit lifecycle hooks (PRD §17).
 *   - A `ping` IPC for the smoke round-trip (Gate A).
 *
 * The window JSX/layout lives in the renderer; this file is never edited by a
 * fan-out track (it only loops the frozen registry).
 */

import { app, shell, BrowserWindow, ipcMain, session, MessageChannelMain } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPCChannels } from '@shared/channels'
import { registerAllHandlers, type IpcContext } from './ipc'
import { validateJobStart } from './ipc/job-start-validation'
import {
  SidecarManager,
  createPQueueLimiterFactory,
  type EventPort
} from './services/sidecar-manager'
import { createKeyVault } from './utils/security'
import {
  MEDIA_SCHEME,
  registerMediaScheme,
  installMediaProtocolHandler
} from './utils/media-protocol'
import { createMediaAccess } from './utils/media-access'
import { mediaDir, openclipTempRoot } from './utils/paths'

let mainWindow: BrowserWindow | null = null
const sidecar = new SidecarManager()
const keyVault = createKeyVault()

// The `openclip-media://` allow-list (audit fix openclip-8tx): the scheme may
// serve only paths EXPLICITLY granted (import/probe + project load) or under an
// always-allowed root (the app-owned media dir + the OpenClip temp root, where
// previews/extracts live). Built once and shared by the protocol handler + ctx.
// Built lazily inside whenReady (mediaDir()/openclipTempRoot() touch app paths).
let mediaAccess: ReturnType<typeof createMediaAccess>

// The source-video preview protocol (PRD §6.6) is PRIVILEGED and must be
// registered before `app.whenReady()` — this runs at module-eval time. The
// handler itself is installed after ready (see whenReady below).
registerMediaScheme()

// ============================================================================
// Content-Security-Policy (PRD §12.2 — no eval, no inline scripts)
// ============================================================================

/**
 * In dev, electron-vite serves the renderer over http with HMR (needs
 * 'unsafe-inline' styles + ws). In prod everything is local `file:` so we can
 * be strict: default-src 'self', no inline script, no eval.
 *
 * F.5 audit: this header is now the SINGLE source of truth (the page-level
 * <meta> CSP was removed from index.html — it intersected with this header and
 * the stale meta blocked the module script/media in the packaged build).
 *
 * DEV vs PROD differ for script-src. In PROD the renderer is a static built
 * bundle whose only entry is an EXTERNAL module script (covered by
 * `script-src 'self'`) — so prod stays strict (no inline, no eval). In DEV,
 * `@vitejs/plugin-react` (Fast Refresh) injects an INLINE `<script type=module>`
 * preamble into the page and `main.tsx` throws if that preamble didn't run
 * (`__vite_plugin_react_preamble_installed__`). A strict `script-src 'self'`
 * blocks that inline preamble → React never mounts → blank (dark) window on
 * `npm run dev`. So DEV must allow `'unsafe-inline' 'unsafe-eval'` for scripts
 * (HMR/Refresh). This relaxation is DEV-ONLY and never ships.
 *
 * In both: Tailwind v4 injects styles via <style> tags (`style-src 'unsafe-inline'`);
 * AI providers are reached over https (`connect-src https:`); the source-video
 * preview streams over the privileged `openclip-media:` scheme + blob:/file:
 * (`media-src`). `font-src 'self' data:` covers the bundled font + any data: URI.
 */
function cspHeader(): string {
  if (is.dev) {
    return [
      "default-src 'self'",
      // DEV-ONLY: Vite HMR + React Fast Refresh inject an inline module preamble
      // and may eval; without these the renderer can't boot in dev (see above).
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      // The privileged `openclip-media:` scheme serves the source video to the
      // preview <video> (PRD §6.6); it bypasses CSP itself but is listed here too.
      `media-src 'self' blob: file: ${MEDIA_SCHEME}:`,
      "connect-src 'self' ws: http: https:",
      "font-src 'self' data:"
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `media-src 'self' blob: file: ${MEDIA_SCHEME}:`,
    // ── CSP TIGHTENING (audit fix — revert THIS LINE alone to restore `https:`) ──
    // The renderer makes NO direct outbound network requests: every AI provider
    // call (OpenAI/Anthropic/Ollama/OpenRouter) runs in the MAIN process via
    // ai-client.ts, and onnxruntime-web loads its WASM from a LOCAL `wasmPaths`
    // dir (reframeWasmDir()) in main — also main-side. So the renderer only ever
    // talks to `'self'`; dropping `https:` removes a needless exfil channel.
    "connect-src 'self'",
    "font-src 'self' data:"
  ].join('; ')
}

function installCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspHeader()]
      }
    })
  })
}

// ============================================================================
// Window (full security baseline)
// ============================================================================

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  // Native-macOS chrome (F.1): inset traffic lights over a vibrant sidebar, with
  // a near-transparent backgroundColor so the vibrancy material shows through.
  // We DELIBERATELY do NOT set `transparent: true` (it kills the window shadow +
  // live resize). Off-mac we keep an opaque dark window. show:false +
  // ready-to-show is preserved so vibrancy doesn't flash an unpainted frame.
  const macChrome: Partial<Electron.BrowserWindowConstructorOptions> = isMac
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 14 },
        vibrancy: 'sidebar',
        visualEffectState: 'followWindow',
        // Near-transparent so the 'sidebar' vibrancy material shows; not fully
        // transparent (that would drop the shadow / break resize).
        backgroundColor: '#00000000'
      }
    : {
        // Off-mac: a sensible opaque dark background (matches the dark canvas).
        backgroundColor: '#0b0b0f'
      }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'OpenClip',
    ...macChrome,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // ── Security baseline (PRD §12.2) ──
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.title = 'OpenClip'

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // External links open in the OS browser, never an in-app window.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Defence in depth against in-page navigation. The renderer already swallows
  // drops window-wide, but a dropped file (or any stray link) must never be able
  // to replace the app with a file:// page — that discards every unsaved edit and
  // leaves no way back. The app itself never navigates after the initial load.
  const win = mainWindow
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ============================================================================
// Streaming-job control plane (MessagePort-per-job, PRD §10.2)
// ============================================================================

/**
 * JOB_START is a plain `invoke` returning `{ jobId }`. A `MessagePort` can
 * neither ride `invoke` nor survive being returned across the contextBridge
 * (the bridge structure-clones+freezes return values into a dead Object), so we
 * deliver the per-job port OUT-OF-BAND, the contextIsolation-safe Electron way
 * (MessageChannelMain → senderFrame.postMessage → preload forwards into the
 * main world; see preload/api/jobs.ts):
 *
 *   1. open a `MessageChannelMain`; keep `port1` (the emitter side the sidecar
 *      runner streams `JobEvent`s into), TRANSFER `port2` to the renderer;
 *   2. assign the jobId, then `event.senderFrame.postMessage(JOB_PORT, {jobId},
 *      [port2])` so the renderer can pair the LIVE port to the jobId;
 *   3. return `{ jobId }` so the `invoke` resolves.
 *
 * JOB_CANCEL stays a plain `invoke` so cancel can never be starved by a busy
 * data port (PRD §10.2).
 */
function wireJobControlPlane(): void {
  ipcMain.handle(IPCChannels.JOB_START, (event, payload: unknown): { jobId: string } => {
    // Validate the inbound payload at the trust boundary BEFORE allocating a port or
    // spawning anything (audit fix openclip-qki): a malformed/hostile renderer payload is
    // rejected with INPUT_INVALID instead of being forwarded into sidecar.startJob → spawn.
    const { kind, params } = validateJobStart(payload)
    const { port1, port2 } = new MessageChannelMain()
    port1.start()
    const eventPort: EventPort = {
      postMessage: (value) => port1.postMessage(value),
      close: () => port1.close(),
      on: (ev, listener) => port1.on(ev, listener),
      start: () => port1.start()
    }
    const jobId = sidecar.startJob(kind, params, eventPort)
    // Transfer the peer port to the exact sender frame, tagged with the jobId
    // so the renderer can pair the live port to the job it just started.
    const frame = event.senderFrame
    if (frame) {
      frame.postMessage(IPCChannels.JOB_PORT, { jobId }, [port2])
    } else {
      // The sender frame was destroyed/navigated before we could transfer the port,
      // so the renderer will NEVER receive this job's event stream (audit fix
      // openclip-jp1 belt-and-suspenders; the renderer's acquireJobPort timeout is
      // the primary guard). Close the orphaned port and cancel the just-started job
      // so it doesn't run consumer-less to completion.
      //
      // LOG IT (BUG-zcqyb7): this branch used to be entirely silent, which makes the
      // resulting renderer-side stall indistinguishable from a wedged sidecar — the
      // consumer just waits out acquireJobPort's timeout with no clue why. One line
      // here is the difference between "flaky hang" and a diagnosable cause.
      console.error(
        `[jobs] ${jobId}: senderFrame was null at JOB_START — the per-job MessagePort ` +
          `could not be transferred, so the job was cancelled and the renderer will ` +
          `see acquireJobPort time out.`
      )
      port2.close()
      sidecar.cancel(jobId)
    }
    return { jobId }
  })

  ipcMain.handle(IPCChannels.JOB_CANCEL, (_event, req: { jobId: string }) => {
    sidecar.cancel(req.jobId)
  })
}

/**
 * Quit-time autosave durability (audit fix openclip-49y): the renderer's `pagehide`
 * flush is an async IPC round-trip the unload path cannot await, so a save still inside
 * the debounce window at a hard quit could be lost. On `before-quit` we HOLD the quit,
 * ask the renderer to flush its pending debounced save (FLUSH_BEFORE_QUIT), and proceed
 * the instant it ACKs (AUTOSAVE_FLUSHED) — or after a bounded wait so a wedged/closed
 * renderer can never block quit.
 */
function wireQuitAutosaveFlush(): void {
  let quitFlushDone = false
  let resolveQuitFlush: (() => void) | null = null

  ipcMain.handle(IPCChannels.AUTOSAVE_FLUSHED, (): { ok: boolean } => {
    resolveQuitFlush?.()
    return { ok: true }
  })

  app.on('before-quit', (e) => {
    if (quitFlushDone) return // second pass (after we re-quit) → let it through
    const wc = mainWindow?.webContents
    if (!wc || wc.isDestroyed()) return // no renderer to flush → quit normally
    e.preventDefault()
    const proceed = (): void => {
      if (quitFlushDone) return
      quitFlushDone = true
      resolveQuitFlush = null
      app.quit()
    }
    resolveQuitFlush = proceed
    wc.send(IPCChannels.FLUSH_BEFORE_QUIT)
    // Backstop: never let a wedged renderer hang the quit.
    setTimeout(proceed, 2000)
  })
}

// ============================================================================
// App lifecycle
// ============================================================================

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.openclip.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Use the production-grade p-queue limiter (ESM, dynamically imported).
  try {
    sidecar.setLimiterFactory(await createPQueueLimiterFactory())
  } catch {
    // Falls back to the built-in array limiter if p-queue can't load.
  }
  sidecar.installLifecycleHooks(app)
  wireQuitAutosaveFlush()

  installCsp()

  // Build the media allow-list (audit fix openclip-8tx) BEFORE installing the
  // protocol handler. Roots are resolved here (app paths are now available).
  mediaAccess = createMediaAccess({ alwaysAllowedRoots: [mediaDir(), openclipTempRoot()] })

  // Serve the source video to the preview <video> over the privileged scheme
  // (PRD §6.6), scoped by the allow-list. The scheme was registered as
  // privileged at module-eval time.
  installMediaProtocolHandler(mediaAccess)

  // Smoke round-trip used by Gate A.
  ipcMain.handle('ping', () => 'pong')

  // Gate-D packaged-bundle diagnostic (PRD §13): expose the PRODUCTION-resolved
  // sidecar/font paths + process.resourcesPath so the packaged-app smoke can
  // prove binaries resolve from Contents/Resources (NOT node_modules). Read-only
  // path strings, no secrets — harmless to keep in production. Resolved lazily so
  // the import of `paths` stays cheap.
  ipcMain.handle('diag:resolved-paths', async () => {
    const paths = await import('./utils/paths')
    return {
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      ffmpeg: paths.ffmpegPath(),
      ffprobe: paths.ffprobePath(),
      whisperCli: paths.whisperCliPath(),
      fontsDir: paths.fontsDir()
    }
  })

  // Gate-D auto-reframe diagnostic (Part J): load + run the bundled YuNet model
  // through the REAL runtime path (require('onnxruntime-web') resolved from
  // app.asar + wasm/model from <Resources>/onnx). Proves the packaged main process
  // can actually run on-device face detection, not just that the files exist.
  // Lazy import so onnxruntime-web is only loaded when the diagnostic is invoked.
  ipcMain.handle('diag:reframe-probe', async () => {
    const { probeReframeModel } = await import('./services/reframe-detect')
    return probeReframeModel()
  })

  // DI seam: build the context once and loop the frozen registrars (E.4).
  const ctx: IpcContext = {
    ipcMain,
    getMainWindow: () => mainWindow,
    sidecar,
    keyVault,
    mediaAccess
  }
  registerAllHandlers(ctx)
  wireJobControlPlane()

  // Launch-time orphan-media sweep (Part H): reclaim <userData>/media/<id>/ dirs
  // with no matching .ocproj (downloads from crashed/abandoned imports). Fire-and-
  // forget so window creation isn't blocked; best-effort + logged.
  void sweepOrphanMediaAtLaunch().catch((err) => console.error('[media] orphan sweep failed:', err))

  // Launch-time orphan-temp sweep (audit fix openclip-2j3): reclaim per-job temp
  // scratch left by a crash/SIGKILL before a runner's finally could delete it,
  // preserving every project's content-addressed cache/ + any still-active job.
  // Fire-and-forget; best-effort + logged.
  void sweepOrphanTempAtLaunch().catch((err) => console.error('[temp] orphan sweep failed:', err))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Reclaim orphaned app-owned media at launch (Part H): media subdirs are named by
 * project id, so any `<userData>/media/<id>/` without a matching `<id>.ocproj` is
 * a leftover from a crashed/abandoned import. Reads `.ocproj` basenames directly
 * (no Zod parse) so a transiently-unreadable project still protects its media.
 */
async function sweepOrphanMediaAtLaunch(): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  const { projectsDir, mediaDir } = await import('./utils/paths')
  const { sweepOrphanMedia } = await import('./services/media-store')
  const { OCPROJ_EXT } = await import('./services/project-store')
  let referenced: string[] = []
  try {
    const entries = await readdir(projectsDir())
    referenced = entries
      .filter((f) => f.endsWith(OCPROJ_EXT))
      .map((f) => f.slice(0, -OCPROJ_EXT.length))
  } catch {
    // No projects dir yet ⇒ everything under media/ is orphaned; sweep with [].
  }
  const { removed } = await sweepOrphanMedia(referenced, mediaDir())
  if (removed.length) console.log(`[media] swept ${removed.length} orphan media dir(s):`, removed)
}

/**
 * Reclaim orphaned per-job temp scratch at launch (audit fix openclip-2j3): per-
 * job dirs under `<temp>/openclip/` are normally removed in each runner's
 * `finally`, but a crash/SIGKILL can leave them behind. Sweep them, preserving
 * every project's content-addressed `cache/` and any STILL-active job (so a sweep
 * fired alongside a running job can't yank its live scratch).
 */
async function sweepOrphanTempAtLaunch(): Promise<void> {
  const { openclipTempRoot } = await import('./utils/paths')
  const { sweepOrphanTemp } = await import('./services/temp-store')
  const { removed } = await sweepOrphanTemp(sidecar.activeJobIds(), openclipTempRoot())
  if (removed.length) console.log(`[temp] swept ${removed.length} orphan temp dir(s):`, removed)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
