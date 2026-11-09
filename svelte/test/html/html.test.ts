import { mount_test, test, expect } from 'cui-svelte/test';
import Form from './Form.svelte';

const state = (app: ReturnType<typeof mount_test>) => app.find(/^name=/)!.text;

test('text input bind:value and Enter submits the form', () => {
	const app = mount_test(Form, { width: 600, height: 700 });
	app.click(app.rect('name')!);
	app.type('Grace');
	expect(state(app)).toContain('name=Grace');
	app.key('enter');
	expect(state(app)).toContain('submitted=1');
});

test('DOM style oninput gets e.target.value', () => {
	const app = mount_test(Form, { width: 600, height: 700 });
	app.click(app.rect('dom')!);
	app.type('xyz');
	expect(state(app)).toContain('last=xyz');
});

test('checkbox and radio group', () => {
	const app = mount_test(Form, { width: 600, height: 700 });
	app.click('Agree');
	expect(state(app)).toContain('agree=true');
	app.click('Blue');
	expect(state(app)).toContain('color=blue');
	app.click('Red');
	expect(state(app)).toContain('color=red');
});

test('select from an each of options', () => {
	const app = mount_test(Form, { width: 600, height: 700 });
	expect(app.text()).toContain('Medium');
	app.click('Medium');
	app.click('Large');
	expect(state(app)).toContain('size=l');
});

test('mouseenter and mouseleave', () => {
	const app = mount_test(Form, { width: 600, height: 700 });
	app.move('Hover target');
	app.frame(2);
	expect(state(app)).toContain('hovered=true');
	app.move({ x: 590, y: 690 });
	app.frame(2);
	expect(state(app)).toContain('hovered=false');
});

test('class: toggles with a click', () => {
	const app = mount_test(Form, { width: 600, height: 700 });
	app.click('Two');
	expect(state(app)).toContain('tab=1');
	app.click('One');
	expect(state(app)).toContain('tab=0');
});
