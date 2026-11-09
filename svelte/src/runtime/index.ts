/**
 * cui-svelte's JS API, for code running in the app (QuickJS, or the browser build).
 *
 *   import { run } from 'cui-svelte';
 *   import App from './App.svelte';
 *   run(App, { title: 'Notes', width: 900, height: 600 });
 */
import { mount, unmount, flushSync, type Component } from 'svelte';
import { native as bridge, hooks } from './bridge.ts';
import renderer, { root_target, commit } from './renderer.ts';

export * from './components.ts';
export * from './host.ts';
export { Painter } from './painter.ts';

/** C functions exported by <script lang="c"> blocks (cuisv_export), by name. */
export const native: Record<string, (...args: unknown[]) => any> = new Proxy({} as Record<string, (...args: unknown[]) => any>, {
	get(_, name: string) {
		const f = (globalThis.__cuisv?.natives as Record<string, unknown> | undefined)?.[name];
		if (typeof f !== 'function') throw new Error(`cui-svelte: no native function ${name} (export it with cuisv_export in a <script lang="c">)`);
		return f;
	}
});
import { set_app_id, local_storage } from './host.ts';
export type { Color, IconName, ImageRef, Size } from './types.ts';

export interface RunOptions<Props extends Record<string, unknown> = Record<string, unknown>> {
	title?: string;
	/** Logical size of the window, default 1080 x 720. */
	width?: number;
	height?: number;
	min_width?: number;
	min_height?: number;
	/** Not resizable. */
	fixed_size?: boolean;
	theme?: 'light' | 'dark' | 'system';
	accent?: Accent;
	/** Render every frame even when nothing changes (games, video). */
	continuous?: boolean;
	renderer?: 'auto' | 'opengl' | 'software';
	/** Names the app's data folder (localStorage, paths.data()); default the binary's name. */
	app_id?: string;
	props?: Props;
}

export type Accent = 'neutral' | 'violet' | 'blue' | 'green' | 'amber' | 'orange' | 'coral' | 'rose';

let app: Record<string, unknown> | null = null;

/** Opens the window and mounts the root component into it. */
export function run<Props extends Record<string, unknown>>(component: Component<Props>, options: RunOptions<Props> = {}) {
	const { props, app_id, ...window_options } = options;
	if (app_id) set_app_id(app_id);
	bridge().app(window_options);
	if (app) unmount(app);
	app = mount(component as Component<Record<string, unknown>>, {
		renderer,
		target: root_target(),
		props: (props ?? {}) as Record<string, unknown>
	} as never);
	flushSync();
	commit();
	return app;
}

hooks().teardown = () => {
	local_storage.flush();
	if (app) {
		unmount(app);
		app = null;
		flushSync();
	}
};

/** Asks for a new frame; state changes do this already. */
export function redraw() {
	bridge().redraw();
}

export function quit() {
	bridge().quit();
}

export function set_title(title: string) {
	(bridge().set_title as (t: string) => void)(title);
}

export function set_theme(theme: 'light' | 'dark') {
	(bridge().set_theme as (t: string) => void)(theme);
}

export function get_theme(): 'light' | 'dark' {
	return (bridge().get_theme as () => 'light' | 'dark')();
}

export function set_accent(accent: Accent) {
	(bridge().set_accent as (a: string) => void)(accent);
}

export function get_accent(): Accent {
	return (bridge().get_accent as () => Accent)();
}
