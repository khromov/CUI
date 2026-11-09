import { mount_test, test, expect } from 'cui-svelte/test';
import { native } from 'cui-svelte';
import Inline from './Inline.svelte';

// <script lang="c"> in the component itself (svelte-check cannot read it: see Host.svelte.c)
const size = { width: 400, height: 300 };
test('inline C', () => {
	const app = mount_test(Inline, size);
	expect(app.text()).toContain('triple=21');
	expect(native.len('four')).toBe(4);
	expect(native.join('a', 'b')).toBe('ab');
	expect(native.odd(3, false)).toBe(true);
	expect(native.odd(3, true)).toBe(false);
});

const thrown = (f: () => unknown) => {
	try {
		f();
	} catch (e) {
		return String(e);
	}
	return 'nothing';
};

test('an argument that does not convert makes the call throw, and leaves nothing pending', () => {
	mount_test(Inline, size);
	expect(thrown(() => native.len(Symbol('x')))).toContain('TypeError');
	expect(thrown(() => native.triple({ valueOf() { throw new Error('boom'); } }))).toContain('boom');
	expect(thrown(() => native.join('a', Symbol('b')))).toContain('TypeError');
	expect(thrown(() => native.odd({ valueOf() { throw new Error('odd'); } }, false))).toContain('odd');
	// the next calls see no exception left over
	expect(native.triple(2)).toBe(6);
	expect(native.join('c', 'd')).toBe('cd');
});

test('a radio bound with a getter and a setter', () => {
	const app = mount_test(Inline, size);
	expect(app.text()).toContain('fit=loose');
	app.click('Snug');
	expect(app.text()).toContain('fit=snug');
	app.click('Loose');
	expect(app.text()).toContain('fit=loose');
});

test('a label component whose id has */ in it', () => {
	const app = mount_test(Inline, size);
	expect(app.rect('slider */ end')).not.toBe(null);
});
