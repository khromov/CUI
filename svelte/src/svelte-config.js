/**
 * For svelte.config.js, so editors and svelte-check read cui-svelte components:
 *
 *   import { cui_svelte } from 'cui-svelte/svelte-config';
 *   export default cui_svelte();
 *
 * <script lang="c"> blocks are blanked for the compiler the tools run, and DOM
 * accessibility advice is filtered. (svelte-check's type pass still reads the raw file and
 * reports a second <script>; put C in Component.svelte.c to keep svelte-check clean.)
 * Plain JS, because the language tools load it outside cui-svelte's CLI.
 */

/** @returns {import('svelte/compiler').PreprocessorGroup} */
export function strip_c_scripts() {
	return {
		name: 'cui-svelte-c-scripts',
		markup({ content }) {
			if (!/lang\s*=\s*["']c["']/.test(content)) return;
			return { code: content.replace(/<script\b[^>]*\blang\s*=\s*["']c["'][^>]*>[\s\S]*?<\/script\s*>/g, (m) => m.replace(/[^\n]/g, ' ')) };
		}
	};
}

/** @param {Record<string, any>} [config] */
export function cui_svelte(config = {}) {
	const pre = config.preprocess ?? [];
	return {
		...config,
		preprocess: [strip_c_scripts(), ...(Array.isArray(pre) ? pre : [pre])],
		compilerOptions: {
			runes: true,
			/** @param {{ code: string }} w */
			warningFilter: (w) => !w.code.startsWith('a11y'),
			...config.compilerOptions
		}
	};
}
