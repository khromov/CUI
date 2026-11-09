<script>
	import { Column, Row, Heading, Secondary, Switch, Button, Text } from 'cui-svelte';
	let notifications = $state(true);
	let clicks = $state(0);
	let items = $state(['one', 'two']);
</script>

<Column pad={32} gap={16} width="fill">
	<Heading level={2}>Hello, CUI</Heading>
	<Secondary>A native window, a few components and no dependencies.</Secondary>
	<Switch bind:checked={notifications}>Notifications</Switch>
	<Row gap={8}>
		<Button variant="primary" onclick={() => clicks++}>Click me</Button>
		<Text>Clicked {clicks} times</Text>
	</Row>
	{#if clicks > 3}
		<Text>That is a lot of clicks</Text>
	{/if}
	{#each items as item, i (item)}
		<Text>{i}: {item}</Text>
	{/each}
</Column>
