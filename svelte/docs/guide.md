# Guide

## A project

```
my-app/
  main.ts            run(App, { … }): the window and the root component
  App.svelte         components
  app.test.ts        headless tests (optional)
  svelte.config.js   for editors and svelte-check only
  package.json
```

`npx cui-svelte create my-app` writes all of these.

### main.ts

```ts
import { run } from 'cui-svelte';
import App from './App.svelte';

run(App, {
	title: 'Notes',
	width: 900,                // logical size, default 1080 × 720
	height: 600,
	min_width: 360,
	theme: 'system',           // 'light' (default), 'dark', or follow the OS
	accent: 'blue',            // neutral, violet, blue, green, amber, orange, coral, rose
	app_id: 'com.example.notes', // names the data folder (localStorage); default the binary name
	props: { /* App's props */ }
});
```

Code that runs before `run()` (imports, module state) runs before the window exists; that is
fine for anything but the window itself.

## Commands

| | |
|---|---|
| `cui-svelte dev main.ts` | A debug build in a window; reloads on save (see below) |
| `cui-svelte run main.ts [--release]` | Build and start once |
| `cui-svelte build main.ts [--out file]` | A release binary in `dist/` with everything inside |
| `cui-svelte build main.ts --web` | `dist-web/`: the browser build ([Web](web.md)) |
| `cui-svelte build main.ts --app` | `dist/Name.app`: a macOS application (below) |
| `cui-svelte dev main.ts --web [--port n]` | Serve the browser build, reloading the page on save |
| `cui-svelte test file.test.ts` | Headless tests ([Testing](testing.md)) |
| `cui-svelte compile App.svelte` | Print one component's C, skeleton and JS |
| `cui-svelte create dir` | A new app |

### The dev loop

`cui-svelte dev` watches the project.

- **A change to a `<script>` or a `.ts` file** rebuilds the JS bundle. The running app
  reloads it in the same window in a fraction of a second. State is reset, the window
  stays.
- **A change to markup or `<style>`** changes the C, so that component's C file is rebuilt.
  The app is relaunched, which takes about a second.

The first build of any app compiles CUI and QuickJS (10 to 20 seconds). That happens once
per machine: native builds share one CMake tree in your cache folder (`~/Library/Caches/cui-svelte`,
`~/.cache/cui-svelte` or `%LOCALAPPDATA%\cui-svelte`; `CUISV_CACHE` moves it). A project's own
`.cui-svelte/` holds only its generated sources.

### A macOS application

`cui-svelte build main.ts --app` puts the release binary in an application bundle,
`dist/Name.app`, that you can open from Finder, keep in the Dock or put in `/Applications`.

| | Where it comes from |
|---|---|
| Name (menu bar, Dock, Finder) | `--name`, else the `title` given to `run()`, else the folder |
| Identifier | `--id com.example.app`, else `local.` and `run()`'s `app_id` |
| Version | `--app-version`, else your `package.json` |
| Icon | `--icon file.png`, else an `icon.png` next to the entry: square, 1024 px |

Native builds run on macOS 11 and later. A `MACOSX_DEPLOYMENT_TARGET` environment variable
overrides that. The bundle is signed ad hoc, so it opens on the Mac that built it.

To give it to others, have Apple notarize it.

1. Save your notary credentials once, under a profile name of your choice:
   `xcrun notarytool store-credentials notary`. It asks for your Apple ID, team ID and an
   app-specific password, or takes an App Store Connect API key.
2. Run `cui-svelte build main.ts --app --notarize notary`.

The build signs the app with the Developer ID Application identity in your keychain (or
`--sign "Developer ID Application: …"`), with the hardened runtime and a secure timestamp. It
then sends the app to Apple, waits a few minutes, and staples the ticket to it. If Apple
rejects it, the error shows Apple's log.

## Components

There are two kinds of tags.

- **CUI components**, imported from `cui-svelte`: `<Button>`, `<DataGrid>`, `<Kanban>`. They
  compile to the matching CUI call, so they look and behave like CUI. See
  [Components](components.md) and the [reference](component-reference.md).
- **HTML elements**: `<div>`, `<p>`, `<button>`, `<input>`. They become boxes, text and CUI's
  controls, and take their look from `<style>`. See [Styling](styling.md).

Your own `.svelte` components work as in any Svelte app: props, `$bindable`, snippets,
`children`, context, events as callback props.

## What Svelte features work

**All of these behave as in Svelte:**

- **Reactivity:** runes (`$state`, `$derived`, `$effect`, `$props`, `$bindable`,
  `$inspect`), and `.svelte.ts` modules with runes.
- **Blocks and snippets:** `{#if}`, `{:else if}`, `{#each}` (keyed, indexed, `{:else}`),
  `{#await}`, `{#key}`, `{#snippet}`, `{@render}`, `{@const}`, `{@debug}`.
- **Components:** components, snippets as props, `children`, `<svelte:boundary>`.
- **Lifecycle and context:** `onMount`, `onDestroy`, `setContext`, `getContext`.

**On HTML elements and CUI components:**

- **Directives:** `bind:` on CUI components and form elements, `class:`, `style:`.
- **Events:** `onclick`, `oninput`, `onchange`, `onsubmit` (forms), `onmouseenter`,
  `onmouseleave`, `ondblclick`, `oncontextmenu`.

**Not supported, because there is no DOM:**

- `{@html}`;
- `<svelte:element>`, `<svelte:window>`, `<svelte:head>`;
- `use:` actions, `transition:`, `animate:`;
- `bind:this` on elements.

Each of these produces a warning, not a crash.

For shortcuts, use `on_key` from `cui-svelte` in an `$effect` (it returns the function that
stops listening):

```ts
$effect(() => on_key((e) => {
	if (e.primary && e.key === 'k') palette = true;   // Cmd+K on macOS, Ctrl+K elsewhere
	if (e.key === 'escape' && !e.editing) selection = [];
}));
```

## Warnings

The compiler warns about anything it leaves out: an unknown prop, CSS that CUI cannot
draw, a directive with no meaning here. The warning names the file and line. Nothing is
silently dropped.
