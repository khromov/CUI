/* The parts of the runtime that use CUI's internals: pointer state for plain boxes (HTML
 * elements with onclick or :hover), the same hit testing CUI's own cards use. */
#include "cuisv.h"
#include "cui_internal.h"

#include <stdlib.h>

cuisv_pointer cuisv_box_pointer(cui_ctx *ui, const char *key, bool focusable) {
    cuisv_pointer p = { 0 };
    cui_id id = cui_make_id(ui, key);
    cui_interact r = cui__interact(ui, id, focusable ? CUI_IF_FOCUSABLE : 0);
    p.hovered = r.hovered;
    p.pressed = r.pressed;
    p.clicked = r.clicked || r.keyboard_activate;
    p.right_clicked = r.right_clicked;
    p.double_clicked = r.double_clicked;
    p.focused = r.focused;
    p.focus_visible = r.focus_visible;
    return p;
}

void cuisv_box_mark(cui_ctx *ui, bool focusable, bool hand_cursor, const cuisv_pointer *p) {
    int cur = cui__current(ui);
    if (cur < 0) return;
    cui__mark_interactive(ui, cur, focusable ? CUI_IF_FOCUSABLE : 0);
    if (hand_cursor && p && p->hovered) cui__set_cursor(ui, CUI_CURSOR_HAND);
}

void cuisv_clipboard_set(cui_ctx *ui, const char *text) {
    if (ui && ui->platform.set_clipboard) ui->platform.set_clipboard(ui->platform.user, text ? text : "");
}

const char *cuisv_clipboard_get(cui_ctx *ui) {
    if (ui && ui->platform.get_clipboard) return ui->platform.get_clipboard(ui->platform.user);
    return NULL;
}

/* The ids of the nodes that scrolled in the latest frame. scroll_to writes a scroll state, and
 * under any other id the state is another widget's (an input's text, a slider's drag), which
 * that write would corrupt. JS calls scroll_to between frames, when CUI's nodes are gone. */
static cui_id *scroll_ids;
static int scroll_count, scroll_cap;

void cuisv_collect_scrolls(cui_ctx *ui) {
    scroll_count = 0;
    for (int i = 0; i < ui->node_count; i++) {
        if (!(ui->nodes[i].flags & (CUI_NF_SCROLL_X | CUI_NF_SCROLL_Y)) || !ui->nodes[i].id) continue;
        if (scroll_count == scroll_cap) {
            int cap = scroll_cap ? scroll_cap * 2 : 32;
            cui_id *grown = realloc(scroll_ids, sizeof *grown * (size_t)cap);
            if (!grown) return;
            scroll_ids = grown;
            scroll_cap = cap;
        }
        scroll_ids[scroll_count++] = ui->nodes[i].id;
    }
}

static bool scrolls(cui_id id) {
    for (int i = 0; i < scroll_count; i++) if (scroll_ids[i] == id) return true;
    return false;
}

/* scroll_to(id, y) from JS: the scroll state of the element registered under id. */
bool cuisv_scroll_to(cui_ctx *ui, const char *name, float y) {
    cui_id id = cuisv_named(name);
    if (!ui || !id || !scrolls(id)) return false;
    if (!(y == y)) y = 0;
    cui_scroll_state *st = cui_state(ui, id, sizeof *st);
    st->ty = y < 0 ? 0 : y;
    cui_request_redraw(ui);
    return true;
}

bool cuisv_rect_of(cui_ctx *ui, const char *name, cui_rect *out) {
    cui_id id = cuisv_named(name);
    if (!ui || !id) return false;
    *out = cui_get_rect(ui, id);
    return true;
}
