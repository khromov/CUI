/**
 * Conversions the skeletons apply to dynamic values before they reach C: enum names to
 * numbers, CSS colors and sizes to their packed forms, icon names to glyphs. Imported by
 * every compiled component as `__cuisv_h`.
 */
import { ENUMS, ICONS } from './tables.ts';
import { parse_color, pack_color, parse_size, pack_size, parse_length } from '../shared/values.ts';

const warned = new Set<string>();
function warn_once(msg: string) {
	if (warned.has(msg)) return;
	warned.add(msg);
	console.warn(`cui-svelte: ${msg}`);
}

/** {expression} in text: what Svelte shows for it (nothing for null and undefined). */
export function t(v: unknown): string {
	return v == null ? '' : String(v);
}

/** "primary" -> CUI_BUTTON_PRIMARY's value; numbers pass through. */
export function en(value: unknown, type: string): number | undefined {
	if (value == null) return undefined;
	if (typeof value === 'number') return value;
	const table = ENUMS[type];
	const key = String(value).trim().toLowerCase().replace(/[\s_]/g, '-');
	const n = table?.[key];
	if (n === undefined) {
		warn_once(`"${value}" is not a ${type.replace(/^cui_/, '')} (one of ${Object.keys(table ?? {}).join(', ')})`);
		return undefined;
	}
	return n;
}

/** A CSS color (or theme token name) packed as 0xRRGGBBAA. */
export function color(value: unknown): number | undefined {
	if (value == null || value === false) return undefined;
	const c = parse_color(value);
	if (!c) {
		warn_once(`${JSON.stringify(value)} is not a color`);
		return undefined;
	}
	return pack_color(c);
}

/** A size (240, "50%", "fill", "fit") packed for cuisv_size. */
export function size(value: unknown): number | undefined {
	if (value == null || value === false) return undefined;
	const z = parse_size(value);
	if (!z) {
		warn_once(`${JSON.stringify(value)} is not a size`);
		return undefined;
	}
	return pack_size(z);
}

export function length(value: unknown): number | undefined {
	if (value == null || value === false) return undefined;
	const n = parse_length(value);
	return n === null ? undefined : n;
}

/** An icon name ("check", "trash-2") to its glyph; other strings pass through. */
export function icon(value: unknown): string | undefined {
	if (value == null || value === false || value === '') return undefined;
	const s = String(value);
	const key = s.trim().replace(/([a-z])([A-Z0-9])/g, '$1-$2').replace(/[_\s]/g, '-').toLowerCase();
	return ICONS[key] ?? s;
}

export function icons(value: unknown): string[] | undefined {
	if (value == null) return undefined;
	return Array.from(value as ArrayLike<unknown>, (v) => icon(v) ?? '');
}

/** Images from load_image() are handles already. */
export function texture(value: unknown): number | undefined {
	if (value == null || value === false) return undefined;
	if (typeof value === 'number') return value;
	const h = (value as { handle?: number }).handle;
	return typeof h === 'number' ? h : undefined;
}

/** Whether a class value (string, array or object, as Svelte accepts) contains `name`. */
export function has_class(value: unknown, name: string): boolean {
	if (value == null || value === false) return false;
	if (typeof value === 'string') return value.split(/\s+/).includes(name);
	if (Array.isArray(value)) return value.some((v) => has_class(v, name));
	if (typeof value === 'object') return !!(value as Record<string, unknown>)[name];
	return false;
}

/**
 * Handlers written for the DOM (oninput={(e) => x = e.target.value}) get an event-like
 * object; the value is under `prop` (value, checked) on target and currentTarget.
 */
export function dom_event(handler: unknown, prop: string) {
	if (typeof handler !== 'function') return handler;
	return (value: unknown) => {
		const target = { [prop]: value, value: prop === 'checked' ? 'on' : value };
		(handler as (e: unknown) => void)({ type: 'input', target, currentTarget: target, preventDefault() {}, stopPropagation() {} });
	};
}

/** Click handlers written for the DOM get an event-like object. */
export function dom_click(handler: unknown, type: string) {
	if (typeof handler !== 'function') return handler;
	return () => {
		const target = {};
		(handler as (e: unknown) => void)({ type, target, currentTarget: target, button: type === 'contextmenu' ? 2 : 0, preventDefault() {}, stopPropagation() {} });
	};
}

// ---- records: arrays of objects packed for C structs ------------------------------------
//
// A descriptor lists the struct's fields in C order: [name, kind, extra?]. Kinds:
// s string, o optional string (left out: NULL), I icon, P point[] ({x,y} or [x,y]), b bool, i int (extra: enum type), u uint, f float, d double, l int64,
// c color, z size, D date, t texture, n element id (by name), F number[], S string[],
// { nested struct (extra: its descriptor), x skipped.

export type FieldDesc = [string, string, (string | FieldDesc[])?];

class Writer {
	buf = new Uint8Array(256);
	view = new DataView(this.buf.buffer);
	len = 0;
	need(n: number) {
		if (this.len + n <= this.buf.length) return;
		const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n + 64));
		next.set(this.buf.subarray(0, this.len));
		this.buf = next;
		this.view = new DataView(next.buffer);
	}
	u8(v: number) {
		this.need(1);
		this.buf[this.len++] = v;
	}
	u32(v: number) {
		this.need(4);
		this.view.setUint32(this.len, v >>> 0, true);
		this.len += 4;
	}
	i32(v: number) {
		this.need(4);
		this.view.setInt32(this.len, v | 0, true);
		this.len += 4;
	}
	f32(v: number) {
		this.need(4);
		this.view.setFloat32(this.len, v, true);
		this.len += 4;
	}
	f64(v: number) {
		this.need(8);
		this.view.setFloat64(this.len, v, true);
		this.len += 8;
	}
	str(s: string) {
		const b = utf8(s);
		this.u32(b.length);
		this.need(b.length);
		this.buf.set(b, this.len);
		this.len += b.length;
	}
}

let encoder: { encode(s: string): Uint8Array } | null = null;
let decoder: { decode(b: Uint8Array): string } | null = null;
function utf8(s: string): Uint8Array {
	encoder ??= new TextEncoder();
	return encoder.encode(s);
}

/** A cui_date from "2026-11-09", a Date or { year, month, day }. */
export function date_parts(v: unknown): [number, number, number] {
	if (v == null || v === '') return [0, 0, 0];
	if (v instanceof Date) return [v.getFullYear(), v.getMonth() + 1, v.getDate()];
	if (typeof v === 'string') {
		const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
		return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
	}
	const o = v as { year?: number; month?: number; day?: number };
	return [o.year ?? 0, o.month ?? 0, o.day ?? 0];
}

export function date_string(y: number, m: number, d: number): string {
	if (!y) return '';
	return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function write_fields(w: Writer, o: Record<string, unknown>, desc: FieldDesc[]) {
	for (const [name, kind, extra] of desc) {
		const v = o?.[name];
		switch (kind) {
			case 's':
				w.str(v == null ? '' : String(v));
				break;
			case 'o':
				if (v == null || v === '' || v === false) w.u32(0xffffffff);
				else w.str(String(v));
				break;
			case 'I': {
				const g = icon(v);
				if (g === undefined) w.u32(0xffffffff);
				else w.str(g);
				break;
			}
			case 'P': {
				const a = v == null ? [] : (v as ArrayLike<unknown>);
				w.u32(a.length);
				for (let i = 0; i < a.length; i++) {
					const pt = a[i] as number[] | { x: number; y: number };
					w.f32(Array.isArray(pt) ? Number(pt[0]) || 0 : Number(pt?.x) || 0);
					w.f32(Array.isArray(pt) ? Number(pt[1]) || 0 : Number(pt?.y) || 0);
				}
				break;
			}
			case 'n':
				w.str(v == null ? '' : String(v));
				break;
			case 'b':
				w.u8(v ? 1 : 0);
				break;
			case 'i':
				w.i32(typeof extra === 'string' ? (en(v, extra) ?? 0) : Number(v) || 0);
				break;
			case 'u':
				w.u32(Number(v) || 0);
				break;
			case 'f':
				w.f32(Number(v) || 0);
				break;
			case 'd':
			case 'l':
				w.f64(Number(v) || 0);
				break;
			case 'c':
				w.u32(v == null ? 0 : (color(v) ?? 0));
				break;
			case 'z':
				w.f64(v == null ? 0 : (size(v) ?? 0));
				break;
			case 'D': {
				const [y, m, d] = date_parts(v);
				w.i32(y);
				w.i32(m);
				w.i32(d);
				break;
			}
			case 't':
				w.f64(texture(v) ?? 0);
				break;
			case 'F': {
				const a = v == null ? [] : (v as ArrayLike<number>);
				w.u32(a.length);
				for (let i = 0; i < a.length; i++) w.f32(Number(a[i]) || 0);
				break;
			}
			case 'S': {
				const a = v == null ? [] : (v as ArrayLike<unknown>);
				w.u32(a.length);
				for (let i = 0; i < a.length; i++) w.str(String(a[i] ?? ''));
				break;
			}
			case '{':
				write_fields(w, (v ?? {}) as Record<string, unknown>, extra as FieldDesc[]);
				break;
		}
	}
}

/** Packs an array of objects (or one object, for a bound struct) for C. */
export function pack(items: unknown, desc: FieldDesc[]): Uint8Array | undefined {
	if (items == null) return undefined;
	const list = Array.isArray(items) || ArrayBuffer.isView(items) ? (items as ArrayLike<unknown>) : [items];
	const w = new Writer();
	w.u32(list.length);
	for (let i = 0; i < list.length; i++) write_fields(w, (list[i] ?? {}) as Record<string, unknown>, desc);
	return w.buf.slice(0, w.len);
}

const ENUM_NAMES = new Map<string, Map<number, string>>();
function enum_name(type: string, n: number): string | number {
	let m = ENUM_NAMES.get(type);
	if (!m) {
		m = new Map(Object.entries(ENUMS[type] ?? {}).map(([k, v]) => [v, k]));
		ENUM_NAMES.set(type, m);
	}
	return m.get(n) ?? n;
}

function hex(n: number) {
	return n.toString(16).padStart(2, '0');
}

/** The reverse of pack: what C sent back (a dragged gantt task, a picked date). */
export function unpack(bytes: Uint8Array, desc: FieldDesc[]): Record<string, unknown>[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let p = 0;
	decoder ??= new TextDecoder();
	const str = () => {
		const n = view.getUint32(p, true);
		p += 4;
		if (n === 0xffffffff) return undefined;
		const s = decoder!.decode(bytes.subarray(p, p + n));
		p += n;
		return s;
	};
	const read = (d: FieldDesc[]): Record<string, unknown> => {
		const o: Record<string, unknown> = {};
		for (const [name, kind, extra] of d) {
			switch (kind) {
				case 's':
				case 'o':
				case 'I':
				case 'n':
					o[name] = str();
					break;
				case 'P': {
					const n = view.getUint32(p, true);
					p += 4;
					const a: { x: number; y: number }[] = [];
					for (let i = 0; i < n; i++, p += 8) a.push({ x: view.getFloat32(p, true), y: view.getFloat32(p + 4, true) });
					o[name] = a;
					break;
				}
				case 'b':
					o[name] = bytes[p++] !== 0;
					break;
				case 'i': {
					const v = view.getInt32(p, true);
					p += 4;
					o[name] = typeof extra === 'string' ? enum_name(extra, v) : v;
					break;
				}
				case 'u':
					o[name] = view.getUint32(p, true);
					p += 4;
					break;
				case 'f':
					o[name] = Math.round(view.getFloat32(p, true) * 1e5) / 1e5;
					p += 4;
					break;
				case 'd':
				case 'l':
				case 't':
				case 'z':
					o[name] = view.getFloat64(p, true);
					p += 8;
					break;
				case 'c': {
					const c = view.getUint32(p, true);
					p += 4;
					o[name] = `#${hex(c >>> 24)}${hex((c >>> 16) & 255)}${hex((c >>> 8) & 255)}${(c & 255) === 255 ? '' : hex(c & 255)}`;
					break;
				}
				case 'D': {
					const y = view.getInt32(p, true), m = view.getInt32(p + 4, true), dd = view.getInt32(p + 8, true);
					p += 12;
					o[name] = date_string(y, m, dd);
					break;
				}
				case 'F': {
					const n = view.getUint32(p, true);
					p += 4;
					const a: number[] = [];
					for (let i = 0; i < n; i++, p += 4) a.push(view.getFloat32(p, true));
					o[name] = a;
					break;
				}
				case 'S': {
					const n = view.getUint32(p, true);
					p += 4;
					const a: string[] = [];
					for (let i = 0; i < n; i++) a.push(str() ?? '');
					o[name] = a;
					break;
				}
				case '{':
					o[name] = read(extra as FieldDesc[]);
					break;
			}
		}
		return o;
	};
	const n = view.getUint32(0, true);
	p = 4;
	const out: Record<string, unknown>[] = [];
	for (let i = 0; i < n; i++) out.push(read(desc));
	return out;
}

/**
 * Bound structs as friendly JS values. A date ("YYYY-MM-DD") and a color (hex) travel as a
 * one-field record ({ value }); other structs are plain objects with the C field names.
 */
export function to_record(type: string, v: unknown): unknown {
	if (type === 'cui_date' || type === 'cui_color') return { value: v };
	return v ?? {};
}

export function from_record(type: string, o: Record<string, unknown> | undefined): unknown {
	if (!o) return undefined;
	if (type === 'cui_date' || type === 'cui_color') return o.value;
	return o;
}

/** For a bound struct's setter: bytes from C to the JS value. */
export function record_value(bytes: Uint8Array, desc: FieldDesc[], type: string): unknown {
	return from_record(type, unpack(bytes, desc)[0]);
}

/** A bool array for C (multi select, toggle group). */
export function bools(v: unknown): Uint8Array | undefined {
	if (v == null) return undefined;
	return Uint8Array.from(v as ArrayLike<unknown>, (x) => (x ? 1 : 0));
}

/**
 * CUI changed records it was given (a dragged gantt task): copy the C fields into the objects
 * the app owns, so fields C does not know about survive; replace the array when the shape
 * changed.
 */
export function merge(target: unknown, items: Record<string, unknown>[], set: (v: unknown) => void) {
	if (Array.isArray(target) && target.length === items.length) {
		for (let i = 0; i < items.length; i++) {
			const t = target[i];
			if (t && typeof t === 'object') {
				for (const [k, v] of Object.entries(items[i])) if ((t as Record<string, unknown>)[k] !== v) (t as Record<string, unknown>)[k] = v;
			} else target[i] = items[i];
		}
		return;
	}
	set(items);
}

/** An image for a component: a path, or { src } / { path }. */
export function image_src(v: unknown): string | undefined {
	if (v == null || v === false) return undefined;
	if (typeof v === 'string') return v;
	const o = v as { src?: string; path?: string };
	return o.src ?? o.path;
}

/** The row indices a row window renders: what CUI shows, and `overscan` rows around it. */
export function rows(win: [number, number], count: number, overscan = 24): number[] {
	const n = Math.max(0, Number(count) || 0);
	const a = Math.max(0, Math.min(n, (win?.[0] ?? 0) - overscan));
	const b = Math.max(a, Math.min(n, Math.max(win?.[1] ?? 0, a + 1) + overscan));
	const out: number[] = [];
	for (let i = a; i < b; i++) out.push(i);
	return out;
}

/** uint32 masks for C (filter bar selections), little endian like the rest. */
export function u32s(v: unknown): Uint8Array | undefined {
	if (v == null) return undefined;
	const a = Uint32Array.from(v as ArrayLike<number>, (x) => Number(x) >>> 0);
	return new Uint8Array(a.buffer);
}

/** A host object (LogBuffer, TerminalBuffer) to its handle. */
export function handle(v: unknown): number | undefined {
	if (v == null) return undefined;
	if (typeof v === 'number') return v;
	return (v as { handle?: number }).handle;
}

/** The node indices a tree table renders rows for (what CUI showed last frame). */
export function node_rows(v: unknown): number[] {
	return Array.isArray(v) ? (v as number[]) : [];
}
