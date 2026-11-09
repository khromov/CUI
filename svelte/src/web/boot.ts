/**
 * The browser build. The C half (CUI, the runtime, the app's templates) is a wasm module;
 * the JS half (Svelte, the app's scripts) runs in the page's own engine. This installs the
 * same `__cuisv` bridge QuickJS has natively, over the module's exports, and drives frames:
 *
 *   each animation frame: the last frame's events go to JS, then CUI builds (the templates
 *   read the slots JS set) and paints into the canvas.
 *
 * Bundled first by `cui-svelte build --web`; the app's main.ts runs after boot() resolves.
 */
import { instantiate as instantiate_js } from './wasm.js';
import { hooks, type Bridge } from '../runtime/bridge.ts';
import { ENUMS } from '../runtime/tables.ts';

type Exports = Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };

const KEYS: Record<string, number> = {
	Tab: 1, Enter: 2, NumpadEnter: 2, Escape: 3, Backspace: 4, Delete: 5, Space: 6,
	ArrowLeft: 7, ArrowRight: 8, ArrowUp: 9, ArrowDown: 10, Home: 11, End: 12, PageUp: 13, PageDown: 14,
	Minus: 51, Equal: 52, Comma: 53, Period: 54, Slash: 55
};
for (let i = 0; i < 26; i++) KEYS['Key' + String.fromCharCode(65 + i)] = 15 + i;
for (let i = 0; i < 10; i++) KEYS['Digit' + i] = KEYS['Numpad' + i] = 41 + i;
for (let i = 1; i <= 12; i++) KEYS['F' + i] = 55 + i;
const MODKEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
const CURSORS = ['default', 'pointer', 'text', 'ew-resize', 'ns-resize', 'move', 'not-allowed'];
const ACCENTS = Object.keys(ENUMS.cui_accent).filter((k) => k !== 'count');

export interface BootOptions {
	/** URL of the app's wasm module. */
	wasm: string | URL;
	/** The canvas to draw into; default one that fills the page. */
	canvas?: HTMLCanvasElement;
}

export async function boot(o: BootOptions) {
	let dirty = true;
	const mark = () => {
		dirty = true;
		schedule();
	};
	const instantiate = instantiate_js as unknown as (url: string, extra: object) => Promise<{ exports: unknown; memory(): WebAssembly.Memory }>;
	const mod = await instantiate(String(o.wasm), {
		paint: (handle: number, slot: number, x: number, y: number, w: number, h: number) => hooks().paint?.(handle, slot, x, y, w, h)
	});
	const x = mod.exports as Exports;
	const u8 = () => new Uint8Array(mod.memory().buffer);
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	/** Copies bytes into wasm memory; free with x.web_free. */
	const put = (bytes: Uint8Array) => {
		const p = x.web_alloc(bytes.length + 1);
		u8().set(bytes, p);
		u8()[p + bytes.length] = 0;
		return p;
	};
	const with_str = <T>(s: string, fn: (p: number, n: number) => T): T => {
		const b = enc.encode(s);
		const p = put(b);
		try {
			return fn(p, b.length);
		} finally {
			x.web_free(p);
		}
	};
	const with_floats = <T>(a: ArrayLike<number>, fn: (p: number, n: number) => T): T => {
		const f = a instanceof Float32Array ? a : Float32Array.from(a, Number);
		const p = x.web_alloc(f.length * 4 + 4);
		new Float32Array(mod.memory().buffer, p, f.length).set(f);
		try {
			return fn(p, f.length);
		} finally {
			x.web_free(p);
		}
	};
	const with_bytes = <T>(b: Uint8Array, fn: (p: number, n: number) => T): T => {
		const p = put(b);
		try {
			return fn(p, b.length);
		} finally {
			x.web_free(p);
		}
	};

	const root = x.cuisv_w_init();
	const canvas = o.canvas ?? make_canvas();
	const ctx2d = canvas.getContext('2d')!;
	let inst = 0;
	let clip = '';
	const ratio = () => window.devicePixelRatio || 1;
	const css = () => ({ w: canvas.clientWidth || window.innerWidth, h: canvas.clientHeight || window.innerHeight });

	const toasts = new Set<number>();
	const natives: Record<string, unknown> = {};
	for (const name of Object.keys(x)) if (name.startsWith('cuisv_native_')) natives[name.slice(13)] = x[name];

	const bridge: Bridge = {
		root: () => root,
		scope: (t) => x.cuisv_w_scope(t >>> 0),
		free: (h) => (x.cuisv_w_free(h), mark()),
		insert: (p, site, c, before) => (x.cuisv_w_insert(p, site, c, before), mark()),
		detach: (h) => (x.cuisv_w_detach(h), mark()),
		num: (h, i, v) => (x.cuisv_w_num(h, i, v), mark()),
		bool: (h, i, v) => (x.cuisv_w_bool(h, i, v ? 1 : 0), mark()),
		str: (h, i, v) => (with_str(v, (p, n) => x.cuisv_w_str(h, i, p, n)), mark()),
		unset: (h, i) => (x.cuisv_w_unset(h, i), mark()),
		fn: (h, i, present) => (x.cuisv_w_fn(h, i, present ? 1 : 0), mark()),
		strs: (h, i, v) => {
			const parts = Array.from(v, (s) => enc.encode(String(s)));
			const total = 4 + parts.reduce((n, b) => n + 4 + b.length, 0);
			const buf = new Uint8Array(total);
			const view = new DataView(buf.buffer);
			view.setUint32(0, parts.length, true);
			let at = 4;
			for (const b of parts) {
				view.setUint32(at, b.length, true);
				buf.set(b, at + 4);
				at += 4 + b.length;
			}
			with_bytes(buf, (p, n) => x.cuisv_w_strs(h, i, p, n));
			mark();
		},
		floats: (h, i, v) => (with_floats(v, (p, n) => x.cuisv_w_floats(h, i, p, n)), mark()),
		blob: (h, i, v) => (with_bytes(v instanceof Uint8Array ? v : new Uint8Array(v), (p, n) => x.cuisv_w_blob(h, i, p, n)), mark()),
		timeout: (fn, ms, repeat) => (repeat ? setInterval(fn, ms) : setTimeout(fn, ms)) as unknown as number,
		clear: (id) => clearTimeout(id),
		want_frame: () => mark(),
		want_keys: (on: boolean) => x.cuisv_w_want_keys(on ? 1 : 0),
		print: (level, text) => (level >= 2 ? console.warn : console.log)(text),
		now: () => performance.now(),
		app(opts: { title?: string; width?: number; height?: number; theme?: string; accent?: string }) {
			if (opts.title) document.title = opts.title;
			if (!inst) {
				resize();
				const { w, h } = css();
				x.cuisv_w_size(w, h);
				const dark = opts.theme === 'dark' || (opts.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
				inst = x.inst_new(0, w, h, ratio(), dark ? 1 : 0, opts.accent ? ACCENTS.indexOf(opts.accent) : -1, 0);
				wire_input();
			}
			mark();
			return true;
		},
		redraw: () => mark(),
		quit: () => {},
		browser: true,
		headless: false,
		natives,
		set_title: (t: string) => (document.title = t),
		set_theme: (t: string) => (x.inst_set_theme(inst, t === 'dark' ? 1 : 0), mark()),
		get_theme: () => (x.cuisv_w_theme_dark() ? 'dark' : 'light'),
		set_accent: (a: string) => (x.inst_set_accent(inst, ACCENTS.indexOf(a)), mark()),
		get_accent: () => ACCENTS[x.inst_get_accent(inst)] ?? 'neutral',
		args: () => [location.href],
		getenv: () => undefined,
		platform: () => 'web',
		scroll_to: (name: string, y: number) => (mark(), with_str(name, (p) => !!x.cuisv_w_scroll_to(p, y))),
		rect_of: (name: string) => {
			const r = (bridge.test_rect as (n: string) => number[] | null)(name);
			return r ? { x: r[0], y: r[1], w: r[2], h: r[3] } : null;
		},
		clipboard_write: (t: string) => {
			clip = t;
			navigator.clipboard?.writeText(t).catch(() => {});
		},
		clipboard_read: () => clip,
		open_url: (u: string) => !!window.open(u, '_blank', 'noopener'),
		file_dialog: () => null,
		toast(title: string, o: { description?: string; tone?: number; duration?: number; action?: string; show_timer?: boolean }) {
			const h = with_str(title, (t) =>
				with_str(o.description ?? '', (d) => with_str(o.action ?? '', (a) => x.cuisv_w_toast(t, d, o.tone ?? 0, o.duration ?? 0, a, o.show_timer ? 1 : 0)))
			);
			if (o.action) toasts.add(h);
			mark();
			return h;
		},
		toast_dismiss: (h: number) => (x.cuisv_w_toast_dismiss(h), mark()),
		viewport: () => {
			const p = x.web_alloc(8);
			x.cuisv_w_viewport(p);
			const v = Array.from(new Float32Array(mod.memory().buffer, p, 2));
			x.web_free(p);
			return v;
		},
		fs_read: () => null,
		fs_write: () => false,
		fs_stat: () => null,
		fs_list: () => null,
		fs_remove: () => false,
		fs_mkdir: () => false,
		data_dir: () => '/',
		home_dir: () => '/',
		buffer_new: (kind: number, lines: number, bytes: number) => x.cuisv_w_buffer_new(kind, lines, bytes),
		buffer_write: (h: number, text: string, level = 0) => (with_str(text, (p, n) => x.cuisv_w_buffer_write(h, p, n, level)), mark()),
		buffer_clear: (h: number) => (x.cuisv_w_buffer_clear(h), mark()),
		buffer_free: (h: number) => x.cuisv_w_buffer_free(h),
		draw_rect: (...a: number[]) => x.cuisv_w_draw_rect(...a),
		draw_circle: (...a: number[]) => x.cuisv_w_draw_circle(...a),
		draw_line: (...a: number[]) => x.cuisv_w_draw_line(...a),
		draw_polyline: (pts: number[], w: number, c: number, closed: boolean) => with_floats(pts, (p, n) => x.cuisv_w_draw_polyline(p, n / 2, w, c, closed ? 1 : 0)),
		draw_polygon: (pts: number[], c: number) => with_floats(pts, (p, n) => x.cuisv_w_draw_polygon(p, n / 2, c)),
		draw_arc: (...a: number[]) => x.cuisv_w_draw_arc(...a),
		draw_text: (px: number, py: number, s: string, size: number, c: number, font: number) => with_str(s, (p, n) => x.cuisv_w_draw_text(px, py, p, n, size, c, font)),
		draw_icon: (icon: string, ...a: number[]) => with_str(icon, (p) => x.cuisv_w_draw_icon(p, ...a)),
		draw_clip: (...a: number[]) => (a.length >= 4 ? x.cuisv_w_clip(a[0], a[1], a[2], a[3], 1) : x.cuisv_w_clip(0, 0, 0, 0, 0)),
		measure_text: (s: string, size: number, font = 0) => with_str(s, (p, n) => x.cuisv_w_measure(p, n, size, font)),
		test_rect: (name: string) =>
			with_str(name, (p) => {
				const out = x.web_alloc(16);
				const ok = x.cuisv_w_rect(p, out);
				const r = Array.from(new Float32Array(mod.memory().buffer, out, 4));
				x.web_free(out);
				return ok ? r : null;
			})
	};
	globalThis.__cuisv = bridge;

	// ---- the frame loop ---------------------------------------------------------------------
	let scheduled = false;
	let last = performance.now();
	let last_w = 0, last_h = 0;
	function schedule() {
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(frame);
	}
	function dispatch() {
		const n = x.cuisv_w_event_count();
		if (!n) return false;
		const events: unknown[][] = [];
		for (let i = 0; i < n; i++) {
			const kind = x.cuisv_w_ev_kind(i);
			const args: unknown[] = [x.cuisv_w_ev_handle(i), x.cuisv_w_ev_slot(i)];
			if (kind === 1) args.push(x.cuisv_w_ev_a(i));
			else if (kind === 2) args.push(x.cuisv_w_ev_a(i) !== 0);
			else if (kind === 3) args.push(dec.decode(u8().subarray(x.cuisv_w_ev_str(i), x.cuisv_w_ev_str(i) + x.cuisv_w_ev_len(i))));
			else if (kind === 4) args.push(x.cuisv_w_ev_a(i), x.cuisv_w_ev_b(i));
			else if (kind === 5) args.push(u8().slice(x.cuisv_w_ev_str(i), x.cuisv_w_ev_str(i) + x.cuisv_w_ev_len(i)));
			events.push(args);
		}
		x.cuisv_w_events_clear();
		for (const args of events) hooks().dispatch?.(...(args as [number, number, ...unknown[]]));
		hooks().commit?.();
		return true;
	}
	function frame(now: number) {
		scheduled = false;
		if (!inst) return;
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;
		// the last frame's events first: CUI has painted it
		if (dispatch()) dirty = true;
		for (const h of toasts) {
			if (x.cuisv_w_toast_clicked(h)) {
				toasts.delete(h);
				hooks().toast_action?.(h);
			}
		}
		const [w, h] = (bridge.viewport as () => number[])();
		if (w !== last_w || h !== last_h) {
			last_w = w;
			last_h = h;
			hooks().resize?.(w, h);
		}
		const wake = x.inst_next_wakeup(inst);
		if (!dirty && !x.inst_needs_redraw(inst) && !(wake >= 0 && wake < 0.02)) {
			if (wake >= 0) setTimeout(schedule, wake * 1000);
			return;
		}
		dirty = false;
		if (x.inst_frame(inst, dt, 1)) blit();
		canvas.style.cursor = CURSORS[x.inst_cursor(inst)] ?? 'default';
		if (x.cuisv_w_event_count() > 0 || x.inst_needs_redraw(inst)) schedule();
		else {
			const next = x.inst_next_wakeup(inst);
			if (next >= 0) setTimeout(schedule, next * 1000);
		}
	}
	function blit() {
		const p = x.inst_pixels(inst), pw = x.inst_pixel_width(inst), ph = x.inst_pixel_height(inst);
		if (!pw || !ph) return;
		if (canvas.width !== pw || canvas.height !== ph) {
			canvas.width = pw;
			canvas.height = ph;
		}
		ctx2d.putImageData(new ImageData(new Uint8ClampedArray(mod.memory().buffer, p, pw * ph * 4).slice(), pw, ph), 0, 0);
	}
	function resize() {
		const { w, h } = css();
		if (inst) x.inst_resize(inst, w, h, ratio());
		mark();
	}
	window.addEventListener('resize', resize);

	// ---- input --------------------------------------------------------------------------------
	function pos(e: MouseEvent): [number, number] {
		const r = canvas.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	}
	function wire_input() {
		let buttons = 0;
		const on = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => canvas.addEventListener(t, f, o);
		on('pointermove', (e) => {
			const [mx, my] = pos(e);
			x.inst_mouse_move(inst, mx, my);
			mark();
		});
		on('pointerdown', (e) => {
			canvas.focus({ preventScroll: true });
			try {
				canvas.setPointerCapture(e.pointerId);
			} catch {
				/* synthetic pointers */
			}
			const [mx, my] = pos(e);
			x.inst_mouse_move(inst, mx, my);
			const b = e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
			buttons |= 1 << b;
			x.inst_mouse_button(inst, b, 1);
			mark();
			e.preventDefault();
		});
		const up = (e: PointerEvent) => {
			const b = e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
			if (!(buttons & (1 << b))) return;
			buttons &= ~(1 << b);
			const [mx, my] = pos(e);
			x.inst_mouse_move(inst, mx, my);
			x.inst_mouse_button(inst, b, 0);
			mark();
		};
		on('pointerup', up);
		on('pointercancel', up);
		on('pointerleave', () => {
			if (!buttons) {
				x.inst_mouse_leave(inst);
				mark();
			}
		});
		on('contextmenu', (e) => e.preventDefault());
		on(
			'wheel',
			(e) => {
				const k = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 10 : 1 / 100;
				let dx = -e.deltaX * k, dy = -e.deltaY * k;
				if (e.shiftKey && !e.deltaX) [dx, dy] = [dy, 0];
				const [mx, my] = pos(e);
				x.inst_mouse_move(inst, mx, my);
				x.inst_scroll(inst, dx, dy);
				e.preventDefault();
				mark();
			},
			{ passive: false }
		);
		const mods = (e: KeyboardEvent) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
		on('keydown', (e) => {
			if (['F5', 'F11', 'F12'].includes(e.code)) return;
			if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') return; // the paste event follows
			const key = KEYS[e.code];
			if (key) x.inst_key(inst, key, 1, mods(e));
			else if (MODKEYS.has(e.key)) x.inst_key(inst, 0, 1, mods(e));
			if ([...e.key].length === 1 && !e.ctrlKey && !e.metaKey) with_str(e.key, (p) => x.inst_text(inst, p));
			if (key || e.key.length === 1) e.preventDefault();
			mark();
		});
		on('keyup', (e) => {
			const key = KEYS[e.code];
			if (key) x.inst_key(inst, key, 0, mods(e));
			else if (MODKEYS.has(e.key)) x.inst_key(inst, 0, 0, mods(e));
			mark();
		});
		on('paste', (e) => {
			const text = e.clipboardData?.getData('text/plain') ?? '';
			clip = text;
			const b = enc.encode(text);
			const p = x.web_clipboard_buffer(b.length);
			u8().set(b, p);
			u8()[p + b.length] = 0;
			x.inst_key(inst, KEYS.KeyV, 1, 2);
			x.inst_key(inst, KEYS.KeyV, 0, 2);
			e.preventDefault();
			mark();
		});
		on('focus', () => (x.inst_focus(inst, 1), mark()));
		on('blur', () => {
			for (const k of Object.values(KEYS)) x.inst_key(inst, k, 0, 0);
			x.inst_focus(inst, 0);
			mark();
		});
		canvas.focus({ preventScroll: true });
	}
	return bridge;
}

function make_canvas(): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.tabIndex = 0;
	c.style.cssText = 'display:block;position:fixed;inset:0;width:100vw;height:100vh;outline:none;touch-action:none';
	document.body.style.margin = '0';
	document.body.appendChild(c);
	return c;
}
