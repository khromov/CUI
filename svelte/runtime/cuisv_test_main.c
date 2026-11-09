/* main() of a test build: no window. run() creates a context drawn by the software renderer
 * and the test script (cui-svelte/test) drives frames and input itself. */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE 1
#elif !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#  define _POSIX_C_SOURCE 200809L
#endif
#include "cuisv_host.h"
#include "cuisv_app.h"
#include "cui_internal.h"

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

static cui_ctx *ui;
static cui_sw_renderer *sw;
static int view_w = 800, view_h = 600;
static int exit_code = -1;
static char clipboard[64 * 1024];

cui_app *cuisv_app(void) { return NULL; }
cui_ctx *cuisv_ui(void) { return ui; }
void cuisv_request_redraw(void) {}

static void clip_set(void *u, const char *s) { (void)u; snprintf(clipboard, sizeof clipboard, "%s", s); }
static const char *clip_get(void *u) { (void)u; return clipboard; }

#define FN(name) static JSValue cuisvt_##name(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv)
#define UNUSED (void)this_val; (void)argc

static double num(JSContext *c, JSValueConst v) { double d = 0; JS_ToFloat64(c, &d, v); return d; }

FN(app) {
    UNUSED;
    cuisv_window_opts w;
    cuisv_window_opts_read(c, argc > 0 ? argv[0] : JS_UNDEFINED, &w);
    if (!ui) {
        if (w.width > 0) view_w = w.width;
        if (w.height > 0) view_h = w.height;
        sw = cui_sw_create();
        ui = cui_create(&(cui_ctx_desc){ .renderer = cui_sw_iface(sw), .theme = w.theme == 1 ? CUI_THEME_DARK : CUI_THEME_LIGHT });
        cui_set_viewport(ui, (float)view_w, (float)view_h, 1);
        cui_set_platform(ui, &(cui_platform_iface){ .set_clipboard = clip_set, .get_clipboard = clip_get });
        cui_set_reduced_motion(ui, true);   /* deterministic: animations snap */
        cuisv_apply_startup(ui, &w);
    } else if (w.width > 0 || w.height > 0) {
        /* a later mount_test in the same file: the context stays, its size follows the options */
        if (w.width > 0) view_w = w.width;
        if (w.height > 0) view_h = w.height;
        cui_set_viewport(ui, (float)view_w, (float)view_h, 1);
    }
    cuisv_window_opts_free(&w);
    return JS_TRUE;
}

/* JS runs inside a frame (events, timers, onpaint), and a frame begun there would nest in the
 * one running: test_frame and test_png refuse while in_frame. */
static bool in_frame;

static void one_frame(void) {
    in_frame = true;
    cui_begin_frame(ui, 1.0f / 60.0f);
    cuisv_host_frame(ui);
    cui_end_frame(ui);
    in_frame = false;
}

#define NOT_IN_FRAME(what) \
    if (in_frame) return JS_ThrowPlainError(c, what " cannot run inside a frame (from an event handler, a timer or onpaint)")

FN(frame) {
    UNUSED;
    double want = argc > 0 ? num(c, argv[0]) : 1;
    int n = want >= 1 ? (want < 100000 ? (int)want : 100000) : 0;
    if (!ui) return JS_ThrowPlainError(c, "test_frame before run()");
    NOT_IN_FRAME("test_frame");
    for (int i = 0; i < n; i++) one_frame();
    return JS_UNDEFINED;
}

FN(move) { UNUSED; if (ui) cui_input_mouse_move(ui, (float)num(c, argv[0]), (float)num(c, argv[1])); return JS_UNDEFINED; }
FN(button) {
    UNUSED;
    if (ui) cui_input_mouse_button(ui, (cui_mouse_button)(int)num(c, argv[0]), JS_ToBool(c, argv[1]) > 0);
    return JS_UNDEFINED;
}
FN(key) {
    UNUSED;
    if (ui) cui_input_key(ui, (cui_key)(int)num(c, argv[0]), JS_ToBool(c, argv[1]) > 0, argc > 2 ? (int)num(c, argv[2]) : 0);
    return JS_UNDEFINED;
}
FN(text) {
    UNUSED;
    const char *s = JS_ToCString(c, argv[0]);
    if (ui && s) cui_input_text(ui, s);
    if (s) JS_FreeCString(c, s);
    return JS_UNDEFINED;
}
FN(scroll) { UNUSED; if (ui) cui_input_scroll(ui, (float)num(c, argv[0]), (float)num(c, argv[1])); return JS_UNDEFINED; }

/* Every node of the latest layout with text: [text, x, y, w, h, depth]. */
FN(nodes) {
    UNUSED; (void)argv;
    JSValue arr = JS_NewArray(c);
    if (!ui) return arr;
    uint32_t k = 0;
    for (int i = 0; i < ui->node_count; i++) {
        cui_node *n = &ui->nodes[i];
        if (!n->text || n->text_len <= 0) continue;
        JSValue e = JS_NewArray(c);
        /* what is drawn: a "Label###key" that shows its key is a bug the tests should see */
        JS_SetPropertyUint32(c, e, 0, JS_NewStringLen(c, n->text, (size_t)n->text_len));
        JS_SetPropertyUint32(c, e, 1, JS_NewFloat64(c, n->rect.x));
        JS_SetPropertyUint32(c, e, 2, JS_NewFloat64(c, n->rect.y));
        JS_SetPropertyUint32(c, e, 3, JS_NewFloat64(c, n->rect.w));
        JS_SetPropertyUint32(c, e, 4, JS_NewFloat64(c, n->rect.h));
        JS_SetPropertyUint32(c, arr, k++, e);
    }
    return arr;
}

/* The rectangle of the box or component with id `key` (as written in markup). */
FN(rect) {
    UNUSED;
    const char *s = JS_ToCString(c, argv[0]);
    JSValue out = JS_NULL;
    if (ui && s) {
        cui_id id = cuisv_named(s);
        if (!id) id = cui_make_id(ui, s);
        cui_rect r = cui_get_rect(ui, id);
        if (r.w > 0 || r.h > 0) {
            out = JS_NewArray(c);
            JS_SetPropertyUint32(c, out, 0, JS_NewFloat64(c, r.x));
            JS_SetPropertyUint32(c, out, 1, JS_NewFloat64(c, r.y));
            JS_SetPropertyUint32(c, out, 2, JS_NewFloat64(c, r.w));
            JS_SetPropertyUint32(c, out, 3, JS_NewFloat64(c, r.h));
        }
    }
    if (s) JS_FreeCString(c, s);
    return out;
}

FN(png) {
    UNUSED;
    if (!ui) return JS_FALSE;
    NOT_IN_FRAME("test_png");
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_EXCEPTION;
    double want = argc > 1 ? num(c, argv[1]) : 1;
    int scale = want >= 1 ? (want < 8 ? (int)want : 8) : 1;
    if (scale != 1) {
        cui_set_viewport(ui, (float)view_w, (float)view_h, (float)scale);
        one_frame();
    }
    int w = view_w * scale, h = view_h * scale;
    uint8_t *px = malloc((size_t)w * (size_t)h * 4);
    bool ok = false;
    if (px) {
        cui_sw_render(sw, cui_get_draw_data(ui), px, w, h, w * 4, CUI_SW_RGBA);
        ok = cui_write_png(path, px, w, h, w * 4);
    }
    free(px);
    if (scale != 1) {
        cui_set_viewport(ui, (float)view_w, (float)view_h, 1);
        one_frame();
    }
    JS_FreeCString(c, path);
    return JS_NewBool(c, ok);
}

FN(exit) { UNUSED; exit_code = argc > 0 ? (int)num(c, argv[0]) : 0; return JS_UNDEFINED; }
FN(noop) { UNUSED; (void)c; (void)argv; return JS_UNDEFINED; }

static void sleep_ms(double ms) {
    if (ms <= 0) return;
#if defined(_WIN32)
    Sleep((DWORD)ms);
#else
    struct timespec ts = { (time_t)(ms / 1000), (long)((ms - (time_t)(ms / 1000) * 1000) * 1e6) };
    nanosleep(&ts, NULL);
#endif
}
FN(clipboard) { UNUSED; (void)argv; return JS_NewString(c, clipboard); }

static void setup_test(JSContext *c, JSValue bridge) {
    static const JSCFunctionListEntry funcs[] = {
        JS_CFUNC_DEF("app", 1, cuisvt_app),
        JS_CFUNC_DEF("test_frame", 1, cuisvt_frame),
        JS_CFUNC_DEF("test_move", 2, cuisvt_move),
        JS_CFUNC_DEF("test_button", 2, cuisvt_button),
        JS_CFUNC_DEF("test_key", 3, cuisvt_key),
        JS_CFUNC_DEF("test_text", 1, cuisvt_text),
        JS_CFUNC_DEF("test_scroll", 2, cuisvt_scroll),
        JS_CFUNC_DEF("test_nodes", 0, cuisvt_nodes),
        JS_CFUNC_DEF("test_rect", 1, cuisvt_rect),
        JS_CFUNC_DEF("test_png", 2, cuisvt_png),
        JS_CFUNC_DEF("test_exit", 1, cuisvt_exit),
        JS_CFUNC_DEF("test_clipboard", 0, cuisvt_clipboard),
    };
    JS_SetPropertyFunctionList(c, bridge, funcs, (int)(sizeof funcs / sizeof funcs[0]));
    JS_SetPropertyStr(c, bridge, "redraw", JS_NewCFunction(c, cuisvt_noop, "redraw", 0));
    JS_SetPropertyStr(c, bridge, "quit", JS_NewCFunction(c, cuisvt_noop, "quit", 0));
    JS_SetPropertyStr(c, bridge, "headless", JS_TRUE);
}

int main(int argc, char **argv) {
    cuisv_set_args(argc, argv);
    cuisv_runtime_init();
    cuisv_app_setup();
    cuisv_js_on_setup(setup_test);
    if (!cuisv_js_init()) { cuisv_log("fatal", "cannot start QuickJS"); return 1; }
    char *file = cuisv_getenv("CUISV_BUNDLE");
    bool ok = cuisv_host_load(file && *file ? file : NULL);
    free(file);
    /* async tests: keep running timers until the script reports or nothing is left */
    double deadline = cuisv_now_ms() + 60000;
    const char *t = getenv("CUISV_TEST_TIMEOUT");
    if (t) deadline = cuisv_now_ms() + atof(t) * 1000;
    while (ok && exit_code < 0) {
        double next = cuisv_js_next_timer();
        if (next < 0) break;
        if (cuisv_now_ms() > deadline) {
            cuisv_log("error", "test timed out");
            exit_code = 1;
            break;
        }
        sleep_ms(next * 1000);
        cuisv_js_tick();
    }
    cuisv_host_shutdown();
    if (ui) cui_destroy(ui);
    if (sw) cui_sw_destroy(sw);
    if (!ok) return 1;
    return exit_code < 0 ? 0 : exit_code;
}
