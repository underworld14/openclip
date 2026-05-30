/**
 * brand-store — the persistent, app-level BRAND LIBRARY (Part K brand kit).
 *
 * Brands live under `<brandsRoot>/<brandId>/`:
 *   - `meta.json` — the `BrandTemplate` (sans the in-flight logo file handling)
 *   - `logo.png`  — the brand logo, COPIED in (so a brand survives the user
 *                   moving/deleting the original PNG); `logoPath` points here.
 *
 * Persisted main-side (NOT renderer localStorage) so the library survives a
 * renderer storage clear and the logo is self-contained. Electron-free (the root
 * is injected), mirroring `media-store.ts`, so it is unit-testable against a real
 * temp filesystem.
 */

import { join, resolve, sep } from 'node:path'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { BrandTemplate } from '@shared/schema'

export class BrandStoreError extends Error {
  constructor(
    readonly code: 'INVALID' | 'IO' | 'NOT_FOUND',
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'BrandStoreError'
  }
}

/** A brand id must be a single path segment (no separators / `..`) — trust boundary. */
export function assertSafeBrandId(brandId: string): string {
  if (!brandId || /[\\/]/.test(brandId) || brandId === '.' || brandId === '..') {
    throw new BrandStoreError('INVALID', `unsafe brand id: ${JSON.stringify(brandId)}`)
  }
  return brandId
}

/** `<brandsRoot>/<brandId>` (pure, validated). */
export function brandDir(brandsRoot: string, brandId: string): string {
  return join(brandsRoot, assertSafeBrandId(brandId))
}

function metaPath(brandsRoot: string, brandId: string): string {
  return join(brandDir(brandsRoot, brandId), 'meta.json')
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code
}

/**
 * List every persisted brand (each `<brandsRoot>/<id>/meta.json`, parsed +
 * validated against `BrandTemplate`). A missing root ⇒ `[]`. Entries whose
 * meta.json is missing/corrupt are skipped (best-effort), so one bad dir never
 * breaks the library.
 */
export async function listBrands(brandsRoot: string): Promise<BrandTemplate[]> {
  let ids: string[]
  try {
    ids = await readdir(brandsRoot)
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return []
    throw new BrandStoreError('IO', `failed to read brands root ${brandsRoot}`, err)
  }
  const brands: BrandTemplate[] = []
  for (const id of ids) {
    try {
      const raw = await readFile(metaPath(brandsRoot, id), 'utf8')
      const parsed = BrandTemplate.safeParse(JSON.parse(raw))
      if (parsed.success) brands.push(parsed.data)
    } catch {
      /* best-effort — skip a missing/corrupt brand dir */
    }
  }
  return brands
}

/**
 * Persist a brand (create or overwrite `<brandsRoot>/<id>/meta.json`) and return
 * it. The brand is validated against `BrandTemplate` first (trust boundary — it
 * arrives from the renderer over IPC).
 */
export async function saveBrand(brandsRoot: string, brand: BrandTemplate): Promise<BrandTemplate> {
  const parsed = BrandTemplate.safeParse(brand)
  if (!parsed.success) {
    throw new BrandStoreError('INVALID', `invalid brand: ${parsed.error.message}`)
  }
  const dir = brandDir(brandsRoot, parsed.data.id)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(metaPath(brandsRoot, parsed.data.id), JSON.stringify(parsed.data, null, 2))
    return parsed.data
  } catch (cause) {
    throw new BrandStoreError('IO', `failed to save brand ${parsed.data.id}`, cause)
  }
}

/** Remove a brand's dir `<brandsRoot>/<id>/` (idempotent). */
export async function deleteBrand(
  brandsRoot: string,
  brandId: string
): Promise<{ deleted: boolean }> {
  const dir = brandDir(brandsRoot, brandId)
  try {
    await rm(dir, { recursive: true, force: true })
    return { deleted: true }
  } catch (cause) {
    throw new BrandStoreError('IO', `failed to delete brand ${brandId}`, cause)
  }
}

/**
 * COPY a PNG logo into the brand's dir as `logo.png` and return the in-library
 * path. The dest is structurally pinned to `<brandsRoot>/<id>/logo.png`, so a
 * crafted brandId/srcPath cannot escape the brand tree (defense-in-depth like
 * `media-store.adoptIntoMedia`). Copy (not move) — the user keeps their original.
 */
export async function adoptBrandLogo(
  brandsRoot: string,
  brandId: string,
  srcPath: string
): Promise<{ logoPath: string }> {
  const dir = brandDir(brandsRoot, brandId)
  const dest = join(dir, 'logo.png')
  if (!resolve(dest).startsWith(resolve(dir) + sep)) {
    throw new BrandStoreError('INVALID', `logo dest escapes brand dir: ${dest}`)
  }
  try {
    await mkdir(dir, { recursive: true })
    await copyFile(srcPath, dest)
    return { logoPath: dest }
  } catch (cause) {
    throw new BrandStoreError('IO', `failed to adopt logo for brand ${brandId}`, cause)
  }
}
