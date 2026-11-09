/* The frame and bundle logic both hosts share. */
#include "cuisv_host.h"
#include "cuisv_app.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern const unsigned char cuisv_bundle[];
extern const size_t cuisv_bundle_size;
extern const int cuisv_bundle_bytecode;

bool cuisv_host_frame(cui_ctx *ui) {
    /* Events from the previous frame go to JS first: CUI has painted that frame by now, so
     * what JS changes (and frees) is no longer referenced by its nodes. */
    bool changed = cuisv_js_dispatch_events() > 0;
    cuisv_js_tick();
    if (cuisv_js_wants_frame()) {
        cuisv_js_run_frame(cui_time(ui) * 1000.0);
        changed = true;
    }
    if (cuisv_app_frame(ui)) changed = true;
    cuisv_frame_reset();
    cuisv_render_scope(ui, cuisv_root());
    cuisv_collect_keys(ui);
    cuisv_collect_scrolls(ui);
    /* events this frame: the next frame dispatches them, so ask for it now */
    if (cuisv_event_count() > 0) changed = true;
    if (cuisv_js_wants_frame()) changed = true;
    return changed;
}

bool cuisv_host_load(const char *file) {
    if (file) {
        size_t len = 0;
        uint8_t *src = cuisv_read_file(file, &len);
        if (!src) {
            cuisv_log("error", "cannot read %s", file);
            return false;
        }
        bool ok = cuisv_js_run_bundle(src, len, false, file);
        free(src);
        return ok;
    }
    return cuisv_js_run_bundle(cuisv_bundle, cuisv_bundle_size, cuisv_bundle_bytecode != 0, "app.js");
}

void cuisv_host_reload(const char *file) {
    JS_FreeValue(cuisv_js_ctx(), cuisv_js_hook("teardown", 0, NULL));
    cuisv_js_shutdown();
    cuisv_runtime_shutdown();
    if (!cuisv_js_init()) {
        cuisv_log("fatal", "cannot restart QuickJS");
        exit(1);
    }
    fprintf(stderr, "[cui-svelte] reloaded %s\n", file ? file : "app.js");
    cuisv_host_load(file);
}

void cuisv_host_shutdown(void) {
    if (cuisv_js_ctx()) JS_FreeValue(cuisv_js_ctx(), cuisv_js_hook("teardown", 0, NULL));
    cuisv_js_shutdown();
    cuisv_runtime_shutdown();
}
