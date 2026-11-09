/* Runtime services with no JS engine in them, shared by the QuickJS host and the browser
 * build: <Canvas> painting, images, links, and the buffers behind LogBuffer/TerminalBuffer. */
#include "cuisv_internal.h"

#include <limits.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- canvas ------------------------------------------------------------------------------- */

typedef struct canvas_payload { cuisv_paint_fn fn; uint32_t handle; int slot; int n; float v[64]; } canvas_payload;

static void canvas_thunk(cui_ctx *ui, cui_rect r, void *user) {
    canvas_payload *p = user;
    if (p->fn) p->fn(ui, r, p->v, p->n);
    else if (p->handle) cuisv_host_paint(p->handle, p->slot, r);
}

cui_canvas_result cuisv_canvas(cui_ctx *ui, const char *id, cui_size w, cui_size h, cuisv_paint_fn fn,
                               cuisv_scope *s, int js_slot, const float *data, int n) {
    canvas_payload p;
    memset(&p, 0, sizeof p);
    p.fn = fn;
    p.handle = (!fn && s && js_slot >= 0) ? s->handle : 0;
    p.slot = js_slot;
    p.n = n < 0 ? 0 : n > 64 ? 64 : n;
    if (data && p.n) memcpy(p.v, data, sizeof(float) * (size_t)p.n);
    size_t size = offsetof(canvas_payload, v) + sizeof(float) * (size_t)p.n;
    return cui_canvas(ui, id, w, h, canvas_thunk, &p, size);
}

/* ---- images ------------------------------------------------------------------------------- */

typedef struct image_entry { char *path; cui_texture tex; int w, h; } image_entry;
static image_entry *images;
static int image_count, image_cap;

cui_texture cuisv_image(cui_ctx *ui, const char *path, int *w, int *h) {
    if (!path || !*path) return 0;
    for (int i = 0; i < image_count; i++) {
        if (strcmp(images[i].path, path) == 0) {
            if (w) *w = images[i].w;
            if (h) *h = images[i].h;
            return images[i].tex;
        }
    }
    if (image_count == image_cap) {
        int cap = image_cap ? image_cap * 2 : 16;
        image_entry *grown = realloc(images, sizeof *images * (size_t)cap);
        if (!grown) return 0;
        images = grown;
        image_cap = cap;
    }
    size_t n = strlen(path);
    char *copy = malloc(n + 1);
    if (!copy) return 0;
    memcpy(copy, path, n + 1);
    image_entry *e = &images[image_count++];
    memset(e, 0, sizeof *e);
    e->path = copy;
    e->tex = cuisv_host_load_image(ui, path, &e->w, &e->h);
    if (!e->tex) cuisv_log("warning", "cannot load image %s", path);
    if (w) *w = e->w;
    if (h) *h = e->h;
    return e->tex;
}

void cuisv_open_url(const char *url) {
    if (url && *url) cuisv_host_open_url(url);
}

/* ---- log and terminal buffers ------------------------------------------------------------- */

typedef struct host_buffer {
    int kind;                  /* 1 log, 2 terminal */
    union { cui_log_buffer log; cui_terminal_buffer term; } u;
    void *lines;
    char *text;
} host_buffer;

static host_buffer *buffers[256];

/* A new buffer's handle (1..255), or 0 when all are taken or memory ran out. */
int cuisv_buffer_new(int kind, int line_cap, size_t text_cap) {
    if (kind != 1) kind = 2;
    if (line_cap < 16) line_cap = 16;
    if (line_cap > (1 << 24)) line_cap = 1 << 24;
    if (text_cap < 1024) text_cap = 1024;
    if (text_cap > ((size_t)1 << 30)) text_cap = (size_t)1 << 30;
    for (int i = 1; i < 256; i++) {
        if (buffers[i]) continue;
        host_buffer *b = calloc(1, sizeof *b);
        if (!b) return 0;
        b->kind = kind;
        b->text = malloc(text_cap);
        b->lines = calloc((size_t)line_cap, kind == 1 ? sizeof(cui_log_line) : sizeof(cui_terminal_line));
        if (!b->text || !b->lines) {
            free(b->text);
            free(b->lines);
            free(b);
            return 0;
        }
        if (kind == 1) cui_log_init(&b->u.log, b->lines, line_cap, b->text, text_cap);
        else cui_terminal_init(&b->u.term, b->text, text_cap, b->lines, line_cap);
        buffers[i] = b;
        return i;
    }
    return 0;
}

/* handles come from JS as numbers: anything but 1..255 (NaN included) is no buffer */
static int buffer_index(double handle) { return handle >= 1 && handle < 256 ? (int)handle : 0; }

static host_buffer *buffer_get(double handle, int kind) {
    int i = buffer_index(handle);
    if (!i || !buffers[i] || (kind && buffers[i]->kind != kind)) return NULL;
    return buffers[i];
}

void cuisv_buffer_write(double handle, const char *s, size_t len, int level) {
    host_buffer *b = buffer_get(handle, 0);
    if (!b || !s) return;
    if (len > INT_MAX) len = INT_MAX;
    if (b->kind == 1) cui_log_append_text(&b->u.log, (cui_log_level)level, cuisv_host_now_ms() / 1000.0, s, (int)len);
    else cui_terminal_write(&b->u.term, s, (int)len);
}

void cuisv_buffer_clear(double handle) {
    host_buffer *b = buffer_get(handle, 0);
    if (!b) return;
    if (b->kind == 1) cui_log_clear(&b->u.log);
    else cui_terminal_clear(&b->u.term);
}

void cuisv_buffer_free(double handle) {
    int i = buffer_index(handle);
    if (i && buffers[i]) {
        free(buffers[i]->lines);
        free(buffers[i]->text);
        free(buffers[i]);
        buffers[i] = NULL;
    }
}

struct cui_log_buffer *cuisv_log_buffer(double handle) {
    static cui_log_buffer empty;
    static cui_log_line empty_lines[1];
    static char empty_text[1];
    host_buffer *b = buffer_get(handle, 1);
    if (b) return &b->u.log;
    if (!empty.lines) cui_log_init(&empty, empty_lines, 1, empty_text, 1);
    return &empty;
}

struct cui_terminal_buffer *cuisv_terminal_buffer(double handle) {
    static cui_terminal_buffer empty;
    static cui_terminal_line empty_lines[1];
    static char empty_text[1];
    host_buffer *b = buffer_get(handle, 2);
    if (b) return &b->u.term;
    if (!empty.lines) cui_terminal_init(&empty, empty_text, 1, empty_lines, 1);
    return &empty;
}
