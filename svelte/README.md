# cui-svelte

**Svelte 5 for CUI.** Components compile to C that calls CUI directly, every frame. The
`<script>`, runes reactivity and npm packages run in an embedded [QuickJS-ng](https://github.com/quickjs-ng/quickjs).
The result is one native binary of a couple of megabytes, or a WebAssembly page.

```svelte
<script>
	import { Column, Row, Heading, Switch, Button } from 'cui-svelte';

	let notifications = $state(true);
	let clicks = $state(0);
</script>

<Column pad={32} gap={16}>
	<Heading level={2}>Hello, CUI</Heading>
	<Switch bind:checked={notifications}>Notifications</Switch>
	<Row gap={8}>
		<Button variant="primary" onclick={() => clicks++}>Click me</Button>
		<p class="count">Clicked {clicks} times</p>
	</Row>
</Column>

<style>
	.count {
		color: var(--cui-text-secondary);
	}
</style>
```

```ts
// main.ts
import { run } from 'cui-svelte';
import App from './App.svelte';

run(App, { title: 'Hello', width: 420, height: 300 });
```

```sh
npx cui-svelte dev main.ts          # a native window; saving reloads it
npx cui-svelte build main.ts        # dist/<app>: one binary
npx cui-svelte build main.ts --web  # dist-web/: index.html, app.js, app.wasm
npx cui-svelte test app.test.ts     # headless tests
```

## How it works

Each `.svelte` file is split in two at build time.

- **The markup becomes C.** Every template (the component, each `{#if}` branch, each
  `{#each}` item, each snippet) is a C function that calls CUI: `cui_column_begin`,
  `cui_button_ex(ui, "Click me###k5", &o)`. Static text, options and `<style>` rules are
  resolved now and become C literals. Anything dynamic is a *slot* the function reads.
- **The script stays Svelte.** The `<script>` and a *skeleton* of the markup (the blocks and
  the dynamic expressions, nothing else) go through the real Svelte compiler. Runes,
  `{#each}` keys, snippets, components, context and `$bindable` all behave exactly as in
  Svelte, inside QuickJS.

The two halves meet through slots and events.

- When a value changes, Svelte's own effect writes it to a slot: `count` changed, so the
  label slot gets `"Clicked 3 times"`.
- When CUI reports something (a click, a new slider value), the C function queues an
  event. JS handles it before the next frame.

An idle app runs no JS at all; a frame is C reading slots. [docs/architecture.md](docs/architecture.md)
has the details.

## What you get

- **All of CUI** as Svelte components: 237 of them, from `Button` to `DataGrid`,
  `Kanban`, `NodeEditor`, `CodeEditor`, charts and AI components. Props are CUI's option
  names; `bind:` works wherever CUI writes a value back.
  See the [component reference](docs/component-reference.md).
- **HTML and CSS**: `<div>`, `<p>`, `<button>`, `<input>`, `<select>`, `<label>` and
  friends, styled with `<style>`. Flexbox, grid, padding, borders, radius, shadows, colors,
  text, `:hover`, `class:`, `style:`, `:root` theme variables and dark-mode media queries
  all compile to CUI options. A component written this way runs unchanged in a browser.
  See [Styling](docs/styling.md).
- **npm packages and web APIs**: `console`, timers, `requestAnimationFrame`, `URL`,
  `TextEncoder`, `structuredClone`, `crypto.randomUUID` and `localStorage`.
- **Host APIs**: the window, theme, clipboard, native file dialogs, toasts, files and the
  app's data folder. See [Host APIs](docs/host.md).
- **C when you want it**: `<script lang="c">` (or a `Component.svelte.c` file) for
  functions you call from JS and `<Canvas>` painters. See [Host APIs](docs/host.md#c-in-a-component).
- **A fast loop**: script edits reload in the running window; markup and style edits
  rebuild the C (about a second) and relaunch.
- **Tests**: `cui-svelte test` runs headless with the software renderer. Click by text,
  type, take screenshots. See [Testing](docs/testing.md).
- **The browser**: `--web` compiles the same app to WebAssembly with CUI's web host. The JS
  half runs in the page's own engine. See [Web](docs/web.md).

## Requirements

Node 24+ (or Bun 1.4+), CMake 3.14+ and a C compiler. The web build also needs clang with
the wasm32 target and `wasm-ld` (`brew install lld`, `apt install clang lld`).

## Start

```sh
npx cui-svelte create my-app
cd my-app && npm install && npm run dev
```

Then read the [Guide](docs/guide.md).

## Examples

| | |
|---|---|
| [examples/hello](examples/hello) | The smallest app |
| [examples/tasks](examples/tasks) | A task list: components, scoped styles, localStorage, toasts with undo |
| [examples/styled](examples/styled) | HTML elements and CSS only, so it runs in a browser too |
| [examples/gallery](examples/gallery) | Most components on one page |

```sh
npm run gallery       # native
npm run gallery:web   # http://localhost:5174
```

## Status

- **Experimental.** cui-svelte runs on the custom renderer branch of Svelte
  ([sveltejs/svelte#18511](https://github.com/sveltejs/svelte/pull/18511)), vendored in
  `vendor/`.
- **Not supported yet:** `TimelineEditor`, `AvatarUpload` and the path bar's segment
  menus.
- **Browser build gaps:** it has no filesystem, no native file dialogs and no images from
  disk.
