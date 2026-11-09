/* main() of a cui-svelte app: QuickJS runs the bundle, whose run(App, options) opens the
 * window; then the frame loop alternates JS turns with C templates building the frame. */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE 1
#elif !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#  define _POSIX_C_SOURCE 200809L
#endif
#include "cuisv_host.h"
#include "cuisv_app.h"

#include <cui/cui_app.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static cui_app *app;
static bool redraw_wanted;

cui_app *cuisv_app(void) { return app; }
cui_ctx *cuisv_ui(void) { return app ? cui_app_ui(app) : NULL; }
void cuisv_request_redraw(void) { redraw_wanted = true; }

static JSValue js_app(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    JSValueConst o = argc > 0 ? argv[0] : JS_UNDEFINED;
    cuisv_window_opts w;
    cuisv_window_opts_read(c, o, &w);
    if (app) {
        /* a hot reload runs run() again: keep the window, apply what can change */
        if (w.title) cui_app_set_title(app, w.title);
    } else {
        cui_app_desc d;
        memset(&d, 0, sizeof d);
        d.title = w.title ? w.title : "CUI";
        d.width = w.width;
        d.height = w.height;
        d.min_width = w.min_width;
        d.min_height = w.min_height;
        d.fixed_size = w.fixed_size;
        d.continuous = w.continuous;
        d.hidden = w.hidden;
        d.renderer = (cui_renderer_kind)w.renderer;
        d.theme = w.theme == 1 ? CUI_THEME_DARK : CUI_THEME_LIGHT;
        d.follow_system_theme = w.theme == 2;
        if (w.accent >= 0) d.accent = (cui_accent)w.accent;
        app = cui_app_create(&d);
        if (!app) {
            cuisv_window_opts_free(&w);
            return JS_ThrowPlainError(c, "could not open a window");
        }
        cuisv_apply_startup(cui_app_ui(app), &w);
    }
    cuisv_window_opts_free(&w);
    return JS_TRUE;
}

static JSValue js_redraw(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)c; (void)this_val; (void)argc; (void)argv;
    redraw_wanted = true;
    return JS_UNDEFINED;
}

static JSValue js_quit(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)c; (void)this_val; (void)argc; (void)argv;
    if (app) cui_app_quit(app);
    return JS_UNDEFINED;
}

static void setup_main(JSContext *c, JSValue bridge) {
    JS_SetPropertyStr(c, bridge, "app", JS_NewCFunction(c, js_app, "app", 1));
    JS_SetPropertyStr(c, bridge, "redraw", JS_NewCFunction(c, js_redraw, "redraw", 0));
    JS_SetPropertyStr(c, bridge, "quit", JS_NewCFunction(c, js_quit, "quit", 0));
}

static long long file_mtime(const char *path) {
    cuisv_file_info fi;
    return cuisv_stat(path, &fi) ? fi.mtime_ns : -1;
}

int main(int argc, char **argv) {
    cuisv_set_args(argc, argv);
    /* CUISV_BUNDLE: a bundle file to run (and watch) instead of the embedded one (dev) */
    char *dev_bundle = cuisv_getenv("CUISV_BUNDLE");
    if (dev_bundle && !*dev_bundle) { free(dev_bundle); dev_bundle = NULL; }
    long long dev_mtime = dev_bundle ? file_mtime(dev_bundle) : 0;

    cuisv_runtime_init();
    cuisv_js_on_setup(setup_main);
    cuisv_app_setup();
    if (!cuisv_js_init()) { cuisv_log("fatal", "cannot start QuickJS"); return 1; }
    if (!cuisv_host_load(dev_bundle) && !app) return 1;
    if (!app) {
        cuisv_log("error", "the app never called run(App, { ... }), so there is no window");
        return 1;
    }

    double last_check = 0;
    while (cui_app_frame(app)) {
        cui_ctx *ui = cui_app_ui(app);
        if (dev_bundle) {
            double now = cuisv_now_ms();
            if (now - last_check > 150) {
                last_check = now;
                long long m = file_mtime(dev_bundle);
                if (m >= 0 && m != dev_mtime) {
                    dev_mtime = m;
                    cuisv_host_reload(dev_bundle);
                    redraw_wanted = true;
                }
            }
            cui_request_wakeup(ui, 0.2f);
        }
        if (cuisv_host_frame(ui)) redraw_wanted = true;
        if (redraw_wanted) {
            cui_request_redraw(ui);
            redraw_wanted = false;
        }
        double next = cuisv_js_next_timer();
        if (next >= 0) cui_request_wakeup(ui, (float)next);
    }
    cuisv_host_shutdown();
    cui_app_destroy(app);
    free(dev_bundle);
    return 0;
}
