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

/** C: the QuickJS wrappers for exported functions and their table. */
export function native_wrappers(fns: NativeFn[], table: string): { c: string; errors: string[] } {
	const errors: string[] = [];
	const lines: string[] = [];
	for (const f of fns) {
		const rk = TYPES[f.ret];
		if (!rk) {
			errors.push(`${f.name}: returns ${f.ret}; exported functions return double, float, int, bool, const char * or void`);
			continue;
		}
		const pre: string[] = [];
		const args: string[] = [];
		const post: string[] = [];
		let ok = true;
		f.params.forEach((p, i) => {
			const k = TYPES[p.type];
			const v = `a${i}`;
			if (!k || k === 'void') {
				errors.push(`${f.name}: parameter ${p.name} is ${p.type}; exported functions take double, float, int, bool or const char *`);
				ok = false;
				return;
			}
			if (k === 'num') pre.push(`double ${v} = 0; if (argc > ${i}) JS_ToFloat64(c, &${v}, argv[${i}]);`);
			else if (k === 'int') pre.push(`int32_t ${v} = 0; if (argc > ${i}) JS_ToInt32(c, &${v}, argv[${i}]);`);
			else if (k === 'bool') pre.push(`bool ${v} = argc > ${i} && JS_ToBool(c, argv[${i}]) > 0;`);
			else {
				pre.push(`const char *${v} = argc > ${i} ? JS_ToCString(c, argv[${i}]) : NULL;`);
				post.push(`if (${v}) JS_FreeCString(c, ${v});`);
			}
			args.push(k === 'str' ? `${v} ? ${v} : ""` : `(${p.type})${v}`);
		});
		if (!ok) continue;
		const call = `${f.name}(${args.join(', ')})`;
		lines.push(`static JSValue cuisv_native_${f.name}(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {`);
		lines.push('    (void)this_val; (void)argc; (void)argv;');
		lines.push(...pre.map((l) => '    ' + l));
		if (rk === 'void') lines.push(`    ${call};`, ...post.map((l) => '    ' + l), '    return JS_UNDEFINED;');
		else if (rk === 'str') lines.push(`    const char *r = ${call};`, '    JSValue out = r ? JS_NewString(c, r) : JS_NULL;', ...post.map((l) => '    ' + l), '    return out;');
		else if (rk === 'bool') lines.push(`    bool r = ${call};`, ...post.map((l) => '    ' + l), '    return JS_NewBool(c, r);');
		else lines.push(`    double r = (double)${call};`, ...post.map((l) => '    ' + l), '    return JS_NewFloat64(c, r);');
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
		const params = f.params.map((p, i) => `double a${i}`).join(', ') || 'void';
		const args = f.params.map((p, i) => `(${p.type})a${i}`).join(', ');
		web.push(
			`__attribute__((export_name("cuisv_native_${f.name}"))) ${f.ret === 'void' ? 'void' : 'double'} cuisv_wnative_${f.name}(${params}) { ${f.ret === 'void' ? '' : 'return (double)'}${f.name}(${args}); }`
		);
	}
	const c = [
		'#ifndef CUISV_WEB',
		...lines,
		'#else',
		...web,
		`const cuisv_native ${table}[] = { { NULL, NULL, 0 } };`,
		`const int ${table}_count = 0;`,
		'#endif'
	];
	return { c: c.join('\n'), errors };
}
