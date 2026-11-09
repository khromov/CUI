import { mount_test, test, expect } from 'cui-svelte/test';
import { rect_of } from 'cui-svelte';
import Ids from './Ids.svelte';

type App = ReturnType<typeof mount_test>;

/** The element's rect holds the text it draws: its label, title or caption. */
function holds(app: App, id: string, text: string) {
	const r = rect_of(id);
	const t = app.find(text);
	const inside = !!r && !!t && t.x + t.w / 2 >= r.x && t.x + t.w / 2 <= r.x + r.w && t.y + t.h / 2 >= r.y && t.y + t.h / 2 <= r.y + r.h;
	expect([id, inside]).toEqual([id, true]);
}

test('rect_of finds elements whose CUI id is not their label, whole', () => {
	const app = mount_test(Ids, { width: 480, height: 1000 });
	app.frame(2);
	for (const [id, text] of [
		['button', 'Save'],
		['slider', 'Volume'],
		['checkbox', 'Remember me'],
		['switch', 'Wi-Fi'],
		['radio', 'Small'],
		['chip', 'Filter'],
		['nav', 'Inbox'],
		['alert', 'Heads up'],
		['alert', 'Something happened'],
		['html_checkbox', 'Agree'],
		['html_radio', 'Medium']
	]) holds(app, id, text);
	for (const id of ['copy', 'html_range']) {
		const r = rect_of(id);
		expect([id, !!r && r.w > 0 && r.h > 0]).toEqual([id, true]);
	}
});

test('clicking by id reaches the control, not a part of it', () => {
	const app = mount_test(Ids, { width: 480, height: 1000 });
	const state = () => app.find(/^on=/)!.text;
	expect(state()).toBe('on=true size=s pick=1 alerts=0');
	for (const [id, after] of [
		['checkbox', 'on=false size=s pick=1 alerts=0'],
		['switch', 'on=true size=s pick=1 alerts=0'],
		['html_checkbox', 'on=false size=s pick=1 alerts=0'],
		['html_radio', 'on=false size=m pick=1 alerts=0'],
		['radio', 'on=false size=m pick=2 alerts=0'],
		// the alert's middle, not its close button
		['alert', 'on=false size=m pick=2 alerts=0']
	]) {
		app.click(app.rect(id)!);
		app.frame(2);
		expect([id, state()]).toEqual([id, after]);
	}
});

test('an element is whole on the frame it first appears', () => {
	const app = mount_test(Ids, { width: 480, height: 1000 });
	expect(rect_of('late')).toBe(null);
	app.click('show late');
	holds(app, 'late', 'Late slider');
});

test('an overlay has a rect while it is open', () => {
	const app = mount_test(Ids, { width: 480, height: 1000 });
	app.frame(2);
	expect(rect_of('dialog')).toBe(null);
	app.click('open dialog');
	app.frame(3);
	holds(app, 'dialog', 'Dialog body');
});

test('an empty element has a rect; a missing one has none', () => {
	const app = mount_test(Ids, { width: 480, height: 1000 });
	app.frame(2);
	const r = rect_of('mark');
	expect(r !== null).toBe(true);
	expect(r!.x > app.find('before')!.x).toBe(true);
	expect(rect_of('no_such_id')).toBe(null);
});
