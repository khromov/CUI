/**
 * Writes src/runtime/components.ts: one export per CUI component, typed from the specs, so
 * `import { Button } from 'cui-svelte'` resolves and svelte-check knows every prop, event and
 * which props bind. The values are placeholders: the compiler turns every use into C.
 *
 *   node scripts/gen-components.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SPECS, bind_kind, type Spec, type EventSpec } from '../src/compiler/specs.ts';
import { api, enum_names, is_enum } from '../src/compiler/api.ts';
import { record_fields } from '../src/compiler/records.ts';
import { HTML_GLOBAL_PROPS } from '../src/compiler/props.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const structs = new Map<string, string>();

/** A TypeScript name for a C struct used as a record: cui_grid_column -> GridColumn. */
function struct_name(t: string) {
	return t.replace(/^cui_/, '').replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
}

/** The JS shape of a struct, as an interface emitted once. */
function struct_type(t: string): string {
	if (t === 'cui_date') return 'DateString';
	if (t === 'cui_color') return 'Color';
	const name = struct_name(t);
	if (structs.has(name)) return name;
	structs.set(name, '');
	const lines = (record_fields(t) ?? []).map((f) => {
		let ty = 'unknown';
		switch (f.kind) {
			case 's':
			case 'o':
				ty = 'string';
				break;
			case 'I':
				ty = 'IconName | (string & {})';
				break;
			case 'n':
				ty = 'string';
				break;
			case 'b':
				ty = 'boolean';
				break;
			case 'i':
				ty = f.extra ? enum_type(f.extra) : 'number';
				break;
			case 'u':
			case 'f':
			case 'd':
			case 'l':
			case 't':
				ty = 'number';
				break;
			case 'c':
				ty = 'Color';
				break;
			case 'z':
				ty = 'Size';
				break;
			case 'D':
				ty = 'DateString';
				break;
			case 'F':
				ty = 'ArrayLike<number>';
				break;
			case 'S':
				ty = 'string[]';
				break;
			case 'P':
				ty = '({ x: number; y: number } | [number, number])[]';
				break;
			case '{':
				ty = struct_type(f.extra!);
				break;
		}
		const c = f.field.comment ? `\t/** ${f.field.comment.replace(/\*\//g, '* /')} */\n` : '';
		return `${c}\t${f.field.name}?: ${ty};`;
	});
	structs.set(name, `/** ${t} */\nexport interface ${name} {\n${lines.join('\n')}\n}`);
	return name;
}

function enum_type(e: string) {
	return enum_names(e).map((n) => JSON.stringify(n)).join(' | ') + ' | (string & {}) | number';
}

function ts_type(type: string, name: string): string | null {
	if (type === 'bool') return 'boolean';
	if (['float', 'double', 'int', 'size_t', 'uint32_t', 'uint8_t', 'int64_t', 'uint64_t', 'cui_id'].includes(type)) return 'number';
	if (type === 'const char *') return /icon/.test(name) ? 'IconName | (string & {})' : 'string';
	if (is_enum(type)) return enum_type(type);
	if (type === 'cui_size') return 'Size';
	if (type === 'cui_color') return 'Color';
	if (type === 'cui_texture') return 'string | ImageRef';
	if (type === 'cui_font') return '"body" | "medium" | "display" | "mono" | number';
	if (type === 'const char *const *') return /icon/.test(name) ? '(IconName | (string & {}))[]' : 'string[]';
	if (type === 'const float *') return 'ArrayLike<number>';
	return null;
}

const payload_ts = (e: EventSpec, value_type: string) =>
	!e.payload ? '' : e.payload.type === 'bool' ? 'value: boolean' : e.payload.type === 'str' ? 'value: string' : e.payload.type === 'num' ? 'value: number' : e.payload.type === 'json' ? 'value: any' : `value: ${value_type}`;

/** Hand-written props of components whose C is not one call (special.ts). */
const CUSTOM: Record<string, { props: string[]; bindable: string[] }> = {
	Canvas: {
		props: [
			'width?: Size;',
			'height?: Size;',
			'/** A C function from <script lang="c">: void name(cui_ctx *ui, cui_rect r, const float *data, int n). */',
			'paint?: string;',
			'/** Draw in JS (runs while CUI paints the frame). */',
			'onpaint?: (g: Painter) => void;',
			'/** Numbers handed to a C paint function (up to 64). */',
			'data?: ArrayLike<number>;',
			'onclick?: (x: number, y: number) => void;',
			'/** While the pointer is held down over the canvas, with its position in the canvas. */',
			'onpress?: (x: number, y: number) => void;',
			'onhover?: (x: number, y: number) => void;',
			'id?: string;'
		],
		bindable: []
	},
	VirtualList: {
		props: ['count: number;', 'row_height?: number;', 'height?: Size;', '/** Rows rendered around the visible ones (default 24). */', 'overscan?: number;', 'row: Snippet<[number]>;', 'id?: string;'],
		bindable: []
	},
	DataGrid: {
		props: [
			'count: number;',
			'columns: GridColumn[];',
			'row: Snippet<[number]>;',
			'/** One boolean per row; adds a checkbox column. */',
			'selected?: boolean[];',
			'sort?: { column: number; descending: boolean };',
			'cursor?: number;',
			'anchor?: number;',
			'onrowclick?: (row: number) => void;',
			'overscan?: number;',
			'id?: string;'
		],
		bindable: ['selected', 'sort', 'cursor', 'anchor']
	},
	TreeTable: {
		props: [
			'columns: GridColumn[];',
			'/** The tree: parent / first_child / next_sibling indices and CUI_TREE_* flags (1 has children, 2 open, 4 selected, 8 loading). */',
			'nodes: TreeNode[];',
			'row: Snippet<[number]>;',
			'cursor?: number;',
			'onactivate?: (node: number) => void;',
			'onexpand?: (node: number) => void;',
			'oncollapse?: (node: number) => void;',
			'onload?: (node: number) => void;',
			'onselectionchange?: () => void;',
			'onsort?: () => void;',
			'id?: string;'
		],
		bindable: ['nodes', 'cursor']
	},
	Popover: { props: ['open?: boolean;', 'onchange?: (open: boolean) => void;', 'children?: Snippet;', 'id?: string;'], bindable: ['open'] },
	Reorder: { props: ['/** Item indices in display order. */', 'order: number[];', 'onchange?: () => void;', 'children?: Snippet;', 'id?: string;'], bindable: ['order'] },
	OtpInput: { props: ['value?: string;', 'length?: number;', 'oncomplete?: (code: string) => void;', 'id?: string;'], bindable: ['value'] },
	GridCell: { props: ['/** Editable text: double click or Enter edits, Enter commits. */', 'value?: string;', 'children?: Snippet;'], bindable: ['value'] },
	TableCell: { props: ['children?: Snippet;'], bindable: [] }
};

function props_of(spec: Spec): { lines: string[]; bindable: string[] } {
	const lines: string[] = [];
	const bindable: string[] = [];
	const seen = new Set<string>();
	const add = (name: string, type: string, doc?: string, required = false) => {
		if (seen.has(name)) return;
		seen.add(name);
		if (doc) lines.push(`\t/** ${doc.replace(/\*\//g, '* /')} */`);
		lines.push(`\t${/^[a-z_][a-z0-9_]*$/i.test(name) ? name : JSON.stringify(name)}${required ? '' : '?'}: ${type};`);
	};
	let value_type = 'unknown';
	for (const p of spec.params) {
		const T = p.type.replace(/^const /, '').replace(/ \*$/, '');
		switch (p.role) {
			case 'id':
				add('id', 'string', 'Identity for the state CUI keeps (scroll position, focus); findable with rect_of. Generated when left out.');
				break;
			case 'label':
			case 'text':
				add(p.prop, 'string');
				break;
			case 'icon':
				add(p.prop, 'IconName | (string & {})');
				break;
			case 'value': {
				const t = ts_type(p.type, p.name);
				if (t) add(p.prop, t);
				break;
			}
			case 'texture':
				add(p.prop, 'string | ImageRef', 'An image file path.');
				break;
			case 'bind': {
				const k = bind_kind(p.type);
				value_type = k === 'bool' ? 'boolean' : 'number';
				add(p.prop, value_type);
				bindable.push(p.prop);
				break;
			}
			case 'buffer':
				value_type = 'string';
				add(p.prop, 'string');
				bindable.push(p.prop);
				break;
			case 'strs':
				add(p.prop, /icon/.test(p.name) ? '(IconName | (string & {}))[]' : 'string[]');
				break;
			case 'floats':
				add(p.prop, 'ArrayLike<number>');
				break;
			case 'records':
				add(p.prop, `${struct_type(T)}[]`);
				break;
			case 'record':
				add(p.prop, struct_type(T));
				break;
			case 'records_mut':
			case 'records_cap':
				value_type = `${struct_type(T)}[]`;
				add(p.prop, value_type);
				bindable.push(p.prop);
				if (p.role === 'records_cap') add('capacity', 'number', 'Most items the editor may create.');
				break;
			case 'bind_struct':
				value_type = struct_type(T);
				add(p.prop, value_type);
				bindable.push(p.prop);
				break;
			case 'struct_value':
				add(p.prop, struct_type(T));
				break;
			case 'bind_bools':
				value_type = 'boolean[]';
				add(p.prop, 'boolean[]');
				bindable.push(p.prop);
				break;
			case 'bind_floats':
				value_type = 'number[]';
				add(p.prop, 'number[]');
				bindable.push(p.prop);
				break;
			case 'bind_u32s':
				value_type = 'number[]';
				add(p.prop, 'number[]', 'One bit mask of chosen options per field.');
				bindable.push(p.prop);
				break;
			case 'host_object':
				add(p.prop, p.type.includes('log') ? 'LogBuffer' : 'TerminalBuffer');
				break;
			case 'bytes':
				add(p.prop, 'Uint8Array');
				break;
		}
	}
	for (const [name, f] of spec.fields) {
		if (f.array) continue;
		if (f.type.endsWith(' *') && !f.type.startsWith('const ')) {
			const k = bind_kind(f.type);
			const T = f.type.slice(0, -2);
			const t = k ? (k === 'bool' ? 'boolean' : 'number') : T in api.structs ? struct_type(T) : null;
			if (t) {
				add(name, t, f.comment);
				bindable.push(name);
			}
			continue;
		}
		const t = ts_type(f.type, f.name);
		if (t) add(name, t, f.comment);
	}
	for (const e of [...spec.events, ...(spec.end_events ?? []), ...(spec.before_end?.events ?? [])]) add(e.name, `(${payload_ts(e, value_type)}) => void`);
	for (const [name, type] of Object.entries(HTML_GLOBAL_PROPS)) add(name, type);
	if (spec.children !== 'none') add('children', 'Snippet');
	return { lines, bindable };
}

const out: string[] = [];
const body: string[] = [];
for (const spec of SPECS.values()) {
	const custom = CUSTOM[spec.name];
	let lines: string[];
	let bindable: string[];
	if (custom) {
		if (spec.name === 'DataGrid' || spec.name === 'TreeTable') {
			struct_type('cui_grid_column');
			struct_type('cui_tree_node');
		}
		const generated = props_of(spec);
		const own = new Set(custom.props.map((p) => /^(\w+)\??:/.exec(p)?.[1]).filter(Boolean));
		lines = [
			...custom.props.map((p) => '\t' + p),
			// option fields the custom emitter also takes
			...generated.lines.filter((l) => {
				const m = /^\t"?(\w+)"?\??:/.exec(l);
				return m && !own.has(m[1]) && !/^on/.test(m[1]) && !['children', 'id'].includes(m[1]);
			})
		];
		bindable = custom.bindable;
	} else ({ lines, bindable } = props_of(spec));
	body.push('');
	body.push(`export interface ${spec.name}Props {`);
	body.push(...lines);
	body.push('}');
	if (spec.doc) body.push(`/** ${spec.doc.replace(/\*\//g, '* /')} */`);
	const b = bindable.length ? bindable.map((x) => JSON.stringify(x)).join(' | ') : "''";
	body.push(`export const ${spec.name}: Component<${spec.name}Props, {}, ${b}> = intrinsic(${JSON.stringify(spec.name)});`);
}
out.push(`/* Generated by scripts/gen-components.ts from the component specs (cui ${api.version}). Do not edit. */`);
out.push("import type { Component, Snippet } from 'svelte';");
out.push("import type { Color, IconName, ImageRef, Size } from './types.ts';");
out.push("import type { Painter } from './painter.ts';");
out.push("import type { LogBuffer, TerminalBuffer } from './host.ts';");
out.push('');
out.push('/** A date as "YYYY-MM-DD". */');
out.push('export type DateString = string;');
out.push('');
out.push(...[...structs.values()].filter(Boolean).flatMap((s) => [s, '']));
out.push('function intrinsic(name: string): never {');
out.push('\tconst c = () => {');
out.push('\t\tthrow new Error(`cui-svelte: <${name}> is compiled to C where it is written, so it cannot be passed around as a value`);');
out.push('\t};');
out.push("\tObject.defineProperty(c, 'name', { value: name });");
out.push('\treturn c as never;');
out.push('}');
out.push(...body);
writeFileSync(join(root, 'src', 'runtime', 'components.ts'), out.join('\n') + '\n');
console.log(`${SPECS.size} components, ${structs.size} record types -> src/runtime/components.ts`);
