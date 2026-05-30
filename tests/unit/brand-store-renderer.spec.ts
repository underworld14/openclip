/**
 * tests/unit/brand-store-renderer.spec.ts — the renderer brand library store
 * (Part K). `activeBrand` resolution + the thin actions that mirror the main-side
 * library via the `brand:*` bridge (stubbed here).
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useBrandStore, activeBrand } from '@renderer/stores/brandStore'
import type { BrandTemplate } from '@shared/schema'

const brandA: BrandTemplate = { id: 'a', name: 'Acme' }
const brandB: BrandTemplate = { id: 'b', name: 'Beta' }

function stubBridge(over: Partial<Record<string, unknown>> = {}): void {
  const brand = {
    list: vi.fn(async () => [brandA]),
    save: vi.fn(async (req: { brand: BrandTemplate }) => req.brand),
    delete: vi.fn(async () => ({ deleted: true })),
    setLogo: vi.fn(async () => ({ logoPath: '/lib/a/logo.png' })),
    ...over
  }
  ;(globalThis as unknown as { window: unknown }).window = { openclip: { brand } }
}

beforeEach(() => {
  useBrandStore.setState({ brands: [], loaded: false })
  stubBridge()
})

describe('activeBrand', () => {
  it('finds the active brand by id, else undefined', () => {
    expect(activeBrand([brandA, brandB], 'b')).toEqual(brandB)
    expect(activeBrand([brandA, brandB], undefined)).toBeUndefined()
    expect(activeBrand([brandA, brandB], 'nope')).toBeUndefined()
  })
})

describe('brandStore actions', () => {
  it('load() pulls the library from main and marks loaded', async () => {
    await useBrandStore.getState().load()
    expect(useBrandStore.getState().brands).toEqual([brandA])
    expect(useBrandStore.getState().loaded).toBe(true)
  })

  it('saveBrand() upserts by id (create then update)', async () => {
    await useBrandStore.getState().saveBrand(brandA)
    expect(useBrandStore.getState().brands).toEqual([brandA])
    await useBrandStore.getState().saveBrand({ ...brandA, name: 'Renamed' })
    expect(useBrandStore.getState().brands).toEqual([{ id: 'a', name: 'Renamed' }])
  })

  it('deleteBrand() removes it from the local list', async () => {
    useBrandStore.setState({ brands: [brandA, brandB], loaded: true })
    await useBrandStore.getState().deleteBrand('a')
    expect(useBrandStore.getState().brands).toEqual([brandB])
  })

  it('setLogo() adopts the PNG and reflects the in-library path', async () => {
    useBrandStore.setState({ brands: [brandA], loaded: true })
    const path = await useBrandStore.getState().setLogo('a', '/Users/me/logo.png')
    expect(path).toBe('/lib/a/logo.png')
    expect(useBrandStore.getState().brands[0].logoPath).toBe('/lib/a/logo.png')
  })
})
