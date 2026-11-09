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

test('rows reorder by dragging, also while the list is filtered', () => {
	localStorage.removeItem('tasks');
	const app = mount_test(App, { width: 520, height: 640 });
	const native = (globalThis as unknown as { __cuisv: Record<string, (...a: number[]) => void> }).__cuisv;
	// press on a row's grip (left of its checkbox) and drag it to another row's height
	const drag = (title: string, onto: string) => {
		const from = app.find(title)!, to = app.find(onto)!;
		const x = 28 + 16, y = from.y + from.h / 2, ty = to.y + to.h / 2 + (to.y < from.y ? -8 : 8);
		native.test_move(x, y);
		app.frame();
		native.test_button(0, 1);
		app.frame();
		for (let k = 1; k <= 10; k++) {
			native.test_move(x, y + ((ty - y) * k) / 10);
			app.frame();
		}
		native.test_button(0, 0);
		app.frame(4);
	};
	const titles = () => app.nodes().map((n) => n.text).filter((t) => ['Write the renderer', 'Try the web build', 'Ship it'].includes(t));
	expect(titles()).toEqual(['Write the renderer', 'Try the web build', 'Ship it']);
	drag('Ship it', 'Write the renderer');
	expect(titles()).toEqual(['Ship it', 'Write the renderer', 'Try the web build']);
	// only the open tasks shown: they swap, the done one keeps its place in the full list
	app.click('Open');
	drag('Try the web build', 'Ship it');
	app.click('All');
	expect(titles()).toEqual(['Try the web build', 'Write the renderer', 'Ship it']);
	app.screenshot(temp_path('tasks-reorder.png'), 2);
	localStorage.removeItem('tasks');
	local_storage.flush();
});

test('a dropped row is drawn in its new place on the drop frame, with no jump', () => {
	localStorage.removeItem('tasks');
	const app = mount_test(App, { width: 520, height: 640 });
	const native = (globalThis as unknown as { __cuisv: Record<string, (...a: number[]) => unknown> }).__cuisv;
	native.test_motion(1); // rows glide as on screen, not snap
	app.frame(30);
	// where each title is drawn: layout y plus the offset its row is animating by
	const drawn = (title: string) => {
		const n = (native.test_nodes() as [string, number, number, number, number, number][]).find((x) => x[0] === title)!;
		return n[2] + n[5];
	};
	const from = app.find('Ship it')!, to = app.find('Write the renderer')!;
	const x = 28 + 16, y = from.y + from.h / 2, ty = to.y + to.h / 2 - 8;
	native.test_move(x, y);
	app.frame();
	native.test_button(0, 1);
	app.frame();
	for (let k = 1; k <= 12; k++) {
		native.test_move(x, y + ((ty - y) * k) / 12);
		app.frame();
	}
	const held = drawn('Ship it');
	native.test_button(0, 0);
	app.frame();
	// the drop frame: the new order already, the dropped row where the pointer left it
	expect(drawn('Ship it')).toBeCloseTo(held, 2);
	expect(drawn('Ship it')).toBeLessThan(drawn('Write the renderer'));
	expect(drawn('Write the renderer')).toBeLessThan(drawn('Try the web build'));
	native.test_motion(0);
	localStorage.removeItem('tasks');
	local_storage.flush();
});
