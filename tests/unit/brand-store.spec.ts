/**
 * tests/unit/brand-store.spec.ts — the main-side brand library (Part K).
 * Runs against a real temp filesystem (the store is Electron-free): save/list
 * roundtrip, delete, logo adoption (copy), and the path-safety trust boundary.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertSafeBrandId,
  adoptBrandLogo,
  brandDir,
  deleteBrand,
  listBrands,
  saveBrand,
  BrandStoreError
} from '@main/services/brand-store'
import type { BrandTemplate } from '@shared/schema'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openclip-brands-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const brand = (over: Partial<BrandTemplate> = {}): BrandTemplate => ({
  id: 'brand-1',
  name: 'Acme',
  brandColors: ['#ff0000', '#00ff00'],
  fontFamily: 'Anton',
  logoPosition: 'bottom-right',
  logoScale: 0.18,
  logoMargin: 48,
  ...over
})

describe('assertSafeBrandId', () => {
  it('rejects separators / dot-segments (trust boundary)', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => assertSafeBrandId(bad)).toThrow(BrandStoreError)
    }
    expect(assertSafeBrandId('brand-1')).toBe('brand-1')
  })
})

describe('saveBrand / listBrands', () => {
  it('persists a brand and reads it back (validated)', async () => {
    await saveBrand(root, brand())
    const list = await listBrands(root)
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(brand())
    expect(existsSync(join(brandDir(root, 'brand-1'), 'meta.json'))).toBe(true)
  })

  it('overwrites an existing brand on re-save', async () => {
    await saveBrand(root, brand())
    await saveBrand(root, brand({ name: 'Renamed' }))
    const list = await listBrands(root)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Renamed')
  })

  it('lists [] when the brands root does not exist yet', async () => {
    expect(await listBrands(join(root, 'nope'))).toEqual([])
  })

  it('skips a corrupt brand dir instead of failing the whole list', async () => {
    await saveBrand(root, brand())
    mkdirSync(join(root, 'broken'))
    writeFileSync(join(root, 'broken', 'meta.json'), '{ not json')
    const list = await listBrands(root)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('brand-1')
  })

  it('rejects an invalid brand (missing required fields)', async () => {
    await expect(saveBrand(root, { id: 'x' } as unknown as BrandTemplate)).rejects.toThrow(
      BrandStoreError
    )
  })
})

describe('deleteBrand', () => {
  it('removes the brand dir and is idempotent', async () => {
    await saveBrand(root, brand())
    expect(await deleteBrand(root, 'brand-1')).toEqual({ deleted: true })
    expect(await listBrands(root)).toEqual([])
    // idempotent — deleting again still resolves
    expect(await deleteBrand(root, 'brand-1')).toEqual({ deleted: true })
  })
})

describe('adoptBrandLogo', () => {
  it('COPIES the source PNG into the brand dir as logo.png (original untouched)', async () => {
    const src = join(root, 'orig-logo.png')
    writeFileSync(src, 'PNGDATA')
    const { logoPath } = await adoptBrandLogo(root, 'brand-1', src)
    expect(logoPath).toBe(join(brandDir(root, 'brand-1'), 'logo.png'))
    expect(readFileSync(logoPath, 'utf8')).toBe('PNGDATA')
    // copy, not move — the user's original still exists
    expect(existsSync(src)).toBe(true)
  })

  it('rejects an unsafe brand id', async () => {
    await expect(adoptBrandLogo(root, '../escape', '/tmp/x.png')).rejects.toThrow(BrandStoreError)
  })
})
