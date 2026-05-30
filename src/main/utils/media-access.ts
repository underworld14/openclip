/**
 * src/main/utils/media-access.ts — the allow-list that scopes which absolute
 * paths the `openclip-media://` protocol (`media-protocol.ts`) may serve.
 *
 * SECURITY (audit fix openclip-8tx): the media scheme used to `net.fetch` ANY
 * absolute path encoded in the URL — an arbitrary-file-read primitive handed to
 * the renderer. This module narrows that to a capability set:
 *   - paths EXPLICITLY granted (the source video of an imported/loaded project),
 *   - anything under an ALWAYS-ALLOWED root (the app-owned media dir + the
 *     OpenClip temp root, where previews/extracts legitimately live).
 *
 * Symlink hardening: every grant is `realpathSync`'d UP FRONT (so swapping the
 * granted path for a symlink AFTER granting can't widen reach), and every
 * `isAllowed` check `realpathSync`'s the candidate before comparing — the
 * decision is always made on the canonical, fully-resolved path.
 *
 * Kept Electron-free (pure node fs/path) so it is unit-testable in isolation;
 * the protocol handler injects an instance.
 */

import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export interface MediaAccess {
  /** Record an absolute path as servable (canonicalised via realpath up front). */
  grant(absPath: string): void
  /** True iff the (realpath-resolved) candidate is granted or under an always-allowed root. */
  isAllowed(absPath: string): boolean
}

/**
 * Resolve a path's canonical form. If the path doesn't exist yet (ENOENT) we
 * fall back to a lexical `resolve()` so a grant issued before the file is fully
 * on disk still records a sensible, normalised path (it'll be re-checked via
 * realpath at serve time anyway).
 */
function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export function createMediaAccess(opts: { alwaysAllowedRoots: string[] }): MediaAccess {
  // Resolve the always-allowed roots ONCE at creation (realpath so a symlinked
  // root is compared by its canonical target). A non-existent root is tolerated
  // (lexically resolved); it simply won't match anything until it exists.
  const roots = opts.alwaysAllowedRoots.map(canonical)
  const granted = new Set<string>()

  return {
    grant(absPath: string): void {
      granted.add(canonical(absPath))
    },
    isAllowed(absPath: string): boolean {
      // Resolve the candidate to its canonical path BEFORE comparing. A
      // non-existent candidate can never be served, so a hard realpath here
      // (no lexical fallback) is correct — the handler also 404s on ENOENT.
      let real: string
      try {
        real = realpathSync(absPath)
      } catch {
        return false
      }
      if (granted.has(real)) return true
      // Under-root check: a prefix match MUST use `root + sep` so `/media-evil`
      // does not match the `/media` root (and the root itself is allowed).
      for (const root of roots) {
        if (real === root || real.startsWith(root + sep)) return true
      }
      return false
    }
  }
}
