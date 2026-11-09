/*
 * cui-svelte runtime: the C half of a Svelte app.
 *
 * Every .svelte component compiles to C render functions ("templates") that call CUI
 * directly, every frame. The component's <script> runs in QuickJS; whatever the markup
 * reads from it reaches C as slot values on a scope:
 *
 *   scope      one live instance of a template: a component root, an {#if} branch, an
 *              {#each} item, a snippet render. JS creates and orders them.
 *   slot       a dynamic value of a scope (a label, a number, a list), set from JS when the
 *              value changes. Templates read slots; they never call into JS.
 *   site       a place in a template where child scopes render (a block, a child
 *              component, {@render}). A site is an ordered list of scopes.
 *   event      what CUI reported (a click, a new value), queued during the frame and handed
 *              to JS after it.
 *
 * Generated code includes this header only.
 */
#ifndef CUISV_H
#define CUISV_H

#include <cui/cui.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct cuisv_scope cuisv_scope;
typedef void (*cuisv_render_fn)(cui_ctx *ui, cuisv_scope *s);

typedef struct cuisv_template {
    uint32_t id;               /* fnv1a32 of "<component path>#<index>", shared with the JS skeleton */
    const char *name;          /* for messages: "src/App.svelte#2" */
    cuisv_render_fn render;
    uint16_t slot_count;
    uint16_t site_count;
} cuisv_template;

typedef enum cuisv_kind {
    CUISV_UNSET = 0,
    CUISV_NUM,
    CUISV_STR,
    CUISV_BOOL,
    CUISV_STRS,                /* array of strings (items, labels) */
    CUISV_FLOATS,              /* array of numbers (chart values) */
    CUISV_BLOB,                /* packed records, unpacked by a generated reader */
    CUISV_FN                   /* a JS function is set; JS keeps the function itself */
} cuisv_kind;

typedef struct cuisv_value {
    uint8_t kind;
    uint32_t version;          /* bumped on every write, so templates can cache derived data */
    union {
        double num;
        bool b;
        struct { char *p; uint32_t len, cap; } str;
        struct { const char **items; char *pool; int count; } strs;
        struct { float *p; int count; } floats;
        struct { uint8_t *p; uint32_t len; void *cache; int cache_count; void (*cache_free)(void *); uint32_t cache_version; } blob;
    } u;
} cuisv_value;

typedef struct cuisv_site { cuisv_scope *first, *last; } cuisv_site;

struct cuisv_scope {
    uint32_t handle;
    const cuisv_template *tpl;
    cuisv_scope *parent;
    int site;                  /* index of the site in parent this scope is inserted into, -1 detached */
    cuisv_scope *prev, *next;
    cuisv_site *sites;
    cuisv_value *slots;
    void *state;               /* per scope C state that templates allocate (cuisv_state) */
    size_t state_size;
};

static inline bool cuisv_dark(cui_ctx *ui) { return cui_get_theme_mode(ui) == CUI_THEME_DARK; }

/* ---- slots: read by templates ------------------------------------------------------ */

static inline cuisv_value *cuisv_slot(cuisv_scope *s, int i) { return &s->slots[i]; }
static inline bool cuisv_has(cuisv_scope *s, int i) { return s->slots[i].kind != CUISV_UNSET; }
static inline double cuisv_num(cuisv_scope *s, int i) {
    cuisv_value *v = &s->slots[i];
    return v->kind == CUISV_NUM ? v->u.num : v->kind == CUISV_BOOL ? (double)v->u.b : 0;
}
static inline float cuisv_float(cuisv_scope *s, int i) { return (float)cuisv_num(s, i); }
/* NaN is 0 and out-of-range values saturate, the same on every CPU ((int) of either is
 * undefined in C). */
static inline int cuisv_to_int(double d) {
    if (!(d == d)) return 0;
    if (d >= 2147483647.0) return 2147483647;
    if (d <= -2147483648.0) return (-2147483647 - 1);
    return (int)d;
}
static inline int cuisv_int(cuisv_scope *s, int i) { return cuisv_to_int(cuisv_num(s, i)); }
static inline bool cuisv_bool(cuisv_scope *s, int i) {
    cuisv_value *v = &s->slots[i];
    if (v->kind == CUISV_BOOL) return v->u.b;
    if (v->kind == CUISV_NUM) return v->u.num != 0;
    if (v->kind == CUISV_STR) return v->u.str.len > 0;
    return v->kind != CUISV_UNSET;
}
/* "" when unset, so a label slot is always safe to pass. */
static inline const char *cuisv_str(cuisv_scope *s, int i) {
    cuisv_value *v = &s->slots[i];
    return v->kind == CUISV_STR ? v->u.str.p : "";
}
/* NULL when unset, for optional strings (placeholder, tooltip, icon). */
static inline const char *cuisv_cstr(cuisv_scope *s, int i) {
    cuisv_value *v = &s->slots[i];
    return v->kind == CUISV_STR ? v->u.str.p : NULL;
}
static inline const char *const *cuisv_strs(cuisv_scope *s, int i, int *count) {
    cuisv_value *v = &s->slots[i];
    if (v->kind != CUISV_STRS) { *count = 0; return NULL; }
    *count = v->u.strs.count;
    return v->u.strs.items;
}
static inline const float *cuisv_floats(cuisv_scope *s, int i, int *count) {
    cuisv_value *v = &s->slots[i];
    if (v->kind != CUISV_FLOATS) { *count = 0; return NULL; }
    *count = v->u.floats.count;
    return v->u.floats.p;
}
/* Colors arrive packed as 0xRRGGBBAA (theme tokens keep CUI's token marker). */
static inline cui_color cuisv_color_u32(uint32_t c) {
    cui_color out = { (uint8_t)(c >> 24), (uint8_t)(c >> 16), (uint8_t)(c >> 8), (uint8_t)c };
    return out;
}
static inline cui_color cuisv_color(cuisv_scope *s, int i, cui_color fallback) {
    double d = cuisv_num(s, i);
    return cuisv_has(s, i) && d >= 0 && d <= 4294967295.0 ? cuisv_color_u32((uint32_t)d) : fallback;
}
/* Sizes arrive as kind * 1e9 + value (cui_size_kind order: fit, grow, fixed, percent). */
static inline cui_size cuisv_size_num(double x) {
    cui_size out;
    if (!(x == x) || x < 0 || x > 4e9) x = 0;
    int kind = (int)(x / 1e9);
    if (kind < 0 || kind > 3) kind = 0;
    out.kind = (cui_size_kind)kind;
    out.value = (float)(x - kind * 1e9);
    return out;
}
static inline cui_size cuisv_size(cuisv_scope *s, int i, cui_size fallback) {
    return cuisv_has(s, i) ? cuisv_size_num(cuisv_num(s, i)) : fallback;
}

/* A text buffer for an editable slot (inputs): at least `reserve` bytes of room past the
 * current text. Returns the buffer and its capacity. When CUI reports that it changed the
 * text, call cuisv_buf_changed: it takes the new length and emits the text to `event_slot`
 * (-1: no event). */
char *cuisv_buf(cuisv_scope *s, int i, size_t reserve, size_t *cap);
void cuisv_buf_changed(cuisv_scope *s, int i, int event_slot);
/* The room to reserve for an editable text this frame: at least `floor`, and enough for what
 * may be inserted at once (a paste, an input method's text). CUI keeps only what fits. */
size_t cuisv_edit_room(cui_ctx *ui, size_t floor);

/* Packed record arrays (BLOB slots) are unpacked by generated readers and cached until the
 * slot changes. `unpack` fills `*out` (heap, freed with `free_fn`) and returns the count. */
typedef int (*cuisv_unpack_fn)(const uint8_t *data, uint32_t len, void **out);
void *cuisv_blob(cuisv_scope *s, int i, cuisv_unpack_fn unpack, void (*free_fn)(void *), int *count);

/* A bool array kept in a slot (raw bytes): `n` entries, missing ones false. Valid this frame. */
bool *cuisv_bools(cuisv_scope *s, int i, int n);
void cuisv_slot_bools(cuisv_scope *s, int i, const bool *values, int n);
void cuisv_slot_floats_set(cuisv_scope *s, int i, const float *values, int n);
/* uint32 masks kept as raw bytes (filter bar selections): `n` entries, missing ones 0. */
uint32_t *cuisv_u32s(cuisv_scope *s, int i, int n);
/* Raw blob bytes of a slot (exposed for generated code). */
void cuisv_slot_blob(cuisv_scope *s, int i, const uint8_t *data, uint32_t len);

/* Small per scope state for templates (e.g. a component that needs a C variable that is not
 * a JS value). Zeroed on first use, freed with the scope. */
void *cuisv_state(cuisv_scope *s, size_t size);

/* Optimistic writes by templates (CUI changed a bound value): the slot holds the new value
 * until JS pushes its own. */
void cuisv_set_num(cuisv_scope *s, int i, double v);
void cuisv_set_bool(cuisv_scope *s, int i, bool v);
void cuisv_set_str(cuisv_scope *s, int i, const char *str, size_t len);

/* ---- records: arrays of C structs packed by JS (cuisv_records.c) ---------------------- */

typedef enum cuisv_field_kind {
    CUISV_F_SKIP = 0, CUISV_F_STR, CUISV_F_BOOL, CUISV_F_I32, CUISV_F_U32, CUISV_F_F32, CUISV_F_F64,
    CUISV_F_I64, CUISV_F_COLOR, CUISV_F_SIZE, CUISV_F_DATE, CUISV_F_TEXTURE, CUISV_F_NAMED_ID,
    CUISV_F_FLOATS, CUISV_F_STRS, CUISV_F_STRUCT, CUISV_F_VEC2S
} cuisv_field_kind;

typedef struct cuisv_struct_desc cuisv_struct_desc;
typedef struct cuisv_field {
    uint8_t kind;
    uint16_t offset;
    int16_t count_offset;      /* FLOATS/STRS: the int field that holds the count, or -1 */
    const cuisv_struct_desc *sub;
} cuisv_field;
struct cuisv_struct_desc { uint16_t size; uint16_t field_count; const cuisv_field *fields; };

typedef struct cuisv_records { void *items; int count; } cuisv_records;

/* The records in a slot, unpacked once per change. CUI may write into the items (gantt
 * tasks being dragged); they stay changed until JS sends new ones. */
const cuisv_records *cuisv_records_get(cuisv_scope *s, int slot, const cuisv_struct_desc *d);
void cuisv_emit_records(cuisv_scope *s, int slot, const cuisv_struct_desc *d, const void *items, int count);
/* Packs records into a slot (CUI grew or edited an array): it holds them until JS answers. */
void cuisv_records_store(cuisv_scope *s, int slot, const cuisv_struct_desc *d, const void *items, int count);
/* A bound struct (a date, a color): read into `out`; write back what CUI changed and emit it. */
void cuisv_record_read(cuisv_scope *s, int slot, const cuisv_struct_desc *d, void *out);
void cuisv_record_write(cuisv_scope *s, int slot, int event_slot, const cuisv_struct_desc *d, const void *value);

/* ---- events: queued during the frame, dispatched to JS after it --------------------- */

void cuisv_emit(cuisv_scope *s, int slot);
void cuisv_emit_num(cuisv_scope *s, int slot, double v);
void cuisv_emit_bool(cuisv_scope *s, int slot, bool v);
void cuisv_emit_str(cuisv_scope *s, int slot, const char *str);
/* Two values (a range, a position): JS receives them as two arguments. */
void cuisv_emit_num2(cuisv_scope *s, int slot, double a, double b);
/* Raw bytes (packed records): JS receives a Uint8Array. */
void cuisv_emit_bytes(cuisv_scope *s, int slot, const void *bytes, uint32_t len);
static inline bool cuisv_has_fn(cuisv_scope *s, int i) { return s->slots[i].kind == CUISV_FN; }
/* After the templates: the keys pressed this frame, as events for on_key() in JS (when JS
 * asked for them with want_keys). */
void cuisv_collect_keys(cui_ctx *ui);
void cuisv_want_keys(bool on);

/* ---- sites --------------------------------------------------------------------------- */

void cuisv_render_scope(cui_ctx *ui, cuisv_scope *s);
static inline void cuisv_render_site(cui_ctx *ui, cuisv_scope *s, int site) {
    for (cuisv_scope *c = s->sites[site].first; c; c = c->next) cuisv_render_scope(ui, c);
}
static inline bool cuisv_site_empty(cuisv_scope *s, int site) { return s->sites[site].first == NULL; }
int cuisv_site_count(cuisv_scope *s, int site);
/* The scopes of a site, in order, in frame memory; returns how many. */
int cuisv_site_scopes(cuisv_scope *s, int site, cuisv_scope ***out);

/* ---- <Reorder> --------------------------------------------------------------------------
 * A <ReorderItem> takes the next position in the list being built (cuisv_reorder_next), so
 * rows can be drawn in an order JS has not seen yet. When the rows are the scopes of one
 * {#each}, CUI knows each row by its scope's handle, which stays with the row when a keyed
 * each moves it: on a drop CUI reorders the handles, the rows are drawn in that order the same
 * frame (as a C app draws from order[] after cui_reorder_begin), and JS gets the new order in
 * its own indices. */
void cuisv_reorder_push(void);
void cuisv_reorder_pop(void);
int cuisv_reorder_next(void);
/* <ol>: its <li>s are numbered from `start` in the order they are built; the marker of the
 * next one is "1.", "2."… (a bullet outside an <ol>). */
void cuisv_ol_begin(int start);
void cuisv_ol_end(void);
const char *cuisv_ol_marker(void);
/* Draws rows in the order of `keys` (row handles). */
void cuisv_reorder_rows(cui_ctx *ui, cuisv_scope **rows, int n, const int *keys);
/* The new order in JS's terms: out[p] = js[k] for the row k whose handle is keys[p]. */
void cuisv_reorder_back(cuisv_scope **rows, int n, const float *js, const int *keys, float *out);

/* ---- per frame scratch ---------------------------------------------------------------- */

/* Memory valid until the end of the frame. */
void *cuisv_frame_alloc(size_t size);
/* "label###key": shows label, keeps the identity of key, so a label that changes (a count,
 * a translation) keeps its component's state and focus. A "##" in label is split by U+200C,
 * or CUI would show only what comes before it. */
const char *cuisv_label(const char *label, const char *key);
const char *cuisv_fmt(const char *fmt, ...);

/* ---- inherited text style (CSS color, font-size... on HTML elements) ------------------ */

typedef struct cuisv_text_style {
    uint32_t set;              /* CUISV_TS_* bits that this level sets */
    cui_color color;
    float size;
    cui_font font;
    cui_text_align align;
    float line_height;
    bool nowrap, tabular;
} cuisv_text_style;
enum {
    CUISV_TS_COLOR = 1 << 0, CUISV_TS_SIZE = 1 << 1, CUISV_TS_FONT = 1 << 2, CUISV_TS_ALIGN = 1 << 3,
    CUISV_TS_LINE_HEIGHT = 1 << 4, CUISV_TS_NOWRAP = 1 << 5, CUISV_TS_TABULAR = 1 << 6
};
void cuisv_text_push(const cuisv_text_style *style);
void cuisv_text_pop(void);
/* Text with the inherited style, then `own` on top (own may be NULL). */
void cuisv_text(cui_ctx *ui, const char *text, const cuisv_text_style *own);
/* Fills opts->color/size/font/... from the inherited style where opts leaves them zero. */
void cuisv_text_inherit(cui_text_opts *opts);

/* ---- boxes with pointer state (HTML elements with :hover, onclick) -------------------- */

typedef struct cuisv_pointer { bool hovered, pressed, clicked, right_clicked, double_clicked, focused, focus_visible; } cuisv_pointer;
/* Pointer state of the box with id `key` (as passed in cui_box.id) from the latest layout,
 * for the box about to be built: call it before cui_box_begin, then cuisv_box_mark right
 * after, so CUI hit tests the box this frame. Clicks are reported once, on release. */
cuisv_pointer cuisv_box_pointer(cui_ctx *ui, const char *key, bool focusable);
void cuisv_box_mark(cui_ctx *ui, bool focusable, bool hand_cursor, const cuisv_pointer *p);

/* ---- host services templates use ------------------------------------------------------- */

/* The buffers behind LogBuffer / TerminalBuffer objects in JS, by handle (never NULL: an
 * empty one stands in for a missing handle). */
struct cui_log_buffer *cuisv_log_buffer(double handle);
struct cui_terminal_buffer *cuisv_terminal_buffer(double handle);

/* A texture for an image file, loaded on first use and kept by path. 0 when it cannot be
 * read. Relative paths are relative to the working directory. */
cui_texture cuisv_image(cui_ctx *ui, const char *path, int *w, int *h);
/* <a href>: opens the URL with the system's handler (nothing in tests). */
void cuisv_open_url(const char *url);

/* ---- names: elements with an id="…" in markup ------------------------------------------ */

/* Records that markup id `name` is the CUI id `cui_make_id(ui, idstr)` under the current id
 * stack, so JS can find the element (scroll_to, rect_of, tests) from outside the frame. */
void cuisv_name(cui_ctx *ui, const char *name, const char *idstr);
/* The CUI id of a named element from the latest frame (or, while a frame is built, from the
 * one before), 0 when unknown. */
cui_id cuisv_named(const char *name);
/* The CUI id of the element drawn under `name` in the latest frame, 0 when none was. */
cui_id cuisv_named_drawn(const char *name);
/* scroll_to / rect_of for JS: false when no element has that id (rect_of: none was drawn in
 * the latest frame; scroll_to: when that element did not scroll in the latest frame, since
 * its state is not a scroll position). */
bool cuisv_scroll_to(cui_ctx *ui, const char *name, float y);
bool cuisv_rect_of(cui_ctx *ui, const char *name, cui_rect *out);
/* After the templates: notes which nodes scroll, for scroll_to. */
void cuisv_collect_scrolls(cui_ctx *ui);

/* ---- registry -------------------------------------------------------------------------- */

/* Generated: every template of the app. */
extern const cuisv_template *const cuisv_templates[];
extern const int cuisv_template_count;

/* Generated: C functions <script lang="c"> exports to JS (fn is a JSCFunction). */
typedef struct cuisv_native { const char *name; void *fn; int length; } cuisv_native;
extern const cuisv_native *const cuisv_native_tables[];
extern const int *const cuisv_native_table_counts[];
extern const int cuisv_native_table_count;

/* ---- canvas ------------------------------------------------------------------------------ */

/* A C paint function from <script lang="c">: the canvas rectangle and the numbers in data={…}. */
typedef void (*cuisv_paint_fn)(cui_ctx *ui, cui_rect r, const float *data, int n);
/* <Canvas>: paints with `fn`, or with the JS function in slot `js_slot` of `s` (onpaint). */
cui_canvas_result cuisv_canvas(cui_ctx *ui, const char *id, cui_size w, cui_size h, cuisv_paint_fn fn,
                               cuisv_scope *s, int js_slot, const float *data, int n);

#ifdef __cplusplus
}
#endif
#endif /* CUISV_H */
