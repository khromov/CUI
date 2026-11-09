<script>
	let name = $state('');
	let agree = $state(false);
	let color = $state('red');
	let size = $state('m');
	let last = $state('');
	let hovered = $state(false);
	let submitted = $state(0);
	let tab = $state(0);
	const sizes = [{ v: 's', label: 'Small' }, { v: 'm', label: 'Medium' }, { v: 'l', label: 'Large' }];
</script>

<div class="wrap">
	<form onsubmit={(e) => { e.preventDefault(); submitted++; }}>
		<input id="name" bind:value={name} placeholder="Name" />
	</form>
	<input id="dom" oninput={(e) => (last = e.target.value)} />
	<label><input type="checkbox" bind:checked={agree} /> Agree</label>
	<label><input type="radio" bind:group={color} value="red" /> Red</label>
	<label><input type="radio" bind:group={color} value="blue" /> Blue</label>
	<select id="size" bind:value={size}>
		{#each sizes as s (s.v)}
			<option value={s.v}>{s.label}</option>
		{/each}
	</select>
	<div class="hoverable" onmouseenter={() => (hovered = true)} onmouseleave={() => (hovered = false)}>Hover target</div>
	<div class="tabs">
		{#each ['One', 'Two'] as label, i}
			<button class="tab" class:active={tab === i} onclick={() => (tab = i)}>{label}</button>
		{/each}
	</div>
	<p>name={name} agree={agree} color={color} size={size} last={last} hovered={hovered} submitted={submitted} tab={tab}</p>
</div>

<style>
	.wrap { padding: 10px; gap: 6px; }
	.hoverable { padding: 8px; }
	.tabs { display: flex; gap: 4px; }
	.tab.active { background: #ff0000; }
</style>
