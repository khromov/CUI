/**
 * style="…" and style:prop={…}: the highest layer of an element's style. Static parts are
 * resolved now; a value with an {expression} is computed by the skeleton and packed for C by
 * a runtime helper chosen from the property (a size, a color, a length, a number).
 */
import type { AST } from 'svelte/compiler';
import { expand, facets, type Facet, type FacetValue, type CssProblem } from './css-props.ts';
import type { Layer } from './styles.ts';
import type { CompileContext } from './template.ts';

/** How a property's runtime value is packed, and the facets it sets. */
const DYNAMIC: Record<string, { as: 'num' | 'size' | 'color' | 'bool'; helper: string; facets: string[] }> = {
	width: { as: 'size', helper: 'size', facets: ['size_w'] },
	height: { as: 'size', helper: 'size', facets: ['size_h'] },
	'min-width': { as: 'num', helper: 'length', facets: ['min_width'] },
	'max-width': { as: 'num', helper: 'length', facets: ['max_width'] },
	'min-height': { as: 'num', helper: 'length', facets: ['min_height'] },
	'max-height': { as: 'num', helper: 'length', facets: ['max_height'] },
	padding: { as: 'num', helper: 'length', facets: ['pad_top', 'pad_right', 'pad_bottom', 'pad_left'] },
	'padding-top': { as: 'num', helper: 'length', facets: ['pad_top'] },
	'padding-right': { as: 'num', helper: 'length', facets: ['pad_right'] },
	'padding-bottom': { as: 'num', helper: 'length', facets: ['pad_bottom'] },
	'padding-left': { as: 'num', helper: 'length', facets: ['pad_left'] },
	gap: { as: 'num', helper: 'length', facets: ['gap'] },
	background: { as: 'color', helper: 'color', facets: ['bg'] },
	'background-color': { as: 'color', helper: 'color', facets: ['bg'] },
	'border-color': { as: 'color', helper: 'color', facets: ['border_color'] },
	'border-width': { as: 'num', helper: 'length', facets: ['border'] },
	'border-radius': { as: 'num', helper: 'length', facets: ['radius_tl', 'radius_tr', 'radius_br', 'radius_bl'] },
	opacity: { as: 'num', helper: 'num', facets: ['opacity'] },
	color: { as: 'color', helper: 'color', facets: ['text_color'] },
	'font-size': { as: 'num', helper: 'length', facets: ['text_size'] },
	'flex-grow': { as: 'num', helper: 'num', facets: ['grow_js'] }
};

interface Part {
	text?: string;
	js?: string;
}

function parts_of(ctx: CompileContext, value: AST.Attribute['value']): Part[] {
	if (value === true) return [];
	const arr = Array.isArray(value) ? value : [value];
	return arr.map((p) => (p.type === 'Text' ? { text: p.data } : { js: ctx.source.slice((p.expression as unknown as { start: number }).start, (p.expression as unknown as { end: number }).end) }));
}

function dynamic_facets(property: string, js: string, warn: (m: string) => void): Facet[] {
	const d = DYNAMIC[property];
	if (!d) {
		warn(`style: a computed ${property} is not supported; use a class`);
		return [];
	}
	const packed = d.helper === 'num' ? `Number(${js})` : `__cuisv_h.${d.helper}(${js})`;
	const value: FacetValue = { kind: 'js', js: packed, as: d.as };
	return d.facets.map((name) => ({ name, value }));
}

export function inline_layer(ctx: CompileContext, node: AST.RegularElement | AST.Component, warn: (m: string) => void): Layer | null {
	const out: Facet[] = [];
	const problems: CssProblem[] = [];
	for (const a of node.attributes) {
		if (a.type === 'Attribute' && a.name === 'style') {
			const parts = parts_of(ctx, a.value);
			if (parts.length === 1 && parts[0].js) {
				warn('style={…} computed as a whole string is not supported; use style:prop={…} or style="prop: {…}"');
				continue;
			}
			// rebuild "prop: value; …" keeping expressions as placeholders
			let text = '';
			const exprs: string[] = [];
			for (const p of parts) {
				if (p.text !== undefined) text += p.text;
				else {
					text += `\u0000${exprs.length}\u0000`;
					exprs.push(p.js!);
				}
			}
			for (const decl of text.split(';')) {
				const i = decl.indexOf(':');
				if (i < 0) continue;
				const property = decl.slice(0, i).trim().toLowerCase();
				const value = decl.slice(i + 1).trim();
				if (!property || !value || property.startsWith('--')) continue;
				if (value.includes('\u0000')) {
					// "{w}px" -> `${w}px`
					const js = '`' + value.replace(/\u0000(\d+)\u0000/g, (_, n) => `\${${exprs[Number(n)]}}`).replace(/`/g, '\\`') + '`';
					const only = /^\u0000(\d+)\u0000$/.exec(value);
					out.push(...dynamic_facets(property, only ? exprs[Number(only[1])] : js, warn));
				} else {
					for (const [p, v] of expand(property, value)) out.push(...facets(p, v, problems));
				}
			}
		} else if (a.type === 'StyleDirective') {
			const property = a.name.toLowerCase();
			const parts = a.value === true ? [{ js: property }] : parts_of(ctx, a.value);
			if (parts.every((p) => p.text !== undefined)) {
				const value = parts.map((p) => p.text).join('');
				for (const [p, v] of expand(property, value)) out.push(...facets(p, v, problems));
			} else {
				const js = parts.length === 1 ? parts[0].js! : '`' + parts.map((p) => (p.text !== undefined ? p.text.replace(/[`\\]/g, '\\$&') : `\${${p.js}}`)).join('') + '`';
				out.push(...dynamic_facets(property, js, warn));
			}
		}
	}
	for (const p of problems) warn(p.message);
	return out.length ? { cond: true, facets: out } : null;
}
