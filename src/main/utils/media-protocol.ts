/**
 * src/main/utils/media-protocol.ts — the `openclip-media://` source-video
 * protocol (TIMELINE spine, plan E.5 / PRD §6.6 "HTML5 <video> on a registered
 * `file:`-safe protocol").
 *
 * WHY a custom protocol (not a raw `file://` src): the renderer runs at
 * `http://localhost:…` (dev, electron-vite HMR) or `file://…/index.html` (prod),
 * and the BrowserWindow has the full security baseline (`webSecurity: true`,
 * `sandbox: true`, a strict CSP — PRD §12.2). A bare `file://` URL pointing at an
 * arbitrary source video on disk is a DIFFERENT origin and is blocked by Chromium
 * for media loads. The supported, contextIsolation-safe way to feed an
 * `<video>` a local file under `webSecurity` is a privileged custom scheme that
 * streams the file through `protocol.handle` → `net.fetch(pathToFileURL(...))`.
 *
 * `net.fetch` over a `file:` URL supports HTTP RANGE requests, so the `<video>`
 * element can SEEK (request byte ranges) rather than download the whole file —
 * exactly what the timeline scrub needs (PRD §6.6 "smooth scrub").
 *
 * SECURITY: the scheme only ever serves a single absolute path encoded in the
 * URL. We decode it, resolve it, and `net.fetch` the resulting `file:` URL.
 * Nothing here grants the renderer broader filesystem reach than the path it was
 * already handed by the import/probe pipeline (the source video path lives in the
 * Project document the renderer already holds).
 *
 * Registration order (Electron 41): `registerSchemesAsPrivileged` MUST run before
 * `app.whenReady()` (module-eval time in main/index.ts); `protocol.handle` runs
 * after ready.
 *
 * IMPORTANT — `electron` is imported LAZILY (inside the register/install
 * functions) so the PURE URL helpers (`mediaUrlForPath`/`pathFromMediaUrl`) can
 * be unit-tested without an Electron runtime (mirrors the `utils/paths.ts`
 * pattern). The round-trip spec imports those helpers directly.
 */

import { pathToFileURL } from 'node:url'
import type { Protocol, Net } from 'electron'

/** Lazy, typed access to Electron's `protocol` + `net` (kept lazy for testability). */
function electron(): { protocol: Protocol; net: Net } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as { protocol: Protocol; net: Net }
}

/** The custom scheme name (kept in one place so renderer + CSP stay in sync). */
export const MEDIA_SCHEME = 'openclip-media'

/**
 * Build the `openclip-media://` URL for an absolute source path. Mirrors the
 * renderer's `sourceMediaUrl()` EXACTLY (segment-wise `encodeURIComponent`) so a
 * URL produced by either side decodes on the other — the renderer cannot import
 * this main module, so the encoding is duplicated and a round-trip unit test
 * asserts agreement.
 *
 *   /Users/me/My Movie.mp4  →  openclip-media://file/Users/me/My%20Movie.mp4
 */
export function mediaUrlForPath(absPath: string): string {
  const encoded = absPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `${MEDIA_SCHEME}://file${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/**
 * Decode an `openclip-media://file/...` request URL back to an absolute path.
 * Mirrors the encoder (segment-wise `decodeURIComponent`); the `host` is always
 * `file`, so we take the URL's pathname and decode each segment.
 */
export function pathFromMediaUrl(requestUrl: string): string {
  const u = new URL(requestUrl)
  // u.pathname is "/Users/me/My%20Movie.mp4" (host is "file").
  return u.pathname
    .split('/')
    .map((seg) => decodeURIComponent(seg))
    .join('/')
}

/**
 * Register the scheme as PRIVILEGED. Called at main module-eval time, before
 * `app.whenReady()` (Electron requires this ordering — it can only be called
 * once, before ready). `stream` enables media (`<video>`) playback with range
 * requests; `supportFetchAPI` lets `protocol.handle` return a `net.fetch`
 * Response; `bypassCSP` lets the privileged scheme load under our strict CSP;
 * `secure`/`standard` give it a real origin.
 */
export function registerMediaScheme(): void {
  electron().protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        bypassCSP: true
      }
    }
  ])
}

/**
 * Install the `protocol.handle` for the media scheme. Called after
 * `app.whenReady()`. Streams the requested local file through `net.fetch` (range
 * requests honoured); returns a 400 for an undecodable URL.
 */
export function installMediaProtocolHandler(): void {
  const { protocol, net } = electron()
  protocol.handle(MEDIA_SCHEME, (req) => {
    let absPath: string
    try {
      absPath = pathFromMediaUrl(req.url)
    } catch {
      return new Response('bad media url', { status: 400 })
    }
    // net.fetch on a file: URL supports Range → the <video> can seek without
    // pulling the whole file. Method/headers (incl. Range) are forwarded.
    return net.fetch(pathToFileURL(absPath).toString(), {
      method: req.method,
      headers: req.headers
    })
  })
}
