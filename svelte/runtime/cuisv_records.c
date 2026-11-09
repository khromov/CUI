/* Records: arrays of C structs (chart series, table columns, gantt tasks…) that arrive from
 * JS as packed bytes and go back the same way when CUI changes them. The layout is a
 * descriptor the compiler generates with offsetof, so one codec serves every struct.
 *
 * Wire format (little endian): u32 count, then each record's fields in descriptor order:
 *   STR      u32 length, bytes          BOOL   u8         I32/U32/NAMED_ID?  i32 / u32
 *   F32      f32                        F64    f64        COLOR  u32 0xRRGGBBAA
 *   SIZE     f64 (kind * 1e9 + value)   DATE   i32 y, m, d
 *   FLOATS   u32 n, n f32 (count field set too)            STRS u32 n, n strings
 *   TEXTURE  f64 handle                 NAMED_ID  a string, resolved with cuisv_named
 *   STRUCT   the nested struct's fields
 */
#include "cuisv_internal.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ---- arena: everything a records value owns, freed at once -------------------------- */

typedef struct arena_chunk { struct arena_chunk *next; size_t used, cap; } arena_chunk;

static void *arena_alloc(arena_chunk **head, size_t size) {
    size = (size + 15) & ~(size_t)15;
    size_t hdr = (sizeof(arena_chunk) + 15) & ~(size_t)15;
    arena_chunk *c = *head;
    if (!c || c->used + size > c->cap) {
        size_t cap = size > 4096 ? size : 4096;
        arena_chunk *n = malloc(hdr + cap);
        if (!n) abort();
        n->next = c;
        n->used = 0;
        n->cap = cap;
        *head = c = n;
    }
    void *p = (char *)c + hdr + c->used;
    c->used += size;
    memset(p, 0, size);
    return p;
}

static void arena_free(arena_chunk *c) {
    while (c) {
        arena_chunk *n = c->next;
        free(c);
        c = n;
    }
}

/* ---- reading -------------------------------------------------------------------------- */

typedef struct reader { const uint8_t *p, *end; bool bad; } reader;

static bool need(reader *r, size_t n) {
    if (r->bad || (size_t)(r->end - r->p) < n) { r->bad = true; return false; }
    return true;
}
static uint32_t rd_u32(reader *r) {
    if (!need(r, 4)) return 0;
    uint32_t v = (uint32_t)r->p[0] | ((uint32_t)r->p[1] << 8) | ((uint32_t)r->p[2] << 16) | ((uint32_t)r->p[3] << 24);
    r->p += 4;
    return v;
}
static float rd_f32(reader *r) { uint32_t u = rd_u32(r); float f; memcpy(&f, &u, 4); return f; }
static double rd_f64(reader *r) {
    if (!need(r, 8)) return 0;
    uint64_t u = 0;
    for (int i = 7; i >= 0; i--) u = (u << 8) | r->p[i];
    r->p += 8;
    double d;
    memcpy(&d, &u, 8);
    return d;
}
#define NULL_STR 0xFFFFFFFFu   /* an optional string left out: NULL in C */

static const char *rd_str(reader *r, arena_chunk **a) {
    uint32_t n = rd_u32(r);
    if (n == NULL_STR) return NULL;
    if (!need(r, n)) return "";
    char *s = arena_alloc(a, n + 1);
    memcpy(s, r->p, n);
    s[n] = 0;
    r->p += n;
    return s;
}

static void read_struct(reader *r, const cuisv_struct_desc *d, uint8_t *base, arena_chunk **a);

/* Room for n items of `wire` bytes each, checked before allocating for them. */
static bool room_for(reader *r, uint32_t n, size_t wire) {
    if (n == 0) return true;
    if ((size_t)n > (size_t)(r->end - r->p) / wire) { r->bad = true; return false; }
    return true;
}

/* A date CUI can index with (month 1..12, day 1..31), or zero (unset). */
static cui_date valid_date(cui_date d) {
    if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31 || d.year < 1 || d.year > 9999) {
        cui_date zero = { 0, 0, 0 };
        return zero;
    }
    return d;
}

static void read_field(reader *r, const cuisv_field *f, uint8_t *base, arena_chunk **a, uint32_t *len) {
    uint8_t *at = base + f->offset;
    switch (f->kind) {
    case CUISV_F_STR: { const char *s = rd_str(r, a); memcpy(at, &s, sizeof s); break; }
    case CUISV_F_BOOL: { bool b = need(r, 1) ? *r->p++ != 0 : false; memcpy(at, &b, sizeof b); break; }
    case CUISV_F_I32: { int32_t v = (int32_t)rd_u32(r); memcpy(at, &v, 4); break; }
    case CUISV_F_U32: { uint32_t v = rd_u32(r); memcpy(at, &v, 4); break; }
    case CUISV_F_F32: { float v = rd_f32(r); memcpy(at, &v, 4); break; }
    case CUISV_F_F64: { double v = rd_f64(r); memcpy(at, &v, 8); break; }
    case CUISV_F_I64: { double d = rd_f64(r); int64_t v = d == d && d > -9.2e18 && d < 9.2e18 ? (int64_t)d : 0; memcpy(at, &v, 8); break; }
    case CUISV_F_COLOR: { cui_color c = cuisv_color_u32(rd_u32(r)); memcpy(at, &c, sizeof c); break; }
    case CUISV_F_SIZE: { cui_size z = cuisv_size_num(rd_f64(r)); memcpy(at, &z, sizeof z); break; }
    case CUISV_F_DATE: {
        cui_date dt;
        dt.year = (int)rd_u32(r); dt.month = (int)rd_u32(r); dt.day = (int)rd_u32(r);
        dt = valid_date(dt);
        memcpy(at, &dt, sizeof dt);
        break;
    }
    case CUISV_F_TEXTURE: { double d = rd_f64(r); cui_texture t = d > 0 && d < 4e9 ? (cui_texture)d : 0; memcpy(at, &t, sizeof t); break; }
    case CUISV_F_NAMED_ID: { const char *s = rd_str(r, a); cui_id id = s ? cuisv_named(s) : 0; memcpy(at, &id, sizeof id); break; }
    case CUISV_F_FLOATS: {
        uint32_t n = rd_u32(r);
        if (!room_for(r, n, 4)) n = 0;
        float *v = n ? arena_alloc(a, sizeof(float) * n) : NULL;
        for (uint32_t i = 0; i < n; i++) v[i] = rd_f32(r);
        memcpy(at, &v, sizeof v);
        *len = n;
        break;
    }
    case CUISV_F_VEC2S: {
        uint32_t n = rd_u32(r);
        if (!room_for(r, n, 8)) n = 0;
        cui_vec2 *v = n ? arena_alloc(a, sizeof(cui_vec2) * n) : NULL;
        for (uint32_t i = 0; i < n; i++) { v[i].x = rd_f32(r); v[i].y = rd_f32(r); }
        memcpy(at, &v, sizeof v);
        *len = n;
        break;
    }
    case CUISV_F_STRS: {
        uint32_t n = rd_u32(r);
        if (!room_for(r, n, 4)) n = 0;
        const char **v = n ? arena_alloc(a, sizeof(char *) * n) : NULL;
        for (uint32_t i = 0; i < n; i++) { v[i] = rd_str(r, a); if (!v[i]) v[i] = ""; }
        memcpy(at, &v, sizeof v);
        *len = n;
        break;
    }
    case CUISV_F_STRUCT: if (f->sub) read_struct(r, f->sub, at, a); break;
    default: break;
    }
}

static void read_struct(reader *r, const cuisv_struct_desc *d, uint8_t *base, arena_chunk **a) {
    /* arrays sharing a count field: the count is the shortest of those present */
    int16_t offs[8];
    uint32_t mins[8];
    int nshared = 0;
    for (int i = 0; i < d->field_count && !r->bad; i++) {
        const cuisv_field *f = &d->fields[i];
        uint32_t len = 0;
        read_field(r, f, base, a, &len);
        bool is_array = f->kind == CUISV_F_FLOATS || f->kind == CUISV_F_VEC2S || f->kind == CUISV_F_STRS;
        if (!is_array || f->count_offset < 0) continue;
        int k;
        for (k = 0; k < nshared; k++) if (offs[k] == f->count_offset) break;
        if (k == nshared) {
            if (nshared == 8) continue;
            offs[nshared] = f->count_offset;
            mins[nshared++] = len;
        } else if (len > 0 && (mins[k] == 0 || len < mins[k])) {
            mins[k] = len;
        }
    }
    for (int k = 0; k < nshared; k++) {
        int c = (int)mins[k];
        memcpy(base + offs[k], &c, sizeof c);
    }
}

typedef struct records_cache { cuisv_records pub; arena_chunk *arena; } records_cache;

static void records_free(void *p) {
    records_cache *c = p;
    arena_free(c->arena);
    free(c);
}

static const cuisv_struct_desc *unpacking;

static int records_unpack(const uint8_t *data, uint32_t len, void **out) {
    records_cache *c = calloc(1, sizeof *c);
    reader r = { data, data + len, false };
    uint32_t n = rd_u32(&r);
    /* every record takes at least one byte on the wire, unless it has no fields */
    if (n > len || (size_t)n > SIZE_MAX / (unpacking->size ? unpacking->size : 1) / 2) n = 0;
    c->pub.items = arena_alloc(&c->arena, (size_t)unpacking->size * (n ? n : 1));
    for (uint32_t i = 0; i < n && !r.bad; i++) read_struct(&r, unpacking, (uint8_t *)c->pub.items + (size_t)i * unpacking->size, &c->arena);
    c->pub.count = r.bad ? 0 : (int)n;
    if (r.bad) cuisv_log("error", "malformed records (a struct changed shape between JS and C?)");
    *out = c;
    return c->pub.count;
}

const cuisv_records *cuisv_records_get(cuisv_scope *s, int slot, const cuisv_struct_desc *d) {
    static const cuisv_records empty = { NULL, 0 };
    int count = 0;
    unpacking = d;
    records_cache *c = cuisv_blob(s, slot, records_unpack, records_free, &count);
    unpacking = NULL;
    return c ? &c->pub : &empty;
}

/* ---- writing ------------------------------------------------------------------------- */

typedef struct writer { uint8_t *p; size_t len, cap; } writer;

static void put(writer *w, const void *src, size_t n) {
    if (w->len + n > w->cap) {
        w->cap = (w->len + n) * 2 + 64;
        w->p = realloc(w->p, w->cap);
        if (!w->p) abort();
    }
    memcpy(w->p + w->len, src, n);
    w->len += n;
}
static void wr_u32(writer *w, uint32_t v) {
    uint8_t b[4] = { (uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24) };
    put(w, b, 4);
}
static void wr_f64(writer *w, double d) {
    uint64_t u;
    memcpy(&u, &d, 8);
    uint8_t b[8];
    for (int i = 0; i < 8; i++) b[i] = (uint8_t)(u >> (8 * i));
    put(w, b, 8);
}
static void wr_str(writer *w, const char *s) {
    if (!s) { wr_u32(w, 0xFFFFFFFFu); return; }
    size_t n = strlen(s);
    wr_u32(w, (uint32_t)n);
    if (n) put(w, s, n);
}

static void write_struct(writer *w, const cuisv_struct_desc *d, const uint8_t *base);

static void write_field(writer *w, const cuisv_field *f, const uint8_t *base) {
    const uint8_t *at = base + f->offset;
    switch (f->kind) {
    case CUISV_F_STR: { const char *s; memcpy(&s, at, sizeof s); wr_str(w, s); break; }
    case CUISV_F_BOOL: { bool b; memcpy(&b, at, sizeof b); uint8_t v = b; put(w, &v, 1); break; }
    case CUISV_F_I32: case CUISV_F_U32: { uint32_t v; memcpy(&v, at, 4); wr_u32(w, v); break; }
    case CUISV_F_F32: { float v; memcpy(&v, at, 4); uint32_t u; memcpy(&u, &v, 4); wr_u32(w, u); break; }
    case CUISV_F_F64: { double v; memcpy(&v, at, 8); wr_f64(w, v); break; }
    case CUISV_F_I64: { int64_t v; memcpy(&v, at, 8); wr_f64(w, (double)v); break; }
    case CUISV_F_COLOR: {
        cui_color c; memcpy(&c, at, sizeof c);
        wr_u32(w, ((uint32_t)c.r << 24) | ((uint32_t)c.g << 16) | ((uint32_t)c.b << 8) | c.a);
        break;
    }
    case CUISV_F_SIZE: { cui_size z; memcpy(&z, at, sizeof z); wr_f64(w, (double)z.kind * 1e9 + z.value); break; }
    case CUISV_F_DATE: { cui_date d; memcpy(&d, at, sizeof d); wr_u32(w, (uint32_t)d.year); wr_u32(w, (uint32_t)d.month); wr_u32(w, (uint32_t)d.day); break; }
    case CUISV_F_TEXTURE: { cui_texture t; memcpy(&t, at, sizeof t); wr_f64(w, (double)t); break; }
    case CUISV_F_NAMED_ID: wr_str(w, ""); break;
    case CUISV_F_FLOATS: {
        const float *v; memcpy(&v, at, sizeof v);
        int n = 0;
        if (f->count_offset >= 0) memcpy(&n, base + f->count_offset, sizeof n);
        if (!v) n = 0;
        wr_u32(w, (uint32_t)n);
        for (int i = 0; i < n; i++) { uint32_t u; memcpy(&u, &v[i], 4); wr_u32(w, u); }
        break;
    }
    case CUISV_F_VEC2S: {
        const cui_vec2 *v; memcpy(&v, at, sizeof v);
        int n = 0;
        if (f->count_offset >= 0) memcpy(&n, base + f->count_offset, sizeof n);
        if (!v) n = 0;
        wr_u32(w, (uint32_t)n);
        for (int i = 0; i < n; i++) { uint32_t u; memcpy(&u, &v[i].x, 4); wr_u32(w, u); memcpy(&u, &v[i].y, 4); wr_u32(w, u); }
        break;
    }
    case CUISV_F_STRS: {
        const char *const *v; memcpy(&v, at, sizeof v);
        int n = 0;
        if (f->count_offset >= 0) memcpy(&n, base + f->count_offset, sizeof n);
        if (!v) n = 0;
        wr_u32(w, (uint32_t)n);
        for (int i = 0; i < n; i++) wr_str(w, v[i]);
        break;
    }
    case CUISV_F_STRUCT: if (f->sub) write_struct(w, f->sub, at); break;
    default: break;
    }
}

static void write_struct(writer *w, const cuisv_struct_desc *d, const uint8_t *base) {
    for (int i = 0; i < d->field_count; i++) write_field(w, &d->fields[i], base);
}

void cuisv_emit_records(cuisv_scope *s, int slot, const cuisv_struct_desc *d, const void *items, int count) {
    writer w = { 0 };
    wr_u32(&w, (uint32_t)count);
    for (int i = 0; i < count; i++) write_struct(&w, d, (const uint8_t *)items + (size_t)i * d->size);
    cuisv_emit_bytes(s, slot, w.p, (uint32_t)w.len);
    free(w.p);
}

/* A record value for a bound struct (a date, a color, a range): the first record, or zeros. */
void cuisv_record_read(cuisv_scope *s, int slot, const cuisv_struct_desc *d, void *out) {
    const cuisv_records *r = cuisv_records_get(s, slot, d);
    if (r->count > 0) memcpy(out, r->items, d->size);
    else memset(out, 0, d->size);
}

/* CUI changed a bound struct: keep it in the slot (until JS answers) and tell JS. */
void cuisv_record_write(cuisv_scope *s, int slot, int event_slot, const cuisv_struct_desc *d, const void *value) {
    writer w = { 0 };
    wr_u32(&w, 1);
    write_struct(&w, d, value);
    cuisv_slot_blob(s, slot, w.p, (uint32_t)w.len);
    if (event_slot >= 0) cuisv_emit_bytes(s, event_slot, w.p, (uint32_t)w.len);
    free(w.p);
}

void cuisv_records_store(cuisv_scope *s, int slot, const cuisv_struct_desc *d, const void *items, int count) {
    writer w = { 0 };
    wr_u32(&w, (uint32_t)count);
    for (int i = 0; i < count; i++) write_struct(&w, d, (const uint8_t *)items + (size_t)i * d->size);
    cuisv_slot_blob(s, slot, w.p, (uint32_t)w.len);
    free(w.p);
}
