<script lang="ts">
	import { Checkbox, IconButton, InlineEdit } from 'cui-svelte';
	import type { Item } from './store.ts';

	// task is a $state object from the list: editing its fields edits the list
	let { task, ondelete }: { task: Item; ondelete: () => void } = $props();
</script>

<div class="task" class:done={task.done}>
	<Checkbox bind:checked={task.done} />
	<InlineEdit bind:value={task.title} width="fill" />
	<IconButton icon="trash-2" tooltip="Delete" onclick={ondelete} />
</div>

<style>
	.task {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px;
		border-radius: 10px;
		border: 1px solid var(--cui-border-subtle);
		background: var(--cui-surface);
	}
	.task:hover {
		border-color: var(--cui-border-strong);
	}
	.task.done {
		background: var(--cui-surface-muted);
		opacity: 0.7;
	}
</style>
