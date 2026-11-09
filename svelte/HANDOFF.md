# HANDOFF: cui-svelte

> **Status (2026-11-09): finished.**
>
> - All 11 review issues are fixed: the "done, untested" ones are now verified, and the
>   "not done yet" ones are implemented.
> - All checks are green: tests, tsc, svelte-check, both gallery builds, headless Chrome and
>   an ASAN/UBSan harness.
> - The changes are described in `docs/architecture.md` and in memory. Nothing below is
>   still open.
> - This file can be deleted.

What exists, what's half done, and what to do next. Delete this file once you've taken over.

## The goal

The user set this goal for the whole effort:

- **The package:** `CUI/svelte/` is a Svelte custom renderer for CUI. Each component compiles
  to C that calls CUI.
- **The JS side:** `<script>`, runes and npm packages run in embedded QuickJS-ng. JS and C
  talk both ways.
- **Coverage:** expose all of CUI's components, and support `<style>` mapped to what CUI can
  draw.
- **Reference:** `../gpuix-svelte` is the reference custom renderer, and the vendored Svelte
  build comes from the same place.

The API and DX decisions were agreed with the user before building. They are in memory
(`~/.claude/projects/-Users-k-Documents-GitHub-CUI/memory/cui-svelte-decisions.md`):

- **Tags:** PascalCase imports from `cui-svelte`, plus HTML elements styled by CSS.
- **Props:** snake_case, as in C.
- **Dev loop:** script edits hot-reload; markup edits relaunch.
- **Entry:** `main.ts` with `run()`.
- **Browser target:** a WASM build that reuses CUI's web host.
- **Unsupported CSS:** a warning, and the declaration is dropped.
- **Host APIs:** app/window, files plus localStorage, and a native C bridge
  (`<script lang="c">`).

The goal is essentially met. What remains is hardening (the review fixes below) and a final
pass.

## Current state

All of this was green before the review fixes were started.

- **Tests:** `node test/run.ts` passed all 11 test files (`test/**` plus `examples/**`).
- **Types:** `npx tsc --noEmit` reported 0 errors, and
  `npx svelte-check --tsconfig ./tsconfig.json --threshold error` reported 0 errors and
  0 warnings.
- **Builds:** native (`node bin/cui-svelte.js build examples/gallery/main.ts`, 2.2 MB) and web
  (`... --web`, 575 KB wasm) both built.
- **In a browser:** the web build was checked in headless Chrome over CDP. Clicks and typing
  work, with no console errors. The driver was a scratch script, not in the repo.
- **Coverage:** 237 components; `docs/component-reference.md` is generated from them.
- **Docs:** README.md, plus `docs/` (guide, components, styling, host, testing, web,
  architecture). architecture.md is the internals doc. `CLAUDE.md` is gitignored repo-wide in
  CUI, so it isn't used.

Nothing is committed: `svelte/` is untracked, and nothing outside `svelte/` was changed. Ask
the user before committing.

## In progress: fixes from a C runtime review

An independent review found 11 issues. Its ASAN/handle harnesses are in
`/private/tmp/claude-501/-Users-k-Documents-GitHub-CUI/5d2e477f-bbbb-4a00-b4e6-b8a4ce03d937/scratchpad/h`
(scratch, may be gone).

**The edits below were made but NOT yet compiled or tested.** First run
`node test/run.ts && npx tsc --noEmit && npx svelte-check --tsconfig ./tsconfig.json --threshold error`
and fix what breaks.

### Done, untested

1. **Shared counts** (`runtime/cuisv_records.c`). Arrays that share a count field (scatter
   points and sizes) now set it to the shortest one present. `read_struct` tracks this with
   `offs`/`mins`; the old `set_count` was removed.
2. **Reader bounds** (`cuisv_records.c`).
   - `room_for()` checks the wire size before arena allocations.
   - Loops stop on `r->bad`.
   - The record count is guarded against `SIZE_MAX`.
   - I64 and texture conversions are guarded.
3. **`cuisv_w_strs`** (`runtime/cuisv_web.c`) clamps `n`, checks lengths against what is
   left, and checks its allocations.
4. **`cuisv_int`** saturates, and NaN becomes 0 (`cuisv_to_int` in `runtime/cuisv.h`).
   - `cuisv_size_num` and `cuisv_color` are guarded too.
   - `src/compiler/special.ts` clamps row counts to ≥ 0 and the OtpInput length to 1..32.
7. **Dates** are validated in the records reader (`valid_date`): month 1..12, day 1..31,
   year 1..9999, otherwise zero.
5. **Shutdown** (`runtime/cuisv_js.c`).
   - It loops: clear timers, run jobs, until both stay empty.
   - It frees the module object when `JS_ResolveModule` fails.
   - The timers realloc is checked.
   - `blob` clears the pending exception for values that aren't buffers.
   - The `strs` and `floats` allocations are checked.
10. **Timeouts** are clamped to `INT32_MAX` ms, so `setTimeout(fn, Infinity)` no longer spins.
9. **`resize` and `toast_action` hooks.** `cuisv_app_frame` now returns `bool` and calls the
   new `cuisv_js_settle()` (declared in `cuisv_js.h`). `cuisv_host.c` uses the return value.

### Not done yet

- **#6 `fs_read` on a directory crashes on Linux** (`runtime/cuisv_app.c`, `slurp`). Use
  `fstat` and require a regular file, and check `malloc`.
- **#8 handle generations are only 12 bits, and freed indices are reused LIFO**
  (`runtime/cuisv.c`, `table_add` / `cuisv_scope_free`). Use a FIFO free list, and only reuse
  an index once there are about 4096 free ones.
- **#11 Windows UTF-8 paths.**
  - Use `_wfopen`, `_wstat`, `_wremove`, `_wmkdir` and `_wgetenv` with
    `MultiByteToWideChar`, in `cuisv_app.c` (`fs_*`, `data_dir`, `home_dir`).
  - This can't be tested on this Mac.
- **Minor issues:**
  - `fs_mkdir("")` reads past the string.
  - Allocations are unchecked in `cuisv_buffer_new` and the image cache
    (`runtime/cuisv_services.c`).
  - `scroll_to` on an element that isn't a scroll area corrupts that widget's state.
    `cuisv_scroll_to` in `runtime/cuisv_cui.c` should check that a node with this id has the
    `CUI_NF_SCROLL_X`/`CUI_NF_SCROLL_Y` flags.
  - The text style stack in `cuisv.c` breaks when full. When full, push should duplicate the
    top instead of reading `text_stack[127]` unwritten, and `cuisv_frame_reset` should reset
    `text_depth`.
  - `points_arg` (draw natives in `cuisv_app.c`) and `fs_write` can leave a pending QuickJS
    exception. Clear it with `JS_FreeValue(c, JS_GetException(c))`.
  - Speculative: `test_frame` could be re-entered from a timer.

## Where things are

`docs/architecture.md` is the map. In short:

- **`src/compiler/`.**
  - `index.ts` compiles a component.
  - `template.ts` turns markup into C plus the skeleton.
  - `specs.ts` is the component table and role inference; `special.ts` holds the custom
    emitters (DataGrid, VirtualList, TreeTable, Popover, Canvas, Reorder, OtpInput, cells).
  - `html.ts` maps HTML elements.
  - `styles.ts`, `css-props.ts`, `apply.ts` and `inline.ts` handle CSS.
  - `records.ts` generates the struct descriptors; `native.ts` handles `<script lang="c">` and
    `.svelte.c` files.
- **`runtime/` (C).**
  - `cuisv.c` holds scopes, slots and events; `cuisv_records.c` the struct codec;
    `cuisv_services.c` canvas, images and buffers; `cuisv_cui.c` the code that uses CUI's
    internals.
  - `cuisv_js.c` is the QuickJS host and `cuisv_app.c` the host natives.
  - `cuisv_host.c` runs a frame. Events dispatch at the START of the next frame, after CUI has
    painted.
  - `cuisv_main.c` is the window `main`, `cuisv_test_main.c` the headless `main`, and
    `cuisv_web.c` the wasm host.
- **`src/runtime/` (JS).** `renderer.ts`, `index.ts` (`run`), `host.ts` (host APIs, `on_key`,
  `rect_of`), `helpers.ts`, `globals.ts` (polyfills), `painter.ts`, `test.ts`.
- **`src/web/`.** The browser bridge and frame loop.
- **`src/cli/`.** `main`, `bundle` (esbuild), `native` (one shared CMake tree in
  `~/Library/Caches/cui-svelte/<hash>/`), `web`, `create`.
- **Generated files.** Regenerate with `npm run api`: `cui-api.json`, `src/runtime/tables.ts`,
  `src/runtime/components.ts` and `docs/component-reference.md`.

## Gotchas

These are also in memory (`cui-svelte-architecture.md`).

- **Svelte's reserved names.** Identifiers starting with `$$` are reserved by Svelte; use
  `__cuisv_*`.
- **Mount and QuickJS.** `mount()` needs `{ renderer }`. QuickJS defines its own `js_free`.
- **Paint-time data.** CUI paints at `end_frame`. Data handed to CUI must outlive the template
  call: use file-scope statics, slots or the frame arena, never compound literals.
- **Labels and ids.**
  - Some labels are display-only: `DISPLAY_LABELS` in `specs.ts`, found by `test/labels`.
  - Some ids are drawn as captions, so generated ids use `"##key"`.
- **Node and installed copies.** Node won't strip TypeScript under `node_modules`.
  `bin/cui-svelte.js` installs a load hook, and `svelte-config` is plain JS.
- **svelte-check** can't read `<script lang="c">`; use `Component.svelte.c`. `test/inline-c`
  is excluded from svelte-check for this reason.
- **Gitignore.** CUI's `.gitignore` ignores `build*/` repo-wide, so no directory may be named
  `build…`.
- **The web build** needs `wasm-ld`. The previous session installed it with
  `brew install lld`.

## After the fixes

1. Run the full checks: tests, tsc, svelte-check, and both gallery builds.
2. Optionally re-run the web check in headless Chrome. Serve `examples/gallery/dist-web` and
   drive it over CDP with Node's built-in WebSocket on Chrome's
   `--remote-debugging-port`.
3. Update memory if the architecture changed.
4. Give the user a final summary:
   - what was built;
   - the decisions;
   - what is unsupported: `TimelineEditor`, `AvatarUpload`, the path bar's segment menus,
     and `fetch`;
   - the browser build's gaps: no fs, dialogs or images from disk, and string natives are
     native only;
   - that nothing is committed.
