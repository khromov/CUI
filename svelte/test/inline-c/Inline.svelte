<script lang="c">
	cuisv_export double triple(double x) { return x * 3; }
</script>

<script>
	import { Text, native } from 'cui-svelte';
</script>

<Text>triple={native.triple(7)}</Text>
