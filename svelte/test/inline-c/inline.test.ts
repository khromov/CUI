import { mount_test, test, expect } from 'cui-svelte/test';
import Inline from './Inline.svelte';

// <script lang="c"> in the component itself (svelte-check cannot read it: see Host.svelte.c)
test('inline C', () => {
	const app = mount_test(Inline, { width: 300, height: 100 });
	expect(app.text()).toContain('triple=21');
});
