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
