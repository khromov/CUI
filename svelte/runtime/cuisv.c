/* Scopes, slots, sites, events and per frame scratch: everything templates touch. */
#include "cuisv_internal.h"

#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- logging ------------------------------------------------------------------------- */

void cuisv_log(const char *level, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "[cui-svelte] %s: ", level);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}

static void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) { cuisv_log("fatal", "out of memory"); abort(); }
    return p;
}
static void *xcalloc(size_t a, size_t b) {
    void *p = calloc(a ? a : 1, b ? b : 1);
    if (!p) { cuisv_log("fatal", "out of memory"); abort(); }
    return p;
}
static void *xrealloc(void *p, size_t n) {
    void *q = realloc(p, n ? n : 1);
    if (!q) { cuisv_log("fatal", "out of memory"); abort(); }
    return q;
}

/* ---- templates ------------------------------------------------------------------------ */

typedef struct { uint32_t id; const cuisv_template *tpl; } tpl_entry;
static tpl_entry *tpl_index;
static int tpl_index_count;

static int tpl_cmp(const void *a, const void *b) {
    uint32_t x = ((const tpl_entry *)a)->id, y = ((const tpl_entry *)b)->id;
    return x < y ? -1 : x > y;
}

const cuisv_template *cuisv_template_find(uint32_t id) {
    int lo = 0, hi = tpl_index_count - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if (tpl_index[mid].id == id) return tpl_index[mid].tpl;
        if (tpl_index[mid].id < id) lo = mid + 1; else hi = mid - 1;
    }
    return NULL;
}

/* ---- scope table ---------------------------------------------------------------------- */

#define IDX_BITS 20u
#define IDX_MASK ((1u << IDX_BITS) - 1u)
#define TABLE_MAX ((int)IDX_MASK + 1)
/* Freed indices wait in a FIFO and are reused only once this many are free, so an index comes
 * back after thousands of other frees, not right away: with 12 generation bits, a stale
 * handle would have to outlive about 4096 * 4096 scope frees to match again. */
#define REUSE_AFTER 4096

typedef struct { cuisv_scope *s; uint32_t gen; int next_free; } table_entry;
static table_entry *table;
static int table_len, table_cap, free_head = -1, free_tail = -1, free_count;
static cuisv_scope *root_scope;

static void root_render(cui_ctx *ui, cuisv_scope *s) { cuisv_render_site(ui, s, 0); }
static const cuisv_template root_template = { 0, "<root>", root_render, 0, 1 };

static int table_new_index(void) {
    if (table_len == table_cap) {
        if (table_cap >= TABLE_MAX) return -1;
        int cap = table_cap ? table_cap * 2 : 256;
        if (cap > TABLE_MAX) cap = TABLE_MAX;
        table = xrealloc(table, sizeof *table * (size_t)cap);
        table_cap = cap;
    }
    int idx = table_len++;
    table[idx].gen = 0;
    table[idx].s = NULL;
    table[idx].next_free = -1;
    return idx;
}

static uint32_t table_add(cuisv_scope *s) {
    int idx = -1;
    if (table_len == 0) table_new_index();   /* index 0 is never handed out: handle 0 means "none" */
    if (free_count < REUSE_AFTER) idx = table_new_index();
    if (idx < 0 && free_count > 0) {
        idx = free_head;
        free_head = table[idx].next_free;
        if (free_head < 0) free_tail = -1;
        free_count--;
    }
    if (idx < 0) { cuisv_log("fatal", "too many live scopes"); abort(); }
    table[idx].gen = (table[idx].gen + 1) & ((1u << (32 - IDX_BITS)) - 1u);
    if (table[idx].gen == 0) table[idx].gen = 1;
    table[idx].s = s;
    table[idx].next_free = -1;
    return ((uint32_t)idx) | (table[idx].gen << IDX_BITS);
}

cuisv_scope *cuisv_scope_get(uint32_t handle) {
    uint32_t idx = handle & IDX_MASK;
    if (!handle || idx >= (uint32_t)table_len) return NULL;
    if (table[idx].gen != handle >> IDX_BITS) return NULL;
    return table[idx].s;
}

static cuisv_scope *scope_alloc(const cuisv_template *tpl) {
    cuisv_scope *s = xcalloc(1, sizeof *s);
    s->tpl = tpl;
    s->site = -1;
    s->sites = tpl->site_count ? xcalloc(tpl->site_count, sizeof *s->sites) : NULL;
    s->slots = tpl->slot_count ? xcalloc(tpl->slot_count, sizeof *s->slots) : NULL;
    s->handle = table_add(s);
    return s;
}

cuisv_scope *cuisv_scope_new(uint32_t template_id) {
    const cuisv_template *tpl = cuisv_template_find(template_id);
    if (!tpl) {
        cuisv_log("error", "unknown template %08x (the C build is older than the JS bundle; rebuild)", template_id);
        return NULL;
    }
    return scope_alloc(tpl);
}

cuisv_scope *cuisv_root(void) { return root_scope; }

static void value_clear(cuisv_value *v) {
    switch (v->kind) {
    case CUISV_STR: free(v->u.str.p); break;
    case CUISV_STRS: free((void *)v->u.strs.items); free(v->u.strs.pool); break;
    case CUISV_FLOATS: free(v->u.floats.p); break;
    case CUISV_BLOB:
        free(v->u.blob.p);
        if (v->u.blob.cache && v->u.blob.cache_free) v->u.blob.cache_free(v->u.blob.cache);
        break;
    default: break;
    }
    memset(&v->u, 0, sizeof v->u);
    v->kind = CUISV_UNSET;
}

void cuisv_scope_free(cuisv_scope *s) {
    if (!s || s == root_scope) return;
    cuisv_detach(s);
    for (int i = 0; i < s->tpl->site_count; i++) {
        cuisv_scope *c = s->sites[i].first;
        while (c) {
            cuisv_scope *next = c->next;
            c->parent = NULL; c->prev = c->next = NULL; c->site = -1;
            cuisv_scope_free(c);
            c = next;
        }
    }
    for (int i = 0; i < s->tpl->slot_count; i++) value_clear(&s->slots[i]);
    uint32_t idx = s->handle & IDX_MASK;
    if (idx < (uint32_t)table_len && table[idx].s == s) {
        table[idx].s = NULL;
        table[idx].next_free = -1;
        if (free_tail >= 0) table[free_tail].next_free = (int)idx;
        else free_head = (int)idx;
        free_tail = (int)idx;
        free_count++;
    }
    free(s->sites);
    free(s->slots);
    free(s->state);
    free(s);
}

void cuisv_detach(cuisv_scope *c) {
    if (!c || !c->parent || c->site < 0) return;
    cuisv_site *site = &c->parent->sites[c->site];
    if (c->prev) c->prev->next = c->next; else site->first = c->next;
    if (c->next) c->next->prev = c->prev; else site->last = c->prev;
    c->prev = c->next = NULL;
    c->parent = NULL;
    c->site = -1;
}

void cuisv_insert(cuisv_scope *parent, int site_index, cuisv_scope *child, cuisv_scope *before) {
    if (!parent || !child || site_index < 0 || site_index >= parent->tpl->site_count) {
        cuisv_log("error", "insert into a site that does not exist (%d)", site_index);
        return;
    }
    cuisv_detach(child);
    cuisv_site *site = &parent->sites[site_index];
    if (before && (before->parent != parent || before->site != site_index)) before = NULL;
    child->parent = parent;
    child->site = site_index;
    if (!before) {
        child->prev = site->last;
        child->next = NULL;
        if (site->last) site->last->next = child; else site->first = child;
        site->last = child;
    } else {
        child->next = before;
        child->prev = before->prev;
        if (before->prev) before->prev->next = child; else site->first = child;
        before->prev = child;
    }
}

int cuisv_site_count(cuisv_scope *s, int site) {
    int n = 0;
    for (cuisv_scope *c = s->sites[site].first; c; c = c->next) n++;
    return n;
}

int cuisv_site_scopes(cuisv_scope *s, int site, cuisv_scope ***out) {
    int n = cuisv_site_count(s, site);
    cuisv_scope **v = cuisv_frame_alloc(sizeof *v * (size_t)(n > 0 ? n : 1));
    int k = 0;
    for (cuisv_scope *c = s->sites[site].first; c; c = c->next) v[k++] = c;
    *out = v;
    return n;
}

/* ---- <Reorder> ------------------------------------------------------------------------------ */

#define REORDER_DEPTH 16
static int reorder_pos[REORDER_DEPTH];
static int reorder_depth;

void cuisv_reorder_push(void) {
    if (reorder_depth < REORDER_DEPTH) reorder_pos[reorder_depth] = 0;
    reorder_depth++;
}

void cuisv_reorder_pop(void) { if (reorder_depth > 0) reorder_depth--; }

/* outside a list (or nested too deep) every row is position 0, which CUI draws as a plain row */
int cuisv_reorder_next(void) {
    if (reorder_depth <= 0 || reorder_depth > REORDER_DEPTH) return 0;
    return reorder_pos[reorder_depth - 1]++;
}

/* ---- <ol> ------------------------------------------------------------------------------------ */

/* Each <li> takes the next number of the innermost <ol> as it is built, so items from {#each},
 * {#if} or a child component count like the browser's. */
#define OL_DEPTH 16
static int ol_next[OL_DEPTH];
static int ol_depth;

void cuisv_ol_begin(int start) {
    if (ol_depth < OL_DEPTH) ol_next[ol_depth] = start;
    ol_depth++;
}

void cuisv_ol_end(void) { if (ol_depth > 0) ol_depth--; }

const char *cuisv_ol_marker(void) {
    if (ol_depth <= 0 || ol_depth > OL_DEPTH) return "\xE2\x80\xA2";
    return cuisv_fmt("%d.", ol_next[ol_depth - 1]++);
}

static int row_index(cuisv_scope **rows, int n, int key) {
    for (int k = 0; k < n; k++) if ((int)rows[k]->handle == key) return k;
    return -1;
}

void cuisv_reorder_rows(cui_ctx *ui, cuisv_scope **rows, int n, const int *keys) {
    for (int p = 0; p < n; p++) {
        int k = row_index(rows, n, keys[p]);
        if (k >= 0) cuisv_render_scope(ui, rows[k]);
    }
}

void cuisv_reorder_back(cuisv_scope **rows, int n, const float *js, const int *keys, float *out) {
    for (int p = 0; p < n; p++) {
        int k = row_index(rows, n, keys[p]);
        out[p] = k >= 0 ? js[k] : js[p];
    }
}

void cuisv_render_scope(cui_ctx *ui, cuisv_scope *s) {
    cui_push_id_int(ui, (int)s->handle);
    s->tpl->render(ui, s);
    cui_pop_id(ui);
}

/* ---- slots ------------------------------------------------------------------------------ */

static cuisv_value *slot_for_write(cuisv_scope *s, int i, uint8_t kind) {
    if (!s || i < 0 || i >= s->tpl->slot_count) return NULL;
    cuisv_value *v = &s->slots[i];
    if (v->kind != kind) {
        uint32_t version = v->version;
        value_clear(v);
        v->version = version;
        v->kind = kind;
    }
    v->version++;
    return v;
}

void cuisv_slot_unset(cuisv_scope *s, int i) {
    if (!s || i < 0 || i >= s->tpl->slot_count) return;
    uint32_t version = s->slots[i].version;
    value_clear(&s->slots[i]);
    s->slots[i].version = version + 1;
}

void cuisv_set_num(cuisv_scope *s, int i, double n) {
    cuisv_value *v = slot_for_write(s, i, CUISV_NUM);
    if (v) v->u.num = n;
}

void cuisv_set_bool(cuisv_scope *s, int i, bool b) {
    cuisv_value *v = slot_for_write(s, i, CUISV_BOOL);
    if (v) v->u.b = b;
}

void cuisv_set_str(cuisv_scope *s, int i, const char *str, size_t len) {
    cuisv_value *v = slot_for_write(s, i, CUISV_STR);
    if (!v) return;
    if (!v->u.str.p || v->u.str.cap < len + 1) {
        uint32_t cap = (uint32_t)(len + 1 < 32 ? 32 : len + 1);
        v->u.str.p = xrealloc(v->u.str.p, cap);
        v->u.str.cap = cap;
    }
    if (len) memcpy(v->u.str.p, str, len);
    v->u.str.p[len] = 0;
    v->u.str.len = (uint32_t)len;
}

void cuisv_slot_strs(cuisv_scope *s, int i, const char *const *items, const size_t *lens, int count) {
    cuisv_value *v = slot_for_write(s, i, CUISV_STRS);
    if (!v) return;
    free((void *)v->u.strs.items);
    free(v->u.strs.pool);
    size_t total = 0;
    for (int k = 0; k < count; k++) total += lens[k] + 1;
    char *pool = xmalloc(total);
    const char **out = xmalloc(sizeof *out * (size_t)(count ? count : 1));
    char *p = pool;
    for (int k = 0; k < count; k++) {
        memcpy(p, items[k], lens[k]);
        p[lens[k]] = 0;
        out[k] = p;
        p += lens[k] + 1;
    }
    v->u.strs.items = out;
    v->u.strs.pool = pool;
    v->u.strs.count = count;
}

void cuisv_slot_floats(cuisv_scope *s, int i, const float *values, int count) {
    cuisv_value *v = slot_for_write(s, i, CUISV_FLOATS);
    if (!v) return;
    free(v->u.floats.p);
    v->u.floats.p = xmalloc(sizeof(float) * (size_t)(count ? count : 1));
    if (count) memcpy(v->u.floats.p, values, sizeof(float) * (size_t)count);
    v->u.floats.count = count;
}

void cuisv_slot_blob(cuisv_scope *s, int i, const uint8_t *data, uint32_t len) {
    cuisv_value *v = slot_for_write(s, i, CUISV_BLOB);
    if (!v) return;
    free(v->u.blob.p);
    v->u.blob.p = xmalloc(len);
    if (len) memcpy(v->u.blob.p, data, len);
    v->u.blob.len = len;
}

void cuisv_slot_fn(cuisv_scope *s, int i, bool present) {
    if (present) slot_for_write(s, i, CUISV_FN);
    else cuisv_slot_unset(s, i);
}

void *cuisv_blob(cuisv_scope *s, int i, cuisv_unpack_fn unpack, void (*free_fn)(void *), int *count) {
    cuisv_value *v = &s->slots[i];
    if (v->kind != CUISV_BLOB) { *count = 0; return NULL; }
    if (!v->u.blob.cache || v->u.blob.cache_version != v->version) {
        if (v->u.blob.cache && v->u.blob.cache_free) v->u.blob.cache_free(v->u.blob.cache);
        v->u.blob.cache = NULL;
        v->u.blob.cache_count = unpack(v->u.blob.p, v->u.blob.len, &v->u.blob.cache);
        v->u.blob.cache_free = free_fn;
        v->u.blob.cache_version = v->version;
    }
    *count = v->u.blob.cache_count;
    return v->u.blob.cache;
}

char *cuisv_buf(cuisv_scope *s, int i, size_t reserve, size_t *cap) {
    cuisv_value *v = &s->slots[i];
    if (v->kind != CUISV_STR) {
        uint32_t version = v->version;
        value_clear(v);
        v->kind = CUISV_STR;
        v->version = version;
    }
    size_t need = (size_t)v->u.str.len + reserve + 1;
    if (!v->u.str.p || v->u.str.cap < need) {
        size_t c = need < 256 ? 256 : need;
        v->u.str.p = xrealloc(v->u.str.p, c);
        if (v->u.str.cap == 0) v->u.str.p[0] = 0;
        v->u.str.cap = (uint32_t)c;
    }
    *cap = v->u.str.cap;
    return v->u.str.p;
}

void cuisv_buf_changed(cuisv_scope *s, int i, int event_slot) {
    cuisv_value *v = &s->slots[i];
    if (v->kind != CUISV_STR) return;
    v->u.str.len = (uint32_t)strlen(v->u.str.p);
    v->version++;
    if (event_slot >= 0) cuisv_emit_str(s, event_slot, v->u.str.p);
}

bool *cuisv_bools(cuisv_scope *s, int i, int n) {
    bool *out = cuisv_frame_alloc((size_t)(n > 0 ? n : 1) * sizeof(bool));
    memset(out, 0, (size_t)(n > 0 ? n : 1) * sizeof(bool));
    cuisv_value *v = &s->slots[i];
    if (v->kind == CUISV_BLOB)
        for (int k = 0; k < n && (uint32_t)k < v->u.blob.len; k++) out[k] = v->u.blob.p[k] != 0;
    return out;
}

void cuisv_slot_bools(cuisv_scope *s, int i, const bool *values, int n) {
    uint8_t *raw = cuisv_frame_alloc((size_t)(n > 0 ? n : 1));
    for (int k = 0; k < n; k++) raw[k] = values[k] ? 1 : 0;
    cuisv_slot_blob(s, i, raw, (uint32_t)(n > 0 ? n : 0));
}

void cuisv_slot_floats_set(cuisv_scope *s, int i, const float *values, int n) { cuisv_slot_floats(s, i, values, n); }

uint32_t *cuisv_u32s(cuisv_scope *s, int i, int n) {
    uint32_t *out = cuisv_frame_alloc(sizeof(uint32_t) * (size_t)(n > 0 ? n : 1));
    memset(out, 0, sizeof(uint32_t) * (size_t)(n > 0 ? n : 1));
    cuisv_value *v = &s->slots[i];
    if (v->kind == CUISV_BLOB) {
        uint32_t m = v->u.blob.len / 4;
        if (m > (uint32_t)n) m = (uint32_t)n;
        memcpy(out, v->u.blob.p, m * 4);
    }
    return out;
}

void *cuisv_state(cuisv_scope *s, size_t size) {
    if (!s->state || s->state_size < size) {
        s->state = xrealloc(s->state, size);
        memset((char *)s->state + s->state_size, 0, size - s->state_size);
        s->state_size = size;
    }
    return s->state;
}

/* ---- events ------------------------------------------------------------------------------- */

static cuisv_event *events;
static int event_count, event_cap;

static cuisv_event *event_push(cuisv_scope *s, int slot, uint8_t kind) {
    if (event_count == event_cap) {
        event_cap = event_cap ? event_cap * 2 : 32;
        events = xrealloc(events, sizeof *events * (size_t)event_cap);
    }
    cuisv_event *e = &events[event_count++];
    memset(e, 0, sizeof *e);
    e->handle = s->handle;
    e->slot = (uint16_t)slot;
    e->kind = kind;
    return e;
}

void cuisv_emit(cuisv_scope *s, int slot) { event_push(s, slot, CUISV_EV_NONE); }
void cuisv_emit_num(cuisv_scope *s, int slot, double v) { event_push(s, slot, CUISV_EV_NUM)->a = v; }
void cuisv_emit_bool(cuisv_scope *s, int slot, bool v) { event_push(s, slot, CUISV_EV_BOOL)->a = v ? 1 : 0; }
void cuisv_emit_num2(cuisv_scope *s, int slot, double a, double b) {
    cuisv_event *e = event_push(s, slot, CUISV_EV_NUM2);
    e->a = a;
    e->b = b;
}
void cuisv_emit_str(cuisv_scope *s, int slot, const char *str) {
    cuisv_event *e = event_push(s, slot, CUISV_EV_STR);
    size_t n = strlen(str ? str : "");
    e->str = xmalloc(n + 1);
    memcpy(e->str, str ? str : "", n + 1);
}

void cuisv_emit_bytes(cuisv_scope *s, int slot, const void *bytes, uint32_t len) {
    cuisv_event *e = event_push(s, slot, CUISV_EV_BYTES);
    e->str = xmalloc(len ? len : 1);
    if (len) memcpy(e->str, bytes, len);
    e->len = len;
}

static bool keys_wanted;
void cuisv_want_keys(bool on) { keys_wanted = on; }

/* Key events carry handle 0; the slot is the cui_key, a the modifiers (+256: a text field
 * has the keyboard). */
void cuisv_collect_keys(cui_ctx *ui) {
    if (!keys_wanted) return;
    int mods = cui_key_mods(ui) | (cui_wants_keyboard(ui) ? 256 : 0);
    for (int k = 1; k < CUI_KEY_COUNT; k++) {
        if (!cui_key_pressed(ui, (cui_key)k)) continue;
        if (event_count == event_cap) {
            event_cap = event_cap ? event_cap * 2 : 32;
            events = xrealloc(events, sizeof *events * (size_t)event_cap);
        }
        cuisv_event *e = &events[event_count++];
        memset(e, 0, sizeof *e);
        e->slot = (uint16_t)k;
        e->kind = CUISV_EV_NUM;
        e->a = mods;
    }
}

int cuisv_event_count(void) { return event_count; }
cuisv_event *cuisv_events(void) { return events; }
void cuisv_events_clear(void) {
    for (int i = 0; i < event_count; i++) free(events[i].str);
    event_count = 0;
}

/* ---- frame arena --------------------------------------------------------------------------- */

typedef struct arena_block { struct arena_block *next; size_t used, cap; } arena_block;
static arena_block *arena_head;

void *cuisv_frame_alloc(size_t size) {
    size = (size + 15) & ~(size_t)15;
    arena_block *b = arena_head;
    size_t header = (sizeof(arena_block) + 15) & ~(size_t)15;
    if (!b || b->used + size > b->cap) {
        size_t cap = size > 64 * 1024 ? size : 64 * 1024;
        arena_block *nb = xmalloc(header + cap);
        nb->cap = cap;
        nb->used = 0;
        nb->next = b;
        arena_head = b = nb;
    }
    void *p = (char *)b + header + b->used;
    b->used += size;
    return p;
}

static int text_depth;   /* the inherited text style stack, below */
static void names_frame(void);   /* the id registry, below */

void cuisv_frame_reset(void) {
    text_depth = 0;   /* a frame always starts outside every styled element */
    reorder_depth = 0;
    names_frame();
    ol_depth = 0;
    /* keep the newest (largest) block, free the rest */
    if (!arena_head) return;
    arena_block *b = arena_head->next;
    while (b) {
        arena_block *n = b->next;
        free(b);
        b = n;
    }
    arena_head->next = NULL;
    arena_head->used = 0;
}

/* A '#' of the label that another '#' (or the "###") follows gets U+200C after it: CUI shows a
 * label up to its first "##". */
static bool label_hash_split(const char *label, size_t i) {
    return label[i] == '#' && (label[i + 1] == '#' || label[i + 1] == 0);
}

const char *cuisv_label(const char *label, const char *key) {
    if (!key) return label ? label : "";
    if (!label) label = "";
    size_t a = strlen(label), b = strlen(key), splits = 0;
    for (size_t i = 0; i < a; i++) splits += label_hash_split(label, i);
    char *out = cuisv_frame_alloc(a + splits * 3 + 3 + b + 1), *o = out;
    for (size_t i = 0; i < a; i++) {
        *o++ = label[i];
        if (label_hash_split(label, i)) { memcpy(o, "\xE2\x80\x8C", 3); o += 3; }
    }
    memcpy(o, "###", 3);
    memcpy(o + 3, key, b + 1);
    return out;
}

const char *cuisv_fmt(const char *fmt, ...) {
    va_list ap, ap2;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) { va_end(ap2); return ""; }
    char *out = cuisv_frame_alloc((size_t)n + 1);
    vsnprintf(out, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    return out;
}

/* ---- inherited text style ------------------------------------------------------------------ */

/* text_depth counts every push; past TEXT_DEPTH the deepest style written stays on top, so
 * elements nested deeper than that inherit it and each pop still matches its push. */
#define TEXT_DEPTH 128
static cuisv_text_style text_stack[TEXT_DEPTH];

static void style_apply(cuisv_text_style *dst, const cuisv_text_style *src) {
    if (!src) return;
    if (src->set & CUISV_TS_COLOR) dst->color = src->color;
    if (src->set & CUISV_TS_SIZE) dst->size = src->size;
    if (src->set & CUISV_TS_FONT) dst->font = src->font;
    if (src->set & CUISV_TS_ALIGN) dst->align = src->align;
    if (src->set & CUISV_TS_LINE_HEIGHT) dst->line_height = src->line_height;
    if (src->set & CUISV_TS_NOWRAP) dst->nowrap = src->nowrap;
    if (src->set & CUISV_TS_TABULAR) dst->tabular = src->tabular;
    dst->set |= src->set;
}

void cuisv_text_push(const cuisv_text_style *style) {
    if (text_depth >= TEXT_DEPTH) { if (text_depth < INT_MAX) text_depth++; return; }
    cuisv_text_style next = text_depth ? text_stack[text_depth - 1] : (cuisv_text_style){ 0 };
    style_apply(&next, style);
    text_stack[text_depth++] = next;
}

void cuisv_text_pop(void) { if (text_depth > 0) text_depth--; }

static cuisv_text_style text_effective(const cuisv_text_style *own) {
    int top = text_depth < TEXT_DEPTH ? text_depth : TEXT_DEPTH;
    cuisv_text_style st = top > 0 ? text_stack[top - 1] : (cuisv_text_style){ 0 };
    style_apply(&st, own);
    return st;
}

void cuisv_text_inherit(cui_text_opts *o) {
    cuisv_text_style st = text_effective(NULL);
    if ((st.set & CUISV_TS_COLOR) && !o->color.a && !o->color.g && !o->color.r && !o->color.b) o->color = st.color;
    if ((st.set & CUISV_TS_SIZE) && o->size <= 0) o->size = st.size;
    if ((st.set & CUISV_TS_FONT) && o->font == 0) o->font = st.font;
    if ((st.set & CUISV_TS_ALIGN) && o->align == 0) o->align = st.align;
    if ((st.set & CUISV_TS_LINE_HEIGHT) && o->line_height <= 0) o->line_height = st.line_height;
    if ((st.set & CUISV_TS_NOWRAP) && !o->nowrap) o->nowrap = st.nowrap;
    if ((st.set & CUISV_TS_TABULAR) && !o->tabular) o->tabular = st.tabular;
}

void cuisv_text(cui_ctx *ui, const char *text, const cuisv_text_style *own) {
    cuisv_text_style st = text_effective(own);
    cui_text_opts o;
    memset(&o, 0, sizeof o);
    if (st.set & CUISV_TS_COLOR) o.color = st.color;
    if (st.set & CUISV_TS_SIZE) o.size = st.size;
    if (st.set & CUISV_TS_FONT) o.font = st.font;
    if (st.set & CUISV_TS_ALIGN) o.align = st.align;
    if (st.set & CUISV_TS_LINE_HEIGHT) o.line_height = st.line_height;
    if (st.set & CUISV_TS_NOWRAP) o.nowrap = st.nowrap;
    if (st.set & CUISV_TS_TABULAR) o.tabular = st.tabular;
    cui_text_ex(ui, text ? text : "", &o);
}

/* ---- names --------------------------------------------------------------------------------- */

/* Each name keeps the frame it was last drawn in. rect_of answers for the latest frame only,
 * and a name that was not drawn in the latest frame (or, while a frame is built, the one
 * before) is gone: lookups miss it and the table drops it the next time it is rebuilt, which
 * happens as it grows and every 64 frames, so ids that come and go do not pile up. */
/* mark, parent: where CUI's next node went when cuisv_name ran, to find the node the
 * component's call made (cuisv_name_last) */
typedef struct name_entry { char *name; cui_id id; int mark, parent; uint32_t seen; } name_entry;
static name_entry *names;
static int name_count, name_cap;
static uint32_t name_now;   /* counts frames: the one being built, or the latest between frames */

static uint32_t name_hash(const char *s) {
    uint32_t h = 2166136261u;
    while (*s) { h ^= (uint8_t)*s++; h *= 16777619u; }
    return h ? h : 1;
}

static bool name_live(const name_entry *e) { return name_now - e->seen <= 1; }

static name_entry *name_find(name_entry *table, int cap, const char *name) {
    uint32_t i = name_hash(name) & (uint32_t)(cap - 1);
    for (;;) {
        if (!table[i].name || strcmp(table[i].name, name) == 0) return &table[i];
        i = (i + 1) & (uint32_t)(cap - 1);
    }
}

/* A new table with the live names (the others are freed), at most half full with `extra` more. */
static void names_rebuild(int extra) {
    int live = 0;
    for (int i = 0; i < name_cap; i++) if (names[i].name && name_live(&names[i])) live++;
    int cap = 64;
    while (cap < (live + extra) * 2) cap *= 2;
    name_entry *table = xcalloc((size_t)cap, sizeof *table);
    for (int i = 0; i < name_cap; i++) {
        if (!names[i].name) continue;
        if (name_live(&names[i])) *name_find(table, cap, names[i].name) = names[i];
        else free(names[i].name);
    }
    free(names);
    names = table;
    name_cap = cap;
    name_count = live;
}

static void names_frame(void) {
    name_now++;
    if (name_count && name_now % 64 == 0) names_rebuild(0);
}

void cuisv_name(cui_ctx *ui, const char *name, const char *idstr) {
    if (!name || !*name) return;
    if (!name_cap) {
        name_cap = 64;
        names = xcalloc((size_t)name_cap, sizeof *names);
    }
    name_entry *e = name_find(names, name_cap, name);
    if (!e->name) {
        if ((name_count + 1) * 2 > name_cap) {
            names_rebuild(1);
            e = name_find(names, name_cap, name);
        }
        size_t n = strlen(name);
        e->name = xmalloc(n + 1);
        memcpy(e->name, name, n + 1);
        name_count++;
    }
    e->id = cui_make_id(ui, idstr ? idstr : name);
    cuisv_node_mark(ui, &e->mark, &e->parent);
    e->seen = name_now;
}

void cuisv_name_last(cui_ctx *ui, const char *name) {
    if (!ui || !name || !*name || !name_cap) return;
    name_entry *e = name_find(names, name_cap, name);
    if (!e->name || e->seen != name_now) return;
    e->id = cuisv_node_pick(ui, e->mark, e->parent, e->id);
}

cui_id cuisv_named(const char *name) {
    if (!name || !name_cap) return 0;
    name_entry *e = name_find(names, name_cap, name);
    return e->name && name_live(e) ? e->id : 0;
}

cui_id cuisv_named_drawn(const char *name) {
    if (!name || !name_cap) return 0;
    name_entry *e = name_find(names, name_cap, name);
    return e->name && e->seen == name_now ? e->id : 0;
}

/* ---- lifetime ----------------------------------------------------------------------------- */

void cuisv_runtime_init(void) {
    tpl_index_count = cuisv_template_count;
    tpl_index = xmalloc(sizeof *tpl_index * (size_t)(tpl_index_count ? tpl_index_count : 1));
    for (int i = 0; i < tpl_index_count; i++) {
        tpl_index[i].id = cuisv_templates[i]->id;
        tpl_index[i].tpl = cuisv_templates[i];
    }
    qsort(tpl_index, (size_t)tpl_index_count, sizeof *tpl_index, tpl_cmp);
    for (int i = 1; i < tpl_index_count; i++)
        if (tpl_index[i].id == tpl_index[i - 1].id)
            cuisv_log("error", "template id collision: %s and %s", tpl_index[i].tpl->name, tpl_index[i - 1].tpl->name);
    root_scope = scope_alloc(&root_template);
}

void cuisv_runtime_shutdown(void) {
    if (root_scope) {
        for (cuisv_scope *c = root_scope->sites[0].first; c;) {
            cuisv_scope *n = c->next;
            c->parent = NULL; c->prev = c->next = NULL; c->site = -1;
            cuisv_scope_free(c);
            c = n;
        }
        root_scope->sites[0].first = root_scope->sites[0].last = NULL;
    }
    cuisv_events_clear();
    cuisv_strings_set(NULL, NULL, 0);
}
