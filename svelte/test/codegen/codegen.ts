/**
 * Golden output for the compiler: compiles every .svelte under test/ and examples/, plus a
 * corpus that uses each component of components.ts four ways (static props, other static
 * values, dynamic props with every event, bound props), and compares the generated C, the
 * skeleton and the metadata byte for byte with the snapshots next to this file.
 *
 *   node test/codegen/codegen.ts            check (exit 1 on any difference)
 *   node test/codegen/codegen.ts --update   rewrite the snapshots; review them with git diff
 *
 * The tests reach about half of the components; this covers every component's codegen, so a
 * refactor that should not change the output can prove it, and one that should shows how.
 */
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../src/compiler/index.ts';
import { collect_globals, type GlobalRules } from '../../src/compiler/styles.ts';

const PKG = fileURLToPath(new URL('../..', import.meta.url));
const SNAPSHOTS = join(PKG, 'test', 'codegen', 'snapshots');
const update = process.argv.includes('--update');

// ---- the corpus ---------------------------------------------------------------------------

interface Prop {
	name: string;
	type: string;
}

/** Each component of components.ts, with its props and its bindable props. */
function components(): { name: string; props: Prop[]; bindable: string[] }[] {
	const ts = readFileSync(join(PKG, 'src', 'runtime', 'components.ts'), 'utf8');
	return [...ts.matchAll(/export interface (\w+)Props \{([\s\S]*?)\n\}/g)].map((m) => {
		const props = m[2]
			.split('\n')
			.map((l) => /^\t"?(\w+)"?\??: (.*);$/.exec(l))
			.filter((pm) => pm !== null)
			.map((pm) => ({ name: pm[1], type: pm[2] }));
		const bm = new RegExp(`export const ${m[1]}: Component<${m[1]}Props, \\{\\}, ([^>]*)>`).exec(ts);
		return { name: m[1], props, bindable: bm ? [...bm[1].matchAll(/"(\w+)"/g)].map((x) => x[1]) : [] };
	});
}

/** A literal for a prop of this type (alt: a second, awkward one), or null to leave it out. */
function literal(p: Prop, alt: boolean): string | null {
	const t = p.type;
	if ((t.startsWith('(') && t.includes('=>')) || t.startsWith('Snippet') || t === 'Uint8Array') return null;
	if (t === 'string') return alt ? `{"line one\\nüñí \\"q\\" ??= \\\\ tab\\t"}` : `"s_${p.name}"`;
	if (t.startsWith('IconName')) return t.endsWith('[]') ? (alt ? `{["plus", "trash-2"]}` : `{["check"]}`) : alt ? '"TrashTwo"' : '"check"';
	const simple: Record<string, [string, string]> = {
		number: ['{3}', '{-2.5}'],
		boolean: ['', '{false}'],
		Size: ['{120}', '"50%"'],
		Color: ['"#336699"', '"var(--cui-accent)"'],
		DateString: ['"2026-01-02"', '"today"'],
		'string[]': ['{["a", "b", "c"]}', '{[]}'],
		'ArrayLike<number>': ['{[1, 2, 3]}', '{[0.5]}'],
		'number[]': ['{[1, 2, 3]}', '{[0.5]}'],
		'boolean[]': ['{[true, false, true]}', '{[true, false, true]}']
	};
	if (simple[t]) return simple[t][alt ? 1 : 0];
	const all = [...t.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
	return t.startsWith('"') && all.length ? `"${alt ? all[all.length - 1] : all[0]}"` : null;
}

/** name_variant.svelte -> source, for every component. */
function corpus(): Map<string, string> {
	const out = new Map<string, string>();
	for (const c of components()) {
		const imports = `import { ${[...new Set([c.name, 'Text', 'GridCell'])].join(', ')} } from 'cui-svelte';`;
		const has_children = c.props.some((p) => p.name === 'children');
		const body = (kids: string) => (c.props.some((p) => p.name === 'row') ? `{#snippet row(i)}<Text>row {i}</Text><GridCell>c {i}</GridCell>{/snippet}` : '') + (has_children ? kids : '');
		const literals = (alt: boolean) =>
			c.props
				.filter((p) => !['children', 'class', 'style'].includes(p.name))
				.map((p) => [p.name, literal(p, alt)] as const)
				.filter(([, v]) => v !== null)
				.map(([n, v]) => (v === '' ? n : `${n}=${v}`));
		const tag = (attrs: string, kids: string) => `<${c.name} ${attrs}>${body(kids)}</${c.name}>`;
		out.set(
			`${c.name}_static.svelte`,
			`<script>${imports}</script>\n${tag([...literals(false), 'class="a b"', 'style="padding: 4px 8px; color: red; width: 50%"'].join(' '), 'Static text')}\n<${c.name} id="fixed_id">${body('<Text>kid</Text>')}</${c.name}>\n<style>.a { padding: 6px; } .b:hover { background: #eee; } :global(.x) .a { gap: 3px; }</style>\n`
		);
		out.set(`${c.name}_alt.svelte`, `<script>${imports}</script>\n${tag(literals(true).join(' '), 'Alt {"x"} text')}\n`);
		const script = (state: string) => `<script>${imports}\n\tlet ${state} = $state({});\n\tconst log = (...a) => console.log(...a);</script>\n`;
		const dynamic = c.props.filter((p) => !['children', 'row', 'id'].includes(p.name)).map((p) => (p.type.includes('=>') ? `${p.name}={(...a) => log(${JSON.stringify(p.name)}, a)}` : `${p.name}={d.${p.name}}`));
		out.set(
			`${c.name}_dynamic.svelte`,
			`${script('d')}${tag(`${dynamic.join(' ')} id={d.id}`, 'Dyn {d.text} and {d.more}')}\n{#if d.flag}<${c.name} class={d.cls} style:width={d.w} style:color="red">${body('{d.only}')}</${c.name}>{/if}\n`
		);
		if (c.bindable.length) {
			const events = c.props.filter((p) => p.type.includes('=>')).map((p) => `${p.name}={(x) => log(x)}`);
			const binds = c.bindable.map((b) => `bind:${b}={v.${b}}`);
			const getset = c.bindable.map((b) => `bind:${b}={() => v.${b}, (x) => (v.${b} = x)}`);
			out.set(`${c.name}_bind.svelte`, `${script('v')}${tag(`${binds.join(' ')} ${events.join(' ')}`, 'Bound')}\n{#each [1, 2] as k (k)}${tag(getset.join(' '), '{k}')}{/each}\n`);
		}
	}
	return out;
}

// ---- compiling ------------------------------------------------------------------------------

/** C, skeleton and metadata of one file, with machine-specific paths taken out. */
function generate(file: string, root: string, globals: GlobalRules, paths: Record<string, string>): string {
	const sibling = existsSync(file + '.c') ? readFileSync(file + '.c', 'utf8') : undefined;
	let text: string;
	try {
		const r = compile(readFileSync(file, 'utf8'), { filename: file, key: relative(root, file), globals, c_source: sibling });
		const meta = JSON.stringify({ templates: r.templates, warnings: r.warnings, natives: r.natives }, null, 1);
		text = `---- C ----\n${r.c}\n---- skeleton ----\n${r.skeleton}\n---- metadata ----\n${meta}\n`;
	} catch (e) {
		text = `---- compile error ----\n${(e as Error).message}\n`;
	}
	for (const [path, name] of Object.entries(paths)) text = text.replaceAll(path, name);
	return text;
}

const actual = new Map<string, string>();
// the package's own components, each folder with its own :global rules, as the tests build them
const own = ['test', 'examples'].flatMap((d) => globSync(`${d}/**/*.svelte`, { cwd: PKG, exclude: ['**/node_modules', '**/dist', '**/dist-web', '**/.*'] })).sort();
const globals = new Map<string, GlobalRules>();
for (const f of own) {
	const file = join(PKG, f);
	const root = dirname(file);
	if (!globals.has(root)) globals.set(root, collect_globals(root));
	actual.set(`${f}.txt`, generate(file, root, globals.get(root)!, { [PKG]: '<pkg>/' }));
}
// the corpus, compiled from a scratch folder, one snapshot per component
const dir = mkdtempSync(join(tmpdir(), 'cuisv-codegen-'));
try {
	const sources = corpus();
	for (const [name, src] of sources) writeFileSync(join(dir, name), src);
	const corpus_globals = collect_globals(dir);
	for (const name of [...sources.keys()].sort()) {
		const component = name.slice(0, name.lastIndexOf('_'));
		const prev = actual.get(`corpus/${component}.txt`) ?? '';
		const text = generate(join(dir, name), dir, corpus_globals, { [dir + '/']: '<corpus>/', [PKG]: '<pkg>/' });
		actual.set(`corpus/${component}.txt`, `${prev}======== ${name} ========\n---- source ----\n${sources.get(name)}${text}`);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

// ---- comparing ------------------------------------------------------------------------------

const stored = new Set(existsSync(SNAPSHOTS) ? globSync('**/*.txt', { cwd: SNAPSHOTS }) : []);
const changed: string[] = [];
for (const [name, text] of actual) {
	const p = join(SNAPSHOTS, name);
	stored.delete(name);
	const old = existsSync(p) ? readFileSync(p, 'utf8') : null;
	if (old === text) continue;
	changed.push(old === null ? `${name} (new)` : `${name}: first difference at line ${first_difference(old, text)}`);
	if (update) {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, text);
	}
}
for (const name of stored) {
	changed.push(`${name} (no longer generated)`);
	if (update) rmSync(join(SNAPSHOTS, name));
}

function first_difference(a: string, b: string): number {
	const x = a.split('\n');
	const y = b.split('\n');
	let i = 0;
	while (i < x.length && i < y.length && x[i] === y[i]) i++;
	return i + 1;
}

if (!changed.length) {
	console.log(`generated output of ${actual.size} snapshots unchanged`);
} else if (update) {
	console.log(`updated ${changed.length} of ${actual.size} snapshots:\n  ${changed.join('\n  ')}`);
} else {
	console.log(`${changed.length} of ${actual.size} snapshots differ:\n  ${changed.slice(0, 40).join('\n  ')}${changed.length > 40 ? `\n  ... and ${changed.length - 40} more` : ''}`);
	console.log('If the change is intended: node test/codegen/codegen.ts --update, then review git diff test/codegen');
	process.exit(1);
}
