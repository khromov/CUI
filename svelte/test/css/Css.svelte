<script>
	import { Button } from 'cui-svelte';
	let progress = $state(0.5);
	let kind = $state('big');
	let hidden = $state(false);
</script>

<div id="page" class="page">
	<div id="track" class="track"><div id="bar" class="bar" style:width="{progress * 100}%"></div></div>
	<div id="row" class="row"><div id="a" class="grow"></div><div id="b" class="grow two"></div></div>
	<div id="grid" class="grid">
		<div id="g1" class="cell"></div><div id="g2" class="cell"></div><div id="g3" class="cell"></div><div id="g4" class="cell"></div>
	</div>
	<div class="center"><div id="centered" class="box">x</div></div>
	<div id="dyn" class="tile {kind}">tile</div>
	<div id="gone" class:none={hidden}>maybe</div>
	<Button id="wide" class="wide">Wide</Button>
	<button onclick={() => { progress = 1; kind = 'small'; hidden = true; }}>change</button>
</div>

<style>
	.page { padding: 10px; gap: 10px; width: 600px; }
	.track { height: 10px; background: #eee; }
	.bar { height: 10px; background: #333; }
	.row { display: flex; gap: 0; }
	.grow { flex: 1; height: 20px; }
	.two { flex: 2; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
	.cell { height: 20px; }
	.center { margin: 0 auto; }
	.box { width: 100px; height: 30px; margin: 0 auto; }
	.tile.big { height: 60px; }
	.tile.small { height: 20px; }
	.none { display: none; }
	.wide { width: 300px; }
</style>
