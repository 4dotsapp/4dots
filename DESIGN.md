# 4dots design system

Everything you need to build a different site with the same look and feel as [4dots.app](https://4dots.app): liquid glass over drifting digits, ink-and-paper colours with one warm accent, and motion that has weight.

Every value here is taken from the live code. The source files are the reference implementation:

| File | What it holds |
| --- | --- |
| [`public/styles.css`](public/styles.css) | Tokens, glass, every component, responsive rules |
| [`public/motion.js`](public/motion.js) | Tweens, speed-based motion blur, slot-machine reels, backdrop hold, lite mode |
| [`public/slider.js`](public/slider.js) | The liquid pill for segmented controls (springs, drag, squash) |
| [`public/lens.js`](public/lens.js) | Edge refraction for glass in Chromium |
| [`public/app.js`](public/app.js) | View transitions, toast, pointer sheen, backdrop digits |

The code is MIT licensed, so you can copy these files into another project as long as you keep the license notice.

---

## 1. Principles

1. **Ink and paper, one accent.** Near-black or warm paper, text in a single colour at three strengths, and one orange used sparingly: the logo's fourth dot, an on-switch, a warning line. Never gradients of colour.
2. **Glass needs something behind it.** Frosted panels only look like glass when there's content to bend. Here that's giant, faint digits drifting slowly behind the page.
3. **Motion has weight.** Things spring, overshoot a little, and blur along their direction of travel in proportion to their speed. Nothing fades in flatly.
4. **Fast on interaction, calm at rest.** View changes take under a third of a second and can be interrupted at any moment. The only constant motion is the slow drift in the background.
5. **Honest and accessible.** Respect reduced motion, keep focus visible, keep contrast readable, and step down gracefully on slow devices.

---

## 2. Colour

Dark is the default; light follows the system setting. Colours are tokens on `:root`, and components only ever use tokens.

```css
:root {
  color-scheme: dark;

  --bg: #0c0c0b;
  --text: #f2f1ed;
  --text-2: rgb(242 241 237 / 0.62);
  --text-3: rgb(242 241 237 / 0.4);
  --fill: rgb(255 255 255 / 0.05);
  --fill-2: rgb(255 255 255 / 0.09);
  --fill-3: rgb(255 255 255 / 0.16);
  --hairline: rgb(255 255 255 / 0.08);
  --dash: rgb(255 255 255 / 0.16);
  --rim: rgb(255 255 255 / 0.45);
  --spec: rgb(255 255 255 / 0.26);
  --well: rgb(0 0 0 / 0.3);
  --glass-tint: linear-gradient(180deg, rgb(255 255 255 / 0.09), rgb(255 255 255 / 0.035));
  --shadow-lg: 0 40px 80px -36px rgb(0 0 0 / 0.85), 0 12px 30px -16px rgb(0 0 0 / 0.6);
  --shadow-sm: 0 8px 20px -12px rgb(0 0 0 / 0.7);

  --accent: #ff6a2b;
  --solid: #f2f1ed;
  --ink: #0c0c0b;
  --focus: rgb(242 241 237 / 0.55);
  --focus-glow: rgb(242 241 237 / 0.09);
  --danger: #ff5f57;
  --danger-glow: rgb(255 95 87 / 0.14);
  --ticker: rgb(255 255 255 / 0.035);
}

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #ebe9e4;
    --text: #141412;
    --text-2: rgb(20 20 18 / 0.62);
    --text-3: rgb(20 20 18 / 0.42);
    --fill: rgb(255 255 255 / 0.4);
    --fill-2: rgb(255 255 255 / 0.6);
    --fill-3: rgb(255 255 255 / 0.92);
    --hairline: rgb(20 20 18 / 0.08);
    --dash: rgb(20 20 18 / 0.2);
    --rim: rgb(255 255 255 / 0.95);
    --spec: rgb(255 255 255 / 0.9);
    --well: rgb(255 255 255 / 0.4);
    --glass-tint: linear-gradient(180deg, rgb(255 255 255 / 0.62), rgb(255 255 255 / 0.38));
    --shadow-lg: 0 40px 80px -40px rgb(30 25 15 / 0.3), 0 12px 30px -18px rgb(30 25 15 / 0.22);
    --shadow-sm: 0 8px 20px -12px rgb(30 25 15 / 0.3);
    --accent: #e4511b;
    --solid: #141412;
    --ink: #f7f6f2;
    --focus: rgb(20 20 18 / 0.5);
    --focus-glow: rgb(20 20 18 / 0.07);
    --danger: #d63a32;
    --danger-glow: rgb(214 58 50 / 0.12);
    --ticker: rgb(20 20 18 / 0.045);
  }
}
```

| Token | Role |
| --- | --- |
| `--bg` | Page background: warm black or warm paper, never pure black or white |
| `--text`, `--text-2`, `--text-3` | Primary, secondary and tertiary text. The same colour at 100%, 62% and about 40% |
| `--fill`, `--fill-2`, `--fill-3` | Raised surfaces inside glass, from subtle to selected |
| `--well` | Sunken surfaces: text areas, digit boxes, chip tracks |
| `--hairline` | 1px borders and separators, always as `inset 0 0 0 1px` box-shadows |
| `--spec` | The 1px specular highlight along the top edge of raised things |
| `--rim` | The brightest point of the glass rim |
| `--glass-tint` | The faint vertical gradient inside glass |
| `--solid` / `--ink` | The primary button: solid in the text colour, with text in the background colour |
| `--accent` | The one colour. Use it for one thing per screen at most |
| `--danger` | Errors and destructive actions only |
| `--ticker` | The background digits: barely there (3.5–4.5%) |

Text selection uses the accent: `::selection { background: var(--accent); color: #fff; }`.

---

## 3. Typography

System fonts only: San Francisco on Apple devices, Segoe UI Variable on Windows, Roboto on Android. No web fonts to load.

```css
--font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
--font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", Roboto, sans-serif;
--font-num: ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```

| Use | Size / line height | Weight | Tracking | Font |
| --- | --- | --- | --- | --- |
| Hero headline | `clamp(30px, 7vw, 42px)` / 1.08 | 660 | −0.035em | display |
| Section title (h2) | 20px / 1.2 | 660 | −0.02em | display |
| Long-text heading | 17px / 1.3 | 650 | −0.01em | display |
| Progress title | 18px / 1.3 | 620 | −0.02em | display |
| Brand wordmark | 19px / 1 | 680 | −0.03em | display |
| Body | 15px / 1.5 | 400 | 0 | text |
| Message / input text | 16px / 1.5 | 400 | 0 | text (16px stops iOS from zooming) |
| Buttons | 15.5px | 600 | −0.01em | text |
| Labels, rows | 14–14.5px | 520–600 | 0 | text |
| Small / hints | 12.5–13.5px | 400–550 | 0 | text |
| Eyebrow | 12px, uppercase | 650 | +0.12em | text |
| Big digits | `calc(var(--cell) * 0.54)` | 640 | −0.02em | num, `tabular-nums` |

**The two-tone headline** is the signature. First line in `--text`, second in `--text-3`:

```html
<h1>Send a note or a file.<br><span>Open it with four digits.</span></h1>
```

```css
.hero h1 { margin: 0; font: 660 clamp(30px, 7vw, 42px)/1.08 var(--font-display); letter-spacing: -0.035em; }
.hero h1 span { color: var(--text-3); }
h1, h2 { text-wrap: balance; }
```

Numbers that change (sizes, countdowns, codes) always use `font-variant-numeric: tabular-nums` so they don't jitter.

---

## 4. Layout, spacing and shape

- **Single column:** `width: min(100% - 32px, 540px)`, centred, `gap: 20px` between blocks.
- **Safe areas:** padding is `max(18px, env(safe-area-inset-top))` at the top and `max(36px, env(safe-area-inset-bottom))` at the bottom, with `viewport-fit=cover` in the viewport meta.
- **Spacing scale:** 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24 px. Most gaps are 8–14 px inside components and 20 px between them.
- **Breakpoints:** `440px` (phones: tighter paddings, `--cell: 80px`) and `360px` (small phones: `--cell: 70px`). Above them, `--cell: 92px`.

| Radius | Used for |
| --- | --- |
| `999px` | Pills: buttons, segmented controls, chips, badges, toast, switch |
| `32px` (28px on phones) | Main glass card, overlay cards |
| `28px` | Long-text cards |
| `22px` | Accordion panels, QR tile |
| `20px` | Text areas, digit boxes, grouped option panels, content blocks |
| `16px` | Rows, text fields |
| `11–14px` | Thumbnails, icon tiles, small captions |

Nested shapes keep their concentric feel: an inner radius is roughly the outer radius minus the padding.

---

## 5. Liquid glass

Glass is four layers on one element: a faint tint, a blurred and saturated view of what's behind, light along the edges, and a soft shadow.

```css
.glass {
  position: relative;
  isolation: isolate;
  background: var(--glass-tint);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  backdrop-filter: blur(18px) saturate(140%);
  box-shadow:
    inset 0 1px 0.5px var(--spec),                 /* light catching the top edge */
    inset 0 -1px 0.5px rgb(255 255 255 / 0.06),    /* faint bottom edge */
    var(--shadow-lg);                              /* lift */
}

/* Rim light: a 1px gradient border, bright where light enters (top-left)
   and leaves (bottom-right). The mask keeps only the border ring. */
.glass::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  padding: 1px;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(140deg,
      var(--rim),
      rgb(255 255 255 / 0.1) 26%,
      rgb(255 255 255 / 0.02) 50%,
      rgb(255 255 255 / 0.08) 74%,
      rgb(255 255 255 / 0.3));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
}

/* Sheen that follows the mouse across the surface. */
.glass::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(420px circle at var(--mx, 50%) var(--my, -40%), rgb(255 255 255 / 0.07), transparent 60%);
  opacity: var(--sheen, 0);
  transition: opacity 0.6s;
}
```

The sheen is driven by a mouse-only `pointermove` listener, throttled to one update per animation frame. For each glass element it sets `--mx` and `--my` (pointer position relative to the element) and `--sheen: 1` while the pointer is within 60 px of it, otherwise `0`. Touch screens skip it.

**Rules for glass**

- **Give it something to blur.** On a flat background, glass looks like a grey box. See the backdrop (section 6).
- **Never animate `filter` or `opacity` on an ancestor of glass** and leave it applied: that makes the ancestor a "backdrop root", and the glass inside stops seeing the page. Entrance animations therefore use `animation-fill-mode: backwards`, never `both` or `forwards`.
- **Stay inside the token set.** Glass surfaces use `--glass-tint`; things *on* glass use `--fill*`, `--well` and `--hairline`. Don't stack glass on glass.
- **Small floating labels** over images use a darker, stronger glass: `background: rgb(12 12 11 / 0.42); backdrop-filter: blur(16px) saturate(150%);` with white text.

### Edge refraction (Chromium only)

In Chromium, small glass pills (the segmented control and the GitHub badge) also *bend* the backdrop at their edges like a glass rod. [`lens.js`](public/lens.js) generates a displacement map for the element's exact size and radius, then applies it inside the backdrop filter:

```css
backdrop-filter: url(#lens-0) blur(1.5px) saturate(1.8);
```

- **The map:** neutral grey (128) in the middle. Within `bezel` px of the edge it points outward, with a smoothstep falloff, so the rim samples from beyond the outline.
- **Parameters:** `bezel: 14, scale: 30` for the segmented control; `bezel: 10, scale: 20` for the badge.
- **Resizing:** the map is rebuilt 120 ms after a resize, and the effect is removed while the size changes so it never warps the wrong area.
- **Other browsers** keep the plain frosted glass, which looks right on its own.

Use it on small pills only. On large panels it's expensive and distracting.

---

## 6. The backdrop

Behind everything sits a fixed layer with two rows of huge, faint digits drifting in opposite directions, plus a fine grain.

```html
<div class="backdrop" aria-hidden="true">
  <div class="ticker">
    <div class="track"></div>
    <div class="track"></div>
  </div>
  <div class="grain"></div>
</div>
```

```css
.backdrop { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }

.ticker {
  position: absolute;
  inset: 0;
  display: grid;
  align-content: space-evenly;
  color: var(--ticker);
  font: 800 clamp(150px, 34vh, 380px)/0.82 var(--font-display);
  letter-spacing: -0.05em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  user-select: none;
}

.track { display: flex; width: max-content; animation: ticker 150s linear infinite; will-change: transform; }
.track:nth-child(2) { animation-duration: 190s; animation-direction: reverse; }
.track span { padding-right: 0.3em; }
@keyframes ticker { to { transform: translate3d(-50%, 0, 0); } }

.grain {
  position: absolute;
  inset: 0;
  opacity: 0.06;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```

Each track holds the same run of six random four-digit numbers twice, so moving it by −50% loops seamlessly:

```js
for (const track of document.querySelectorAll('.ticker .track')) {
  const codes = Array.from({ length: 6 }, () => String(Math.floor(Math.random() * 10_000)).padStart(4, '0')).join(' ');
  track.innerHTML = `<span>${codes}</span><span>${codes}</span>`;
}
```

On another site, swap the digits for whatever suits the brand: words, numbers, initials. Keep them huge, heavy, slow and around 4% opacity.

Never give the grain a `mix-blend-mode`: a blend over the moving digits costs two extra full-screen passes on every frame. Plain opacity looks the same.

---

## 7. Depth and shadows

| Level | Recipe |
| --- | --- |
| Floating glass (cards, toast, overlays) | `var(--shadow-lg)` plus the inset spec lines |
| Raised controls (pills, badges, filled boxes) | `inset 0 1px 0.5px var(--spec), var(--shadow-sm)` |
| Selected pill / thumb | `background: var(--fill-3)` + `inset 0 1px 0.5px var(--spec), 0 6px 16px -8px rgb(0 0 0 / 0.55)` |
| Pressed / lifted | Add `inset 0 0 0 1px var(--hairline)` and a slightly deeper drop shadow |
| Sunken (wells) | `background: var(--well); box-shadow: inset 0 0 0 1px var(--hairline), inset 0 3px 10px rgb(0 0 0 / 0.12)` |
| Flat surface on glass | `background: var(--fill); box-shadow: inset 0 0 0 1px var(--hairline)` |

Borders are always inset box-shadows, never `border`, so they never change layout.

---

## 8. Components

### Buttons

```css
.btn {
  position: relative; isolation: isolate;
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  height: 52px; padding: 0 20px; border: 0; border-radius: 999px;
  color: var(--text); font-size: 15.5px; font-weight: 600; letter-spacing: -0.01em;
  cursor: pointer; user-select: none;
  transition: transform 0.3s var(--spring), box-shadow 0.2s, opacity 0.2s, background 0.2s;
}
.btn:active:not(:disabled) { transform: scale(0.97); }
.btn:disabled { opacity: 0.32; cursor: not-allowed; }

/* Primary: solid in the text colour, with a glossy upper lens */
.btn-primary {
  width: 100%; overflow: hidden;
  background: var(--solid); color: var(--ink);
  box-shadow: inset 0 1px 0.5px rgb(255 255 255 / 0.5), inset 0 -2px 5px rgb(0 0 0 / 0.12), 0 12px 26px -14px rgb(0 0 0 / 0.7);
}
.btn-primary::before {
  content: ""; position: absolute; inset: 1px 1px 52%; z-index: -1;
  border-radius: 999px 999px 40% 40% / 999px 999px 16px 16px;
  background: linear-gradient(rgb(255 255 255 / 0.22), rgb(255 255 255 / 0));
  pointer-events: none;
}

/* Glass: for secondary actions on a card */
.btn-glass { background: var(--fill-2); box-shadow: inset 0 1px 0.5px var(--spec), inset 0 0 0 1px var(--hairline), var(--shadow-sm); }
.btn-glass:hover { background: var(--fill-3); }
```

- **Text buttons** (`.text-btn`): no background until hover, 14px / 550, colour `--text-2`, and `--danger` for destructive ones.
- **Icon buttons** (`.icon-btn`): 36px circles that press down to `scale(0.88)`.
- **Destructive actions** need a second tap: the label changes to "Tap again to delete" for 3 seconds.

### Segmented control with a liquid pill

A pill track (`.seg`: 4px padding, 40px buttons, `width: min(100%, 280px)`) with a separate thumb element underneath the labels. [`slider.js`](public/slider.js) drives the thumb. Tap a label to move it, or press and drag it:

- **On press:** the pill swells to 1.1× on a spring and its shadow deepens.
- **While dragging:** it follows the finger, stretches with speed, and lights up the label beneath it. Past the ends it resists like rubber and squashes against the wall; it never leaves the track.
- **On release:** it springs to the nearest option, or further on a quick flick, with a small overshoot.
- **Input:** works with taps, the mouse, touch and arrow keys. `touch-action: pan-y` keeps vertical scrolling working.

The same slider drives the smaller **chips** (`.chips`: 3px padding, 32px buttons, 13px labels), even when options have different widths.

### Toggle switch

A native checkbox with `appearance: none`:
- **Track:** 52 × 32, `--fill-2`; turns `--accent` when on.
- **Knob:** 26px, white, `transition: transform 0.4s var(--spring)`.
- **While pressed:** the knob widens to 32px, like a drop of liquid, then springs across.

### Inputs

| Input | Recipe |
| --- | --- |
| Text area | `--well`, 20px radius, 16px text; focus ring `inset 0 0 0 1.5px var(--focus), 0 0 0 4px var(--focus-glow)` |
| Text field | Same, 48px tall, 16px radius |
| Digit boxes | `calc(var(--cell) * 0.76)` × `var(--cell)`, 20px radius, rounded numerals; focused box lifts 2px; each typed digit pops (scale 1.14 → 1 with a 3px blur, 380ms spring). Empty boxes show a *drawn* centred dot (radial gradient), not placeholder text, so it sits centred in every browser |
| Drop zone | `1.5px dashed var(--dash)`, 20px radius; on hover the fill appears and the border turns `--focus`; on press `scale(0.985)` |

### Big digit tiles ("reels")

Same size as the digit boxes, with `--fill`, inset spec and hairline, an inner bottom shade (`inset 0 -12px 24px rgb(0 0 0 / 0.12)`), a top gloss (`::after` gradient), and a mask that fades the top and bottom 24%. Each holds a vertical strip of 30 digits for the slot-machine reveal (section 9).

### Pills, badges and labels

- **Pill** (`.pill`): 30px tall, `--fill` + hairline, 13px / 550 text, 15px icon. The accent version is for one warning, e.g. "Burns once opened".
- **Badge** (`.badge`): a glass pill, 34px, 12.5px, used for the header link.
- **Eyebrow:** 12px uppercase with +0.12em tracking, `--text-3`, above a centred section.

### Grouped options

A panel with `--fill`, hairline and a 20px radius. Rows are at least 54px tall, separated by `border-top: 1px solid var(--hairline)`, with the label on the left and the control on the right, like an iOS settings group.

### Accordion

`<details>` with a glass summary row. The chevron turns 180° on a spring. The content animates open and closed with `::details-content { block-size: 0 → auto; transition: block-size 0.35s var(--out), content-visibility 0.35s allow-discrete; }` plus `interpolate-size: allow-keywords` on `:root`.

### Lists and rows

File rows: 7px padding, 16px radius, `--fill` + hairline, a 42px rounded thumbnail, name (14px / 550, ellipsis) over size (12.5px, `--text-3`, tabular). They enter with `pop-in` and leave with `pop-out` (section 9).

### Toast

A glass pill fixed at the bottom centre with an icon and short text. It springs in from 18px below at scale 0.94 out of a 10px blur over 460ms. It reverses out after 2.2 s, or 4.5 s for errors.

### Overlays and dialogs

- **Scrim:** `rgb(12 12 11 / 0.3–0.35)` with `backdrop-filter: blur(8–10px)`, fading in over 200 ms.
- **Card:** glass, 32px radius, `width: min(100%, 320px)`, rising in on a spring (`rise 0.45s var(--spring)`).
- **Closing:** Done, Escape or a tap outside.
- **Focus:** moves into the dialog on open and back to the trigger on close.

### Progress

- **Spinner:** a 44px conic gradient masked to a 3px ring, spinning in 0.8 s.
- **Bar:** 4px, `--fill-2` track and `--text` fill, `transition: width 0.25s var(--out)`.
- **Unknown progress:** a 34% segment sweeping across (`sweep 1.1s var(--out) infinite`).

### Icons

- **Grid:** 24 × 24 viewBox, drawn at 18px.
- **Style:** `fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round`.
- **Brand marks** (like GitHub): filled instead (`.i.solid`).
- **Delivery:** keep icons in one inline SVG sprite and use them with `<svg class="i"><use href="#i-name"/></svg>`.

### Logo

Four dots in a 2 × 2 grid (circles of r = 4.5 at 6.5/17.5 in a 24-unit box), all in `--text` except the bottom-right one in `--accent`. The wordmark sits beside it at 19px / 680 with −0.03em tracking.

---

## 9. Motion

### Easing and timing

```css
--spring: cubic-bezier(0.34, 1.56, 0.64, 1);  /* overshoots, then settles: presses, pops, toggles */
--out: cubic-bezier(0.22, 1, 0.36, 1);        /* fast start, soft landing: reveals, resizes */
```

In JavaScript, the eased tweens use `outQuart: t => 1 - (1 - t) ** 4` for view changes and reels.

| Motion | Duration | Easing |
| --- | --- | --- |
| Page entrance (`rise`) | 600ms, staggered by 40ms per block | `--out` |
| Switching views sideways (tabs) | 280ms | outQuart |
| Switching views vertically (steps) | 320ms | outQuart |
| Press feedback | 300ms | `--spring` |
| Toggle knob | 400ms | `--spring` |
| Chevron, accordion | 350ms | `--spring` / `--out` |
| List item in / out | 350ms / 200ms | `--out` / ease-in |
| Toast in / out | 460ms / 280ms | `--spring` / ease-in |
| Overlay fade, card rise | 200ms, 450ms | ease, `--spring` |
| Digit pop | 380ms | `--spring` |
| Reels | 950ms + 170ms per reel | linear progress with outQuart inside |

### Entrance: settle in from a blur

```css
.reveal { animation: rise 0.6s var(--out) backwards; }
.d1 { animation-delay: 40ms; } .d2 { animation-delay: 80ms; } .d3 { animation-delay: 120ms; } .d4 { animation-delay: 160ms; }
@keyframes rise { from { opacity: 0; transform: translateY(10px); filter: blur(8px); } }

@keyframes pop-in { from { opacity: 0; transform: translateY(8px); filter: blur(6px); } }
@keyframes pop-out { to { opacity: 0; transform: scale(0.97); filter: blur(5px); } }
```

### View transitions inside a glass card

The card stays put while views slide through it (see `transition()` in [`app.js`](public/app.js)):

- **Travel:** `min(30% of the width, 140px)` sideways, or 22px vertically.
- **Fade:** the leaving view fades out by 40% of the way (`opacity = 1 − 2.5v`); the arriving view fades in by halfway (`opacity = 2v`).
- **Height:** the card's height interpolates from the old view's to the new one's.
- **Blur:** both views blur along the direction of travel (below).
- **Interruptible:** starting a new transition snaps the running one to its end, so quick taps never wait.

### Motion blur proportional to speed

Every moving element borrows an SVG Gaussian blur from a small pool and is blurred only along its axis of travel:

```js
const perFrame = (Math.abs(pos - lastPos) / (now - lastTime)) * 16.7;   // px per 60 Hz frame
const amount = Math.min(max, perFrame * strength);
filter.setAttribute('stdDeviation', axis === 'x' ? `${amount} 0` : `0 ${amount}`);
```

| Moving element | strength | max |
| --- | --- | --- |
| Whole views | 0.35 | 12 |
| Liquid pill | 0.35 | 6 |
| Reels | 0.42 | 22 |

The blur moves in half-pixel steps and comes off entirely below half a pixel, so it costs nothing once the movement is too slow to see.

### Liquid pill physics

All motion runs on damped springs, integrated in fixed 1/240-second steps so the bounce is the same at any frame rate:

| Spring | Stiffness | Damping | Feel |
| --- | --- | --- | --- |
| Position and width | 520 | 28 | About 7% overshoot, settles in under half a second |
| Swell on press (to 1.1×) | 700 | 22 | A quick, bouncy pop |

- **Stretch with speed:** `stretch = min(0.16, |velocity| / 6000)`; scaleX `1 + stretch`, scaleY `1 − stretch / 2`.
- **Rubber band past the ends:** `limit × (1 − e^(−distance / 40))`, where `limit` is 14px or 20% of the pill's width, whichever is smaller. It squashes against the wall instead of leaving the track.
- **Fling:** the release point is projected 0.08 s ahead using the current velocity.
- **Drag:** starts after 4px of movement. The click that ends a drag is swallowed so it doesn't select twice.
- **Rendering:** transform only. The width changes only between options of different widths.

### Slot-machine reveal

Each digit reel spins a 30-digit strip down to its target over `950 + 170 × i` ms. Progress is outQuart plus a small settle (`0.22 × sin²` over the last 30%), so each digit lands with a little bounce, one after another, with vertical motion blur.

### Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

JavaScript tweens jump straight to the end and springs snap. Loading spinners keep turning so progress stays visible.

---

## 10. Keeping it smooth

The look is expensive if done naively. These rules keep it fast, even on budget phones:

1. **Animate only `transform` and `opacity` per frame.** Avoid per-frame layout. The card's height is the one deliberate exception, and it's short.
2. **No blend modes over moving content.** They force extra full-screen passes every frame.
3. **Hold the backdrop while something animates.** Moving content behind glass makes every panel re-blur each frame, so the drift pauses during transitions, drags and reveals (`holdBackdrop()` in `motion.js`, which adds `.hold-backdrop` to `<html>`). The pause is invisible; the digits move about half a pixel per frame.
4. **Motion blur only while it's visible**, in half-pixel steps (section 9).
5. **Lite mode.** If two view changes in a row run below about 40 fps, `<html>` gets `.lite`. That stops the drift, turns off motion blur and edge refraction, and is remembered for 30 days. The glass, slides and springs all stay.
6. **No filters left on glass ancestors** (section 5).
7. **`will-change` only on things that really move constantly:** the backdrop tracks and the pill.

---

## 11. Accessibility

- **Focus:** `:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }`. Never remove focus without replacing it.
- **Touch:**
  - turn off the blue tap flash: `-webkit-tap-highlight-color: transparent` on `html`;
  - stop long-press text selection on controls: `user-select: none; -webkit-touch-callout: none`. Text fields stay selectable.
- **Semantics:**
  - segmented controls are `role="tablist"`/`tab` with `aria-selected`;
  - option chips are a `radiogroup` with `aria-checked`;
  - status text uses `aria-live`.
- **Keyboard:** arrow keys move through tabs and chips, and Escape closes dialogs.
- **Contrast:** body text uses `--text` or `--text-2`. Keep `--text-3` for decoration and secondary hints.
- **Theme:** follows `prefers-color-scheme`. Theme-colour meta tags exist for both themes.
- **Motion:** honours `prefers-reduced-motion` (section 9).

---

## 12. Voice

- **Short, plain sentences in sentence case.** No exclamation marks, no jargon.
- **Two-line headlines:** a statement, then a quieter second line.
- **Honest about limits.** Say what something can't do as clearly as what it can, e.g. "Use it for things that matter for minutes, not secrets that must stay secret forever."
- **Buttons say what happens:** "Encrypt & get code", "Open another code", "Delete now".

---

## 13. Starter page

A complete page with the backdrop, glass, the two-tone headline and a primary button. Save it as `index.html` next to a `styles.css` built from sections 2, 3, 5, 6 and 8.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <meta name="theme-color" content="#0c0c0b" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#ebe9e4" media="(prefers-color-scheme: light)">
  <title>Your site</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="backdrop" aria-hidden="true">
    <div class="ticker">
      <div class="track"><span>2741 0937 8853 1206 5512 4821</span><span>2741 0937 8853 1206 5512 4821</span></div>
      <div class="track"><span>3804 1297 6650 9152 4471 0386</span><span>3804 1297 6650 9152 4471 0386</span></div>
    </div>
    <div class="grain"></div>
  </div>

  <div class="shell">
    <header class="top">
      <a class="brand reveal" href="/">
        <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="4.5"/><circle cx="17.5" cy="6.5" r="4.5"/>
          <circle cx="6.5" cy="17.5" r="4.5"/><circle class="hot" cx="17.5" cy="17.5" r="4.5"/>
        </svg>
        <span>Your brand</span>
      </a>
    </header>

    <section class="hero">
      <h1 class="reveal d1">Say the main thing.<br><span>Then say it quieter.</span></h1>
    </section>

    <main class="card glass reveal d2">
      <p class="eyebrow">Get started</p>
      <button class="btn btn-primary" type="button">Do the thing</button>
    </main>
  </div>
</body>
</html>
```

From there, bring in what you need:
- [`slider.js`](public/slider.js) for the liquid pill;
- [`motion.js`](public/motion.js) for motion blur and reels;
- [`lens.js`](public/lens.js) for edge refraction;
- the `transition()` function in [`app.js`](public/app.js) for sliding views inside a glass card.
