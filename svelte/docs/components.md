# Components

Every CUI component is a Svelte component in `cui-svelte`:

```svelte
<script>
	import { Button, Slider, DataGrid } from 'cui-svelte';
</script>
```

They are compile-time components: each use becomes the C call that draws it, in place. You
cannot pass one around as a value (`const C = Button`). Everything else works: spreading
into your own wrappers, snippets, `{#each}`.

The [component reference](component-reference.md) lists all of them with their props.
CUI's own [component docs](../../docs/components.md) show what each looks like and does.

## Props are CUI's options

A component's props are the parameters and option fields of its C function, named as in C:

```c
cui_slider(ui, "Volume", &volume, 0, 100, .show_value = true, .step = 5);
```

```svelte
<Slider bind:value={volume} min={0} max={100} show_value step={5}>Volume</Slider>
```

| C | Markup |
|---|---|
| `bool` | `show_value` or `show_value={x}` |
| numbers | `step={5}` or `step="5"` |
| strings | `placeholder="Search"` or `placeholder={text}` |
| enums | the member name: `variant="primary"` (`CUI_BUTTON_PRIMARY`), `tone="success"`, `placement="bottom-end"` |
| icons | the icon's name: `icon="trash-2"` (`CUI_ICON_TRASH_2`) |
| `cui_size` | `width={240}`, `"240px"`, `"50%"`, `"fill"`, `"fit"`, `"grow(2)"` |
| `cui_color` | any CSS color, or a theme token: `"accent"`, `"var(--cui-border)"`, `"#7747ff"` |
| `cui_date` | `"2026-11-09"` |
| lists of strings | `items={['Day', 'Week', 'Month']}` |
| lists of numbers | `values={[3, 5, 4]}` (a `Float32Array` too) |
| lists of structs | arrays of objects with the C field names: `series={[{ name: 'Visits', values: [1, 2, 3] }]}` |

Values written as literals are resolved at build time and cost nothing at run time.

## Text children are the label

A component whose first parameter is a label or text takes it from its children:

```svelte
<Button variant="primary">Save {count} files</Button>
<Switch bind:checked={on}>Notifications</Switch>
<Text>Hello, {name}</Text>
```

`label="…"` (or `title="…"`, `text="…"`) works too. Containers (`Column`, `Card`, `Dialog`,
`Menu`…) take any children, including your own components and blocks.

## Binding and events

Wherever CUI writes a value back, `bind:` works:

```svelte
<Switch bind:checked={dark}>Dark</Switch>
<Input bind:value={query} placeholder="Search" />
<Select items={fruit} bind:value={index} />
<DatePicker bind:value={date} />            <!-- "2026-11-09" -->
<ColorPicker bind:value={color} />          <!-- "#7747ff" -->
<MultiSelect items={tags} bind:value={chosen} />  <!-- boolean[] -->
<Gantt bind:tasks />                        <!-- objects updated in place when dragged -->
```

What CUI reports becomes an event prop:

| CUI | Event |
|---|---|
| a button's `true` | `onclick` |
| a bound value changed | `onchange(value)`; `onchange(lo, hi)` when the two values are numbers (a range, an hour and minute, a node's position) |
| text fields' flags | `oninput(text)`, `onsubmit(text)`, `onfocus`, `onblur` |
| an index or -1 (charts, menus, palettes) | `onselect(index)` |
| results (`cui_path_bar_result`, `cui_doc_tabs_result`…) | named events: `onclose(i)`, `onpick(path)`… |

Without `bind:`, a value prop is where the control starts. `<Switch checked={true}>` then
toggles on its own, like an uncontrolled input.

## Identity

CUI keys the state it keeps (focus, scroll offset, hover animations) by id. cui-svelte
gives every component an id from its place in the markup, scoped to its component instance
and `{#each}` item. A label can change while the component keeps its state, and two buttons
called "Edit" never collide.

Give an `id="…"` to find a component from code: `rect_of(id)`, `app.rect(id)` in tests,
or `scroll_to`.

## Components that work differently

### Lists that build only what shows

`VirtualList` and `DataGrid` take a `row` snippet and a `count`. JS renders only the rows CUI
shows, plus 24 on each side (`overscan`):

```svelte
<DataGrid columns={[{ title: 'Name' }, { title: 'Email', width: 220 }]} count={people.length} bind:selected bind:sort>
	{#snippet row(i)}
		<GridCell>{people[i].name}</GridCell>
		<GridCell bind:value={people[i].email} />   <!-- editable -->
	{/snippet}
</DataGrid>

<VirtualList count={100000} row_height={28} height="fill">
	{#snippet row(i)}
		<Text>Row {i}</Text>
	{/snippet}
</VirtualList>
```

`TreeTable` works the same way. Its rows are the nodes CUI shows (`nodes` is the flat tree
CUI expects: `parent`, `first_child`, `next_sibling`, `flags`). The first cell of a row is
`<TreeName icon="folder">{name}</TreeName>`.

### Tables, boards and other structures

These containers take their parts as children:

```svelte
<Table columns={cols} striped>
	{#each rows as r (r.id)}
		<TableRow onclick={() => open(r)}>
			<TableCell>{r.name}</TableCell>
			<TableCell><Badge>{r.status}</Badge></TableCell>
		</TableRow>
	{/each}
</Table>

<Kanban onmove={(m) => move(m.card, m.from_column, m.to_column, m.to_index)}>
	{#each columns as col (col.id)}
		<KanbanColumn title={col.title} count={col.cards.length}>
			{#each col.cards as card (card.id)}
				<KanbanCard id={card.id}><Text>{card.title}</Text></KanbanCard>
			{/each}
		</KanbanColumn>
	{/each}
</Kanban>

<Split bind:ratio>
	<Sidebar />
	<Editor />          <!-- cui_split_next goes between the two -->
</Split>

<Reorder bind:order>
	{#each order as item (item)}
		<ReorderItem><Text>{names[item]}</Text></ReorderItem>
	{/each}
</Reorder>
```

`<Reorder>` rewrites `order` when a row is dropped. To use that order for your own list,
bind a getter and a setter: `bind:order={() => list.map((_, i) => i), (o) => (list = o.map((i) => list[i]))}`.
Write the rows as one keyed `{#each}`, so every row keeps its identity. The dropped row is
then drawn in its new place on the frame you let go, and glides there as in a C app.
`examples/tasks` reorders a filtered list this way.

The node editor is built the same way, from `NodeEditor`, `Node`, `NodeInput`, `NodeOutput`
and `NodeLink`, with `onconnect`, `ondisconnect` and `ondelete` events.

### Overlays

`Dialog`, `Sheet`, `Popover` and `Menu` build their children only while open:

```svelte
<Button onclick={() => (open = true)}>Delete…</Button>
<Dialog title="Delete project?" bind:open description="This cannot be undone.">
	<DialogFooter>
		<Button onclick={() => (open = false)}>Cancel</Button>
		<Button variant="danger" onclick={remove}>Delete</Button>
	</DialogFooter>
</Dialog>
```

`Popover`, `Tooltip` and `ContextMenu` attach to the component just before them, as in CUI.
Any component also takes `tooltip="…"`.

### Logs and terminals

`LogView` and `Terminal` show a buffer you append to from anywhere:

```svelte
<script>
	import { LogView, LogBuffer } from 'cui-svelte';
	const log = new LogBuffer();
	log.info('server started');
</script>

<LogView buffer={log} height={200} />
```

### Canvas

`<Canvas>` paints with a C function or with JS. See [Host APIs](host.md#canvas).
