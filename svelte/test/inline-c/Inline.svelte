<script lang="c">
	cuisv_export double triple(double x) { return x * 3; }
	cuisv_export int len(const char *s) { return (int)strlen(s); }
	cuisv_export const char *join(const char *a, const char *b) {
		static char buf[64];
		snprintf(buf, sizeof buf, "%s%s", a, b);
		return buf;
	}
	cuisv_export bool odd(int n, bool flip) { return (n % 2 != 0) != flip; }
</script>

<script>
	import { Text, Slider, native } from 'cui-svelte';
	let fit = $state('loose');
</script>

<Text>triple={native.triple(7)}</Text>

<!-- markup cui-svelte takes and svelte-check refuses (it skips this folder) -->
<label>Snug <input type="radio" bind:group={() => fit, (v) => (fit = v)} value="snug" /></label>
<label>Loose <input type="radio" bind:group={() => fit, (v) => (fit = v)} value="loose" /></label>
<Text>fit={fit}</Text>
<Slider id="slider */ end">slider</Slider>
