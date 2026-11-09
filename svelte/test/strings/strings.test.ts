import { mount_test, test, expect } from 'cui-svelte/test';
import { set_strings, type Strings } from 'cui-svelte';
import Dates from './Dates.svelte';

const es: Strings = {
	month: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
	month_short: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'],
	weekday_min: ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'],
	today: 'Hoy'
};
const size = { width: 500, height: 500 };

test('English by default', () => {
	const app = mount_test(Dates, size);
	expect(app.text()).toContain('March 2026');
	expect(app.text()).toContain('Mar 15, 2026');
	expect(app.find('Mo')).not.toBe(null);
});

test('run({ strings }) translates month and weekday names', () => {
	const app = mount_test(Dates, { ...size, strings: es });
	expect(app.text()).toContain('marzo 2026');
	expect(app.text()).toContain('mar 15, 2026');
	expect(app.find('sá')).not.toBe(null);
	expect(app.text()).not.toContain('March');
});

test('what a table leaves out stays English', () => {
	// no month_short, an empty month name, and a weekday that is not a string
	const app = mount_test(Dates, { ...size, strings: { month: ['', '', ''], weekday_min: ['lu', 7 as never] } });
	expect(app.text()).toContain('March 2026');
	expect(app.text()).toContain('Mar 15, 2026');
	expect(app.find('lu')).not.toBe(null);
	expect(app.find('Tu')).not.toBe(null);
	expect(app.find('Mo')).toBe(null);
});

test('set_strings switches language at runtime; null is English', () => {
	const app = mount_test(Dates, size);
	set_strings(es);
	app.frame(2);
	expect(app.text()).toContain('marzo 2026');
	set_strings(null);
	app.frame(2);
	expect(app.text()).toContain('March 2026');
});

test('run() without strings is English again', () => {
	mount_test(Dates, { ...size, strings: es });
	const app = mount_test(Dates, size);
	expect(app.text()).toContain('March 2026');
});
