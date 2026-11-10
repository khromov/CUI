import { mount_test, test, expect } from 'cui-svelte/test';
import Esm from './Esm.svelte';

test('an npm package written as ES modules (culori) runs on every engine', () => {
	const app = mount_test(Esm, { width: 600, height: 200 });
	expect(app.text()).toContain('parsed=rgb hex=#ff0000');
	app.click('blue');
	expect(app.text()).toContain('hex=#0000ff');
});
