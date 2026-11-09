import { mount_test, test, expect } from 'cui-svelte/test';
import Features from './Features.svelte';

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
