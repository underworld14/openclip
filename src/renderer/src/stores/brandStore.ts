/**
 * src/renderer/src/stores/brandStore.ts — the APP-LEVEL brand library (Part K).
 *
 * The brand LIBRARY (the set of saved brands) is app-level and persisted
 * MAIN-SIDE under `<userData>/brands/` (NOT renderer localStorage) via the
 * `brand:*` IPC namespace, so it survives a renderer storage clear and the logo
 * is self-contained. This store is just the in-memory mirror + thin actions that
 * call `window.openclip.brand.*`. WHICH brand applies to a project is per-project
 * (`Project.activeBrandId`, owned by projectStore) — resolved by `activeBrand()`.
 */

import { create } from 'zustand'
import type { BrandTemplate } from '@shared/schema'

/** PURE: find the active brand in a library by id (undefined ⇒ none). */
export function activeBrand(
  brands: BrandTemplate[],
  activeBrandId: string | null | undefined
): BrandTemplate | undefined {
  if (!activeBrandId) return undefined
  return brands.find((b) => b.id === activeBrandId)
}

export interface BrandStore {
  brands: BrandTemplate[]
  loaded: boolean
  /** Load the library from main (idempotent — safe to call on mount). */
  load: () => Promise<void>
  /** Create or update a brand (persisted main-side); refreshes the local list. */
  saveBrand: (brand: BrandTemplate) => Promise<void>
  /** Delete a brand by id (persisted main-side); refreshes the local list. */
  deleteBrand: (id: string) => Promise<void>
  /** Adopt a PNG into the brand's dir; returns the in-library logo path. */
  setLogo: (id: string, srcPath: string) => Promise<string>
}

export const useBrandStore = create<BrandStore>()((set, get) => ({
  brands: [],
  loaded: false,
  load: async () => {
    const brands = await window.openclip.brand.list()
    set({ brands, loaded: true })
  },
  saveBrand: async (brand) => {
    const saved = await window.openclip.brand.save({ brand })
    set((s) => {
      const rest = s.brands.filter((b) => b.id !== saved.id)
      return { brands: [...rest, saved] }
    })
  },
  deleteBrand: async (id) => {
    await window.openclip.brand.delete({ id })
    set((s) => ({ brands: s.brands.filter((b) => b.id !== id) }))
  },
  setLogo: async (id, srcPath) => {
    const { logoPath } = await window.openclip.brand.setLogo({ id, srcPath })
    // Reflect the adopted path on the in-memory brand (the editor re-saves meta).
    set((s) => ({
      brands: s.brands.map((b) => (b.id === id ? { ...b, logoPath } : b))
    }))
    void get
    return logoPath
  }
}))
