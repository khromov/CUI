/* The browser build's host: the app's templates as the one "content" of CUI's web host
 * (web/host/web_host.c), and exports for the JS bridge (src/web/bridge.ts), which plays the
 * part QuickJS plays natively. The browser's own JS engine runs the bundle. */
#include "cuisv_internal.h"
#include "web_host.h"   /* CUI's web/host, on the include path (src/cli/web.ts) */
#include <cui/cui_render.h>

#include <stdlib.h>
#include <string.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

void js_paint(uint32_t handle, int slot, float x, float y, float w, float h) IMPORT(cuisv_js_paint);
void js_open_url(const char *s, int n) IMPORT(cuisv_js_open_url);
double js_perf_now(void) IMPORT(js_perf_now);

static cui_ctx *g_ui;
static float g_width = 1080, g_height = 720;

/* ---- the one content: the app --------------------------------------------------------- */

int web_content_count(void) { return 1; }
const char *web_content_name(int i) { (void)i; return "app"; }
float web_content_width(int i) { (void)i; return g_width; }
float web_content_height(int i) { (void)i; return g_height; }
int web_content_accent(int i) { (void)i; return -1; }
int web_content_theme(int i) { (void)i; return -1; }
int web_content_warmup(int i) { (void)i; return 0; }
void web_content_input(int i, cui_ctx *ui, int f) { (void)i; (void)ui; (void)f; }

void web_content_build(int i, cui_ctx *ui, int f) {
    (void)i; (void)f;
    g_ui = ui;
    cuisv_strings_apply(ui);   /* a pointer store; the first set_strings() runs before any frame */
    cuisv_frame_reset();
    cuisv_render_scope(ui, cuisv_root());
    cuisv_collect_keys(ui);
    cuisv_collect_scrolls(ui);
}

EXPORT(cuisv_w_want_keys) void cuisv_w_want_keys(int on) { cuisv_want_keys(on != 0); }

/* ---- host hooks for the shared services ------------------------------------------------ */

void cuisv_host_paint(uint32_t handle, int slot, cui_rect r) { js_paint(handle, slot, r.x, r.y, r.w, r.h); }
void cuisv_host_open_url(const char *url) { js_open_url(url, (int)strlen(url)); }
cui_texture cuisv_host_load_image(cui_ctx *ui, const char *path, int *w, int *h) { (void)ui; (void)path; *w = *h = 0; return 0; }
double cuisv_host_now_ms(void) { return js_perf_now(); }
void cuisv_clipboard_set(cui_ctx *ui, const char *text);

/* clipboard.write() from JS: through CUI, whose own paste then reads it too. 0 before the first frame. */
EXPORT(cuisv_w_clipboard_set) int cuisv_w_clipboard_set(const char *text) {
    if (!g_ui) return 0;
    cuisv_clipboard_set(g_ui, text);
    return 1;
}

/* ---- boot and size ---------------------------------------------------------------------- */

EXPORT(cuisv_w_init) uint32_t cuisv_w_init(void) {
    cuisv_runtime_init();
    return cuisv_root()->handle;
}

EXPORT(cuisv_w_size) void cuisv_w_size(float w, float h) { g_width = w; g_height = h; }

/* ---- scopes and slots -------------------------------------------------------------------- */

EXPORT(cuisv_w_scope) uint32_t cuisv_w_scope(uint32_t tpl) { cuisv_scope *s = cuisv_scope_new(tpl); return s ? s->handle : 0; }
EXPORT(cuisv_w_free) void cuisv_w_free(uint32_t h) { cuisv_scope_free(cuisv_scope_get(h)); }
EXPORT(cuisv_w_insert) void cuisv_w_insert(uint32_t p, int site, uint32_t c, uint32_t before) {
    cuisv_insert(cuisv_scope_get(p), site, cuisv_scope_get(c), cuisv_scope_get(before));
}
EXPORT(cuisv_w_detach) void cuisv_w_detach(uint32_t h) { cuisv_detach(cuisv_scope_get(h)); }
EXPORT(cuisv_w_num) void cuisv_w_num(uint32_t h, int slot, double v) { cuisv_set_num(cuisv_scope_get(h), slot, v); }
EXPORT(cuisv_w_bool) void cuisv_w_bool(uint32_t h, int slot, int v) { cuisv_set_bool(cuisv_scope_get(h), slot, v != 0); }
EXPORT(cuisv_w_str) void cuisv_w_str(uint32_t h, int slot, const char *p, int n) { cuisv_set_str(cuisv_scope_get(h), slot, p, (size_t)n); }
EXPORT(cuisv_w_unset) void cuisv_w_unset(uint32_t h, int slot) { cuisv_slot_unset(cuisv_scope_get(h), slot); }
EXPORT(cuisv_w_fn) void cuisv_w_fn(uint32_t h, int slot, int present) { cuisv_slot_fn(cuisv_scope_get(h), slot, present != 0); }
EXPORT(cuisv_w_floats) void cuisv_w_floats(uint32_t h, int slot, const float *v, int n) { cuisv_slot_floats(cuisv_scope_get(h), slot, v, n); }
EXPORT(cuisv_w_blob) void cuisv_w_blob(uint32_t h, int slot, const uint8_t *p, int n) { cuisv_slot_blob(cuisv_scope_get(h), slot, p, (uint32_t)n); }
/* Strings packed by JS: u32 count, then per string u32 length and the bytes. */
/* A string list as the bridge packs it (a u32 count, then a u32 length and the bytes of each
 * string; len >= 4): up to cap strings, pointing into p. Returns how many were whole. */
static int unpack_strs(const uint8_t *p, int len, const char **items, size_t *lens, uint32_t cap) {
    const uint8_t *end = p + len;
    uint32_t n = 0;
    memcpy(&n, p, 4);
    p += 4;
    if (n > cap) n = cap;
    uint32_t k = 0;
    for (; k < n && end - p >= 4; k++) {
        uint32_t l;
        memcpy(&l, p, 4);
        p += 4;
        if (l > (size_t)(end - p)) break;
        items[k] = (const char *)p;
        lens[k] = l;
        p += l;
    }
    return (int)k;
}

EXPORT(cuisv_w_strs) void cuisv_w_strs(uint32_t h, int slot, const uint8_t *p, int len) {
    if (!p || len < 4) { cuisv_slot_strs(cuisv_scope_get(h), slot, NULL, NULL, 0); return; }
    uint32_t n = 0;
    memcpy(&n, p, 4);
    uint32_t most = (uint32_t)(len - 4) / 4;   /* each string takes at least its length */
    if (n > most) n = most;
    const char **items = malloc(sizeof *items * (n ? n : 1));
    size_t *lens = malloc(sizeof *lens * (n ? n : 1));
    if (!items || !lens) { free(items); free(lens); return; }
    int k = unpack_strs(p, len, items, lens, n);
    cuisv_slot_strs(cuisv_scope_get(h), slot, items, lens, k);
    free(items);
    free(lens);
}

/* set_strings(): an empty list restores English. The table reaches CUI in web_content_build. */
EXPORT(cuisv_w_set_strings) void cuisv_w_set_strings(const uint8_t *p, int len) {
    const char *items[CUISV_STRINGS_COUNT] = { 0 };
    size_t lens[CUISV_STRINGS_COUNT] = { 0 };
    int n = p && len >= 4 ? unpack_strs(p, len, items, lens, CUISV_STRINGS_COUNT) : 0;
    cuisv_strings_set(items, lens, n);
}

/* ---- events ----------------------------------------------------------------------------- */

EXPORT(cuisv_w_event_count) int cuisv_w_event_count(void) { return cuisv_event_count(); }
EXPORT(cuisv_w_ev_handle) uint32_t cuisv_w_ev_handle(int i) { return cuisv_events()[i].handle; }
EXPORT(cuisv_w_ev_slot) int cuisv_w_ev_slot(int i) { return cuisv_events()[i].slot; }
EXPORT(cuisv_w_ev_kind) int cuisv_w_ev_kind(int i) { return cuisv_events()[i].kind; }
EXPORT(cuisv_w_ev_a) double cuisv_w_ev_a(int i) { return cuisv_events()[i].a; }
EXPORT(cuisv_w_ev_b) double cuisv_w_ev_b(int i) { return cuisv_events()[i].b; }
EXPORT(cuisv_w_ev_str) const char *cuisv_w_ev_str(int i) { return cuisv_events()[i].str; }
EXPORT(cuisv_w_ev_len) int cuisv_w_ev_len(int i) {
    cuisv_event *e = &cuisv_events()[i];
    return (int)(e->kind == 5 ? e->len : (e->str ? strlen(e->str) : 0));
}
EXPORT(cuisv_w_events_clear) void cuisv_w_events_clear(void) { cuisv_events_clear(); }

/* ---- elements by id, theme, toasts --------------------------------------------------------- */

EXPORT(cuisv_w_rect) int cuisv_w_rect(const char *name, float *out) {
    cui_rect r;
    if (!cuisv_rect_of(g_ui, name, &r)) return 0;
    out[0] = r.x; out[1] = r.y; out[2] = r.w; out[3] = r.h;
    return 1;
}

EXPORT(cuisv_w_scroll_to) int cuisv_w_scroll_to(const char *name, float y) { return cuisv_scroll_to(g_ui, name, y); }

EXPORT(cuisv_w_viewport) void cuisv_w_viewport(float *out) {
    cui_vec2 v = g_ui ? cui_viewport_size(g_ui) : (cui_vec2){ g_width, g_height };
    out[0] = v.x; out[1] = v.y;
}

EXPORT(cuisv_w_toast) int cuisv_w_toast(const char *title, const char *desc, int tone, float duration, const char *action, int timer) {
    if (!g_ui) return -1;
    cui_toast_opts o;
    memset(&o, 0, sizeof o);
    o.description = desc && *desc ? desc : NULL;
    o.tone = (cui_tone)tone;
    o.duration = duration;
    o.action = action && *action ? action : NULL;
    o.show_timer = timer != 0;
    return cui_toast_ex(g_ui, title, &o);
}
EXPORT(cuisv_w_toast_clicked) int cuisv_w_toast_clicked(int h) { return g_ui && cui_toast_action_clicked(g_ui, h); }
bool cuisv_toast_alive(cui_ctx *ui, int handle);
EXPORT(cuisv_w_toast_alive) int cuisv_w_toast_alive(int h) { return cuisv_toast_alive(g_ui, h); }
EXPORT(cuisv_w_toast_dismiss) void cuisv_w_toast_dismiss(int h) { if (g_ui) cui_toast_dismiss(g_ui, h); }
EXPORT(cuisv_w_theme_dark) int cuisv_w_theme_dark(void) { return g_ui && cui_get_theme_mode(g_ui) == CUI_THEME_DARK; }

/* ---- LogBuffer / TerminalBuffer ------------------------------------------------------------- */

EXPORT(cuisv_w_buffer_new) int cuisv_w_buffer_new(int kind, int lines, int bytes) { return cuisv_buffer_new(kind, lines, bytes > 0 ? (size_t)bytes : 0); }
EXPORT(cuisv_w_buffer_write) void cuisv_w_buffer_write(double h, const char *p, int n, int level) { if (n > 0) cuisv_buffer_write(h, p, (size_t)n, level); }
EXPORT(cuisv_w_buffer_clear) void cuisv_w_buffer_clear(double h) { cuisv_buffer_clear(h); }
EXPORT(cuisv_w_buffer_free) void cuisv_w_buffer_free(double h) { cuisv_buffer_free(h); }

/* ---- drawing for <Canvas onpaint> ------------------------------------------------------------ */

EXPORT(cuisv_w_draw_rect) void cuisv_w_draw_rect(float x, float y, float w, float h, float r, uint32_t fill, uint32_t border, float bw) {
    if (!g_ui) return;
    cui_rect rr = { x, y, w, h };
    if (bw > 0) cui_draw_rect_border(g_ui, rr, CUI_CORNERS(r), cuisv_color_u32(fill), cuisv_color_u32(border), bw);
    else cui_draw_rect(g_ui, rr, CUI_CORNERS(r), cuisv_color_u32(fill));
}
EXPORT(cuisv_w_draw_circle) void cuisv_w_draw_circle(float x, float y, float r, uint32_t c) { if (g_ui) cui_draw_circle(g_ui, (cui_vec2){ x, y }, r, cuisv_color_u32(c)); }
EXPORT(cuisv_w_draw_line) void cuisv_w_draw_line(float x1, float y1, float x2, float y2, float w, uint32_t c) {
    if (g_ui) cui_draw_line(g_ui, (cui_vec2){ x1, y1 }, (cui_vec2){ x2, y2 }, w, cuisv_color_u32(c));
}
EXPORT(cuisv_w_draw_polyline) void cuisv_w_draw_polyline(const float *pts, int n, float w, uint32_t c, int closed) {
    if (g_ui) cui_draw_polyline(g_ui, (const cui_vec2 *)pts, n, w, cuisv_color_u32(c), closed != 0);
}
EXPORT(cuisv_w_draw_polygon) void cuisv_w_draw_polygon(const float *pts, int n, uint32_t c) {
    if (g_ui) cui_draw_polygon(g_ui, (const cui_vec2 *)pts, n, cuisv_color_u32(c));
}
EXPORT(cuisv_w_draw_arc) void cuisv_w_draw_arc(float x, float y, float r, float a0, float a1, float w, uint32_t c) {
    if (g_ui) cui_draw_arc(g_ui, (cui_vec2){ x, y }, r, a0, a1, w, cuisv_color_u32(c));
}
EXPORT(cuisv_w_draw_text) void cuisv_w_draw_text(float x, float y, const char *s, int n, float size, uint32_t c, int font) {
    if (g_ui) cui_draw_text(g_ui, (cui_font)font, size, (cui_vec2){ x, y }, cuisv_color_u32(c), s, n);
}
EXPORT(cuisv_w_draw_icon) void cuisv_w_draw_icon(const char *icon, float x, float y, float w, float h, float size, uint32_t c) {
    if (g_ui) cui_draw_icon(g_ui, icon, (cui_rect){ x, y, w, h }, size, cuisv_color_u32(c));
}
EXPORT(cuisv_w_clip) void cuisv_w_clip(float x, float y, float w, float h, int push) {
    if (!g_ui) return;
    if (push) cui_push_clip(g_ui, (cui_rect){ x, y, w, h });
    else cui_pop_clip(g_ui);
}
EXPORT(cuisv_w_measure) float cuisv_w_measure(const char *s, int n, float size, int font) {
    return g_ui ? cui_measure_text(g_ui, (cui_font)font, size, s, n).width : 0;
}
