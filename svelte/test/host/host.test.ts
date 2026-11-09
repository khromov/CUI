import { mount_test, test, expect, temp_path } from 'cui-svelte/test';
import { fs, paths, clipboard, local_storage } from 'cui-svelte';
import Host from './Host.svelte';

test('C functions from <script lang="c"> are callable from JS', () => {
	const app = mount_test(Host, { width: 500, height: 400 });
	expect(app.text()).toContain('native: 5 hello C');
});

test('canvas: C paint, JS paint, pointer', () => {
	const app = mount_test(Host, { width: 500, height: 400 });
	const r = app.rect('bar')!;
	expect(r.w).toBeGreaterThan(100);
	app.click({ x: r.x + 50, y: r.y + 10 });
	expect(app.text()).toContain('pressed=50,10');
	app.frame(2);
	expect(app.text()).toContain('painted=true');
	app.screenshot(temp_path('host.png'));
});

test('toast', () => {
	const app = mount_test(Host, { width: 500, height: 400 });
	app.click('toast');
	app.frame(3);
	expect(app.text()).toContain('All good');
});

test('files, app data and localStorage', () => {
	const dir = paths.data();
	expect(fs.exists(dir)).toBe(true);
	const file = `${dir}/probe.txt`;
	expect(fs.write_text(file, 'héllo')).toBe(true);
	expect(fs.read_text(file)).toBe('héllo');
	fs.append_text(file, '!');
	expect(fs.read_text(file)).toBe('héllo!');
	expect(fs.list(dir)!.some((e) => e.name === 'probe.txt')).toBe(true);
	expect(fs.remove(file)).toBe(true);
	localStorage.setItem('k', 'v');
	local_storage.flush();
	expect(fs.read_text(`${dir}/localStorage.json`)).toBe('{"k":"v"}');
	localStorage.removeItem('k');
	local_storage.flush();
});

test('files: folders, bad data and names outside ASCII', () => {
	const dir = paths.data();
	expect(fs.read_text(dir)).toBe(null); // a folder is not a file
	expect(fs.mkdir('')).toBe(false);
	const top = `${dir}/ünïcode dir`;
	const sub = `${top}/nested`;
	expect(fs.mkdir(sub)).toBe(true);
	expect(fs.stat(sub)!.dir).toBe(true);
	const file = `${sub}/naïve ✓.txt`;
	expect(fs.write_text(file, 'kept')).toBe(true);
	expect(fs.stat(file)!.size).toBe(4);
	expect(fs.mkdir(file)).toBe(false); // a file is in the way
	// neither text nor bytes: nothing is written and the file stays as it was
	expect(fs.write_bytes(file, 42 as never)).toBe(false);
	expect(fs.read_text(file)).toBe('kept');
	expect(fs.write_bytes(file, new Uint8Array([104, 105]))).toBe(true);
	expect(fs.read_text(file)).toBe('hi');
	let threw = false;
	try {
		fs.write_text(Symbol() as never, 'x'); // a path that is no string throws, as in JS
	} catch {
		threw = true;
	}
	expect(threw).toBe(true);
	expect(fs.remove(file)).toBe(true);
	expect(fs.remove(sub)).toBe(true); // an empty folder
	expect(fs.remove(top)).toBe(true);
	expect(fs.exists(top)).toBe(false);
});

test('clipboard', () => {
	clipboard.write('copied text');
	expect(clipboard.read()).toBe('copied text');
});

test('set_app_id: localStorage moves to the new folder without carrying data over', async () => {
	const { set_app_id } = await import('cui-svelte');
	const before = paths.data();
	localStorage.setItem('probe', 'old folder'); // not written yet
	set_app_id('cui-svelte-rebind-test');
	const after = paths.data();
	expect(after === before).toBe(false);
	expect(localStorage.getItem('probe')).toBe(null);
	expect(JSON.parse(fs.read_text(`${before}/localStorage.json`)!).probe).toBe('old folder');
	fs.remove(after);
	set_app_id(before.split('/').pop()!);
	expect(localStorage.getItem('probe')).toBe('old folder');
	localStorage.removeItem('probe');
	local_storage.flush();
});
