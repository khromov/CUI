<script lang="ts">
	import { Column, Row, Heading, Muted, Input, Button, IconButton, Checkbox, Tabs, Badge, EmptyState, ThemeToggle, Scroll, Reorder, ReorderItem, toast, get_theme } from 'cui-svelte';
	import Task from './Task.svelte';
	import { load, save, save_theme, type Item } from './store.ts';

	let items = $state<Item[]>(load());
	let draft = $state('');
	let filter = $state(0);
	const filters = ['All', 'Open', 'Done'];

	const shown = $derived(items.filter((t) => (filter === 0 ? true : filter === 1 ? !t.done : t.done)));
	const open = $derived(items.filter((t) => !t.done).length);

	$effect(() => save(items));

	function add() {
		const title = draft.trim();
		if (!title) return;
		items.push({ id: crypto.randomUUID(), title, done: false });
		draft = '';
	}

	// A dragged row lands in its new place. The list may be filtered: the shown tasks take the
	// places they held in the full list, in their new order, and hidden ones stay where they are.
	function reorder(order: number[]) {
		const moved = order.map((i) => shown[i]);
		let k = 0;
		items = items.map((t) => (shown.includes(t) ? moved[k++] : t));
	}

	function remove(id: string) {
		const i = items.findIndex((t) => t.id === id);
		if (i < 0) return;
		const [gone] = items.splice(i, 1);
		toast('Task deleted', { action: 'Undo', show_timer: true, onaction: () => items.splice(i, 0, gone) });
	}
</script>

<Column pad={28} gap={16} height="fill">
	<div class="header">
		<Heading level={2}>Tasks</Heading>
		<Badge tone={open ? 'accent' : 'success'}>{open ? `${open} open` : 'all done'}</Badge>
		<div class="spacer"></div>
		<!-- the toggle switches the theme itself; main.ts opens the window in the one saved here -->
		<ThemeToggle onclick={() => save_theme(get_theme())} />
	</div>
	<Row gap={8}>
		<Input id="new" bind:value={draft} placeholder="What needs doing?" icon="plus" width="fill" onsubmit={add} />
		<Button variant="primary" onclick={add} disabled={!draft.trim()}>Add</Button>
	</Row>
	<Tabs items={filters} bind:value={filter} variant="pill" />
	<Scroll height="fill">
		{#if shown.length}
			<!-- drag a row by its grip (or anywhere but its controls) to move it -->
			<Reorder bind:order={() => shown.map((_, i) => i), reorder}>
				{#each shown as task, position (task.id)}
					<ReorderItem {position}><Task {task} ondelete={() => remove(task.id)} /></ReorderItem>
				{/each}
			</Reorder>
		{:else}
			<EmptyState icon="check" description={filter === 2 ? 'Nothing finished yet.' : 'Add a task above.'}>Nothing here</EmptyState>
		{/if}
	</Scroll>
	<Muted>Saved to this computer as you go.</Muted>
</Column>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.spacer {
		flex: 1;
	}
</style>
