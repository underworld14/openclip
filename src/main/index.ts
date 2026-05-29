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
import type { JobKind, JobParams } from '@shared/jobs'
import { registerAllHandlers, type IpcContext } from './ipc'
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

let mainWindow: BrowserWindow | null = null
const sidecar = new SidecarManager()
const keyVault = createKeyVault()

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
 */
function cspHeader(): string {
  if (is.dev) {
    return [
      "default-src 'self'",
      "script-src 'self'",
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
    "connect-src 'self' https:",
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'OpenClip Desktop',
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // External links open in the OS browser, never an in-app window.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
  ipcMain.handle(
    IPCChannels.JOB_START,
    (event, payload: { kind: JobKind; params: JobParams[JobKind] }): { jobId: string } => {
      const { port1, port2 } = new MessageChannelMain()
      port1.start()
      const eventPort: EventPort = {
        postMessage: (value) => port1.postMessage(value),
        close: () => port1.close(),
        on: (ev, listener) => port1.on(ev, listener),
        start: () => port1.start()
      }
      const jobId = sidecar.startJob(payload.kind, payload.params, eventPort)
      // Transfer the peer port to the exact sender frame, tagged with the jobId
      // so the renderer can pair the live port to the job it just started.
      const frame = event.senderFrame
      if (frame) frame.postMessage(IPCChannels.JOB_PORT, { jobId }, [port2])
      return { jobId }
    }
  )

  ipcMain.handle(IPCChannels.JOB_CANCEL, (_event, req: { jobId: string }) => {
    sidecar.cancel(req.jobId)
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

  installCsp()

  // Serve the source video to the preview <video> over the privileged scheme
  // (PRD §6.6). The scheme was registered as privileged at module-eval time.
  installMediaProtocolHandler()

  // Smoke round-trip used by Gate A.
  ipcMain.handle('ping', () => 'pong')

  // DI seam: build the context once and loop the frozen registrars (E.4).
  const ctx: IpcContext = {
    ipcMain,
    getMainWindow: () => mainWindow,
    sidecar,
    keyVault
  }
  registerAllHandlers(ctx)
  wireJobControlPlane()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
