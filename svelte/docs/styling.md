# Styling

`<style>` works as in any Svelte component: scoped to the component, with `:global(…)` for
the whole app. Rules are resolved when the app is built. Each element's matching
declarations become the C options CUI draws with, so styling costs nothing at run time.
Rules that depend on a dynamic class or on the pointer become C conditions.

```svelte
<div class="card" class:selected>
	<h3>Profile</h3>
	<p class="muted">Changes save as you type.</p>
	<button class="primary" onclick={save}>Save</button>
</div>

<style>
	.card {
		padding: 20px 24px;
		gap: 10px;
		border: 1px solid var(--cui-border);
		border-radius: 14px;
		background: var(--cui-surface);
	}
	.card.selected {
		border-color: var(--cui-accent);
	}
	.muted {
		color: var(--cui-text-muted);
	}
	.primary {
		background: #7747ff;
		color: white;
	}
	.primary:hover {
		background: #6236e8;
	}
</style>
```

## HTML elements

| Elements | In CUI |
|---|---|
| `div`, `section`, `article`, `header`, `footer`, `main`, `nav`, `aside`, `form`, `figure`, `ul`, `ol`, `li`, `table`, `tr`, `td`, `th` | A box. A block stacks its children like the browser does (a column, children full width). When every child is inline it flows them in a wrapping row. `display: flex` and `grid` follow CSS. An `li` has a bullet, or its number in an `ol` (from `start`, counting items from `{#each}` too). |
| `p`, `span`, `label`, `strong`, `b`, `em`, `small`, `code`, `kbd`, `pre`, `a`, `h1`…`h6` | Text, styled by the element (headings are larger, `strong` is bolder, `code` is monospace) and by CSS. Text with elements inside (`<p>Hello <strong>you</strong></p>`) flows as a row of runs. |
| `button`, `a href`, anything with `onclick` | A clickable box, with a hover tint and a hand cursor. `a href` opens the link when nothing handles the click. |
| `input` (text, password, email, search, url, tel, number, checkbox, radio, range), `textarea`, `select` with `option`s (written out, from `{#each}`, or both) | CUI's controls, with `bind:value` / `bind:checked` / `bind:group`, `placeholder`, `disabled`, `readonly`, `min`, `max`, `step`, `rows`. `<label>text <input></label>` labels the control. Enter in a field submits its `<form>`. |
| `img src` | An image (a file path; not in the browser build yet). |
| `hr` | A separator. |
| `progress`, `meter` | A progress bar. |

Handlers written for the DOM keep working: `oninput={(e) => (name = e.target.value)}` and
`onsubmit={(e) => { e.preventDefault(); … }}` get event-like objects.

There is no user-agent margin: elements start with none, as after a CSS reset.

## Selectors

**Supported:**

- type, class and id selectors, and attribute selectors with static values;
- compound selectors (`button.primary.large`);
- descendant (`.card .title`) and child (`.list > li`) combinators;
- `:hover`, `:active`, `:focus`, `:focus-visible`, on the element itself or on an ancestor in
  the same block;
- `:global(…)` and `:root`;
- specificity and source order, like the browser; inline `style` wins.

**Dynamic classes** work too: `class:x={cond}`, `class={expr}`, and `class="a {b}"` (strings,
arrays and objects, as Svelte accepts). A rule that depends on them becomes a condition
evaluated each frame.

**Not supported** (a build warning each):

- the sibling combinators `+` and `~`;
- structural pseudo-classes (`:first-child`, `:nth-child`);
- pseudo-elements;
- nesting;
- `@media` other than `prefers-color-scheme`.

## Properties

| CSS | CUI |
|---|---|
| `display: flex \| block \| grid \| none`, `flex-direction`, `flex-wrap` | the box's direction, wrapping, or not drawing it |
| `align-items`, `justify-content` | `align`, `justify` |
| `gap` (and `row-gap`, `column-gap`) | `gap` |
| `padding` (all forms, `padding-inline`, `padding-block`) | `pad_top` … `pad_left` |
| `margin` (numbers) | a transparent box around the element; `margin: 0 auto` centers it |
| `width`, `height` (`px`, `rem`, `%`, `auto`, `fit-content`) | `width`, `height` |
| `min-width` … `max-height` | the same |
| `flex: 1`, `flex-grow: 2` | grow along the parent's direction |
| `grid-template-columns: repeat(3, 1fr)` / `repeat(auto-fill, minmax(180px, 1fr))` | `columns` / `min_column_width` |
| `background`, `background-color` | `bg` (colors only) |
| `border`, `border-width`, `border-color`, `border-style: none` | `border`, `border_color` (one width for all sides) |
| `border-radius` (1 to 4 values) | `radius` or per corner |
| `box-shadow` | `elevation`: resting, raised or floating, by blur |
| `opacity` | `opacity` |
| `overflow: auto \| scroll \| hidden` | a scroll area or clipping |
| `direction: rtl` | right to left layout |
| `color`, `font-size`, `font-weight`, `font-family: monospace`, `text-align`, `line-height`, `white-space: nowrap`, `text-overflow: ellipsis`, `font-variant-numeric: tabular-nums` | text, inherited by descendants as in CSS |
| `cursor: pointer` | the hand cursor |

Lengths are points (`px`); `rem` and `em` are 16 points. Properties with nothing to draw
are accepted and ignored: `box-sizing`, `outline`, `user-select`, `transition`,
`letter-spacing`…. Anything else produces a warning naming the file, rule and property.

### CUI components take CSS too

A class on a CUI component sets whichever of its options the CSS maps to:

```svelte
<Button class="wide" variant="primary">Save</Button>
<Text class="note">Saved</Text>

<style>
	:global(.wide) { width: 100%; }
	.note { color: var(--cui-success); font-size: 12px; }
</style>
```

### Dynamic values

`style:` directives and expressions in `style="…"` are computed in JS and arrive as numbers:

```svelte
<div class="bar" style:width="{progress * 100}%"></div>
<div style="height: {h}px; background: {color}"></div>
```

A whole `style={string}` is not supported; write the properties.

## Colors and the theme

Colors are any CSS color (`#hex`, `rgb()`, `hsl()`, `oklch()`, names) or one of CUI's theme
tokens as a variable. Tokens follow light and dark mode and the accent:

`--cui-background`, `--cui-surface`, `--cui-surface-raised`, `--cui-surface-muted`,
`--cui-foreground`, `--cui-text-secondary`, `--cui-text-muted`, `--cui-border`,
`--cui-border-subtle`, `--cui-border-strong`, `--cui-accent`, `--cui-accent-strong`,
`--cui-accent-subtle`, `--cui-accent-foreground`, `--cui-success`, `--cui-warning`,
`--cui-danger`, `--cui-info`, `--cui-hover`, `--cui-active`, `--cui-scrim`,
`--cui-focus-ring`, `--cui-series-1` … `--cui-series-6`.

Your own variables on `:root` are substituted at build time. Setting CUI's variables on
`:root` changes the theme itself, for every component:

```css
:root {
	--cui-accent: #7747ff;           /* the accent color */
	--cui-radius-control: 8px;       /* buttons and inputs (also -panel, -surface) */
	--cui-text-body: 14px;           /* also -xs, -sm, -lg, --cui-heading-1 … 4 */
	--cui-font-scale: 1.1;
	background: #fafafa;             /* the window */
}

@media (prefers-color-scheme: dark) {
	:root { --cui-accent: #9b7bff; }
	.card { border-color: #333; }    /* any rule: applies while the theme is dark */
}
```

`prefers-color-scheme` follows CUI's theme (`set_theme`, `ThemeToggle`, or the system when
`theme: 'system'`).

## In the browser (DOM)

Components that use only HTML elements and `<style>` compile with plain Svelte too, so they
run in a SvelteKit page as they are. The `--cui-*` variables don't exist there: define them
in your app's CSS, or use your own variables.
