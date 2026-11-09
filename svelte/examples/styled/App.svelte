<script>
	let count = $state(0);
	let name = $state('Ada');
	let agree = $state(true);
	let plan = $state('pro');
	let level = $state(40);
	let selected = $state(1);
	const items = ['Inbox', 'Starred', 'Archive'];
</script>

<main class="page">
	<header class="top">
		<h1>Settings</h1>
		<span class="badge">beta</span>
	</header>
	<section class="card">
		<h3>Profile</h3>
		<p class="muted">Changes save as you type.</p>
		<label>Name <input bind:value={name} placeholder="Your name" /></label>
		<label><input type="checkbox" bind:checked={agree} /> Email me about updates</label>
		<select bind:value={plan}>
			<option value="free">Free</option>
			<option value="pro">Pro</option>
			<option value="team">Team</option>
		</select>
		<input type="range" min="0" max="100" bind:value={level} />
		<p>Hello <strong>{name}</strong>, plan {plan}, level {Math.round(level)}, agree {agree}</p>
	</section>
	<nav class="tabs">
		{#each items as item, i}
			<button class="tab" class:active={selected === i} onclick={() => (selected = i)}>{item}</button>
		{/each}
	</nav>
	<div class="row">
		<button class="primary" onclick={() => count++}>Clicked {count}</button>
		<button onclick={() => (count = 0)}>Reset</button>
		<div class="spacer"></div>
		<a href="https://svelte.dev">svelte.dev</a>
	</div>
	<ul>
		<li>Plain C</li>
		<li>Svelte 5 runes</li>
	</ul>
</main>

<style>
	:root {
		--cui-accent: #7747ff;
		--cui-radius-control: 8px;
	}
	@media (prefers-color-scheme: dark) {
		.badge {
			background: #3b2a7a;
			color: #d6ccff;
		}
	}
	.page {
		padding: 32px;
		gap: 16px;
		background: var(--cui-background);
	}
	.top {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	h1 {
		font-size: 28px;
	}
	.badge {
		background: var(--cui-accent-subtle);
		color: var(--cui-accent);
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 12px;
	}
	.card {
		background: var(--cui-surface);
		border: 1px solid var(--cui-border);
		border-radius: 14px;
		padding: 20px 24px;
		gap: 10px;
	}
	.muted {
		color: var(--cui-text-muted);
	}
	.tabs {
		display: flex;
		gap: 4px;
		padding: 4px;
		background: var(--cui-surface-muted);
		border-radius: 10px;
	}
	.tab {
		border: none;
		background: transparent;
		flex: 1;
	}
	.tab.active {
		background: var(--cui-surface);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
	}
	.tab:hover {
		color: var(--cui-accent);
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.spacer {
		flex: 1;
	}
	.primary {
		background: #7747ff;
		color: white;
		border-color: #7747ff;
	}
	.primary:hover {
		background: #6236e8;
	}
</style>
