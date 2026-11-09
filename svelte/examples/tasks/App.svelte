<script lang="ts">
	import { Column, Row, Heading, Muted, Input, Button, IconButton, Checkbox, Tabs, Badge, EmptyState, ThemeToggle, Scroll, toast } from 'cui-svelte';
	import Task from './Task.svelte';
	import { load, save, type Item } from './store.ts';

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
		<ThemeToggle />
	</div>
	<Row gap={8}>
		<Input id="new" bind:value={draft} placeholder="What needs doing?" icon="plus" width="fill" onsubmit={add} />
		<Button variant="primary" onclick={add} disabled={!draft.trim()}>Add</Button>
	</Row>
	<Tabs items={filters} bind:value={filter} variant="pill" />
	<Scroll gap={6} height="fill">
		{#each shown as task (task.id)}
			<Task {task} ondelete={() => remove(task.id)} />
		{:else}
			<EmptyState icon="check" description={filter === 2 ? 'Nothing finished yet.' : 'Add a task above.'}>Nothing here</EmptyState>
		{/each}
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
