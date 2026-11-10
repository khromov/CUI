/**
 * Replaces svelte/src/internal/client/proxy.js in scriptc builds.
 *
 * scriptc's native Proxy takes plain objects as targets, not arrays, so `$state([...])`
 * cannot be svelte's own array proxy. Objects keep svelte's proxy (the code below follows
 * upstream, minus its array branches and dev-only labels) over a copy of the object, see
 * proxy(). An array becomes a Proxy over an
 * empty object that answers like an array from a copy it owns:
 *
 * - one version signal for the whole array instead of a signal per index: every read
 *   depends on it and every write increments it, so a change to one index re-runs whatever
 *   read any part of the array (keyed `{#each}` still only touches the rows that changed);
 * - `Array.isArray` is redirected by the build (src/scriptc/globals.ts) so that it answers
 *   true for these, in svelte and in the app; `instanceof Array` is false;
 * - the array methods are the ones named in `methods` below; a callback's third argument is
 *   the copy, not the proxy.
 *
 * `JSON.stringify` is redirected the same way (json_stringify): a Proxy cannot be serialized
 * by scriptc, so state is snapshotted first.
 */
import { get, active_effect, update_version, active_reaction, set_update_version, set_active_reaction } from './runtime.js';
// `proxies` and `arrays`: every proxy made here, and the array stand-ins among them. They
// live in utils.js (the build adds them, see src/cli/scriptc.ts) so that its
// get_prototype_of can answer for a proxy, which scriptc's Object.getPrototypeOf cannot.
// Sets rather than a `STATE_SYMBOL in value` test: scriptc throws for a symbol `in` some
// native values.
import { array_prototype, get_descriptor, get_prototype_of, object_prototype, cuisv_proxies as proxies, cuisv_arrays as arrays } from '../shared/utils.js';
import { state as source, set, increment } from './reactivity/sources.js';
import { COMPONENT_SYMBOL, STATE_SYMBOL } from '#client/constants';
import { UNINITIALIZED } from '../../constants.js';
import * as e from './errors.js';
import { snapshot } from '../shared/clone.js';

/** Array.isArray for the bundle: real arrays and `$state` arrays. */
export function is_array_like_state(value) {
	if (value instanceof Array) return true;
	return typeof value === 'object' && value !== null && arrays.has(value);
}

/**
 * JSON.stringify for the bundle (redirected like Array.isArray): scriptc refuses to
 * serialize a Proxy, so `$state` is copied to plain objects and arrays first.
 */
export function json_stringify(value, replacer, space) {
	var json = JSON;
	return json.stringify(typeof value === 'object' && value !== null ? snapshot(value, true, true) : value, replacer, space);
}

export function proxy(value) {
	if (typeof value !== 'object' || value === null || proxies.has(value)) return value;

	const prototype = get_prototype_of(value);
	if (prototype === array_prototype) return array_proxy(value);
	if (prototype !== object_prototype || COMPONENT_SYMBOL in value) return value;

	// An object whose shape scriptc knew where it was written is a native record, which a
	// Proxy cannot trap; a copy made key by key is a plain object. Upstream never writes to
	// its target either (the signals hold what changed), so the copy stands in for it; an
	// accessor of the original is read once, here.
	var target_copy = {};
	for (var own_key of Object.keys(value)) target_copy[own_key] = value[own_key];

	var sources = new Map();
	var version = source(0);
	var parent_version = update_version;

	/** Runs `fn` in the context of the reaction the proxy was created in, if any. */
	var with_parent = (fn) => {
		if (update_version === parent_version) return fn();
		var reaction = active_reaction;
		var version = update_version;
		set_active_reaction(null);
		set_update_version(parent_version);
		var result = fn();
		set_active_reaction(reaction);
		set_update_version(version);
		return result;
	};

	var has_trap = (target, prop) => {
		if (prop === STATE_SYMBOL) return true;
		var s = sources.get(prop);
		var has = (s !== undefined && s.v !== UNINITIALIZED) || Reflect.has(target, prop);
		if (s !== undefined || ((active_effect !== null || active_reaction !== null) && (!has || get_descriptor(target, prop)?.writable))) {
			if (s === undefined) {
				s = with_parent(() => source(has ? proxy(target[prop]) : UNINITIALIZED));
				sources.set(prop, s);
			}
			if (get(s) === UNINITIALIZED) return false;
		}
		return has;
	};

	var self = new Proxy(target_copy, {
		defineProperty(_, prop, descriptor) {
			if (!('value' in descriptor) || descriptor.configurable === false || descriptor.enumerable === false || descriptor.writable === false) {
				e.state_descriptors_fixed();
			}
			var s = sources.get(prop);
			if (s === undefined) {
				with_parent(() => {
					var s = source(descriptor.value);
					sources.set(prop, s);
					return s;
				});
			} else {
				set(s, descriptor.value, true);
			}
			return true;
		},

		deleteProperty(target, prop) {
			var s = sources.get(prop);
			if (s === undefined) {
				if (prop in target) {
					const s = with_parent(() => source(UNINITIALIZED));
					sources.set(prop, s);
					increment(version);
				}
			} else {
				set(s, UNINITIALIZED);
				increment(version);
			}
			return true;
		},

		get(target, prop) {
			if (prop === STATE_SYMBOL) return value;
			var s = sources.get(prop);
			var exists = prop in target;
			// a source only for an own property, not for one of the prototype
			if (s === undefined && (!exists || get_descriptor(target, prop)?.writable)) {
				s = with_parent(() => source(proxy(exists ? target[prop] : UNINITIALIZED)));
				sources.set(prop, s);
			}
			if (s !== undefined) {
				var v = get(s);
				return v === UNINITIALIZED ? undefined : v;
			}
			return target[prop];
		},

		getOwnPropertyDescriptor(target, prop) {
			has_trap(target, prop);
			var descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
			var s = sources.get(prop);
			if (s !== undefined) {
				var value = get(s);
				if (value === UNINITIALIZED) return undefined;
				if (descriptor && 'value' in descriptor) descriptor.value = value;
				else return { enumerable: true, configurable: true, value, writable: true };
			}
			return descriptor;
		},

		has: has_trap,

		set(target, prop, value, receiver) {
			var s = sources.get(prop);
			var has = prop in target;
			if (s === undefined) {
				if (!has || get_descriptor(target, prop)?.writable) {
					s = with_parent(() => source(undefined));
					set(s, proxy(value));
					sources.set(prop, s);
				}
			} else {
				has = s.v !== UNINITIALIZED;
				var p = with_parent(() => proxy(value));
				set(s, p);
			}
			var descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
			if (descriptor?.set) descriptor.set.call(receiver, value);
			if (!has) increment(version);
			return true;
		},

		ownKeys(target) {
			get(version);
			var own_keys = Reflect.ownKeys(target).filter((key) => {
				var source = sources.get(key);
				return source === undefined || source.v !== UNINITIALIZED;
			});
			for (var [key, source] of sources) {
				if (source.v !== UNINITIALIZED && !(key in target)) own_keys.push(key);
			}
			return own_keys;
		},

		setPrototypeOf() {
			e.state_prototype_fixed();
		}
	});
	proxies.add(self);
	return self;
}

/** "12" -> 12; -1 for anything that is not an array index. */
function index_of(prop) {
	if (typeof prop !== 'string' || prop === '') return -1;
	var n = Number(prop);
	return Number.isInteger(n) && n >= 0 && String(n) === prop ? n : -1;
}

function array_proxy(value) {
	/** The array's content: the items, each a proxy itself where it can be. */
	var arr = [];
	for (var i = 0; i < value.length; i++) arr.push(proxy(value[i]));
	var version = source(0);

	var read = () => {
		get(version);
		return arr;
	};
	var wrote = () => {
		increment(version);
	};
	var all = (items) => {
		var out = [];
		for (var i = 0; i < items.length; i++) out.push(proxy(items[i]));
		return out;
	};

	var methods = {
		// reads
		at: (i) => read().at(i),
		concat: (...rest) => read().concat(...rest.map((r) => (is_array_like_state(r) ? Array.from(r) : r))),
		entries: () => read().entries(),
		every: (f) => read().every(f),
		filter: (f) => read().filter(f),
		find: (f) => read().find(f),
		findIndex: (f) => read().findIndex(f),
		findLast: (f) => read().findLast(f),
		findLastIndex: (f) => read().findLastIndex(f),
		flat: (depth = 1) => read().flat(depth),
		flatMap: (f) => read().flatMap(f),
		forEach: (f) => read().forEach(f),
		includes: (v, from = 0) => read().includes(v, from),
		indexOf: (v, from = 0) => read().indexOf(v, from),
		join: (sep = ',') => read().join(sep),
		keys: () => read().keys(),
		lastIndexOf: (v) => read().lastIndexOf(v),
		map: (f) => read().map(f),
		reduce: (...args) => (args.length > 1 ? read().reduce(args[0], args[1]) : read().reduce(args[0])),
		reduceRight: (...args) => (args.length > 1 ? read().reduceRight(args[0], args[1]) : read().reduceRight(args[0])),
		slice: (start = 0, end = arr.length) => read().slice(start, end),
		some: (f) => read().some(f),
		toReversed: () => read().slice().reverse(),
		toSorted: (f) => (f ? read().slice().sort(f) : read().slice().sort()),
		toSpliced: (start, count, ...items) => {
			var copy = read().slice();
			copy.splice(start, count === undefined ? copy.length : count, ...items);
			return copy;
		},
		toString: () => read().join(','),
		toLocaleString: () => read().join(','),
		toJSON: () => read().slice(),
		values: () => read().values(),
		with: (i, v) => {
			var copy = read().slice();
			copy[i < 0 ? copy.length + i : i] = v;
			return copy;
		},
		// writes
		push: (...items) => {
			for (var i = 0; i < items.length; i++) arr.push(proxy(items[i]));
			wrote();
			return arr.length;
		},
		pop: () => {
			var v = arr.pop();
			wrote();
			return v;
		},
		shift: () => {
			var v = arr.shift();
			wrote();
			return v;
		},
		unshift: (...items) => {
			arr.unshift(...all(items));
			wrote();
			return arr.length;
		},
		splice: (start, count, ...items) => {
			var removed = arr.splice(start, count === undefined ? arr.length : count, ...all(items));
			wrote();
			return removed;
		},
		sort: (f) => {
			if (f) arr.sort(f);
			else arr.sort();
			wrote();
			return self;
		},
		reverse: () => {
			arr.reverse();
			wrote();
			return self;
		},
		fill: (v, start = 0, end = arr.length) => {
			arr.fill(proxy(v), start, end);
			wrote();
			return self;
		},
		copyWithin: (to, start, end = arr.length) => {
			arr.copyWithin(to, start, end);
			wrote();
			return self;
		}
	};

	var self = new Proxy(
		{},
		{
			get(_, prop) {
				if (prop === STATE_SYMBOL) return value;
				if (prop === 'length') return read().length;
				if (prop === Symbol.iterator) return () => read().values();
				var i = index_of(prop);
				if (i >= 0) return read()[i];
				if (typeof prop === 'string' && Object.hasOwn(methods, prop)) return methods[prop];
				return undefined;
			},
			set(_, prop, v) {
				if (prop === 'length') {
					arr.length = v;
					wrote();
					return true;
				}
				var i = index_of(prop);
				if (i < 0) return false;
				arr[i] = proxy(v);
				wrote();
				return true;
			},
			has(_, prop) {
				if (prop === STATE_SYMBOL || prop === 'length') return true;
				var i = index_of(prop);
				return i >= 0 && i < read().length;
			},
			deleteProperty(_, prop) {
				var i = index_of(prop);
				if (i >= 0 && i < arr.length) {
					arr[i] = undefined;
					wrote();
				}
				return true;
			},
			ownKeys() {
				var keys = [];
				var n = read().length;
				for (var i = 0; i < n; i++) keys.push(String(i));
				return keys;
			},
			getOwnPropertyDescriptor(_, prop) {
				var i = index_of(prop);
				if (i < 0 || i >= read().length) return undefined;
				return { enumerable: true, configurable: true, writable: true, value: arr[i] };
			},
			defineProperty() {
				e.state_descriptors_fixed();
			},
			setPrototypeOf() {
				e.state_prototype_fixed();
			}
		}
	);
	proxies.add(self);
	arrays.add(self);
	return self;
}

export function get_proxied_value(value) {
	return value !== null && typeof value === 'object' && proxies.has(value) ? value[STATE_SYMBOL] : value;
}

export function is(a, b) {
	return Object.is(get_proxied_value(a), get_proxied_value(b));
}
