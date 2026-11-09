import { mount_test, test, expect } from 'cui-svelte/test';
import Gallery from './Gallery.svelte';

test('every component on the page renders, and no label shows its key', () => {
	const app = mount_test(Gallery, { width: 1280, height: 4400 });
	app.frame(5);
	expect(app.nodes().filter((n) => n.text.includes('##')).map((n) => n.text)).toEqual([]);
	for (const t of ['cui-svelte gallery', 'Revenue', 'Person 0', 'Virtual row 0', 'To do', 'Inbox', 'Accordion content']) expect(app.text()).toContain(t);
});

test('dragging a kanban card to another column moves it there', () => {
	const app = mount_test(Gallery, { width: 1280, height: 6000 });
	const native = (globalThis as unknown as { __cuisv: Record<string, (...a: number[]) => void> }).__cuisv;
	const card = app.find('Fix bug')!, done = app.find('QuickJS host')!;
	native.test_move(card.x + 10, card.y + 5);
	app.frame();
	native.test_button(0, 1);
	app.frame();
	for (let k = 1; k <= 12; k++) {
		native.test_move(card.x + 10 + ((done.x - card.x) * k) / 12, card.y + 5 + ((done.y + 40 - card.y) * k) / 12);
		app.frame();
	}
	native.test_button(0, 0);
	app.frame(3);
	expect(app.find('Fix bug')!.x).toBeCloseTo(done.x);
	expect(app.text()).toContain('Cards moved: 1');
});

test('frame cost', () => {
	const app = mount_test(Gallery, { width: 1280, height: 900 });
	app.frame(10);
	const n = 200;
	const t0 = performance.now();
	app.frame(n);
	const ms = (performance.now() - t0) / n;
	console.log(`  gallery: ${ms.toFixed(3)} ms a frame (templates + layout + paint data, software renderer not drawing)`);
	expect(ms).toBeLessThan(50);
});
