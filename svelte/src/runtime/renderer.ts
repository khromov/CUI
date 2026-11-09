/**
 * The Svelte custom renderer for compiled skeletons.
 *
 * A component's markup is C; what Svelte renders here is its skeleton: one `<t…>` element
 * per live template (component root, block branch, each item, snippet render) whose
 * attributes are that template's slot values, and `<s…>` elements for its sites. The
 * renderer keeps that tree in JS (Svelte walks siblings and anchors) and mirrors the parts C
 * needs: scopes, their order in each site, and slot values.
 *
 *   <t3735928559 s0={label} n1={count} f2={onclick}>   scope of template 3735928559
 *     <s0> …child scopes… </s0>                          its site 0
 *   </t3735928559>
 *
 * Attribute names carry the slot kind and index: n (number), s (string), b (boolean),
 * f (function), g<i>v<j> (setter for the bound value in slot j), a (string array),
 * d (number array), o (packed records).
 *
 * C scopes are created when a template element becomes reachable from the root and freed in
 * commit() once it has stayed out of the tree, because Svelte removes and re-inserts nodes in
 * consecutive steps and renders some offscreen.
 */

import { createRenderer } from 'svelte/renderer';
import { flushSync } from 'svelte';
import { native, hooks } from './bridge.ts';

type NodeKind = 'fragment' | 'element' | 'text' | 'comment';

export class CNode {
	kind: NodeKind;
	name = '';
	value = '';
	parent: CNode | null = null;
	first: CNode | null = null;
	last: CNode | null = null;
	next: CNode | null = null;
	prev: CNode | null = null;
	/** Template id for `<t…>` elements, -1 otherwise. */
	template = -1;
	/** Site index for `<s…>` elements, -1 otherwise. */
	site = -1;
	/** C scope handle while materialized (template elements; the root site's owner). */
	handle = 0;
	root = false;
	attrs: Map<string, unknown> | null = null;

	constructor(kind: NodeKind) {
		this.kind = kind;
	}
}

interface SlotKey {
	kind: string;
	slot: number;
	bound: number;
}

const slot_keys = new Map<string, SlotKey | null>();

function slot_key(name: string): SlotKey | null {
	let k = slot_keys.get(name);
	if (k !== undefined) return k;
	k = null;
	const m = /^([nsbfadoc])(\d+)$/.exec(name);
	if (m) k = { kind: m[1], slot: Number(m[2]), bound: -1 };
	const g = /^g(\d+)v(\d+)$/.exec(name);
	if (g) k = { kind: 'g', slot: Number(g[1]), bound: Number(g[2]) };
	slot_keys.set(name, k);
	return k;
}

const by_handle = new Map<number, CNode>();
const pending = new Set<CNode>();
let root_site: CNode | null = null;
let warned = new Set<string>();

function warn_once(msg: string) {
	if (warned.has(msg)) return;
	warned.add(msg);
	console.warn(`cui-svelte: ${msg}`);
}

/** The site node apps mount into: site 0 of the C root scope. */
export function root_target(): CNode {
	if (root_site) return root_site;
	const owner = new CNode('element');
	owner.name = 'root';
	owner.root = true;
	owner.handle = native().root();
	const site = new CNode('element');
	site.name = 's0';
	site.site = 0;
	site.parent = owner;
	owner.first = owner.last = site;
	root_site = site;
	return site;
}

/** The scope element that owns a site, when it is materialized. */
function site_owner(site: CNode): CNode | null {
	const owner = site.parent;
	if (!owner || owner.kind !== 'element') return null;
	if (owner.root) return owner;
	return owner.template >= 0 && owner.handle ? owner : null;
}

function push_slot(handle: number, name: string, value: unknown, b = native()) {
	const k = slot_key(name);
	if (!k) return;
	const i = k.slot;
	switch (k.kind) {
		case 'n':
		case 'c':
			if (value == null || value === false || (typeof value === 'number' && Number.isNaN(value))) b.unset(handle, i);
			else b.num(handle, i, Number(value));
			break;
		case 's':
			if (value == null || value === false) b.unset(handle, i);
			else b.str(handle, i, String(value));
			break;
		case 'b':
			b.bool(handle, i, !!value);
			break;
		case 'f':
		case 'g':
			b.fn(handle, i, typeof value === 'function');
			break;
		case 'a':
			if (value == null) b.unset(handle, i);
			else b.strs(handle, i, Array.from(value as ArrayLike<unknown>, (v) => (v == null ? '' : String(v))));
			break;
		case 'd':
			if (value == null) b.unset(handle, i);
			else b.floats(handle, i, value instanceof Float32Array ? value : Float32Array.from(value as ArrayLike<number>, Number));
			break;
		case 'o':
			if (value == null) b.unset(handle, i);
			else b.blob(handle, i, value as Uint8Array);
			break;
	}
}

/** Creates the C scope for a template element and everything below it, then pushes slots. */
function materialize(node: CNode) {
	pending.delete(node);
	// a detached scope that comes back before commit() still has its C scope and children
	if (node.handle) return;
	const b = native();
	node.handle = b.scope(node.template);
	if (!node.handle) return;
	by_handle.set(node.handle, node);
	if (node.attrs) for (const [name, value] of node.attrs) push_slot(node.handle, name, value, b);
	// sites of this template, and the scopes already in them
	for (let site = node.first; site; site = site.next) {
		if (site.kind !== 'element' || site.site < 0) continue;
		attach_children(site);
	}
}

/** Inserts every template element under a site node into C, in order. */
function attach_children(site: CNode) {
	const owner = site_owner(site);
	if (!owner) return;
	for (let c = site.first; c; c = c.next) {
		for (const t of template_elements(c)) {
			materialize(t);
			if (t.handle) native().insert(owner.handle, site.site, t.handle, 0);
		}
	}
}

/** Template elements a node contributes to its site (itself, or a fragment's children). */
function* template_elements(node: CNode): Generator<CNode> {
	if (node.kind === 'element' && node.template >= 0) yield node;
	else if (node.kind === 'fragment') for (let c = node.first; c; c = c.next) yield* template_elements(c);
}

/** The next materialized template element after `node` in its site, as a C anchor. */
function next_scope_handle(node: CNode): number {
	for (let n = node.next; n; n = n.next) {
		if (n.kind === 'element' && n.template >= 0 && n.handle) return n.handle;
	}
	return 0;
}

function is_live(node: CNode): boolean {
	for (let n: CNode | null = node; n; n = n.parent) {
		if (n.root) return true;
	}
	return false;
}

function dematerialize(node: CNode) {
	if (node.handle) by_handle.delete(node.handle);
	node.handle = 0;
	for (let c = node.first; c; c = c.next) dematerialize(c);
}

/** Called by the host after every JS turn: frees the scopes that stayed out of the tree. */
export function commit() {
	if (!pending.size) return;
	const b = native();
	for (const node of pending) {
		if (node.handle && !is_live(node)) {
			b.free(node.handle);
			dematerialize(node);
		}
	}
	pending.clear();
}

function attached(parent: CNode, node: CNode) {
	// a template element entering a live site goes to C at its place among its siblings
	if (parent.kind !== 'element' || parent.site < 0) {
		// a site element entering a materialized template: attach what it already holds
		if (node.kind === 'element' && node.site >= 0 && parent.template >= 0 && parent.handle) attach_children(node);
		return;
	}
	const owner = site_owner(parent);
	if (!owner) return;
	for (const t of template_elements(node)) {
		materialize(t);
		if (t.handle) native().insert(owner.handle, parent.site, t.handle, next_scope_handle(t));
	}
}

function detached(parent: CNode, node: CNode) {
	if (parent.kind !== 'element' || parent.site < 0) return;
	for (const t of template_elements(node)) {
		if (t.handle) {
			native().detach(t.handle);
			pending.add(t);
		}
	}
}

function unlink(node: CNode) {
	const p = node.parent;
	if (!p) return;
	if (node.prev) node.prev.next = node.next;
	else p.first = node.next;
	if (node.next) node.next.prev = node.prev;
	else p.last = node.prev;
	node.parent = node.prev = node.next = null;
	detached(p, node);
}

function link(parent: CNode, node: CNode, anchor: CNode | null) {
	if (node.parent) unlink(node);
	node.parent = parent;
	if (anchor && anchor.parent === parent) {
		node.next = anchor;
		node.prev = anchor.prev;
		if (anchor.prev) anchor.prev.next = node;
		else parent.first = node;
		anchor.prev = node;
	} else {
		node.prev = parent.last;
		node.next = null;
		if (parent.last) parent.last.next = node;
		else parent.first = node;
		parent.last = node;
	}
	attached(parent, node);
}

const renderer = createRenderer<{ fragment: CNode; element: CNode; text: CNode; comment: CNode }>({
	createFragment() {
		return new CNode('fragment');
	},
	createElement(name) {
		const n = new CNode('element');
		n.name = name;
		if (name.charCodeAt(0) === 116 /* t */) n.template = Number(name.slice(1)) >>> 0;
		else if (name.charCodeAt(0) === 115 /* s */) n.site = Number(name.slice(1));
		else warn_once(`unexpected element <${name}> in a skeleton`);
		return n;
	},
	createTextNode(data) {
		const n = new CNode('text');
		n.value = data;
		return n;
	},
	createComment(data) {
		const n = new CNode('comment');
		n.value = data;
		return n;
	},
	nodeType(node) {
		return node.kind;
	},
	getNodeValue(node) {
		return node.kind === 'text' || node.kind === 'comment' ? node.value : null;
	},
	getAttribute(el, name) {
		const v = el.attrs?.get(name);
		return v == null ? null : String(v);
	},
	setAttribute(el, name, value) {
		(el.attrs ??= new Map()).set(name, value);
		if (el.handle && el.template >= 0) push_slot(el.handle, name, value);
	},
	removeAttribute(el, name) {
		el.attrs?.delete(name);
		if (el.handle && el.template >= 0) push_slot(el.handle, name, null);
	},
	hasAttribute(el, name) {
		return !!el.attrs?.has(name);
	},
	setText(node, text) {
		if (node.kind === 'element') {
			while (node.first) unlink(node.first);
			if (text) warn_once('text content on a skeleton element is ignored');
		} else {
			node.value = text;
		}
	},
	getFirstChild(el) {
		return el.first;
	},
	getLastChild(el) {
		return el.last;
	},
	getNextSibling(node) {
		return node.next;
	},
	insert(parent, node, anchor) {
		if (node.kind === 'fragment') {
			let c = node.first;
			while (c) {
				const next = c.next;
				link(parent, c, anchor);
				c = next;
			}
			return;
		}
		link(parent, node, anchor);
	},
	remove(node) {
		unlink(node);
	},
	getParent(node) {
		return node.parent;
	},
	addEventListener(_el, type) {
		warn_once(`event listener "${type}" on a skeleton element is ignored`);
	},
	removeEventListener() {}
});

export default renderer;

/** C reported an event for a slot of a scope: call the function the skeleton set there. */
function dispatch(handle: number, slot: number, ...args: unknown[]) {
	if (handle === 0) {
		// a key (cuisv_collect_keys): slot is the cui_key, args[0] the modifiers
		hooks().key?.(slot, Number(args[0]));
		flushSync();
		return;
	}
	const node = by_handle.get(handle);
	if (!node?.attrs) return;
	let fn: unknown;
	let bound = -1;
	let bound_name = '';
	for (const [name, value] of node.attrs) {
		const k = slot_key(name);
		if (k && k.slot === slot && (k.kind === 'f' || k.kind === 'g')) {
			fn = value;
			if (k.kind === 'g') bound = k.bound;
			break;
		}
	}
	if (bound >= 0) {
		for (const name of node.attrs.keys()) {
			const k = slot_key(name);
			if (k && k.slot === bound && k.kind !== 'f' && k.kind !== 'g') {
				bound_name = name;
				break;
			}
		}
	}
	if (typeof fn === 'function') {
		try {
			fn(...args);
		} catch (e) {
			console.error(e);
		}
	}
	flushSync();
	// a setter that kept the old value (or changed it to something else) leaves C holding
	// what the user did: send the current value back
	if (bound_name && node.handle) push_slot(node.handle, bound_name, node.attrs.get(bound_name));
}

/** The function a scope holds in a slot (for <Canvas onpaint>). */
export function scope_fn(handle: number, slot: number): unknown {
	const node = by_handle.get(handle);
	if (!node?.attrs) return undefined;
	for (const [name, value] of node.attrs) {
		const k = slot_key(name);
		if (k && k.slot === slot && k.kind === 'f') return value;
	}
	return undefined;
}

const h = hooks();
h.dispatch = dispatch;
h.commit = commit;
