/* Host APIs for JS: the window, theme, clipboard, dialogs, files and localStorage. */
#ifndef CUISV_APP_H
#define CUISV_APP_H

#include <cui/cui_app.h>
#include "quickjs.h"

#include <stdint.h>
#include <stdio.h>

/* The window (NULL in the headless test host). Implemented by each host. */
cui_app *cuisv_app(void);
void cuisv_request_redraw(void);
int cuisv_accent_from_name(const char *name);

/* run()'s window options. */
typedef struct cuisv_window_opts {
    char *title;
    int width, height, min_width, min_height;
    bool fixed_size, continuous, hidden;
    int renderer;              /* cui_renderer_kind */
    int theme;                 /* 0 light, 1 dark, 2 follow the system */
    int accent;                /* -1: default */
} cuisv_window_opts;
void cuisv_window_opts_read(JSContext *c, JSValueConst obj, cuisv_window_opts *out);
void cuisv_window_opts_free(cuisv_window_opts *o);
/* What a host applies to a new context: theme and accent. */
void cuisv_apply_startup(cui_ctx *ui, const cuisv_window_opts *o);

/* The program's arguments for args() (UTF-8; on Windows taken from the wide command line). */
void cuisv_set_args(int argc, char **argv);

/* Files and the environment with UTF-8 names on every platform: Windows' narrow APIs use the
 * ANSI code page, so there these go through the wide ones. */
FILE *cuisv_fopen(const char *path, const char *mode);
char *cuisv_getenv(const char *name);   /* malloc'd; NULL when unset */
typedef struct cuisv_file_info { bool dir, regular; double size; long long mtime_ns; } cuisv_file_info;
bool cuisv_stat(const char *path, cuisv_file_info *out);
/* A whole regular file, NUL terminated (not counted in len); NULL for a folder or an error. */
uint8_t *cuisv_read_file(const char *path, size_t *len);

void cuisv_clipboard_set(cui_ctx *ui, const char *text);
const char *cuisv_clipboard_get(cui_ctx *ui);
/* Once per frame: toasts whose action was clicked, and a changed window size, go to JS. */
bool cuisv_app_frame(cui_ctx *ui);

/* Registers the host natives on the bridge (cuisv_js_on_setup). */
void cuisv_app_setup(void);

#endif
