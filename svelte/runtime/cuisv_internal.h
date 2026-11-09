/* Shared by the runtime's own files; generated code uses cuisv.h only. */
#ifndef CUISV_INTERNAL_H
#define CUISV_INTERNAL_H

#include "cuisv.h"

typedef enum cuisv_event_kind { CUISV_EV_NONE = 0, CUISV_EV_NUM, CUISV_EV_BOOL, CUISV_EV_STR, CUISV_EV_NUM2, CUISV_EV_BYTES } cuisv_event_kind;

typedef struct cuisv_event {
    uint32_t handle;
    uint16_t slot;
    uint8_t kind;
    double a, b;
    char *str;
    uint32_t len;              /* BYTES: length of str */
} cuisv_event;

/* Scopes are addressed from JS by handle: the low 20 bits index the table, the rest is a
 * generation, so a handle from a freed scope never reaches the scope that reuses its index. */
cuisv_scope *cuisv_scope_new(uint32_t template_id);
cuisv_scope *cuisv_scope_get(uint32_t handle);
void cuisv_scope_free(cuisv_scope *s);
cuisv_scope *cuisv_root(void);
void cuisv_insert(cuisv_scope *parent, int site, cuisv_scope *child, cuisv_scope *before);
void cuisv_detach(cuisv_scope *child);
const cuisv_template *cuisv_template_find(uint32_t id);

void cuisv_slot_unset(cuisv_scope *s, int i);
void cuisv_slot_strs(cuisv_scope *s, int i, const char *const *items, const size_t *lens, int count);
void cuisv_slot_floats(cuisv_scope *s, int i, const float *values, int count);
void cuisv_slot_blob(cuisv_scope *s, int i, const uint8_t *data, uint32_t len);
void cuisv_slot_fn(cuisv_scope *s, int i, bool present);

/* Events queued this frame; the host drains them after the frame. */
int cuisv_event_count(void);
cuisv_event *cuisv_events(void);
void cuisv_events_clear(void);

void cuisv_frame_reset(void);
void cuisv_runtime_init(void);
void cuisv_runtime_shutdown(void);

void cuisv_log(const char *level, const char *fmt, ...);

/* What each host (QuickJS app, browser) provides to the shared services. */
void cuisv_host_paint(uint32_t handle, int slot, cui_rect r);   /* <Canvas onpaint> in JS */
void cuisv_host_open_url(const char *url);
cui_texture cuisv_host_load_image(cui_ctx *ui, const char *path, int *w, int *h);
double cuisv_host_now_ms(void);

/* LogBuffer / TerminalBuffer storage (cuisv_services.c). */
int cuisv_buffer_new(int kind, int line_cap, size_t text_cap);
void cuisv_buffer_write(double handle, const char *s, size_t len, int level);
void cuisv_buffer_clear(double handle);
void cuisv_buffer_free(double handle);

#endif
