/**
 * Value parsing shared by the compiler (static attributes and <style> are resolved to C at
 * build time) and the runtime (the same values arriving from JS expressions): colors, sizes
 * and lengths. No imports, so it bundles into QuickJS as is.
 */

// ---- colors ------------------------------------------------------------------------------

/** CUI's semantic colors, in cui_token order (CUI_TOKEN_BACKGROUND is 1). */
export const TOKENS = [
	'background',
	'surface',
	'surface-raised',
	'surface-muted',
	'foreground',
	'text-secondary',
	'text-muted',
	'border',
	'border-subtle',
	'border-strong',
	'accent',
	'accent-strong',
	'accent-subtle',
	'accent-foreground',
	'success',
	'warning',
	'danger',
	'info',
	'control-on',
	'control-glyph',
	'control-track',
	'control-track-hover',
	'control-thumb',
	'control-thumb-on',
	'hover',
	'active',
	'scrim',
	'focus-ring',
	'series-1',
	'series-2',
	'series-3',
	'series-4',
	'series-5',
	'series-6'
] as const;

const NAMED: Record<string, number> = {
	black: 0x000000, silver: 0xc0c0c0, gray: 0x808080, grey: 0x808080, white: 0xffffff, maroon: 0x800000,
	red: 0xff0000, purple: 0x800080, fuchsia: 0xff00ff, magenta: 0xff00ff, green: 0x008000, lime: 0x00ff00,
	olive: 0x808000, yellow: 0xffff00, navy: 0x000080, blue: 0x0000ff, teal: 0x008080, aqua: 0x00ffff,
	cyan: 0x00ffff, orange: 0xffa500, aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aquamarine: 0x7fffd4,
	azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, blanchedalmond: 0xffebcd, blueviolet: 0x8a2be2,
	brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e,
	coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c, darkblue: 0x00008b,
	darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9,
	darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00,
	darkorchid: 0x9932cc, darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f,
	darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1,
	darkviolet: 0x9400d3, deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969,
	dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22,
	gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700, goldenrod: 0xdaa520, greenyellow: 0xadff2f,
	honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c, indigo: 0x4b0082, ivory: 0xfffff0,
	khaki: 0xf0e68c, lavender: 0xe6e6fa, lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd,
	lightblue: 0xadd8e6, lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2,
	lightgray: 0xd3d3d3, lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
	lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899,
	lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, limegreen: 0x32cd32, linen: 0xfaf0e6,
	mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db,
	mediumseagreen: 0x3cb371, mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a,
	mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa,
	mistyrose: 0xffe4e1, moccasin: 0xffe4b5, navajowhite: 0xffdead, oldlace: 0xfdf5e6, olivedrab: 0x6b8e23,
	orangered: 0xff4500, orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98,
	paleturquoise: 0xafeeee, palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9,
	peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6, rebeccapurple: 0x663399,
	rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460,
	seagreen: 0x2e8b57, seashell: 0xfff5ee, sienna: 0xa0522d, skyblue: 0x87ceeb, slateblue: 0x6a5acd,
	slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f, steelblue: 0x4682b4,
	tan: 0xd2b48c, thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee,
	wheat: 0xf5deb3, whitesmoke: 0xf5f5f5, yellowgreen: 0x9acd32
};

/** A parsed color: either concrete RGBA or one of CUI's theme tokens. */
export type Color = { r: number; g: number; b: number; a: number } | { token: number };

const clamp255 = (x: number) => Math.max(0, Math.min(255, Math.round(x)));

function channel(s: string, max = 255): number {
	s = s.trim();
	if (s.endsWith('%')) return (parseFloat(s) / 100) * max;
	return parseFloat(s);
}

function alpha_of(s: string | undefined): number {
	if (s === undefined) return 255;
	s = s.trim();
	if (s.endsWith('%')) return clamp255((parseFloat(s) / 100) * 255);
	return clamp255(parseFloat(s) * 255);
}

function hsl_to_rgb(h: number, s: number, l: number) {
	h = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return { r: clamp255((r + m) * 255), g: clamp255((g + m) * 255), b: clamp255((b + m) * 255) };
}

function linear_to_srgb(x: number) {
	const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
	return clamp255(v * 255);
}

function oklab_to_rgb(L: number, a: number, b: number) {
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
	return {
		r: linear_to_srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		g: linear_to_srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		b: linear_to_srgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
	};
}

function fn_args(body: string): { parts: string[]; alpha?: string } {
	const [main, alpha] = body.split('/');
	const parts = main.includes(',') ? main.split(',') : main.trim().split(/\s+/);
	if (parts.length === 4 && alpha === undefined) return { parts: parts.slice(0, 3), alpha: parts[3] };
	return { parts, alpha };
}

/**
 * Parses a CSS color. `var(--cui-accent)` and the bare token names (`accent`, `surface`)
 * become theme tokens, which follow light/dark and the accent. Returns null when the
 * text is not a color CUI can show.
 */
export function parse_color(input: unknown): Color | null {
	if (input == null) return null;
	if (typeof input === 'number') return { r: (input >> 16) & 255, g: (input >> 8) & 255, b: input & 255, a: 255 };
	let s = String(input).trim().toLowerCase();
	const v = /^var\(\s*--(?:cui-)?([\w-]+)\s*(?:,\s*(.+))?\)$/.exec(s);
	if (v) {
		const t = TOKENS.indexOf(v[1] as (typeof TOKENS)[number]);
		if (t >= 0) return { token: t + 1 };
		return v[2] ? parse_color(v[2]) : null;
	}
	const t = TOKENS.indexOf(s as (typeof TOKENS)[number]);
	if (t >= 0) return { token: t + 1 };
	if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
	if (s in NAMED) {
		const n = NAMED[s];
		return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
	}
	if (s.startsWith('#')) {
		s = s.slice(1);
		if (!/^[0-9a-f]+$/.test(s)) return null;
		if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join('');
		if (s.length !== 6 && s.length !== 8) return null;
		const n = parseInt(s.slice(0, 6), 16);
		return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: s.length === 8 ? parseInt(s.slice(6), 16) : 255 };
	}
	const f = /^(rgba?|hsla?|oklch|oklab)\((.*)\)$/.exec(s);
	if (!f) return null;
	const { parts, alpha } = fn_args(f[2]);
	if (parts.length < 3) return null;
	const a = alpha_of(alpha);
	if (f[1].startsWith('rgb')) return { r: clamp255(channel(parts[0])), g: clamp255(channel(parts[1])), b: clamp255(channel(parts[2])), a };
	if (f[1].startsWith('hsl')) {
		const rgb = hsl_to_rgb(parseFloat(parts[0]), channel(parts[1], 1), channel(parts[2], 1));
		return { ...rgb, a };
	}
	if (f[1] === 'oklch') {
		const L = channel(parts[0], 1);
		const C = parts[1].trim().endsWith('%') ? channel(parts[1], 0.4) : parseFloat(parts[1]);
		const h = (parseFloat(parts[2]) * Math.PI) / 180;
		return { ...oklab_to_rgb(L, C * Math.cos(h), C * Math.sin(h)), a };
	}
	const L = channel(parts[0], 1);
	return { ...oklab_to_rgb(L, channel(parts[1], 0.4), channel(parts[2], 0.4)), a };
}

/** 0xRRGGBBAA, with theme tokens in CUI's marker form ({ token, 0xC5, 0x1D, 0 }). */
export function pack_color(c: Color): number {
	if ('token' in c) return ((c.token << 24) | (0xc5 << 16) | (0x1d << 8) | 0) >>> 0;
	return ((c.r << 24) | (c.g << 16) | (c.b << 8) | c.a) >>> 0;
}

// ---- sizes -------------------------------------------------------------------------------

/** cui_size_kind order. */
export const SIZE_FIT = 0, SIZE_GROW = 1, SIZE_FIXED = 2, SIZE_PERCENT = 3;
export type Size = { kind: number; value: number };

/**
 * A size for width/height: 240 or "240px" (points), "50%", "fill", "fit"/"auto",
 * "grow(2)" / "2fr" (a share of the free space). Returns null for anything else.
 */
export function parse_size(input: unknown): Size | null {
	if (input == null || input === false) return null;
	if (typeof input === 'number') return Number.isFinite(input) ? { kind: SIZE_FIXED, value: input } : null;
	const s = String(input).trim().toLowerCase();
	if (s === 'fill' || s === 'stretch') return { kind: SIZE_GROW, value: 1 };
	if (s === 'fit' || s === 'auto' || s === 'fit-content' || s === 'max-content' || s === 'min-content') return { kind: SIZE_FIT, value: 0 };
	const g = /^grow\(\s*([\d.]+)\s*\)$/.exec(s) || /^([\d.]+)fr$/.exec(s);
	if (g) return { kind: SIZE_GROW, value: parseFloat(g[1]) };
	if (s.endsWith('%')) {
		const p = parseFloat(s);
		return Number.isFinite(p) ? { kind: SIZE_PERCENT, value: p } : null;
	}
	const px = parse_length(s);
	return px === null ? null : { kind: SIZE_FIXED, value: px };
}

export function pack_size(z: Size): number {
	return z.kind * 1e9 + z.value;
}

/** A length in points: 12, "12px", "1.5rem" (16 points each), "0". Null for anything else. */
export function parse_length(input: unknown): number | null {
	if (typeof input === 'number') return Number.isFinite(input) ? input : null;
	if (input == null) return null;
	const s = String(input).trim().toLowerCase();
	const m = /^(-?[\d.]+)(px|pt|rem|em)?$/.exec(s);
	if (!m) return null;
	const n = parseFloat(m[1]);
	if (!Number.isFinite(n)) return null;
	if (m[2] === 'rem' || m[2] === 'em') return n * 16;
	return n;
}
