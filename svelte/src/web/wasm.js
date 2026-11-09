// @ts-nocheck
/**
 * Instantiates an app's wasm module: the imports CUI's libc shim and web host need (from
 * CUI's web/site/js/runtime.js), plus the cui-svelte ones (JS painting, links).
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

function fmtFloat(v, conv, prec, alt) {
  const upper = conv === 70 || conv === 69 || conv === 71 || conv === 65; // F E G A
  let s;
  if (!Number.isFinite(v)) s = Number.isNaN(v) ? 'nan' : 'inf';
  else {
    const fixed = (x, p) => {
      if (x >= 1e21) {               // toFixed switches to exponent form here
        let int = BigInt(Math.trunc(x)).toString();
        return p > 0 ? int + '.' + '0'.repeat(p) : int;
      }
      return x.toFixed(Math.min(p, 100));
    };
    const expo = (x, p) => {
      let t = x.toExponential(Math.min(p, 100));
      return t.replace(/e([+-])(\d)$/, 'e$10$2');   // C prints at least two exponent digits
    };
    const c = String.fromCharCode(conv).toLowerCase();
    if (c === 'f') s = fixed(v, prec);
    else if (c === 'e') s = expo(v, prec);
    else if (c === 'a') s = v.toString(16);
    else {                            // %g
      const P = prec === 0 ? 1 : prec;
      const X = v === 0 ? 0 : Number(v.toExponential(P - 1).split('e')[1]);
      if (P > X && X >= -4) s = fixed(v, P - 1 - X);
      else s = expo(v, P - 1);
      if (!alt && s.includes('.')) s = s.replace(/\.?0+(e|$)/, '$1');
    }
    if (alt && prec === 0 && !s.includes('.') && c !== 'g') s = s.replace(/^(\d+)/, '$1.');
  }
  return upper ? s.toUpperCase() : s;
}


export async function instantiate(url, extra = {}) {
  let mem;
  const u8 = () => new Uint8Array(mem.buffer);
  const str = (p, n) => dec.decode(u8().subarray(p, n === undefined ? u8().indexOf(0, p) : p + n));
  const lines = { 1: '', 2: '' };
  let emojiCanvas = null, emojiCtx = null;
  const env = {
    js_write(fd, p, n) {
      lines[fd] += str(p, n);
      let i;
      while ((i = lines[fd].indexOf('\n')) >= 0) {
        const line = lines[fd].slice(0, i);
        lines[fd] = lines[fd].slice(i + 1);
        (fd === 2 ? console.warn : console.log)(line);
      }
    },
    js_fmt_float(v, conv, prec, alt, buf, cap) {
      const b = enc.encode(fmtFloat(v, conv, prec, alt));
      const n = Math.min(b.length, cap);
      u8().set(b.subarray(0, n), buf);
      return n;
    },
    js_parse_float: (p, n) => parseFloat(str(p, n)),
    js_date_now: () => Date.now(),
    js_perf_now: () => performance.now(),
    js_tz_offset: (ms) => -new Date(ms).getTimezoneOffset(),
    js_abort(p) { throw new Error('CUI aborted: ' + str(p)); },
    js_tex_create() { return 0; },
    js_tex_update() {},
    js_tex_destroy() {},
    js_draw_emoji(p, n, px, out) {
      if (!emojiCanvas) {
        emojiCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px, px) : document.createElement('canvas');
        emojiCtx = emojiCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!emojiCtx) return 0;
      if (emojiCanvas.width < px) { emojiCanvas.width = px; emojiCanvas.height = px; }
      const c = emojiCtx;
      c.clearRect(0, 0, emojiCanvas.width, emojiCanvas.height);
      c.font = `${Math.round(px * 0.84)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#000';
      c.fillText(str(p, n), px / 2, px * 0.54);
      const d = c.getImageData(0, 0, px, px).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) { ink = 1; break; }
      if (!ink) return 0;
      u8().set(d, out);
      return 1;
    },
    js_clipboard_set(p, n) {
      const text = str(p, n);
      navigator.clipboard?.writeText(text).catch(() => {});
    },
    cuisv_js_paint: (...a) => extra.paint?.(...a),
    cuisv_js_open_url: (p, n) => { window.open(str(p, n), '_blank', 'noopener'); },
  };
  for (const f of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'expm1', 'log', 'log10', 'log2', 'log1p', 'cbrt'])
    env['math_' + f] = Math[f];
  env.math_atan2 = Math.atan2;
  env.math_pow = Math.pow;
  env.math_hypot = Math.hypot;
  env.math_fmod = (x, y) => x % y;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), { env });
  mem = instance.exports.memory;
  if (instance.exports.web_boot) instance.exports.web_boot();
  return { exports: instance.exports, memory: () => mem, str };
}
