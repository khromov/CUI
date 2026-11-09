/* C for Host.svelte: compiled into the component (cuisv_export functions are callable from JS). */
#include <math.h>
cuisv_export double hypotenuse(double a, double b) { return sqrt(a * a + b * b); }
cuisv_export const char *greet(const char *name) {
	static char buf[64];
	snprintf(buf, sizeof buf, "hello %s", name);
	return buf;
}
static void draw_bar(cui_ctx *ui, cui_rect r, const float *data, int n) {
	float level = n > 0 ? data[0] : 0;
	cui_draw_rect(ui, r, CUI_CORNERS(4), CUI_COLOR_SURFACE_MUTED);
	cui_draw_rect(ui, (cui_rect){ r.x, r.y, r.w * level, r.h }, CUI_CORNERS(4), CUI_COLOR_ACCENT);
}
