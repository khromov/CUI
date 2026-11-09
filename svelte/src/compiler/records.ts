/**
 * Record descriptors: how a C struct is packed by JS (helpers.pack) and unpacked by the
 * runtime (cuisv_records.c). Generated from cui-api.json, emitted once per component file.
 */
import { api, is_enum, type Field } from './api.ts';

const KIND_C: Record<string, string> = {
	s: 'CUISV_F_STR',
	o: 'CUISV_F_STR',
	I: 'CUISV_F_STR',
	P: 'CUISV_F_VEC2S',
	b: 'CUISV_F_BOOL',
	i: 'CUISV_F_I32',
	u: 'CUISV_F_U32',
	f: 'CUISV_F_F32',
	d: 'CUISV_F_F64',
	l: 'CUISV_F_I64',
	c: 'CUISV_F_COLOR',
	z: 'CUISV_F_SIZE',
	D: 'CUISV_F_DATE',
	t: 'CUISV_F_TEXTURE',
	n: 'CUISV_F_NAMED_ID',
	F: 'CUISV_F_FLOATS',
	S: 'CUISV_F_STRS',
	'{': 'CUISV_F_STRUCT'
};

/** Field types packed as one value, and their kind. */
const SCALAR_KIND = new Map(Object.entries({ bool: 'b', int: 'i', uint32_t: 'u', unsigned: 'u', cui_id: 'n', float: 'f', double: 'd', int64_t: 'l', uint64_t: 'l', cui_color: 'c', cui_size: 'z', cui_date: 'D', cui_texture: 't' }));
/** Pointer field types packed as an array, with the count field that follows them. */
const ARRAY_KIND = new Map(Object.entries({ 'const cui_vec2 *': 'P', 'const float *': 'F', 'float *': 'F', 'const char *const *': 'S', 'const char **': 'S' }));

interface FieldKind {
	field: Field;
	kind: string;
	/** Enum type for 'i', nested struct for '{'. */
	extra?: string;
	/** Name of the count field for F/S. */
	count?: string;
}

/** The descriptor fields of a struct, or null when it cannot be a record. */
export function record_fields(type: string): FieldKind[] | null {
	const fields = api.structs[type];
	if (!fields) return null;
	const out: FieldKind[] = [];
	const consumed = new Set<string>();
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i];
		if (f.name === '_' || consumed.has(f.name)) continue;
		if (f.array) continue;
		// the count after an array (scatter points and sizes share one, after both)
		const count_field = fields.slice(i + 1).find((x) => (x.type === 'int' || x.type === 'size_t') && /count|^n$|len|num/.test(x.name));
		const t = f.type;
		let k: FieldKind | null = null;
		if (t === 'const char *' || t === 'char *') k = { field: f, kind: /icon/.test(f.name) ? 'I' : /^(title|name|label|text)$/.test(f.name) ? 's' : 'o' };
		else if (ARRAY_KIND.has(t) && count_field) {
			k = { field: f, kind: ARRAY_KIND.get(t)!, count: count_field.name };
			consumed.add(count_field.name);
		} else if (SCALAR_KIND.has(t)) k = { field: f, kind: SCALAR_KIND.get(t)! };
		else if (is_enum(t)) k = { field: f, kind: 'i', extra: t };
		else if (t in api.structs && record_fields(t)) k = { field: f, kind: '{', extra: t };
		if (k) out.push(k);
	}
	return out;
}

/** Collects the C descriptors a component needs, in dependency order. */
export class Records {
	private c = new Map<string, string>();

	/** Types whose JS value is a scalar wrapped as { value }: a date string, a color. */
	static WRAPPED: Record<string, string> = { cui_date: 'D', cui_color: 'c' };

	/** C expression `&cuisv_sd_<type>` for a struct, emitting its descriptor once. */
	c_desc(type: string): string {
		const name = `cuisv_sd_${type}`;
		if (this.c.has(type)) return `&${name}`;
		this.c.set(type, '');
		let body: string;
		const wrapped = Records.WRAPPED[type];
		if (wrapped) {
			body = `static const cuisv_field cuisv_fd_${type}[] = { { ${KIND_C[wrapped]}, 0, -1, NULL } };\nstatic const cuisv_struct_desc ${name} = { sizeof(${type}), 1, cuisv_fd_${type} };`;
		} else {
			const fields = record_fields(type) ?? [];
			for (const f of fields) if (f.kind === '{' && f.extra) this.c_desc(f.extra);
			const lines = fields.map(
				(f) =>
					`    { ${KIND_C[f.kind]}, (uint16_t)offsetof(${type}, ${f.field.name}), ${f.count ? `(int16_t)offsetof(${type}, ${f.count})` : '-1'}, ${f.kind === '{' ? `&cuisv_sd_${f.extra}` : 'NULL'} },`
			);
			body = `static const cuisv_field cuisv_fd_${type}[] = {\n${lines.join('\n') || '    { 0, 0, -1, NULL },'}\n};\nstatic const cuisv_struct_desc ${name} = { sizeof(${type}), ${fields.length}, cuisv_fd_${type} };`;
		}
		// re-insert so dependencies come first
		this.c.delete(type);
		this.c.set(type, body);
		return `&${name}`;
	}

	/** The JS descriptor literal for helpers.pack / unpack. */
	static js_desc(type: string): string {
		const wrapped = Records.WRAPPED[type];
		if (wrapped) return `[["value","${wrapped}"]]`;
		const fields = record_fields(type) ?? [];
		return (
			'[' +
			fields
				.map((f) => {
					if (f.kind === '{') return `[${JSON.stringify(f.field.name)},"{",${Records.js_desc(f.extra!)}]`;
					if (f.extra) return `[${JSON.stringify(f.field.name)},"${f.kind}",${JSON.stringify(f.extra)}]`;
					return `[${JSON.stringify(f.field.name)},"${f.kind}"]`;
				})
				.join(',') +
			']'
		);
	}

	preamble(): string {
		return [...this.c.values()].join('\n');
	}
}
