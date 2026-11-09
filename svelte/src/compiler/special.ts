/**
 * Components whose C does not follow one call or one begin/end pair: table and grid cells,
 * row windows (VirtualList, DataGrid: JS renders only the rows CUI shows), and Popover.
 */
import type { AST } from 'svelte/compiler';
import type { Spec } from './specs.ts';
import {
	c_string,
	each_site,
	edit_room,
	gather,
	js_of,
	new_template,
	src,
	string_val,
	text_of,
	typed_val,
	value_slot,
	walk,
	walk_children,
	warn,
	type CompileContext,
	type Template
} from './template.ts';
import { Records } from './records.ts';

type Emitter = (ctx: CompileContext, t: Template, node: AST.Component, spec: Spec) => void;
type Gathered = ReturnType<typeof gather>;

/** The C id: id="…" when markup gives one, else `fallback`. */
function id_of(t: Template, g: Gathered, fallback: string): string {
	const id = g.props.get('id');
	return id ? string_val(t, id).c : c_string(fallback);
}

/** id="…" on a custom component: registered so JS can find it (rect_of, tests). */
function register_id(t: Template, g: Gathered, id_c: string) {
	if (g.props.get('id')) t.line(`cuisv_name(ui, ${id_c}, ${id_c});`);
}

/** `o.field = value;` for each option field markup set, except the types `skip` leaves out. */
function set_opts(ctx: CompileContext, t: Template, node: AST.Component, spec: Spec, g: Gathered, skip?: (type: string) => boolean) {
	for (const [name, f] of spec.fields) {
		const v = g.props.get(name);
		if (!v || skip?.(f.type)) continue;
		const c = typed_val(ctx, t, f.type, name, v, node);
		if (c) t.line(`o.${name} = ${c.c};`);
	}
}

/** The site of a row window: the row snippet as a template (slot 0 is the row), for each of `rows`. */
function row_site(ctx: CompileContext, t: Template, snippet: AST.SnippetBlock, param: string, rows: string): number {
	const row = new_template(ctx);
	row.slot('n', param);
	walk(ctx, row, snippet.body.nodes);
	return t.site(`{#each ${rows} as ${param} (${param})}${row.element()}{/each}`);
}

const text_only = (nodes: AST.Fragment['nodes']) => nodes.every((n) => n.type === 'Text' || n.type === 'ExpressionTag' || n.type === 'Comment');

/** <TableCell>text</TableCell> or <TableCell><Badge/></TableCell>. */
const table_cell: Emitter = (ctx, t, node) => {
	const kids = node.fragment.nodes;
	if (text_only(kids)) {
		const text = text_of(ctx, kids);
		t.line(`cui_table_cell_text(ui, ${string_val(t, text ?? { kind: 'static', value: '' }).c});`);
		return;
	}
	t.open('{');
	t.line('cui_table_cell(ui);');
	walk_children(ctx, t, kids);
	t.close();
};

/** <GridCell>text</GridCell>, <GridCell bind:value /> (editable), or any children. */
const grid_cell: Emitter = (ctx, t, node) => {
	const g = gather(ctx, node, 'GridCell');
	const kids = node.fragment.nodes;
	const bound = g.binds.get('value');
	if (bound) {
		const slot = t.slot('s', bound.js);
		const setter = t.setter(slot, bound.set);
		t.open('{');
		t.line(`size_t cap; char *buf = cuisv_buf(s, ${slot}, ${edit_room()}, &cap);`);
		t.line(`if (cui_data_grid_cell_edit(ui, buf, cap)) cuisv_buf_changed(s, ${slot}, ${setter});`);
		t.close();
		return;
	}
	if (text_only(kids)) {
		const given = g.props.get('value');
		const text = given ?? text_of(ctx, kids);
		t.line(`cui_data_grid_cell_text(ui, ${string_val(t, text ?? { kind: 'static', value: '' }).c});`);
		return;
	}
	t.open('{');
	t.line('cui_data_grid_cell(ui);');
	walk_children(ctx, t, kids);
	t.close();
};

/**
 * VirtualList and DataGrid: CUI says which rows are in view (first..last); JS renders only
 * those (and some around them) from the `row` snippet, keyed by index, and C builds them in
 * order. A row JS has not rendered yet (scrolled into view this frame) is left blank for a frame.
 */
const row_window: Emitter = (ctx, t, node, spec) => {
	const key = t.key();
	const g = gather(ctx, node, spec.name);
	const snippet = node.fragment.nodes.find((n): n is AST.SnippetBlock => n.type === 'SnippetBlock');
	if (!snippet) {
		warn(ctx, 'row_snippet', `<${node.name}> needs a {#snippet row(i)} that builds one row`, node);
		return;
	}
	const param = snippet.parameters[0] ? src(ctx, snippet.parameters[0]) : 'i';
	if (!/^[A-Za-z_$][\w$]*$/.test(param)) warn(ctx, 'row_snippet', `the row snippet of <${node.name}> takes the row index as a plain name`, snippet);
	const count = g.props.get('count');
	if (!count) warn(ctx, 'row_count', `<${node.name}> needs count={…} (the number of rows)`, node);
	const count_js = count ? js_of(count) : '0';
	const overscan = g.props.get('overscan');
	const overscan_js = overscan ? js_of(overscan) : '24';

	// JS: the window CUI reported, and the rows in it
	const win = `__cuisv_win_${t.id.toString(16)}_${key}`;
	ctx.inject.push(`let ${win} = $state([0, 0]);`);
	const site = row_site(ctx, t, snippet, param, `__cuisv_h.rows(${win}, ${count_js}, ${overscan_js})`);
	const report = t.slot('f', `(a, b) => { ${win} = [a, b]; }`);
	const last_a = t.slot('n', null);
	const last_b = t.slot('n', null);

	const count_raw = count ? (typed_val(ctx, t, 'int', 'count', count, node)?.c ?? '0') : '0';
	const count_c = `((${count_raw}) > 0 ? (${count_raw}) : 0)`;
	t.open(`{ /* <${node.name}> ${key} */`);
	t.line('int first = 0, last = 0;');
	const id_c = id_of(t, g, key);
	register_id(t, g, id_c);
	let row_open: string;
	const post: string[] = [];
	if (spec.name === 'VirtualList') {
		const rh = g.props.get('row_height');
		const rh_c = rh ? (typed_val(ctx, t, 'float', 'row_height', rh, node)?.c ?? '36.0f') : '36.0f';
		const h = g.props.get('height');
		const h_c = h ? (typed_val(ctx, t, 'cui_size', 'height', h, node)?.c ?? 'CUI_FILL') : 'CUI_FILL';
		t.line(`cui_virtual_list_begin(ui, ${id_c}, ${count_c}, ${rh_c}, ${h_c}, &first, &last);`);
		t.open('{');
		// each row is exactly row_height tall, as the list's arithmetic needs
		row_open = `cui_box_begin(ui, &(cui_box){ .height = CUI_PX(${rh_c}), .width = CUI_FILL, .justify = CUI_JUSTIFY_CENTER });`;
	} else {
		// DataGrid: columns and options
		const cols = g.props.get('columns');
		const sd = ctx.records.c_desc('cui_grid_column');
		const cols_slot = t.slot('o', cols ? `__cuisv_h.pack(${js_of(cols)}, ${Records.js_desc('cui_grid_column')})` : null);
		t.line(`const cuisv_records *cols = cuisv_records_get(s, ${cols_slot}, ${sd});`);
		t.line('cui_grid_opts o = {0};');
		set_opts(ctx, t, node, spec, g, (type) => type.endsWith('*'));
		// selection: one bool per row, bind:selected to an array
		const sel = g.binds.get('selected');
		if (sel) {
			const slot = t.slot('o', `__cuisv_h.bools(${sel.js})`);
			const setter = t.setter(slot, `(b) => (${sel.set})(Array.from(b, Boolean))`);
			t.line(`int nsel = ${count_c}; bool *sel = cuisv_bools(s, ${slot}, nsel); bool *sel_was = cuisv_frame_alloc((size_t)(nsel > 0 ? nsel : 1)); memcpy(sel_was, sel, (size_t)nsel); o.selected = sel;`);
			post.push(`if (memcmp(sel, sel_was, (size_t)nsel) != 0) { cuisv_slot_bools(s, ${slot}, sel, nsel); cuisv_emit_bytes(s, ${setter}, sel, (uint32_t)nsel); }`);
		}
		for (const name of ['cursor', 'anchor']) {
			const b = g.binds.get(name) ?? null;
			const v = g.props.get(name);
			if (!b && !v) continue;
			const slot = t.slot('n', b ? b.js : js_of(v!));
			const setter = b ? t.setter(slot, b.set) : -1;
			t.line(`int ${name} = cuisv_int(s, ${slot}), ${name}_was = ${name}; o.${name} = &${name};`);
			post.push(`if (${name} != ${name}_was) { cuisv_set_num(s, ${slot}, ${name});${setter >= 0 ? ` cuisv_emit_num(s, ${setter}, ${name});` : ''} }`);
		}
		const sort = g.binds.get('sort') ?? null;
		const sortv = g.props.get('sort');
		if (sort || sortv) {
			const ssd = ctx.records.c_desc('cui_table_sort');
			const desc = Records.js_desc('cui_table_sort');
			const js = sort ? sort.js : js_of(sortv!);
			const slot = t.slot('o', `__cuisv_h.pack(${js}, ${desc})`);
			const setter = sort ? t.setter(slot, `(b) => (${sort.set})(__cuisv_h.unpack(b, ${desc})[0])`) : -1;
			t.line(`cui_table_sort sort; cuisv_record_read(s, ${slot}, ${ssd}, &sort); cui_table_sort sort_was = sort; o.sort = &sort;`);
			post.push(`if (memcmp(&sort, &sort_was, sizeof sort) != 0) { cuisv_record_write(s, ${slot}, ${setter}, ${ssd}, &sort); }`);
		}
		t.open(`if (cui_data_grid_begin_ex(ui, ${id_c}, (const cui_grid_column *)cols->items, cols->count, ${count_c}, &first, &last, &o)) {`);
		const click = g.events.get('onrowclick');
		row_open = click ? `if (cui_data_grid_row(ui, r)) cuisv_emit_num(s, ${t.slot('f', click)}, r);` : 'cui_data_grid_row(ui, r);';
	}
	t.line(`cuisv_scope *c = s->sites[${site}].first;`);
	t.open('for (int r = first; r < last; r++) {');
	t.line('while (c && cuisv_int(c, 0) < r) c = c->next;');
	t.line(row_open);
	t.line('if (c && cuisv_int(c, 0) == r) cuisv_render_scope(ui, c);');
	if (spec.name === 'VirtualList') t.line('cui_box_end(ui);');
	t.close();
	t.line(`${spec.name === 'VirtualList' ? 'cui_virtual_list_end' : 'cui_data_grid_end'}(ui);`);
	t.close();
	for (const l of post) t.line(l);
	t.line(`if (first != cuisv_int(s, ${last_a}) || last != cuisv_int(s, ${last_b}) || !cuisv_has(s, ${last_a})) { cuisv_set_num(s, ${last_a}, first); cuisv_set_num(s, ${last_b}, last); cuisv_emit_num2(s, ${report}, first, last); }`);
	t.close();
};

/** <Popover bind:open>: CUI owns whether it shows; markup can open and close it too. */
const popover: Emitter = (ctx, t, node, spec) => {
	const key = t.key();
	const g = gather(ctx, node, spec.name);
	const id_c = id_of(t, g, key);
	const bound = g.binds.get('open');
	const given = g.props.get('open');
	const open = t.slot('b', bound ? bound.js : given?.kind === 'expr' ? given.js : given?.kind === 'static' ? String(!!given.value) : null);
	const setter = bound ? t.setter(open, bound.set) : -1;
	const applied = t.slot('b', null);
	t.open(`{ /* <Popover> ${key} */`);
	t.line(`const char *pid = ${id_c};`);
	register_id(t, g, 'pid');
	t.line(`bool want = cuisv_bool(s, ${open});`);
	t.line(`if (want != cuisv_bool(s, ${applied})) { if (want) cui_popover_open(ui, pid); else cui_popover_close(ui, pid); cuisv_set_bool(s, ${applied}, want); }`);
	t.line('cui_popover_opts o = {0};');
	set_opts(ctx, t, node, spec, g);
	t.open('if (cui_popover_begin(ui, pid, &o)) {');
	walk_children(ctx, t, node.fragment.nodes);
	t.line('cui_popover_end(ui);');
	t.close();
	t.line('bool now = cui_popover_is_open(ui, pid);');
	const lines = [`cuisv_set_bool(s, ${open}, now);`, `cuisv_set_bool(s, ${applied}, now);`];
	if (setter >= 0) lines.push(`cuisv_emit_bool(s, ${setter}, now);`);
	const onchange = g.events.get('onchange');
	if (onchange) lines.push(`cuisv_emit_bool(s, ${t.slot('f', onchange)}, now);`);
	t.line(`if (now != want) { ${lines.join(' ')} }`);
	t.close();
};

/**
 * <Canvas paint="c_function" data={[…]} /> or <Canvas onpaint={(g) => …} />, with onclick and
 * onpress(x, y) (pointer held down, relative to the canvas).
 */
const canvas: Emitter = (ctx, t, node, spec) => {
	const key = t.key();
	const g = gather(ctx, node, spec.name);
	const w = g.props.get('width');
	const h = g.props.get('height');
	const w_c = w ? (typed_val(ctx, t, 'cui_size', 'width', w, node)?.c ?? 'CUI_FILL') : 'CUI_FILL';
	const h_c = h ? (typed_val(ctx, t, 'cui_size', 'height', h, node)?.c ?? 'CUI_PX(120.0f)') : 'CUI_PX(120.0f)';
	const paint = g.props.get('paint');
	const onpaint = g.events.get('onpaint');
	let fn = 'NULL';
	if (paint) {
		if (paint.kind !== 'static') warn(ctx, 'canvas_paint', 'paint= names a C function from <script lang="c">, so it is written as text: paint="draw_meter"', node);
		else if (!/^[A-Za-z_]\w*$/.test(String(paint.value))) warn(ctx, 'canvas_paint', `paint= names a C function; ${JSON.stringify(paint.value)} is not a C name`, node);
		else fn = `(cuisv_paint_fn)${String(paint.value)}`;
	}
	const js_slot = onpaint ? t.slot('f', onpaint) : -1;
	if (!paint && !onpaint) warn(ctx, 'canvas_paint', '<Canvas> needs paint="c_function" or onpaint={(g) => …}', node);
	const data = g.props.get('data');
	t.open(`{ /* <Canvas> ${key} */`);
	if (data) {
		const v = typed_val(ctx, t, 'const float *', 'data', data, node);
		if (v?.dynamic) t.line(`int n_data = 0; const float *data = ${v.c.replace('&(int){0}', '&n_data')};`);
		else t.line(`const float *data = ${v?.c ?? 'NULL'}; int n_data = ${data.kind === 'static' && Array.isArray(data.value) ? data.value.length : 0};`);
	} else t.line('const float *data = NULL; int n_data = 0;');
	const id_c = id_of(t, g, `##${key}`);
	register_id(t, g, id_c);
	t.line(`cui_canvas_result r = cuisv_canvas(ui, ${id_c}, ${w_c}, ${h_c}, ${fn}, s, ${js_slot}, data, n_data);`);
	t.line('(void)r;');
	const click = g.events.get('onclick');
	if (click) t.line(`if (r.clicked) cuisv_emit_num2(s, ${t.slot('f', click)}, r.mouse.x, r.mouse.y);`);
	const press = g.events.get('onpress');
	if (press) t.line(`if (r.pressed) cuisv_emit_num2(s, ${t.slot('f', press)}, r.mouse.x, r.mouse.y);`);
	const hover = g.events.get('onhover');
	if (hover) t.line(`if (r.hovered) cuisv_emit_num2(s, ${t.slot('f', hover)}, r.mouse.x, r.mouse.y);`);
	t.close();
};

/** <OtpInput bind:value length={6} oncomplete={(code) => …} /> */
const otp: Emitter = (ctx, t, node, spec) => {
	const key = t.key();
	const g = gather(ctx, node, spec.name);
	const len = g.props.get('length');
	const len_c = len ? (typed_val(ctx, t, 'int', 'length', len, node)?.c ?? '6') : '6';
	const bound = g.binds.get('value');
	const given = g.props.get('value');
	const { slot, setter } = value_slot(t, 's', bound, given);
	const id_c = id_of(t, g, `##${key}`);
	t.open(`{ /* <OtpInput> ${key} */`);
	register_id(t, g, id_c);
	t.line(`int len = ${len_c}; if (len < 1) len = 1; if (len > 32) len = 32; size_t cap; char *buf = cuisv_buf(s, ${slot}, (size_t)len + 1, &cap);`);
	t.line('char was[64]; snprintf(was, sizeof was, "%s", buf);');
	t.line(`bool done = cui_otp_input(ui, ${id_c}, buf, len);`);
	t.line(`if (strcmp(was, buf) != 0) cuisv_buf_changed(s, ${slot}, ${setter});`);
	const complete = g.events.get('oncomplete');
	if (complete) t.line(`if (done) cuisv_emit_str(s, ${t.slot('f', complete)}, buf);`);
	t.close();
};

/**
 * <Reorder bind:order={order}> with a <ReorderItem> per row, in display order. When the rows
 * come from one {#each}, CUI knows each row by its scope (which a keyed each keeps with the
 * row), and the drop is drawn in its new order on the frame it happens, as a C app draws from
 * order[] after cui_reorder_begin; JS gets the new order of its own indices and catches up a
 * frame later with the same picture. Other children keep JS's order until JS answers.
 */
const reorder: Emitter = (ctx, t, node, spec) => {
	const key = t.key();
	const g = gather(ctx, node, spec.name);
	const bound = g.binds.get('order');
	const given = g.props.get('order');
	if (!bound && !given) warn(ctx, 'reorder_order', '<Reorder> needs bind:order={…} (the item indices in display order)', node);
	const slot = t.slot('d', bound ? bound.js : given?.kind === 'expr' ? given.js : null);
	const setter = bound ? t.setter(slot, `(b) => (${bound.set})(Array.from(new Int32Array(b.slice().buffer)))`) : -1;
	const id_c = id_of(t, g, `##${key}`);
	const kids = node.fragment.nodes.filter((n) => !(n.type === 'Text' && !n.data.trim()));
	const each = kids.length === 1 && kids[0].type === 'EachBlock' ? (kids[0] as AST.EachBlock) : null;
	const site = each ? each_site(ctx, t, each) : -1;
	t.open(`{ /* <Reorder> ${key} */`);
	register_id(t, g, id_c);
	t.line(`int n = 0; const float *src = cuisv_floats(s, ${slot}, &n);`);
	t.line('int *order = cuisv_frame_alloc(sizeof(int) * (size_t)(n > 0 ? n : 1));');
	if (each) {
		// one row scope per index: CUI keys rows by scope handle
		t.line(`cuisv_scope **rows = NULL; int m = cuisv_site_scopes(s, ${site}, &rows); bool by_row = m == n && n > 0;`);
		t.line('for (int k = 0; k < n; k++) order[k] = by_row ? (int)rows[k]->handle : (int)src[k];');
	} else {
		t.line('for (int k = 0; k < n; k++) order[k] = (int)src[k];');
	}
	t.line(`cui_reorder_begin(ui, ${id_c}, order, n);`);
	t.line('cuisv_reorder_push();');
	if (each) t.line(`if (by_row) cuisv_reorder_rows(ui, rows, n, order); else cuisv_render_site(ui, s, ${site});`);
	else walk_children(ctx, t, node.fragment.nodes);
	t.line('cuisv_reorder_pop();');
	t.open('if (cui_reorder_end(ui)) {');
	t.line('float *f = cuisv_frame_alloc(sizeof(float) * (size_t)(n > 0 ? n : 1));');
	if (each) t.line('if (by_row) cuisv_reorder_back(rows, n, src, order, f); else for (int k = 0; k < n; k++) f[k] = (float)order[k];');
	else t.line('for (int k = 0; k < n; k++) f[k] = (float)order[k];');
	// rows keyed by scope wait for JS to move them; otherwise C keeps the new order until JS answers
	t.line(`${each ? 'if (!by_row) ' : ''}cuisv_slot_floats_set(s, ${slot}, f, n);`);
	if (setter >= 0) {
		t.line('int *js = cuisv_frame_alloc(sizeof(int) * (size_t)(n > 0 ? n : 1)); for (int k = 0; k < n; k++) js[k] = (int)f[k];');
		t.line(`cuisv_emit_bytes(s, ${setter}, js, (uint32_t)(sizeof(int) * (size_t)n));`);
	}
	const onchange = g.events.get('onchange');
	if (onchange) t.line(`cuisv_emit(s, ${t.slot('f', onchange)});`);
	t.close();
	t.close();
};

/**
 * <TreeTable columns nodes bind:nodes>{#snippet row(n)}<TreeName …/><GridCell …/>{/snippet}</TreeTable>:
 * CUI walks the open part of the tree and says which nodes are in view; JS renders those rows.
 */
const tree_table: Emitter = (ctx, t, node, spec) => {
	const key = t.key();
	const g = gather(ctx, node, spec.name);
	const snippet = node.fragment.nodes.find((n): n is AST.SnippetBlock => n.type === 'SnippetBlock');
	if (!snippet) {
		warn(ctx, 'row_snippet', '<TreeTable> needs a {#snippet row(node)} that builds one row (TreeName, then GridCells)', node);
		return;
	}
	const param = snippet.parameters[0] ? src(ctx, snippet.parameters[0]) : 'n';
	const shown = `__cuisv_nodes_${t.id.toString(16)}_${key}`;
	ctx.inject.push(`let ${shown} = $state([]);`);
	const site = row_site(ctx, t, snippet, param, `__cuisv_h.node_rows(${shown})`);
	const report = t.slot('f', `(b) => { ${shown} = Array.from(new Int32Array(b.slice().buffer)); }`);
	const last = t.slot('o', null);
	// columns and nodes
	const cols = g.props.get('columns');
	const cd = ctx.records.c_desc('cui_grid_column');
	const cols_slot = t.slot('o', cols ? `__cuisv_h.pack(${js_of(cols)}, ${Records.js_desc('cui_grid_column')})` : null);
	const nd = ctx.records.c_desc('cui_tree_node');
	const ndesc = Records.js_desc('cui_tree_node');
	const nb = g.binds.get('nodes');
	const nv = g.props.get('nodes');
	const nodes_slot = t.slot('o', nb ? `__cuisv_h.pack(${nb.js}, ${ndesc})` : nv?.kind === 'expr' ? `__cuisv_h.pack(${nv.js}, ${ndesc})` : null);
	const nodes_setter = nb ? t.setter(nodes_slot, `(b) => __cuisv_h.merge(${nb.js}, __cuisv_h.unpack(b, ${ndesc}), ${nb.set})`) : -1;
	const id_c = id_of(t, g, `##${key}`);
	t.open(`{ /* <TreeTable> ${key} */`);
	register_id(t, g, id_c);
	t.line(`const cuisv_records *cols = cuisv_records_get(s, ${cols_slot}, ${cd});`);
	t.line(`const cuisv_records *nodes = cuisv_records_get(s, ${nodes_slot}, ${nd});`);
	t.line('size_t nodes_sz = sizeof(cui_tree_node) * (size_t)nodes->count;');
	t.line('void *nodes_was = cuisv_frame_alloc(nodes_sz ? nodes_sz : 1); memcpy(nodes_was, nodes->items, nodes_sz);');
	t.line('cui_tree_table_opts o = {0};');
	set_opts(ctx, t, node, spec, g, (type) => type.endsWith('*') || type.startsWith('fnptr'));
	const cur = g.binds.get('cursor');
	let cur_slot = -1;
	let cur_setter = -1;
	if (cur) {
		cur_slot = t.slot('n', cur.js);
		cur_setter = t.setter(cur_slot, cur.set);
		t.line(`int cursor = cuisv_int(s, ${cur_slot}), cursor_was = cursor; o.cursor = &cursor;`);
	}
	t.line(`cui_tree_table_begin_ex(ui, ${id_c}, (const cui_grid_column *)cols->items, cols->count, (cui_tree_node *)nodes->items, nodes->count, &o);`);
	t.line('int *vis = cuisv_frame_alloc(sizeof(int) * (size_t)(nodes->count > 0 ? nodes->count : 1)); int seen = 0;');
	t.line(`cuisv_scope *c = s->sites[${site}].first;`);
	t.open('for (int n; (n = cui_tree_table_row(ui)) >= 0;) {');
	t.line('if (seen < nodes->count) vis[seen++] = n;');
	t.line(`if (!c || cuisv_int(c, 0) != n) { c = s->sites[${site}].first; while (c && cuisv_int(c, 0) != n) c = c->next; }`);
	t.line('if (c) { cuisv_render_scope(ui, c); c = c->next; } else cui_tree_table_name(ui, "", NULL);');
	t.close();
	t.line('cui_tree_table_events ev = cui_tree_table_end(ui);');
	t.line('(void)ev;');
	// the rows in view, when they changed
	t.line(`{ uint32_t len = 0; const uint8_t *prev = cuisv_slot(s, ${last})->kind == CUISV_BLOB ? cuisv_slot(s, ${last})->u.blob.p : NULL; if (prev) len = cuisv_slot(s, ${last})->u.blob.len;`);
	t.line(`  if (len != sizeof(int) * (uint32_t)seen || (seen && memcmp(prev, vis, len) != 0)) { cuisv_slot_blob(s, ${last}, (const uint8_t *)vis, sizeof(int) * (uint32_t)seen); cuisv_emit_bytes(s, ${report}, vis, sizeof(int) * (uint32_t)seen); } }`);
	t.line(`if (memcmp(nodes_was, nodes->items, nodes_sz) != 0) { cuisv_records_store(s, ${nodes_slot}, ${nd}, nodes->items, nodes->count);${nodes_setter >= 0 ? ` cuisv_emit_records(s, ${nodes_setter}, ${nd}, nodes->items, nodes->count);` : ''} }`);
	if (cur) t.line(`if (cursor != cursor_was) { cuisv_set_num(s, ${cur_slot}, cursor); cuisv_emit_num(s, ${cur_setter}, cursor); }`);
	const evs: [string, string, string | null][] = [
		['onactivate', 'ev.activated >= 0', 'ev.activated'],
		['onexpand', 'ev.expanded >= 0', 'ev.expanded'],
		['oncollapse', 'ev.collapsed >= 0', 'ev.collapsed'],
		['onselectionchange', 'ev.selection_changed', null],
		['onsort', 'ev.sort_changed', null]
	];
	for (const [name, when, payload] of evs) {
		const js = g.events.get(name);
		if (!js) continue;
		const fs = t.slot('f', js);
		t.line(payload ? `if (${when}) cuisv_emit_num(s, ${fs}, ${payload});` : `if (${when}) cuisv_emit(s, ${fs});`);
	}
	const load = g.events.get('onload');
	if (load) t.line(`for (int k = 0; k < ev.load_count; k++) cuisv_emit_num(s, ${t.slot('f', load)}, ev.load[k]);`);
	t.close();
};

export const SPECIAL: Record<string, Emitter> = { table_cell, grid_cell, row_window, popover, canvas, otp, reorder, tree_table };
