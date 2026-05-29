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

Download URLs (raw):
- https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/archivoblack/ArchivoBlack-Regular.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-ExtraBold.ttf

The full SIL OFL 1.1 license text (with each font's copyright + Reserved Font
Names) travels with the fonts in **`OFL.txt`** in this directory; it ships under
`<Resources>/fonts/` via the same `extraResources` rule, satisfying the OFL's
"license must accompany the fonts" requirement.

> When adding a font, reference it in a caption preset by its **family name**
> (verify with `fc-scan --format '%{family}\n' <file>`), add a row here, and
> append its `OFL.txt` license text to `OFL.txt`.
