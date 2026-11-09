import { mount_test, test, expect } from 'cui-svelte/test';
import Labels from './Labels.svelte';

// every component that takes a label draws it without the identity suffix cui-svelte adds
test('no label shows its ###key', () => {
	const app = mount_test(Labels, { width: 900, height: 4000 });
	const leaks = app.nodes().filter((n) => n.text.includes('##')).map((n) => n.text);
	expect(leaks).toEqual([]);
	expect(app.nodes().filter((n) => n.text.startsWith('L_')).length).toBeGreaterThan(30);
});
