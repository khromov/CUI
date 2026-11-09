<script lang="ts">
	import {
		Scroll, Column, Row, Box, Card, Heading, Text, Secondary, Muted, Button, IconButton, Badge, Avatar, AvatarGroup,
		Switch, Checkbox, Slider, RangeSlider, Rating, Chip, Segmented, Tabs, Select, Input, Search, NumberInput,
		Progress, ProgressRing, Spinner, Alert, Metric, LineChart, BarChart, DonutChart, Sparkline, Gauge, Treemap,
		BarList, Calendar, DatePicker, ColorPicker, TimePicker, Breadcrumb, Pagination, Stepper, ToggleGroup,
		MultiSelect, Table, TableRow, TableCell, DataGrid, GridCell, VirtualList, Kanban, KanbanColumn, KanbanCard,
		Popover, Menu, MenuItem, MenuSeparator, Dialog, DialogFooter, Accordion, ListItem, TimelineItem, CodeBlock,
		Markdown, ChatMessage, ToolCall, AgentPlan, Toolbar, ToolbarButton, StatusBar, StatusBarText, Split,
		RadioCards, SplitButton, Tooltip, Separator, Heatmap, Funnel, Waffle, CommandPalette, Gantt, NodeEditor, Node,
		NodeInput, NodeOutput, NodeLink, Kbd, Link, EmptyState, Banner, Counter, Countdown, Knob, Fader, WheelPicker
	} from 'cui-svelte';

	let on = $state(true);
	let checked = $state(false);
	let volume = $state(40);
	let lo = $state(20), hi = $state(70);
	let rating = $state(3);
	let chip = $state(true);
	let seg = $state(1);
	let tab = $state(0);
	let fruit = $state(2);
	let name = $state('Ada');
	let query = $state('');
	let amount = $state(12.5);
	let date = $state('2026-11-09');
	let color = $state('#7747ff');
	let hour = $state(9), minute = $state(30);
	let page = $state(2);
	let tools = $state([true, false, true]);
	let picked = $state([false, true, false, false]);
	let sort = $state({ column: 0, descending: false });
	let selected = $state(Array(200).fill(false));
	let pop = $state(false);
	let dialog = $state(false);
	let acc = $state(true);
	let plan = $state(0);
	let palette = $state(false);
	let knob = $state(0.4), fader = $state(0.7), wheel = $state(3);
	let moves = $state(0);
	let tasks = $state([
		{ name: 'Design', owner: 'Ada', start: 1, end: 5, progress: 1, tone: 'violet' },
		{ name: 'Build', owner: 'Grace', start: 4, end: 13, progress: 0.4, depends_on: 0 },
		{ name: 'Ship', start: 14, end: 14, milestone: true, depends_on: 1 }
	]);
	let view = $state({ x: 0, y: 0, zoom: 1 });
	let nx = $state(20), ny = $state(20), mx = $state(260), my = $state(60);

	const people = Array.from({ length: 200 }, (_, i) => ({ name: `Person ${i}`, email: `p${i}@example.com`, score: (i * 37) % 100 }));
	const series = [
		{ name: 'Visits', values: [12, 19, 14, 22, 30, 26, 34] },
		{ name: 'Signups', values: [4, 6, 5, 9, 11, 10, 14] }
	];
	const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
	const columns = [{ title: 'Name' }, { title: 'Email', width: 220 }, { title: 'Score', width: 80, align: 'right', sortable: true }];
	const board = [
		{ title: 'To do', cards: ['Write docs', 'Fix bug'] },
		{ title: 'Doing', cards: ['Svelte renderer'] },
		{ title: 'Done', cards: ['QuickJS host'] }
	];
	const heat = Array.from({ length: 7 * 12 }, (_, i) => (i * 7) % 10);
</script>

<Scroll id="page" pad={24} gap={20}>
	<Heading level={1}>cui-svelte gallery</Heading>
	<Row gap={8} wrap>
		<Button variant="primary" icon="plus">Primary</Button>
		<Button variant="outline">Outline</Button>
		<Button variant="ghost" tooltip="A ghost button">Ghost</Button>
		<Button variant="danger" icon="trash-2">Delete</Button>
		<IconButton icon="settings" tooltip="Settings" />
		<SplitButton items={['Save as…', 'Export']}>Save</SplitButton>
		<Badge tone="success">Live</Badge>
		<Badge tone="warning" dot>Pending</Badge>
		<Avatar name="Ada Lovelace" />
		<AvatarGroup names={['Ada', 'Grace', 'Linus', 'Ken', 'Dennis']} />
		<Kbd keys="Ctrl K" />
		<Link>A link</Link>
	</Row>
	<Row gap={16} wrap align="center">
		<Switch bind:checked={on}>Switch</Switch>
		<Checkbox bind:checked>Checkbox</Checkbox>
		<Chip bind:selected={chip} icon="star">Chip</Chip>
		<Rating bind:value={rating} />
		<Segmented items={['Day', 'Week', 'Month']} bind:value={seg} />
		<ToggleGroup items={['B', 'I', 'U']} bind:value={tools} />
	</Row>
	<Row gap={16} wrap>
		<Column gap={8} width={280}>
			<Slider bind:value={volume} show_value>Volume</Slider>
			<RangeSlider bind:lo bind:hi>Range</RangeSlider>
			<Input bind:value={name} label="Name" placeholder="Your name" />
			<Search bind:value={query} placeholder="Search" />
			<NumberInput bind:value={amount} label="Amount" step={0.5} decimals={1} />
			<Select items={['Apple', 'Banana', 'Cherry']} bind:value={fruit} label="Fruit" />
			<MultiSelect items={['Red', 'Green', 'Blue', 'Gold']} bind:value={picked} placeholder="Colors" />
			<DatePicker bind:value={date} label="Date" />
			<TimePicker bind:hour bind:minute />
		</Column>
		<Calendar bind:value={date} />
		<ColorPicker bind:value={color} />
	</Row>
	<Text>state: on={on} checked={checked} volume={Math.round(volume)} range={Math.round(lo)}-{Math.round(hi)} rating={rating} seg={seg} tools={tools.map(Number).join('')} picked={picked.map(Number).join('')} date={date} color={color} time={hour}:{minute}</Text>
	<Tabs items={['Overview', 'Charts', 'Data']} bind:value={tab} />
	<Box dir="grid" columns={3} gap={16} min_column_width={240}>
		<Metric label="Revenue" value="$64,210" delta={12.4} spark={[3, 5, 4, 6, 8, 7, 9]} />
		<Metric label="Customers" value="2,040" delta={7.3} />
		<Metric label="Churn" value="1.7%" delta={-0.6} lower_is_better />
	</Box>
	<Row gap={16} wrap>
		<Card width={420}><LineChart series={series} labels={labels} smooth area height={200} /></Card>
		<Card width={420}><BarChart series={series} labels={labels} stacked height={200} /></Card>
		<Card width={260}><DonutChart values={[40, 25, 20, 15]} labels={['A', 'B', 'C', 'D']} height={200} /></Card>
	</Row>
	<Row gap={16} wrap>
		<Card width={300}><Treemap items={[{ label: 'Svelte', value: 40 }, { label: 'C', value: 30 }, { label: 'JS', value: 20 }, { label: 'CSS', value: 10 }]} height={160} /></Card>
		<Card width={300}><BarList items={[{ label: 'Inbox', value: 120 }, { label: 'Sent', value: 80 }, { label: 'Spam', value: 12 }]} /></Card>
		<Card width={300}><Funnel stages={[{ label: 'Visit', value: 1000 }, { label: 'Signup', value: 400 }, { label: 'Paid', value: 90 }]} height={160} /></Card>
		<Card width={300}><Heatmap values={heat} rows={7} cols={12} /></Card>
		<Card width={200}><Waffle items={[{ label: 'Yes', value: 62 }, { label: 'No', value: 38 }]} /></Card>
		<Gauge label="CPU" value={0.62} />
		<ProgressRing label="Disk" value={0.7} />
		<Sparkline values={[1, 4, 2, 6, 3, 8, 5]} width={140} height={40} />
	</Row>
	<Row gap={12} wrap align="center">
		<Progress value={0.45} width={200} />
		<Spinner />
		<Knob bind:value={knob} />
		<Fader bind:value={fader} />
		<WheelPicker items={['One', 'Two', 'Three', 'Four', 'Five']} bind:value={wheel} />
		<Counter value={1234.5} />
		<Countdown seconds_left={3725} />
	</Row>
	<Alert tone="info" description="Everything on this page is Svelte compiled to C.">Heads up</Alert>
	<Banner open={true} tone="success">A banner</Banner>
	<Row gap={8}>
		<Breadcrumb items={['Home', 'Projects', 'cui-svelte']} />
		<Pagination bind:page page_count={8} />
	</Row>
	<Stepper steps={['Account', 'Plan', 'Pay', 'Done']} current={1} />
	<RadioCards choices={[{ title: 'Free', description: 'For trying it out' }, { title: 'Pro', description: 'For teams', badge: 'Popular' }]} bind:value={plan} />
	<Table id="t" columns={columns} bind:sort striped>
		{#each people.slice(0, 4) as p (p.email)}
			<TableRow>
				<TableCell>{p.name}</TableCell>
				<TableCell>{p.email}</TableCell>
				<TableCell><Badge tone="accent">{p.score}</Badge></TableCell>
			</TableRow>
		{/each}
	</Table>
	<DataGrid id="grid" columns={columns} count={people.length} bind:selected height={240}>
		{#snippet row(i)}
			<GridCell>{people[i].name}</GridCell>
			<GridCell>{people[i].email}</GridCell>
			<GridCell>{people[i].score}</GridCell>
		{/snippet}
	</DataGrid>
	<VirtualList id="vl" count={10000} row_height={28} height={140}>
		{#snippet row(i)}
			<Text>Virtual row {i}</Text>
		{/snippet}
	</VirtualList>
	<Kanban onmove={() => moves++}>
		{#each board as col (col.title)}
			<KanbanColumn title={col.title} count={col.cards.length}>
				{#each col.cards as card, i (card)}
					<KanbanCard id={i}><Text>{card}</Text></KanbanCard>
				{/each}
			</KanbanColumn>
		{/each}
	</Kanban>
	<Gantt tasks={tasks} origin="2026-11-01" days={21} />
	<Row gap={8}>
		<Button onclick={() => (pop = !pop)}>Popover</Button>
		<Popover bind:open={pop} width={220}><Text>Inside a popover</Text></Popover>
		<Menu label="Menu"><MenuItem icon="copy">Copy</MenuItem><MenuSeparator /><MenuItem danger>Delete</MenuItem></Menu>
		<Button onclick={() => (dialog = true)}>Dialog</Button>
		<Button onclick={() => (palette = true)}>Palette</Button>
	</Row>
	<Dialog title="Delete project?" bind:open={dialog} description="This cannot be undone.">
		<DialogFooter>
			<Button onclick={() => (dialog = false)}>Cancel</Button>
			<Button variant="danger" onclick={() => (dialog = false)}>Delete</Button>
		</DialogFooter>
	</Dialog>
	<CommandPalette bind:open={palette} commands={[{ title: 'New file', icon: 'plus', group: 'File' }, { title: 'Settings', icon: 'settings', group: 'App' }]} />
	<Accordion title="Accordion" bind:open={acc}><Text>Accordion content</Text></Accordion>
	<ListItem icon="mail" subtitle="From Grace" trailing="9:41">Inbox</ListItem>
	<TimelineItem time="Today" description="Compiled to C">Svelte</TimelineItem>
	<CodeBlock lang="c" code={'int main(void) {\n    return 0;\n}'} />
	<Markdown text={'# Markdown\nSome **bold** text and a [link](https://svelte.dev).'} />
	<ChatMessage>Hello from a chat message</ChatMessage>
	<ToolCall name="search" />
	<AgentPlan steps={[{ title: 'Read', status: 'done' }, { title: 'Write', status: 'running' }, { title: 'Test', status: 'pending' }]} />
	<EmptyState icon="inbox" description="Nothing here yet" action="Create">Empty</EmptyState>
	<Box height={260} border={1} radius={12}>
		<NodeEditor bind:view>
			<Node id={1} title="Source" bind:x={nx} bind:y={ny}><NodeOutput pin={11}>out</NodeOutput></Node>
			<Node id={2} title="Sink" bind:x={mx} bind:y={my}><NodeInput pin={21}>in</NodeInput></Node>
			<NodeLink id={1} from={11} to={21} />
		</NodeEditor>
	</Box>
	<Muted>moves={moves}</Muted>
</Scroll>
