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
	/* the row inside the list's card (ReorderItem draws the card and the grip) */
	.task {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
	}
	.task.done {
		opacity: 0.55;
	}
</style>
