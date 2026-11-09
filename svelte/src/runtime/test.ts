/**
 * Headless tests: `cui-svelte test file.test.ts` builds the app with a host that has no
 * window (software renderer, reduced motion) and runs the test file in QuickJS.
 *
 *   import { mount_test, test, expect } from 'cui-svelte/test';
 *   import Counter from './Counter.svelte';
 *
 *   test('counts', () => {
 *       const app = mount_test(Counter);
 *       app.click('Click me');
 *       expect(app.text()).toContain('Clicked 1 times');
 *   });
 */
import type { Component } from 'svelte';
import { flushSync } from 'svelte';
import { run, type RunOptions } from './index.ts';
import { hooks, native } from './bridge.ts';
import { ENUMS } from './tables.ts';

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface TextNode extends Rect {
	text: string;
}

const MOD: Record<string, number> = { shift: 1, ctrl: 2, alt: 4, super: 8, cmd: 8, meta: 8 };

export class TestApp {
	/** Draws `n` frames: JS timers, the templates, then events to JS. */
	frame(n = 1) {
		(native().test_frame as (n: number) => void)(n);
	}

	/** Every text on screen with its rectangle, in build order. */
	nodes(): TextNode[] {
		return (native().test_nodes as () => [string, number, number, number, number][])().map(([text, x, y, w, h]) => ({ text, x, y, w, h }));
	}

	/** All text on screen, joined by newlines. */
	text(): string {
		return this.nodes()
			.map((n) => n.text)
			.join('\n');
	}

	/** All text on screen as one string, whitespace collapsed: "Clicked 2 times" even when
	 * <strong> split it into three text nodes. */
	flat(): string {
		return this.text().replace(/\s+/g, ' ').trim();
	}

	/** The first text node that equals (or, failing that, contains) `text`. */
	find(text: string | RegExp): TextNode | null {
		const nodes = this.nodes();
		if (typeof text !== 'string') return nodes.find((n) => text.test(n.text)) ?? null;
		return nodes.find((n) => n.text === text) ?? nodes.find((n) => n.text.includes(text)) ?? null;
	}

	/** The rectangle of the element with id="…". */
	rect(id: string): Rect | null {
		const r = (native().test_rect as (id: string) => number[] | null)(id);
		return r ? { x: r[0], y: r[1], w: r[2], h: r[3] } : null;
	}

	private point(target: string | RegExp | { x: number; y: number } | Rect): { x: number; y: number } {
		if (typeof target === 'object' && !(target instanceof RegExp)) {
			const r = target as Rect;
			return r.w !== undefined ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : target;
		}
		const n = this.find(target);
		if (!n) throw new Error(`no text ${String(target)} on screen. On screen:\n${this.text()}`);
		return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
	}

	move(target: string | RegExp | { x: number; y: number } | Rect) {
		const p = this.point(target);
		(native().test_move as (x: number, y: number) => void)(p.x, p.y);
		this.frame();
	}

	/** Moves to the text (or point), presses and releases the left button, one frame each. */
	click(target: string | RegExp | { x: number; y: number } | Rect, button: 0 | 1 | 2 = 0) {
		this.move(target);
		const press = native().test_button as (b: number, down: boolean) => void;
		press(button, true);
		this.frame();
		press(button, false);
		this.frame();
		this.frame();
	}

	/** A key by name ("enter", "tab", "a", "f5"), with modifiers: key('k', 'ctrl'). */
	key(name: string, ...mods: string[]) {
		const code = ENUMS.cui_key[name.toLowerCase()];
		if (code === undefined) throw new Error(`no key ${name}`);
		const m = mods.reduce((acc, x) => acc | (MOD[x] ?? 0), 0);
		const key = native().test_key as (k: number, down: boolean, mods: number) => void;
		key(code, true, m);
		this.frame();
		key(code, false, m);
		this.frame();
	}

	/** Types text into whatever has keyboard focus. */
	type(text: string) {
		(native().test_text as (s: string) => void)(text);
		this.frame(2);
	}

	scroll(dy: number, dx = 0) {
		(native().test_scroll as (dx: number, dy: number) => void)(dx, dy);
		this.frame(2);
	}

	/** Saves what the last frame drew. `scale` 2 for a retina sized image. */
	screenshot(path: string, scale = 1) {
		if (!(native().test_png as (p: string, s: number) => boolean)(path, scale)) throw new Error(`could not write ${path}`);
	}

	clipboard(): string {
		return (native().test_clipboard as () => string)();
	}
}

/**
 * A path for `name` in a cui-svelte-tests folder under the system's temporary folder (TMPDIR,
 * TEMP or TMP, else /tmp), created on first use: where screenshots and scratch files go.
 */
export function temp_path(name: string): string {
	const env = native().getenv as (k: string) => string | undefined;
	const base = (env('TMPDIR') || env('TEMP') || env('TMP') || '/tmp').replace(/[\\/]+$/, '');
	const dir = `${base}/cui-svelte-tests`;
	(native().fs_mkdir as (p: string) => boolean)(dir);
	return `${dir}/${name}`;
}

export function mount_test<Props extends Record<string, unknown>>(component: Component<Props>, options: RunOptions<Props> = {}): TestApp {
	if (!native().headless) throw new Error('mount_test() runs in a test build: cui-svelte test <file>');
	run(component, options);
	const app = new TestApp();
	app.frame(2);
	return app;
}

// ---- a small test runner -------------------------------------------------------------------

type TestFn = () => void | Promise<void>;
const tests: { name: string; fn: TestFn }[] = [];
let scheduled = false;

export function test(name: string, fn: TestFn) {
	tests.push({ name, fn });
	if (!scheduled) {
		scheduled = true;
		Promise.resolve().then(run_tests);
	}
}

let current: string | null = null;

async function run_tests() {
	let failed = 0;
	for (const t of tests) {
		current = t.name;
		try {
			await t.fn();
			flushSync();
			console.log(`  ok   ${t.name}`);
		} catch (e) {
			failed++;
			const msg = e instanceof Error ? `${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}` : String(e);
			console.error(`  FAIL ${t.name}\n       ${msg.split('\n').join('\n       ')}`);
		}
	}
	current = null;
	console.log(`${tests.length - failed}/${tests.length} passed`);
	(native().test_exit as (code: number) => void)(failed ? 1 : 0);
}

// the host ends a test file that stops making progress (or runs too long): name the test
hooks().unfinished = () => {
	if (current) console.error(`  FAIL ${current}\n       did not finish`);
};

class Expect {
	private actual: unknown;
	private negate: boolean;
	constructor(actual: unknown, negate = false) {
		this.actual = actual;
		this.negate = negate;
	}
	get not() {
		return new Expect(this.actual, !this.negate);
	}
	private check(ok: boolean, msg: string) {
		if (ok === this.negate) throw new Error((this.negate ? 'not: ' : '') + msg);
	}
	toBe(v: unknown) {
		this.check(Object.is(this.actual, v), `expected ${fmt(this.actual)} to be ${fmt(v)}`);
	}
	toEqual(v: unknown) {
		this.check(JSON.stringify(this.actual) === JSON.stringify(v), `expected ${fmt(this.actual)} to equal ${fmt(v)}`);
	}
	toContain(v: unknown) {
		const a = this.actual as string | unknown[];
		this.check(a != null && (a as { includes(x: unknown): boolean }).includes(v), `expected ${fmt(a)} to contain ${fmt(v)}`);
	}
	toBeTruthy() {
		this.check(!!this.actual, `expected ${fmt(this.actual)} to be truthy`);
	}
	toBeGreaterThan(v: number) {
		this.check((this.actual as number) > v, `expected ${fmt(this.actual)} > ${v}`);
	}
	toBeLessThan(v: number) {
		this.check((this.actual as number) < v, `expected ${fmt(this.actual)} < ${v}`);
	}
	toBeCloseTo(v: number, eps = 0.5) {
		this.check(Math.abs((this.actual as number) - v) <= eps, `expected ${fmt(this.actual)} to be within ${eps} of ${v}`);
	}
}

function fmt(v: unknown): string {
	if (typeof v === 'string') return JSON.stringify(v.length > 400 ? v.slice(0, 400) + '…' : v);
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export function expect(actual: unknown) {
	return new Expect(actual);
}
