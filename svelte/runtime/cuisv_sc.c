/* The scriptc host: the app's JS is compiled to native code by scriptc (no JS engine in the
 * binary) and calls these functions through scriptc's FFI (src/scriptc/ffi.json). The compiled
 * program owns main() and the frame loop:
 *
 *     while (cuisvsc_frame_begin()) {      window events, cui_begin_frame
 *         ...events of the last frame, timers, the renderer's commit (all JS)...
 *         cuisvsc_frame_render(...);       templates; headless: cui_end_frame
 *     }
 *
 * FFI values are scalars and borrowed (pointer, length) spans, so events are read by index
 * and strings reach JS through call-scoped callbacks. */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE 1
#elif !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#  define _POSIX_C_SOURCE 200809L
#endif
#include "cuisv_internal.h"
#include "cui_internal.h"

#include <cui/cui_app.h>
#include <cui/cui_render.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <time.h>
#endif

static cui_app *sc_app;
static cui_ctx *sc_ui;                 /* the window's context, or the headless one */
static cui_sw_renderer *sc_sw;         /* headless only */
static int sc_view_w = 800, sc_view_h = 600;
static bool sc_headless, sc_redraw, sc_inited;
static char sc_clipboard[64 * 1024];

typedef void (*cuisvsc_paint_fn)(uint32_t handle, int32_t slot, double x, double y, double w, double h, void *context);
static cuisvsc_paint_fn sc_paint;
static void *sc_paint_ctx;

/* ---- what the shared services need from a host ------------------------------------------ */

double cuisv_host_now_ms(void) {
#if defined(_WIN32)
    static LARGE_INTEGER freq;
    LARGE_INTEGER now;
    if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&now);
    return (double)now.QuadPart * 1000.0 / (double)freq.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}
void cuisv_host_paint(uint32_t handle, int slot, cui_rect r) {
    if (sc_paint) sc_paint(handle, slot, r.x, r.y, r.w, r.h, sc_paint_ctx);
}
void cuisv_host_open_url(const char *url) { if (sc_app) cui_app_open_url(url); }
cui_texture cuisv_host_load_image(cui_ctx *ui, const char *path, int *w, int *h) { return cui_image_load(ui, path, w, h); }

static void sc_init(void) {
    if (sc_inited) return;
    sc_inited = true;
    cuisv_runtime_init();
}

/* A span from JS as a C string (spans are not NUL terminated). Freed by the caller. */
static char *sc_cstr(const uint8_t *p, size_t len) {
    char *s = malloc(len + 1);
    if (!s) { cuisv_log("fatal", "out of memory"); abort(); }
    if (len) memcpy(s, p, len);
    s[len] = 0;
    return s;
}

/* ---- scopes and slots --------------------------------------------------------------------- */

uint32_t cuisvsc_root(void) { sc_init(); return cuisv_root()->handle; }
uint32_t cuisvsc_scope(uint32_t template_id) {
    sc_init();
    cuisv_scope *s = cuisv_scope_new(template_id);
    return s ? s->handle : 0;
}
void cuisvsc_free(uint32_t h) { cuisv_scope_free(cuisv_scope_get(h)); }
void cuisvsc_insert(uint32_t parent, int32_t site, uint32_t child, uint32_t before) {
    cuisv_insert(cuisv_scope_get(parent), site, cuisv_scope_get(child), before ? cuisv_scope_get(before) : NULL);
}
void cuisvsc_detach(uint32_t h) { cuisv_detach(cuisv_scope_get(h)); }

void cuisvsc_num(uint32_t h, int32_t slot, double v) { cuisv_set_num(cuisv_scope_get(h), slot, v); }
void cuisvsc_bool(uint32_t h, int32_t slot, uint8_t v) { cuisv_set_bool(cuisv_scope_get(h), slot, v != 0); }
void cuisvsc_str(uint32_t h, int32_t slot, const uint8_t *p, size_t len) {
    cuisv_set_str(cuisv_scope_get(h), slot, p ? (const char *)p : "", len);
}
void cuisvsc_unset(uint32_t h, int32_t slot) { cuisv_slot_unset(cuisv_scope_get(h), slot); }
void cuisvsc_fn(uint32_t h, int32_t slot, uint8_t present) { cuisv_slot_fn(cuisv_scope_get(h), slot, present != 0); }

/* A string list arrives as one span: each item as a little-endian u32 byte length, then its
 * UTF-8 bytes. */
void cuisvsc_strs(uint32_t h, int32_t slot, const uint8_t *p, size_t len, int32_t count) {
    if (count < 0) count = 0;
    size_t cap = (size_t)(count ? count : 1);
    const char **items = calloc(cap, sizeof *items);
    size_t *lens = calloc(cap, sizeof *lens);
    if (!items || !lens) { cuisv_log("fatal", "out of memory"); abort(); }
    size_t at = 0;
    int n = 0;
    for (; n < count && at + 4 <= len; n++) {
        uint32_t l = (uint32_t)p[at] | (uint32_t)p[at + 1] << 8 | (uint32_t)p[at + 2] << 16 | (uint32_t)p[at + 3] << 24;
        at += 4;
        if (l > len - at) break;
        items[n] = (const char *)p + at;
        lens[n] = l;
        at += l;
    }
    cuisv_slot_strs(cuisv_scope_get(h), slot, items, lens, n);
    free((void *)items);
    free(lens);
}
/* The bytes of a Float32Array. */
void cuisvsc_floats(uint32_t h, int32_t slot, const uint8_t *p, size_t len) {
    int n = (int)(len / sizeof(float));
    float *vals = malloc(sizeof(float) * (size_t)(n ? n : 1));
    if (!vals) { cuisv_log("fatal", "out of memory"); abort(); }
    if (n) memcpy(vals, p, sizeof(float) * (size_t)n);   /* the span may not be aligned */
    cuisv_slot_floats(cuisv_scope_get(h), slot, vals, n);
    free(vals);
}
void cuisvsc_blob(uint32_t h, int32_t slot, const uint8_t *p, size_t len) {
    cuisv_slot_blob(cuisv_scope_get(h), slot, p, (uint32_t)len);
}

/* ---- events of the last frame ------------------------------------------------------------- */

static cuisv_event *sc_event(int32_t i) {
    return i >= 0 && i < cuisv_event_count() ? &cuisv_events()[i] : NULL;
}
int32_t cuisvsc_ev_count(void) { return cuisv_event_count(); }
uint32_t cuisvsc_ev_handle(int32_t i) { cuisv_event *e = sc_event(i); return e ? e->handle : 0; }
int32_t cuisvsc_ev_slot(int32_t i) { cuisv_event *e = sc_event(i); return e ? e->slot : 0; }
int32_t cuisvsc_ev_kind(int32_t i) { cuisv_event *e = sc_event(i); return e ? e->kind : 0; }
double cuisvsc_ev_a(int32_t i) { cuisv_event *e = sc_event(i); return e ? e->a : 0; }
double cuisvsc_ev_b(int32_t i) { cuisv_event *e = sc_event(i); return e ? e->b : 0; }
typedef void (*cuisvsc_span_fn)(const uint8_t *p, size_t len, void *context);
void cuisvsc_ev_str(int32_t i, cuisvsc_span_fn cb, void *context) {
    cuisv_event *e = sc_event(i);
    const char *s = e && e->str ? e->str : "";
    cb((const uint8_t *)s, strlen(s), context);
}
void cuisvsc_ev_bytes(int32_t i, cuisvsc_span_fn cb, void *context) {
    cuisv_event *e = sc_event(i);
    cb(e && e->str ? (const uint8_t *)e->str : (const uint8_t *)"", e && e->str ? e->len : 0, context);
}
void cuisvsc_ev_clear(void) { cuisv_events_clear(); }

/* ---- the window (or the headless context) and the frame ------------------------------------- */

static void sc_clip_set(void *u, const char *s) { (void)u; snprintf(sc_clipboard, sizeof sc_clipboard, "%s", s); }
static const char *sc_clip_get(void *u) { (void)u; return sc_clipboard; }

/* theme: 0 light, 1 dark, 2 follow the system. accent: -1 for the default.
 * flags: 1 fixed size, 2 continuous, 4 hidden, 8 headless (no window: the software renderer). */
uint8_t cuisvsc_app(const uint8_t *title, size_t title_len, int32_t width, int32_t height, int32_t min_width, int32_t min_height,
                    int32_t flags, int32_t renderer, int32_t theme, int32_t accent) {
    sc_init();
    if (flags & 8) {
        sc_headless = true;
        if (width > 0) sc_view_w = width;
        if (height > 0) sc_view_h = height;
        if (!sc_ui) {
            sc_sw = cui_sw_create();
            sc_ui = cui_create(&(cui_ctx_desc){ .renderer = cui_sw_iface(sc_sw), .theme = theme == 1 ? CUI_THEME_DARK : CUI_THEME_LIGHT });
            cui_set_platform(sc_ui, &(cui_platform_iface){ .set_clipboard = sc_clip_set, .get_clipboard = sc_clip_get });
            cui_set_reduced_motion(sc_ui, true);   /* deterministic: animations snap */
            if (accent >= 0) cui_set_accent(sc_ui, (cui_accent)accent);
        }
        cui_set_viewport(sc_ui, (float)sc_view_w, (float)sc_view_h, 1);
        return 1;
    }
    char *t = sc_cstr(title, title_len);
    if (sc_app) {
        if (title_len) cui_app_set_title(sc_app, t);
    } else {
        cui_app_desc d;
        memset(&d, 0, sizeof d);
        d.title = title_len ? t : "CUI";
        d.width = width;
        d.height = height;
        d.min_width = min_width;
        d.min_height = min_height;
        d.fixed_size = (flags & 1) != 0;
        d.continuous = (flags & 2) != 0;
        d.hidden = (flags & 4) != 0;
        d.renderer = (cui_renderer_kind)renderer;
        d.theme = theme == 1 ? CUI_THEME_DARK : CUI_THEME_LIGHT;
        d.follow_system_theme = theme == 2;
        if (accent >= 0) d.accent = (cui_accent)accent;
        sc_app = cui_app_create(&d);
        if (sc_app) {
            sc_ui = cui_app_ui(sc_app);
            if (theme == 1) cui_set_theme(sc_ui, CUI_THEME_DARK);
            if (accent >= 0) cui_set_accent(sc_ui, (cui_accent)accent);
        }
    }
    free(t);
    return sc_app != NULL;
}

/* Starts a frame. False once the window was closed (or there is no context). */
uint8_t cuisvsc_frame_begin(void) {
    if (!sc_ui) return 0;
    if (sc_headless) {
        cui_begin_frame(sc_ui, 1.0f / 60.0f);
        return 1;
    }
    return cui_app_frame(sc_app);
}

/* Builds the frame from the templates. `changed`: JS changed something this turn, so draw
 * again; `wake`: seconds until JS wants to run again without input, negative for never.
 * Returns how many events the frame queued. */
int32_t cuisvsc_frame_render(uint8_t changed, double wake) {
    if (!sc_ui) return 0;
    cuisv_frame_reset();
    cuisv_render_scope(sc_ui, cuisv_root());
    cuisv_collect_keys(sc_ui);
    cuisv_collect_scrolls(sc_ui);
    int n = cuisv_event_count();
    if (sc_headless) {
        cui_end_frame(sc_ui);
        return n;
    }
    if (changed || n > 0 || sc_redraw) cui_request_redraw(sc_ui);
    sc_redraw = false;
    if (wake >= 0) cui_request_wakeup(sc_ui, (float)wake);
    return n;
}

void cuisvsc_on_paint(cuisvsc_paint_fn fn, void *context) { sc_paint = fn; sc_paint_ctx = context; }
/* Asked for between frames too (a promise settled): the window must not go to sleep first. */
void cuisvsc_redraw(void) {
    sc_redraw = true;
    if (sc_ui && !sc_headless) cui_request_redraw(sc_ui);
}
void cuisvsc_quit(void) { if (sc_app) cui_app_quit(sc_app); }
void cuisvsc_want_keys(uint8_t on) { cuisv_want_keys(on != 0); }
double cuisvsc_time_ms(void) { return sc_ui ? (double)cui_time(sc_ui) * 1000.0 : 0; }
void cuisvsc_set_title(const uint8_t *p, size_t len) {
    char *t = sc_cstr(p, len);
    if (sc_app) cui_app_set_title(sc_app, t);
    free(t);
}
void cuisvsc_set_theme(uint8_t dark) { if (sc_ui) cui_set_theme(sc_ui, dark ? CUI_THEME_DARK : CUI_THEME_LIGHT); sc_redraw = true; }
uint8_t cuisvsc_get_theme(void) { return sc_ui && cui_get_theme_mode(sc_ui) == CUI_THEME_DARK; }
void cuisvsc_set_accent(int32_t accent) { if (sc_ui) cui_set_accent(sc_ui, (cui_accent)accent); sc_redraw = true; }

void cuisvsc_shutdown(void) {
    cuisv_runtime_shutdown();
    if (sc_app) cui_app_destroy(sc_app);
    else if (sc_ui) cui_destroy(sc_ui);
    if (sc_sw) cui_sw_destroy(sc_sw);
    sc_app = NULL;
    sc_ui = NULL;
    sc_sw = NULL;
}

/* ---- host APIs with no equivalent in the compiled program's own library ----------------------- */

/* cuisv_cui.c; declared in cuisv_app.h, which is QuickJS's */
void cuisv_clipboard_set(cui_ctx *ui, const char *text);
const char *cuisv_clipboard_get(cui_ctx *ui);

void cuisvsc_clipboard_write(const uint8_t *p, size_t len) {
    char *s = sc_cstr(p, len);
    cuisv_clipboard_set(sc_ui, s);
    free(s);
}
void cuisvsc_clipboard_read(cuisvsc_span_fn cb, void *context) {
    const char *s = cuisv_clipboard_get(sc_ui);
    if (!s) s = "";
    cb((const uint8_t *)s, strlen(s), context);
}
uint8_t cuisvsc_open_url(const uint8_t *p, size_t len) {
    char *s = sc_cstr(p, len);
    bool ok = sc_app && cui_app_open_url(s);
    free(s);
    return ok;
}
double cuisvsc_viewport_part(int32_t i) {
    cui_vec2 v = sc_ui ? cui_viewport_size(sc_ui) : (cui_vec2){ 0, 0 };
    return i == 0 ? v.x : v.y;
}

/* A rectangle is answered in two steps: the call that finds it, then its four parts. */
static cui_rect sc_rect;
double cuisvsc_rect_part(int32_t i) {
    return i == 0 ? sc_rect.x : i == 1 ? sc_rect.y : i == 2 ? sc_rect.w : sc_rect.h;
}
uint8_t cuisvsc_rect_of(const uint8_t *p, size_t len) {
    char *s = sc_cstr(p, len);
    bool ok = sc_ui && cuisv_rect_of(sc_ui, s, &sc_rect);
    free(s);
    return ok;
}
uint8_t cuisvsc_scroll_to(const uint8_t *p, size_t len, double y) {
    char *s = sc_cstr(p, len);
    bool ok = sc_ui && cuisv_scroll_to(sc_ui, s, (float)y);
    free(s);
    sc_redraw = true;
    return ok;
}
void cuisvsc_get_accent(cuisvsc_span_fn cb, void *context) {
    const char *s = sc_ui ? cui_accent_name(cui_get_accent(sc_ui)) : "neutral";
    cb((const uint8_t *)s, strlen(s), context);
}

/* set_strings: the list packed like cuisvsc_strs; count 0 is English. */
void cuisvsc_set_strings(const uint8_t *p, size_t len, int32_t count) {
    const char *items[CUISV_STRINGS_COUNT] = { 0 };
    size_t lens[CUISV_STRINGS_COUNT] = { 0 };
    size_t at = 0;
    int n = 0;
    for (; n < count && n < CUISV_STRINGS_COUNT && at + 4 <= len; n++) {
        uint32_t l = (uint32_t)p[at] | (uint32_t)p[at + 1] << 8 | (uint32_t)p[at + 2] << 16 | (uint32_t)p[at + 3] << 24;
        at += 4;
        if (l > len - at) break;
        if (l) { items[n] = (const char *)p + at; lens[n] = l; }
        at += l;
    }
    cuisv_strings_set(items, lens, n);
    cuisv_strings_apply(sc_ui);
    sc_redraw = true;
}

int32_t cuisvsc_buffer_new(int32_t kind, int32_t lines, double bytes) { return cuisv_buffer_new(kind, lines, (size_t)bytes); }
void cuisvsc_buffer_write(double handle, const uint8_t *p, size_t len, int32_t level) {
    cuisv_buffer_write(handle, p ? (const char *)p : "", len, level);
}
void cuisvsc_buffer_clear(double handle) { cuisv_buffer_clear(handle); }
void cuisvsc_buffer_free(double handle) { cuisv_buffer_free(handle); }

/* ---- toasts and dialogs ------------------------------------------------------------------------- */

/* Toasts with an action: JS asks once per frame which were clicked or are gone. */
static int *sc_toasts;
static int sc_toast_count, sc_toast_cap, sc_toast_event_kind;

int32_t cuisvsc_toast(const uint8_t *title, size_t title_len, const uint8_t *desc, size_t desc_len, const uint8_t *action, size_t action_len,
                      int32_t tone, double duration, uint8_t show_timer) {
    if (!sc_ui) return -1;
    char *t = sc_cstr(title, title_len), *d = sc_cstr(desc, desc_len), *a = sc_cstr(action, action_len);
    cui_toast_opts o;
    memset(&o, 0, sizeof o);
    o.description = desc_len ? d : NULL;
    o.action = action_len ? a : NULL;
    o.tone = (cui_tone)tone;
    o.duration = (float)duration;
    o.show_timer = show_timer != 0;
    int h = cui_toast_ex(sc_ui, t, &o);
    if (action_len && sc_toast_count == sc_toast_cap) {
        int cap = sc_toast_cap ? sc_toast_cap * 2 : 8;
        int *grown = realloc(sc_toasts, sizeof *sc_toasts * (size_t)cap);
        if (grown) { sc_toasts = grown; sc_toast_cap = cap; }
    }
    if (action_len && sc_toast_count < sc_toast_cap) sc_toasts[sc_toast_count++] = h;
    free(t); free(d); free(a);
    sc_redraw = true;
    return h;
}
void cuisvsc_toast_dismiss(int32_t h) { if (sc_ui) cui_toast_dismiss(sc_ui, h); }
/* The next toast whose action was clicked (kind 1) or that left without it (kind 2); -1 for none. */
int32_t cuisvsc_toast_next(void) {
    if (!sc_ui) return -1;
    for (int i = 0; i < sc_toast_count; i++) {
        int kind = cui_toast_action_clicked(sc_ui, sc_toasts[i]) ? 1 : !cuisv_toast_alive(sc_ui, sc_toasts[i]) ? 2 : 0;
        if (!kind) continue;
        int h = sc_toasts[i];
        sc_toasts[i] = sc_toasts[--sc_toast_count];
        sc_toast_event_kind = kind;
        return h;
    }
    return -1;
}
int32_t cuisvsc_toast_kind(void) { return sc_toast_event_kind; }

uint8_t cuisvsc_file_dialog(int32_t kind, const uint8_t *title, size_t title_len, const uint8_t *filter_name, size_t filter_name_len,
                            const uint8_t *filter, size_t filter_len, const uint8_t *name, size_t name_len, cuisvsc_span_fn cb, void *context) {
    if (!sc_app) return 0;
    char *t = sc_cstr(title, title_len), *fn = sc_cstr(filter_name, filter_name_len), *f = sc_cstr(filter, filter_len), *n = sc_cstr(name, name_len);
    cui_file_dialog_opts o;
    memset(&o, 0, sizeof o);
    o.kind = (cui_file_dialog_kind)kind;
    o.title = title_len ? t : NULL;
    o.filter_name = filter_name_len ? fn : NULL;
    o.filter = filter_len ? f : NULL;
    o.default_name = name_len ? n : NULL;
    char out[4096];
    bool ok = cui_app_file_dialog(sc_app, &o, out, sizeof out);
    free(t); free(fn); free(f); free(n);
    if (ok) cb((const uint8_t *)out, strlen(out), context);
    return ok;
}

/* ---- <Canvas onpaint>: the Painter's calls ------------------------------------------------------- */

static cui_color sc_color(double d) { return cuisv_color_u32(d >= 0 && d <= 4294967295.0 ? (uint32_t)d : 0); }
/* x, y pairs as the bytes of a Float32Array; the points live until the frame is painted */
static cui_vec2 *sc_points(const uint8_t *p, size_t len, int *n) {
    *n = (int)(len / (2 * sizeof(float)));
    cui_vec2 *pts = cuisv_frame_alloc(sizeof(cui_vec2) * (size_t)(*n > 0 ? *n : 1));
    for (int i = 0; i < *n; i++) {
        float xy[2];
        memcpy(xy, p + (size_t)i * sizeof xy, sizeof xy);
        pts[i] = (cui_vec2){ xy[0], xy[1] };
    }
    return pts;
}
void cuisvsc_draw_rect(double x, double y, double w, double h, double radius, double fill, double border, double border_width) {
    if (!sc_ui) return;
    cui_rect r = { (float)x, (float)y, (float)w, (float)h };
    if (border_width > 0) cui_draw_rect_border(sc_ui, r, CUI_CORNERS((float)radius), sc_color(fill), sc_color(border), (float)border_width);
    else cui_draw_rect(sc_ui, r, CUI_CORNERS((float)radius), sc_color(fill));
}
void cuisvsc_draw_circle(double cx, double cy, double r, double color) {
    if (sc_ui) cui_draw_circle(sc_ui, (cui_vec2){ (float)cx, (float)cy }, (float)r, sc_color(color));
}
void cuisvsc_draw_line(double x1, double y1, double x2, double y2, double width, double color) {
    if (sc_ui) cui_draw_line(sc_ui, (cui_vec2){ (float)x1, (float)y1 }, (cui_vec2){ (float)x2, (float)y2 }, (float)width, sc_color(color));
}
void cuisvsc_draw_polyline(const uint8_t *p, size_t len, double width, double color, uint8_t closed) {
    if (!sc_ui) return;
    int n;
    cui_vec2 *pts = sc_points(p, len, &n);
    cui_draw_polyline(sc_ui, pts, n, (float)width, sc_color(color), closed != 0);
}
void cuisvsc_draw_polygon(const uint8_t *p, size_t len, double color) {
    if (!sc_ui) return;
    int n;
    cui_vec2 *pts = sc_points(p, len, &n);
    cui_draw_polygon(sc_ui, pts, n, sc_color(color));
}
void cuisvsc_draw_arc(double cx, double cy, double r, double a0, double a1, double width, double color) {
    if (sc_ui) cui_draw_arc(sc_ui, (cui_vec2){ (float)cx, (float)cy }, (float)r, (float)a0, (float)a1, (float)width, sc_color(color));
}
/* text and icon names are copied into the frame: CUI paints after this call returns */
static const char *sc_frame_str(const uint8_t *p, size_t len) {
    char *s = cuisv_frame_alloc(len + 1);
    if (len) memcpy(s, p, len);
    s[len] = 0;
    return s;
}
void cuisvsc_draw_text(double x, double y, const uint8_t *p, size_t len, double size, double color, int32_t font) {
    if (sc_ui) cui_draw_text(sc_ui, (cui_font)font, (float)size, (cui_vec2){ (float)x, (float)y }, sc_color(color), sc_frame_str(p, len), -1);
}
void cuisvsc_draw_icon(const uint8_t *p, size_t len, double x, double y, double w, double h, double size, double color) {
    if (sc_ui) cui_draw_icon(sc_ui, sc_frame_str(p, len), (cui_rect){ (float)x, (float)y, (float)w, (float)h }, (float)size, sc_color(color));
}
void cuisvsc_draw_clip(double x, double y, double w, double h) {
    if (sc_ui) cui_push_clip(sc_ui, (cui_rect){ (float)x, (float)y, (float)w, (float)h });
}
void cuisvsc_draw_unclip(void) { if (sc_ui) cui_pop_clip(sc_ui); }
double cuisvsc_measure_text(const uint8_t *p, size_t len, double size, int32_t font) {
    if (!sc_ui) return 0;
    char *s = sc_cstr(p, len);
    double w = cui_measure_text(sc_ui, (cui_font)font, (float)size, s, -1).width;
    free(s);
    return w;
}

/* ---- headless input and inspection (cui-svelte/test) ------------------------------------------ */

void cuisvsc_test_move(double x, double y) { if (sc_ui) cui_input_mouse_move(sc_ui, (float)x, (float)y); }
void cuisvsc_test_button(int32_t button, uint8_t down) { if (sc_ui) cui_input_mouse_button(sc_ui, (cui_mouse_button)button, down != 0); }
void cuisvsc_test_key(int32_t key, uint8_t down, int32_t mods) { if (sc_ui) cui_input_key(sc_ui, (cui_key)key, down != 0, mods); }
void cuisvsc_test_text(const uint8_t *p, size_t len) {
    char *s = sc_cstr(p, len);
    if (sc_ui) cui_input_text(sc_ui, s);
    free(s);
}
void cuisvsc_test_scroll(double dx, double dy) { if (sc_ui) cui_input_scroll(sc_ui, (float)dx, (float)dy); }
void cuisvsc_test_motion(uint8_t on) { if (sc_ui) cui_set_reduced_motion(sc_ui, !on); }

/* Every node of the latest layout with text; dy is how far animations move it when drawn. */
typedef void (*cuisvsc_node_fn)(const uint8_t *text, size_t len, double x, double y, double w, double h, double dy, void *context);
void cuisvsc_test_nodes(cuisvsc_node_fn cb, void *context) {
    if (!sc_ui) return;
    for (int i = 0; i < sc_ui->node_count; i++) {
        cui_node *n = &sc_ui->nodes[i];
        if (!n->text || n->text_len <= 0) continue;
        float dy = n->ty;
        for (int p = n->parent; p >= 0; p = sc_ui->nodes[p].parent) dy += sc_ui->nodes[p].ty;
        cb((const uint8_t *)n->text, (size_t)n->text_len, n->rect.x, n->rect.y, n->rect.w, n->rect.h, dy, context);
    }
}

uint8_t cuisvsc_test_rect(const uint8_t *p, size_t len) {
    char *s = sc_cstr(p, len);
    sc_rect = (cui_rect){0};
    if (sc_ui && !cuisv_rect_of(sc_ui, s, &sc_rect)) sc_rect = cui_get_rect(sc_ui, cui_make_id(sc_ui, s));
    free(s);
    return sc_rect.w > 0 || sc_rect.h > 0;
}

/* The latest frame as a PNG (headless). */
uint8_t cuisvsc_test_png(const uint8_t *p, size_t len) {
    if (!sc_ui || !sc_sw) return 0;
    char *path = sc_cstr(p, len);
    int w = sc_view_w, h = sc_view_h;
    uint8_t *px = malloc((size_t)w * (size_t)h * 4);
    bool ok = false;
    if (px) {
        cui_sw_render(sc_sw, cui_get_draw_data(sc_ui), px, w, h, w * 4, CUI_SW_RGBA);
        ok = cui_write_png(path, px, w, h, w * 4);
    }
    free(px);
    free(path);
    return ok;
}
void cuisvsc_test_clipboard(cuisvsc_span_fn cb, void *context) {
    cb((const uint8_t *)sc_clipboard, strlen(sc_clipboard), context);
}
