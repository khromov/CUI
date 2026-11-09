/**
 * Cascaded facets -> C. A facet is applied to the first field of the target's options
 * struct that can hold it (pad_top -> pad_top, or pad_y on a card), unconditionally or under
 * its rule's condition, in cascade order, so the last matching rule wins at runtime.
 */
import type { Field } from './api.ts';
import { enum_constant } from './api.ts';
import type { Facet, FacetValue } from './css-props.ts';
import { cond_c, type Cond, type ElementStyle } from './styles.ts';
import { c_color, c_float, c_size, type Template } from './template.ts';

const FACET_FIELDS: Record<string, string[]> = {
	pad_top: ['pad_top', 'pad_y', 'pad'],
	pad_bottom: ['pad_bottom', 'pad_y', 'pad'],
	pad_left: ['pad_left', 'pad_x', 'pad'],
	pad_right: ['pad_right', 'pad_x', 'pad'],
	gap: ['gap'],
	size_w: ['width'],
	size_h: ['height'],
	min_width: ['min_width'],
	max_width: ['max_width'],
	min_height: ['min_height'],
	max_height: ['max_height'],
	bg: ['bg'],
	border: ['border'],
	border_color: ['border_color'],
	radius_tl: ['radius_tl', 'radius'],
	radius_tr: ['radius_tr', 'radius'],
	radius_br: ['radius_br', 'radius'],
	radius_bl: ['radius_bl', 'radius'],
	elevation: ['elevation'],
	opacity: ['opacity'],
	wrap: ['wrap'],
	align: ['align'],
	justify: ['justify'],
	columns: ['columns'],
	min_column_width: ['min_column_width'],
	scroll_x: ['scroll_x', 'horizontal'],
	scroll_y: ['scroll_y'],
	clip: ['clip'],
	direction: ['direction'],
	// a field name may carry the C type it must have: CSS text-align is not a box's align
	text_color: ['color'],
	text_size: ['size@float'],
	text_font: ['font@cui_font'],
	text_weight: ['font@cui_font'],
	text_align: ['align@cui_text_align'],
	text_line_height: ['line_height@float'],
	text_nowrap: ['nowrap'],
	text_tabular: ['tabular']
};

/** C for a facet value stored in a field of `type`, or null when the field cannot hold it. */
export function facet_c(v: FacetValue, field: Field, t: Template): string | null {
	const type = field.type;
	if (v.kind === 'js') {
		const i = t.slot(v.as === 'bool' ? 'b' : 'n', v.js);
		if (type === 'cui_size') return `cuisv_size(s, ${i}, CUI_FIT)`;
		if (type === 'cui_color') return `cuisv_color(s, ${i}, CUI_TRANSPARENT)`;
		if (type === 'bool') return `cuisv_bool(s, ${i})`;
		if (type === 'float') return `cuisv_float(s, ${i})`;
		if (type === 'int') return `cuisv_int(s, ${i})`;
		return `(${type})cuisv_int(s, ${i})`;
	}
	if (type === 'cui_font') {
		if (v.kind === 'enum') return v.value === 'mono' ? 'CUI_FONT_MONO' : 'CUI_FONT_DISPLAY';
		if (v.kind === 'num') return v.value >= 500 ? 'CUI_FONT_MEDIUM' : 'CUI_FONT_BODY';
		return null;
	}
	switch (type) {
		case 'float':
		case 'double':
			if (v.kind === 'num') return c_float(v.value);
			if (v.kind === 'size' && v.size.kind === 2) return c_float(v.size.value);
			return null;
		case 'int':
			if (v.kind === 'num' && Number.isFinite(v.value)) return String(Math.round(v.value));
			return null;
		case 'bool':
			if (v.kind === 'bool') return v.value ? 'true' : 'false';
			return null;
		case 'cui_size':
			if (v.kind === 'size') return c_size(v.size.kind, v.size.value);
			if (v.kind === 'num') return `CUI_PX(${c_float(v.value)})`;
			return null;
		case 'cui_color':
			if (v.kind === 'color') return c_color(v.color);
			return null;
		default:
			if (v.kind === 'enum') return enum_constant(type, v.value);
			return null;
	}
}

export interface ApplyOptions {
	/** Direction of the parent, for flex-grow. */
	parent_dir: 'row' | 'column' | 'grid' | 'stack' | null;
	/** Fields markup set explicitly: they win over CSS. */
	explicit: Set<string>;
	opts: string;
}

/** Applies the style's box facets to the option fields that exist. Returns C lines. */
export function apply_fields(style: ElementStyle, fields: Map<string, Field>, t: Template, o: ApplyOptions): string[] {
	const lines: string[] = [];
	// flex-grow grows the box along its parent's direction
	const axis = o.parent_dir === 'column' ? 'height' : 'width';
	for (const layer of style.layers) {
		const assigns: string[] = [];
		const corners = layer.facets.filter((f) => f.name.startsWith('radius_'));
		const uniform = corners.length === 4 && corners.every((c) => JSON.stringify(c.value) === JSON.stringify(corners[0].value));
		for (const f of layer.facets) {
			let name = f.name;
			if (name === 'grow_js' || name === 'grow') {
				if (fields.get(axis) && !o.explicit.has(axis)) {
					if (name === 'grow_js' && f.value.kind === 'js') assigns.push(`${o.opts}.${axis} = CUI_GROW(cuisv_float(s, ${t.slot('n', f.value.js)}));`);
					else if (name === 'grow' && f.value.kind === 'num' && f.value.value > 0) assigns.push(`${o.opts}.${axis} = CUI_GROW(${c_float(f.value.value)});`);
				}
				continue;
			}
			if (name.startsWith('radius_') && uniform) {
				if (f !== corners[0]) continue;
				name = 'radius';
			}
			const candidates = name === 'radius' ? ['radius'] : FACET_FIELDS[name];
			if (!candidates) continue;
			for (const candidate of candidates) {
				const [fname, want] = candidate.split('@');
				const field = fields.get(fname);
				if (!field || o.explicit.has(fname)) continue;
				if (want && field.type !== want) continue;
				if (name.startsWith('radius_') && fname === 'radius') continue;
				const c = facet_c(f.value, field, t);
				if (c !== null) {
					assigns.push(`${o.opts}.${fname} = ${c};`);
					break;
				}
			}
		}
		push_layer(lines, layer.cond, assigns, t);
	}
	return lines;
}

function push_layer(lines: string[], cond: Cond, assigns: string[], t: Template) {
	if (!assigns.length) return;
	if (cond === true) lines.push(...assigns);
	else if (cond !== false) lines.push(`if (${cond_c(cond, t)}) { ${assigns.join(' ')} }`);
}

/** The direction a box lays its children out in, from display and flex-direction. */
export function box_dir(style: ElementStyle, fallback: 'row' | 'column'): 'row' | 'column' | 'grid' {
	let dir: 'row' | 'column' | 'grid' = fallback;
	let flex = false;
	let flex_dir: 'row' | 'column' | null = null;
	for (const l of style.layers) {
		if (l.cond !== true) continue;
		for (const f of l.facets) {
			if (f.name === 'display_flex') flex = true;
			else if (f.name === 'dir' && f.value.kind === 'enum') {
				dir = f.value.value as 'column' | 'grid';
				flex = false;
			} else if (f.name === 'flex_dir' && f.value.kind === 'enum') flex_dir = f.value.value as 'row' | 'column';
		}
	}
	if (flex) return flex_dir ?? 'row';
	return dir;
}

/** C condition under which the element is display: none, or null when never. */
export function display_none(style: ElementStyle, t: Template): string | null {
	let cond: string | null = null;
	for (const l of style.layers) {
		for (const f of l.facets) {
			if (f.name === 'display_none') cond = l.cond === true ? 'true' : `(${cond_c(l.cond, t)})`;
			else if ((f.name === 'display_flex' || f.name === 'dir') && cond !== null) cond = l.cond === true ? null : `(${cond} && !${cond_c(l.cond, t)})`;
		}
	}
	return cond;
}

/** Margins: a transparent wrapper box padded by them. Returns the facets, or null. */
export function margins(style: ElementStyle): Map<string, { cond: Cond; value: FacetValue }[]> | null {
	const out = new Map<string, { cond: Cond; value: FacetValue }[]>();
	for (const l of style.layers) {
		for (const f of l.facets) {
			if (!f.name.startsWith('margin_')) continue;
			const side = f.name.replace('margin_', '');
			if (!out.has(side)) out.set(side, []);
			out.get(side)!.push({ cond: l.cond, value: f.value });
		}
	}
	return out.size ? out : null;
}

const TS_BITS: Record<string, string> = {
	text_color: 'CUISV_TS_COLOR',
	text_size: 'CUISV_TS_SIZE',
	text_font: 'CUISV_TS_FONT',
	text_weight: 'CUISV_TS_FONT',
	text_align: 'CUISV_TS_ALIGN',
	text_line_height: 'CUISV_TS_LINE_HEIGHT',
	text_line_height_px: 'CUISV_TS_LINE_HEIGHT',
	text_nowrap: 'CUISV_TS_NOWRAP',
	text_tabular: 'CUISV_TS_TABULAR'
};

/** Text facets as statements filling `cuisv_text_style var`. Returns null when none. */
export function text_style(style: ElementStyle, t: Template, v: string, extra: Facet[] = []): string[] | null {
	const lines: string[] = [];
	const layers = extra.length ? [{ cond: true as Cond, facets: extra }, ...style.layers] : style.layers;
	let any = false;
	let size_known: number | null = null;
	for (const layer of layers) {
		const assigns: string[] = [];
		for (const f of layer.facets) {
			const bit = TS_BITS[f.name];
			if (!bit) continue;
			any = true;
			const val = f.value;
			let a: string | null = null;
			switch (f.name) {
				case 'text_color':
					if (val.kind === 'color') a = `${v}.color = ${c_color(val.color)};`;
					else if (val.kind === 'js') a = `${v}.color = cuisv_color(s, ${t.slot('n', val.js)}, CUI_COLOR_FOREGROUND);`;
					break;
				case 'text_size':
					if (val.kind === 'num') {
						a = `${v}.size = ${c_float(val.value)};`;
						if (layer.cond === true) size_known = val.value;
					} else if (val.kind === 'js') a = `${v}.size = cuisv_float(s, ${t.slot('n', val.js)});`;
					break;
				case 'text_weight':
					if (val.kind === 'num') a = `${v}.font = ${val.value >= 500 ? 'CUI_FONT_MEDIUM' : 'CUI_FONT_BODY'};`;
					break;
				case 'text_font':
					if (val.kind === 'enum') a = `${v}.font = ${val.value === 'mono' ? 'CUI_FONT_MONO' : 'CUI_FONT_DISPLAY'};`;
					break;
				case 'text_align':
					if (val.kind === 'enum') a = `${v}.align = ${enum_constant('cui_text_align', val.value) ?? 'CUI_TEXT_START'};`;
					break;
				case 'text_line_height':
					if (val.kind === 'num') a = `${v}.line_height = ${c_float(val.value)};`;
					break;
				case 'text_line_height_px':
					if (val.kind === 'num') a = `${v}.line_height = ${c_float(size_known ? val.value / size_known : val.value / 13)};`;
					break;
				case 'text_nowrap':
					if (val.kind === 'bool') a = `${v}.nowrap = ${val.value};`;
					break;
				case 'text_tabular':
					if (val.kind === 'bool') a = `${v}.tabular = ${val.value};`;
					break;
			}
			if (a) assigns.push(a, `${v}.set |= ${bit};`);
		}
		push_layer(lines, layer.cond, assigns, t);
	}
	return any ? lines : null;
}

/** Whether a facet with this name was set by any layer (e.g. cursor_hand). */
export function has_facet(style: ElementStyle, name: string): boolean {
	return style.layers.some((l) => l.cond !== false && l.facets.some((f) => f.name === name && (f.value.kind !== 'bool' || f.value.value)));
}
