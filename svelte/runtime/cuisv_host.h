/* What a host (the windowed app or the headless test runner) shares: one frame of the
 * app, and loading the bundle. */
#ifndef CUISV_HOST_H
#define CUISV_HOST_H

#include "cuisv_js.h"

/* The cui_ctx of the app (NULL before run() created it). Implemented by each host. */
cui_ctx *cuisv_ui(void);

/* One frame between cui_begin_frame and cui_end_frame: JS timers and animation frames,
 * the templates, then the frame's events to JS. Returns true when JS changed something
 * the next frame should show. */
bool cuisv_host_frame(cui_ctx *ui);

/* Loads the embedded bundle, or `file` when set (dev). */
bool cuisv_host_load(const char *file);

/* Frees the JS context and every scope, then starts a fresh context with `file`. */
void cuisv_host_reload(const char *file);

void cuisv_host_shutdown(void);

#endif
