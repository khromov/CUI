/* The QuickJS side of the runtime: one runtime and context, the __cuisv bridge object the
 * JS renderer talks to, timers, and the hooks C calls back into (events, frames). */
#ifndef CUISV_JS_H
#define CUISV_JS_H

#include "cuisv_internal.h"
#include "quickjs.h"

bool cuisv_js_init(void);
void cuisv_js_shutdown(void);
JSContext *cuisv_js_ctx(void);

/* Adds a native function to the __cuisv bridge object (before the bundle runs). */
void cuisv_js_register(const char *name, JSCFunction *fn, int length);
/* Lets a host add its natives; runs on every (re)initialisation of the context. */
typedef void (*cuisv_js_setup_fn)(JSContext *ctx, JSValue bridge);
void cuisv_js_on_setup(cuisv_js_setup_fn fn);

/* Evaluates the app bundle: JS source, or QuickJS bytecode when `bytecode` is set. */
bool cuisv_js_run_bundle(const uint8_t *data, size_t len, bool bytecode, const char *name);

/* One turn of the JS event loop: due timers, microtasks, then the renderer's commit. */
void cuisv_js_tick(void);
void cuisv_js_settle(void);
/* Hands the frame's events to JS. Returns how many were dispatched. */
int cuisv_js_dispatch_events(void);
/* requestAnimationFrame callbacks are pending: run them before building the next frame. */
bool cuisv_js_wants_frame(void);
void cuisv_js_run_frame(double time_ms);
/* Seconds until the next timer, or -1 for none. */
double cuisv_js_next_timer(void);

/* Prints a pending exception with its stack. */
void cuisv_js_report(JSContext *ctx, const char *where);
/* Calls a hook on globalThis.__cuisv_hooks if the JS runtime installed it. */
JSValue cuisv_js_hook(const char *name, int argc, JSValueConst *argv);

double cuisv_now_ms(void);
void cuisv_js_paint(uint32_t handle, int slot, cui_rect r);

#endif
