/**
 * Host APIs for app code: clipboard, links, native file dialogs, toasts, the window size,
 * files and app data. Over the native bridge; the browser build provides what a page can.
 */
import { createSubscriber } from 'svelte/reactivity';
import { native, hooks } from './bridge.ts';
import { ENUMS } from './tables.ts';

type Fn<A extends unknown[] = unknown[], R = unknown> = (...a: A) => R;
const call = <R>(name: string, ...args: unknown[]): R => (native()[name] as Fn<unknown[], R>)(...args);

// ---- clipboard and links ------------------------------------------------------------------

export const clipboard = {
	read(): string {
		return call<string>('clipboard_read');
	},
	write(text: string) {
		call('clipboard_write', String(text));
	}
};

/** Opens a URL (or a file) with the system's default handler. */
export function open_url(url: string): boolean {
	return call<boolean>('open_url', String(url));
}

// ---- file dialogs ---------------------------------------------------------------------------

export interface FileDialogOptions {
	title?: string;
	/** e.g. "Images" */
	filter_name?: string;
	/** extensions separated by ';', e.g. "png;jpg" */
	filter?: string;
	/** save: the name to start with */
	default_name?: string;
}

const dialog = (kind: number, o: FileDialogOptions = {}) => Promise.resolve(call<string | null>('file_dialog', { ...o, kind }));

/** The system's open dialog. Resolves to the chosen path, or null. */
export const open_file = (o?: FileDialogOptions) => dialog(0, o);
export const save_file = (o?: FileDialogOptions) => dialog(1, o);
export const choose_folder = (o?: FileDialogOptions) => dialog(2, o);

// ---- toasts ------------------------------------------------------------------------------------

export interface ToastOptions {
	description?: string;
	tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'violet' | 'teal' | 'rose' | 'accent';
	/** seconds, default 4; negative stays until dismissed */
	duration?: number;
	/** a button label; onaction runs when it is clicked */
	action?: string;
	onaction?: () => void;
	/** a draining line shows how long the action stays (undo) */
	show_timer?: boolean;
}

const toast_actions = new Map<number, () => void>();

export function toast(title: string, o: ToastOptions = {}) {
	const tone = o.tone ? (ENUMS.cui_tone[o.tone] ?? 0) : 0;
	const handle = call<number>('toast', String(title), { ...o, tone, onaction: undefined });
	if (o.onaction && o.action) toast_actions.set(handle, o.onaction);
	return {
		handle,
		dismiss() {
			call('toast_dismiss', handle);
			toast_actions.delete(handle);
		}
	};
}

hooks().toast_action = (handle: number) => {
	const fn = toast_actions.get(handle);
	toast_actions.delete(handle);
	fn?.();
};

// ---- the window size ------------------------------------------------------------------------------

let size = [0, 0];
let notify: (() => void) | null = null;
const subscribe = createSubscriber((update) => {
	notify = update;
	return () => {
		notify = null;
	};
});

hooks().resize = (w: number, h: number) => {
	size = [w, h];
	notify?.();
};

/** The window's size in points, reactive: read it in markup or an $effect. */
export const viewport = {
	get width(): number {
		subscribe();
		if (!size[0]) size = call<number[]>('viewport');
		return size[0];
	},
	get height(): number {
		subscribe();
		if (!size[1]) size = call<number[]>('viewport');
		return size[1];
	}
};

// ---- files ----------------------------------------------------------------------------------------------

export interface FileInfo {
	name?: string;
	size: number;
	dir: boolean;
	/** milliseconds since 1970 */
	modified: number;
}

export const fs = {
	read_text(path: string): string | null {
		return call<string | null>('fs_read', path, false);
	},
	read_bytes(path: string): Uint8Array | null {
		return call<Uint8Array | null>('fs_read', path, true);
	},
	write_text(path: string, text: string): boolean {
		return call<boolean>('fs_write', path, String(text), false);
	},
	append_text(path: string, text: string): boolean {
		return call<boolean>('fs_write', path, String(text), true);
	},
	write_bytes(path: string, bytes: Uint8Array | ArrayBuffer): boolean {
		return call<boolean>('fs_write', path, bytes, false);
	},
	exists(path: string): boolean {
		return call<FileInfo | null>('fs_stat', path) !== null;
	},
	stat(path: string): FileInfo | null {
		return call<FileInfo | null>('fs_stat', path);
	},
	/** Entries of a folder (hidden ones too), or null when it cannot be read. */
	list(path: string): FileInfo[] | null {
		return call<FileInfo[] | null>('fs_list', path);
	},
	remove(path: string): boolean {
		return call<boolean>('fs_remove', path);
	},
	/** Creates the folder and any missing parents. */
	mkdir(path: string): boolean {
		return call<boolean>('fs_mkdir', path);
	}
};

let app_id = '';

export function set_app_id(id: string) {
	app_id = id.replace(/[^\w.-]+/g, '-');
}

function default_app_id() {
	const exe = (call<string[]>('args')[0] ?? 'app').split(/[\\/]/).pop()!.replace(/\.exe$/i, '');
	return exe.replace(/_test$/, '') || 'app';
}

export const paths = {
	/** The folder this app keeps its data in (created on first use). */
	data(): string {
		const dir = `${call<string>('data_dir')}/${app_id || default_app_id()}`;
		fs.mkdir(dir);
		return dir;
	},
	home(): string {
		return call<string>('home_dir');
	}
};

// ---- localStorage ------------------------------------------------------------------------------------------

/** Web Storage over a JSON file in the app's data folder, written shortly after each change. */
class FileStorage {
	#data: Map<string, string> | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#file() {
		return `${paths.data()}/localStorage.json`;
	}
	#load() {
		if (this.#data) return this.#data;
		this.#data = new Map();
		try {
			const text = fs.read_text(this.#file());
			if (text) for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, string>)) this.#data.set(k, String(v));
		} catch {
			/* a broken file starts empty */
		}
		return this.#data;
	}
	#save() {
		if (this.#timer) return;
		this.#timer = setTimeout(() => this.flush(), 50);
	}
	flush() {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		if (this.#data) fs.write_text(this.#file(), JSON.stringify(Object.fromEntries(this.#data)));
	}
	get length() {
		return this.#load().size;
	}
	key(i: number) {
		return [...this.#load().keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.#load().get(String(k)) ?? null;
	}
	setItem(k: string, v: unknown) {
		this.#load().set(String(k), String(v));
		this.#save();
	}
	removeItem(k: string) {
		if (this.#load().delete(String(k))) this.#save();
	}
	clear() {
		this.#load().clear();
		this.#save();
	}
}

export const local_storage = new FileStorage();
const g = globalThis as Record<string, unknown>;
if (!g.localStorage && g.__cuisv && !(g.__cuisv as Record<string, unknown>).browser) g.localStorage = local_storage;

// ---- log and terminal buffers --------------------------------------------------------------

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Lines for <LogView buffer={log} />: append from anywhere, the view follows. */
export class LogBuffer {
	readonly handle: number;
	constructor(o: { lines?: number; bytes?: number } = {}) {
		this.handle = call<number>('buffer_new', 1, o.lines ?? 2000, o.bytes ?? 256 * 1024);
	}
	append(level: 'debug' | 'info' | 'warn' | 'error', ...parts: unknown[]) {
		call('buffer_write', this.handle, parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '), LEVELS[level] ?? 1);
	}
	debug(...p: unknown[]) {
		this.append('debug', ...p);
	}
	info(...p: unknown[]) {
		this.append('info', ...p);
	}
	warn(...p: unknown[]) {
		this.append('warn', ...p);
	}
	error(...p: unknown[]) {
		this.append('error', ...p);
	}
	clear() {
		call('buffer_clear', this.handle);
	}
	dispose() {
		call('buffer_free', this.handle);
	}
}

/** Output for <Terminal buffer={term} />: ANSI colors and cursor moves work. */
export class TerminalBuffer {
	readonly handle: number;
	constructor(o: { lines?: number; bytes?: number } = {}) {
		this.handle = call<number>('buffer_new', 2, o.lines ?? 5000, o.bytes ?? 512 * 1024);
	}
	write(text: string) {
		call('buffer_write', this.handle, String(text));
	}
	writeln(text = '') {
		this.write(text + '\n');
	}
	clear() {
		call('buffer_clear', this.handle);
	}
	dispose() {
		call('buffer_free', this.handle);
	}
}

// ---- keyboard ------------------------------------------------------------------------------

export interface KeyEvent {
	/** The key as cui_key names it: "k", "enter", "escape", "f5", "1", "left". */
	key: string;
	shift: boolean;
	ctrl: boolean;
	alt: boolean;
	/** Command on macOS, the Windows key elsewhere. */
	meta: boolean;
	/** The platform's shortcut modifier: Command on macOS, Ctrl elsewhere. */
	primary: boolean;
	/** A text field has the keyboard (and gets this key too): skip single-letter shortcuts. */
	editing: boolean;
}

const KEY_NAMES = new Map(Object.entries(ENUMS.cui_key).map(([k, v]) => [v, k]));
const key_handlers = new Set<(e: KeyEvent) => void>();
/** Where the app runs: "macos", "windows", "linux", or "web" (the browser build). */
export function platform(): 'macos' | 'windows' | 'linux' | 'web' {
	return call<'macos' | 'windows' | 'linux' | 'web'>('platform');
}

const mac = () => {
	const p = platform();
	if (p !== 'web') return p === 'macos';
	return /mac/i.test((globalThis as { navigator?: { platform?: string } }).navigator?.platform ?? '');
};

/**
 * Every key pressed (with repeat), wherever the focus is. Returns a function that stops
 * listening. For a shortcut: on_key((e) => { if (e.primary && e.key === 'k') open = true; }).
 */
export function on_key(handler: (e: KeyEvent) => void): () => void {
	key_handlers.add(handler);
	call('want_keys', true);
	return () => {
		key_handlers.delete(handler);
		if (!key_handlers.size) call('want_keys', false);
	};
}

let is_mac: boolean | null = null;
hooks().key = (key: number, mods: number) => {
	is_mac ??= mac();
	const e: KeyEvent = {
		key: KEY_NAMES.get(key) ?? String(key),
		shift: !!(mods & 1),
		ctrl: !!(mods & 2),
		alt: !!(mods & 4),
		meta: !!(mods & 8),
		primary: is_mac ? !!(mods & 8) : !!(mods & 2),
		editing: !!(mods & 256)
	};
	for (const h of key_handlers) {
		try {
			h(e);
		} catch (err) {
			console.error(err);
		}
	}
};

// ---- elements by id -----------------------------------------------------------------------

/** Where the element with id="…" was laid out in the latest frame (points), or null. */
export function rect_of(id: string): { x: number; y: number; w: number; h: number } | null {
	return call('rect_of', id);
}

/** Scrolls the scroll area with id="…" (a <Scroll>, or an element with overflow: auto) to y. */
export function scroll_to(id: string, y: number): boolean {
	return call<boolean>('scroll_to', id, y);
}
