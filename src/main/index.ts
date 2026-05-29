/**
 * src/main/index.ts — the main-process entry (TRUNK, frozen seam).
 *
 * Responsibilities:
 *   - Create the BrowserWindow with the FULL security baseline (PRD §12.2):
 *     contextIsolation: true, sandbox: true, nodeIntegration: false, plus a
 *     strict CSP installed on every response (no eval / no inline script).
 *   - Build the single `IpcContext` (DI seam) and loop `HANDLER_REGISTRARS`
 *     (E.4) so each fan-out track fills only its own `ipc/<domain>.ts`.
 *   - Wire the streaming-job control plane: JOB_START transfers a MessagePort
 *     to the renderer and drives the SidecarManager; JOB_CANCEL is plain invoke.
 *   - Install the sidecar kill-on-quit lifecycle hooks (PRD §17).
 *   - A `ping` IPC for the smoke round-trip (Gate A).
 *
 * The window JSX/layout lives in the renderer; this file is never edited by a
 * fan-out track (it only loops the frozen registry).
 */

import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
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

let mainWindow: BrowserWindow | null = null
const sidecar = new SidecarManager()
const keyVault = createKeyVault()

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
      "media-src 'self' blob: file:",
      "connect-src 'self' ws: http: https:",
      "font-src 'self' data:"
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: file:",
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
 * The renderer calls `ipcRenderer.postMessage(JOB_START, {kind,params}, [port2])`
 * (the only way to transfer a MessagePort over IPC). We receive `port1` here as
 * a MessagePortMain, hand it to the SidecarManager as an EventPort, and reply
 * with the jobId over the same port's first message. JOB_CANCEL stays a plain
 * `invoke` so cancel can never be starved by a busy data port.
 */
function wireJobControlPlane(): void {
  ipcMain.on(
    IPCChannels.JOB_START,
    (event, payload: { kind: JobKind; params: JobParams[JobKind] }) => {
      const [port] = event.ports
      if (!port) return
      port.start()
      const eventPort: EventPort = {
        postMessage: (value) => port.postMessage(value),
        close: () => port.close(),
        on: (ev, listener) => port.on(ev, listener),
        start: () => port.start()
      }
      const jobId = sidecar.startJob(payload.kind, payload.params, eventPort)
      // First message on the port carries the assigned jobId for cancel().
      port.postMessage({ t: 'job-id', jobId })
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
