# Architecture

How cui-svelte turns a `.svelte` file into a native app, for contributors.

## The split

Each component is compiled twice from one parse (`src/compiler/index.ts`).

**C (`template.ts`).**
- The markup is walked once. Every *template* becomes a C function
  `void cuisv_t_<id>(cui_ctx *ui, cuisv_scope *s)`. A template is the component root, each
  block branch, each `{#each}` body or each snippet body.
- CUI components (`specs.ts`, `special.ts`) and HTML elements (`html.ts`) emit their CUI
  calls in place, inside the C scopes of their parents.
- Anything known at build time is a C literal: static props, text, enums, icons, sizes,
  colors, resolved CSS.
- Anything dynamic is a **slot** of the scope: `cuisv_str(s, 3)`, `cuisv_bool(s, 5)`.
- Template ids are `fnv1a32("<path>#<index>")`.

**JS (the skeleton).**
- The original `<script>` blocks and a skeleton of the markup go through the real Svelte
  compiler with `experimental.customRenderer: 'cui-svelte/renderer'`.
- The skeleton keeps only the blocks, components and dynamic expressions:

```svelte
<t742576998 s3={`Clicked ${__cuisv_h.t(clicks)} times`} f2={() => clicks++} b0={notifications} g1v0={(v) => { notifications = v; }}>
	<s0>{#if clicks > 3}<t759354617></t759354617>{/if}</s0>
	<s1>{#each items as item, i (item)}<t709021760 s0={…}></t709021760>{/each}</s1>
</t742576998>
```

- `<t…>` is a template instance. `<s…>` is a *site*: where child scopes go in C (a block,
  a component, `{@render}`).
- Attribute names carry the slot's kind and index:
  - `n` number, `s` string, `b` boolean, `a` string array, `d` number array, `o` packed
    records;
  - `f` function;
  - `g<i>v<j>` the setter for the value bound in slot `j`.
- Everything Svelte does (runes, keyed each, snippets, components, `$bindable`, context,
  `{#await}`, boundaries) runs unchanged.

## Runtime (C, `runtime/`)

- **`cuisv.c`** holds scopes, slots, sites, events, the frame arena, inherited text style
  and the id registry.
  - A scope is addressed from JS by a handle: a 20-bit index plus a 12-bit generation.
    Freed indices wait in a FIFO and come back only once about 4096 are free. So a stale
    handle from JS would have to outlive about 16 million scope frees before it could match
    a new scope.
  - A site is an ordered list of child scopes.
  - `cuisv_render_site` walks it and calls each child's template, under `cui_push_id_int(handle)`.
    That push is how CUI identity stays unique and stable per instance.
- **`cuisv_records.c`** packs and unpacks arrays of C structs. It works from descriptors
  the compiler emits with `offsetof`.
- **`cuisv_services.c`** has the parts with no JS engine in them: canvas, the image cache,
  and log/terminal buffers.
- **`cuisv_cui.c`** uses CUI's internals: pointer state for plain boxes (`cui__interact`),
  the clipboard, `scroll_to`.
  - After each frame it notes which nodes scroll. `scroll_to` writes a scroll state, and
    only does so for those ids, since under any other id the state belongs to another
    widget.
- **`cuisv_js.c`** is the QuickJS host: the `__cuisv` bridge functions, timers, microtasks,
  and calls into JS hooks.
- **`cuisv_app.c`** has the host natives: window, theme, dialogs, toasts, files, drawing.
  - Paths, the environment and `argv` are UTF-8 everywhere. On Windows they go through the
    wide APIs (`cuisv_fopen`, `cuisv_stat`, `cuisv_getenv`).
  - A string argument that cannot convert makes a native throw. Numbers and options fall
    back to defaults, and the exception that raised is dropped. Either way no exception is
    left pending for a later call to find.
- **`cuisv_host.c`** runs one frame (below), loads the bundle and handles hot reload.
- **`cuisv_main.c`** is the windowed `main`.
- **`cuisv_test_main.c`** is the headless `main` used by `cui-svelte test`.
- **`cuisv_web.c`** is the browser build's host, on top of CUI's `web/host/web_host.c`.

### A frame

```
cuisv_host_frame:
    events from the previous frame -> JS (hooks.dispatch, flushSync, commit)
    JS timers, requestAnimationFrame callbacks, microtasks
    toast actions, a changed window size
    templates: cuisv_render_scope(root)        <- reads slots, queues events
    keys pressed (for on_key)
cui_end_frame: layout and paint
```

Events go to JS at the *start* of the next frame, after CUI has painted. JS may free a slot
string that a node of the painted frame still points at; at that point the frame is done
with it. Anything else CUI reads at paint time comes from file-scope statics, the frame
arena or slots, never from a template's stack.

When an event updates a bound value, the setter runs, then `flushSync()`, and the slot is
pushed again, so a setter that rejects the value puts the control back.

### The JS renderer (`src/runtime/renderer.ts`)

- Keeps the skeleton tree Svelte builds.
- Creates C scopes lazily: only when a `<t…>` element becomes reachable from the root.
- Frees scopes in `commit()` once they have stayed out of the tree, because Svelte removes
  and re-inserts nodes in consecutive steps.
- Pushes attribute values to slots.
- Dispatches events by looking up the function in the scope's attributes.

## Styling (`styles.ts`, `css-props.ts`, `apply.ts`, `inline.ts`)

1. **Rules.** Each rule's selectors are parsed into compound parts.
2. **Matching.** For each element, the rules are matched against its info: tag, classes
   with their conditions, ancestors (`ctx.ancestors`). Matching produces a condition tree:
   - `true`;
   - a JS condition, which becomes a boolean slot of the current template;
   - a C condition (pointer state such as `pt_k3.hovered`, or `cuisv_dark(ui)`);
   - and/or combinations of these.
3. **Cascade.** Matched rules are cascaded and expanded into *facets*: `pad_top`, `bg`,
   `text_color`, `size_w`, and so on.
4. **Assignment.** `apply.ts` assigns each facet to the first field of the target's
   options struct that can hold it, conditionally where needed.
5. **Text.** Text facets become a `cuisv_text_style` pushed for descendants.

`:root` rules become theme assignments at the top of the component's root template.

## Components (`specs.ts`)

The component table names each component and its C source (a macro from `cui.h`, or a
function). Everything else is inferred from the prototype in `cui-api.json`, which
`scripts/extract-api.ts` generates from `cui.h`: parameter roles, events, option fields.

| C parameter | Role |
|---|---|
| `const char *id` | an identity from the element's place (`"##k3"`) |
| `const char *label` | a label, with `###key` identity |
| `T *` scalar | `bind` |
| `char *, size_t` | a text buffer |
| `const char *const *, int` | `strs` |
| `const float *, int` | `floats` |
| `const T *, int` | `records` |
| `T *, int` | `records_mut` |
| `T *` struct | `bind_struct` |
| `bool *` after a list | `bind_bools` |

There are a few more roles. Overrides in the table fix what inference cannot know: prop
names, event names, defaults, begin/end pairs, and display-only labels (`DISPLAY_LABELS`,
found by `test/labels`).

Components whose C is not one call or one begin/end pair have emitters in `special.ts`:
`VirtualList`, `DataGrid`, `TreeTable`, `Popover`, `Canvas`, `Reorder`, `OtpInput` and the
table and grid cells.

After changing the table:

```sh
npm run api                          # cui-api.json, tables.ts, components.ts (types)
node scripts/gen-docs.ts             # docs/component-reference.md
npm test && npm run typecheck
```

## Builds (`src/cli/`)

**`bundle.ts`.**
- esbuild, with a plugin that compiles `.svelte` (and collects the C) and `.svelte.ts`
  rune modules.
- `svelte` and `cui-svelte` always resolve to this package's copies; Svelte comes from
  `vendor/`.

**`native.ts`.**
- Writes `.cui-svelte/<mode>/gen/*.c`, `registry.c` and `bundle.c`, plus a `CMakeLists.txt`
  with the app's targets.
- All apps build inside one CMake tree per configuration in the user's cache folder, which
  also builds CUI, QuickJS and the runtime once.
- A configure that failed leaves no marker, so the next build configures again.

**`web.ts`.** clang `--target=wasm32` with CUI's shim, shared objects cached, then
`wasm-ld`.

**`main.ts`.** The CLI. `dev` decides between hot reload (the C did not change) and a
relaunch.

## Svelte

`vendor/svelte-<version>-<sha>.tgz` is a build of the custom renderer PR
([#18511](https://github.com/sveltejs/svelte/pull/18511)). `npm run vendor` moves it to the
PR's current head; then run the tests and the typecheck.
