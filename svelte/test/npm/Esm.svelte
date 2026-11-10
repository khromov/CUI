<script lang="ts">
	import { formatHex, interpolate, parse } from 'culori';
	import { Column, Text, Button } from 'cui-svelte';

	let t = $state(0);
	const mix = interpolate(['#ff0000', '#0000ff']);
	const hex = $derived(formatHex(mix(t)));
</script>

<Column>
	<Text>parsed={parse('rebeccapurple')?.mode} hex={hex}</Text>
	<Button onclick={() => (t = 1)}>blue</Button>
</Column>
