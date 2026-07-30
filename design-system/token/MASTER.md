# Token Design System

**Product:** local Telegram and Fragment username workspace
**Pattern:** marketplace / data workspace
**Primary mode:** dark
**Design dials:** variance 5/10 · motion 4/10 · density 7/10

## Direction

Token uses the clarity of a marketplace interface: a restrained top navigation,
prominent search controls, and a wide results table where usernames are the
strongest element. The interface is original and must not reproduce Fragment
branding or assets.

Avoid cyberpunk styling, neon glow, decorative gradients, glass-heavy cards,
tiny metadata, and a permanent desktop sidebar.

## Logo

- Primary lockup: `web/assets/token-logo.svg`.
- Compact mark: `web/assets/token-mark.svg`.
- The geometry follows the approved Token reference: outlined hexagonal token,
  open linear glyph, and the small square signal.
- Use the full lockup on desktop and the compact mark below 420px.

## Tokens

| Role | Value |
|---|---|
| Background | `#17212B` |
| Deep background | `#111A22` |
| Surface | `#202B36` |
| Raised surface | `#253341` |
| Primary text | `#F4F7FA` |
| Secondary text | `#AAB7C4` |
| Faint text | `#8798A6` |
| Accent | `#2AABEE` |
| Success | `#5ED99A` |
| Warning | `#F3C969` |
| Danger | `#FF8797` |
| Border | `rgba(214, 228, 240, 0.10)` |

Use semantic CSS variables. Functional state must always include text or an
icon in addition to color.

## Typography

- System-only font stack because the server CSP is self-only.
- UI: Segoe UI Variable / Segoe UI / system UI.
- Data: Cascadia Code / Cascadia Mono / system monospace.
- Body text: 16px with at least 1.5 line-height.
- Username in results: 18–20px, 700 weight.
- Metadata must not fall below 12px; interactive labels should be at least 13px.
- Use tabular figures for prices, progress, counts, and timestamps.

## Layout

- Desktop content width: maximum 1240px.
- Sticky top navigation: 64px.
- Spacing rhythm: 4 / 8 / 12 / 16 / 24 / 32 / 48.
- Cards: 12–16px radius, 1px border, minimal shadow.
- Controls: at least 44px high; 48px preferred for primary forms.
- Results rows: approximately 76px on desktop with generous horizontal padding.
- Breakpoints to verify: 375 / 768 / 1024 / 1440.
- Mobile uses a four-item bottom navigation and no horizontal page scroll.

## Interaction

- Motion duration: 160–240ms, `cubic-bezier(0.16, 1, 0.3, 1)`.
- Animate only opacity and transform for entrances.
- Hover and pressed states must not change layout bounds.
- Async submit buttons expose a busy state.
- Respect `prefers-reduced-motion`.
- Form controls use one inner accent border/soft ring, never a second thick
  outer halo. Links and buttons retain a visible keyboard-only outline.

## Accessibility and performance

- WCAG AA: 4.5:1 normal text, 3:1 large text and UI graphics.
- Preserve native form controls, explicit labels, inline errors, live regions,
  skip link, heading order, and route focus management.
- Do not load external fonts, icon CDNs, or scripts.
- Use inline/local SVG for icons.
- Avoid continuous decorative animation, layout thrashing, and excessive blur.

## Pre-delivery checks

- All current routes, forms, options, IDs, names, and delegated data attributes
  remain available.
- Usernames are readable at a glance on desktop and mobile.
- Statuses are understandable without hover.
- All touch targets are at least 44×44px.
- No content sits behind sticky navigation.
- Reduced motion, keyboard focus, empty/loading/error states, and mobile layout
  are verified in a real browser.
