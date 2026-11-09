/**
 * CUI components as Svelte components: which C function each one calls and what its
 * parameters mean in markup. Most of it is inferred from the C prototype (cui-api.json);
 * the table at the bottom only names the components and corrects what inference gets wrong.
 */
import { api, fields_of, is_struct, type Field, type Param } from './api.ts';

export type Role =
	| 'id' //        const char *id: generated from the component's place in the template
	| 'label' //     const char *label/title: text children or label=, also the identity
	| 'text' //      const char *: text children or the prop
	| 'icon' //      const char *icon: an icon name
	| 'value' //     by value: number, bool, enum, size, color, texture
	| 'bind' //      T *: a value CUI reads and writes (bind:checked, bind:value)
	| 'buffer' //    char *buf, size_t cap: an editable string (bind:value)
	| 'strs' //      const char *const *items, int count
	| 'floats' //    const float *values, int count
	| 'records' //   const T *items, int count: an array of objects
	| 'records_mut' // T *items, int count: objects CUI changes (bind: to get them back)
	| 'bind_struct' // T *value for a struct (a date, a color, a range): bind:value
	| 'struct_value' // T by value (a date)
	| 'bind_bools' //  bool *values next to a list (toggle group, multi select): bind to an array
	| 'bind_floats' // float *value, int n (a vector): bind to an array of numbers
	| 'texture' //    cui_texture: an image path (src) or load_image()
	| 'record' //     const T *one: a single object
	| 'bytes' //      const uint8_t *data, size_t size: a Uint8Array
	| 'host_object' // cui_log_buffer *, cui_terminal_buffer *: a LogBuffer / TerminalBuffer from JS
	| 'records_cap' // T *items, int *count, int capacity: an array CUI may grow and shrink
	| 'bind_u32s' //  uint32_t *masks, one per item of the records before it
	| 'out' //       T *: written by CUI each frame, read by nobody (first/last of a list)
	| 'skip'; //     filled with a default, not exposed

export interface ParamSpec {
	/** C parameter name. */
	name: string;
	/** Attribute name in markup. */
	prop: string;
	type: string;
	role: Role;
	/** C expression used when markup leaves the prop out. */
	default?: string;
	/** Index of the count parameter that follows an array. */
	count?: boolean;
}

export type Children = 'container' | 'label' | 'text' | 'none';

export interface EventSpec {
	/** Markup name, e.g. onclick. */
	name: string;
	/** C condition on the result `r` (and `changed` for binds). */
	when: string;
	/** C expression for the payload, or null for none. 'num' | 'str' | 'bool' typed. */
	/** 'value': the bound value as JS sees it (after its setter ran), whatever its type. */
	/** 'num2': two numbers, `expr` and `expr2` (a range's ends, an hour and a minute). */
	payload?: { type: 'num' | 'str' | 'bool' | 'value' | 'json' | 'num2'; expr: string; expr2?: string };
}

export interface Spec {
	name: string;
	kind: 'call' | 'scope' | 'scope_if';
	fn: string;
	end?: string;
	opts?: string;
	ret: string;
	params: ParamSpec[];
	children: Children;
	events: EventSpec[];
	/** Options fields, by markup name. */
	fields: Map<string, Field>;
	doc?: string;
	/** C condition (over `r`) that a text buffer changed, for results that are not flags. */
	buffer_changed?: string;
	/** Room a text buffer keeps past its text for what CUI writes itself (cuisv_edit_room adds a paste). */
	buffer_room: number;
	/** The end function's arguments after ui, statements before it, and events on its result `e`. */
	end_args?: string;
	end_pre?: string;
	end_events?: EventSpec[];
	/** Children go right after the call, with no end (a table row's cells). */
	children_after?: boolean;
	/** A statement between the first and second child (cui_split_next). */
	between?: string;
	/** Name of a custom emitter in special.ts. */
	custom?: string;
	/** Queries after the children, before the end (node editor links). */
	before_end?: { pre: string; events: EventSpec[] };
}

interface Override {
	/** Markup names for C parameters. */
	props?: Record<string, string>;
	roles?: Record<string, Role>;
	defaults?: Record<string, string>;
	children?: Children;
	/** Replaces the inferred events. */
	events?: EventSpec[];
	/** For components without an _ex function: the plain function. */
	fn?: string;
	/** C condition (over `r`) that a text buffer changed, for results that are not flags. */
	buffer_changed?: string;
	/** Room a text buffer keeps past its text, besides a paste (default 256: typing). */
	buffer_room?: number;
	/** Extra events, added to the inferred ones. */
	more_events?: EventSpec[];
	/** Containers CUI has no scope macro for: the begin and end functions. */
	begin?: string;
	end?: string;
	kind?: Spec['kind'];
	/** The end function's arguments after ui (e.g. "&move") and the events on its result `e`. */
	end_args?: string;
	end_pre?: string;
	end_events?: EventSpec[];
	/** Children go right after the call, with no end (a table row's cells). */
	children_after?: boolean;
	/** A statement between the first and second child (cui_split_next). */
	between?: string;
	custom?: string;
	/** Queries to run after the children, before the end (node editor links). */
	before_end?: { pre: string; events: EventSpec[] };
}

const BIND_TYPES: Record<string, 'bool' | 'int' | 'float' | 'double'> = {
	'bool *': 'bool',
	'int *': 'int',
	'float *': 'float',
	'double *': 'double'
};

export function bind_kind(type: string) {
	return BIND_TYPES[type];
}

/** Roles followed by a count parameter, which travels with them. */
const COUNTED = new Set<Role>(['buffer', 'strs', 'floats', 'records', 'records_mut', 'bind_floats', 'bytes']);
/** Roles CUI writes back; those besides scalars and text send their value as JS sees it. */
const BOUND = new Set<Role>(['bind', 'buffer', 'bind_struct', 'bind_bools', 'bind_floats', 'records_mut', 'records_cap', 'bind_u32s']);
const VALUE_PAYLOAD = new Set<Role>(['bind_struct', 'bind_bools', 'bind_floats', 'records_mut', 'records_cap', 'bind_u32s']);

/**
 * Components whose label is only shown, never hashed into an identity: a "###key" suffix
 * would be drawn. Found by test/labels (every label component, rendered headless).
 */
const DISPLAY_LABELS = new Set(['cui_gauge', 'cui_nav_section', 'cui_empty_state_ex', 'cui_metric_ex', 'cui_timeline_item_ex', 'cui_chat_divider', 'cui_kanban_column_begin_ex', 'cui_node_begin_ex', 'cui_node_input_ex', 'cui_node_output_ex']);

function infer_params(params: Param[], o: Override, fn_name = ''): ParamSpec[] {
	const out: ParamSpec[] = [];
	const ps = params.filter((p) => p.name !== 'ui' && p.name !== 'opts' && p.type !== '...');
	for (let i = 0; i < ps.length; i++) {
		const p = ps[i];
		const next = ps[i + 1];
		const prop = o.props?.[p.name] ?? p.name;
		let role: Role | undefined = o.roles?.[p.name];
		const takes_count = next && (next.type === 'int' || next.type === 'size_t') && /count|^n$|len|cap|size/.test(next.name);
		if (!role) {
			if (p.type === 'const char *' && p.name === 'id') role = 'id';
			else if (p.type === 'const char *' && (p.name === 'label' || p.name === 'title')) role = DISPLAY_LABELS.has(fn_name) ? 'text' : 'label';
			else if (p.type === 'const char *' && /icon/.test(p.name)) role = 'icon';
			else if (p.type === 'const char *') role = 'text';
			else if (p.type === 'char *' && next?.type === 'size_t') role = 'buffer';
			else if (p.type === 'const char *const *' && takes_count) role = 'strs';
			else if (p.type === 'const float *' && takes_count) role = 'floats';
			else if (/^const cui_\w+ \*$/.test(p.type) && is_struct(p.type.slice(6, -2)) && takes_count) role = 'records';
			else if (p.type === 'cui_log_buffer *' || p.type === 'cui_terminal_buffer *') role = 'host_object';
			else if (/^cui_\w+ \*$/.test(p.type) && is_struct(p.type.slice(0, -2)) && next?.type === 'int *' && ps[i + 2]?.type === 'int' && /cap/.test(ps[i + 2].name)) role = 'records_cap';
			else if (p.type === 'uint32_t *' && out.some((q) => q.role === 'records')) role = 'bind_u32s';
			else if (/^cui_\w+ \*$/.test(p.type) && is_struct(p.type.slice(0, -2)) && takes_count) role = 'records_mut';
			else if (/^const cui_\w+ \*$/.test(p.type) && is_struct(p.type.slice(6, -2))) role = 'record';
			else if (p.type === 'const uint8_t *' && next?.type === 'size_t') role = 'bytes';
			else if (p.type === 'bool *' && out.some((q) => q.role === 'strs')) role = 'bind_bools';
			else if (p.type === 'float *' && next?.type === 'int' && /components|count|n$/.test(next.name)) role = 'bind_floats';
			else if (/^cui_\w+ \*$/.test(p.type) && is_struct(p.type.slice(0, -2))) role = 'bind_struct';
			else if (p.type === 'cui_texture') role = 'texture';
			else if (p.type in BIND_TYPES) role = 'bind';
			else if (is_struct(p.type) && !['cui_size', 'cui_color', 'cui_vec2'].includes(p.type)) role = 'struct_value';
			else role = 'value';
		}
		const spec: ParamSpec = {
			name: p.name,
			prop: role === 'buffer' && !o.props?.[p.name] ? 'value' : role === 'texture' && p.name === 'tex' && !o.props?.[p.name] ? 'src' : role === 'host_object' && !o.props?.[p.name] ? 'buffer' : prop,
			type: p.type,
			role,
			default: o.defaults?.[p.name]
		};
		out.push(spec);
		if (COUNTED.has(role)) {
			out.push({ name: next.name, prop: next.name, type: next.type, role: 'skip', count: true });
			i++;
		}
		if (role === 'records_cap') {
			// int *count, int capacity
			out.push({ name: next.name, prop: next.name, type: next.type, role: 'skip', count: true });
			const cap = ps[i + 2];
			if (cap) out.push({ name: cap.name, prop: 'capacity', type: cap.type, role: 'skip', count: true });
			i += cap ? 2 : 1;
		}
	}
	return out;
}

/**
 * `when` is C over `r` (the return value) and `$changed` (a bound value differs from what the
 * frame started with); `$name` in a payload is the local holding parameter `name`.
 */
function infer_events(ret: string, params: ParamSpec[]): EventSpec[] {
	const all = params.filter((p) => BOUND.has(p.role));
	const bound = all[0];
	if (bound && bound.role !== 'buffer') {
		// $changed: any of them changed. Two numbers (lo and hi, hour and minute, x and y) both
		// go to the handler; otherwise it gets the first.
		const num = (p?: ParamSpec) => p?.role === 'bind' && bind_kind(p.type) !== 'bool';
		if (all.length === 2 && num(all[0]) && num(all[1])) return [{ name: 'onchange', when: '$changed', payload: { type: 'num2', expr: `$${all[0].name}`, expr2: `$${all[1].name}` } }];
		return [{ name: 'onchange', when: '$changed', payload: payload_of(bound) }];
	}
	if (ret === 'bool') return [{ name: 'onclick', when: 'r' }];
	if (ret === 'int' && bound?.role === 'buffer') {
		return [
			{ name: 'oninput', when: 'r & CUI_CHANGED', payload: payload_of(bound) },
			{ name: 'onsubmit', when: 'r & CUI_SUBMITTED', payload: payload_of(bound) },
			{ name: 'onfocus', when: 'r & CUI_FOCUSED' },
			{ name: 'onblur', when: 'r & CUI_BLURRED' }
		];
	}
	if (ret === 'int') return [{ name: 'onselect', when: 'r >= 0', payload: { type: 'num', expr: 'r' } }];
	return [];
}

function payload_of(p: ParamSpec): EventSpec['payload'] {
	if (p.role === 'buffer') return { type: 'str', expr: `$${p.name}` };
	if (VALUE_PAYLOAD.has(p.role)) return { type: 'value', expr: `$${p.name}` };
	const k = bind_kind(p.type);
	return { type: k === 'bool' ? 'bool' : 'num', expr: `$${p.name}` };
}

function make(name: string, source: string, o: Override = {}): Spec {
	const macro = api.macros[source];
	let fn_name: string;
	let kind: Spec['kind'] = 'call';
	let end: string | undefined;
	let opts: string | undefined;
	if (macro) {
		fn_name = macro.fn;
		kind = macro.kind;
		end = macro.end;
		opts = macro.opts;
	} else {
		fn_name = o.begin ?? o.fn ?? source;
	}
	if (o.kind) kind = o.kind;
	if (o.end) end = o.end;
	const fn = api.functions[fn_name];
	if (!fn) throw new Error(`cui-svelte specs: ${name} names ${fn_name}, which cui.h does not have`);
	if (!opts) {
		const last = fn.params[fn.params.length - 1];
		const m = last && /^const (cui_\w+) \*$/.exec(last.type);
		if (m && last.name === 'opts') opts = m[1];
	}
	const params = infer_params(fn.params, o, fn_name);
	const fields = opts ? fields_of(opts) : new Map<string, Field>();
	const has_label = params.some((p) => p.role === 'label' || p.role === 'text');
	const has_id = params.some((p) => p.role === 'id');
	const children: Children = o.children ?? (o.children_after ? 'container' : kind === 'call' ? (has_label || has_id ? 'label' : 'none') : 'container');
	return {
		name,
		kind,
		fn: fn_name,
		end,
		opts,
		ret: fn.ret,
		params,
		children,
		events: [...(o.events ?? infer_events(fn.ret, params)), ...(o.more_events ?? [])],
		fields,
		doc: fn.comment,
		buffer_changed: o.buffer_changed,
		buffer_room: o.buffer_room ?? 256,
		end_args: o.end_args,
		end_pre: o.end_pre,
		end_events: o.end_events,
		children_after: o.children_after,
		between: o.between,
		custom: o.custom,
		before_end: o.before_end
	};
}

// ---- the components ------------------------------------------------------------------------

type Entry = [name: string, source: string, o?: Override];

const ev = (name: string, when: string, payload?: EventSpec['payload']): EventSpec => ({ name, when, payload });
const num = (expr: string): EventSpec['payload'] => ({ type: 'num', expr });
const str = (expr: string): EventSpec['payload'] => ({ type: 'str', expr });

const ENTRIES: Entry[] = [
	// ---- layout
	['Box', 'cui_box'],
	['Row', 'cui_row'],
	['Column', 'cui_column'],
	['Card', 'cui_card', { events: [ev('onclick', 'r')] }],
	['Scroll', 'cui_scroll'],
	['Spacer', 'cui_spacer'],
	['Gap', 'cui_gap', { defaults: { size: '8' } }],
	['Separator', 'cui_separator'],
	['ButtonGroup', 'cui_button_group'],
	['Spotlight', 'cui_spotlight'],
	// ---- text
	['Text', 'cui_text'],
	['Heading', 'cui_heading', { defaults: { level: '2' } }],
	['Label', 'cui_label'],
	['Secondary', 'cui_secondary'],
	['Muted', 'cui_muted'],
	['Code', 'cui_code'],
	['Kbd', 'cui_kbd', { props: { keys: 'keys' } }],
	['Link', 'cui_link', { roles: { text: 'label' }, children: 'label' }],
	['Icon', 'cui_icon', { roles: { icon: 'icon' }, props: { icon: 'name' }, defaults: { size: '16', color: 'CUI_COLOR_FOREGROUND' } }],
	['Emoji', 'cui_emoji', { props: { utf8: 'emoji' }, defaults: { size: '20' } }],
	['ShimmerText', 'cui_shimmer_text'],
	['Typewriter', 'cui_typewriter', { events: [ev('oncomplete', 'r')] }],
	['TextReveal', 'cui_text_reveal'],
	['WordRotate', 'cui_word_rotate', { defaults: { interval: '2.0f' } }],
	['NumberRoll', 'cui_number_roll'],
	['GradientText', 'cui_gradient_text'],
	['ExpandableText', 'cui_expandable_text', { events: [ev('onchange', 'r')] }],
	// ---- buttons and actions
	['Button', 'cui_button'],
	['IconButton', 'cui_icon_button', { children: 'none' }],
	['CopyButton', 'cui_copy_button', { events: [ev('oncopy', 'r')] }],
	['HoldButton', 'cui_hold_button'],
	['ConfirmButton', 'cui_confirm_button', { events: [ev('onconfirm', 'r')] }],
	['StatusButton', 'cui_status_button'],
	['SplitButton', 'cui_split_button', { events: [ev('onclick', 'r == 0'), ev('onselect', 'r > 0', num('r - 1'))] }],
	['ToggleGroup', 'cui_toggle_group', { props: { labels: 'items', values: 'value' } }],
	['Segmented', 'cui_segmented', { props: { index: 'value' } }],
	['SpeedDial', 'cui_speed_dial', { props: { actions: 'actions' } }],
	['Reactions', 'cui_reactions', { props: { items: 'items' } }],
	['ThemeSwitcher', 'cui_theme_switcher', { props: { mode: 'value' } }],
	['ThemeToggle', 'cui_theme_toggle'],
	['CommandPalette', 'cui_command_palette', { events: [ev('onselect', 'r >= 0', num('r')), ev('onchange', '$changed', { type: 'bool', expr: '$open' })] }],
	['ResponseActions', 'cui_response_actions', { events: [ev('onaction', 'r != 0', num('r'))] }],
	// ---- selection
	['Checkbox', 'cui_checkbox', { props: { value: 'checked' } }],
	['Switch', 'cui_switch', { props: { value: 'checked' } }],
	['Radio', 'cui_radio', { props: { value: 'group', option: 'value' } }],
	['RadioGroup', 'cui_radio_group', { props: { index: 'value' } }],
	['RadioCards', 'cui_radio_cards', { props: { index: 'value', choices: 'choices' } }],
	['Slider', 'cui_slider', { defaults: { min: '0', max: '100' } }],
	['RangeSlider', 'cui_range_slider', { defaults: { min: '0', max: '100' } }],
	['RulerSlider', 'cui_ruler_slider', { defaults: { min: '0', max: '100' } }],
	['HistogramSlider', 'cui_histogram_slider', { defaults: { min: '0', max: '100' } }],
	['Scrub', 'cui_scrub', { defaults: { min: '0', max: '100' } }],
	['Knob', 'cui_knob', { defaults: { min: '0', max: '1' } }],
	['Fader', 'cui_fader', { defaults: { min: '0', max: '1' } }],
	['Rating', 'cui_rating', { defaults: { max: '5' } }],
	['Chip', 'cui_chip', { props: { selected: 'selected' } }],
	['ControlTile', 'cui_control_tile', { props: { on: 'on' } }],
	['MultiSelect', 'cui_multi_select', { props: { selected: 'value' } }],
	['WheelPicker', 'cui_wheel_picker', { props: { index: 'value' } }],
	// ---- text input
	['Input', 'cui_input'],
	['Textarea', 'cui_textarea'],
	['Search', 'cui_search'],
	['NumberInput', 'cui_number', { defaults: { min: '-1e300', max: '1e300' } }],
	['MoneyInput', 'cui_money_input'],
	['TagInput', 'cui_tag_input', { events: [ev('onchange', 'r', str('$buf'))] }],
	['InlineEdit', 'cui_inline_edit', { events: [ev('onchange', 'r & CUI_CHANGED', str('$buf'))] }],
	['ChatComposer', 'cui_chat_composer', { events: [ev('onsubmit', 'r & 2', str('$buf'))] }],
	['ShortcutRecorder', 'cui_shortcut_recorder', { props: { combo: 'value' } }],
	// ---- select and pickers
	['Select', 'cui_select', { props: { index: 'value' } }],
	['Calendar', 'cui_calendar'],
	['DatePicker', 'cui_date_picker'],
	['DateRangePicker', 'cui_date_range_picker', { props: { range: 'value' } }],
	['RangeCalendar', 'cui_range_calendar', { props: { range: 'value' }, defaults: { months: '2' } }],
	['TimePicker', 'cui_time_picker'],
	['TimeDial', 'cui_time_dial', { defaults: { size: '200' } }],
	['ColorPicker', 'cui_color_picker'],
	['ModelPicker', 'cui_model_picker', { props: { selected: 'value' } }],
	['EmojiPicker', 'cui_emoji_picker', { events: [ev('onselect', 'r != NULL', str('r'))] }],
	// ---- navigation
	['Tabs', 'cui_tabs', { props: { index: 'value' } }],
	['TabBar', 'cui_tab_bar', { props: { selected: 'value' } }],
	['NavItem', 'cui_nav_item'],
	['NavSection', 'cui_nav_section'],
	['Breadcrumb', 'cui_breadcrumb'],
	['Pagination', 'cui_pagination'],
	['Stepper', 'cui_stepper'],
	['PathBar', 'cui_path_bar', { events: [ev('onclick', 'r.clicked >= 0', num('r.clicked')), ev('onsubmit', 'r.submitted != NULL', str('r.submitted'))] }],
	// ---- menus and overlays
	['Menu', 'cui_menu'],
	['ContextMenu', 'cui_context_menu'],
	['MenuItem', 'cui_menu_item'],
	['MenuSeparator', 'cui_menu_separator'],
	['MenuLabel', 'cui_menu_label'],
	['UserMenu', 'cui_user_menu'],
	['Tooltip', 'cui_tooltip', { roles: { text: 'text' }, children: 'text' }],
	['Dialog', 'cui_dialog', { props: { open: 'open' } }],
	['DialogFooter', 'cui_dialog_footer'],
	['Sheet', 'cui_sheet'],
	['HoverCard', 'cui_hover_card'],
	['ConfirmPopover', 'cui_confirm_popover', { events: [ev('onconfirm', 'r')] }],
	['Alert', 'cui_alert', { events: [ev('ondismiss', '!r')] }],
	['Banner', 'cui_banner', { events: [ev('onaction', 'r'), ev('onchange', '$changed', { type: 'bool', expr: '$open' })] }],
	['Tour', 'cui_tour', { events: [ev('onchange', '$changed', num('$step')), ev('ondone', 'r == 3 || r == 4')] }],
	// ---- feedback and display
	['Progress', 'cui_progress'],
	['ProgressRing', 'cui_progress_ring', { defaults: { size: '64' } }],
	['Spinner', 'cui_spinner', { defaults: { size: '20' } }],
	['Skeleton', 'cui_skeleton', { defaults: { width: 'CUI_FILL', height: '16' } }],
	['Loader', 'cui_loader'],
	['Badge', 'cui_badge'],
	['Avatar', 'cui_avatar'],
	['AvatarGroup', 'cui_avatar_group', { defaults: { max_visible: '4', size: '32' } }],
	['EmptyState', 'cui_empty_state'],
	['Metric', 'cui_metric'],
	['Meter', 'cui_meter', { defaults: { unit: '""' } }],
	['PasswordStrength', 'cui_password_strength', { events: [] }],
	['TimelineItem', 'cui_timeline_item'],
	['Countdown', 'cui_countdown'],
	['Counter', 'cui_counter'],
	['Ticker', 'cui_ticker'],
	['Presence', 'cui_presence', { defaults: { max_visible: '4', size: '28' } }],
	// ---- data display
	['Accordion', 'cui_accordion'],
	['ExpandableCard', 'cui_expandable_card'],
	['Tree', 'cui_tree', { events: [ev('onchange', '$changed', { type: 'bool', expr: '$open' }), ev('onclick', 'cui_tree_clicked(ui)')] }],
	['TreeCell', 'cui_tree_cell'],
	['ListItem', 'cui_list_item'],
	['Checklist', 'cui_checklist', { more_events: [ev('onaction', 'r >= 0', num('r'))] }],
	['Toc', 'cui_toc', { roles: { scroll_id: 'text' }, props: { scroll_id: 'scroll' }, events: [] }],
	['TocAnchor', 'cui_toc_anchor', { roles: { anchor: 'text' }, children: 'none' }],
	// ---- code
	['CodeBlock', 'cui_code_block'],
	['JsonView', 'cui_json_view', { events: [] }],
	['Markdown', 'cui_markdown', { events: [] }],
	// an editor's own edits (replace all, indenting a selection) can add more than a paste
	['CodeEditor', 'cui_code_editor', { buffer_changed: 'r.changed', buffer_room: 65536, events: [ev('oninput', 'r.changed', str('$buf'))] }],
	['DiffView', 'cui_diff_view', { events: [] }],
	// ---- charts
	['LineChart', 'cui_line_chart'],
	['BarChart', 'cui_bar_chart'],
	['DonutChart', 'cui_donut_chart'],
	['Sparkline', 'cui_sparkline', { defaults: { width: 'CUI_FILL', height: '32', color: 'CUI_COLOR_ACCENT' } }],
	['Gauge', 'cui_gauge', { defaults: { size: '120' } }],
	['RadialGauge', 'cui_radial_gauge', { defaults: { min: '0', max: '100' } }],
	['Heatmap', 'cui_heatmap'],
	['CalendarHeatmap', 'cui_calendar_heatmap'],
	['Treemap', 'cui_treemap'],
	['RadarChart', 'cui_radar_chart'],
	['Funnel', 'cui_funnel'],
	['Sankey', 'cui_sankey'],
	['Waffle', 'cui_waffle'],
	['SplitBar', 'cui_split_bar'],
	['BarList', 'cui_bar_list'],
	['ActivityRings', 'cui_activity_rings'],
	['ScatterChart', 'cui_scatter_chart'],
	['Candlestick', 'cui_candlestick'],
	['LevelMeter', 'cui_level_meter', { events: [ev('onclear', 'r')] }],
	['Waveform', 'cui_waveform', { events: [ev('onseek', 'r', num('$progress'))] }],
	// ---- media
	['Image', 'cui_image'],
	['ImageViewer', 'cui_image_viewer'],
	['Cropper', 'cui_cropper', { props: { crop: 'value' } }],
	['ImageCompare', 'cui_image_compare', { props: { pos: 'value' } }],
	['Carousel', 'cui_carousel', { props: { index: 'value' } }],
	['CarouselSlide', 'cui_carousel_slide'],
	['NowPlaying', 'cui_now_playing', { props: { np: 'value' }, events: [ev('onaction', 'r != 0', num('r'))] }],
	['SignaturePad', 'cui_signature_pad', { events: [ev('onchange', 'r')] }],
	['Dropzone', 'cui_dropzone', { events: [ev('ondrop', 'r > 0', num('r'))] }],
	// ---- conversation and AI
	['ChatMessage', 'cui_chat_message'],
	['ChatDivider', 'cui_chat_divider'],
	['TypingIndicator', 'cui_typing_indicator'],
	['Comment', 'cui_comment', { events: [ev('onlike', 'r & 1'), ev('onreply', 'r & 2')] }],
	['Reasoning', 'cui_reasoning'],
	['ToolCall', 'cui_tool_call'],
	['AgentPlan', 'cui_agent_plan'],
	['AgentStatus', 'cui_agent_status'],
	['SourceList', 'cui_source_list'],
	['Citation', 'cui_citation'],
	['ContextMeter', 'cui_context_meter'],
	['PromptSuggestions', 'cui_prompt_suggestions'],
	['VoiceOrb', 'cui_voice_orb'],
	// ---- planning
	['WeekCalendar', 'cui_week_calendar', { more_events: [ev('onselect', 'r >= 0', num('r'))] }],
	['Gantt', 'cui_gantt', { more_events: [ev('onselect', 'r >= 0', num('r'))] }],
	// ---- app chrome
	['MenuBar', 'cui_menu_bar'],
	['MenuBarMenu', 'cui_menu_bar_menu'],
	['Toolbar', 'cui_toolbar'],
	['ToolbarButton', 'cui_toolbar_button'],
	['ToolbarSeparator', 'cui_toolbar_separator'],
	['ToolbarSpacer', 'cui_toolbar_spacer'],
	['StatusBar', 'cui_status_bar'],
	['StatusBarText', 'cui_status_bar_text'],
	['StatusBarItem', 'cui_status_bar_item'],
	['StatusBarProgress', 'cui_status_bar_progress'],
	['StatusBarSpacer', 'cui_status_bar_spacer'],
	['Dock', 'cui_dock'],
	['DockItem', 'cui_dock_item'],
	['DockSeparator', 'cui_dock_separator'],
	['Dockspace', 'cui_dockspace'],
	['DockPanel', 'cui_dock_panel'],
	// ---- tool panels
	['Inspector', 'cui_inspector'],
	['InspectorGroup', 'cui_inspector_group', { events: [ev('onchange', '$changed', { type: 'bool', expr: '$open' })] }],
	['PropFloat', 'cui_prop_float'],
	['PropInt', 'cui_prop_int'],
	['PropText', 'cui_prop_text', { events: [ev('onchange', 'r', str('$buf'))] }],
	['PropBool', 'cui_prop_bool'],
	['PropEnum', 'cui_prop_enum', { props: { index: 'value' } }],
	['PropColor', 'cui_prop_color'],
	['PropVec', 'cui_prop_vec_ex', { defaults: { components: '3' } }],
	['HexView', 'cui_hex_view', { props: { sel: 'selection' }, events: [] }],
	['Split', 'cui_split', { props: { ratio: 'ratio' }, defaults: { ratio: '0.5f' }, between: 'cui_split_next(ui);' }],
	// ---- tables, lists and boards
	['Table', 'cui_table', { events: [] }],
	['TableRow', 'cui_table_row', { children_after: true, defaults: { selected: 'false' } }],
	['TableCell', 'cui_table_cell', { custom: 'table_cell' }],
	['VirtualList', 'cui_virtual_list', { custom: 'row_window', props: { n: 'count' } }],
	['DataGrid', 'cui_data_grid_begin', { custom: 'row_window', kind: 'scope_if', end: 'cui_data_grid_end', props: { row_count: 'count' } }],
	['GridCell', 'cui_data_grid_cell', { custom: 'grid_cell' }],
	['Kanban', 'cui_kanban_begin', { kind: 'scope', end: 'cui_kanban_end', end_pre: 'cui_kanban_move mv; memset(&mv, 0, sizeof mv);', end_args: '&mv', end_events: [{ name: 'onmove', when: 'e', payload: { type: 'json', expr: 'cuisv_fmt("{\\"card\\":%d,\\"from_column\\":%d,\\"to_column\\":%d,\\"to_index\\":%d}", mv.card, mv.from_column, mv.to_column, mv.to_index)' } }] }],
	['KanbanColumn', 'cui_kanban_column_begin_ex', { kind: 'scope', end: 'cui_kanban_column_end', props: { card_count: 'count' }, events: [ev('onadd', 'r')] }],
	['KanbanCard', 'cui_kanban_card_begin', { kind: 'scope', end: 'cui_kanban_card_end', props: { card_id: 'id' } }],
	['CardStack', 'cui_card_stack_begin', { kind: 'scope', end: 'cui_card_stack_end', end_events: [{ name: 'onswipe', when: 'e != 0', payload: { type: 'num', expr: 'e' } }] }],
	['CardStackItem', 'cui_card_stack_item'],
	['SwipeItem', 'cui_swipe_item_begin', { kind: 'scope', end: 'cui_swipe_item_end', end_events: [{ name: 'onaction', when: 'e >= 0', payload: { type: 'num', expr: 'e' } }] }],
	['Popover', 'cui_popover', { custom: 'popover' }],
	['MonthCalendar', 'cui_month_calendar', { props: { month: 'month' }, events: [ev('onselect', 'r.event >= 0', num('r.event')), ev('onchange', 'r.month_changed')] }],
	['DocTabs', 'cui_doc_tabs', { props: { selected: 'value' }, events: [ev('onchange', '$changed', num('$selected')), ev('onclose', 'r.close >= 0', num('r.close'))] }],
	// paths: the browser writes a whole one
	['FileBrowser', 'cui_file_browser', { props: { path: 'path' }, buffer_changed: 'r.navigated', buffer_room: 4096, events: [ev('onpick', 'r.picked != NULL', str('r.picked')), ev('onselect', 'r.selected != NULL', str('r.selected')), ev('onnavigate', 'r.navigated', str('$path'))] }],
	['FilePicker', 'cui_file_picker', { props: { out: 'value' }, buffer_changed: 'r', buffer_room: 4096, events: [ev('onpick', 'r', str('$out'))] }],
	['NodeEditor', 'cui_node_editor_begin', {
		kind: 'scope',
		end: 'cui_node_editor_end',
		before_end: {
			pre: 'int ne_from = 0, ne_to = 0, ne_link = 0, ne_node = 0; bool ne_c = cui_node_link_created(ui, &ne_from, &ne_to); bool ne_r = cui_node_link_removed(ui, &ne_link); bool ne_d = cui_node_deleted(ui, &ne_node);',
			events: [
				{ name: 'onconnect', when: 'ne_c', payload: { type: 'json', expr: 'cuisv_fmt("{\\"from\\":%d,\\"to\\":%d}", ne_from, ne_to)' } },
				{ name: 'ondisconnect', when: 'ne_r', payload: { type: 'num', expr: 'ne_link' } },
				{ name: 'ondelete', when: 'ne_d', payload: { type: 'num', expr: 'ne_node' } }
			]
		}
	}],
	['Node', 'cui_node_begin', { kind: 'scope', end: 'cui_node_end', props: { node_id: 'id' } }],
	['NodeInput', 'cui_node_input', { props: { pin_id: 'pin' } }],
	['NodeOutput', 'cui_node_output', { props: { pin_id: 'pin' } }],
	['NodeContent', 'cui_node_content'],
	['Canvas', 'cui_canvas', { custom: 'canvas', events: [] }],
	['LogView', 'cui_log_view', { events: [] }],
	['Terminal', 'cui_terminal', { events: [ev('oncommand', 'r.command != NULL', str('r.command')), ev('oninterrupt', 'r.interrupt')] }],
	['CurveEditor', 'cui_curve_editor', { props: { keys: 'value' } }],
	['GradientEditor', 'cui_gradient_editor', { props: { stops: 'value' } }],
	['FlameGraph', 'cui_flame_graph_ex', { more_events: [ev('onselect', 'r.selection_changed', num('$selected'))] }],
	['FilterBar', 'cui_filter_bar', { props: { selected: 'selected', search: 'search' } }],
	['OtpInput', 'cui_otp_input', { custom: 'otp' }],
	['Reorder', 'cui_reorder_begin', { custom: 'reorder' }],
	// a row's position is counted as the list is built, so rows can be drawn in an order JS has not seen yet
	['ReorderItem', 'cui_reorder_item', { roles: { position: 'skip' }, defaults: { position: 'cuisv_reorder_next()' } }],
	['TreeTable', 'cui_tree_table_begin', { custom: 'tree_table' }],
	['TreeName', 'cui_tree_table_name', { roles: { label: 'text' }, events: [] }],
	['NodeLink', 'cui_node_link', { props: { link_id: 'id', from_pin: 'from', to_pin: 'to' }, events: [] }]
];

export const SPECS = new Map<string, Spec>();
for (const [name, source, o] of ENTRIES) SPECS.set(name, make(name, source, o));

