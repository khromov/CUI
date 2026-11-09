import { mount_test, test, expect } from 'cui-svelte/test';
import Labels from './Labels.svelte';

// every component that takes a label draws it without the identity suffix cui-svelte adds
test('no label shows its ###key', () => {
	const app = mount_test(Labels, { width: 900, height: 4000 });
	const leaks = app.nodes().filter((n) => n.text.includes('##')).map((n) => n.text);
	expect(leaks).toEqual([]);
	expect(app.nodes().filter((n) => n.text.startsWith('L_')).length).toBeGreaterThan(30);
});

// CUI shows a label up to its first "##"; cui-svelte splits one in the text with U+200C
test('a label with ## in its text shows in full', () => {
	const app = mount_test(Labels, { width: 900, height: 4000 });
	const shown = app.nodes().map((n) => n.text.replaceAll('\u200c', ''));
	for (const text of ['Ticket ##42', '## Release notes', 'C#', 'Static ##7', 'Knob ##1', 'Gain ##2']) expect(shown).toContain(text);
});
