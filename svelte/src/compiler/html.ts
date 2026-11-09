/**
 * HTML elements in CUI. Block elements (div, section, ul…) are boxes laid out like the
 * browser would (a column, a row when every child is inline, flex and grid from CSS); text
 * elements (p, span, h1…) are text; buttons, links and anything with onclick are clickable
 * boxes; form elements are CUI's controls, since a text field cannot be drawn from boxes.
 * Their look comes from <style>, so the same component runs in a browser unchanged.
 */
import type { AST } from 'svelte/compiler';
import {
	attr_source,
	c_comment,
	c_string,
	edit_room,
	init_str,
	js_of,
	label_part,
	setter_of,
	src,
	string_val,
	text_of,
	typed_val,
	value_slot,
	walk,
	warn,
	type Bound,
	type CompileContext,
	type Source,
	type Template
} from './template.ts';
import { bind_pointer, cond_c, type ElementInfo, type ElementStyle, type Layer } from './styles.ts';
import { apply_fields, box_dir, display_none, has_facet, margins, text_style, facet_c } from './apply.ts';
import { inline_layer } from './inline.ts';
import type { Facet } from './css-props.ts';
import { fields_of } from './api.ts';
import { parse_color } from '../shared/values.ts';

type Node = AST.Fragment['nodes'][number];

export interface HtmlSpec {
	kind: 'block' | 'text' | 'control' | 'void';
	/** Lays out inline (a span inside a p), for the browser's inline-in-block rule. */
	inline?: boolean;
	defaults?: Facet[];
}

const num = (value: number) => ({ kind: 'num' as const, value });
const color = (c: string) => ({ kind: 'color' as const, color: parse_color(c)! });
const f = (name: string, value: Facet['value']): Facet => ({ name, value });

const BLOCK: HtmlSpec = { kind: 'block' };
const INLINE_TEXT: HtmlSpec = { kind: 'text', inline: true };
const heading = (size: number, display = false): HtmlSpec => ({
	kind: 'text',
	defaults: [f('text_size', num(size)), f('text_weight', num(600)), ...(display ? [f('text_font', { kind: 'enum', value: 'display' } as const)] : [])]
});

export const HTML: Record<string, HtmlSpec> = {
	div: BLOCK,
	section: BLOCK,
	article: BLOCK,
	aside: BLOCK,
	header: BLOCK,
	footer: BLOCK,
	main: BLOCK,
	nav: BLOCK,
	form: BLOCK,
	fieldset: BLOCK,
	figure: BLOCK,
	details: BLOCK,
	summary: BLOCK,
	blockquote: { kind: 'block', defaults: [f('pad_left', num(16)), f('text_color', color('text-secondary'))] },
	ul: { kind: 'block', defaults: [f('pad_left', num(4)), f('gap', num(4))] },
	ol: { kind: 'block', defaults: [f('pad_left', num(4)), f('gap', num(4))] },
	li: { kind: 'block', defaults: [f('display_flex', { kind: 'bool', value: true }), f('gap', num(8)), f('align', { kind: 'enum', value: 'start' })] },
	table: { kind: 'block' },
	thead: BLOCK,
	tbody: BLOCK,
	tfoot: BLOCK,
	tr: { kind: 'block', defaults: [f('display_flex', { kind: 'bool', value: true }), f('gap', num(12))] },
	td: { kind: 'block', defaults: [f('grow', num(1)), f('pad_top', num(4)), f('pad_bottom', num(4))] },
	th: { kind: 'block', defaults: [f('grow', num(1)), f('pad_top', num(4)), f('pad_bottom', num(4)), f('text_weight', num(600))] },
	p: { kind: 'text' },
	span: INLINE_TEXT,
	label: INLINE_TEXT,
	strong: { kind: 'text', inline: true, defaults: [f('text_weight', num(700))] },
	b: { kind: 'text', inline: true, defaults: [f('text_weight', num(700))] },
	em: INLINE_TEXT,
	i: INLINE_TEXT,
	u: INLINE_TEXT,
	s: INLINE_TEXT,
	mark: { kind: 'text', inline: true, defaults: [f('bg', color('#fde68a'))] },
	small: { kind: 'text', inline: true, defaults: [f('text_size', num(11))] },
	time: INLINE_TEXT,
	abbr: INLINE_TEXT,
	cite: INLINE_TEXT,
	q: INLINE_TEXT,
	sub: INLINE_TEXT,
	sup: INLINE_TEXT,
	code: { kind: 'text', inline: true, defaults: [f('text_font', { kind: 'enum', value: 'mono' })] },
	kbd: { kind: 'text', inline: true, defaults: [f('text_font', { kind: 'enum', value: 'mono' })] },
	samp: { kind: 'text', inline: true, defaults: [f('text_font', { kind: 'enum', value: 'mono' })] },
	pre: { kind: 'text', defaults: [f('text_font', { kind: 'enum', value: 'mono' })] },
	h1: heading(36, true),
	h2: heading(28, true),
	h3: heading(22),
	h4: heading(17),
	h5: heading(15),
	h6: heading(13),
	a: { kind: 'text', inline: true, defaults: [f('text_color', color('accent'))] },
	button: {
		kind: 'block',
		inline: true,
		defaults: [
			f('display_flex', { kind: 'bool', value: true }),
			f('align', { kind: 'enum', value: 'center' }),
			f('justify', { kind: 'enum', value: 'center' }),
			f('gap', num(6)),
			f('pad_top', num(6)),
			f('pad_bottom', num(6)),
			f('pad_left', num(12)),
			f('pad_right', num(12)),
			f('radius_tl', num(8)),
			f('radius_tr', num(8)),
			f('radius_br', num(8)),
			f('radius_bl', num(8)),
			f('border', num(1)),
			f('border_color', color('border')),
			f('bg', color('surface'))
		]
	},
	input: { kind: 'control', inline: true },
	textarea: { kind: 'control', inline: true },
	select: { kind: 'control', inline: true },
	img: { kind: 'control', inline: true },
	progress: { kind: 'control' },
	meter: { kind: 'control' },
	hr: { kind: 'void' },
	br: { kind: 'void', inline: true }
};

const BOX_FIELDS = fields_of('cui_box');

function attr(node: AST.RegularElement, name: string): AST.Attribute | undefined {
	return node.attributes.find((a): a is AST.Attribute => a.type === 'Attribute' && a.name === name);
}

function event(ctx: CompileContext, node: AST.RegularElement, name: string): string | null {
	const a = attr(node, name);
	if (!a) return null;
	const s = attr_source(ctx, a);
	return s.kind === 'expr' ? s.js : null;
}

function bind(ctx: CompileContext, node: AST.RegularElement, name: string): Bound | null {
	const b = node.attributes.find((a): a is AST.BindDirective => a.type === 'BindDirective' && a.name === name);
	return b ? setter_of(ctx, b.expression) : null;
}

/**
 * Whether a boolean attribute (checked, hidden) with a value known now is on: written as text
 * (`checked`, `checked=""`) it is, like the browser's; as a {value}, when the value is truthy,
 * like Svelte sets the property (`checked={null}` is off).
 */
function attr_on(value: unknown): boolean {
	return typeof value === 'string' || !!value;
}

function is_blank(n: Node) {
	return (n.type === 'Text' && !n.data.trim()) || n.type === 'Comment';
}

/** Whether every child would be inline in a browser (so they flow in a row). */
function all_inline(nodes: Node[]): boolean {
	let any = false;
	for (const n of nodes) {
		if (is_blank(n)) continue;
		if (n.type === 'Text' || n.type === 'ExpressionTag') {
			any = true;
			continue;
		}
		if (n.type === 'RegularElement') {
			const h = HTML[n.name];
			if (!h?.inline) return false;
			any = true;
			continue;
		}
		return false;
	}
	return any;
}

function has_elements(nodes: Node[]): boolean {
	return nodes.some((n) => !(n.type === 'Text' || n.type === 'ExpressionTag' || n.type === 'Comment'));
}

/** Style of an HTML element: tag defaults under the cascade, inline style on top. */
function element_style(ctx: CompileContext, t: Template, node: AST.RegularElement, spec: HtmlSpec): { info: ElementInfo; style: ElementStyle } {
	const info = ctx.styles.info(node, t, ctx, node.name);
	const style = ctx.styles.resolve(info, ctx.ancestors);
	if (spec.defaults?.length) style.layers.unshift({ cond: true, facets: spec.defaults });
	const inline = inline_layer(ctx, node, (m) => warn(ctx, 'css_unsupported', m, node));
	if (inline) style.layers.push(inline);
	const hidden = attr(node, 'hidden');
	if (hidden) {
		const s = attr_source(ctx, hidden);
		const cond = s.kind === 'static' ? attr_on(s.value) : { js: `!!(${s.js})` };
		style.layers.push({ cond: cond as Layer['cond'], facets: [f('display_none', { kind: 'bool', value: true })] });
	}
	return { info, style };
}

/**
 * The element's identity: its id="…" when static, else a key unique in the template.
 * `labelled`: CUI knows the element by a label, "…###key", whose identity is "###key".
 */
function element_key(ctx: CompileContext, t: Template, node: AST.RegularElement, labelled = false): { key: string; name_line: string | null; name_c: string | null } {
	const id = attr(node, 'id');
	if (id) {
		const s = attr_source(ctx, id);
		if (s.kind === 'static' && s.value) {
			const v = String(s.value);
			return { key: v, name_line: `cuisv_name(ui, ${c_string(v)}, ${c_string(labelled ? `###${v}` : v)});`, name_c: c_string(v) };
		}
	}
	return { key: t.key(), name_line: null, name_c: null };
}

export function emit_html(ctx: CompileContext, t: Template, node: AST.RegularElement) {
	const spec = HTML[node.name] ?? BLOCK;
	for (const a of node.attributes) {
		if (a.type === 'SpreadAttribute') warn(ctx, 'spread', `{...spread} on <${node.name}> is not supported yet`, a);
		else if (a.type === 'UseDirective' || a.type === 'TransitionDirective' || a.type === 'AnimateDirective' || a.type === 'AttachTag')
			warn(ctx, 'unsupported_directive', `${a.type} has no meaning in CUI and is left out`, a as never);
	}
	if (spec.kind === 'control') return emit_control(ctx, t, node);
	// <label>Remember me <input type="checkbox"></label>: one control, labelled by the text
	if (node.name === 'label') {
		const controls = node.fragment.nodes.filter((n): n is AST.RegularElement => n.type === 'RegularElement' && HTML[n.name]?.kind === 'control' && n.name !== 'img');
		const rest = node.fragment.nodes.filter((n) => n.type === 'Text' || n.type === 'ExpressionTag' || n.type === 'Comment');
		if (controls.length === 1 && rest.length + 1 === node.fragment.nodes.filter((n) => !(n.type === 'Comment')).length) {
			(controls[0] as unknown as { cuisv_label?: Source | null }).cuisv_label = text_of(ctx, rest);
			return emit_control(ctx, t, controls[0]);
		}
	}
	if (spec.kind === 'void') {
		if (node.name === 'hr') t.line('cui_separator(ui);');
		return;
	}
	const kids = node.fragment.nodes;
	const clickable = node.name === 'button' || !!event(ctx, node, 'onclick') || (node.name === 'a' && !!attr(node, 'href'));
	const { info, style } = element_style(ctx, t, node, spec);
	const box_like =
		spec.kind === 'block' ||
		clickable ||
		has_elements(kids) ||
		style.layers.some((l) => l.facets.some((x) => /^(bg|border|pad_|radius_|size_|elevation|min_|max_)/.test(x.name)));
	if (!box_like) return emit_text_element(ctx, t, node, style);
	emit_box(ctx, t, node, spec, info, style, clickable);
}

/** p, span, h1…: one text, styled. */
function emit_text_element(ctx: CompileContext, t: Template, node: AST.RegularElement, style: ElementStyle) {
	const text = text_of(ctx, node.fragment.nodes);
	if (!text) return;
	const key = t.key();
	bind_pointer(style, '((cuisv_pointer){0})');
	const none = display_none(style, t);
	t.open(`{ /* <${node.name}> ${key} */`);
	if (none) t.open(`if (!${none}) {`);
	const lines = text_style(style, t, `ts_${key}`);
	const v = string_val(t, text);
	if (lines) {
		t.line(`cuisv_text_style ts_${key} = {0};`);
		for (const l of lines) t.line(l);
		t.line(`cuisv_text(ui, ${v.c}, &ts_${key});`);
	} else t.line(`cuisv_text(ui, ${v.c}, NULL);`);
	emit_title_tooltip(ctx, t, node);
	if (none) t.close();
	t.close();
}

function emit_title_tooltip(ctx: CompileContext, t: Template, node: AST.RegularElement) {
	const title = attr(node, 'title');
	if (!title) return;
	const v = string_val(t, attr_source(ctx, title));
	t.line(`cui_tooltip(ui, ${v.c});`);
}

/** div, section, button, li…: a box; clickable ones report pointer state. */
function emit_box(ctx: CompileContext, t: Template, node: AST.RegularElement, spec: HtmlSpec, info: ElementInfo, style: ElementStyle, clickable: boolean) {
	const { key, name_line } = element_key(ctx, t, node);
	const kids = node.fragment.nodes;
	const pointer = clickable || style.needs_pointer || !!event(ctx, node, 'onmouseenter') || !!event(ctx, node, 'onmouseleave') || !!event(ctx, node, 'ondblclick') || !!event(ctx, node, 'oncontextmenu');
	const pv = `pt_${key.replace(/\W/g, '_')}`;
	if (pointer) info.pointer = pv;
	if (node.name === 'form') (info as unknown as { cuisv_submit?: string | null }).cuisv_submit = event(ctx, node, 'onsubmit');
	bind_pointer(style, pointer ? pv : '((cuisv_pointer){0})');
	// buttons answer the pointer like the browser's: a hover tint unless CSS says otherwise
	if (node.name === 'button') {
		style.layers.splice(1, 0, { cond: { c: `${pv}.hovered` }, facets: [f('bg', color('hover'))] });
	}
	const fallback = spec.inline && node.name !== 'button' ? 'row' : all_inline(kids) && kids.some((k) => k.type === 'RegularElement') ? 'row' : 'column';
	const dir = box_dir(style, fallback);
	info.dir = dir;
	const parent = ctx.ancestors[ctx.ancestors.length - 1];
	const none = display_none(style, t);
	const mg = margins(style);
	const v = key.replace(/\W/g, '_');

	t.open(`{ /* ${c_comment(`<${node.name}> ${key}`)} */`);
	if (name_line) t.line(name_line);
	if (none) t.open(`if (!${none}) {`);
	if (mg) {
		// margins: a transparent box around, padded by them
		t.line(`cui_box mo_${v} = {0};`);
		t.line(`mo_${v}.dir = ${parent?.dir === 'row' ? 'CUI_ROW' : 'CUI_COLUMN'};`);
		for (const [side, values] of mg) {
			const field = side === 'auto_left' || side === 'auto_right' || side === 'auto_top' || side === 'auto_bottom' ? null : `pad_${side}`;
			if (!field) continue;
			for (const val of values) {
				const c = facet_c(val.value, { name: field, type: 'float' }, t);
				if (c === null) continue;
				t.line(val.cond === true ? `mo_${v}.${field} = ${c};` : `if (${cond_c(val.cond, t)}) mo_${v}.${field} = ${c};`);
			}
		}
		if (mg.has('auto_left') && mg.has('auto_right')) t.line(`mo_${v}.align = CUI_ALIGN_CENTER;`);
		t.line(`cui_box_begin(ui, &mo_${v});`);
	}
	if (pointer) t.line(`cuisv_pointer ${pv} = cuisv_box_pointer(ui, ${c_string(key)}, ${clickable ? 'true' : 'false'});`);
	t.line('cui_box o = {0};');
	t.line(`o.id = ${c_string(key)};`);
	t.line(`o.dir = ${dir === 'row' ? 'CUI_ROW' : dir === 'grid' ? 'CUI_GRID' : 'CUI_COLUMN'};`);
	if (dir === 'row' && fallback === 'row' && !style.layers.some((l) => l.facets.some((x) => x.name === 'display_flex'))) {
		// inline flow: wraps like text; the spaces in the text runs separate the words
		t.line('o.wrap = true;');
		t.line('o.align = CUI_ALIGN_CENTER;');
	}
	for (const l of apply_fields(style, BOX_FIELDS, t, { parent_dir: parent?.dir ?? null, explicit: new Set(), opts: 'o' })) t.line(l);
	const ts_lines = text_style(style, t, `ts_${v}`);
	if (ts_lines) {
		t.line(`cuisv_text_style ts_${v} = {0};`);
		for (const l of ts_lines) t.line(l);
	}
	t.line('cui_box_begin(ui, &o);');
	if (pointer) t.line(`cuisv_box_mark(ui, ${clickable ? 'true' : 'false'}, ${clickable || has_facet(style, 'cursor_hand') ? 'true' : 'false'}, &${pv});`);
	if (ts_lines) t.line(`cuisv_text_push(&ts_${v});`);
	if (node.name === 'li') emit_marker(ctx, t);
	if (node.name === 'ol') t.line(`cuisv_ol_begin(${ol_start(ctx, t, node)});`);
	ctx.ancestors.push(info);
	const inline_flow = dir === 'row' && fallback === 'row' && kids.some((k) => k.type === 'Text' && k.data.trim());
	walk(ctx, t, kids, undefined, inline_flow);
	ctx.ancestors.pop();
	if (node.name === 'ol') t.line('cuisv_ol_end();');
	if (ts_lines) t.line('cuisv_text_pop();');
	t.line('cui_box_end(ui);');
	emit_title_tooltip(ctx, t, node);
	if (mg) t.line('cui_box_end(ui);');
	// events
	const ev = (name: string, cond: string) => {
		const js = event(ctx, node, name);
		if (js) t.line(`if (${cond}) cuisv_emit(s, ${t.slot('f', `__cuisv_h.dom_click(${js}, ${JSON.stringify(name.slice(2))})`)});`);
	};
	if (pointer) {
		ev('onclick', `${pv}.clicked`);
		ev('ondblclick', `${pv}.double_clicked`);
		ev('oncontextmenu', `${pv}.right_clicked`);
		const enter = event(ctx, node, 'onmouseenter');
		const leave = event(ctx, node, 'onmouseleave');
		if (enter || leave) {
			const was = t.slot('b', null);
			t.open(`if (${pv}.hovered != cuisv_bool(s, ${was})) {`);
			t.line(`cuisv_set_bool(s, ${was}, ${pv}.hovered);`);
			if (enter) t.line(`if (${pv}.hovered) cuisv_emit(s, ${t.slot('f', enter)});`);
			if (leave) t.line(`if (!${pv}.hovered) cuisv_emit(s, ${t.slot('f', leave)});`);
			t.close();
		}
		// <a href> opens the link when nothing handles the click
		const href = attr(node, 'href');
		if (node.name === 'a' && href && !event(ctx, node, 'onclick')) {
			const hv = string_val(t, attr_source(ctx, href));
			t.line(`if (${pv}.clicked) cuisv_open_url(${hv.c});`);
		}
	}
	if (none) t.close();
	t.close();
}

/** The li's box is a row: its marker, then the content. In an <ol> the runtime counts the items. */
function emit_marker(ctx: CompileContext, t: Template) {
	const list = [...ctx.ancestors].reverse().find((a) => a.tag === 'ol' || a.tag === 'ul');
	if (list?.tag === 'ol') t.line('cuisv_text(ui, cuisv_ol_marker(), NULL);');
	else t.line('cuisv_text(ui, "\\342\\200\\242", NULL);');
}

/** C for the number an <ol>'s first item gets: start="…", else 1. */
function ol_start(ctx: CompileContext, t: Template, node: AST.RegularElement): string {
	const a = attr(node, 'start');
	return (a && typed_val(ctx, t, 'int', 'start', attr_source(ctx, a), a)?.c) || '1';
}

// ---- form controls and media ------------------------------------------------------------------

function label_text(ctx: CompileContext, node: AST.RegularElement): Source | null {
	// <label>text <input …></label>: the text around the control is its label
	const own = attr(node, 'aria-label');
	if (own) return attr_source(ctx, own);
	return (node as unknown as { cuisv_label?: Source }).cuisv_label ?? null;
}

function opt_attr(ctx: CompileContext, t: Template, node: AST.RegularElement, name: string, type: string, field = name): string | null {
	const a = attr(node, name);
	if (!a) return null;
	const v = typed_val(ctx, t, type, field, attr_source(ctx, a), a);
	return v?.c ?? null;
}

function emit_control(ctx: CompileContext, t: Template, node: AST.RegularElement) {
	const { style } = element_style(ctx, t, node, HTML[node.name]);
	bind_pointer(style, '((cuisv_pointer){0})');
	const typeAttr = attr(node, 'type');
	const type = typeAttr && typeAttr.value !== true ? String((attr_source(ctx, typeAttr) as { value?: unknown }).value ?? 'text') : 'text';
	// checkboxes, radios and sliders are CUI controls with a label (label_c below)
	const labelled = node.name === 'input' && ['checkbox', 'radio', 'range'].includes(type);
	const { key, name_line, name_c } = element_key(ctx, t, node, labelled);
	const none = display_none(style, t);
	t.open(`{ /* ${c_comment(`<${node.name}${node.name === 'input' ? ` type=${type}` : ''}> ${key}`)} */`);
	if (name_line) t.line(name_line);
	if (none) t.open(`if (!${none}) {`);
	const disabled = opt_attr(ctx, t, node, 'disabled', 'bool');
	const parent_dir = ctx.ancestors[ctx.ancestors.length - 1]?.dir ?? null;
	const css = (opts: string, explicit: string[] = []) => {
		for (const l of apply_fields(style, fields_of(opts), t, { parent_dir, explicit: new Set(explicit), opts: 'o' })) t.line(l);
	};
	const label = label_text(ctx, node);
	const label_c = (fallback = '') => {
		if (!label) return c_string(`${fallback}###${key}`);
		if (label.kind === 'static') return c_string(`${label_part(String(label.value ?? ''))}###${key}`);
		return `cuisv_label(${string_val(t, label).c}, ${c_string(key)})`;
	};

	switch (node.name) {
		case 'input': {
			if (type === 'checkbox' || type === 'radio') {
				emit_check(ctx, t, node, type, label_c(), disabled, css);
				break;
			}
			if (type === 'range') {
				const b = bind(ctx, node, 'value');
				const val = slot_number(ctx, t, node, b, 'value');
				t.line('cui_slider_opts o = {0};');
				css('cui_slider_opts');
				const step = opt_attr(ctx, t, node, 'step', 'float');
				if (step) t.line(`o.step = ${step};`);
				if (disabled) t.line(`o.disabled = ${disabled};`);
				t.line(`float p_value = (float)cuisv_num(s, ${val.slot}); float p_was = p_value;`);
				const min = opt_attr(ctx, t, node, 'min', 'float') ?? '0.0f';
				const max = opt_attr(ctx, t, node, 'max', 'float') ?? '100.0f';
				t.line(`cui_slider_ex(ui, ${label_c()}, &p_value, ${min}, ${max}, &o);`);
				emit_change(ctx, t, node, 'p_value != p_was', `cuisv_set_num(s, ${val.slot}, p_value);`, val.setter, 'num', 'p_value');
				break;
			}
			if (type === 'number') {
				const b = bind(ctx, node, 'value');
				const val = slot_number(ctx, t, node, b, 'value');
				t.line('cui_number_opts o = {0};');
				css('cui_number_opts');
				const step = opt_attr(ctx, t, node, 'step', 'double');
				if (step) t.line(`o.step = ${step};`);
				if (disabled) t.line(`o.disabled = ${disabled};`);
				t.line(`double p_value = cuisv_num(s, ${val.slot}); double p_was = p_value;`);
				const min = opt_attr(ctx, t, node, 'min', 'double') ?? '-1e300';
				const max = opt_attr(ctx, t, node, 'max', 'double') ?? '1e300';
				t.line(`cui_number_ex(ui, ${c_string(key)}, &p_value, ${min}, ${max}, &o);`);
				emit_change(ctx, t, node, 'p_value != p_was', `cuisv_set_num(s, ${val.slot}, p_value);`, val.setter, 'num', 'p_value');
				break;
			}
			if (['text', 'password', 'email', 'search', 'url', 'tel', ''].includes(type)) {
				emit_text_input(ctx, t, node, type === 'search' ? 'cui_search_ex' : 'cui_input_ex', key, type === 'password', disabled, css);
				break;
			}
			warn(ctx, 'unsupported_input', `<input type="${type}"> is not supported; it renders as a text field`, node);
			emit_text_input(ctx, t, node, 'cui_input_ex', key, false, disabled, css);
			break;
		}
		case 'textarea':
			emit_text_input(ctx, t, node, 'cui_textarea_ex', key, false, disabled, css);
			break;
		case 'select':
			emit_select(ctx, t, node, key, disabled, css);
			break;
		case 'img': {
			const src = attr(node, 'src');
			if (!src) break;
			const sv = string_val(t, attr_source(ctx, src));
			t.line('int iw = 0, ih = 0;');
			t.line(`cui_texture tex = cuisv_image(ui, ${sv.c}, &iw, &ih);`);
			t.line('cui_image_opts o = {0};');
			const w = opt_attr(ctx, t, node, 'width', 'cui_size');
			const h = opt_attr(ctx, t, node, 'height', 'cui_size');
			if (w) t.line(`o.width = ${w};`);
			if (h) t.line(`o.height = ${h};`);
			css('cui_image_opts', [w ? 'width' : '', h ? 'height' : ''].filter(Boolean));
			for (const l of apply_fields(style, new Map([['radius', { name: 'radius', type: 'float' }]]), t, { parent_dir, explicit: new Set(), opts: 'o' })) t.line(l);
			t.line('if (tex) cui_image_ex(ui, tex, &o);');
			break;
		}
		case 'progress':
		case 'meter': {
			const value = opt_attr(ctx, t, node, 'value', 'float');
			const max = opt_attr(ctx, t, node, 'max', 'float') ?? '1.0f';
			t.line('cui_progress_opts o = {0};');
			css('cui_progress_opts');
			if (!value) t.line('o.indeterminate = true;');
			t.line(`cui_progress_ex(ui, ${value ? `(${value}) / (${max})` : '0'}, &o);`);
			break;
		}
	}
	// a checkbox's or radio's CUI id is not its label's (see cuisv_name_last)
	if (labelled && name_c) t.line(`cuisv_name_last(ui, ${name_c});`);
	emit_title_tooltip(ctx, t, node);
	if (none) t.close();
	t.close();
}

/** A numeric slot for a bound (or plain) value attribute, with its setter when bound. */
function slot_number(ctx: CompileContext, t: Template, node: AST.RegularElement, b: Bound | null, name: string): { slot: number; setter: number } {
	const a = attr(node, name);
	const s = a ? attr_source(ctx, a) : null;
	const { slot, setter, own } = value_slot(t, 'n', b, s, (js) => `Number(${js})`);
	if (own && s?.kind === 'static' && s.value != null) {
		const n = Number(s.value);
		if (Number.isFinite(n)) t.line(`if (!cuisv_has(s, ${slot})) cuisv_set_num(s, ${slot}, ${n});`);
		else warn(ctx, 'bad_value', `${name}: expected a number, got ${JSON.stringify(s.value)}`, a);
	}
	return { slot, setter };
}

/** The setter (for bind:), then onchange/oninput handlers, when the control changed. */
function emit_change(ctx: CompileContext, t: Template, node: AST.RegularElement, changed: string, write: string, setter: number, type: 'num' | 'bool' | 'str', local: string) {
	const emit = type === 'num' ? 'cuisv_emit_num' : type === 'bool' ? 'cuisv_emit_bool' : 'cuisv_emit_str';
	const lines = [write];
	if (setter >= 0) lines.push(`${emit}(s, ${setter}, ${local});`);
	for (const name of ['oninput', 'onchange']) {
		const js = event(ctx, node, name);
		// the DOM passes an Event; handlers here get { target: { value } } alike
		if (js) lines.push(`${emit}(s, ${t.slot('f', `__cuisv_h.dom_event(${js}, ${JSON.stringify(type === 'bool' ? 'checked' : 'value')})`)}, ${local});`);
	}
	t.line(`if (${changed}) { ${lines.join(' ')} }`);
}

function emit_check(ctx: CompileContext, t: Template, node: AST.RegularElement, type: string, label: string, disabled: string | null, css: (o: string) => void) {
	t.line('cui_check_opts o = {0};');
	css('cui_check_opts');
	if (disabled) t.line(`o.disabled = ${disabled};`);
	if (type === 'checkbox') {
		const a = attr(node, 'checked');
		const s = a ? attr_source(ctx, a) : null;
		const { slot, setter, own } = value_slot(t, 'b', bind(ctx, node, 'checked'), s);
		if (own && s?.kind === 'static' && attr_on(s.value)) t.line(`if (!cuisv_has(s, ${slot})) cuisv_set_bool(s, ${slot}, true);`);
		t.line(`bool p_checked = cuisv_bool(s, ${slot}); bool p_was = p_checked;`);
		t.line(`cui_checkbox_ex(ui, ${label}, &p_checked, &o);`);
		emit_change(ctx, t, node, 'p_checked != p_was', `cuisv_set_bool(s, ${slot}, p_checked);`, setter, 'bool', 'p_checked');
	} else {
		// bind:group={x} value={v}: selected while x === v; choosing it sets x = v
		const g = bind(ctx, node, 'group');
		const va = attr(node, 'value');
		const value_js = va ? js_of(attr_source(ctx, va)) : 'undefined';
		const slot = t.slot('b', g ? `(${g.js}) === (${value_js})` : 'false');
		const setter = g ? t.setter(slot, `() => (${g.set})(${value_js})`) : -1;
		t.line(`int p_sel = cuisv_bool(s, ${slot}) ? 1 : 0; int p_was = p_sel;`);
		t.line(`cui_radio_ex(ui, ${label}, &p_sel, 1, &o);`);
		emit_change(ctx, t, node, 'p_sel != p_was && p_sel == 1', `cuisv_set_bool(s, ${slot}, true);`, setter, 'bool', 'true');
	}
}

function emit_text_input(ctx: CompileContext, t: Template, node: AST.RegularElement, fn: string, key: string, password: boolean, disabled: string | null, css: (o: string) => void) {
	const a = attr(node, 'value');
	const s = a ? attr_source(ctx, a) : null;
	const { slot, setter, own } = value_slot(t, 's', bind(ctx, node, 'value'), s);
	if (own && s?.kind === 'static' && s.value != null) t.line(init_str(slot, String(s.value)));
	t.line('cui_input_opts o = {0};');
	css('cui_input_opts');
	if (password) t.line('o.password = true;');
	if (disabled) t.line(`o.disabled = ${disabled};`);
	const ph = opt_attr(ctx, t, node, 'placeholder', 'const char *');
	if (ph) t.line(`o.placeholder = ${ph};`);
	const ro = opt_attr(ctx, t, node, 'readonly', 'bool');
	if (ro) t.line(`o.read_only = ${ro};`);
	const af = opt_attr(ctx, t, node, 'autofocus', 'bool');
	if (af) t.line(`o.autofocus = ${af};`);
	const rows = opt_attr(ctx, t, node, 'rows', 'float');
	if (rows && fn === 'cui_textarea_ex') t.line(`o.height = (${rows}) * 20.0f + 16.0f;`);
	const label = label_text(ctx, node);
	if (label) t.line(`o.label = ${string_val(t, label).c};`);
	t.line(`size_t cap; char *p_value = cuisv_buf(s, ${slot}, ${edit_room()}, &cap);`);
	t.line(`int r = ${fn}(ui, ${c_string(key)}, p_value, cap, &o);`);
	const lines = [`cuisv_buf_changed(s, ${slot}, ${setter});`];
	const oninput = event(ctx, node, 'oninput');
	if (oninput) lines.push(`cuisv_emit_str(s, ${t.slot('f', `__cuisv_h.dom_event(${oninput}, "value")`)}, p_value);`);
	t.line(`if (r & CUI_CHANGED) { ${lines.join(' ')} }`);
	const onchange = event(ctx, node, 'onchange');
	if (onchange) t.line(`if (r & (CUI_SUBMITTED | CUI_BLURRED)) cuisv_emit_str(s, ${t.slot('f', `__cuisv_h.dom_event(${onchange}, "value")`)}, p_value);`);
	for (const [name, flag] of [
		['onfocus', 'CUI_FOCUSED'],
		['onblur', 'CUI_BLURRED']
	] as const) {
		const js = event(ctx, node, name);
		if (js) t.line(`if (r & ${flag}) cuisv_emit(s, ${t.slot('f', js)});`);
	}
	// Enter in a field submits its form, like the browser
	const form = [...ctx.ancestors].reverse().find((a) => a.tag === 'form');
	if (form && fn !== 'cui_textarea_ex') {
		const js = (form as unknown as { cuisv_submit?: string }).cuisv_submit;
		if (js) t.line(`if (r & CUI_SUBMITTED) cuisv_emit(s, ${t.slot('f', `__cuisv_h.dom_event(${js}, "value")`)});`);
	}
}

/** <select> with <option> children: static ones and {#each} blocks of them, in order. The binding is on the value. */
function emit_select(ctx: CompileContext, t: Template, node: AST.RegularElement, key: string, disabled: string | null, css: (o: string) => void) {
	// JS array elements: one per static option, a spread per {#each}
	const labels: string[] = [];
	const values: string[] = [];
	for (const n of node.fragment.nodes) {
		if (is_blank(n)) continue;
		if (n.type === 'RegularElement' && n.name === 'option') {
			const text = text_of(ctx, n.fragment.nodes);
			const lab = text ? (text.kind === 'static' ? JSON.stringify(String(text.value)) : text.js) : '""';
			const va = attr(n, 'value');
			const val = va ? js_of(attr_source(ctx, va)) : lab;
			labels.push(lab);
			values.push(val);
		} else if (n.type === 'EachBlock') {
			const opt = n.body.nodes.find((x): x is AST.RegularElement => x.type === 'RegularElement' && x.name === 'option');
			if (!opt) continue;
			const ctx_src = n.context ? src(ctx, n.context) : '__cuisv_o';
			const params = `(${ctx_src}, ${n.index ?? '__cuisv_i'})`;
			const list = src(ctx, n.expression);
			const text = text_of(ctx, opt.fragment.nodes);
			const lab = text ? (text.kind === 'static' ? JSON.stringify(String(text.value)) : text.js) : '""';
			const va = attr(opt, 'value');
			const val = va ? js_of(attr_source(ctx, va)) : lab;
			labels.push(`...Array.from(${list}, ${params} => String(${lab}))`);
			values.push(`...Array.from(${list}, ${params} => (${val}))`);
		} else warn(ctx, 'select_children', '<select> takes <option>s and {#each} blocks of them', n as never);
	}
	const array = (parts: string[]) => (parts.length === 1 && parts[0].startsWith('...') ? parts[0].slice(3) : `[${parts.join(', ')}]`);
	const labels_js = array(labels);
	const values_js = array(values);
	const b = bind(ctx, node, 'value');
	const items = t.slot('a', labels_js);
	let index: number;
	let setter = -1;
	if (b) {
		index = t.slot('n', `${values_js}.indexOf(${b.js})`);
		setter = t.setter(index, `(__cuisv_i) => (${b.set})(${values_js}[__cuisv_i])`);
	} else {
		const va = attr(node, 'value');
		const s = va ? attr_source(ctx, va) : null;
		index = t.slot('n', s?.kind === 'expr' ? `${values_js}.indexOf(${s.js})` : s?.kind === 'static' ? `${values_js}.indexOf(${JSON.stringify(s.value)})` : null);
	}
	t.line('cui_select_opts o = {0};');
	css('cui_select_opts');
	if (disabled) t.line(`o.disabled = ${disabled};`);
	const label = label_text(ctx, node);
	if (label) t.line(`o.label = ${string_val(t, label).c};`);
	t.line(`int n_items = 0; const char *const *p_items = cuisv_strs(s, ${items}, &n_items);`);
	t.line(`int p_index = cuisv_int(s, ${index}); int p_was = p_index;`);
	t.line(`cui_select_ex(ui, ${c_string(key)}, p_items, n_items, &p_index, &o);`);
	const lines = [`cuisv_set_num(s, ${index}, p_index);`];
	if (setter >= 0) lines.push(`cuisv_emit_num(s, ${setter}, p_index);`);
	const onchange = event(ctx, node, 'onchange');
	if (onchange) lines.push(`cuisv_emit_num(s, ${t.slot('f', `(__cuisv_i) => (${onchange})({ target: { value: ${values_js}[__cuisv_i] }, currentTarget: { value: ${values_js}[__cuisv_i] } })`)}, p_index);`);
	t.line(`if (p_index != p_was) { ${lines.join(' ')} }`);
}

