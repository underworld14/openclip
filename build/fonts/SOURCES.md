# Bundled caption fonts — sources & licenses

These fonts are shipped under `<Resources>/fonts/` (electron-builder `extraResources`)
and resolved by libass at caption-burn time via `subtitles=…:fontsdir=<dir>`
(see `src/main/utils/paths.ts → fontsDir()`). Caption presets reference them by
their **internal family name** (the right column), which is what libass matches.

All bundled fonts are **free for redistribution** (SIL Open Font License 1.1 or
Bitstream Vera). No proprietary fonts (Arial/Helvetica) are bundled.

| File | Family name (libass) | License | Source |
|------|----------------------|---------|--------|
| `DejaVuSans.ttf` | `DejaVu Sans` | Bitstream Vera / DejaVu (permissive) | dejavu-fonts.github.io |
| `Anton-Regular.ttf` | `Anton` | OFL 1.1 | google/fonts `ofl/anton` |
| `ArchivoBlack-Regular.ttf` | `Archivo Black` | OFL 1.1 | google/fonts `ofl/archivoblack` |
| `BebasNeue-Regular.ttf` | `Bebas Neue` | OFL 1.1 | google/fonts `ofl/bebasneue` |
| `Poppins-ExtraBold.ttf` | `Poppins ExtraBold` | OFL 1.1 | google/fonts `ofl/poppins` |
| `NotoEmoji-Regular.ttf` | `Noto Emoji` | OFL 1.1 | google/fonts `ofl/notoemoji` |

`NotoEmoji-Regular.ttf` is a **MONOCHROME** emoji font used as a libass glyph
**FALLBACK** for the auto-emoji feature (Part K) — the bundled FFmpeg's libass
cannot render COLOR emoji, so emoji burn as single-color glyphs that follow the
caption fill. It is intentionally **NOT** referenced by any caption preset
`fontFamily` (it is a fallback only), so `caption-presets.spec.ts`'s `FAMILY_FILE`
map need not list it. It is the static `wght=400` instance of google/fonts'
variable `NotoEmoji[wght].ttf` (instanced with `fontTools.varLib` to drop the
unused axis and roughly halve the file size: 1.9 MB → ~0.87 MB).

Download URLs (raw):
- https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/archivoblack/ArchivoBlack-Regular.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-ExtraBold.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf (variable; instanced to `wght=400` → `NotoEmoji-Regular.ttf`)

The full SIL OFL 1.1 license text (with each font's copyright + Reserved Font
Names) travels with the fonts in **`OFL.txt`** in this directory; it ships under
`<Resources>/fonts/` via the same `extraResources` rule, satisfying the OFL's
"license must accompany the fonts" requirement.

`DejaVuSans.ttf` is **not** OFL — it ships under the Bitstream Vera / DejaVu
license, whose full text travels in **`LICENSE-DejaVu.txt`** in this directory
(shipped via the electron-builder `**/LICENSE*` font filter). The Bitstream Vera
license likewise requires its notice to accompany the font.

> When adding a font, reference it in a caption preset by its **family name**
> (verify with `fc-scan --format '%{family}\n' <file>`), add a row here, and
> append its `OFL.txt` license text to `OFL.txt`.
