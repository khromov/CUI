<script>
	// Elements with an id="…", for rect_of: CUI ids that differ from the label's (checkbox,
	// switch, radio, copy button, chip, nav items, an alert), ones that always matched (button,
	// slider), html inputs, overlays closed and open, and an empty element.
	import { Alert, Button, Checkbox, Chip, CopyButton, Dialog, NavItem, Radio, Slider, Switch } from 'cui-svelte';
	let on = $state(true);
	let size = $state('s');
	let n = $state(0.5);
	let pick = $state(1);
	let late = $state(false);
	let open = $state(false);
	let alerts = $state(0);
</script>

<div style="display: flex; flex-direction: column; gap: 6px; padding: 8px">
	<Button id="button">Save</Button>
	<Slider id="slider" label="Volume" bind:value={n} />
	<Checkbox id="checkbox" bind:checked={on}>Remember me</Checkbox>
	<Switch id="switch" bind:checked={on}>Wi-Fi</Switch>
	<Radio id="radio" bind:group={pick} value={2}>Small</Radio>
	<Chip id="chip" label="Filter" />
	<CopyButton id="copy" text="hello" />
	<NavItem id="nav" label="Inbox" />
	<Alert id="alert" title="Heads up" description="Something happened" dismissible ondismiss={() => alerts++} />
	<label><input type="checkbox" id="html_checkbox" bind:checked={on} /> Agree</label>
	<label><input type="radio" id="html_radio" name="size" value="m" bind:group={size} /> Medium</label>
	<input type="range" id="html_range" min="0" max="1" step="0.1" bind:value={n} />
	<div style="display: flex; flex-direction: row; align-items: center; gap: 8px">
		<span>before</span><div id="mark"></div><span>after</span>
	</div>
	<Button onclick={() => (late = true)}>show late</Button>
	{#if late}<Slider id="late" label="Late slider" bind:value={n} />{/if}
	<Button onclick={() => (open = true)}>open dialog</Button>
	<Dialog id="dialog" title="Settings" bind:open>Dialog body</Dialog>
	<p>on={on} size={size} pick={pick} alerts={alerts}</p>
</div>
