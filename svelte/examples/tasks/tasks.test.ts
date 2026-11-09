import { mount_test, test, expect, temp_path } from 'cui-svelte/test';
import { local_storage } from 'cui-svelte';
import App from './App.svelte';

test('add, complete and filter tasks', () => {
	localStorage.removeItem('tasks');
	const app = mount_test(App, { width: 520, height: 640 });
	expect(app.text()).toContain('2 open');
	app.click(app.rect('new')!);
	app.type('Write the docs');
	app.key('enter');
	expect(app.text()).toContain('3 open');
	app.click('Done');
	expect(app.text()).toContain('Write the renderer');
	expect(app.text()).not.toContain('Ship it');
	app.screenshot(temp_path('tasks.png'), 2);
	local_storage.flush();
	expect(JSON.parse(localStorage.getItem('tasks')!).length).toBe(4);
	localStorage.removeItem('tasks');
	local_storage.flush();
});

test('the theme toggle saves its choice for the next launch', async () => {
	const { get_theme } = await import('cui-svelte');
	const { saved_theme } = await import('./store.ts');
	localStorage.removeItem('theme');
	const app = mount_test(App, { width: 520, height: 640 });
	const heading = app.find('Tasks')!;
	const toggle = { x: 520 - 28 - 16, y: heading.y + heading.h / 2 }; // right end of the header
	app.click(toggle);
	app.frame(2);
	expect(get_theme()).toBe('dark');
	expect(saved_theme()).toBe('dark');
	app.click(toggle);
	app.frame(2);
	expect(saved_theme()).toBe('light');
	localStorage.removeItem('theme');
	local_storage.flush();
});
