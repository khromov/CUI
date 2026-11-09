// Tasks persist in localStorage: a JSON file in the app's data folder natively, the
// browser's own storage in the web build.
export interface Item {
	id: string;
	title: string;
	done: boolean;
}

const KEY = 'tasks';

export function load(): Item[] {
	try {
		const saved = localStorage.getItem(KEY);
		if (saved) return JSON.parse(saved);
	} catch {
		/* first run */
	}
	return [
		{ id: '1', title: 'Write the renderer', done: true },
		{ id: '2', title: 'Try the web build', done: false },
		{ id: '3', title: 'Ship it', done: false }
	];
}

export function save(items: Item[]) {
	localStorage.setItem(KEY, JSON.stringify(items));
}

/** The theme picked with the toggle last time; light until then. */
export function saved_theme(): 'light' | 'dark' {
	return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
}

export function save_theme(theme: 'light' | 'dark') {
	localStorage.setItem('theme', theme);
}
