/**
 * CSS declarations -> CUI options. Shorthands are expanded first; each longhand then maps to
 * an abstract "facet" (pad_top, bg, text_color, size_w…) that every target (a box, text, a
 * component's options struct) applies to the fields it has.
 */
import { parse_color, parse_length, parse_size, type Color } from '../shared/values.ts';

export type FacetValue =
	| { kind: 'num'; value: number }
	| { kind: 'size'; size: { kind: number; value: number } }
	| { kind: 'color'; color: Color }
	| { kind: 'enum'; value: string }
	| { kind: 'bool'; value: boolean }
	/** Dynamic: a JS expression that produces the packed value at runtime. */
	| { kind: 'js'; js: string; as: 'num' | 'size' | 'color' | 'bool' | 'enum'; enum_type?: string };

export interface Facet {
	name: string;
	value: FacetValue;
}

export interface CssProblem {
	property: string;
	message: string;
}

/** Splits a CSS value on top-level whitespace (not inside parentheses). */
export function split_ws(v: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of v.trim()) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (/\s/.test(ch) && depth === 0) {
			if (cur) out.push(cur);
			cur = '';
		} else cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

function box4(values: string[]): [string, string, string, string] | null {
	if (values.length === 1) return [values[0], values[0], values[0], values[0]];
	if (values.length === 2) return [values[0], values[1], values[0], values[1]];
	if (values.length === 3) return [values[0], values[1], values[2], values[1]];
	if (values.length === 4) return [values[0], values[1], values[2], values[3]];
	return null;
}

/** Expands shorthands into the longhands the mapping understands. */
export function expand(property: string, value: string): [string, string][] {
	const p = property.toLowerCase();
	const v = value.replace(/\s*!important\s*$/, '').trim();
	switch (p) {
		case 'padding':
		case 'margin': {
			const b = box4(split_ws(v));
			if (!b) return [[p, v]];
			return [
				[`${p}-top`, b[0]],
				[`${p}-right`, b[1]],
				[`${p}-bottom`, b[2]],
				[`${p}-left`, b[3]]
			];
		}
		case 'padding-inline':
		case 'margin-inline': {
			const [a, b = a] = split_ws(v);
			const base = p.split('-')[0];
			return [
				[`${base}-left`, a],
				[`${base}-right`, b]
			];
		}
		case 'padding-block':
		case 'margin-block': {
			const [a, b = a] = split_ws(v);
			const base = p.split('-')[0];
			return [
				[`${base}-top`, a],
				[`${base}-bottom`, b]
			];
		}
		case 'border-radius': {
			const b = box4(split_ws(v.split('/')[0]));
			if (!b) return [[p, v]];
			return [
				['border-top-left-radius', b[0]],
				['border-top-right-radius', b[1]],
				['border-bottom-right-radius', b[2]],
				['border-bottom-left-radius', b[3]]
			];
		}
		case 'border': {
			const out: [string, string][] = [];
			for (const part of split_ws(v)) {
				if (part === 'none' || part === '0') out.push(['border-width', '0']);
				else if (/^(solid|dashed|dotted|double|groove|ridge|inset|outset|hidden)$/.test(part)) out.push(['border-style', part]);
				else if (parse_length(part) !== null) out.push(['border-width', part]);
				else out.push(['border-color', part]);
			}
			return out;
		}
		case 'flex': {
			const parts = split_ws(v);
			if (v === 'none') return [['flex-grow', '0']];
			if (v === 'auto') return [['flex-grow', '1']];
			if (parts.length && /^[\d.]+$/.test(parts[0])) {
				const out: [string, string][] = [['flex-grow', parts[0]]];
				const basis = parts[2] ?? (parts[1] && !/^[\d.]+$/.test(parts[1]) ? parts[1] : undefined);
				if (basis && basis !== '0' && basis !== '0%' && basis !== 'auto') out.push(['flex-basis', basis]);
				return out;
			}
			return [['flex-basis', v]];
		}
		case 'flex-flow': {
			const out: [string, string][] = [];
			for (const part of split_ws(v)) out.push([/wrap/.test(part) ? 'flex-wrap' : 'flex-direction', part]);
			return out;
		}
		case 'gap': {
			const [a] = split_ws(v);
			return [['gap', a]];
		}
		case 'row-gap':
		case 'column-gap':
			return [['gap', v]];
		case 'background':
			return [['background-color', v]];
		case 'overflow': {
			const [x, y = x] = split_ws(v);
			return [
				['overflow-x', x],
				['overflow-y', y]
			];
		}
		case 'inset':
		case 'place-items': {
			if (p === 'place-items') {
				const [a, b = a] = split_ws(v);
				return [
					['align-items', a],
					['justify-items', b]
				];
			}
			return [[p, v]];
		}
		case 'font': {
			// "600 15px/1.4 Inter" or "bold 13px monospace"
			const out: [string, string][] = [];
			const parts = split_ws(v);
			for (const part of parts) {
				if (/^(bold|bolder|lighter|normal|\d00)$/.test(part)) out.push(['font-weight', part]);
				else if (/^[\d.]+(px|rem|em|pt)?(\/[\d.]+(px)?)?$/.test(part)) {
					const [size, lh] = part.split('/');
					out.push(['font-size', size]);
					if (lh) out.push(['line-height', lh]);
				} else if (/mono|courier|consolas|menlo/i.test(part)) out.push(['font-family', 'monospace']);
			}
			return out;
		}
		default:
			return [[p, v]];
	}
}

const num = (value: number): FacetValue => ({ kind: 'num', value });

/** A plain number ("1.5", "150%" as 1.5 when `percent`), or null when it is not one. */
function number_of(v: string, percent = false): number | null {
	const pct = percent && v.endsWith('%');
	if (!/^\d*\.?\d+$/.test(pct ? v.slice(0, -1) : v)) return null;
	const n = parseFloat(v) / (pct ? 100 : 1);
	return Number.isFinite(n) ? n : null;
}

function length_or(property: string, v: string, problems: CssProblem[]): number | null {
	const n = parse_length(v);
	if (n === null) problems.push({ property, message: `${property}: ${v} is not a length CUI can use (px, rem or a number)` });
	return n;
}

const JUSTIFY: Record<string, string> = {
	'flex-start': 'start',
	start: 'start',
	left: 'start',
	normal: 'start',
	center: 'center',
	'flex-end': 'end',
	end: 'end',
	right: 'end',
	'space-between': 'between',
	'space-around': 'around',
	'space-evenly': 'around'
};
const ALIGN: Record<string, string> = {
	'flex-start': 'start',
	start: 'start',
	'self-start': 'start',
	baseline: 'center',
	center: 'center',
	'flex-end': 'end',
	end: 'end',
	'self-end': 'end',
	stretch: 'stretch',
	normal: 'default'
};
const TEXT_ALIGN: Record<string, string> = { left: 'left', right: 'right', center: 'center', start: 'start', end: 'end', justify: 'start' };

/** Properties that take a plain length or a color, and the facet each sets. */
const LENGTH_FACET: Record<string, string> = { gap: 'gap', 'border-width': 'border', 'font-size': 'text_size' };
const COLOR_FACET: Record<string, string> = { 'background-color': 'bg', 'border-color': 'border_color', color: 'text_color' };

/** Accepted and ignored: nothing to draw differently. */
const IGNORED = new Set([
	'flex-shrink', 'justify-items', 'box-sizing', 'outline', 'outline-offset', 'user-select', '-webkit-user-select', 'pointer-events',
	'font-style', 'letter-spacing', 'text-decoration', 'text-decoration-line', 'list-style', 'list-style-type', 'appearance',
	'-webkit-appearance', 'transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'will-change',
	'content', 'resize', 'vertical-align', 'word-break', 'overflow-wrap', 'word-wrap', 'hyphens', 'scrollbar-width',
	'scroll-behavior', 'font-smoothing', '-webkit-font-smoothing', '-moz-osx-font-smoothing', 'text-rendering', 'font-feature-settings'
]);

/** Elevation for a box-shadow, by how far it floats. */
function elevation_of(v: string): string {
	if (v === 'none') return 'none';
	const lengths = (v.match(/-?[\d.]+px/g) ?? []).map((x) => Math.abs(parseFloat(x)));
	const blur = lengths[2] ?? lengths[1] ?? 0;
	if (blur >= 24) return 'floating';
	if (blur >= 8) return 'raised';
	return 'resting';
}

/**
 * Longhand -> facets. Unknown or unsupported properties land in `problems` (the caller warns
 * once per property and file); properties with no visual meaning in CUI are ignored.
 */
export function facets(property: string, value: string, problems: CssProblem[]): Facet[] {
	const v = value.trim().toLowerCase();
	const raw = value.trim();
	const out: Facet[] = [];
	const add = (name: string, fv: FacetValue | null) => {
		if (fv) out.push({ name, value: fv });
	};
	switch (property) {
		case 'padding-top':
		case 'padding-right':
		case 'padding-bottom':
		case 'padding-left':
		case 'margin-top':
		case 'margin-right':
		case 'margin-bottom':
		case 'margin-left': {
			if (v === 'auto' && property.startsWith('margin')) {
				add(`margin_auto_${property.split('-')[1]}`, { kind: 'bool', value: true });
				break;
			}
			const n = length_or(property, v, problems);
			if (n !== null) {
				const [kind, side] = property.split('-');
				if (n < 0) problems.push({ property, message: `${property}: negative values are not supported` });
				else add(`${kind === 'padding' ? 'pad' : 'margin'}_${side}`, num(n));
			}
			break;
		}
		case 'gap':
		case 'border-width':
		case 'font-size': {
			const n = length_or(property, v, problems);
			if (n !== null) add(LENGTH_FACET[property], num(n));
			break;
		}
		case 'width':
		case 'height':
		case 'flex-basis': {
			const z = parse_size(v);
			if (!z) problems.push({ property, message: `${property}: ${raw} is not a size CUI can use` });
			else add(property === 'flex-basis' ? 'basis' : property === 'width' ? 'size_w' : 'size_h', { kind: 'size', size: z });
			break;
		}
		case 'min-width':
		case 'max-width':
		case 'min-height':
		case 'max-height': {
			if (v === 'none' || v === 'auto') break;
			const n = length_or(property, v, problems);
			if (n !== null) add(property.replace('-', '_'), num(n));
			break;
		}
		case 'flex-grow': {
			const n = parseFloat(v);
			if (Number.isFinite(n)) add('grow', num(n));
			break;
		}
		case 'background-color':
		case 'border-color':
		case 'color': {
			if (property === 'background-color' && /gradient|url\(/.test(v)) {
				problems.push({ property: 'background', message: 'background: gradients and images are not supported; use a color' });
				break;
			}
			const c = parse_color(raw);
			if (!c) problems.push({ property, message: `${property}: ${raw} is not a color` });
			else add(COLOR_FACET[property], { kind: 'color', color: c });
			break;
		}
		case 'border-style':
			if (v === 'none' || v === 'hidden') add('border', num(0));
			break;
		case 'border-top-left-radius':
		case 'border-top-right-radius':
		case 'border-bottom-right-radius':
		case 'border-bottom-left-radius': {
			const corner = `radius_${property.split('-').slice(1, 3).map((x) => x[0]).join('')}`;
			if (v === '50%' || v === '9999px' || v === '999px') {
				add(corner, num(9999));
				break;
			}
			const n = length_or(property, v, problems);
			if (n !== null) add(corner, num(n));
			break;
		}
		case 'box-shadow':
			add('elevation', { kind: 'enum', value: elevation_of(v) });
			break;
		case 'opacity': {
			const n = v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
			if (Number.isFinite(n)) add('opacity', num(Math.max(0.001, Math.min(1, n))));
			break;
		}
		case 'display':
			if (v === 'none') add('display_none', { kind: 'bool', value: true });
			else if (v === 'flex' || v === 'inline-flex') add('display_flex', { kind: 'bool', value: true });
			else if (v === 'grid' || v === 'inline-grid') add('dir', { kind: 'enum', value: 'grid' });
			else if (v === 'block' || v === 'inline-block' || v === 'flow-root') add('dir', { kind: 'enum', value: 'column' });
			else if (v === 'contents' || v === 'inline') break;
			else problems.push({ property, message: `display: ${v} is not supported` });
			break;
		case 'flex-direction':
			if (v === 'row' || v === 'row-reverse') add('flex_dir', { kind: 'enum', value: 'row' });
			else if (v === 'column' || v === 'column-reverse') add('flex_dir', { kind: 'enum', value: 'column' });
			if (v.endsWith('reverse')) problems.push({ property, message: `${v} is laid out as ${v.replace('-reverse', '')}` });
			break;
		case 'flex-wrap':
			add('wrap', { kind: 'bool', value: v === 'wrap' || v === 'wrap-reverse' });
			break;
		case 'align-items':
		case 'align-content':
			if (ALIGN[v]) add('align', { kind: 'enum', value: ALIGN[v] });
			else problems.push({ property, message: `${property}: ${v} is not supported` });
			break;
		case 'justify-content':
			if (JUSTIFY[v]) add('justify', { kind: 'enum', value: JUSTIFY[v] });
			else problems.push({ property, message: `${property}: ${v} is not supported` });
			break;
		case 'grid-template-columns': {
			const rep = /^repeat\(\s*(\d+)\s*,/.exec(v);
			const auto = /^repeat\(\s*auto-(?:fill|fit)\s*,\s*minmax\(\s*([\d.]+)(?:px)?\s*,/.exec(v);
			const min = auto ? number_of(auto[1]) : null;
			if (auto && min === null) problems.push({ property, message: `grid-template-columns: ${auto[1]} is not a length` });
			else if (auto) add('min_column_width', num(min!));
			else if (rep) add('columns', num(parseInt(rep[1], 10)));
			else {
				const cols = split_ws(v).length;
				if (cols > 0) add('columns', num(cols));
				if (!/^((\d+fr|1fr|auto)\s*)+$/.test(v)) problems.push({ property, message: `grid-template-columns: CUI grids have equal columns; ${raw} is laid out as ${cols} equal columns` });
			}
			break;
		}
		case 'overflow-x':
		case 'overflow-y': {
			const axis = property.endsWith('x') ? 'x' : 'y';
			if (v === 'auto' || v === 'scroll') add(`scroll_${axis}`, { kind: 'bool', value: true });
			else if (v === 'hidden' || v === 'clip') add('clip', { kind: 'bool', value: true });
			break;
		}
		case 'direction':
			if (v === 'rtl' || v === 'ltr') add('direction', { kind: 'enum', value: v });
			break;
		// ---- text (inherited) ----
		case 'font-weight': {
			const w = v === 'bold' || v === 'bolder' ? 700 : v === 'normal' || v === 'lighter' ? 400 : parseInt(v, 10);
			add('text_weight', num(Number.isFinite(w) ? w : 400));
			break;
		}
		case 'font-family':
			if (/mono|courier|consolas|menlo|code/.test(v)) add('text_font', { kind: 'enum', value: 'mono' });
			else if (/geist|display/.test(v)) add('text_font', { kind: 'enum', value: 'display' });
			break;
		case 'text-align':
			if (TEXT_ALIGN[v]) add('text_align', { kind: 'enum', value: TEXT_ALIGN[v] });
			break;
		case 'line-height': {
			if (v === 'normal') break;
			const factor = number_of(v, true);
			const n = factor === null ? parse_length(v) : null;
			if (factor !== null) add('text_line_height', num(factor));
			else if (n !== null) add('text_line_height_px', num(n));
			else problems.push({ property, message: `line-height: ${raw} is not a number, percentage or length` });
			break;
		}
		case 'white-space':
		case 'text-wrap':
			if (v === 'nowrap' || v === 'pre') add('text_nowrap', { kind: 'bool', value: true });
			break;
		case 'text-overflow':
			if (v === 'ellipsis') add('text_nowrap', { kind: 'bool', value: true });
			break;
		case 'font-variant-numeric':
			if (v.includes('tabular-nums')) add('text_tabular', { kind: 'bool', value: true });
			break;
		case 'cursor':
			if (v === 'pointer') add('cursor_hand', { kind: 'bool', value: true });
			break;
		default:
			if (!IGNORED.has(property)) problems.push({ property, message: `${property} is not supported by CUI` });
	}
	return out;
}
