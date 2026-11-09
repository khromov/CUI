/**
 * What <Canvas onpaint={(g) => …}> draws with. Coordinates are points from the canvas's top
 * left corner; colors are any CSS color or theme token ("accent", "border").
 */
import { native, hooks } from './bridge.ts';
import { color, icon } from './helpers.ts';
import { scope_fn } from './renderer.ts';

type Fn = (...a: unknown[]) => unknown;
const draw = (name: string, ...args: unknown[]) => (native()[name] as Fn)(...args);
const col = (c: unknown, fallback = 'foreground') => color(c ?? fallback) ?? 0;
const FONTS: Record<string, number> = { body: 0, medium: 1, display: 2, mono: 3 };

type Points = ArrayLike<number> | { x: number; y: number }[];

export class Painter {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	constructor(x: number, y: number, width: number, height: number) {
		this.x = x;
		this.y = y;
		this.width = width;
		this.height = height;
	}
	#flat(points: Points): number[] {
		const out: number[] = [];
		const a = points as ArrayLike<unknown>;
		for (let i = 0; i < a.length; i++) {
			const p = a[i];
			if (typeof p === 'number') out.push(i % 2 === 0 ? p + this.x : p + this.y);
			else out.push((p as { x: number }).x + this.x, (p as { y: number }).y + this.y);
		}
		return out;
	}
	rect(x: number, y: number, w: number, h: number, o: { fill?: unknown; border?: unknown; border_width?: number; radius?: number } = {}) {
		draw('draw_rect', this.x + x, this.y + y, w, h, o.radius ?? 0, col(o.fill, 'transparent'), col(o.border, 'border'), o.border !== undefined ? (o.border_width ?? 1) : 0);
	}
	circle(cx: number, cy: number, r: number, fill?: unknown) {
		draw('draw_circle', this.x + cx, this.y + cy, r, col(fill));
	}
	line(x1: number, y1: number, x2: number, y2: number, o: { color?: unknown; width?: number } = {}) {
		draw('draw_line', this.x + x1, this.y + y1, this.x + x2, this.y + y2, o.width ?? 1, col(o.color));
	}
	polyline(points: Points, o: { color?: unknown; width?: number; closed?: boolean } = {}) {
		draw('draw_polyline', this.#flat(points), o.width ?? 1, col(o.color), !!o.closed);
	}
	/** A convex polygon. */
	polygon(points: Points, fill?: unknown) {
		draw('draw_polygon', this.#flat(points), col(fill));
	}
	/** Angles in radians. */
	arc(cx: number, cy: number, r: number, a0: number, a1: number, o: { color?: unknown; width?: number } = {}) {
		draw('draw_arc', this.x + cx, this.y + cy, r, a0, a1, o.width ?? 1, col(o.color));
	}
	/** `y` is the top of the text. */
	text(x: number, y: number, text: string, o: { size?: number; color?: unknown; font?: 'body' | 'medium' | 'display' | 'mono' } = {}) {
		draw('draw_text', this.x + x, this.y + y, String(text), o.size ?? 13, col(o.color), FONTS[o.font ?? 'body'] ?? 0);
	}
	icon(name: string, x: number, y: number, w: number, h: number, o: { size?: number; color?: unknown } = {}) {
		draw('draw_icon', icon(name) ?? name, this.x + x, this.y + y, w, h, o.size ?? Math.min(w, h), col(o.color));
	}
	/** Draws `fn` clipped to a rectangle. */
	clip(x: number, y: number, w: number, h: number, fn: () => void) {
		draw('draw_clip', this.x + x, this.y + y, w, h);
		try {
			fn();
		} finally {
			draw('draw_clip');
		}
	}
	measure(text: string, size = 13, font: 'body' | 'medium' | 'display' | 'mono' = 'body'): number {
		return draw('measure_text', String(text), size, FONTS[font] ?? 0) as number;
	}
}

hooks().paint = (handle: number, slot: number, x: number, y: number, w: number, h: number) => {
	const fn = scope_fn(handle, slot);
	if (typeof fn !== 'function') return;
	try {
		fn(new Painter(x, y, w, h));
	} catch (e) {
		console.error(e);
	}
};
