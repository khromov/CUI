/** Value types shared by the component props. */
import type { ICONS } from './tables.ts';

/** 240 (points), "240px", "50%", "fill", "fit", "grow(2)". */
export type Size = number | `${number}px` | `${number}%` | 'fill' | 'fit' | 'auto' | `grow(${number})` | (string & {});

/** Any CSS color, or a theme token: "accent", "surface", "var(--cui-border)". */
export type Color = string | number;

export type IconName = keyof typeof ICONS;

/** An image handle (from a host API that loads pixels). */
export interface ImageRef {
	readonly handle: number;
	readonly width: number;
	readonly height: number;
}
