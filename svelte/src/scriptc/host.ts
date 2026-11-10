/**
 * The scriptc build's host: the app's JS is compiled to native code by scriptc, so there is
 * no JS engine for C to embed and the roles turn around. This module is the `__cuisv` bridge
 * the renderer talks to, implemented over scriptc's FFI (ffi.ts -> runtime/cuisv_sc.c), and
 * it owns the frame loop: one frame per turn of scriptc's event loop, so timers, promises
 * and I/O run between frames.
 */
import * as ffi from 'cuisv-ffi';
import { flushSync } from 'svelte';
import { hooks, type Bridge } from '../runtime/bridge.ts';
import { natives, pack_strings, float_bytes } from './natives.ts';
import { native_names, call_native } from 'cuisv-app-natives';

const ACCENTS = ['neutral', 'violet', 'blue', 'green', 'amber', 'orange', 'coral', 'rose'];
const RENDERERS = ['auto', 'opengl', 'software'];
const EV_NUM = 1;
const EV_BOOL = 2;
const EV_STR = 3;
const EV_NUM2 = 4;
const EV_BYTES = 5;

const headless = process.env.CUISV_HEADLESS === '1';

/** JS changed what C draws since the last frame was built. */
let dirty = false;
let in_frame = false;
let exit_code = -1;

// ---- timers ------------------------------------------------------------------------------------
// Kept here and armed on the platform's (written globalThis.setTimeout: the build redirects the
// bare names to the functions below). A timer that is due when a frame starts runs in that
// frame, so what it changes is drawn at once and frames in tests are deterministic; the
// platform's timer is what makes scriptc's event loop come back for it while nothing draws.

interface Timer {
	fn: (...a: unknown[]) => void;
	args: unknown[];
	/** Milliseconds between runs; 0 for a timeout. */
	every: number;
	due: number;
	handle: unknown;
}
const timers = new Map<number, Timer>();
let next_timer_id = 1;

function arm(id: number, t: Timer) {
	t.handle = globalThis.setTimeout(() => fire(id), Math.max(0, t.due - performance.now()));
}

function fire(id: number) {
	const t = timers.get(id);
	if (!t) return;
	globalThis.clearTimeout(t.handle as never);
	if (t.every) {
		const now = performance.now();
		t.due = Math.max(t.due + t.every, now);
		arm(id, t);
	} else {
		timers.delete(id);
	}
	t.fn(...t.args);
}

function add_timer(fn: (...a: unknown[]) => void, ms: unknown, every: number, args: unknown[]): number {
	const id = next_timer_id++;
	const wait = every || Number(ms) || 0;
	// armed in the literal: with `handle: null` there, scriptc types the field null for good
	const t: Timer = { fn, args, every, due: performance.now() + wait, handle: globalThis.setTimeout(() => fire(id), wait) };
	timers.set(id, t);
	return id;
}

export function set_timeout(fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]): number {
	return add_timer(fn, ms, 0, args);
}
export function set_interval(fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]): number {
	return add_timer(fn, ms, Math.max(1, Number(ms) || 0), args);
}
export function clear_timer(id: unknown) {
	if (typeof id !== 'number') return;
	const t = timers.get(id);
	if (!t) return;
	timers.delete(id);
	globalThis.clearTimeout(t.handle as never);
}

/** Runs the timers that are due (those there now: a callback may add and clear timers). */
function run_due_timers(): boolean {
	if (!timers.size) return false;
	const now = performance.now();
	const ids: number[] = [];
	timers.forEach((t, id) => {
		if (t.due <= now) ids.push(id);
	});
	for (const id of ids) {
		try {
			fire(id);
		} catch (e) {
			console.error('[cui-svelte] error in a timer:', e);
		}
	}
	return ids.length > 0;
}

/** Seconds until the next timer, or -1 for none. */
function next_timer(): number {
	let soonest = -1;
	timers.forEach((t) => {
		if (soonest < 0 || t.due < soonest) soonest = t.due;
	});
	return soonest < 0 ? -1 : Math.max(0, (soonest - performance.now()) / 1000);
}

let frame_callbacks = new Map<number, (t: number) => void>();
let next_frame_id = 1;

export function request_animation_frame(cb: (t: number) => void) {
	const id = next_frame_id++;
	frame_callbacks.set(id, cb);
	return id;
}
export function cancel_animation_frame(id: number) {
	frame_callbacks.delete(id);
}

function run_frame_callbacks(time: number) {
	const cbs = frame_callbacks;
	frame_callbacks = new Map();
	for (const cb of cbs.values()) {
		try {
			cb(time);
		} catch (e) {
			console.error(e);
		}
	}
}

// ---- the frame ----------------------------------------------------------------------------------

/** Events the last frame queued, to JS. */
function dispatch_events(): boolean {
	const n = ffi.ev_count();
	if (!n) return false;
	// each event is [handle, slot, ...values]. `new Array()`: once the types are gone, a literal
	// that starts with two numbers is an array of numbers to scriptc, and a string in it throws
	const events: unknown[][] = new Array();
	for (let i = 0; i < n; i++) {
		const ev: unknown[] = new Array();
		ev.push(ffi.ev_handle(i));
		ev.push(ffi.ev_slot(i));
		const kind = ffi.ev_kind(i);
		if (kind === EV_NUM) ev.push(ffi.ev_a(i));
		else if (kind === EV_BOOL) ev.push(ffi.ev_a(i) !== 0);
		else if (kind === EV_NUM2) {
			ev.push(ffi.ev_a(i));
			ev.push(ffi.ev_b(i));
		} else if (kind === EV_STR) ffi.ev_str(i, (text) => void ev.push(text));
		else if (kind === EV_BYTES) ffi.ev_bytes(i, (data) => void ev.push(data));
		events.push(ev);
	}
	ffi.ev_clear();
	const dispatch = hooks().dispatch;
	if (dispatch) for (const ev of events) dispatch(ev[0] as number, ev[1] as number, ...ev.slice(2));
	return true;
}

let last_width = 0;
let last_height = 0;

/** Toasts whose action was clicked or that are gone, and a changed window size, to JS. */
function app_events(): boolean {
	let changed = false;
	for (let h = ffi.toast_next(); h >= 0; h = ffi.toast_next()) {
		if (ffi.toast_kind() === 1) hooks().toast_action?.(h);
		else hooks().toast_gone?.(h);
		changed = true;
	}
	const w = ffi.viewport_part(0);
	const h = ffi.viewport_part(1);
	if (w !== last_width || h !== last_height) {
		last_width = w;
		last_height = h;
		hooks().resize?.(w, h);
		changed = true;
	}
	return changed;
}

/** One frame: false once the window is closed. */
function frame(): boolean {
	if (!ffi.frame_begin()) return false;
	in_frame = true;
	let changed = false;
	try {
		changed = dispatch_events();
		if (run_due_timers()) changed = true;
		if (app_events()) changed = true;
		if (frame_callbacks.size) {
			run_frame_callbacks(ffi.time_ms());
			changed = true;
		}
		// Svelte applies a state change in a microtask, and microtasks only run once this turn
		// is over: what the callbacks above changed is applied now, to be in this frame
		if (changed) flushSync();
		hooks().commit?.();
	} finally {
		// the frame was begun: build it whatever JS threw
		if (dirty || frame_callbacks.size) changed = true;
		dirty = false;
		// promises and I/O settle in scriptc's event loop, which only runs between frames, and
		// the window sleeps inside frame_begin: without a timer to wait for, look again 20 times
		// a second
		const timer = next_timer();
		ffi.frame_render(changed, timer < 0 ? 0.05 : Math.min(timer, 0.05));
		in_frame = false;
	}
	return true;
}

function not_in_frame(what: string) {
	if (in_frame) throw new Error(`${what} cannot run inside a frame (from an event handler, a timer or onpaint)`);
}

// ---- the bridge ---------------------------------------------------------------------------------

const touch = () => {
	dirty = true;
};

const bridge: Bridge = {
	...natives,
	root: () => ffi.root(),
	scope: (template) => ffi.scope(template),
	free: (handle) => (touch(), ffi.free(handle)),
	insert: (parent, site, child, before) => (touch(), ffi.insert(parent, site, child, before || 0)),
	detach: (handle) => (touch(), ffi.detach(handle)),

	num: (handle, slot, value) => (touch(), ffi.num(handle, slot, value)),
	bool: (handle, slot, value) => (touch(), ffi.bool(handle, slot, !!value)),
	str: (handle, slot, value) => (touch(), ffi.str(handle, slot, value)),
	unset: (handle, slot) => (touch(), ffi.unset(handle, slot)),
	fn: (handle, slot, present) => ffi.fn(handle, slot, !!present),
	strs: (handle, slot, value) => (touch(), ffi.strs(handle, slot, pack_strings(value), value.length)),
	floats(handle, slot, value) {
		touch();
		ffi.floats(handle, slot, float_bytes(value));
	},
	blob(handle, slot, value) {
		touch();
		ffi.blob(handle, slot, value instanceof Uint8Array ? value : new Uint8Array(value));
	},

	timeout: (fn, ms, repeat) => (repeat ? set_interval(fn, ms) : set_timeout(fn, ms)),
	clear: (id) => clear_timer(id),
	want_frame: () => {},
	want_keys: (on: boolean) => ffi.want_keys(!!on),
	print(level, text) {
		if (level >= 2) console.error(text);
		else console.log(text);
	},
	now: () => performance.now(),

	app(options) {
		const o = options as Record<string, unknown>;
		const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
		const flags = (o.fixed_size ? 1 : 0) | (o.continuous ? 2 : 0) | (o.hidden ? 4 : 0) | (headless ? 8 : 0);
		const theme = o.theme === 'dark' ? 1 : o.theme === 'system' ? 2 : 0;
		const ok = ffi.app(
			typeof o.title === 'string' ? o.title : '',
			int(o.width),
			int(o.height),
			int(o.min_width),
			int(o.min_height),
			flags,
			Math.max(0, RENDERERS.indexOf(String(o.renderer))),
			theme,
			ACCENTS.indexOf(String(o.accent))
		);
		if (!ok) throw new Error('could not open a window');
		return true;
	},
	redraw: () => ffi.redraw(),
	quit: () => ffi.quit(),
	set_title: (title: string) => ffi.set_title(String(title)),
	set_theme: (theme: string) => ffi.set_theme(theme === 'dark'),
	get_theme: () => (ffi.get_theme() ? 'dark' : 'light'),
	set_accent: (accent: string) => ffi.set_accent(Math.max(0, ACCENTS.indexOf(accent))),
	natives: Object.fromEntries(native_names.map((name) => [name, (...args: unknown[]) => call_native(name, args)])),
	scriptc: true,
	headless,

	test_frame(n = 1) {
		not_in_frame('test_frame');
		for (let i = 0; i < n; i++) frame();
	},
	test_move: (x: number, y: number) => ffi.test_move(x, y),
	test_button: (button: number, down: boolean) => ffi.test_button(button, !!down),
	test_key: (key: number, down: boolean, mods = 0) => ffi.test_key(key, !!down, mods),
	test_text: (text: string) => ffi.test_text(text),
	test_scroll: (dx: number, dy: number) => ffi.test_scroll(dx, dy),
	test_motion: (on: boolean) => ffi.test_motion(!!on),
	test_nodes() {
		const out: unknown[][] = [];
		ffi.test_nodes((text, x, y, w, h, dy) => out.push([text, x, y, w, h, dy]));
		return out;
	},
	test_rect(key: string) {
		if (!ffi.test_rect(key)) return null;
		return [ffi.rect_part(0), ffi.rect_part(1), ffi.rect_part(2), ffi.rect_part(3)];
	},
	test_png(path: string) {
		not_in_frame('test_png');
		return ffi.test_png(path);
	},
	test_clipboard() {
		let text = '';
		ffi.test_clipboard((s) => {
			text = s;
		});
		return text;
	},
	test_exit(code = 0) {
		exit_code = code;
	}
};

// The renderer and the host APIs reach these by name (`native()[name]`). Installed as a
// dictionary rather than as the object above: over an object whose members scriptc knows,
// a call by a computed name must be compiled for every member's signature at once (and
// scriptc 0.4.10 fails on that with an empty SC3004).
globalThis.__cuisv = Object.fromEntries(Object.entries(bridge)) as Bridge;

/** Runs the app until its window closes. Called once the entry module has run. */
export function start() {
	ffi.on_paint((handle, slot, x, y, w, h) => hooks().paint?.(handle, slot, x, y, w, h));
	if (headless) {
		// a test file drives frames itself and reports through test_exit; its tests start in a
		// microtask and may await timers, so look again until it reported or ran out of time
		const deadline = performance.now() + (Number(process.env.CUISV_TEST_TIMEOUT) || 60) * 1000;
		const wait = () => {
			if (exit_code >= 0) return finish(exit_code);
			if (performance.now() > deadline) {
				hooks().unfinished?.();
				console.error('[cui-svelte] error: test timed out');
				return finish(1);
			}
			globalThis.setTimeout(wait, 1);
		};
		wait();
		return;
	}
	const turn = () => {
		// what a promise or I/O changed since the last turn: draw it
		if (dirty) ffi.redraw();
		if (!frame()) return finish(0);
		globalThis.setImmediate(turn);
	};
	turn();
}

function finish(code: number) {
	hooks().teardown?.();
	ffi.shutdown();
	process.exit(code);
}
