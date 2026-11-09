<script lang="ts">
	import { getContext } from 'svelte';
	import { Column, Text, Button } from 'cui-svelte';
	import type { Snippet } from 'svelte';

	let { title, value = $bindable(0), onbump, children, footer }: {
		title: string;
		value?: number;
		onbump?: (n: number) => void;
		children?: Snippet;
		footer?: Snippet<[number]>;
	} = $props();
	const theme = getContext<string>('theme');
</script>

<Column gap={4}>
	<Text>Child {title} value={value} theme={theme}</Text>
	<Button onclick={() => { value += 10; onbump?.(value); }}>Bump {title}</Button>
	{@render children?.()}
	{@render footer?.(value)}
</Column>
