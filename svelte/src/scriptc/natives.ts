/**
 * The host natives of the scriptc build (what runtime/cuisv_app.c is to the QuickJS build),
 * by the names src/runtime/host.ts calls. A compiled program has Node's own library, so
 * files, the environment and arguments are plain JS here; the rest goes to C through the FFI.
 *
 * (The functions of <script lang="c"> blocks are bound per app: see app_natives in
 * src/cli/scriptc.ts.)
 */
import * as ffi from 'cuisv-ffi';
import * as fs from 'node:fs';

const encoder = new TextEncoder();

/** A string list as one span: each item a little-endian u32 byte length, then its UTF-8. */
export function pack_strings(list: ArrayLike<unknown>): Uint8Array {
	const parts: Uint8Array[] = [];
	let size = 0;
	for (let i = 0; i < list.length; i++) {
		const item = list[i];
		const b = encoder.encode(item == null ? '' : String(item));
		parts.push(b);
		size += 4 + b.length;
	}
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	let at = 0;
	for (const b of parts) {
		view.setUint32(at, b.length, true);
		out.set(b, at + 4);
		at += 4 + b.length;
	}
	return out;
}

/** What the QuickJS natives make of an argument that is not a number: 0. */
const num = (v: unknown): number => (typeof v === 'number' && !Number.isNaN(v) ? v : Number(v) || 0);

/** Numbers as the bytes of a Float32Array (a loop: scriptc has no Float32Array.from with a mapper). */
export function float_bytes(values: ArrayLike<number>): Uint8Array {
	const f = new Float32Array(values.length);
	for (let i = 0; i < f.length; i++) f[i] = Number(values[i]);
	return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

function text_of(read: (cb: (s: string) => void) => void): string {
	let text = '';
	read((s) => {
		text = s;
	});
	return text;
}

// Paths are passed as text(path): this file reaches scriptc with its types erased, and a
// call of node:fs with an untyped argument gives an untyped result, whose members
// (`.size`, `.isFile()`) scriptc does not compile.

/** A string argument as the QuickJS natives take it: a Symbol throws, anything else converts. */
function text(v: unknown): string {
	if (typeof v === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
	return String(v);
}

function stat(path: string) {
	try {
		const s = fs.statSync(text(path));
		return { size: s.size, dir: s.isDirectory(), modified: Math.floor(s.mtimeMs) };
	} catch {
		return null;
	}
}

export const natives: Record<string, (...args: never[]) => unknown> = {
	args: () => process.argv.slice(1),
	getenv: (name: string) => process.env[name],
	platform: () => (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'),
	home_dir: () => process.env.HOME || process.env.USERPROFILE || '.',
	data_dir() {
		if (process.platform === 'win32') return process.env.APPDATA || '.';
		if (process.platform !== 'darwin' && process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
		return (process.env.HOME || '.') + (process.platform === 'darwin' ? '/Library/Application Support' : '/.local/share');
	},

	fs_read(path: string, bytes: boolean) {
		path = text(path);
		try {
			if (!fs.statSync(text(path)).isFile()) return null;
			const data = fs.readFileSync(text(path));
			return bytes ? new Uint8Array(data) : data.toString('utf8');
		} catch {
			return null;
		}
	},
	fs_write(path: string, data: string | Uint8Array | ArrayBuffer, append: boolean) {
		// the data first: a value that is neither text nor bytes leaves the file as it was
		const content = typeof data === 'string' ? data : data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
		if (content === null) return false;
		path = text(path);
		try {
			if (append) fs.appendFileSync(text(path), content);
			else fs.writeFileSync(text(path), content);
			return true;
		} catch {
			return false;
		}
	},
	fs_stat: (path: string) => stat(text(path)),
	fs_list(path: string) {
		path = text(path);
		try {
			const out: { name: string; dir: boolean; size: number; modified: number }[] = [];
			for (const name of fs.readdirSync(text(path))) {
				const s = stat(`${path}/${name}`);
				if (s) out.push({ name, dir: s.dir, size: s.dir ? 0 : s.size, modified: s.modified });
			}
			// folders first, then by name, as cui_fs_list answers
			out.sort((a, b) => (a.dir === b.dir ? (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1) : a.dir ? -1 : 1));
			return out;
		} catch {
			return null;
		}
	},
	fs_remove(path: string) {
		path = text(path);
		if (!path) return false;
		try {
			if (fs.statSync(text(path)).isDirectory()) fs.rmdirSync(text(path));
			else fs.unlinkSync(text(path));
			return true;
		} catch {
			return false;
		}
	},
	fs_mkdir(path: string) {
		path = text(path);
		if (!path) return false;
		try {
			fs.mkdirSync(text(path), { recursive: true });
		} catch {
			/* answered by the stat below */
		}
		return !!stat(path)?.dir;
	},

	clipboard_write: (text: string) => ffi.clipboard_write(String(text)),
	clipboard_read: () => text_of(ffi.clipboard_read),
	open_url: (url: string) => ffi.open_url(String(url)),
	viewport: () => [ffi.viewport_part(0), ffi.viewport_part(1)],
	rect_of(id: string) {
		if (!ffi.rect_of(String(id))) return null;
		return { x: ffi.rect_part(0), y: ffi.rect_part(1), w: ffi.rect_part(2), h: ffi.rect_part(3) };
	},
	scroll_to: (id: string, y: number) => ffi.scroll_to(String(id), Number(y) || 0),
	get_accent: () => text_of(ffi.get_accent),
	set_strings(list: string[] | null) {
		if (list) ffi.set_strings(pack_strings(list), list.length);
		else ffi.set_strings(new Uint8Array(0), 0);
	},

	toast(title: string, o: { description?: string; action?: string; tone?: number; duration?: number; show_timer?: boolean } = {}) {
		return ffi.toast(String(title), o.description ?? '', o.action ?? '', num(o.tone), num(o.duration), !!o.show_timer);
	},
	toast_dismiss: (handle: number) => ffi.toast_dismiss(num(handle)),
	file_dialog(o: { kind?: number; title?: string; filter_name?: string; filter?: string; default_name?: string } = {}) {
		let path: string | null = null;
		ffi.file_dialog(num(o.kind), o.title ?? '', o.filter_name ?? '', o.filter ?? '', o.default_name ?? '', (s) => {
			path = s;
		});
		return path;
	},

	draw_rect: (x: number, y: number, w: number, h: number, radius: number, fill: number, border: number, border_width = 0) =>
		ffi.draw_rect(num(x), num(y), num(w), num(h), num(radius), num(fill), num(border), num(border_width)),
	draw_circle: (cx: number, cy: number, r: number, color: number) => ffi.draw_circle(num(cx), num(cy), num(r), num(color)),
	draw_line: (x1: number, y1: number, x2: number, y2: number, width: number, color: number) => ffi.draw_line(num(x1), num(y1), num(x2), num(y2), num(width), num(color)),
	draw_polyline: (points: ArrayLike<number>, width: number, color: number, closed: boolean) => ffi.draw_polyline(float_bytes(points), num(width), num(color), !!closed),
	draw_polygon: (points: ArrayLike<number>, color: number) => ffi.draw_polygon(float_bytes(points), num(color)),
	draw_arc: (cx: number, cy: number, r: number, a0: number, a1: number, width: number, color: number) => ffi.draw_arc(num(cx), num(cy), num(r), num(a0), num(a1), num(width), num(color)),
	draw_text: (x: number, y: number, text: string, size: number, color: number, font: number) => ffi.draw_text(num(x), num(y), String(text), num(size), num(color), num(font)),
	draw_icon: (name: string, x: number, y: number, w: number, h: number, size: number, color: number) => ffi.draw_icon(String(name), num(x), num(y), num(w), num(h), num(size), num(color)),
	draw_clip(x?: number, y?: number, w?: number, h?: number) {
		if (h === undefined) ffi.draw_unclip();
		else ffi.draw_clip(num(x), num(y), num(w), num(h));
	},
	measure_text: (text: string, size: number, font = 0) => ffi.measure_text(String(text), num(size), num(font)),

	buffer_new: (kind: number, lines: number, bytes: number) => ffi.buffer_new(kind, lines, bytes),
	buffer_write: (handle: number, text: string, level = 1) => ffi.buffer_write(handle, String(text), level),
	buffer_clear: (handle: number) => ffi.buffer_clear(handle),
	buffer_free: (handle: number) => ffi.buffer_free(handle)
};
