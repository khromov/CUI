/**
 * A macOS application bundle around a release binary (cui-svelte build --app):
 *
 *   Name.app/Contents/Info.plist
 *   Name.app/Contents/MacOS/<binary>
 *   Name.app/Contents/Resources/AppIcon.icns     (from a PNG, with sips and iconutil)
 *
 * The binary links only system frameworks and has the app inside, so nothing else is
 * copied. The bundle is signed ad hoc unless a signing identity is given.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The oldest macOS the native builds target (CMAKE_OSX_DEPLOYMENT_TARGET in native.ts). */
export const MACOS_MIN = '11.0';

export interface BundleOptions {
	binary: string;
	/** the folder the .app goes in */
	out_dir: string;
	/** shown in the menu bar, the Dock and Finder */
	name: string;
	/** reverse DNS, e.g. com.example.tasks */
	id: string;
	version: string;
	/** a square PNG, 1024 px for the sharpest Dock icon */
	icon?: string;
	/** a signing identity ("Developer ID Application: …"); ad hoc when left out */
	sign?: string;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
	const r = spawnSync(cmd, args, { encoding: 'utf8' });
	return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function info_plist(o: BundleOptions, exe: string, has_icon: boolean): string {
	const entries: [string, string | boolean][] = [
		['CFBundleDevelopmentRegion', 'en'],
		['CFBundleDisplayName', o.name],
		['CFBundleExecutable', exe],
		['CFBundleIdentifier', o.id],
		['CFBundleInfoDictionaryVersion', '6.0'],
		['CFBundleName', o.name],
		['CFBundlePackageType', 'APPL'],
		['CFBundleShortVersionString', o.version],
		['CFBundleVersion', o.version],
		['LSMinimumSystemVersion', MACOS_MIN],
		['NSHighResolutionCapable', true],
		['NSSupportsAutomaticGraphicsSwitching', true]
	];
	if (has_icon) entries.push(['CFBundleIconFile', 'AppIcon']);
	const body = entries
		.map(([k, v]) => `\t<key>${k}</key>\n\t${typeof v === 'boolean' ? `<${v}/>` : `<string>${xml(v)}</string>`}`)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

/** AppIcon.icns from a PNG: every size macOS asks for, scaled with sips, packed by iconutil. */
function make_icns(png: string, dest: string, work: string): string | null {
	const set = join(work, 'AppIcon.iconset');
	rmSync(set, { recursive: true, force: true });
	mkdirSync(set, { recursive: true });
	for (const size of [16, 32, 128, 256, 512]) {
		for (const scale of [1, 2]) {
			const px = String(size * scale);
			const file = join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
			const r = run('sips', ['-s', 'format', 'png', '-z', px, px, png, '--out', file]);
			if (!r.ok) return `sips could not scale ${png}: ${r.out.trim()}`;
		}
	}
	const r = run('iconutil', ['-c', 'icns', set, '-o', dest]);
	rmSync(set, { recursive: true, force: true });
	return r.ok ? null : `iconutil failed: ${r.out.trim()}`;
}

/** Writes Name.app (replacing an earlier one) and returns its path, or throws with the reason. */
export function make_app_bundle(o: BundleOptions): string {
	if (process.platform !== 'darwin') throw new Error('--app makes a macOS application, so it runs on macOS');
	if (o.icon && !existsSync(o.icon)) throw new Error(`no icon at ${o.icon}`);
	const app = join(o.out_dir, `${o.name.replace(/[/:]/g, '-')}.app`);
	const contents = join(app, 'Contents');
	rmSync(app, { recursive: true, force: true });
	mkdirSync(join(contents, 'MacOS'), { recursive: true });
	mkdirSync(join(contents, 'Resources'), { recursive: true });
	const exe = basename(o.binary);
	copyFileSync(o.binary, join(contents, 'MacOS', exe));
	if (o.icon) {
		const err = make_icns(o.icon, join(contents, 'Resources', 'AppIcon.icns'), dirname(app));
		if (err) throw new Error(err);
	}
	writeFileSync(join(contents, 'Info.plist'), info_plist(o, exe, !!o.icon));
	writeFileSync(join(contents, 'PkgInfo'), 'APPL????');
	// ad hoc ("-") runs on this Mac; a Developer ID identity, plus notarization, for others
	const sign = o.sign ?? '-';
	const args = ['--force', '--sign', sign];
	if (sign !== '-') args.push('--options', 'runtime', '--timestamp');
	const r = run('codesign', [...args, app]);
	if (!r.ok) throw new Error(`codesign failed: ${r.out.trim()}`);
	return app;
}

/** The one "Developer ID Application" identity in the keychain; throws when there is none or several. */
export function developer_id(): string {
	const r = run('security', ['find-identity', '-v', '-p', 'codesigning']);
	const ids = [...r.out.matchAll(/"(Developer ID Application: [^"]+)"/g)].map((m) => m[1]);
	const unique = [...new Set(ids)];
	if (unique.length === 1) return unique[0];
	throw new Error(
		unique.length
			? `several Developer ID identities; pick one with --sign:\n  ${unique.join('\n  ')}`
			: 'no "Developer ID Application" identity in the keychain (create one at developer.apple.com, or pass --sign)'
	);
}

/**
 * Sends a signed Name.app to Apple's notary service and staples the ticket to it, so it opens
 * on any Mac without a warning. `profile` is a notarytool keychain profile, saved once with
 * `xcrun notarytool store-credentials <profile>`. Throws with Apple's findings when rejected.
 */
export function notarize(app: string, profile: string, log: (s: string) => void): void {
	const zip = join(dirname(app), `${basename(app, '.app')}-notarize.zip`);
	rmSync(zip, { force: true });
	const z = run('ditto', ['-c', '-k', '--keepParent', app, zip]);
	if (!z.ok) throw new Error(`could not zip ${app}: ${z.out.trim()}`);
	try {
		log(`notarizing ${basename(app)} (usually a few minutes)…`);
		const s = run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait', '--output-format', 'json']);
		let res: { id?: string; status?: string; message?: string } = {};
		try {
			res = JSON.parse(s.out.slice(s.out.indexOf('{'), s.out.lastIndexOf('}') + 1));
		} catch {
			throw new Error(`notarytool failed: ${s.out.trim()}`);
		}
		if (res.status !== 'Accepted') {
			const l = res.id ? run('xcrun', ['notarytool', 'log', res.id, '--keychain-profile', profile]).out.trim() : '';
			throw new Error(`notarization ${res.status ?? 'failed'}${res.message ? `: ${res.message}` : ''}${l ? `\n${l}` : ''}`);
		}
		log(`accepted (${res.id})`);
	} finally {
		rmSync(zip, { force: true });
	}
	const st = run('xcrun', ['stapler', 'staple', app]);
	if (!st.ok) throw new Error(`stapler failed: ${st.out.trim()}`);
}

/** What run(App, { title, app_id }) in the entry says, when it says it with string literals. */
export function run_options(entry: string): { title?: string; app_id?: string } {
	const src = readFileSync(entry, 'utf8');
	const call = src.match(/\brun\s*\([^,]+,\s*\{([\s\S]*?)\}\s*\)/)?.[1] ?? '';
	const str = (key: string) => call.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`))?.[2];
	return { title: str('title'), app_id: str('app_id') };
}
