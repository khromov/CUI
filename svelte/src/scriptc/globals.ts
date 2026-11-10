/**
 * Injected into the scriptc bundle (esbuild `inject`): a read of one of these names as a
 * global, in the app or in a package, becomes an import of the host's version.
 */
export {
	set_timeout as setTimeout,
	set_interval as setInterval,
	clear_timer as clearTimeout,
	clear_timer as clearInterval,
	request_animation_frame as requestAnimationFrame,
	cancel_animation_frame as cancelAnimationFrame
} from './host.ts';

// `Array.isArray` and `JSON.stringify` (`define`s of the build name these exports): the first
// answers true for `$state` arrays, which are stand-ins in this build, the second serializes
// state, which scriptc's own cannot. Resolved to the file that replaces svelte's proxy.js.
export { is_array_like_state as __cuisv_is_array, json_stringify as __cuisv_json_stringify } from 'cuisv-svelte-proxy';

// the browser's name for what cui-svelte keeps in the app's data folder
export { local_storage as localStorage } from '../runtime/host.ts';
