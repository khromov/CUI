/** Typed access to cui-api.json (generated from cui.h by scripts/extract-api.ts). */
import { readFileSync } from 'node:fs';

export interface Field {
	name: string;
	type: string;
	array?: number;
	comment?: string;
}
export interface Param {
	name: string;
	type: string;
}
export interface Fn {
	name: string;
	ret: string;
	params: Param[];
	comment?: string;
}
export interface Macro {
	name: string;
	params: string[];
	kind: 'call' | 'scope' | 'scope_if';
	fn: string;
	opts?: string;
	end?: string;
	args: string[];
}
export interface Api {
	version: string;
	enums: Record<string, { name: string; value: number }[]>;
	anon_enums: { name: string; value: number }[][];
	structs: Record<string, Field[]>;
	functions: Record<string, Fn>;
	macros: Record<string, Macro>;
	icons: Record<string, string>;
}

export const api: Api = JSON.parse(readFileSync(new URL('./cui-api.json', import.meta.url), 'utf8'));

/** The C prefix every member of an enum shares (CUI_BUTTON_ for cui_button_variant). */
export function enum_prefix(name: string): string {
	const values = api.enums[name].map((v) => v.name);
	let prefix = values[0];
	for (const v of values) {
		while (!v.startsWith(prefix)) prefix = prefix.slice(0, -1);
	}
	// cut back to the last underscore so CUI_SIZE_SM and CUI_SIZE_MD keep "SM"/"MD"
	return prefix.slice(0, prefix.lastIndexOf('_') + 1);
}

/** "primary" for CUI_BUTTON_PRIMARY: what markup writes for an enum member. */
export function enum_member_name(enum_name: string, member: string): string {
	return member.slice(enum_prefix(enum_name).length).toLowerCase().replace(/_/g, '-');
}

/** C constant for a markup value of an enum, or null when there is none. */
export function enum_constant(enum_name: string, value: string): string | null {
	const want = value.trim().toLowerCase().replace(/[\s_]/g, '-');
	for (const v of api.enums[enum_name] ?? []) {
		if (enum_member_name(enum_name, v.name) === want) return v.name;
	}
	return null;
}

export function enum_names(enum_name: string): string[] {
	return (api.enums[enum_name] ?? []).map((v) => enum_member_name(enum_name, v.name));
}

/** "check" -> CUI_ICON_CHECK, accepting "trash-2", "trash_2", "Trash2". */
export function icon_constant(name: string): string | null {
	const key = name.trim().replace(/([a-z])([A-Z0-9])/g, '$1_$2').replace(/[-\s]/g, '_').toUpperCase();
	return key in api.icons ? `CUI_ICON_${key}` : null;
}

export function is_enum(type: string): boolean {
	return type in api.enums;
}

export function is_struct(type: string): boolean {
	return type in api.structs;
}
