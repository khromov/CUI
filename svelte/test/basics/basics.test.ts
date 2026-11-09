import { mount_test, test, expect } from 'cui-svelte/test';
import Hello from '../../examples/hello/App.svelte';

test('renders the hello app', () => {
	const app = mount_test(Hello, { width: 420, height: 360 });
	expect(app.text()).toContain('Hello, CUI');
	expect(app.text()).toContain('Clicked 0 times');
	expect(app.text()).toContain('0: one');
});

test('a click reaches JS and the new count reaches C', () => {
	const app = mount_test(Hello, { width: 420, height: 360 });
	app.click('Click me');
	expect(app.text()).toContain('Clicked 1 times');
	app.click('Click me');
	app.click('Click me');
	app.click('Click me');
	expect(app.text()).toContain('Clicked 4 times');
	expect(app.text()).toContain('That is a lot of clicks');
});
