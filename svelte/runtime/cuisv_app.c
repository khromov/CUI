/* Host natives for the cui-svelte JS API: window, theme, clipboard, dialogs. */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE 1
#elif !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#  define _POSIX_C_SOURCE 200809L
#endif
#include "cuisv_app.h"
#include "cuisv_host.h"
#include <stddef.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <shellapi.h>
#  include <direct.h>
#  include <io.h>
#else
#  include <unistd.h>
#endif

#define FN(name) static JSValue cuisva_##name(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv)
#define UNUSED (void)this_val; (void)argc

/* ---- arguments from JS ------------------------------------------------------------------
 * A string argument that cannot convert (a Symbol, a throwing toString) makes the native
 * throw. Numbers and options are lenient: what does not convert is the default, and the
 * exception it raised is dropped, never left pending for an unrelated call to find. */

static void drop_exception(JSContext *c) {
    if (JS_HasException(c)) JS_FreeValue(c, JS_GetException(c));
}

static double num_arg(JSContext *c, JSValueConst v) {
    double d = 0;
    if (JS_ToFloat64(c, &d, v) < 0) { drop_exception(c); d = 0; }
    return d;
}

static int32_t int_arg(JSContext *c, JSValueConst v) {
    int32_t i = 0;
    if (JS_ToInt32(c, &i, v) < 0) { drop_exception(c); i = 0; }
    return i;
}

/* ---- UTF-8 paths, environment and arguments ------------------------------------------------ */

#if defined(_WIN32)
static wchar_t *to_wide(const char *s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *w = malloc(sizeof *w * (size_t)n);
    if (w && MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n) <= 0) { free(w); return NULL; }
    return w;
}

static char *to_utf8(const wchar_t *w) {
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char *s = malloc((size_t)n);
    if (s && WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL) <= 0) { free(s); return NULL; }
    return s;
}

typedef struct _stat64 stat_buf;
#  define IS_DIR(m) (((m) & _S_IFMT) == _S_IFDIR)
#  define IS_REG(m) (((m) & _S_IFMT) == _S_IFREG)
#else
typedef struct stat stat_buf;
#  define IS_DIR(m) S_ISDIR(m)
#  define IS_REG(m) S_ISREG(m)
#endif

static int g_argc;
static char **g_argv;
void cuisv_set_args(int argc, char **argv) {
    g_argc = argc;
    g_argv = argv;
#if defined(_WIN32)
    /* main's argv is in the ANSI code page; the wide command line has every character */
    int wn = 0;
    wchar_t **wv = CommandLineToArgvW(GetCommandLineW(), &wn);
    if (wv && wn > 0) {
        char **u = calloc((size_t)wn + 1, sizeof *u);
        int k = 0;
        while (u && k < wn && (u[k] = to_utf8(wv[k])) != NULL) k++;
        if (u && k == wn) { g_argc = wn; g_argv = u; }   /* kept for the life of the program */
        else if (u) { for (int i = 0; i < k; i++) free(u[i]); free(u); }
    }
    if (wv) LocalFree(wv);
#endif
}

FILE *cuisv_fopen(const char *path, const char *mode) {
    if (!path || !*path) return NULL;
#if defined(_WIN32)
    wchar_t *p = to_wide(path), *m = to_wide(mode);
    FILE *f = p && m ? _wfopen(p, m) : NULL;
    free(p);
    free(m);
    return f;
#else
    return fopen(path, mode);
#endif
}

char *cuisv_getenv(const char *name) {
    if (!name || !*name) return NULL;
#if defined(_WIN32)
    wchar_t *n = to_wide(name);
    const wchar_t *v = n ? _wgetenv(n) : NULL;
    char *out = v ? to_utf8(v) : NULL;
    free(n);
    return out;
#else
    const char *v = getenv(name);
    if (!v) return NULL;
    size_t len = strlen(v);
    char *out = malloc(len + 1);
    if (out) memcpy(out, v, len + 1);
    return out;
#endif
}

static void file_info(const stat_buf *st, cuisv_file_info *out) {
    out->dir = IS_DIR(st->st_mode);
    out->regular = IS_REG(st->st_mode);
    out->size = (double)st->st_size;
#if defined(__APPLE__)
    out->mtime_ns = (long long)st->st_mtimespec.tv_sec * 1000000000LL + st->st_mtimespec.tv_nsec;
#elif defined(_WIN32)
    out->mtime_ns = (long long)st->st_mtime * 1000000000LL;
#else
    out->mtime_ns = (long long)st->st_mtim.tv_sec * 1000000000LL + st->st_mtim.tv_nsec;
#endif
}

bool cuisv_stat(const char *path, cuisv_file_info *out) {
    memset(out, 0, sizeof *out);
    if (!path || !*path) return false;
    stat_buf st;
#if defined(_WIN32)
    wchar_t *p = to_wide(path);
    bool ok = p && _wstat64(p, &st) == 0;
    free(p);
#else
    bool ok = stat(path, &st) == 0;
#endif
    if (ok) file_info(&st, out);
    return ok;
}

uint8_t *cuisv_read_file(const char *path, size_t *len) {
    *len = 0;
    FILE *f = cuisv_fopen(path, "rb");
    if (!f) return NULL;
    /* a regular file only: a folder opens on Linux, and its size is no byte count */
    stat_buf st;
#if defined(_WIN32)
    bool regular = _fstat64(_fileno(f), &st) == 0 && IS_REG(st.st_mode);
#else
    bool regular = fstat(fileno(f), &st) == 0 && IS_REG(st.st_mode);
#endif
    if (!regular || st.st_size < 0 || (unsigned long long)st.st_size >= (unsigned long long)SIZE_MAX) {
        fclose(f);
        return NULL;
    }
    size_t n = (size_t)st.st_size;
    uint8_t *buf = malloc(n + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, n, f);
    bool failed = ferror(f) != 0;
    fclose(f);
    if (failed) { free(buf); return NULL; }
    buf[got] = 0;
    *len = got;
    return buf;
}

static void make_dir(const char *path) {
#if defined(_WIN32)
    wchar_t *w = to_wide(path);
    if (w) _wmkdir(w);
    free(w);
#else
    mkdir(path, 0755);
#endif
}

/* A file, or an empty folder (as remove() does on POSIX). */
static bool remove_path(const char *path) {
    if (!*path) return false;
#if defined(_WIN32)
    wchar_t *w = to_wide(path);
    bool ok = w && (_wremove(w) == 0 || _wrmdir(w) == 0);
    free(w);
    return ok;
#else
    return remove(path) == 0;
#endif
}

int cuisv_accent_from_name(const char *name) {
    if (!name) return -1;
    for (int i = 0; i < CUI_ACCENT_COUNT; i++) {
        const char *n = cui_accent_name((cui_accent)i);
        if (n && strcmp(n, name) == 0) return i;
    }
    return -1;
}

/* ---- window options ------------------------------------------------------------------- */

/* Options: a missing key, a value of another type or a getter that throws is the default. */
static char *opt_str(JSContext *c, JSValueConst obj, const char *key) {
    JSValue v = JS_GetPropertyStr(c, obj, key);
    char *out = NULL;
    if (JS_IsString(v)) {
        size_t n = 0;
        const char *s = JS_ToCStringLen(c, &n, v);
        if (s && (out = malloc(n + 1)) != NULL) memcpy(out, s, n + 1);
        if (s) JS_FreeCString(c, s);
    }
    JS_FreeValue(c, v);
    drop_exception(c);
    return out;
}

static double opt_num(JSContext *c, JSValueConst obj, const char *key, double fallback) {
    JSValue v = JS_GetPropertyStr(c, obj, key);
    double d = fallback;
    if (JS_IsNumber(v)) JS_ToFloat64(c, &d, v);
    JS_FreeValue(c, v);
    drop_exception(c);
    return d == d ? d : fallback;
}

static bool opt_bool(JSContext *c, JSValueConst obj, const char *key) {
    JSValue v = JS_GetPropertyStr(c, obj, key);
    bool b = !JS_IsException(v) && !JS_IsUndefined(v) && JS_ToBool(c, v) > 0;
    JS_FreeValue(c, v);
    drop_exception(c);
    return b;
}

/* An option that becomes an int (sizes, enums): NaN and out of range values are clamped. */
static int opt_int(JSContext *c, JSValueConst obj, const char *key, int fallback) {
    double d = opt_num(c, obj, key, fallback);
    if (d >= 2147483647.0) return 2147483647;
    if (d <= -2147483648.0) return -2147483647 - 1;
    return (int)d;
}

void cuisv_window_opts_read(JSContext *c, JSValueConst o, cuisv_window_opts *w) {
    memset(w, 0, sizeof *w);
    w->accent = -1;
    if (!JS_IsObject(o)) return;
    w->title = opt_str(c, o, "title");
    w->width = opt_int(c, o, "width", 0);
    w->height = opt_int(c, o, "height", 0);
    w->min_width = opt_int(c, o, "min_width", 0);
    w->min_height = opt_int(c, o, "min_height", 0);
    w->fixed_size = opt_bool(c, o, "fixed_size");
    w->continuous = opt_bool(c, o, "continuous");
    w->hidden = opt_bool(c, o, "hidden");
    char *renderer = opt_str(c, o, "renderer");
    if (renderer && strcmp(renderer, "opengl") == 0) w->renderer = CUI_RENDERER_OPENGL;
    if (renderer && strcmp(renderer, "software") == 0) w->renderer = CUI_RENDERER_SOFTWARE;
    free(renderer);
    char *theme = opt_str(c, o, "theme");
    if (theme && strcmp(theme, "dark") == 0) w->theme = 1;
    if (theme && strcmp(theme, "system") == 0) w->theme = 2;
    free(theme);
    char *accent = opt_str(c, o, "accent");
    w->accent = cuisv_accent_from_name(accent);
    free(accent);
}

void cuisv_window_opts_free(cuisv_window_opts *o) {
    free(o->title);
    o->title = NULL;
}

void cuisv_apply_startup(cui_ctx *ui, const cuisv_window_opts *o) {
    if (!ui) return;
    if (o->theme == 1) cui_set_theme(ui, CUI_THEME_DARK);
    if (o->accent >= 0) cui_set_accent(ui, (cui_accent)o->accent);
}

/* ---- what the services need from this host ----------------------------------------------- */

void cuisv_host_paint(uint32_t handle, int slot, cui_rect r) { cuisv_js_paint(handle, slot, r); }
void cuisv_host_open_url(const char *url) { if (cuisv_app()) cui_app_open_url(url); }
cui_texture cuisv_host_load_image(cui_ctx *ui, const char *path, int *w, int *h) { return cui_image_load(ui, path, w, h); }
double cuisv_host_now_ms(void) { return cuisv_now_ms(); }

/* ---- window and theme ----------------------------------------------------------------- */

FN(set_title) {
    UNUSED;
    const char *s = JS_ToCString(c, argv[0]);
    if (!s) return JS_EXCEPTION;
    if (cuisv_app()) cui_app_set_title(cuisv_app(), s);
    JS_FreeCString(c, s);
    return JS_UNDEFINED;
}

FN(set_theme) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    const char *s = JS_ToCString(c, argv[0]);
    if (!s) return JS_EXCEPTION;
    if (ui) cui_set_theme(ui, strcmp(s, "dark") == 0 ? CUI_THEME_DARK : CUI_THEME_LIGHT);
    JS_FreeCString(c, s);
    cuisv_request_redraw();
    return JS_UNDEFINED;
}

FN(get_theme) {
    UNUSED; (void)argv;
    cui_ctx *ui = cuisv_ui();
    return JS_NewString(c, ui && cui_get_theme_mode(ui) == CUI_THEME_DARK ? "dark" : "light");
}

FN(set_accent) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    const char *s = JS_ToCString(c, argv[0]);
    if (!s) return JS_EXCEPTION;
    int a = cuisv_accent_from_name(s);
    if (ui && a >= 0) cui_set_accent(ui, (cui_accent)a);
    JS_FreeCString(c, s);
    cuisv_request_redraw();
    return JS_UNDEFINED;
}

FN(get_accent) {
    UNUSED; (void)argv;
    cui_ctx *ui = cuisv_ui();
    return JS_NewString(c, ui ? cui_accent_name(cui_get_accent(ui)) : "neutral");
}

/* set_strings(list | null): the list is in cui_strings' field order (see cuisv_strings_set);
 * an entry that is not a string stays English, and null restores English everywhere. */
FN(set_strings) {
    UNUSED;
    const char *items[CUISV_STRINGS_COUNT] = { 0 };
    size_t lens[CUISV_STRINGS_COUNT] = { 0 };
    int n = 0;
    bool failed = false;
    if (JS_IsArray(argv[0])) {
        for (; n < CUISV_STRINGS_COUNT; n++) {
            JSValue v = JS_GetPropertyUint32(c, argv[0], (uint32_t)n);
            if (JS_IsException(v)) { failed = true; break; }
            if (JS_IsString(v) && !(items[n] = JS_ToCStringLen(c, &lens[n], v))) failed = true;
            JS_FreeValue(c, v);
            if (failed) break;
        }
    }
    if (!failed) {
        cuisv_strings_set(items, lens, n);
        cuisv_strings_apply(cuisv_ui());
        cuisv_request_redraw();
    }
    for (int i = 0; i < n; i++) if (items[i]) JS_FreeCString(c, items[i]);
    return failed ? JS_EXCEPTION : JS_UNDEFINED;
}

FN(args) {
    UNUSED; (void)argv;
    JSValue arr = JS_NewArray(c);
    for (int i = 0; i < g_argc; i++) JS_SetPropertyUint32(c, arr, (uint32_t)i, JS_NewString(c, g_argv[i]));
    return arr;
}

FN(scroll_to) {
    UNUSED;
    const char *name = JS_ToCString(c, argv[0]);
    if (!name) return JS_EXCEPTION;
    double y = num_arg(c, argv[1]);
    bool ok = cuisv_scroll_to(cuisv_ui(), name, (float)y);
    JS_FreeCString(c, name);
    cuisv_request_redraw();
    return JS_NewBool(c, ok);
}

FN(rect_of) {
    UNUSED;
    const char *name = JS_ToCString(c, argv[0]);
    if (!name) return JS_EXCEPTION;
    cui_rect r;
    bool ok = cuisv_rect_of(cuisv_ui(), name, &r);
    JS_FreeCString(c, name);
    if (!ok) return JS_NULL;
    JSValue o = JS_NewObject(c);
    JS_SetPropertyStr(c, o, "x", JS_NewFloat64(c, r.x));
    JS_SetPropertyStr(c, o, "y", JS_NewFloat64(c, r.y));
    JS_SetPropertyStr(c, o, "w", JS_NewFloat64(c, r.w));
    JS_SetPropertyStr(c, o, "h", JS_NewFloat64(c, r.h));
    return o;
}

FN(platform) {
    UNUSED; (void)argv;
#if defined(_WIN32)
    return JS_NewString(c, "windows");
#elif defined(__APPLE__)
    return JS_NewString(c, "macos");
#else
    return JS_NewString(c, "linux");
#endif
}

FN(getenv) {
    UNUSED;
    const char *k = JS_ToCString(c, argv[0]);
    if (!k) return JS_EXCEPTION;
    char *v = cuisv_getenv(k);
    JS_FreeCString(c, k);
    JSValue out = v ? JS_NewString(c, v) : JS_UNDEFINED;
    free(v);
    return out;
}

/* ---- clipboard, links, dialogs ---------------------------------------------------------- */

FN(clipboard_write) {
    UNUSED;
    const char *s = JS_ToCString(c, argv[0]);
    if (!s) return JS_EXCEPTION;
    cuisv_clipboard_set(cuisv_ui(), s);
    JS_FreeCString(c, s);
    return JS_UNDEFINED;
}

FN(clipboard_read) {
    UNUSED; (void)argv;
    const char *s = cuisv_clipboard_get(cuisv_ui());
    return JS_NewString(c, s ? s : "");
}

FN(open_url) {
    UNUSED;
    const char *s = JS_ToCString(c, argv[0]);
    if (!s) return JS_EXCEPTION;
    bool ok = cuisv_app() && cui_app_open_url(s);
    JS_FreeCString(c, s);
    return JS_NewBool(c, ok);
}

FN(file_dialog) {
    UNUSED;
    if (!cuisv_app()) return JS_NULL;
    cui_file_dialog_opts o;
    memset(&o, 0, sizeof o);
    o.kind = (cui_file_dialog_kind)opt_int(c, argv[0], "kind", 0);
    char *title = opt_str(c, argv[0], "title");
    char *filter_name = opt_str(c, argv[0], "filter_name");
    char *filter = opt_str(c, argv[0], "filter");
    char *name = opt_str(c, argv[0], "default_name");
    o.title = title; o.filter_name = filter_name; o.filter = filter; o.default_name = name;
    char out[4096];
    bool ok = cui_app_file_dialog(cuisv_app(), &o, out, sizeof out);
    free(title); free(filter_name); free(filter); free(name);
    return ok ? JS_NewString(c, out) : JS_NULL;
}

/* ---- toasts ----------------------------------------------------------------------------- */

typedef struct watched_toast { int handle; double until; } watched_toast;
static watched_toast toasts[64];
static int toast_count;

FN(toast) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    if (!ui) return JS_NewInt32(c, -1);
    const char *title = JS_ToCString(c, argv[0]);
    if (!title) return JS_EXCEPTION;
    JSValueConst o = argc > 1 ? argv[1] : JS_UNDEFINED;
    cui_toast_opts t;
    memset(&t, 0, sizeof t);
    char *desc = JS_IsObject(o) ? opt_str(c, o, "description") : NULL;
    char *action = JS_IsObject(o) ? opt_str(c, o, "action") : NULL;
    t.description = desc;
    t.action = action;
    if (JS_IsObject(o)) {
        t.tone = (cui_tone)opt_int(c, o, "tone", 0);
        t.duration = (float)opt_num(c, o, "duration", 0);
        t.show_timer = opt_bool(c, o, "show_timer");
    }
    int h = cui_toast_ex(ui, title, &t);
    if (action && toast_count < 64) {
        toasts[toast_count].handle = h;
        toasts[toast_count].until = cui_time(ui) + (t.duration > 0 ? t.duration : t.duration < 0 ? 3600 : 4) + 2;
        toast_count++;
    }
    JS_FreeCString(c, title);
    free(desc);
    free(action);
    cuisv_request_redraw();
    return JS_NewInt32(c, h);
}

FN(toast_dismiss) {
    UNUSED;
    int32_t h = int_arg(c, argv[0]);
    if (cuisv_ui()) cui_toast_dismiss(cuisv_ui(), h);
    return JS_UNDEFINED;
}

static float last_w = -1, last_h = -1;

bool cuisv_app_frame(cui_ctx *ui) {
    bool changed = false;
    double now = cui_time(ui);
    for (int i = 0; i < toast_count;) {
        if (cui_toast_action_clicked(ui, toasts[i].handle)) {
            JSValue h = JS_NewInt32(cuisv_js_ctx(), toasts[i].handle);
            JS_FreeValue(cuisv_js_ctx(), cuisv_js_hook("toast_action", 1, &h));
            toasts[i] = toasts[--toast_count];
            changed = true;
        } else if (now > toasts[i].until) {
            toasts[i] = toasts[--toast_count];
        } else i++;
    }
    cui_vec2 v = cui_viewport_size(ui);
    if (v.x != last_w || v.y != last_h) {
        last_w = v.x;
        last_h = v.y;
        JSValue args[2] = { JS_NewFloat64(cuisv_js_ctx(), v.x), JS_NewFloat64(cuisv_js_ctx(), v.y) };
        JS_FreeValue(cuisv_js_ctx(), cuisv_js_hook("resize", 2, args));
        changed = true;
    }
    if (changed) cuisv_js_settle();
    return changed;
}

FN(viewport) {
    UNUSED; (void)argv;
    cui_ctx *ui = cuisv_ui();
    cui_vec2 v = ui ? cui_viewport_size(ui) : (cui_vec2){ 0, 0 };
    JSValue a = JS_NewArray(c);
    JS_SetPropertyUint32(c, a, 0, JS_NewFloat64(c, v.x));
    JS_SetPropertyUint32(c, a, 1, JS_NewFloat64(c, v.y));
    return a;
}

/* ---- files ------------------------------------------------------------------------------- */

FN(fs_read) {
    UNUSED;
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_EXCEPTION;
    bool bytes = argc > 1 && JS_ToBool(c, argv[1]) > 0;
    size_t len = 0;
    uint8_t *data = cuisv_read_file(path, &len);
    JS_FreeCString(c, path);
    if (!data) return JS_NULL;
    JSValue out = bytes ? JS_NewUint8ArrayCopy(c, data, len) : JS_NewStringLen(c, (const char *)data, len);
    free(data);
    return out;
}

FN(fs_write) {
    UNUSED;
    /* the data first: a value that is neither text nor bytes leaves the file as it was */
    size_t n = 0;
    const char *text = NULL;
    const uint8_t *p = NULL;
    if (JS_IsString(argv[1])) {
        text = JS_ToCStringLen(c, &n, argv[1]);
        if (!text) return JS_EXCEPTION;
        p = (const uint8_t *)text;
    } else {
        p = JS_GetUint8Array(c, &n, argv[1]);
        if (!p) { drop_exception(c); p = JS_GetArrayBuffer(c, &n, argv[1]); }
        if (!p) { drop_exception(c); return JS_FALSE; }
    }
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) { if (text) JS_FreeCString(c, text); return JS_EXCEPTION; }
    bool append = argc > 2 && JS_ToBool(c, argv[2]) > 0;
    FILE *f = cuisv_fopen(path, append ? "ab" : "wb");
    JS_FreeCString(c, path);
    bool ok = f && fwrite(p, 1, n, f) == n;
    if (f && fclose(f) != 0) ok = false;
    if (text) JS_FreeCString(c, text);
    return JS_NewBool(c, ok);
}

FN(fs_stat) {
    UNUSED;
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_EXCEPTION;
    cuisv_file_info fi;
    bool ok = cuisv_stat(path, &fi);
    JS_FreeCString(c, path);
    if (!ok) return JS_NULL;
    JSValue o = JS_NewObject(c);
    JS_SetPropertyStr(c, o, "size", JS_NewFloat64(c, fi.size));
    JS_SetPropertyStr(c, o, "dir", JS_NewBool(c, fi.dir));
    JS_SetPropertyStr(c, o, "modified", JS_NewFloat64(c, (double)(fi.mtime_ns / 1000000)));
    return o;
}

FN(fs_list) {
    UNUSED;
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_EXCEPTION;
    int cap = 4096;
    cui_file_entry *entries = malloc(sizeof *entries * (size_t)cap);
    char *names = malloc(256 * 1024);
    int n = entries && names ? cui_fs_list(NULL, path, entries, cap, names, 256 * 1024, true) : -1;
    JS_FreeCString(c, path);
    JSValue out = JS_NULL;
    if (n >= 0) {
        out = JS_NewArray(c);
        for (int i = 0; i < n; i++) {
            JSValue e = JS_NewObject(c);
            JS_SetPropertyStr(c, e, "name", JS_NewString(c, entries[i].name));
            JS_SetPropertyStr(c, e, "dir", JS_NewBool(c, entries[i].dir));
            JS_SetPropertyStr(c, e, "size", JS_NewFloat64(c, (double)entries[i].size));
            JS_SetPropertyStr(c, e, "modified", JS_NewFloat64(c, (double)entries[i].modified * 1000.0));
            JS_SetPropertyUint32(c, out, (uint32_t)i, e);
        }
    }
    free(entries);
    free(names);
    return out;
}

FN(fs_remove) {
    UNUSED;
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_EXCEPTION;
    bool ok = remove_path(path);
    JS_FreeCString(c, path);
    return JS_NewBool(c, ok);
}

FN(fs_mkdir) {
    UNUSED;
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_EXCEPTION;
    size_t n = strlen(path);
    char *buf = n ? malloc(n + 1) : NULL;
    if (buf) memcpy(buf, path, n + 1);
    JS_FreeCString(c, path);
    if (!buf) return JS_FALSE;   /* "" names no folder */
    /* every missing parent too */
    for (char *p = buf + 1; *p; p++) {
        if (*p == '/' || *p == '\\') { char k = *p; *p = 0; make_dir(buf); *p = k; }
    }
    make_dir(buf);
    cuisv_file_info fi;
    bool ok = cuisv_stat(buf, &fi) && fi.dir;
    free(buf);
    return JS_NewBool(c, ok);
}

/* An environment variable that is set and not empty, else NULL (malloc'd). */
static char *env_set(const char *name) {
    char *v = cuisv_getenv(name);
    if (v && !*v) { free(v); v = NULL; }
    return v;
}

/* The folder an app keeps its data in (localStorage), per platform. */
FN(data_dir) {
    UNUSED; (void)argv;
    JSValue out;
#if defined(_WIN32)
    char *appdata = env_set("APPDATA");
    out = JS_NewString(c, appdata ? appdata : ".");
    free(appdata);
#else
    char *home = env_set("HOME");
    char *xdg = NULL;
#  if !defined(__APPLE__)
    xdg = env_set("XDG_DATA_HOME");
#  endif
    if (xdg) out = JS_NewString(c, xdg);
    else {
#  if defined(__APPLE__)
        const char *sub = "/Library/Application Support";
#  else
        const char *sub = "/.local/share";
#  endif
        const char *base = home ? home : ".";
        size_t a = strlen(base), b = strlen(sub);
        char *path = malloc(a + b + 1);
        if (path) { memcpy(path, base, a); memcpy(path + a, sub, b + 1); }
        out = path ? JS_NewString(c, path) : JS_ThrowOutOfMemory(c);
        free(path);
    }
    free(xdg);
    free(home);
#endif
    return out;
}

FN(home_dir) {
    UNUSED; (void)argv;
    char *home = env_set("HOME");
#if defined(_WIN32)
    if (!home) home = env_set("USERPROFILE");
#endif
    JSValue out = JS_NewString(c, home ? home : ".");
    free(home);
    return out;
}

static void setup(JSContext *c, JSValue bridge) {
    static const JSCFunctionListEntry funcs[] = {
        JS_CFUNC_DEF("set_title", 1, cuisva_set_title),
        JS_CFUNC_DEF("set_theme", 1, cuisva_set_theme),
        JS_CFUNC_DEF("get_theme", 0, cuisva_get_theme),
        JS_CFUNC_DEF("set_accent", 1, cuisva_set_accent),
        JS_CFUNC_DEF("get_accent", 0, cuisva_get_accent),
        JS_CFUNC_DEF("set_strings", 1, cuisva_set_strings),
        JS_CFUNC_DEF("args", 0, cuisva_args),
        JS_CFUNC_DEF("getenv", 1, cuisva_getenv),
        JS_CFUNC_DEF("platform", 0, cuisva_platform),
        JS_CFUNC_DEF("scroll_to", 2, cuisva_scroll_to),
        JS_CFUNC_DEF("rect_of", 1, cuisva_rect_of),
        JS_CFUNC_DEF("clipboard_write", 1, cuisva_clipboard_write),
        JS_CFUNC_DEF("clipboard_read", 0, cuisva_clipboard_read),
        JS_CFUNC_DEF("open_url", 1, cuisva_open_url),
        JS_CFUNC_DEF("file_dialog", 1, cuisva_file_dialog),
        JS_CFUNC_DEF("toast", 2, cuisva_toast),
        JS_CFUNC_DEF("toast_dismiss", 1, cuisva_toast_dismiss),
        JS_CFUNC_DEF("viewport", 0, cuisva_viewport),
        JS_CFUNC_DEF("fs_read", 2, cuisva_fs_read),
        JS_CFUNC_DEF("fs_write", 3, cuisva_fs_write),
        JS_CFUNC_DEF("fs_stat", 1, cuisva_fs_stat),
        JS_CFUNC_DEF("fs_list", 1, cuisva_fs_list),
        JS_CFUNC_DEF("fs_remove", 1, cuisva_fs_remove),
        JS_CFUNC_DEF("fs_mkdir", 1, cuisva_fs_mkdir),
        JS_CFUNC_DEF("data_dir", 0, cuisva_data_dir),
        JS_CFUNC_DEF("home_dir", 0, cuisva_home_dir),
    };
    JS_SetPropertyFunctionList(c, bridge, funcs, (int)(sizeof funcs / sizeof funcs[0]));
}

void cuisv_draw_setup(void);
void cuisv_buffers_setup(void);
void cuisv_app_setup(void) {
    cuisv_js_on_setup(setup);
    cuisv_draw_setup();
    cuisv_buffers_setup();
}

/* Drawing for JS painters: absolute points, colors packed as by helpers.color. */
static cui_color color_arg(JSContext *c, JSValueConst v) {
    double d = num_arg(c, v);
    return cuisv_color_u32(d >= 0 && d <= 4294967295.0 ? (uint32_t)d : 0);
}

FN(draw_rect) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    if (!ui) return JS_UNDEFINED;
    cui_rect r = { (float)num_arg(c, argv[0]), (float)num_arg(c, argv[1]), (float)num_arg(c, argv[2]), (float)num_arg(c, argv[3]) };
    float rad = (float)num_arg(c, argv[4]);
    cui_color fill = color_arg(c, argv[5]);
    float bw = argc > 7 ? (float)num_arg(c, argv[7]) : 0;
    if (bw > 0) cui_draw_rect_border(ui, r, CUI_CORNERS(rad), fill, color_arg(c, argv[6]), bw);
    else cui_draw_rect(ui, r, CUI_CORNERS(rad), fill);
    return JS_UNDEFINED;
}

FN(draw_circle) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    if (ui) cui_draw_circle(ui, (cui_vec2){ (float)num_arg(c, argv[0]), (float)num_arg(c, argv[1]) }, (float)num_arg(c, argv[2]), color_arg(c, argv[3]));
    return JS_UNDEFINED;
}

FN(draw_line) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    if (ui) cui_draw_line(ui, (cui_vec2){ (float)num_arg(c, argv[0]), (float)num_arg(c, argv[1]) }, (cui_vec2){ (float)num_arg(c, argv[2]), (float)num_arg(c, argv[3]) }, (float)num_arg(c, argv[4]), color_arg(c, argv[5]));
    return JS_UNDEFINED;
}

/* Points from a flat [x0, y0, x1, y1, …]; NULL with the exception pending (the native then
 * throws it) when the array cannot be read. A value in it that is no number is 0. */
#define MAX_POINTS (1 << 20)
static cui_vec2 *points_arg(JSContext *c, JSValueConst arr, int *n) {
    int64_t len = 0;
    *n = 0;
    if (JS_GetLength(c, arr, &len) < 0) return NULL;
    if (len / 2 > MAX_POINTS) { JS_ThrowRangeError(c, "more than %d points", MAX_POINTS); return NULL; }
    *n = len > 0 ? (int)(len / 2) : 0;
    cui_vec2 *pts = cuisv_frame_alloc(sizeof(cui_vec2) * (size_t)(*n > 0 ? *n : 1));
    for (int i = 0; i < *n; i++) {
        JSValue x = JS_GetPropertyUint32(c, arr, (uint32_t)(2 * i)), y = JS_GetPropertyUint32(c, arr, (uint32_t)(2 * i + 1));
        pts[i].x = (float)num_arg(c, x);
        pts[i].y = (float)num_arg(c, y);
        JS_FreeValue(c, x);
        JS_FreeValue(c, y);
    }
    return pts;
}

FN(draw_polyline) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    if (!ui) return JS_UNDEFINED;
    int n;
    cui_vec2 *pts = points_arg(c, argv[0], &n);
    if (!pts) return JS_EXCEPTION;
    cui_draw_polyline(ui, pts, n, (float)num_arg(c, argv[1]), color_arg(c, argv[2]), JS_ToBool(c, argv[3]) > 0);
    return JS_UNDEFINED;
}

FN(draw_polygon) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    if (!ui) return JS_UNDEFINED;
    int n;
    cui_vec2 *pts = points_arg(c, argv[0], &n);
    if (!pts) return JS_EXCEPTION;
    cui_draw_polygon(ui, pts, n, color_arg(c, argv[1]));
    return JS_UNDEFINED;
}

FN(draw_arc) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    if (ui) cui_draw_arc(ui, (cui_vec2){ (float)num_arg(c, argv[0]), (float)num_arg(c, argv[1]) }, (float)num_arg(c, argv[2]), (float)num_arg(c, argv[3]), (float)num_arg(c, argv[4]), (float)num_arg(c, argv[5]), color_arg(c, argv[6]));
    return JS_UNDEFINED;
}

FN(draw_text) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    const char *s = JS_ToCString(c, argv[2]);
    if (!s) return JS_EXCEPTION;
    if (ui) {
        int32_t font = int_arg(c, argv[5]);
        cui_draw_text(ui, (cui_font)font, (float)num_arg(c, argv[3]), (cui_vec2){ (float)num_arg(c, argv[0]), (float)num_arg(c, argv[1]) }, color_arg(c, argv[4]), s, -1);
    }
    JS_FreeCString(c, s);
    return JS_UNDEFINED;
}

FN(draw_icon) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    const char *s = JS_ToCString(c, argv[0]);
    if (!s) return JS_EXCEPTION;
    if (ui) {
        cui_rect r = { (float)num_arg(c, argv[1]), (float)num_arg(c, argv[2]), (float)num_arg(c, argv[3]), (float)num_arg(c, argv[4]) };
        cui_draw_icon(ui, s, r, (float)num_arg(c, argv[5]), color_arg(c, argv[6]));
    }
    JS_FreeCString(c, s);
    return JS_UNDEFINED;
}

FN(draw_clip) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    if (!ui) return JS_UNDEFINED;
    if (argc < 4) cui_pop_clip(ui);
    else cui_push_clip(ui, (cui_rect){ (float)num_arg(c, argv[0]), (float)num_arg(c, argv[1]), (float)num_arg(c, argv[2]), (float)num_arg(c, argv[3]) });
    return JS_UNDEFINED;
}

FN(measure_text) {
    UNUSED;
    cui_ctx *ui = cuisv_ui();
    const char *s = JS_ToCString(c, argv[0]);
    if (!s) return JS_EXCEPTION;
    double w = 0;
    if (ui) {
        int32_t font = argc > 2 ? int_arg(c, argv[2]) : 0;
        w = cui_measure_text(ui, (cui_font)font, (float)num_arg(c, argv[1]), s, -1).width;
    }
    JS_FreeCString(c, s);
    return JS_NewFloat64(c, w);
}

static void setup_draw(JSContext *c, JSValue bridge) {
    static const JSCFunctionListEntry funcs[] = {
        JS_CFUNC_DEF("draw_rect", 8, cuisva_draw_rect),
        JS_CFUNC_DEF("draw_circle", 4, cuisva_draw_circle),
        JS_CFUNC_DEF("draw_line", 6, cuisva_draw_line),
        JS_CFUNC_DEF("draw_polyline", 4, cuisva_draw_polyline),
        JS_CFUNC_DEF("draw_polygon", 2, cuisva_draw_polygon),
        JS_CFUNC_DEF("draw_arc", 7, cuisva_draw_arc),
        JS_CFUNC_DEF("draw_text", 6, cuisva_draw_text),
        JS_CFUNC_DEF("draw_icon", 7, cuisva_draw_icon),
        JS_CFUNC_DEF("draw_clip", 4, cuisva_draw_clip),
        JS_CFUNC_DEF("measure_text", 3, cuisva_measure_text),
    };
    JS_SetPropertyFunctionList(c, bridge, funcs, (int)(sizeof funcs / sizeof funcs[0]));
}

void cuisv_draw_setup(void) { cuisv_js_on_setup(setup_draw); }

/* ---- log and terminal buffers (LogBuffer / TerminalBuffer in JS): cuisv_services.c ---- */

FN(buffer_new) {
    UNUSED;
    int32_t kind = int_arg(c, argv[0]);
    int32_t lines = argc > 1 ? int_arg(c, argv[1]) : 2000;
    double text = argc > 2 ? num_arg(c, argv[2]) : 256 * 1024;
    /* cuisv_buffer_new clamps both; this keeps the double -> size_t conversion defined */
    if (!(text >= 0)) text = 0;
    if (text > 1073741824.0) text = 1073741824.0;
    return JS_NewInt32(c, cuisv_buffer_new(kind, lines, (size_t)text));
}

FN(buffer_write) {
    UNUSED;
    double h = num_arg(c, argv[0]);
    size_t len = 0;
    const char *s = JS_ToCStringLen(c, &len, argv[1]);
    if (!s) return JS_EXCEPTION;
    int32_t level = argc > 2 ? int_arg(c, argv[2]) : 0;
    cuisv_buffer_write(h, s, len, level);
    JS_FreeCString(c, s);
    cuisv_request_redraw();
    return JS_UNDEFINED;
}

FN(buffer_clear) {
    UNUSED;
    cuisv_buffer_clear(num_arg(c, argv[0]));
    cuisv_request_redraw();
    return JS_UNDEFINED;
}

FN(buffer_free) {
    UNUSED;
    cuisv_buffer_free(num_arg(c, argv[0]));
    return JS_UNDEFINED;
}

static void setup_buffers(JSContext *c, JSValue bridge) {
    static const JSCFunctionListEntry funcs[] = {
        JS_CFUNC_DEF("buffer_new", 3, cuisva_buffer_new),
        JS_CFUNC_DEF("buffer_write", 3, cuisva_buffer_write),
        JS_CFUNC_DEF("buffer_clear", 1, cuisva_buffer_clear),
        JS_CFUNC_DEF("buffer_free", 1, cuisva_buffer_free),
    };
    JS_SetPropertyFunctionList(c, bridge, funcs, (int)(sizeof funcs / sizeof funcs[0]));
}

void cuisv_buffers_setup(void) { cuisv_js_on_setup(setup_buffers); }
