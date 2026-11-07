# BOCC Brand Assets

Canonical logo files and color palette for Buffalo Open Coffee Club. Added 2026-11-07.
Use these files for anything new (web, social, print, email). Do not recolor, stretch,
rotate, or filter them. See `docs/strategy/brand-consistency-guide.md` for usage rules.

## Logo files

| File | Size | Use for |
|------|------|---------|
| `bocc-logo-square.png` | 2000x2000 | Full badge: sunrise arch, buffalo, "716", wordmark on charcoal. Profile pictures, event graphics, print. |
| `bocc-header-coffee-beans.png` | 851x315 | Full badge over coffee-bean photo. Facebook/LinkedIn cover, page headers. |
| `bocc-mug-with-text.png` | 2000x2000 | Mug icon with buffalo-face badge and curved wordmark. Merch, stickers, larger icon uses. |
| `bocc-mug-badge-only.png` | 2000x2000 | Mug icon with badge, no text. Favicons, avatars, watermarks, small-format uses. |

## Color palette (sampled from the logo files)

Hex values below were extracted directly from the PNGs (dominant opaque pixels),
so they are the exact colors in the artwork.

| Role | Name | Hex | RGB | Where it appears |
|------|------|-----|-----|------------------|
| Primary dark | Charcoal | `#161616` | 22, 22, 22 | Badge background, buffalo silhouette |
| Primary accent | Sunrise Amber | `#DB9951` | 219, 153, 81 | Sun arch, "716", divider lines, mug badge ring |
| Secondary accent | Burnt Orange | `#DD7F4B` | 221, 127, 75 | Outer arch band, outer badge ring |
| Light neutral | Cream | `#F1EDDA` | 241, 237, 218 | Inner sun, trees, badge face, mug text on dark |
| White | Off-White | `#F9FCF8` | 249, 252, 248 | Wordmark text, mug rim/highlight |
| True black | Black | `#000000` | 0, 0, 0 | Mug body |
| Line color | Ink | `#152026` | 21, 32, 38 | Buffalo-face line art on the mug badge |

### Pairing guidance

- Core look: Charcoal `#161616` + Sunrise Amber `#DB9951` + Cream `#F1EDDA`
- Use Burnt Orange `#DD7F4B` sparingly as a gradient partner or hover/accent, never as the main brand orange
- Text on dark: Off-White `#F9FCF8` or Cream `#F1EDDA`
- Text on light: Charcoal `#161616` or Ink `#152026`
- Contrast (WCAG): Cream on Charcoal ~15.5:1, Amber on Charcoal ~7.6:1, Charcoal on Amber ~7.6:1 -- all pass AA for body text

### CSS custom properties

```css
:root {
  --bocc-charcoal: #161616;
  --bocc-amber:    #DB9951;
  --bocc-orange:   #DD7F4B;
  --bocc-cream:    #F1EDDA;
  --bocc-white:    #F9FCF8;
  --bocc-black:    #000000;
  --bocc-ink:      #152026;
}
```
