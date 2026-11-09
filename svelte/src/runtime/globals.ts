/**
 * The web-ish globals Svelte and npm packages expect, over the native bridge: console,
 * timers, requestAnimationFrame, structuredClone, TextEncoder/TextDecoder. QuickJS-ng brings
 * queueMicrotask and performance itself. Imported first by every app bundle.
 */
import { native, hooks } from './bridge.ts';

const g = globalThis as Record<string, unknown>;

// ---- console -------------------------------------------------------------------------------

function inspect(v: unknown, depth = 0, seen = new Set<unknown>()): string {
	if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
	if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
	if (typeof v === 'symbol' || typeof v === 'bigint') return String(v) + (typeof v === 'bigint' ? 'n' : '');
	if (v === null || typeof v !== 'object') return String(v);
	if (v instanceof Error) return depth ? `[${v.name}: ${v.message}]` : `${v.name}: ${v.message}${v.stack ? '\n' + v.stack : ''}`;
	if (seen.has(v)) return '[Circular]';
	if (depth > 4) return Array.isArray(v) ? '[Array]' : '[Object]';
	seen.add(v);
	try {
		if (Array.isArray(v)) return `[ ${v.map((x) => inspect(x, depth + 1, seen)).join(', ')} ]`;
		if (v instanceof Map) return `Map(${v.size}) { ${[...v].map(([k, x]) => `${inspect(k, depth + 1, seen)} => ${inspect(x, depth + 1, seen)}`).join(', ')} }`;
		if (v instanceof Set) return `Set(${v.size}) { ${[...v].map((x) => inspect(x, depth + 1, seen)).join(', ')} }`;
		if (v instanceof Date) return v.toISOString();
		if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${(v as unknown as ArrayLike<number>).length}) [ ${Array.from(v as unknown as ArrayLike<number>).slice(0, 32).join(', ')} ]`;
		const entries = Object.entries(v as object).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${inspect(x, depth + 1, seen)}`);
		const name = (v as object).constructor && (v as object).constructor !== Object ? (v as object).constructor.name + ' ' : '';
		return entries.length ? `${name}{ ${entries.join(', ')} }` : `${name}{}`;
	} finally {
		seen.delete(v);
	}
}

function format(args: unknown[]): string {
	if (typeof args[0] === 'string' && /%[sdifoOjc%]/.test(args[0])) {
		let i = 1;
		const head = (args[0] as string).replace(/%([sdifoOjc%])/g, (m, f: string) => {
			if (f === '%') return '%';
			if (i >= args.length) return m;
			const a = args[i++];
			if (f === 's') return typeof a === 'string' ? a : inspect(a, 1);
			if (f === 'd' || f === 'i') return String(Math.trunc(Number(a)));
			if (f === 'f') return String(Number(a));
			if (f === 'c') return '';
			return inspect(a, 1);
		});
		return [head, ...args.slice(i).map((a) => inspect(a))].join(' ');
	}
	return args.map((a) => inspect(a)).join(' ');
}

const counts = new Map<string, number>();
const timers = new Map<string, number>();
const out = (level: number) => (...args: unknown[]) => native().print(level, format(args));

g.console = {
	log: out(0),
	info: out(0),
	debug: out(0),
	trace: out(0),
	warn: out(2),
	error: out(2),
	dir: (v: unknown) => native().print(0, inspect(v)),
	table: (v: unknown) => native().print(0, inspect(v)),
	assert: (cond: unknown, ...args: unknown[]) => {
		if (!cond) native().print(2, 'Assertion failed' + (args.length ? ': ' + format(args) : ''));
	},
	count: (label = 'default') => {
		const n = (counts.get(label) ?? 0) + 1;
		counts.set(label, n);
		native().print(0, `${label}: ${n}`);
	},
	countReset: (label = 'default') => counts.delete(label),
	time: (label = 'default') => timers.set(label, native().now()),
	timeEnd: (label = 'default') => {
		const t = timers.get(label);
		if (t !== undefined) native().print(0, `${label}: ${(native().now() - t).toFixed(3)}ms`);
		timers.delete(label);
	},
	timeLog: (label = 'default', ...args: unknown[]) => {
		const t = timers.get(label);
		if (t !== undefined) native().print(0, `${label}: ${(native().now() - t).toFixed(3)}ms ${format(args)}`);
	},
	group: out(0),
	groupEnd: () => {}
};

// ---- timers --------------------------------------------------------------------------------

g.setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) =>
	native().timeout(() => fn(...args), Number(ms) || 0, false);
g.setInterval = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) =>
	native().timeout(() => fn(...args), Number(ms) || 0, true);
g.clearTimeout = g.clearInterval = (id: number) => {
	if (id != null) native().clear(id);
};
g.setImmediate ??= (fn: () => void) => native().timeout(fn, 0, false);

// ---- animation frames -------------------------------------------------------------------------

let frame_callbacks: Map<number, (t: number) => void> = new Map();
let next_frame_id = 1;

g.requestAnimationFrame = (cb: (t: number) => void) => {
	const id = next_frame_id++;
	frame_callbacks.set(id, cb);
	native().want_frame();
	return id;
};
g.cancelAnimationFrame = (id: number) => {
	frame_callbacks.delete(id);
};
hooks().frame = (time: number) => {
	const run = frame_callbacks;
	frame_callbacks = new Map();
	for (const cb of run.values()) {
		try {
			cb(time);
		} catch (e) {
			console.error(e);
		}
	}
};

// ---- structuredClone ------------------------------------------------------------------------------

function clone(v: unknown, seen: Map<unknown, unknown>): unknown {
	if (v === null || typeof v !== 'object') return v;
	if (seen.has(v)) return seen.get(v);
	if (v instanceof Date) return new Date(v.getTime());
	if (v instanceof RegExp) return new RegExp(v.source, v.flags);
	if (ArrayBuffer.isView(v)) return (v as unknown as { slice(): unknown }).slice();
	if (v instanceof ArrayBuffer) return v.slice(0);
	if (v instanceof Map) {
		const m = new Map();
		seen.set(v, m);
		for (const [k, x] of v) m.set(clone(k, seen), clone(x, seen));
		return m;
	}
	if (v instanceof Set) {
		const s = new Set();
		seen.set(v, s);
		for (const x of v) s.add(clone(x, seen));
		return s;
	}
	const o: Record<string, unknown> | unknown[] = Array.isArray(v) ? [] : {};
	seen.set(v, o);
	for (const k of Object.keys(v)) (o as Record<string, unknown>)[k] = clone((v as Record<string, unknown>)[k], seen);
	return o;
}
g.structuredClone ??= (v: unknown) => clone(v, new Map());

// ---- text encoding -----------------------------------------------------------------------------------

if (!g.TextEncoder) {
	g.TextEncoder = class TextEncoder {
		readonly encoding = 'utf-8';
		/** UTF-8, with U+FFFD for a lone surrogate (as browsers do). */
		encode(input = ''): Uint8Array {
			const s = String(input);
			const out = new Uint8Array(s.length * 3);
			let n = 0;
			for (let i = 0; i < s.length; i++) {
				let c = s.charCodeAt(i);
				if (c >= 0xd800 && c < 0xe000) {
					const d = c < 0xdc00 && i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
					if (d >= 0xdc00 && d < 0xe000) {
						c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
						i++;
					} else c = 0xfffd;
				}
				if (c < 0x80) out[n++] = c;
				else if (c < 0x800) {
					out[n++] = 0xc0 | (c >> 6);
					out[n++] = 0x80 | (c & 63);
				} else if (c < 0x10000) {
					out[n++] = 0xe0 | (c >> 12);
					out[n++] = 0x80 | ((c >> 6) & 63);
					out[n++] = 0x80 | (c & 63);
				} else {
					out[n++] = 0xf0 | (c >> 18);
					out[n++] = 0x80 | ((c >> 12) & 63);
					out[n++] = 0x80 | ((c >> 6) & 63);
					out[n++] = 0x80 | (c & 63);
				}
			}
			return out.slice(0, n);
		}
	};
}
if (!g.TextDecoder) {
	/**
	 * UTF-8 as the WHATWG Encoding standard decodes it (and browsers do): each invalid or
	 * truncated sequence becomes one U+FFFD (or a TypeError when `fatal`), a leading byte order
	 * mark is dropped unless `ignoreBOM`, and `{ stream: true }` keeps a sequence split between
	 * calls. Only UTF-8: other labels decode as UTF-8 too.
	 */
	g.TextDecoder = class TextDecoder {
		readonly encoding = 'utf-8';
		readonly fatal: boolean;
		readonly ignoreBOM: boolean;
		#cp = 0;
		#needed = 0;
		#seen = 0;
		#lower = 0x80;
		#upper = 0xbf;
		#bom_checked = false;
		constructor(_label = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
			this.fatal = !!options?.fatal;
			this.ignoreBOM = !!options?.ignoreBOM;
		}
		decode(input?: ArrayBuffer | ArrayBufferView | null, options?: { stream?: boolean }): string {
			const b = !input ? new Uint8Array(0) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
			let s = '';
			const units: number[] = [];
			const emit = (cp: number) => {
				if (!this.#bom_checked) {
					this.#bom_checked = true;
					if (cp === 0xfeff && !this.ignoreBOM) return;
				}
				if (cp > 0xffff) {
					cp -= 0x10000;
					units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
				} else units.push(cp);
				if (units.length >= 8192) {
					s += String.fromCharCode.apply(null, units);
					units.length = 0;
				}
			};
			const error = () => {
				this.#reset();
				if (this.fatal) {
					this.#bom_checked = false;
					throw new TypeError('The encoded data was not valid utf-8');
				}
				emit(0xfffd);
			};
			for (let i = 0; i < b.length; i++) {
				const c = b[i];
				if (this.#needed === 0) {
					if (c < 0x80) emit(c);
					else if (c >= 0xc2 && c <= 0xdf) {
						this.#needed = 1;
						this.#cp = c & 0x1f;
					} else if (c >= 0xe0 && c <= 0xef) {
						if (c === 0xe0) this.#lower = 0xa0;
						if (c === 0xed) this.#upper = 0x9f;
						this.#needed = 2;
						this.#cp = c & 0xf;
					} else if (c >= 0xf0 && c <= 0xf4) {
						if (c === 0xf0) this.#lower = 0x90;
						if (c === 0xf4) this.#upper = 0x8f;
						this.#needed = 3;
						this.#cp = c & 0x7;
					} else error();
					continue;
				}
				if (c < this.#lower || c > this.#upper) {
					// the sequence ends here; the byte that ended it starts over
					error();
					i--;
					continue;
				}
				this.#lower = 0x80;
				this.#upper = 0xbf;
				this.#cp = (this.#cp << 6) | (c & 0x3f);
				if (++this.#seen === this.#needed) {
					const cp = this.#cp;
					this.#reset();
					emit(cp);
				}
			}
			if (!options?.stream) {
				if (this.#needed) error();
				this.#bom_checked = false;
			}
			return s + String.fromCharCode.apply(null, units);
		}
		#reset() {
			this.#cp = this.#needed = this.#seen = 0;
			this.#lower = 0x80;
			this.#upper = 0xbf;
		}
	};
}

g.global ??= globalThis;

// ---- URL and URLSearchParams (QuickJS has neither; svelte/reactivity and many packages do) --

if (!g.URLSearchParams) {
	const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
	const dec = (s: string) => {
		try {
			return decodeURIComponent(s.replace(/\+/g, ' '));
		} catch {
			return s;
		}
	};
	class URLSearchParams {
		#list: [string, string][] = [];
		_url: { _set_search(s: string): void } | null = null;
		constructor(init?: string | Record<string, string> | [string, string][] | URLSearchParams) {
			if (init == null) return;
			if (typeof init === 'string') {
				for (const part of init.replace(/^\?/, '').split('&')) {
					if (!part) continue;
					const i = part.indexOf('=');
					this.#list.push(i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]);
				}
			} else if (init instanceof URLSearchParams) this.#list = [...init.entries()];
			else if (Array.isArray(init)) this.#list = init.map(([k, v]) => [String(k), String(v)]);
			else this.#list = Object.entries(init).map(([k, v]) => [k, String(v)]);
		}
		#changed() {
			this._url?._set_search(this.toString());
		}
		get size() {
			return this.#list.length;
		}
		append(k: string, v: string) {
			this.#list.push([String(k), String(v)]);
			this.#changed();
		}
		delete(k: string, v?: string) {
			this.#list = this.#list.filter(([a, b]) => !(a === k && (v === undefined || b === v)));
			this.#changed();
		}
		get(k: string) {
			return this.#list.find(([a]) => a === k)?.[1] ?? null;
		}
		getAll(k: string) {
			return this.#list.filter(([a]) => a === k).map(([, b]) => b);
		}
		has(k: string, v?: string) {
			return this.#list.some(([a, b]) => a === k && (v === undefined || b === v));
		}
		set(k: string, v: string) {
			const i = this.#list.findIndex(([a]) => a === k);
			if (i < 0) this.#list.push([String(k), String(v)]);
			else {
				this.#list[i] = [String(k), String(v)];
				this.#list = this.#list.filter(([a], j) => a !== k || j === i);
			}
			this.#changed();
		}
		sort() {
			this.#list.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
			this.#changed();
		}
		forEach(fn: (v: string, k: string, p: URLSearchParams) => void) {
			for (const [k, v] of this.#list) fn(v, k, this);
		}
		keys() {
			return this.#list.map(([k]) => k)[Symbol.iterator]();
		}
		values() {
			return this.#list.map(([, v]) => v)[Symbol.iterator]();
		}
		entries() {
			return this.#list.map(([k, v]) => [k, v] as [string, string])[Symbol.iterator]();
		}
		[Symbol.iterator]() {
			return this.entries();
		}
		toString() {
			return this.#list.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
		}
	}
	g.URLSearchParams = URLSearchParams;

	const RE = /^([a-z][a-z0-9+.-]*:)(?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]*)(?::(\d+))?)?([^?#]*)(\?[^#]*)?(#.*)?$/i;
	class URL {
		protocol = '';
		username = '';
		password = '';
		hostname = '';
		port = '';
		pathname = '';
		hash = '';
		#search = '';
		#params: URLSearchParams | null = null;
		constructor(input: string | URL, base?: string | URL) {
			let s = String(input);
			if (!RE.test(s) || !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
				if (base === undefined) throw new TypeError(`Invalid URL: ${s}`);
				const b = new URL(base);
				if (s.startsWith('//')) s = b.protocol + s;
				else if (s.startsWith('/')) s = `${b.origin}${s}`;
				else if (s.startsWith('?')) s = `${b.origin}${b.pathname}${s}`;
				else if (s.startsWith('#')) s = `${b.origin}${b.pathname}${b.search}${s}`;
				else {
					const dir = b.pathname.replace(/[^/]*$/, '');
					const parts: string[] = [];
					for (const seg of (dir + s.replace(/[?#].*$/, '')).split('/')) {
						if (seg === '..') parts.pop();
						else if (seg !== '.') parts.push(seg);
					}
					s = `${b.origin}${parts.join('/')}${(/[?#].*$/.exec(s) ?? [''])[0]}`;
				}
			}
			const m = RE.exec(s);
			if (!m) throw new TypeError(`Invalid URL: ${s}`);
			this.protocol = m[1].toLowerCase();
			this.username = m[2] ?? '';
			this.password = m[3] ?? '';
			this.hostname = (m[4] ?? '').toLowerCase();
			this.port = m[5] ?? '';
			this.pathname = m[6] || (this.hostname ? '/' : '');
			this.#search = m[7] && m[7] !== '?' ? m[7] : '';
			this.hash = m[8] && m[8] !== '#' ? m[8] : '';
		}
		get host() {
			return this.port ? `${this.hostname}:${this.port}` : this.hostname;
		}
		get origin() {
			return this.hostname ? `${this.protocol}//${this.host}` : 'null';
		}
		get search() {
			return this.#search;
		}
		set search(v: string) {
			this.#search = v ? (v.startsWith('?') ? v : '?' + v) : '';
			this.#params = null;
		}
		_set_search(v: string) {
			this.#search = v ? '?' + v : '';
		}
		get searchParams() {
			if (!this.#params) {
				this.#params = new URLSearchParams(this.#search);
				this.#params._url = this;
			}
			return this.#params;
		}
		get href() {
			const auth = this.username ? `${this.username}${this.password ? ':' + this.password : ''}@` : '';
			return `${this.protocol}${this.hostname || this.protocol === 'file:' ? '//' : ''}${auth}${this.host}${this.pathname}${this.#search}${this.hash}`;
		}
		toString() {
			return this.href;
		}
		toJSON() {
			return this.href;
		}
		static canParse(u: string, b?: string) {
			try {
				new URL(u, b);
				return true;
			} catch {
				return false;
			}
		}
	}
	g.URL = URL;
}

// ---- crypto.getRandomValues / randomUUID (not cryptographically strong: Math.random) -------

if (!(g.crypto as { getRandomValues?: unknown } | undefined)?.getRandomValues) {
	const getRandomValues = <T extends ArrayBufferView>(a: T): T => {
		const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
		for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0;
		return a;
	};
	g.crypto = {
		getRandomValues,
		randomUUID() {
			const b = getRandomValues(new Uint8Array(16));
			b[6] = (b[6] & 0x0f) | 0x40;
			b[8] = (b[8] & 0x3f) | 0x80;
			const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
			return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
		}
	};
}
