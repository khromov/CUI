# Host APIs

Everything here is exported from `cui-svelte`.

## The window

```ts
import { set_title, set_theme, get_theme, set_accent, quit, viewport, platform } from 'cui-svelte';

set_title('Untitled — Notes');
set_theme('dark');                 // 'light' | 'dark'; animates
set_accent('green');
quit();
viewport.width;                    // reactive: read it in markup or an $effect
platform();                        // 'macos' | 'windows' | 'linux' | 'web'
```

## Keyboard

```ts
import { on_key } from 'cui-svelte';

$effect(() =>
	on_key((e) => {
		if (e.primary && e.key === 's') save();          // Cmd+S on macOS, Ctrl+S elsewhere
		if (e.key === 'escape' && !e.editing) close();   // editing: a text field has focus
	})
);
```

`e.key` is a lowercase key name: `"a"`, `"5"`, `"enter"`, `"escape"`, `"left"`, `"f5"`.

## Clipboard, links, dialogs, toasts

```ts
import { clipboard, open_url, open_file, save_file, choose_folder, toast } from 'cui-svelte';

clipboard.write('copied');
clipboard.read();
open_url('https://svelte.dev');

const path = await open_file({ title: 'Open image', filter_name: 'Images', filter: 'png;jpg' });
const out = await save_file({ default_name: 'notes.txt' });

toast('Saved', { tone: 'success', description: 'All changes are on disk' });
toast('Deleted', { action: 'Undo', show_timer: true, onaction: () => restore() });
```

The file dialogs are the system's own. On Linux they need `zenity` or `kdialog`. For a dialog
drawn by CUI, use `<FilePicker>`.

## Files and app data

```ts
import { fs, paths } from 'cui-svelte';

const dir = paths.data();                     // the app's folder in the user's data folder
fs.write_text(`${dir}/notes.md`, text);
fs.read_text(`${dir}/notes.md`);              // string | null (null for a folder too)
fs.read_bytes(path);                          // Uint8Array | null
fs.write_bytes(path, bytes);                  // a Uint8Array or ArrayBuffer
fs.append_text(path, line);
fs.exists(path);
fs.stat(path);                                // { size, dir, modified } | null
fs.list(dir);                                 // [{ name, dir, size, modified }] | null
fs.mkdir(`${dir}/cache`);                     // with parents; true when the folder is there
fs.remove(path);                              // a file or an empty folder
paths.home();
```

`paths.data()` is `~/Library/Application Support/<app>` on macOS, `%APPDATA%\<app>` on
Windows and `$XDG_DATA_HOME/<app>` on Linux. `<app>` is `run()`'s `app_id`, or the binary's
name.

Paths are UTF-8 strings on every platform, Windows included. The `fs` functions return
`false` or `null` when the disk says no. A path that is not a string, such as a Symbol,
throws, as it would in any JS API.

`localStorage` works like the browser's. It is a JSON file in that folder, written shortly
after each change and when the app closes.

## Logs and terminals

```ts
import { LogBuffer, TerminalBuffer } from 'cui-svelte';

const log = new LogBuffer({ lines: 2000 });
log.info('ready');
log.warn('disk almost full', { free: 1.2 });

const term = new TerminalBuffer();
term.writeln('\x1b[32m$\x1b[0m make');          // ANSI colors and cursor moves
```

Show them with `<LogView buffer={log}>` and `<Terminal buffer={term} oncommand={run}>`.

## Elements by id

```ts
import { rect_of, scroll_to } from 'cui-svelte';

rect_of('preview');            // { x, y, w, h } from the latest layout, or null
scroll_to('messages', 0);      // a <Scroll id="messages"> or an element with overflow
```

`scroll_to` returns `false` and changes nothing when no element has that id, or when the
element did not scroll in the latest frame (an input, a button).

## Canvas

`<Canvas>` reserves a box and paints it, in JS or in C.

```svelte
<script>
	import { Canvas } from 'cui-svelte';
	let level = $state(0.5);
</script>

<Canvas
	height={40}
	onpaint={(g) => {
		g.rect(0, 0, g.width, g.height, { fill: 'surface-muted', radius: 8 });
		g.rect(0, 0, g.width * level, g.height, { fill: 'accent', radius: 8 });
		g.text(10, 12, `${Math.round(level * 100)}%`, { color: 'white' });
	}}
	onpress={(x) => (level = x / 300)}
/>
```

The painter `g` has `width` and `height` and these methods:

- `rect`, `circle`, `line`, `polyline`, `polygon`, `arc`;
- `text`, `icon`, `measure`;
- `clip(x, y, w, h, fn)`.

Coordinates start at the canvas's top left corner. Colors are any CSS color or theme token.

`onpaint` runs while CUI paints the frame. Draw from state; don't change it there. Events:
`onclick(x, y)`, `onpress(x, y)` while held, `onhover(x, y)`.

For heavy drawing, paint in C: `paint="name"` names a function in the component's C (see
below), and `data={[…]}` passes it up to 64 numbers.

```c
static void draw_meter(cui_ctx *ui, cui_rect r, const float *data, int n) {
    cui_draw_rect(ui, r, CUI_CORNERS(4), CUI_COLOR_SURFACE_MUTED);
    cui_draw_rect(ui, (cui_rect){ r.x, r.y, r.w * data[0], r.h }, CUI_CORNERS(4), CUI_COLOR_ACCENT);
}
```

```svelte
<Canvas height={12} paint="draw_meter" data={[level]} />
```

## C in a component

A component can carry C. It is compiled into the component's C file, with CUI's headers
included:

- **A sibling file,** `Meter.svelte.c` next to `Meter.svelte`. Editors highlight it as C,
  and svelte-check never sees it.
- **A block,** `<script lang="c">…</script>` in the component. Handy for a few lines.
  svelte-check reports the second `<script>`, so typed projects use the sibling file.

Functions marked `cuisv_export` are callable from JS through `native`:

```c
// Meter.svelte.c
#include <math.h>
cuisv_export double hypotenuse(double a, double b) { return sqrt(a * a + b * b); }
cuisv_export const char *greet(const char *name) {
    static char buf[64];
    snprintf(buf, sizeof buf, "hello %s", name);
    return buf;
}
```

```ts
import { native } from 'cui-svelte';
native.hypotenuse(3, 4);    // 5
native.greet('C');          // "hello C"
```

Exported functions take and return `double`, `float`, `int`, `bool`, `const char *` or
`void`. In the browser build, the ones that take and return numbers are wasm exports;
strings are native only for now.

## Web APIs in QuickJS

**Provided natively:**

- `console`;
- `setTimeout`, `setInterval`, `requestAnimationFrame` (and the `clear`/`cancel` functions);
- `queueMicrotask`, `performance.now()`;
- `structuredClone`, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`;
- `crypto.getRandomValues`, `crypto.randomUUID` (seeded from `Math.random`, not
  cryptographically strong);
- `localStorage`.

**Not provided natively:** `fetch`, `WebSocket` and the DOM.

npm packages that use only these APIs bundle and run as they are.
