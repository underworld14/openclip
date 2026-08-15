/**
 * theme.ts — persisted light/dark preference (BUG-qcvhcn).
 *
 * `App.tsx`'s theme toggle used to be plain `useState(true)`: every launch
 * reset to dark regardless of what the user last chose, with no persistence
 * anywhere. `localStorage` (not the main-process `Settings` document) is the
 * right home for this — it is a purely renderer-local UI preference, not
 * something exported with the project or read by main, so it does not
 * warrant a change to the FROZEN `schema.ts`/`channels.ts` contracts.
 */

export const THEME_STORAGE_KEY = 'openclip-theme'

/**
 * Read the persisted theme choice. Defaults to dark (the app's historical
 * default aesthetic) when nothing is stored yet, the stored value is
 * unrecognised, or storage itself is unavailable (e.g. a restrictive
 * sandbox) — a read must never throw and block the app from rendering.
 */
export function readStoredTheme(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    return storage.getItem(THEME_STORAGE_KEY) !== 'light'
  } catch {
    return true
  }
}

/** Persist the theme choice. Best-effort — a storage failure must never block toggling. */
export function writeStoredTheme(
  dark: boolean,
  storage: Pick<Storage, 'setItem'> = localStorage
): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light')
  } catch {
    /* best-effort only */
  }
}
