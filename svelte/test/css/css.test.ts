import { mount_test, test, expect } from 'cui-svelte/test';
import Css from './Css.svelte';

test('style: percentages, flex grow, grid columns, auto margins', () => {
	const app = mount_test(Css, { width: 800, height: 600 });
	const track = app.rect('track')!, bar = app.rect('bar')!;
	expect(bar.w).toBeCloseTo(track.w / 2, 1);
	const a = app.rect('a')!, b = app.rect('b')!;
	expect(b.w).toBeCloseTo(a.w * 2, 1.5);
	const g1 = app.rect('g1')!, g4 = app.rect('g4')!;
	expect(g4.y).toBe(g1.y); // 580 wide: four 130+ columns fit in one row
	const c = app.rect('centered')!, page = app.rect('page')!;
	expect(c.x + c.w / 2).toBeCloseTo(page.x + page.w / 2, 2);
	expect(app.rect('dyn')!.h).toBeCloseTo(60, 1);
	expect(app.rect('wide')!.w).toBeCloseTo(300, 1);
});

test('dynamic class strings, display: none and style: update', () => {
	const app = mount_test(Css, { width: 800, height: 600 });
	expect(app.text()).toContain('maybe');
	app.click('change');
	expect(app.rect('bar')!.w).toBeCloseTo(app.rect('track')!.w, 1);
	expect(app.rect('dyn')!.h).toBeCloseTo(20, 1);
	expect(app.text()).not.toContain('maybe');
});
