# Testing

`cui-svelte test file.test.ts` builds the app with a host that has no window. That host
uses CUI's software renderer with reduced motion, so frames are deterministic. The test
file runs inside it, in QuickJS, with the same components and runtime as the app.

```ts
import { mount_test, test, expect } from 'cui-svelte/test';
import App from './App.svelte';

test('counts clicks', () => {
	const app = mount_test(App, { width: 480, height: 360 });
	app.click('Click me');
	app.click('Click me');
	expect(app.flat()).toContain('Clicked 2 times');
});
```

`mount_test(Component, options)` takes `run()`'s options (`width`, `height`, `theme`,
`props`) and draws two frames. It returns:

| | |
|---|---|
| `frame(n = 1)` | Draws `n` frames: JS timers, the templates, events to JS |
| `text()` | Every text on screen, one per line, in build order |
| `flat()` | The same as one string with whitespace collapsed (`"Clicked 2 times"` across a `<strong>`) |
| `nodes()` | `[{ text, x, y, w, h }]` |
| `find(text \| regexp)` | The first node that equals (or contains) the text |
| `rect(id)` | Where the element with `id="…"` was laid out |
| `click(target, button?)` | Moves to a text, a rect or a point, presses and releases |
| `move(target)` | Hover |
| `type(text)` | Types into whatever has focus |
| `key(name, ...mods)` | `key('enter')`, `key('k', 'ctrl')` |
| `scroll(dy, dx?)` | The wheel |
| `screenshot(path, scale = 1)` | A PNG of the last frame (`scale` 2 for retina, up to 8) |
| `clipboard()` | What the app copied |

`temp_path(name)` returns a path in a `cui-svelte-tests` folder under the system's temporary
folder, for screenshots and scratch files: `app.screenshot(temp_path('home.png'))`.

`frame()` and `screenshot()` throw when called from inside a frame: from an event handler, a
timer that comes due during `frame()`, or `onpaint`.

`test(name, fn)` takes sync or async functions (timers and promises run while you `await`).
`expect(x)` has `toBe`, `toEqual`, `toContain`, `toBeTruthy`, `toBeGreaterThan`,
`toBeLessThan`, `toBeCloseTo` and `.not`. The process exits with 1 when a test fails, so
`cui-svelte test` works in CI.

Text drawn by painting (a log view's lines, chart labels, a canvas) is not in `text()`;
check those with a screenshot.

## This package's own tests

```sh
npm test                 # every test/**/*.test.ts and examples/**/*.test.ts
node test/run.ts css     # the ones whose path contains "css"
VERBOSE=1 npm test       # with each file's output
npm run typecheck        # tsc and svelte-check
node test/codegen/codegen.ts --update   # after a change to the compiler's output; review with git diff
```

`test/codegen` is the compiler's golden output. It compiles every component under `test/` and
`examples/`, plus a corpus that uses each component of `components.ts` four ways (static props,
other static values, dynamic props with every event, bound props), and compares the generated
C, skeleton and metadata byte for byte with `test/codegen/snapshots/`. The tests reach about
half of the components, so a refactor that should not change the output proves it here, and
one that should shows how in the snapshot diff.
