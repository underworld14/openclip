/**
 * tests/unit/media-protocol.spec.ts — the `openclip-media://` protocol handler
 * security gate (audit fix openclip-8tx) + the `media-access.ts` allow-list.
 *
 * The handler lazily `require('electron')`, which `vi.mock('electron')` cannot
 * intercept (native require), so `installMediaProtocolHandler` accepts an
 * INJECTED electron seam — we pass a fake `protocol.handle` (captures the
 * handler) + a fake `net.fetch` (tagged Response, records the file: URL it was
 * called with). The handler then runs in-process against a real temp filesystem.
 *
 * Asserts the gate: a granted file → 200 (net.fetch called with its REALPATH); a
 * file UNDER an always-allowed root → 200; an ungranted path (/etc/passwd) → 403
 * (net.fetch NOT called); `..`/NUL → 400; POST → 405; a symlink escaping the
 * allowed roots → 403. Plus a direct unit test of `createMediaAccess().isAllowed`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installMediaProtocolHandler,
  mediaUrlForPath,
  isUnsafeMediaPath
} from '@main/utils/media-protocol'
import { createMediaAccess, type MediaAccess } from '@main/utils/media-access'

const fetchCalls: string[] = []
let capturedHandler: ((req: Request) => Response | Promise<Response>) | null = null

/** A fake electron seam: capture the handler, tag + record net.fetch. */
function fakeElectron(): {
  protocol: { handle: (s: string, h: (req: Request) => Response | Promise<Response>) => void }
  net: { fetch: (url: string) => Promise<Response> }
} {
  return {
    protocol: {
      handle: (_scheme, h) => {
        capturedHandler = h
      }
    },
    net: {
      // Electron's net.fetch returns a Promise<Response>; mirror that here.
      fetch: (url) => {
        fetchCalls.push(url)
        return Promise.resolve(
          new Response('VIDEO-BYTES', { status: 200, headers: { 'x-tag': 'net-fetch' } })
        )
      }
    }
  }
}

let allowedRoot: string // an always-allowed root
let outside: string // a dir NOT under any allowed root
let grantedFile: string // an explicitly-granted file (outside the root)

function install(access: MediaAccess): void {
  installMediaProtocolHandler(access, fakeElectron())
}

async function call(url: string, method = 'GET'): Promise<Response> {
  expect(capturedHandler).toBeTruthy()
  return capturedHandler!(new Request(url, { method }))
}

beforeEach(async () => {
  fetchCalls.length = 0
  capturedHandler = null
  allowedRoot = await mkdtemp(join(tmpdir(), 'oc-mp-root-'))
  outside = await mkdtemp(join(tmpdir(), 'oc-mp-out-'))
  await writeFile(join(allowedRoot, 'preview.mp4'), 'X')
  grantedFile = join(outside, 'imported.mp4')
  await writeFile(grantedFile, 'Y')
})
afterEach(async () => {
  await rm(allowedRoot, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('installMediaProtocolHandler — security gate (openclip-8tx)', () => {
  function installWithGrant(): void {
    const access = createMediaAccess({ alwaysAllowedRoots: [allowedRoot] })
    access.grant(grantedFile)
    install(access)
  }

  it('serves an EXPLICITLY GRANTED file → 200, net.fetch called with its realpath', async () => {
    installWithGrant()
    const res = await call(mediaUrlForPath(grantedFile))
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    const expected = new URL(`file://${await realpath(grantedFile)}`).toString()
    expect(fetchCalls[0]).toBe(expected)
  })

  it('serves a file UNDER an always-allowed root → 200 (no explicit grant needed)', async () => {
    installWithGrant()
    const res = await call(mediaUrlForPath(join(allowedRoot, 'preview.mp4')))
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
  })

  it('REFUSES an ungranted path (/etc/passwd) → 403, net.fetch NOT called', async () => {
    installWithGrant()
    const res = await call(mediaUrlForPath('/etc/passwd'))
    expect(res.status).toBe(403)
    expect(fetchCalls).toHaveLength(0)
  })

  it('does NOT leak via a `..` traversal request: the escaped target is refused, no fetch', async () => {
    // The WHATWG URL parser collapses `..` in a scheme request before the handler
    // runs (so `<root>/../<sibling>` → the sibling). `allowedRoot` and `outside`
    // are sibling temp dirs, so a `..` from inside `allowedRoot` lands in
    // `outside`, where we put a REAL but UNGRANTED file → the request resolves to
    // an existing path the allow-list refuses (403). net.fetch is never called.
    const sibling = join(outside, 'sibling.mp4')
    await writeFile(sibling, 'SIB')
    const outsideBase = outside.split('/').pop()!
    installWithGrant()
    const traversalUrl = `openclip-media://file${allowedRoot}/../${outsideBase}/sibling.mp4`
    const res = await call(traversalUrl)
    expect(res.status).toBe(403)
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects a NUL byte in the path → 400', async () => {
    installWithGrant()
    const res = await call(`openclip-media://file${allowedRoot}/a%00b.mp4`)
    expect(res.status).toBe(400)
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects a non-GET/HEAD method (POST) → 405', async () => {
    installWithGrant()
    const res = await call(mediaUrlForPath(grantedFile), 'POST')
    expect(res.status).toBe(405)
    expect(fetchCalls).toHaveLength(0)
  })

  it('allows HEAD (read-only metadata) for a granted file', async () => {
    installWithGrant()
    const res = await call(mediaUrlForPath(grantedFile), 'HEAD')
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
  })

  it('REFUSES a symlink that escapes the allowed roots → 403 (realpath defeats it)', async () => {
    const secret = join(outside, 'secret.mp4')
    await writeFile(secret, 'S')
    const link = join(allowedRoot, 'sneaky.mp4')
    await symlink(secret, link)
    installWithGrant()
    const res = await call(mediaUrlForPath(link))
    expect(res.status).toBe(403)
    expect(fetchCalls).toHaveLength(0)
  })

  it('404s a granted-but-now-missing path (realpath ENOENT)', async () => {
    const access = createMediaAccess({ alwaysAllowedRoots: [allowedRoot] })
    const ghost = join(outside, 'ghost.mp4')
    access.grant(ghost) // grant tolerates ENOENT
    install(access)
    const res = await call(mediaUrlForPath(ghost))
    expect(res.status).toBe(404)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('isUnsafeMediaPath (unit) — traversal/NUL guard', () => {
  it('flags `..` segments and NUL bytes; passes clean absolute paths', () => {
    expect(isUnsafeMediaPath('/Users/me/Movies/clip.mp4')).toBe(false)
    expect(isUnsafeMediaPath('/Users/me/My Movie.mp4')).toBe(false)
    // `..` as a path segment → unsafe (the directly-testable seam for the rule
    // the URL parser otherwise neutralises upstream).
    expect(isUnsafeMediaPath('/a/../b.mp4')).toBe(true)
    expect(isUnsafeMediaPath('/a/..')).toBe(true)
    expect(isUnsafeMediaPath('..')).toBe(true)
    // A literal `..` inside a filename (not its own segment) is fine.
    expect(isUnsafeMediaPath('/a/..b.mp4')).toBe(false)
    // NUL byte → unsafe.
    expect(isUnsafeMediaPath('/a/b\0.mp4')).toBe(true)
  })
})

describe('createMediaAccess.isAllowed (unit)', () => {
  it('allows a granted file, the root itself, files under a root; rejects siblings/ungranted', async () => {
    const access = createMediaAccess({ alwaysAllowedRoots: [allowedRoot] })
    access.grant(grantedFile)

    expect(access.isAllowed(grantedFile)).toBe(true)
    expect(access.isAllowed(allowedRoot)).toBe(true)
    expect(access.isAllowed(join(allowedRoot, 'preview.mp4'))).toBe(true)

    const other = join(outside, 'other.mp4')
    await writeFile(other, 'Z')
    expect(access.isAllowed(other)).toBe(false)
    expect(access.isAllowed(join(outside, 'nope.mp4'))).toBe(false)
  })

  it('a sibling root prefix (`/media-evil` vs `/media`) does NOT match (root + sep guard)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'oc-mp-pfx-'))
    try {
      const root = join(base, 'media')
      const evil = join(base, 'media-evil')
      await mkdir(root, { recursive: true })
      await mkdir(evil, { recursive: true })
      const evilFile = join(evil, 'x.mp4')
      await writeFile(evilFile, 'E')
      const access = createMediaAccess({ alwaysAllowedRoots: [root] })
      expect(access.isAllowed(evilFile)).toBe(false)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
