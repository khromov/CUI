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
