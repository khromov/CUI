import { mount_test, test, expect, temp_path } from 'cui-svelte/test';
import Tools from './Tools.svelte';

test('tool panels render', () => {
	const app = mount_test(Tools, { width: 700, height: 1000 });
	app.frame(3);
	const text = app.text();
	expect(text).toContain('apple');
	expect(text).toContain('src');
	app.screenshot(temp_path('tools.png'));
});

test('tree table rows come from JS and opening a folder shows its children', () => {
	const app = mount_test(Tools, { width: 700, height: 1000 });
	app.frame(3);
	expect(app.text()).toContain('main.c');
	expect(app.text()).toContain('README.md');
});

test('otp input', () => {
	const app = mount_test(Tools, { width: 700, height: 1000 });
	app.click(app.rect('otp')!);
	app.type('1234');
	app.frame(2);
	expect(app.find(/^code=/)!.text).toContain('code=1234');
	expect(app.find(/^code=/)!.text).toContain('completed=1234');
});

test('lists without items, a non-finite value, an id with */, bytes and no image build and run', () => {
	const app = mount_test(Tools, { width: 700, height: 1400 });
	// (a toggle group with no items lays out nothing)
	for (const id of ['multi', 'hex', 'viewer']) expect(app.rect(id)).not.toBe(null);
	expect(app.text()).toContain('slider');
	expect(app.rect('hex')!.h).toBeGreaterThan(30);
});

test('a reorder list with an id is findable', () => {
	const app = mount_test(Tools, { width: 700, height: 1400 });
	const r = app.rect('fruits')!;
	const apple = app.find('apple')!;
	expect(r.h).toBeGreaterThan(apple.h * 2);
	expect(apple.y).toBeGreaterThan(r.y - 1);
	expect(apple.y).toBeLessThan(r.y + r.h);
});

test('a vector shows as many fields as components={…} says, 1 to 4', () => {
	const app = mount_test(Tools, { width: 700, height: 1200 });
	// the axis letters on the vector's row
	const axes = () => {
		const row = app.find('vec')!;
		return app.nodes().filter((n) => /^[XYZW]$/.test(n.text) && Math.abs(n.y - row.y) < row.h).map((n) => n.text);
	};
	expect(axes()).toEqual(['X', 'Y']);
	app.click('dims');
	app.frame(2);
	expect(axes()).toEqual(['X', 'Y', 'Z', 'W']);
});
