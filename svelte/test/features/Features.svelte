<script lang="ts">
	import { setContext, onMount, untrack } from 'svelte';
	import { Column, Row, Text, Button, Switch, Slider, Input, Scroll, on_key } from 'cui-svelte';
	import Child from './Child.svelte';

	setContext('theme', 'midnight');
	let on = $state(false);
	let volume = $state(25);
	let name = $state('Ada');
	let items = $state([{ id: 1, label: 'apple' }, { id: 2, label: 'banana' }, { id: 3, label: 'cherry' }]);
	let n = $state(0);
	let shared = $state(5);
	let bumps = $state(0);
	let mounted = $state('no');
	let ticks = $state(0);
	let effect_runs = $state(0);
	let promise: Promise<string> = $state(new Promise((r) => setTimeout(() => r('loaded'), 30)));
	let key = $state(0);
	const doubled = $derived(n * 2);
	let shortcut = $state('');
	$effect(() => on_key((e) => (shortcut = `${e.key}${e.ctrl ? ' ctrl' : ''}`)));

	$effect(() => {
		void n;
		untrack(() => effect_runs++);
	});
	onMount(() => {
		mounted = 'yes';
		const id = setInterval(() => ticks++, 10);
		return () => clearInterval(id);
	});
</script>

{#snippet badge(label: string)}
	<Text>badge:{label}</Text>
{/snippet}

<Column gap={2}>
	<Switch bind:checked={on}>Power</Switch>
	<Text>power={on ? 'on' : 'off'}</Text>
	<Slider bind:value={volume} min={0} max={100}>Volume</Slider>
	<Text>volume={Math.round(volume)}</Text>
	<Input id="name" bind:value={name} placeholder="name" />
	<Text>name={name}</Text>
	<Row gap={4}>
		<Button onclick={() => n++}>inc</Button>
		<Button onclick={() => items.reverse()}>reverse</Button>
		<Button onclick={() => items.splice(0, items.length)}>clear</Button>
		<Button onclick={() => key++}>rekey</Button>
	</Row>
	<Text>n={n} doubled={doubled} effects={effect_runs} mounted={mounted}</Text>
	{#if n === 0}
		<Text>zero</Text>
	{:else if n === 1}
		<Text>one</Text>
	{:else}
		<Text>many</Text>
	{/if}
	{#each items as item, i (item.id)}
		<Text>item {i}={item.label}</Text>
	{:else}
		<Text>no items</Text>
	{/each}
	{#await promise}
		<Text>waiting</Text>
	{:then v}
		<Text>promise={v}</Text>
	{/await}
	{#key key}
		<Text>keyed {key}</Text>
	{/key}
	{@render badge('first')}
	{@render badge(`n${n}`)}
	<Child title="A" bind:value={shared} onbump={() => bumps++}>
		<Text>child content n={n}</Text>
		{#snippet footer(v)}
			<Text>footer {v}</Text>
		{/snippet}
	</Child>
	<Text>shared={shared} bumps={bumps}</Text>
	<Text>ticking={ticks > 0 ? 'yes' : 'no'}</Text>
	<Text>shortcut={shortcut}</Text>
	<Scroll id="list" height={40}>
		{#each Array.from({ length: 12 }, (_, i) => i) as i (i)}
			<Text>scroll row {i}</Text>
		{/each}
	</Scroll>
	<div id="pane" style="overflow-y: auto; height: 40px">
		{#each Array.from({ length: 12 }, (_, i) => i) as i (i)}
			<p>pane line {i}</p>
		{/each}
	</div>
</Column>
