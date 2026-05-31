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
 * SECURITY (audit fix openclip-8tx): the scheme serves a single absolute path
 * encoded in the URL, but ONLY if that path is in the injected `MediaAccess`
 * allow-list (explicitly granted source videos + the app-owned media/temp
 * roots). The handler decodes, rejects traversal/NUL, `realpathSync`-resolves,
 * checks `isAllowed`, and only then `net.fetch`es the REALPATH. Without the
 * allow-list this scheme was an arbitrary-file-read primitive (any absolute path
 * the renderer could name was streamed back). See `media-access.ts`.
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
import { realpathSync } from 'node:fs'
import type { Protocol, Net } from 'electron'
import type { MediaAccess } from './media-access'

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
 * Pure path-safety predicate (audit fix openclip-8tx): a decoded media path is
 * UNSAFE if it carries a NUL byte (path truncation) or any `..` segment
 * (traversal). The protocol handler rejects an unsafe path with 400.
 *
 * NOTE: the WHATWG `URL`/`Request` parser already collapses `..` in a scheme
 * request's pathname before the handler ever sees it, so a request-driven `..`
 * is neutralised upstream too — this is the belt-and-suspenders check on the
 * DECODED path (and the directly-testable seam for the traversal rule).
 */
export function isUnsafeMediaPath(decodedPath: string): boolean {
  if (decodedPath.includes('\0')) return true
  return decodedPath.split(/[\\/]/).includes('..')
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
 * requests honoured), but ONLY after the request clears the security gate:
 *
 *   1. method must be GET/HEAD (a media load is read-only) → 405 otherwise,
 *   2. the URL must decode (`pathFromMediaUrl`) → 400 on throw,
 *   3. the decoded path must contain no NUL byte and no `..` segment → 400,
 *   4. it must resolve on disk (`realpathSync`) → 404 on ENOENT,
 *   5. the REALPATH must be in the injected allow-list → 403 otherwise.
 *
 * Only then do we `net.fetch(pathToFileURL(realpath))` — fetching the CANONICAL
 * realpath (not the as-typed path) so a symlink can't be the thing that's served.
 *
 * ACCEPTED RESIDUAL RISK: a hand-crafted/malicious `.ocproj` can name an
 * arbitrary path (e.g. `/etc/passwd`) as its `sourceVideo.path`; LOAD_PROJECT
 * grants that path, so the scheme would serve its bytes. We accept this: the
 * bytes only ever feed a media (`<video>`) decoder in the renderer, and the
 * alternative — refusing any path outside the app-owned roots — would break the
 * core "import a video from anywhere on disk" feature. The grant is the
 * narrowest capability that keeps file-import working.
 *
 * `realpathSync` is `node:fs` (not Electron), so the pure URL helpers above stay
 * runtime-free for unit tests even though it's a top-level import.
 */
export function installMediaProtocolHandler(
  access: MediaAccess,
  // Injectable electron seam (DI for tests): the lazy `require('electron')` can't
  // be intercepted by `vi.mock('electron')` (native require), so tests pass a
  // fake `{ protocol, net }`. Production calls with one arg → the real Electron.
  electronOverride?: { protocol: Pick<Protocol, 'handle'>; net: Pick<Net, 'fetch'> }
): void {
  const { protocol, net } = electronOverride ?? electron()
  protocol.handle(MEDIA_SCHEME, (req) => {
    // 1. Read-only: a media load is GET (HEAD for metadata). Anything else is
    //    not a thing the <video> element does → reject.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 })
    }

    // 2. Decode the path out of the URL.
    let absPath: string
    try {
      absPath = pathFromMediaUrl(req.url)
    } catch {
      return new Response('bad media url', { status: 400 })
    }

    // 3. Reject obvious traversal/poison BEFORE touching the fs: a NUL byte
    //    (path truncation) or any `..` path segment. (URL normalisation already
    //    collapses request-driven `..`; this is the belt-and-suspenders check.)
    if (isUnsafeMediaPath(absPath)) {
      return new Response('bad media path', { status: 400 })
    }

    // 4. Canonicalise. A non-existent path can't be served (and realpath also
    //    collapses any residual symlink/`.` so the allow-list check is honest).
    //    `realpathSync` is `node:fs` (NOT Electron), so the pure URL helpers above
    //    stay runtime-free for unit tests even with this top-level import.
    let realPath: string
    try {
      realPath = realpathSync(absPath)
    } catch {
      return new Response('not found', { status: 404 })
    }

    // 5. Scope check (audit fix openclip-8tx): only granted paths / paths under
    //    an always-allowed root are servable.
    if (!access.isAllowed(realPath)) {
      return new Response('forbidden', { status: 403 })
    }

    // net.fetch on a file: URL supports Range → the <video> can seek without
    // pulling the whole file. Method/headers (incl. Range) are forwarded. We
    // fetch the REALPATH so the served bytes match what we authorised.
    return net.fetch(pathToFileURL(realPath).toString(), {
      method: req.method,
      headers: req.headers
    })
  })
}
