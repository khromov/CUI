/**
 * <script lang="c">: C that goes into the component's C file. Functions marked cuisv_export
 * become callable from JS (`native.name(…)` from cui-svelte); any function can paint a
 * <Canvas paint="name">.
 *
 *   <script lang="c">
 *     #include <math.h>
 *     cuisv_export double distance(double x, double y) { return sqrt(x * x + y * y); }
 *   </script>
 */

export interface NativeFn {
	name: string;
	ret: string;
	params: { type: string; name: string }[];
}

export interface CBlocks {
	/** The source with the C blocks blanked out (offsets kept), for Svelte to parse. */
	source: string;
	code: string;
	exports: NativeFn[];
}

const TYPES: Record<string, 'num' | 'int' | 'bool' | 'str' | 'void'> = {
	double: 'num',
	float: 'num',
	int: 'int',
	long: 'int',
	unsigned: 'int',
	int32_t: 'int',
	uint32_t: 'int',
	int64_t: 'num',
	bool: 'bool',
	'const char *': 'str',
	'char *': 'str',
	void: 'void'
};

function norm(t: string) {
	return t.replace(/\s+/g, ' ').replace(/\s*\*\s*/g, ' *').trim();
}

export function extract_c(source: string, sibling?: string): CBlocks {
	let code = sibling ? `${sibling}\n` : '';
	const out = source.replace(/<script\b([^>]*)\blang\s*=\s*["']c["']([^>]*)>([\s\S]*?)<\/script\s*>/g, (m, _a, _b, body: string) => {
		code += body + '\n';
		return m.replace(/[^\n]/g, ' ');
	});
	const exports: NativeFn[] = [];
	const re = /cuisv_export\s+([A-Za-z_][\w\s*]*?)\s*\b([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
	for (const m of code.matchAll(re)) {
		const params = m[3].trim() === '' || m[3].trim() === 'void' ? [] : m[3].split(',').map((p) => {
			const pm = /^(.*?)([A-Za-z_]\w*)\s*$/.exec(p.trim());
			return { type: norm(pm ? pm[1] : p), name: pm ? pm[2] : 'arg' };
		});
		exports.push({ name: m[2], ret: norm(m[1]), params });
	}
	return { source: out, code, exports };
}

/** How a C type crosses to JS: undefined for a type exported functions cannot use. */
export function native_kind(type: string): 'num' | 'int' | 'bool' | 'str' | 'void' | undefined {
	return TYPES[type];
}

/**
 * C for the scriptc build: each exported function as `cuisvn_<name>` with the argument
 * layout of scriptc's FFI. Strings arrive as a (pointer, length) span and are copied to a C
 * string for the call; a string result goes to a callback, which is not called for NULL.
 * src/cli/scriptc.ts writes the matching manifest entries and declarations.
 */
function scriptc_shims(fns: NativeFn[]): string[] {
	const lines: string[] = [];
	if (fns.some((f) => f.params.some((p) => TYPES[p.type] === 'str'))) {
		lines.push('#include <stdlib.h>');
		lines.push('static char *cuisvn__cstr(const uint8_t *p, size_t n) { char *s = malloc(n + 1); if (!s) abort(); if (n) memcpy(s, p, n); s[n] = 0; return s; }');
	}
	for (const f of fns) {
		const rk = TYPES[f.ret];
		const params: string[] = [];
		const before: string[] = [];
		const after: string[] = [];
		const args: string[] = [];
		f.params.forEach((p, i) => {
			const k = TYPES[p.type];
			if (k === 'num') params.push(`double a${i}`);
			else if (k === 'int') params.push(`int32_t a${i}`);
			else if (k === 'bool') params.push(`uint8_t a${i}`);
			else {
				params.push(`const uint8_t *a${i}`, `size_t n${i}`);
				before.push(`char *s${i} = cuisvn__cstr(a${i}, n${i});`);
				after.push(`free(s${i});`);
			}
			args.push(k === 'str' ? `s${i}` : k === 'bool' ? `a${i} != 0` : `(${p.type})a${i}`);
		});
		if (rk === 'str') params.push('void (*cb)(const uint8_t *, size_t, void *)', 'void *context');
		const call = `${f.name}(${args.join(', ')})`;
		const ret = rk === 'void' || rk === 'str' ? 'void' : rk === 'bool' ? 'uint8_t' : 'double';
		const body =
			rk === 'void' ? [`${call};`]
			: rk === 'str' ? [`const char *r = ${call};`, 'if (r) cb((const uint8_t *)r, strlen(r), context);']
			: [`${ret} r = (${ret})${call};`];
		lines.push(`${ret} cuisvn_${f.name}(${params.join(', ') || 'void'}) { ${[...before, ...body, ...after, ...(ret === 'void' ? [] : ['return r;'])].join(' ')} }`);
	}
	return lines;
}

/** C: the QuickJS wrappers for exported functions and their table. */
export function native_wrappers(fns: NativeFn[], table: string): { c: string; errors: string[]; exported: NativeFn[] } {
	const errors: string[] = [];
	const lines: string[] = [];
	for (const f of fns) {
		const rk = TYPES[f.ret];
		if (!rk) {
			errors.push(`${f.name}: returns ${f.ret}; exported functions return double, float, int, bool, const char * or void`);
			continue;
		}
		// an argument that does not convert (a Symbol, a throwing valueOf) makes the call throw,
		// with the strings converted so far freed: no exception is left pending behind a value
		const decls: string[] = [];
		const convert: string[] = [];
		const args: string[] = [];
		const free: string[] = [];
		let ok = true;
		f.params.forEach((p, i) => {
			const k = TYPES[p.type];
			const v = `a${i}`;
			if (!k || k === 'void') {
				errors.push(`${f.name}: parameter ${p.name} is ${p.type}; exported functions take double, float, int, bool or const char *`);
				ok = false;
				return;
			}
			if (k === 'num') {
				decls.push(`double ${v} = 0;`);
				convert.push(`if (argc > ${i} && JS_ToFloat64(c, &${v}, argv[${i}]) < 0) goto done;`);
			} else if (k === 'int') {
				decls.push(`int32_t ${v} = 0;`);
				convert.push(`if (argc > ${i} && JS_ToInt32(c, &${v}, argv[${i}]) < 0) goto done;`);
			} else if (k === 'bool') {
				decls.push(`int ${v} = 0;`);
				convert.push(`if (argc > ${i} && (${v} = JS_ToBool(c, argv[${i}])) < 0) goto done;`);
			} else {
				decls.push(`const char *${v} = NULL;`);
				convert.push(`if (argc > ${i} && !(${v} = JS_ToCString(c, argv[${i}]))) goto done;`);
				free.push(`if (${v}) JS_FreeCString(c, ${v});`);
			}
			args.push(k === 'str' ? `${v} ? ${v} : ""` : k === 'bool' ? `${v} > 0` : `(${p.type})${v}`);
		});
		if (!ok) continue;
		const call = `${f.name}(${args.join(', ')})`;
		const result =
			rk === 'void' ? `${call}; out = JS_UNDEFINED;`
			: rk === 'str' ? `const char *r = ${call}; out = r ? JS_NewString(c, r) : JS_NULL;`
			: rk === 'bool' ? `bool r = ${call}; out = JS_NewBool(c, r);`
			: `double r = (double)${call}; out = JS_NewFloat64(c, r);`;
		lines.push(`static JSValue cuisv_native_${f.name}(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {`);
		lines.push('    (void)this_val; (void)argc; (void)argv;');
		lines.push(...decls.map((l) => '    ' + l));
		lines.push('    JSValue out = JS_EXCEPTION;');
		lines.push(...convert.map((l) => '    ' + l));
		lines.push(`    { ${result} }`);
		if (convert.length) lines.push('done:');
		lines.push(...free.map((l) => '    ' + l));
		lines.push('    return out;');
		lines.push('}');
	}
	const ok_fns = fns.filter((f) => !errors.some((e) => e.startsWith(f.name + ':')));
	lines.push(`const cuisv_native ${table}[] = { ${ok_fns.map((f) => `{ ${JSON.stringify(f.name)}, (void *)cuisv_native_${f.name}, ${f.params.length} }`).join(', ') || '{ NULL, NULL, 0 }'} };`);
	lines.push(`const int ${table}_count = ${ok_fns.length};`);
	// the browser build: functions that take and return numbers are wasm exports
	const web: string[] = [];
	for (const f of ok_fns) {
		const numeric = (t: string) => TYPES[t] === 'num' || TYPES[t] === 'int' || TYPES[t] === 'bool';
		if (!f.params.every((p) => numeric(p.type)) || !(numeric(f.ret) || f.ret === 'void')) continue;
		const params = f.params.map((_, i) => `double a${i}`).join(', ') || 'void';
		const args = f.params.map((p, i) => `(${p.type})a${i}`).join(', ');
		web.push(
			`__attribute__((export_name("cuisv_native_${f.name}"))) ${f.ret === 'void' ? 'void' : 'double'} cuisv_wnative_${f.name}(${params}) { ${f.ret === 'void' ? '' : 'return (double)'}${f.name}(${args}); }`
		);
	}
	const empty = [`const cuisv_native ${table}[] = { { NULL, NULL, 0 } };`, `const int ${table}_count = 0;`];
	const c = ['#if defined(CUISV_SCRIPTC)', ...scriptc_shims(ok_fns), ...empty, '#elif !defined(CUISV_WEB)', ...lines, '#else', ...web, ...empty, '#endif'];
	return { c: c.join('\n'), errors, exported: ok_fns };
}
