import { mount_test, test, expect } from 'cui-svelte/test';
import Gallery from './Gallery.svelte';

test('every component on the page renders, and no label shows its key', () => {
	const app = mount_test(Gallery, { width: 1280, height: 4400 });
	app.frame(5);
	expect(app.nodes().filter((n) => n.text.includes('##')).map((n) => n.text)).toEqual([]);
	for (const t of ['cui-svelte gallery', 'Revenue', 'Person 0', 'Virtual row 0', 'To do', 'Inbox', 'Accordion content']) expect(app.text()).toContain(t);
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
