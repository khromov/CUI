/**
 * The native object the C host installs as `globalThis.__cuisv` (runtime/cuisv_js.c and
 * friends). Everything the JS side does to the screen goes through these functions; the
 * browser build implements the same object over WebAssembly exports.
 */
export interface Bridge {
	root(): number;
	scope(template: number): number;
	free(handle: number): void;
	insert(parent: number, site: number, child: number, before: number): void;
	detach(handle: number): void;

	num(handle: number, slot: number, value: number): void;
	bool(handle: number, slot: number, value: boolean): void;
	str(handle: number, slot: number, value: string): void;
	unset(handle: number, slot: number): void;
	fn(handle: number, slot: number, present: boolean): void;
	strs(handle: number, slot: number, value: ArrayLike<string>): void;
	floats(handle: number, slot: number, value: ArrayLike<number>): void;
	blob(handle: number, slot: number, value: Uint8Array | ArrayBuffer): void;

	timeout(fn: () => void, ms: number, repeat: boolean): number;
	clear(id: number): void;
	want_frame(): void;
	print(level: number, text: string): void;
	now(): number;

	app(options: object): boolean;
	redraw(): void;
	quit(): void;

	[name: string]: unknown;
}

export interface Hooks {
	dispatch(handle: number, slot: number, ...args: unknown[]): void;
	commit(): void;
	frame(time: number): void;
	teardown(): void;
	paint(handle: number, slot: number, x: number, y: number, w: number, h: number): void;
	resize(w: number, h: number): void;
	toast_action(handle: number): void;
	/** A toast with an action left without the action being clicked. */
	toast_gone(handle: number): void;
	key(key: number, mods: number): void;
	/** Test builds: the host found the tests unfinished (timed out, or nothing left to run). */
	unfinished(): void;
}

declare global {
	var __cuisv: Bridge;
	var __cuisv_hooks: Partial<Hooks>;
}

export function native(): Bridge {
	const b = globalThis.__cuisv;
	if (!b) throw new Error('cui-svelte: no native bridge (this code runs inside a cui-svelte app, built with `cui-svelte build`)');
	return b;
}

export function hooks(): Partial<Hooks> {
	return (globalThis.__cuisv_hooks ??= {});
}
