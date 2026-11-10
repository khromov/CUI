# The scriptc build (experimental)

`--scriptc` builds an app without a JS engine in it: the app's JavaScript is compiled to
native code by [scriptc](https://scriptc.dev) and linked with the C templates, the runtime and
CUI into one executable.

```sh
npm install -g scriptc                 # or CUISV_SCRIPTC=/path/to/scriptc
npm install -D typescript              # the build rewrites the bundle with it
cui-svelte build main.ts               # once: the scriptc build links this build's libcui.a
cui-svelte build main.ts --scriptc     # dist/<name>-scriptc
cui-svelte run   main.ts --scriptc
cui-svelte test  app.test.ts --scriptc
CUISV_ENGINE=scriptc node test/run.ts  # this package's test files on the scriptc build
```

The compiler half is the same as in the QuickJS build: the markup becomes C templates and the
`<script>` becomes a Svelte skeleton for the custom renderer ([architecture](architecture.md)).
Only what runs the skeleton changes.

## What scriptc is, and is not

scriptc compiles TypeScript and JavaScript through LLVM. It does **not** emit C source: its
outputs are an executable, an object, assembly, LLVM IR, or (library mode) a static archive.
C code joins the program through an FFI manifest: a JSON file that names C functions, their
argument layout and the archives to link. The manifest allows scalars, borrowed
`(pointer, length)` spans for strings and bytes, and callbacks; a C function cannot return a
string.

## How the pieces fit

```
main.ts, *.svelte ──esbuild──> app.mjs ──scriptc──┐
                                                  ├──> executable
*.svelte ──cui-svelte──> gen/*.c ──cc, ar──> libapp.a ┘  (+ libcui.a, frameworks)
runtime/cuisv*.c ─────────────────────────────┘
```

| Piece | File |
|---|---|
| The build | `src/cli/scriptc.ts` |
| The `__cuisv` bridge and the frame loop | `src/scriptc/host.ts` |
| Host natives (files, clipboard, toasts, dialogs, Canvas drawing) | `src/scriptc/natives.ts` |
| The FFI surface, written once | `src/scriptc/gen-ffi.ts` makes `ffi.ts` and `ffi.functions.json` |
| Globals the bundle reads (timers, `requestAnimationFrame`, `Array.isArray`, `JSON.stringify`) | `src/scriptc/globals.ts` |
| Svelte's `$state` proxy for this build | `src/scriptc/svelte-proxy.js` |
| The C side | `runtime/cuisv_sc.c` |

**Who owns the loop.** In the QuickJS build C owns `main()` and calls into JS. Here the
compiled program owns `main()` and C is a library:

```
turn (one per setImmediate):
    cuisvsc_frame_begin        window events, cui_begin_frame
    events of the last frame -> hooks.dispatch                      (JS)
    timers that are due, toasts, a changed window size,
    requestAnimationFrame callbacks, then flushSync and commit      (JS)
    cuisvsc_frame_render       templates
between turns: scriptc's event loop runs promises, I/O and its own timers
```

- Events are read by index (`ev_count`, `ev_handle(i)`, …). Strings reach JS through
  call-scoped callbacks.
- `<Canvas onpaint>` is a retained callback: CUI calls it while it paints.
- `setTimeout` and `setInterval` are the host's (the build redirects the names): a timer that
  is due when a frame starts runs in that frame, as in the QuickJS build.
- The window sleeps inside `frame_begin`, and scriptc's event loop only runs between turns.
  So the loop asks CUI to wake it for the next timer, and otherwise every 50 ms, which is
  when a settled promise or finished I/O gets to run.

**`<script lang="c">`.** Under `CUISV_SCRIPTC` the compiler emits each exported function as
`cuisvn_<name>` with the FFI's argument layout, and the build writes `natives.ts` and the
manifest entries for them.

## What the bundle goes through

scriptc trusts types: it type-checks JavaScript by its JSDoc and compiles each value with the
representation its type gives. The bundle is rewritten (`for_scriptc` in `src/cli/scriptc.ts`)
so that Svelte's runtime compiles as untyped JavaScript:

- Comments are removed. Svelte's JSDoc does not pass scriptc's check, and it claims types
  that its values do not always have.
- `let x = void 0` becomes `let x`, and a class field `x = null` becomes a bare field that the
  constructor sets. With the initializer, the variable is typed `undefined` (or `null`) for
  good and a later write throws.
- `await import('./x.ts')` becomes a static import that is already resolved.
- `Array.isArray` and `JSON.stringify` are redirected, see below.

## Differences from the QuickJS build

- **`$state` arrays.** scriptc cannot make a `Proxy` over an array. A `$state` array is a
  stand-in that answers like an array:
  - it has one signal for the whole array, so a change to one index re-runs everything that
    read any part of it (a keyed `{#each}` still only touches the rows that changed);
  - `Array.isArray` answers true for it (the build redirects the call), `instanceof Array`
    false;
  - the usual array methods are there; a callback's third argument is a plain copy.
- **`$state` objects** are proxies over a copy of the object, made when it becomes state.
  Svelte does not write to the original either, so this only shows for an accessor property,
  which is read once.
- **`JSON.stringify`** of state works because the build redirects it to a version that
  snapshots first. `SvelteURL` and `SvelteURLSearchParams` are not available.
- **Microtasks** run when a turn ends, not after each callback. State changed by a timer, a
  toast action or an animation frame is applied before the frame is built (the loop calls
  `flushSync`), but the continuation of an `await` waits for the turn to end. QuickJS runs
  microtasks after every callback.
- **Types are trusted.** Code that scriptc cannot compile is not a build error in JavaScript:
  the build succeeds and that statement throws when it runs (inside a `try`, the `catch`
  runs instead). The build prints scriptc's report of those places as warnings; read them.
  Typed code that lies about a type (`as Config` on parsed JSON) throws a `TypeError` where
  QuickJS would carry on.
- **npm packages** the app imports are left to scriptc, which compiles them with their own
  types. A package it cannot compile (dayjs: classes written as constructor functions with
  `prototype` writes) would run in Node.js inside the app, which needs a libnode next to the
  binary. The build reports that as an error. Bundling such a package instead does not help:
  dayjs then stops at `instanceof` against a constructor function, which scriptc does not
  compile either. A package written as ES modules with classes or plain functions works
  (culori does).
- **No hot reload.** There is no engine to load a new bundle into: every change is a rebuild.
- **Node's library is there.** `node:fs`, `fetch`, `process` and the rest of what
  [scriptc supports](https://scriptc.dev/compatibility) work in app code. The host's file
  functions are plain JS over `node:fs` in this build.
- **No browser build** from this path; `--web` keeps using the browser's engine.

## Measured

scriptc 0.4.10, macOS arm64, release builds, both with svelte's production runtime.

| | QuickJS | scriptc |
|---|---|---|
| `examples/hello` binary | 1.9 MB | 6.6 MB (6.0 MB stripped) |
| `examples/gallery` binary | 2.3 MB | 7.4 MB |
| Build after an edit | under 1 s | 10 to 30 s |
| Script-only edit in `dev` | hot reload | rebuild |
| Start to first frame (headless test) | about 10 ms | about 10 ms |
| Peak memory, `test/basics` | 13.5 MB | 16.7 MB |
| `fib(27)` | 10 to 13 ms | 9 ms |
| Sort 200,000 numbers | 83 ms | 60 ms |
| Create 2,000 keyed rows | 180 ms | 72 ms |
| Update all 2,000 rows, 10 times | 192 ms | 120 ms |
| Reverse 2,000 rows, 10 times | 4.2 s | 2.6 s |
| 100 frames of 2,000 rows (C only) | 107 ms | 106 ms |

The JS half runs 1.3 to 2.5 times faster. It is not more, because svelte's runtime reaches
scriptc as untyped JavaScript, which compiles to checked, dynamic code; scriptc's large gains
are for typed code. Frames are C in both builds and cost the same.

Tests: every test file of this package passes on the scriptc build
(`CUISV_ENGINE=scriptc node test/run.ts`) except `test/npm/npm.test.ts`, which the runner
skips there: it is the dayjs test, marked `// @engine quickjs: why` (see npm packages above).
`test/npm/esm.test.ts` covers a package on both engines.

## The other design: no C templates

The build above keeps cui-svelte's compiler: markup is C, and JS only fills slots. The
alternative was tried as a spike (not in the package): compile a component with Svelte alone
for a plain custom renderer that keeps the tree in JS, and have the compiled JS walk that tree
every frame, calling CUI through the FFI (`cui_column_begin`, `cui_text`, `cui_button`).

It works: the same benchmark component mounts, takes a click and updates.

| 2,000 rows | C templates + slots | JS walks the tree |
|---|---|---|
| Create | 72 ms | 72 ms |
| Update all, 10 times | 120 ms | 79 ms |
| Reverse, 10 times | 2.6 s | 2.7 s |
| 100 frames | 106 ms | 136 ms |

Updates are cheaper (a changed text is a field in JS, not a call into C), and every frame is
dearer, since each node is a call through the FFI and an idle app runs JS on every frame.
What decides against it is the rest: each of the components and their option structs would
need an FFI binding and a JS mapping of props, and styles, records and ids are resolved at
compile time by the existing compiler. The template design gets all of that unchanged.

## Limits of scriptc 0.4.10 that the build works around

These are worth checking again with each scriptc release; a workaround that is no longer
needed should go.

| Limit | Where it is handled |
|---|---|
| No `Proxy` over an array or over an object literal whose shape it knows | `svelte-proxy.js` |
| `symbol in value` and `Object.getPrototypeOf(value)` throw for some native values (a Promise) | `svelte-proxy.js` |
| A dynamic `import()` of a bundled module fails the build with an empty `SC3004` | `scriptc.ts` (static import) |
| A computed (symbol) method name in a class | `src/runtime/host.ts` uses a closure |
| An array literal of numbers stays an array of numbers once the types are erased | `host.ts` builds event lists with `new Array()` |
| `Float32Array.from(list, map)` and `Uint8Array.from(list, map)` | loops in `src/runtime/renderer.ts` and `helpers.ts` |
| A `node:fs` call with an untyped argument gives a result whose members do not compile | `natives.ts` passes `String(path)` |
| esbuild's CommonJS wrappers (`__commonJS`, `__toESM`) fail like the dynamic import | app imports of packages stay external |
