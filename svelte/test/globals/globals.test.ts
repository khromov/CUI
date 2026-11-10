import { mount_test, test, expect } from 'cui-svelte/test';
import Globals from './Globals.svelte';

test('web globals: crypto.randomUUID, URL', () => {
	const app = mount_test(Globals, { width: 600, height: 200 });
	expect(app.text()).toContain('uuid=36 url=https://example.com/docs?page=2#top page=2');
});

const decode = (bytes: number[], o?: TextDecoderOptions) => new TextDecoder('utf-8', o).decode(new Uint8Array(bytes));
const encode = (s: string) => Array.from(new TextEncoder().encode(s));

test('TextDecoder: invalid UTF-8 becomes U+FFFD, as in browsers', () => {
	expect(decode([0x61, 0xff, 0x62])).toBe('a\uFFFDb');
	expect(decode([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f])).toBe('héllo');
	expect(decode([0xf0, 0x9f, 0x98, 0x80])).toBe('😀');
	// a truncated sequence is one replacement; the byte that cut it short starts over
	expect(decode([0xe2, 0x82, 0x41])).toBe('\uFFFDA');
	expect(decode([0xf0, 0x9f, 0x98])).toBe('\uFFFD');
	// overlong forms, surrogates and code points past U+10FFFF: one replacement per byte
	expect(decode([0xc0, 0xaf])).toBe('\uFFFD\uFFFD');
	expect(decode([0xe0, 0x80, 0xaf])).toBe('\uFFFD\uFFFD\uFFFD');
	expect(decode([0xed, 0xa0, 0x80])).toBe('\uFFFD\uFFFD\uFFFD');
	expect(decode([0xf4, 0x90, 0x80, 0x80])).toBe('\uFFFD\uFFFD\uFFFD\uFFFD');
	expect(decode([0x80, 0x41])).toBe('\uFFFDA');
	// a byte order mark is dropped unless ignoreBOM
	expect(decode([0xef, 0xbb, 0xbf, 0x41])).toBe('A');
	expect(decode([0xef, 0xbb, 0xbf, 0x41], { ignoreBOM: true })).toBe('\uFEFFA');
	let threw = false;
	try {
		decode([0x61, 0xff], { fatal: true });
	} catch (e) {
		threw = e instanceof TypeError;
	}
	expect(threw).toBe(true);
	expect(decode([0x61], { fatal: true })).toBe('a');
	expect(new TextDecoder().decode()).toBe('');
	expect(new TextDecoder().decode(new Uint8Array([0x41, 0x42]).buffer)).toBe('AB');
	// longer than the chunks the decoder builds its string from
	const long = 'añ€😀'.repeat(5000);
	expect(new TextDecoder().decode(new TextEncoder().encode(long))).toBe(long);
});

test('TextDecoder: { stream: true } keeps a sequence split between chunks', () => {
	const d = new TextDecoder();
	expect(d.decode(new Uint8Array([0x41, 0xf0, 0x9f]), { stream: true })).toBe('A');
	expect(d.decode(new Uint8Array([0x98, 0x80, 0x42]), { stream: true })).toBe('😀B');
	expect(d.decode(new Uint8Array([0xe2, 0x82]), { stream: true })).toBe('');
	expect(d.decode()).toBe('\uFFFD');
});

test('TextEncoder: a lone surrogate becomes U+FFFD', () => {
	expect(encode('a\uD800b')).toEqual([0x61, 0xef, 0xbf, 0xbd, 0x62]);
	expect(encode('\uDC00')).toEqual([0xef, 0xbf, 0xbd]);
	expect(encode('\uD800')).toEqual([0xef, 0xbf, 0xbd]);
	expect(encode('😀')).toEqual([0xf0, 0x9f, 0x98, 0x80]);
	expect(encode('é€')).toEqual([0xc3, 0xa9, 0xe2, 0x82, 0xac]);
});
