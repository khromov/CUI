<script lang="ts">
	import dayjs from 'dayjs';
	import relativeTime from 'dayjs/plugin/relativeTime.js';
	import { Column, Text, Button } from 'cui-svelte';

	dayjs.extend(relativeTime);
	let date = $state(dayjs('2026-11-09'));
</script>

<Column>
	<Text>date={date.format('dddd D MMMM YYYY')}</Text>
	<Text>later={date.add(3, 'day').format('YYYY-MM-DD')} from={dayjs('2026-11-09').from(dayjs('2026-11-12'))}</Text>
	<Button onclick={() => (date = date.add(1, 'month'))}>next month</Button>
</Column>
