// @engine quickjs: scriptc 0.4.10 cannot compile dayjs (constructor functions with prototype writes)
import { mount_test, test, expect } from 'cui-svelte/test';
import Npm from './Npm.svelte';

test('an npm package (dayjs with a plugin) runs in QuickJS', () => {
	const app = mount_test(Npm, { width: 600, height: 200 });
	expect(app.text()).toContain('date=Monday 9 November 2026');
	expect(app.text()).toContain('later=2026-11-12 from=3 days ago');
	app.click('next month');
	expect(app.text()).toContain('date=Wednesday 9 December 2026');
});
