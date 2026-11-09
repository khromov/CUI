/** `cui-svelte create <dir>`: a new app with a component, a test and editor support. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { PKG_ROOT } from './bundle.ts';

export function create(dir: string) {
	const root = resolve(dir);
	if (existsSync(root) && readdirSync(root).length) throw new Error(`${dir} is not empty`);
	mkdirSync(root, { recursive: true });
	const name = basename(root).replace(/[^\w.-]+/g, '-').toLowerCase() || 'app';
	const files: Record<string, string> = {
		'package.json': JSON.stringify(
			{
				name,
				private: true,
				type: 'module',
				scripts: {
					dev: 'cui-svelte dev main.ts',
					'dev:web': 'cui-svelte dev main.ts --web',
					build: 'cui-svelte build main.ts',
					'build:web': 'cui-svelte build main.ts --web',
					test: 'cui-svelte test app.test.ts',
					check: 'svelte-check --threshold error'
				},
				dependencies: { 'cui-svelte': `file:${relative(root, PKG_ROOT) || '.'}` },
				// a local install copies the package without CUI next to it: where CUI is
				'cui-svelte': existsSync(join(PKG_ROOT, 'cui')) ? undefined : { cui_root: relative(root, join(PKG_ROOT, '..')) || '.' },
				devDependencies: { 'svelte-check': '^4.0.0', typescript: '^5.9.0' }
			},
			null,
			'\t'
		) + '\n',
		'main.ts': `import { run } from 'cui-svelte';
import App from './App.svelte';

run(App, { title: ${JSON.stringify(name)}, width: 480, height: 360 });
`,
		'App.svelte': `<script lang="ts">
	import { Column, Row, Heading, Secondary, Button, Switch } from 'cui-svelte';

	let count = $state(0);
	let dark = $state(false);
</script>

<Column pad={32} gap={16}>
	<Heading level={2}>Hello from Svelte</Heading>
	<Secondary>This markup is C; the script runs in QuickJS.</Secondary>
	<div class="card">
		<p>Clicked <strong>{count}</strong> times</p>
		<Row gap={8}>
			<Button variant="primary" onclick={() => count++}>Click me</Button>
			<Button onclick={() => (count = 0)}>Reset</Button>
		</Row>
	</div>
	<Switch bind:checked={dark}>Dark mode</Switch>
</Column>

<style>
	.card {
		padding: 16px 20px;
		gap: 12px;
		border: 1px solid var(--cui-border);
		border-radius: 14px;
		background: var(--cui-surface);
	}
</style>
`,
		'app.test.ts': `import { mount_test, test, expect } from 'cui-svelte/test';
import App from './App.svelte';

test('counts clicks', () => {
	const app = mount_test(App);
	app.click('Click me');
	app.click('Click me');
	expect(app.flat()).toContain('Clicked 2 times');
});
`,
		'svelte.config.js': `// For editors and svelte-check; cui-svelte compiles the components itself.
import { cui_svelte } from 'cui-svelte/svelte-config';

export default cui_svelte();
`,
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'esnext',
					module: 'nodenext',
					moduleResolution: 'nodenext',
					customConditions: ['custom-renderer'],
					strict: true,
					noEmit: true,
					allowImportingTsExtensions: true,
					verbatimModuleSyntax: true,
					skipLibCheck: true,
					types: []
				},
				include: ['**/*.ts', '**/*.svelte'],
				exclude: ['node_modules', '.cui-svelte', 'dist', 'dist-web']
			},
			null,
			'\t'
		) + '\n',
		'.gitignore': 'node_modules/\n.cui-svelte/\ndist/\ndist-web/\n'
	};
	for (const [f, content] of Object.entries(files)) writeFileSync(join(root, f), content);
	return root;
}
