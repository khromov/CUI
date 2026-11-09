import { mount_test, test, expect } from 'cui-svelte/test';
import { clipboard, platform } from 'cui-svelte';
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

test('a paste longer than a line of typing is kept whole', () => {
	const app = mount_test(Form, { width: 600, height: 700 });
	app.click(app.rect('name')!);
	clipboard.write('x'.repeat(1000));
	app.key('v', platform() === 'macos' ? 'cmd' : 'ctrl');
	expect(state(app)).toContain(`name=${'x'.repeat(1000)} agree`);
});

const more = (app: ReturnType<typeof mount_test>) => app.find(/^fruit=/)!.text;

test('markup the build warns about still builds and runs', () => {
	const app = mount_test(Form, { width: 600, height: 1100 });
	// an id with */ in it, and a template literal in a style expression: 40 * `${fruit}?`.length
	expect(app.rect('a*/b')!.w).toBeCloseTo(40, 1);
	app.click('Choose a fruit');
	app.click('Banana');
	expect(more(app)).toContain('fruit=b');
	expect(app.rect('a*/b')!.w).toBeCloseTo(80, 1);
	expect(app.rect('c*/d')).not.toBe(null);
	// a slider with an id is findable too (CUI knows it by its label)
	expect(app.rect('half')).not.toBe(null);
	expect(app.text()).toContain('line height');
});

test('a select keeps its static options around an {#each} of them, in order', () => {
	const app = mount_test(Form, { width: 600, height: 1100 });
	expect(app.text()).toContain('Choose a fruit');
	app.click('Choose a fruit');
	const options = app.nodes().filter((n) => ['Choose a fruit', 'Apple', 'Banana', 'Something else'].includes(n.text));
	expect(options.slice(1).map((n) => n.text)).toEqual(['Choose a fruit', 'Apple', 'Banana', 'Something else']);
	app.click(options[options.length - 1]);
	expect(more(app)).toContain('fruit=z');
});

test('checked={null} and hidden={null} are off', () => {
	const app = mount_test(Form, { width: 600, height: 1100 });
	expect(app.text()).toContain('hidden=null shows');
	app.click('Null start');
	expect(more(app)).toContain('nullcheck=true');
});

test('<ol> numbers its items, from start, through {#each}; a nested <ul> keeps bullets', () => {
	const app = mount_test(Form, { width: 600, height: 1100 });
	const markers = app.nodes().filter((n) => /^(\d+\.|•)$/.test(n.text)).map((n) => n.text);
	expect(markers).toEqual(['3.', '4.', '5.', '6.', '•']);
});
