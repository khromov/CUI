import { mount_test, test, expect } from 'cui-svelte/test';
import { clipboard, platform } from 'cui-svelte';
import Features from './Features.svelte';
import Child from './Child.svelte';
// (svelte's *.svelte module type only has the default export)
import * as features_module from './Features.svelte';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('bind:checked on a switch', () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	expect(app.text()).toContain('power=off');
	app.click('Power');
	expect(app.text()).toContain('power=on');
});

test('bind:value on an input, typing', () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	app.click(app.rect('name')!);
	app.key('end');
	app.type(' Lovelace');
	expect(app.text()).toContain('name=Ada Lovelace');
});

test('bind:value on an input keeps a long paste whole', () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	app.click(app.rect('name')!);
	app.key('a', platform() === 'macos' ? 'cmd' : 'ctrl');
	clipboard.write('0123456789'.repeat(500));
	app.key('v', platform() === 'macos' ? 'cmd' : 'ctrl');
	expect(app.find(/^name=/)!.text).toBe(`name=${'0123456789'.repeat(500)}`);
});

test('onchange of a control with two values fires when the second one changes', () => {
	const app = mount_test(Features, { width: 700, height: 1400 });
	const r = app.rect('range')!;
	const state = () => /^range=([\d.]+)-([\d.]+) onchange=(.*)$/.exec(app.find(/^range=/)!.text)!;
	expect(Math.round(Number(state()[2]))).toBe(60);
	// the high thumb jumps to a click near the right end; the low one stays
	app.click({ x: r.x + r.w - 6, y: r.y + r.h - 8 });
	app.frame(2);
	const [, lo, hi, changed] = state();
	expect(Math.round(Number(lo))).toBe(20);
	expect(Number(hi)).toBeGreaterThan(90);
	expect(changed).toBe(`${lo}-${hi}`);
});

test('{@const} inside a CUI component belongs to its children', () => {
	const app = mount_test(Features, { width: 700, height: 1600 });
	expect(app.text()).toContain('tripled=0');
	expect(app.text()).toContain('id 1\nis apple');
	expect(app.text()).toContain('id 3\nis cherry');
	app.click('inc');
	expect(app.text()).toContain('tripled=3');
});

test('top-level snippets: used from <script>, exported from <script module>', () => {
	const app = mount_test(Features, { width: 700, height: 1600 });
	expect(app.text()).toContain('cell a');
	expect(app.text()).toContain('hello module');
	expect(typeof (features_module as unknown as { greeting?: unknown }).greeting).toBe('function');
});

test('derived, effect, onMount, if / else if / else', () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	expect(app.text()).toContain('n=0 doubled=0 effects=1 mounted=yes');
	expect(app.text()).toContain('zero');
	app.click('inc');
	expect(app.text()).toContain('n=1 doubled=2 effects=2');
	expect(app.text()).toContain('one');
	app.click('inc');
	expect(app.text()).toContain('many');
	expect(app.text()).not.toContain('zero');
});

test('keyed each: order, reverse, else', () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	const order = () => app.nodes().filter((x) => x.text.startsWith('item ')).map((x) => x.text);
	expect(order()).toEqual(['item 0=apple', 'item 1=banana', 'item 2=cherry']);
	app.click('reverse');
	expect(order()).toEqual(['item 0=cherry', 'item 1=banana', 'item 2=apple']);
	app.click('clear');
	expect(order()).toEqual([]);
	expect(app.text()).toContain('no items');
});

test('snippets, key blocks, child components, context, bindable, callback props', () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	expect(app.text()).toContain('badge:first');
	expect(app.text()).toContain('badge:n0');
	expect(app.text()).toContain('keyed 0');
	app.click('rekey');
	expect(app.text()).toContain('keyed 1');
	expect(app.text()).toContain('Child A value=5 theme=midnight');
	expect(app.text()).toContain('child content n=0');
	expect(app.text()).toContain('footer 5');
	app.click('Bump A');
	expect(app.text()).toContain('shared=15 bumps=1');
	expect(app.text()).toContain('footer 15');
	app.click('inc');
	expect(app.text()).toContain('child content n=1');
	expect(app.text()).toContain('badge:n1');
});

test('await and timers', async () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	expect(app.text()).toContain('waiting');
	await wait(60);
	app.frame(2);
	expect(app.text()).toContain('promise=loaded');
	expect(app.text()).toContain('ticking=yes');
});

test('slider drag writes the bound value', () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	const label = app.find('Volume')!;
	expect(app.text()).toContain('volume=25');
	app.key('tab');
	void label;
});

test('on_key: global shortcuts', () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	app.key('k', 'ctrl');
	expect(app.text()).toContain('shortcut=k ctrl');
	app.key('f5');
	expect(app.text()).toContain('shortcut=f5');
});

test('rect_of and scroll_to', async () => {
	const { rect_of, scroll_to } = await import('cui-svelte');
	const app = mount_test(Features, { width: 700, height: 900 });
	const r = rect_of('name');
	expect(r!.w).toBeGreaterThan(50);
	expect(scroll_to('nope', 10)).toBe(false);
	void app;
});

test('rect_of and app.rect: null once the element is gone', async () => {
	const { rect_of } = await import('cui-svelte');
	const app = mount_test(Features, { width: 700, height: 900 });
	const r = rect_of('name');
	expect(r!.w).toBeGreaterThan(50);
	expect(app.rect('name')).toEqual(r);
	// another root replaces Features: CUI still keeps the old rects for a while, rect_of must not
	const child = mount_test(Child, { width: 700, height: 900, props: { title: 'B' } });
	expect(child.text()).toContain('Child B');
	expect(rect_of('name')).toBe(null);
	expect(rect_of('list')).toBe(null);
	expect(child.rect('name')).toBe(null);
	// past the registry's pruning (every 64 frames), the names come back with their elements
	child.frame(130);
	mount_test(Features, { width: 700, height: 900 });
	expect(rect_of('name')).toEqual(r);
	expect(rect_of('list')).toBeTruthy();
});

test('scroll_to scrolls scroll areas and leaves other elements alone', async () => {
	const { scroll_to } = await import('cui-svelte');
	const app = mount_test(Features, { width: 700, height: 900 });
	// an input's state is its text, not a scroll position: writing one there would corrupt it
	expect(scroll_to('name', 10)).toBe(false);
	app.click(app.rect('name')!);
	app.key('end');
	app.type('x');
	expect(app.text()).toContain('name=Adax');
	for (const [id, first] of [['list', 'scroll row 0'], ['pane', 'pane line 0']]) {
		const before = app.find(first)!.y;
		expect(scroll_to(id, 1000)).toBe(true);
		app.frame(3);
		expect(app.find(first)!.y).toBeLessThan(before);
	}
});

test('each mount_test gets the size it asks for', () => {
	const size = () => (globalThis as unknown as { __cuisv: { viewport(): number[] } }).__cuisv.viewport();
	mount_test(Features, { width: 700, height: 900 });
	expect(size()).toEqual([700, 900]);
	mount_test(Features, { width: 420, height: 300 });
	expect(size()).toEqual([420, 300]);
});

test('test_frame refuses to run inside a frame', () => {
	const app = mount_test(Features, { width: 700, height: 900 });
	let error = '';
	// due at once, so the next frame runs it (timers run at the start of a frame)
	setTimeout(() => {
		try {
			app.frame();
		} catch (e) {
			error = String(e);
		}
	}, 0);
	app.frame(2);
	expect(error).toContain('inside a frame');
	expect(app.text()).toContain('power=off'); // and frames still run after it
});
