/**
 * BrandKitEditor — the brand-kit producer surface (Part K / openclip-61p),
 * mounted as a section in SettingsPanel. Manages the app-level brand LIBRARY
 * (via `brandStore` → main-side `brand:*` IPC) and selects which brand applies to
 * the current project (`Project.activeBrandId`).
 *
 * A brand contributes: caption font + colors (brand colors win over the selected
 * preset via `brandCaptionOverride`) and a logo overlay (PNG, copied into the
 * brand's library dir, drawn at export by the ffmpeg overlay). Logo upload uses
 * the hard-scoped PNG picker (`system.imageDialog`).
 */

import { useEffect, useState } from 'react'
import type { BrandTemplate } from '@shared/schema'
import { useBrandStore } from '@renderer/stores/brandStore'
import { useProjectStore } from '@renderer/stores/projectStore'
import { PRESET_FONT_FAMILIES } from '@renderer/components/captionPresets'
import { DEFAULT_CAPTION_STYLE } from '@shared/caption-layout'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'

/** Sentinel: the font Select option meaning "no brand override (use the preset)". */
const NO_FONT = '__preset__'
const FONT_OPTIONS = Array.from(
  new Set([DEFAULT_CAPTION_STYLE.fontFamily, ...PRESET_FONT_FAMILIES])
)
const LOGO_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

function freshBrand(): BrandTemplate {
  return {
    id: `brand-${crypto.randomUUID().slice(0, 8)}`,
    name: 'New brand',
    brandColors: ['#FFE000', '#FFFFFF'],
    logoPosition: 'bottom-right',
    logoScale: 0.18,
    logoMargin: 48
  }
}

export function BrandKitEditor(): React.JSX.Element {
  const brands = useBrandStore((s) => s.brands)
  const loaded = useBrandStore((s) => s.loaded)
  const load = useBrandStore((s) => s.load)
  const saveBrand = useBrandStore((s) => s.saveBrand)
  const deleteBrand = useBrandStore((s) => s.deleteBrand)
  const setLogo = useBrandStore((s) => s.setLogo)

  const hasProject = useProjectStore((s) => !!s.currentProject)
  const activeBrandId = useProjectStore((s) => s.currentProject?.activeBrandId)
  const setActiveBrandId = useProjectStore((s) => s.setActiveBrandId)

  const [draft, setDraft] = useState<BrandTemplate | null>(null)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const patch = (p: Partial<BrandTemplate>): void => setDraft((d) => (d ? { ...d, ...p } : d))
  const colors = draft?.brandColors ?? []
  const primary = colors[0] ?? '#FFE000'
  const secondary = colors[1] ?? '#FFFFFF'
  const setColor = (idx: 0 | 1, value: string): void => {
    const next = [primary, secondary] as string[]
    next[idx] = value
    patch({ brandColors: next })
  }

  const onSave = async (): Promise<void> => {
    if (draft && draft.name.trim()) await saveBrand(draft)
  }
  const onDelete = async (): Promise<void> => {
    if (!draft) return
    await deleteBrand(draft.id)
    if (activeBrandId === draft.id) setActiveBrandId(undefined)
    setDraft(null)
  }
  const onUploadLogo = async (): Promise<void> => {
    if (!draft) return
    const res = await window.openclip.system.imageDialog({})
    if (res.canceled || !res.filePaths[0]) return
    // The brand dir must exist before adopting the logo into it.
    await saveBrand(draft)
    const logoPath = await setLogo(draft.id, res.filePaths[0])
    const updated = { ...draft, logoPath }
    setDraft(updated)
    await saveBrand(updated)
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-3" data-testid="brand-kit-editor">
      <div className="flex items-center justify-between">
        <Label>Brand kit</Label>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          data-testid="brand-new"
          onClick={() => setDraft(freshBrand())}
        >
          New
        </Button>
      </div>

      {/* Brand library picker. */}
      {brands.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="brand-list">
          {brands.map((b) => (
            <button
              key={b.id}
              type="button"
              data-testid="brand-chip"
              data-active={b.id === draft?.id}
              onClick={() => setDraft(b)}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                b.id === draft?.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:bg-accent'
              }`}
            >
              {b.name}
              {b.id === activeBrandId ? ' ✓' : ''}
            </button>
          ))}
        </div>
      )}

      {draft && (
        <div className="flex flex-col gap-2 rounded-md border p-2" data-testid="brand-draft">
          <div className="flex flex-col gap-1">
            <Label htmlFor="brand-name">Name</Label>
            <Input
              id="brand-name"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          {/* Brand colors → caption highlight (primary) + base font (secondary). */}
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Highlight</span>
              <input
                type="color"
                data-testid="brand-color-primary"
                value={primary}
                onChange={(e) => setColor(0, e.target.value)}
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Text</span>
              <input
                type="color"
                data-testid="brand-color-secondary"
                value={secondary}
                onChange={(e) => setColor(1, e.target.value)}
              />
            </label>
          </div>

          {/* Caption font — constrained to the bundled families (libass can resolve). */}
          <div className="flex flex-col gap-1">
            <Label htmlFor="brand-font">Caption font</Label>
            <Select
              value={draft.fontFamily ?? NO_FONT}
              onValueChange={(v) => patch({ fontFamily: v === NO_FONT ? undefined : v })}
            >
              <SelectTrigger id="brand-font">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FONT}>Preset default</SelectItem>
                {FONT_OPTIONS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Logo + placement. */}
          <div className="flex flex-col gap-1">
            <Label>Logo (PNG)</Label>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                data-testid="brand-logo-upload"
                onClick={() => void onUploadLogo()}
              >
                {draft.logoPath ? 'Replace logo' : 'Choose logo'}
              </Button>
              {draft.logoPath && (
                <span
                  className="truncate text-xs text-muted-foreground"
                  data-testid="brand-logo-path"
                >
                  {draft.logoPath.split('/').pop()}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Select
              value={draft.logoPosition ?? 'bottom-right'}
              onValueChange={(v) => patch({ logoPosition: v as BrandTemplate['logoPosition'] })}
            >
              <SelectTrigger className="h-8 w-36" data-testid="brand-logo-position">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOGO_POSITIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">Size</span>
              <Input
                type="number"
                className="h-8 w-16"
                step="0.01"
                min="0.05"
                max="0.5"
                value={draft.logoScale ?? 0.18}
                onChange={(e) => patch({ logoScale: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">Margin</span>
              <Input
                type="number"
                className="h-8 w-16"
                step="1"
                min="0"
                value={draft.logoMargin ?? 48}
                onChange={(e) => patch({ logoMargin: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" data-testid="brand-save" onClick={() => void onSave()}>
              Save brand
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="brand-use"
              disabled={!hasProject}
              onClick={() => setActiveBrandId(draft.id)}
            >
              {activeBrandId === draft.id ? 'Active ✓' : 'Use for this project'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              data-testid="brand-delete"
              onClick={() => void onDelete()}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default BrandKitEditor
