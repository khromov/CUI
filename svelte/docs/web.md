# The browser build

```sh
cui-svelte build main.ts --web          # dist-web/: index.html, app.js, app.wasm
cui-svelte dev main.ts --web            # http://localhost:5174, reloading on save
```

The same app runs in a page:

- **The C half** (CUI, the cui-svelte runtime and the app's templates) is one WebAssembly
  module, built with plain clang and `wasm-ld` against CUI's own web shim. There's no
  Emscripten, and CUI's renderer draws into a canvas.
- **The JS half** (Svelte, your scripts, npm packages) runs in the browser's own JS engine
  instead of QuickJS.

A small bridge installs the same `__cuisv` object QuickJS has natively, over the module's
exports, so the components and runtime are identical. A gallery of about a hundred
components is around 575 KB of wasm and 110 KB of JS before compression.

`dist-web/` is static: any file server works (`.wasm` must be served as `application/wasm`).

## What differs from native

| | Browser |
|---|---|
| Clipboard | Writes go to the system clipboard; reads see what was last written, copied in the app or pasted into the page |
| `open_url` | A new tab |
| File dialogs, `fs`, `paths` | Not available (`open_file` resolves to `null`, `fs` reads return `null`) |
| `localStorage` | The browser's |
| Images from files (`<img src>`, `src=`) | Not yet |
| `native` C functions | Exported functions that take and return numbers; not strings yet |
| Timers, `requestAnimationFrame`, `URL`, `crypto`… | The browser's |
| `platform()` | `"web"` |

## Requirements

clang with the wasm32 target, and `wasm-ld`. macOS's clang has the target; add lld with
`brew install lld`. On Debian and Ubuntu: `apt install clang lld`. `CUISV_CLANG` and
`CUISV_WASM_LD` point to other builds.
