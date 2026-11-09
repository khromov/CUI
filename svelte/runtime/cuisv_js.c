/* QuickJS host: the __cuisv bridge, timers, microtasks and the C -> JS hooks. */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE 1
#elif !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#  define _POSIX_C_SOURCE 200809L
#endif
#include "cuisv_js.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <time.h>
#endif

static JSRuntime *rt;
static JSContext *ctx;
static JSValue bridge;
static bool frame_wanted;

#define MAX_SETUP 16
static cuisv_js_setup_fn setup_fns[MAX_SETUP];
static int setup_count;

double cuisv_now_ms(void) {
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

JSContext *cuisv_js_ctx(void) { return ctx; }

/* ---- errors ------------------------------------------------------------------------- */

static void print_value(JSContext *c, JSValueConst v) {
    const char *s = JS_ToCString(c, v);
    fprintf(stderr, "%s\n", s ? s : "<unprintable>");
    if (s) JS_FreeCString(c, s);
    if (JS_IsError(v)) {
        JSValue stack = JS_GetPropertyStr(c, v, "stack");
        if (!JS_IsUndefined(stack)) {
            const char *st = JS_ToCString(c, stack);
            if (st && *st) fprintf(stderr, "%s", st);
            if (st) JS_FreeCString(c, st);
        }
        JS_FreeValue(c, stack);
    }
}

void cuisv_js_report(JSContext *c, const char *where) {
    JSValue e = JS_GetException(c);
    fprintf(stderr, "[cui-svelte] error in %s: ", where);
    print_value(c, e);
    JS_FreeValue(c, e);
}

static void run_jobs(void) {
    JSContext *c;
    for (;;) {
        int r = JS_ExecutePendingJob(rt, &c);
        if (r == 0) break;
        if (r < 0) cuisv_js_report(c, "a microtask");
    }
}

static void rejection_tracker(JSContext *c, JSValueConst promise, JSValueConst reason, bool is_handled, void *opaque) {
    (void)promise; (void)opaque;
    if (is_handled) return;
    fprintf(stderr, "[cui-svelte] unhandled promise rejection: ");
    print_value(c, reason);
}

/* ---- argument helpers ------------------------------------------------------------------- */

/* Handles and slot numbers come from the renderer: what does not convert is 0 (no scope),
 * with the exception dropped rather than left pending for a later call to find. */
static void drop_exception(void) {
    if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));
}
static uint32_t arg_u32(JSValueConst v) {
    double d = 0;
    if (JS_ToFloat64(ctx, &d, v) < 0) drop_exception();
    return d >= 0 && d <= 4294967295.0 ? (uint32_t)d : 0;
}
static int arg_int(JSValueConst v) {
    int32_t i = 0;
    if (JS_ToInt32(ctx, &i, v) < 0) drop_exception();
    return i;
}
static cuisv_scope *arg_scope(JSValueConst v) { return cuisv_scope_get(arg_u32(v)); }

#define FN(name) static JSValue cuisvb_##name(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv)
#define UNUSED (void)this_val; (void)argc

/* ---- scopes --------------------------------------------------------------------------------- */

FN(root) { UNUSED; (void)argv; return JS_NewFloat64(c, (double)cuisv_root()->handle); }

FN(scope) {
    UNUSED;
    cuisv_scope *s = cuisv_scope_new(arg_u32(argv[0]));
    return JS_NewFloat64(c, s ? (double)s->handle : 0);
}

FN(free) { UNUSED; (void)c; cuisv_scope_free(arg_scope(argv[0])); return JS_UNDEFINED; }

FN(insert) {
    UNUSED; (void)c;
    cuisv_scope *parent = arg_scope(argv[0]);
    cuisv_scope *child = arg_scope(argv[2]);
    cuisv_scope *before = argc > 3 ? arg_scope(argv[3]) : NULL;
    cuisv_insert(parent, arg_int(argv[1]), child, before);
    return JS_UNDEFINED;
}

FN(detach) { UNUSED; (void)c; cuisv_detach(arg_scope(argv[0])); return JS_UNDEFINED; }

/* ---- slots ------------------------------------------------------------------------------------ */

FN(num) {
    UNUSED;
    double d = 0;
    if (JS_ToFloat64(c, &d, argv[2]) < 0) return JS_EXCEPTION;   /* a valueOf that threw */
    cuisv_set_num(arg_scope(argv[0]), arg_int(argv[1]), d);
    return JS_UNDEFINED;
}

FN(bool) {
    UNUSED;
    cuisv_set_bool(arg_scope(argv[0]), arg_int(argv[1]), JS_ToBool(c, argv[2]) > 0);
    return JS_UNDEFINED;
}

FN(str) {
    UNUSED;
    size_t len = 0;
    const char *s = JS_ToCStringLen(c, &len, argv[2]);
    if (!s) return JS_EXCEPTION;
    cuisv_set_str(arg_scope(argv[0]), arg_int(argv[1]), s, len);
    JS_FreeCString(c, s);
    return JS_UNDEFINED;
}

FN(unset) { UNUSED; (void)c; cuisv_slot_unset(arg_scope(argv[0]), arg_int(argv[1])); return JS_UNDEFINED; }

FN(fn) {
    UNUSED;
    cuisv_slot_fn(arg_scope(argv[0]), arg_int(argv[1]), JS_ToBool(c, argv[2]) > 0);
    return JS_UNDEFINED;
}

FN(strs) {
    UNUSED;
    int64_t n = 0;
    if (JS_GetLength(c, argv[2], &n) < 0) return JS_EXCEPTION;
    if (n < 0) n = 0;
    size_t cap = (size_t)(n ? n : 1);
    const char **items = calloc(cap, sizeof *items);
    const char **owned = calloc(cap, sizeof *owned);   /* what QuickJS allocated, to free */
    size_t *lens = calloc(cap, sizeof *lens);
    if (!items || !owned || !lens) { free(items); free((void *)owned); free(lens); return JS_ThrowOutOfMemory(c); }
    int ok = 1;
    for (int64_t k = 0; k < n; k++) {
        JSValue v = JS_GetPropertyUint32(c, argv[2], (uint32_t)k);
        if (!JS_IsUndefined(v) && !JS_IsNull(v)) owned[k] = JS_ToCStringLen(c, &lens[k], v);
        if (owned[k]) items[k] = owned[k];
        else { items[k] = ""; lens[k] = 0; if (JS_HasException(c)) ok = 0; }
        JS_FreeValue(c, v);
    }
    if (ok) cuisv_slot_strs(arg_scope(argv[0]), arg_int(argv[1]), items, lens, (int)n);
    for (int64_t k = 0; k < n; k++) if (owned[k]) JS_FreeCString(c, owned[k]);
    free(items);
    free((void *)owned);
    free(lens);
    return ok ? JS_UNDEFINED : JS_EXCEPTION;
}

FN(floats) {
    UNUSED;
    cuisv_scope *s = arg_scope(argv[0]);
    int slot = arg_int(argv[1]);
    if (JS_GetTypedArrayType(argv[2]) == JS_TYPED_ARRAY_FLOAT32) {
        size_t off = 0, len = 0, per = 0;
        JSValue buf = JS_GetTypedArrayBuffer(c, argv[2], &off, &len, &per);
        size_t size = 0;
        uint8_t *p = JS_GetArrayBuffer(c, &size, buf);
        if (p) cuisv_slot_floats(s, slot, (const float *)(p + off), (int)(len / sizeof(float)));
        JS_FreeValue(c, buf);
        return JS_UNDEFINED;
    }
    int64_t n = 0;
    if (JS_GetLength(c, argv[2], &n) < 0) return JS_EXCEPTION;
    if (n > 64 * 1024 * 1024) return JS_ThrowRangeError(c, "too many numbers");
    float *vals = malloc(sizeof(float) * (size_t)(n > 0 ? n : 1));
    if (!vals) return JS_ThrowOutOfMemory(c);
    for (int64_t k = 0; k < n; k++) {
        JSValue v = JS_GetPropertyUint32(c, argv[2], (uint32_t)k);
        double d = 0;
        int bad = JS_ToFloat64(c, &d, v) < 0;
        JS_FreeValue(c, v);
        if (bad) { free(vals); return JS_EXCEPTION; }
        vals[k] = (float)d;
    }
    cuisv_slot_floats(s, slot, vals, (int)(n > 0 ? n : 0));
    free(vals);
    return JS_UNDEFINED;
}

FN(blob) {
    UNUSED;
    size_t size = 0;
    uint8_t *p = NULL;
    JSValue held = JS_UNDEFINED;
    if (JS_GetTypedArrayType(argv[2]) >= 0) {
        size_t off = 0, len = 0, per = 0;
        held = JS_GetTypedArrayBuffer(c, argv[2], &off, &len, &per);
        size_t total = 0;
        uint8_t *base = JS_GetArrayBuffer(c, &total, held);
        if (base) { p = base + off; size = len; }
    } else {
        p = JS_GetArrayBuffer(c, &size, argv[2]);
        if (!p) JS_FreeValue(c, JS_GetException(c));   /* not a buffer: nothing to set */
    }
    if (p) cuisv_slot_blob(arg_scope(argv[0]), arg_int(argv[1]), p, (uint32_t)size);
    JS_FreeValue(c, held);
    return JS_UNDEFINED;
}

/* ---- timers --------------------------------------------------------------------------------- */

typedef struct js_timer { uint32_t id; double due, interval; JSValue fn; bool repeat; } js_timer;
static js_timer *timers;
static int timer_count, timer_cap;
static uint32_t next_timer_id = 1;

FN(timeout) {
    UNUSED;
    if (!JS_IsFunction(c, argv[0])) return JS_ThrowTypeError(c, "timer callback is not a function");
    double ms = 0;
    if (JS_ToFloat64(c, &ms, argv[1]) < 0) return JS_EXCEPTION;
    if (!(ms >= 0)) ms = 0;
    if (ms > 2147483647.0) ms = 2147483647.0;   /* setTimeout(fn, Infinity): about 25 days */
    if (timer_count == timer_cap) {
        int cap = timer_cap ? timer_cap * 2 : 16;
        js_timer *grown = realloc(timers, sizeof *timers * (size_t)cap);
        if (!grown) return JS_ThrowOutOfMemory(c);
        timers = grown;
        timer_cap = cap;
    }
    js_timer *t = &timers[timer_count++];
    t->id = next_timer_id++;
    t->interval = ms;
    t->due = cuisv_now_ms() + ms;
    t->repeat = argc > 2 && JS_ToBool(c, argv[2]) > 0;
    t->fn = JS_DupValue(c, argv[0]);
    return JS_NewFloat64(c, t->id);
}

static void timer_remove_at(int i) {
    JS_FreeValue(ctx, timers[i].fn);
    timers[i] = timers[--timer_count];
}

FN(clear) {
    UNUSED; (void)c;
    uint32_t id = arg_u32(argv[0]);
    for (int i = 0; i < timer_count; i++)
        if (timers[i].id == id) { timer_remove_at(i); break; }
    return JS_UNDEFINED;
}

static void run_timers(void) {
    if (!timer_count) return;
    double now = cuisv_now_ms();
    /* collect the due ids first: callbacks add and clear timers */
    uint32_t due_ids[256];
    int n = 0;
    for (int i = 0; i < timer_count && n < 256; i++)
        if (timers[i].due <= now) due_ids[n++] = timers[i].id;
    for (int k = 0; k < n; k++) {
        int i;
        for (i = 0; i < timer_count; i++) if (timers[i].id == due_ids[k]) break;
        if (i == timer_count) continue;
        JSValue fn = JS_DupValue(ctx, timers[i].fn);
        if (timers[i].repeat) {
            timers[i].due += timers[i].interval > 1 ? timers[i].interval : 1;
            if (timers[i].due < now) timers[i].due = now + (timers[i].interval > 1 ? timers[i].interval : 1);
        } else {
            timer_remove_at(i);
        }
        JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 0, NULL);
        if (JS_IsException(r)) cuisv_js_report(ctx, "a timer");
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, fn);
        run_jobs();
    }
}

double cuisv_js_next_timer(void) {
    if (!timer_count) return -1;
    double soonest = timers[0].due;
    for (int i = 1; i < timer_count; i++) if (timers[i].due < soonest) soonest = timers[i].due;
    double d = (soonest - cuisv_now_ms()) / 1000.0;
    return d < 0 ? 0 : d;
}

/* ---- misc ---------------------------------------------------------------------------------------- */

FN(want_frame) { UNUSED; (void)c; (void)argv; frame_wanted = true; return JS_UNDEFINED; }

FN(want_keys) { UNUSED; cuisv_want_keys(JS_ToBool(c, argv[0]) > 0); return JS_UNDEFINED; }

FN(print) {
    UNUSED;
    int level = arg_int(argv[0]);
    const char *s = JS_ToCString(c, argv[1]);
    if (!s) return JS_EXCEPTION;
    FILE *out = level >= 2 ? stderr : stdout;
    fputs(s, out);
    fputc('\n', out);
    fflush(out);
    JS_FreeCString(c, s);
    return JS_UNDEFINED;
}

FN(now) { UNUSED; (void)argv; return JS_NewFloat64(c, cuisv_now_ms()); }

/* ---- hooks ------------------------------------------------------------------------------------------- */

JSValue cuisv_js_hook(const char *name, int argc, JSValueConst *argv) {
    if (!ctx) return JS_UNDEFINED;
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue hooks = JS_GetPropertyStr(ctx, global, "__cuisv_hooks");
    JSValue fn = JS_IsUndefined(hooks) ? JS_UNDEFINED : JS_GetPropertyStr(ctx, hooks, name);
    JSValue r = JS_UNDEFINED;
    if (JS_IsFunction(ctx, fn)) {
        r = JS_Call(ctx, fn, hooks, argc, argv);
        if (JS_IsException(r)) {
            char where[96];
            snprintf(where, sizeof where, "the %s hook", name);
            cuisv_js_report(ctx, where);
            r = JS_UNDEFINED;
        }
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, hooks);
    JS_FreeValue(ctx, global);
    return r;
}

static void commit(void) {
    run_jobs();
    JS_FreeValue(ctx, cuisv_js_hook("commit", 0, NULL));
    run_jobs();
}

/* After a hook outside the usual turns (resize, a toast action): flush what it changed. */
void cuisv_js_settle(void) {
    if (ctx) commit();
}

void cuisv_js_tick(void) {
    if (!ctx) return;
    run_timers();
    commit();
}

bool cuisv_js_wants_frame(void) { return frame_wanted; }

/* <Canvas onpaint>: CUI paints at the end of the frame; JS draws through the draw natives. */
void cuisv_js_paint(uint32_t handle, int slot, cui_rect r) {
    if (!ctx) return;
    JSValue args[6] = {
        JS_NewFloat64(ctx, handle), JS_NewInt32(ctx, slot),
        JS_NewFloat64(ctx, r.x), JS_NewFloat64(ctx, r.y), JS_NewFloat64(ctx, r.w), JS_NewFloat64(ctx, r.h)
    };
    JS_FreeValue(ctx, cuisv_js_hook("paint", 6, args));
}

void cuisv_js_run_frame(double time_ms) {
    if (!ctx || !frame_wanted) return;
    frame_wanted = false;
    JSValue t = JS_NewFloat64(ctx, time_ms);
    JS_FreeValue(ctx, cuisv_js_hook("frame", 1, &t));
    commit();
}

int cuisv_js_dispatch_events(void) {
    int n = cuisv_event_count();
    if (!ctx || !n) { cuisv_events_clear(); return 0; }
    cuisv_event *ev = cuisv_events();
    for (int i = 0; i < n; i++) {
        JSValue args[4];
        args[0] = JS_NewFloat64(ctx, (double)ev[i].handle);
        args[1] = JS_NewInt32(ctx, ev[i].slot);
        int argc = 2;
        switch (ev[i].kind) {
        case CUISV_EV_NUM: args[argc++] = JS_NewFloat64(ctx, ev[i].a); break;
        case CUISV_EV_BOOL: args[argc++] = JS_NewBool(ctx, ev[i].a != 0); break;
        case CUISV_EV_STR: args[argc++] = JS_NewString(ctx, ev[i].str ? ev[i].str : ""); break;
        case CUISV_EV_NUM2:
            args[argc++] = JS_NewFloat64(ctx, ev[i].a);
            args[argc++] = JS_NewFloat64(ctx, ev[i].b);
            break;
        case CUISV_EV_BYTES:
            args[argc++] = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)ev[i].str, ev[i].len);
            break;
        default: break;
        }
        JS_FreeValue(ctx, cuisv_js_hook("dispatch", argc, args));
        for (int k = 0; k < argc; k++) JS_FreeValue(ctx, args[k]);
        run_jobs();
    }
    cuisv_events_clear();
    commit();
    return n;
}

/* ---- setup ------------------------------------------------------------------------------------------ */

static const JSCFunctionListEntry bridge_funcs[] = {
    JS_CFUNC_DEF("root", 0, cuisvb_root),
    JS_CFUNC_DEF("scope", 1, cuisvb_scope),
    JS_CFUNC_DEF("free", 1, cuisvb_free),
    JS_CFUNC_DEF("insert", 4, cuisvb_insert),
    JS_CFUNC_DEF("detach", 1, cuisvb_detach),
    JS_CFUNC_DEF("num", 3, cuisvb_num),
    JS_CFUNC_DEF("bool", 3, cuisvb_bool),
    JS_CFUNC_DEF("str", 3, cuisvb_str),
    JS_CFUNC_DEF("unset", 2, cuisvb_unset),
    JS_CFUNC_DEF("fn", 3, cuisvb_fn),
    JS_CFUNC_DEF("strs", 3, cuisvb_strs),
    JS_CFUNC_DEF("floats", 3, cuisvb_floats),
    JS_CFUNC_DEF("blob", 3, cuisvb_blob),
    JS_CFUNC_DEF("timeout", 3, cuisvb_timeout),
    JS_CFUNC_DEF("clear", 1, cuisvb_clear),
    JS_CFUNC_DEF("want_frame", 0, cuisvb_want_frame),
    JS_CFUNC_DEF("want_keys", 1, cuisvb_want_keys),
    JS_CFUNC_DEF("print", 2, cuisvb_print),
    JS_CFUNC_DEF("now", 0, cuisvb_now),
};

void cuisv_js_on_setup(cuisv_js_setup_fn fn) {
    if (setup_count < MAX_SETUP) setup_fns[setup_count++] = fn;
}

void cuisv_js_register(const char *name, JSCFunction *fn, int length) {
    JS_SetPropertyStr(ctx, bridge, name, JS_NewCFunction(ctx, fn, name, length));
}

bool cuisv_js_init(void) {
    rt = JS_NewRuntime();
    if (!rt) return false;
    JS_SetHostPromiseRejectionTracker(rt, rejection_tracker, NULL);
    ctx = JS_NewContext(rt);
    if (!ctx) return false;
    bridge = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, bridge, bridge_funcs, (int)(sizeof bridge_funcs / sizeof bridge_funcs[0]));
    for (int i = 0; i < setup_count; i++) setup_fns[i](ctx, bridge);
    JSValue natives = JS_NewObject(ctx);
    for (int t = 0; t < cuisv_native_table_count; t++) {
        const cuisv_native *tab = cuisv_native_tables[t];
        for (int i = 0; i < *cuisv_native_table_counts[t]; i++)
            JS_SetPropertyStr(ctx, natives, tab[i].name, JS_NewCFunction(ctx, (JSCFunction *)tab[i].fn, tab[i].name, tab[i].length));
    }
    JS_SetPropertyStr(ctx, bridge, "natives", natives);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__cuisv", JS_DupValue(ctx, bridge));
    JS_FreeValue(ctx, global);
    frame_wanted = false;
    return true;
}

void cuisv_js_shutdown(void) {
    if (!ctx) return;
    /* jobs can start timers and timers hold functions: empty both until both stay empty */
    for (int round = 0; round < 64; round++) {
        while (timer_count) timer_remove_at(timer_count - 1);
        run_jobs();
        if (!timer_count && !JS_IsJobPending(rt)) break;
    }
    JS_FreeValue(ctx, bridge);
    bridge = JS_UNDEFINED;
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    ctx = NULL;
    rt = NULL;
}

static bool settle(JSValue v, const char *name) {
    if (JS_IsException(v)) {
        cuisv_js_report(ctx, name);
        return false;
    }
    run_jobs();
    bool ok = true;
    if (JS_IsPromise(v)) {
        JSPromiseStateEnum st = JS_PromiseState(ctx, v);
        if (st == JS_PROMISE_REJECTED) {
            JSValue reason = JS_PromiseResult(ctx, v);
            fprintf(stderr, "[cui-svelte] error in %s: ", name);
            print_value(ctx, reason);
            JS_FreeValue(ctx, reason);
            ok = false;
        }
    }
    JS_FreeValue(ctx, v);
    commit();
    return ok;
}

bool cuisv_js_run_bundle(const uint8_t *data, size_t len, bool bytecode, const char *name) {
    if (!bytecode) {
        /* JS_Eval wants a NUL at data[len] */
        char *src = malloc(len + 1);
        memcpy(src, data, len);
        src[len] = 0;
        JSValue v = JS_Eval(ctx, src, len, name, JS_EVAL_TYPE_MODULE);
        free(src);
        return settle(v, name);
    }
    JSValue obj = JS_ReadObject(ctx, data, len, JS_READ_OBJ_BYTECODE);
    if (JS_IsException(obj)) { cuisv_js_report(ctx, name); return false; }
    if (JS_VALUE_GET_TAG(obj) == JS_TAG_MODULE && JS_ResolveModule(ctx, obj) < 0) {
        cuisv_js_report(ctx, name);
        JS_FreeValue(ctx, obj);
        return false;
    }
    return settle(JS_EvalFunction(ctx, obj), name);
}
