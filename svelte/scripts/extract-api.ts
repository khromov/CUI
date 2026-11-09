/**
 * Reads include/cui/cui.h and writes src/compiler/cui-api.json: every struct (fields and
 * their C types), enum, CUI_API function and component macro. The compiler's component
 * table is built on this, so the bindings follow the header instead of a hand-kept copy.
 *
 *   node scripts/extract-api.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const header = readFileSync(join(root, '..', 'include', 'cui', 'cui.h'), 'utf8');
const icons_header = readFileSync(join(root, '..', 'include', 'cui', 'cui_icons.h'), 'utf8');

export interface Field {
	name: string;
	type: string;
	array?: number;
	comment?: string;
}
export interface Param {
	name: string;
	type: string;
}
export interface Fn {
	name: string;
	ret: string;
	params: Param[];
	comment?: string;
}
export interface Macro {
	name: string;
	params: string[];
	kind: 'call' | 'scope' | 'scope_if';
	/** The function the macro calls (or the begin function of a scope). */
	fn: string;
	/** The options struct for named arguments, when the macro takes `...`. */
	opts?: string;
	end?: string;
	/** Arguments the macro passes before the options, as written (for `call` macros that fill in defaults). */
	args: string[];
}

/** Strips comments but remembers a trailing one per line, which documents struct fields. */
function strip_comments(src: string) {
	return src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(0) + m.replace(/[^\n]/g, ' '));
}

const clean = strip_comments(header);

// ---- enums -------------------------------------------------------------------------------
const enums: Record<string, { name: string; value: number }[]> = {};
const anon_enums: { name: string; value: number }[][] = [];
{
	const re = /(typedef\s+)?enum\s*(\w*)\s*\{([^}]*)\}\s*(\w*)\s*;/g;
	for (const m of clean.matchAll(re)) {
		const name = m[4] || m[2];
		const values: { name: string; value: number }[] = [];
		let next = 0;
		for (const raw of m[3].split(',')) {
			const part = raw.trim();
			if (!part) continue;
			const [k, v] = part.split('=').map((s) => s.trim());
			let value = next;
			if (v !== undefined) value = eval_int(v, values);
			values.push({ name: k, value });
			next = value + 1;
		}
		if (name) enums[name] = values;
		else anon_enums.push(values);
	}
}

function eval_int(expr: string, known: { name: string; value: number }[]): number {
	let e = expr;
	for (const k of known) e = e.replace(new RegExp(`\\b${k.name}\\b`, 'g'), String(k.value));
	// only integer literals, shifts, ors and parens remain
	if (!/^[\d\s<>|()+\-xXa-fA-F]+$/.test(e)) throw new Error(`enum value ${expr}`);
	return Function(`return (${e})`)() as number;
}

// ---- structs -----------------------------------------------------------------------------
const structs: Record<string, Field[]> = {};
{
	const lines = header.split('\n');
	const re_start = /typedef\s+struct\s+(\w+)\s*\{(.*)$/;
	for (let i = 0; i < lines.length; i++) {
		const m = re_start.exec(lines[i]);
		if (!m) continue;
		const name = m[1];
		// collect until the closing `} name;`
		let body = m[2] + '\n';
		let j = i;
		if (!new RegExp(`\\}\\s*${name}\\s*;`).test(lines[i])) {
			for (j = i + 1; j < lines.length; j++) {
				body += lines[j] + '\n';
				if (new RegExp(`\\}\\s*${name}\\s*;`).test(lines[j])) break;
			}
		}
		body = body.replace(new RegExp(`\\}\\s*${name}\\s*;[\\s\\S]*$`), '');
		structs[name] = parse_fields(body);
		i = j;
	}
}

function parse_fields(body: string): Field[] {
	const fields: Field[] = [];
	// keep trailing comments: split into declarations on ';' while tracking the comment after each
	const decls: { text: string; comment?: string }[] = [];
	let rest = body;
	while (rest.trim()) {
		const semi = find_decl_end(rest);
		if (semi < 0) break;
		const text = rest.slice(0, semi);
		rest = rest.slice(semi + 1);
		const cm = /^[ \t]*\/\*([\s\S]*?)\*\//.exec(rest);
		let comment: string | undefined;
		if (cm) {
			comment = cm[1].replace(/\s+/g, ' ').trim();
			rest = rest.slice(cm[0].length);
		}
		decls.push({ text: text.replace(/\/\*[\s\S]*?\*\//g, ' ').trim(), comment });
	}
	for (const d of decls) {
		if (!d.text) continue;
		const fnptr = /^(.*?)\(\s*\*\s*(\w+)\s*\)\s*\((.*)\)$/s.exec(d.text);
		if (fnptr) {
			fields.push({ name: fnptr[2], type: `fnptr:${fnptr[1].trim()}(${fnptr[3].replace(/\s+/g, ' ')})`, comment: d.comment });
			continue;
		}
		// "const char *a, *b" / "float x, y" / "cui_shadow s[2], t[2]"
		const m = /^((?:const\s+)?(?:unsigned\s+|signed\s+)?[\w]+(?:\s+const)?)\s*(.*)$/s.exec(d.text);
		if (!m) throw new Error(`field: ${d.text}`);
		const base = m[1].trim();
		for (const part of split_top(m[2], ',')) {
			const p = part.trim();
			const pm = /^((?:\*\s*(?:const\s*)?)*)(\w+)\s*(?:\[(\w+)\])?$/.exec(p);
			if (!pm) throw new Error(`field part: ${p} in ${d.text}`);
			const stars = pm[1].replace(/\s+/g, '');
			const type = `${base}${stars ? ' ' + stars.replace(/const/g, ' const ').replace(/\s+/g, ' ').trim() : ''}`;
			const f: Field = { name: pm[2], type: normalize_type(type), comment: d.comment };
			if (pm[3]) f.array = /^\d+$/.test(pm[3]) ? Number(pm[3]) : enum_value(pm[3]);
			fields.push(f);
		}
	}
	return fields;
}

function enum_value(name: string): number {
	for (const vs of [...Object.values(enums), ...anon_enums]) for (const v of vs) if (v.name === name) return v.value;
	throw new Error(`unknown constant ${name}`);
}

function find_decl_end(s: string) {
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '/' && s[i + 1] === '*') {
			const e = s.indexOf('*/', i + 2);
			i = e + 1;
			continue;
		}
		if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (c === ';' && depth === 0) return i;
	}
	return -1;
}

function split_top(s: string, sep: string) {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '(' || c === '[') depth++;
		else if (c === ')' || c === ']') depth--;
		else if (c === sep && depth === 0) {
			out.push(s.slice(start, i));
			start = i + 1;
		}
	}
	out.push(s.slice(start));
	return out;
}

function normalize_type(t: string) {
	return t
		.replace(/\s*\*\s*/g, ' *')
		.replace(/\*\s+const/g, '*const')
		.replace(/\s+/g, ' ')
		.replace(/ \*/g, ' *')
		.trim();
}

// ---- functions ---------------------------------------------------------------------------
const functions: Record<string, Fn> = {};
{
	const lines = header.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith('CUI_API ')) continue;
		let decl = lines[i];
		let j = i;
		while (!/\)\s*(CUI_PRINTF\([^)]*\))?\s*;/.test(strip_comments(decl)) && j < lines.length - 1) decl += ' ' + lines[++j].trim();
		// comment directly above
		let comment = '';
		for (let k = i - 1; k >= 0 && /^\s*(\/\*|\*)/.test(lines[k]) || (k >= 0 && /\*\/\s*$/.test(lines[k]) && k === i - 1); k--) {
			comment = lines[k] + '\n' + comment;
			if (/^\s*\/\*/.test(lines[k])) break;
		}
		const d = strip_comments(decl).replace(/CUI_PRINTF\([^)]*\)/, '').replace(/^CUI_API\s+/, '').trim();
		const m = /^(.*?)\b(\w+)\s*\((.*)\)\s*;\s*$/s.exec(d);
		if (!m) throw new Error(`fn: ${d}`);
		const ret = normalize_type(m[1]);
		const name = m[2];
		const params: Param[] = [];
		const plist = m[3].trim();
		if (plist && plist !== 'void') {
			for (const raw of split_top(plist, ',')) {
				const p = raw.trim().replace(/\s+/g, ' ');
				if (p === '...') {
					params.push({ name: '...', type: '...' });
					continue;
				}
				const fp = /^(.*?)\(\s*\*\s*(\w+)\s*\)\s*\((.*)\)$/.exec(p);
				if (fp) {
					params.push({ name: fp[2], type: `fnptr:${fp[1].trim()}(${fp[3]})` });
					continue;
				}
				const pm = /^(.*?)(\w+)(\s*\[\s*\])?$/.exec(p);
				if (!pm) throw new Error(`param ${p}`);
				params.push({ name: pm[2], type: normalize_type(pm[1] + (pm[3] ? ' *' : '')) });
			}
		}
		functions[name] = { name, ret, params, comment: comment.replace(/\/\*|\*\/|^\s*\*/gm, '').replace(/\s+/g, ' ').trim() || undefined };
		i = j;
	}
}

// ---- component macros --------------------------------------------------------------------
const macros: Record<string, Macro> = {};
{
	const re = /^#define\s+(cui_\w+)\(([^)]*)\)\s+(.+)$/gm;
	for (const m of header.matchAll(re)) {
		const name = m[1];
		const params = m[2].split(',').map((s) => s.trim()).filter(Boolean);
		const body = m[3].trim();
		const scope = /^CUI__SCOPE(_IF)?\((.*)\)$/.exec(body);
		if (scope) {
			const [begin, end] = split_top(scope[2], ',').map((s) => s.trim());
			const call = parse_call(begin);
			const end_call = parse_call(end);
			macros[name] = {
				name,
				params,
				kind: scope[1] ? 'scope_if' : 'scope',
				fn: call.fn,
				opts: call.opts,
				end: end_call.fn,
				args: call.args
			};
			continue;
		}
		const call = parse_call(body);
		if (!call.fn.startsWith('cui_')) continue;
		macros[name] = { name, params, kind: 'call', fn: call.fn, opts: call.opts, args: call.args };
	}
}

function parse_call(src: string): { fn: string; args: string[]; opts?: string } {
	let s = src.trim();
	s = s.replace(/^\(\(void\)\(/, '').replace(/^\(void\)/, '');
	const m = /^(\w+)\s*\((.*)\)$/s.exec(s);
	if (!m) return { fn: s, args: [] };
	const args = split_top(m[2], ',').map((a) => a.trim());
	let opts: string | undefined;
	const rest: string[] = [];
	for (const a of args) {
		const om = /^CUI__OPTS\((\w+),\s*__VA_ARGS__\)$/.exec(a);
		if (om) opts = om[1];
		else rest.push(a.replace(/^\((.*)\)$/, '$1'));
	}
	return { fn: m[1], args: rest, opts };
}

// ---- icons -------------------------------------------------------------------------------
const icons: Record<string, string> = {};
for (const m of icons_header.matchAll(/#define\s+CUI_ICON_(\w+)\s+"([^"]*)"/g)) icons[m[1]] = m[2];

const out = {
	version: /CUI_VERSION_MAJOR (\d+)[\s\S]*?CUI_VERSION_MINOR (\d+)[\s\S]*?CUI_VERSION_PATCH (\d+)/.exec(header)!.slice(1).join('.'),
	enums,
	anon_enums,
	structs,
	functions,
	macros,
	icons
};
writeFileSync(join(root, 'src', 'compiler', 'cui-api.json'), JSON.stringify(out, null, '\t') + '\n');

// ---- runtime tables: enum names and icon glyphs, for values that arrive from JS -----------
function c_unescape(s: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < s.length; i++) {
		if (s[i] === '\\' && s[i + 1] === 'x') {
			bytes.push(parseInt(s.slice(i + 2, i + 4), 16));
			i += 3;
		} else bytes.push(s.charCodeAt(i));
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}
function prefix_of(values: string[]) {
	let p = values[0];
	for (const v of values) while (!v.startsWith(p)) p = p.slice(0, -1);
	return p.slice(0, p.lastIndexOf('_') + 1);
}
const enum_table: Record<string, Record<string, number>> = {};
for (const [name, values] of Object.entries(enums)) {
	const prefix = prefix_of(values.map((v) => v.name));
	enum_table[name] = Object.fromEntries(values.map((v) => [v.name.slice(prefix.length).toLowerCase().replace(/_/g, '-'), v.value]));
}
const icon_table: Record<string, string> = {};
for (const [k, v] of Object.entries(icons)) icon_table[k.toLowerCase().replace(/_/g, '-')] = c_unescape(v);
writeFileSync(
	join(root, 'src', 'runtime', 'tables.ts'),
	`/* Generated by scripts/extract-api.ts from cui.h ${out.version}. Do not edit. */\n\n` +
		`export const ENUMS: Record<string, Record<string, number>> = ${JSON.stringify(enum_table)};\n\n` +
		`export const ICONS: Record<string, string> = ${JSON.stringify(icon_table)};\n`
);
console.log(
	`cui ${out.version}: ${Object.keys(structs).length} structs, ${Object.keys(enums).length} enums, ` +
		`${Object.keys(functions).length} functions, ${Object.keys(macros).length} macros, ${Object.keys(icons).length} icons`
);
