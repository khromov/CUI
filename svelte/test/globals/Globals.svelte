<script lang="ts">
	import { Column, Text } from 'cui-svelte';

	const id = crypto.randomUUID();
	const url = new URL('/docs?page=2#top', 'https://example.com/app/');
</script>

<Column>
	<Text>uuid={id.length} url={url.href} page={url.searchParams.get('page')}</Text>
</Column>
