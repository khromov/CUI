/**
 * Value parsing shared by the compiler (static attributes and <style> are resolved to C at
 * build time) and the runtime (the same values arriving from JS expressions): colors, sizes
 * and lengths. Colors are parsed by culori, which bundles into QuickJS as is.
 */
import { useParser, parse, parseHex, parseNamed, parseTransparent, parseRgb, parseRgbLegacy, parseHsl, parseHslLegacy, parseOklab, parseOklch, convertHslToRgb, convertOklabToRgb, convertLchToLab } from 'culori/fn';

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

/** A parsed color: either concrete RGBA or one of CUI's theme tokens. */
export type Color = { r: number; g: number; b: number; a: number } | { token: number };

for (const p of [parseHex, parseNamed, parseTransparent, parseRgb, parseRgbLegacy, parseHsl, parseHslLegacy, parseOklab, parseOklch]) useParser(p as never);
const TO_RGB: Record<string, (c: never) => { r: number; g: number; b: number; alpha?: number }> = {
	rgb: (c) => c,
	hsl: convertHslToRgb,
	oklab: convertOklabToRgb,
	oklch: (c) => convertOklabToRgb((convertLchToLab as unknown as (c: never, mode: string) => never)(c, 'oklab'))
};
const byte = (x: number | undefined, fallback = 0) => Math.max(0, Math.min(255, Math.round((x ?? fallback) * 255)));

/**
 * Parses a CSS color. `var(--cui-accent)` and the bare token names (`accent`, `surface`)
 * become theme tokens, which follow light/dark and the accent. Returns null when the
 * text is not a color CUI can show.
 */
export function parse_color(input: unknown): Color | null {
	if (input == null) return null;
	if (typeof input === 'number') return { r: (input >> 16) & 255, g: (input >> 8) & 255, b: input & 255, a: 255 };
	const s = String(input).trim().toLowerCase();
	const v = /^var\(\s*--(?:cui-)?([\w-]+)\s*(?:,\s*(.+))?\)$/.exec(s);
	if (v) {
		const t = TOKENS.indexOf(v[1] as (typeof TOKENS)[number]);
		if (t >= 0) return { token: t + 1 };
		return v[2] ? parse_color(v[2]) : null;
	}
	const t = TOKENS.indexOf(s as (typeof TOKENS)[number]);
	if (t >= 0) return { token: t + 1 };
	const c = parse(s);
	const rgb = c && TO_RGB[c.mode]?.(c as never);
	return rgb ? { r: byte(rgb.r), g: byte(rgb.g), b: byte(rgb.b), a: byte(rgb.alpha, 1) } : null;
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
