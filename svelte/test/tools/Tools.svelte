<script lang="ts">
	import {
		Column, Row, Text, LogView, Terminal, CurveEditor, GradientEditor, FlameGraph, FilterBar, OtpInput,
		Reorder, ReorderItem, TreeTable, TreeName, GridCell, Box, LogBuffer, TerminalBuffer
	} from 'cui-svelte';

	const log = new LogBuffer();
	log.info('server started');
	log.warn('disk almost full');
	const term = new TerminalBuffer();
	term.writeln('\x1b[32m$\x1b[0m make');
	let keys = $state([{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0.2 }]);
	let stops = $state([{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }]);
	let flame_view = $state({});
	let flame_sel = $state(-1);
	const spans = [
		{ name: 'main', start: 0, end: 10, depth: 0 },
		{ name: 'render', start: 1, end: 6, depth: 1 },
		{ name: 'layout', start: 6, end: 9, depth: 1 }
	];
	let masks = $state([0, 0]);
	let search = $state('');
	const fields = [{ name: 'Status', options: ['Open', 'Closed'] }, { name: 'Owner', options: ['Ada', 'Grace'] }];
	let code = $state('');
	let completed = $state('');
	let order = $state([0, 1, 2]);
	const fruit = ['apple', 'banana', 'cherry'];
	const files = [
		{ name: 'src', dir: true },
		{ name: 'main.c', dir: false },
		{ name: 'cui.h', dir: false },
		{ name: 'README.md', dir: false }
	];
	let tree = $state([
		{ parent: -1, first_child: 1, next_sibling: 3, flags: 3 },
		{ parent: 0, first_child: -1, next_sibling: 2, flags: 0 },
		{ parent: 0, first_child: -1, next_sibling: -1, flags: 0 },
		{ parent: -1, first_child: -1, next_sibling: -1, flags: 0 }
	]);
	const columns = [{ title: 'Name', width: 220 }, { title: 'Kind', width: 120 }];
	let activated = $state(-1);
</script>

<Column gap={8} pad={8}>
	<Row gap={8}>
		<Box width={300}><LogView buffer={log} height={120} /></Box>
		<Box width={300}><Terminal buffer={term} height={120} /></Box>
	</Row>
	<Row gap={8}>
		<Box width={300}><CurveEditor bind:value={keys} height={140} /></Box>
		<Box width={300}><GradientEditor bind:value={stops} /></Box>
	</Row>
	<FlameGraph spans={spans} bind:view={flame_view} bind:selected={flame_sel} height={90} />
	<FilterBar fields={fields} bind:selected={masks} bind:search={search} />
	<OtpInput id="otp" bind:value={code} length={4} oncomplete={(c) => (completed = c)} />
	<Text>code={code} completed={completed} masks={masks.join(',')} keys={keys.length} stops={stops.length}</Text>
	<Reorder bind:order>
		{#each order as idx (idx)}
			<ReorderItem><Text>{fruit[idx]}</Text></ReorderItem>
		{/each}
	</Reorder>
	<Box height={160}>
		<TreeTable columns={columns} bind:nodes={tree} onactivate={(n) => (activated = n)}>
			{#snippet row(n)}
				<TreeName icon={files[n].dir ? 'folder' : 'file'}>{files[n].name}</TreeName>
				<GridCell>{files[n].dir ? 'Folder' : 'File'}</GridCell>
			{/snippet}
		</TreeTable>
	</Box>
	<Text>activated={activated} flags={tree.map((x) => x.flags).join(',')}</Text>
</Column>
