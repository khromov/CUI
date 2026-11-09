<script>
	import { Column, Text, Button, Canvas, native, fs, paths, clipboard, toast } from 'cui-svelte';
	let level = $state(0.5);
	let pressed = $state('');
	let painted = $state(0);
	const h = native.hypotenuse(3, 4);
	const g = native.greet('C');
</script>

<Column gap={8} pad={8}>
	<Text>native: {h} {g}</Text>
	<Canvas id="bar" height={20} paint="draw_bar" data={[level]} onpress={(x, y) => (pressed = `${Math.round(x)},${Math.round(y)}`)} />
	<Canvas height={40} onpaint={(p) => { p.rect(0, 0, p.width / 2, p.height, { fill: 'accent', radius: 6 }); p.text(8, 8, 'js paint', { color: 'white' }); painted++; }} />
	<Text>pressed={pressed} painted={painted > 0}</Text>
	<Button onclick={() => (level = 1)}>full</Button>
	<Button onclick={() => toast('Saved', { tone: 'success', description: 'All good' })}>toast</Button>
</Column>
