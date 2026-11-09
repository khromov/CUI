/**
 * npm pack with CUI inside: copies the CUI sources the builds need (include, src, the web
 * shim and host, CMake files, third_party, licenses) into cui/, then runs `npm pack`. The
 * vendored Svelte build ships as a bundled dependency.
 *
 *   node scripts/pack.ts [--dry-run]
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const cui = join(root, '..');
const out = join(root, 'cui');
if (!existsSync(join(cui, 'include', 'cui', 'cui.h'))) throw new Error('scripts/pack.ts runs inside the CUI repository');
rmSync(out, { recursive: true, force: true });
for (const p of ['include', 'src', 'cmake', 'third_party', 'web/shim', 'web/host', 'CMakeLists.txt', 'LICENSE', 'THIRD_PARTY.md']) {
	cpSync(join(cui, p), join(out, p), { recursive: true });
}
const r = spawnSync('npm', ['pack', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
rmSync(out, { recursive: true, force: true });
process.exit(r.status ?? 1);
