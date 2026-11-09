<script lang="ts">
	import { Calendar, DatePicker } from 'cui-svelte';

	let date = $state('2026-03-15');
</script>

<DatePicker bind:value={date} label="Date" />
<Calendar bind:value={date} />
