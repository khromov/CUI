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
	const fruits = [{ id: 'a', name: 'Apple' }, { id: 'b', name: 'Banana' }];
	let fruit = $state('');
	let nullcheck = $state('untouched');
	const px = (n) => n * 40;
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
	<select id="fruit" bind:value={fruit}>
		<option value="">Choose a fruit</option>
		{#each fruits as f (f.id)}
			<option value={f.id}>{f.name}</option>
		{/each}
		<option value="z">Something else</option>
	</select>
	<label><input type="checkbox" checked={null} onchange={(e) => (nullcheck = String(e.target.checked))} /> Null start</label>
	<p hidden={null}>hidden=null shows</p>
	<ol start={3}>
		<li>three</li>
		{#each ['four', 'five'] as x (x)}
			<li>{x}</li>
		{/each}
		<li>six <ul><li>inner</li></ul></li>
	</ol>
	<p>fruit={fruit} nullcheck={nullcheck}</p>
	<!-- markup that once made C that did not compile: the build warns and leaves the value out -->
	<div id="a*/b" style="width: {px(`${fruit}?`.length)}px">comment <span>end</span></div>
	<input id="c*/d" />
	<input id="half" type="range" value="half" />
	<p style="line-height: x%">line height</p>
</div>

<style>
	.wrap { padding: 10px; gap: 6px; }
	.hoverable { padding: 8px; }
	.tabs { display: flex; gap: 4px; }
	.tab.active { background: #ff0000; }
</style>
