<script>import { Link, Button, HoldButton, ConfirmButton, StatusButton, SplitButton, Checkbox, Switch, Radio, Slider, RangeSlider, RulerSlider, HistogramSlider, Scrub, Chip, ControlTile, NavItem, NavSection, Alert, ProgressRing, EmptyState, Metric, Meter, TimelineItem, Accordion, ExpandableCard, Tree, TreeCell, ListItem, Gauge, ChatDivider, StatusBarItem, DockItem, InspectorGroup, PropFloat, PropInt, PropText, PropBool, PropEnum, PropVec, Text, Scroll, Knob } from 'cui-svelte';
	let notes = $state('## Release notes');
	let caption = $state('Gain ##2');
</script>
<Scroll>
<Link text="L_Link" />
<Button label="L_Button" />
<HoldButton label="L_HoldButton" />
<ConfirmButton label="L_ConfirmButton" />
<StatusButton label="L_StatusButton" />
<SplitButton label="L_SplitButton" />
<Checkbox label="L_Checkbox" />
<Switch label="L_Switch" />
<Radio label="L_Radio" />
<Slider label="L_Slider" />
<RangeSlider label="L_RangeSlider" />
<RulerSlider label="L_RulerSlider" />
<HistogramSlider label="L_HistogramSlider" />
<Scrub label="L_Scrub" />
<Chip label="L_Chip" />
<ControlTile label="L_ControlTile" />
<NavItem label="L_NavItem" />
<NavSection title="L_NavSection" />
<Alert title="L_Alert" />
<ProgressRing label="L_ProgressRing" />
<EmptyState title="L_EmptyState" />
<Metric label="L_Metric" />
<Meter label="L_Meter" />
<TimelineItem title="L_TimelineItem" />
<Accordion title="L_Accordion"><Text>x</Text></Accordion>
<ExpandableCard title="L_ExpandableCard"><Text>x</Text></ExpandableCard>
<Tree label="L_Tree"><Text>x</Text></Tree>
<TreeCell label="L_TreeCell" />
<ListItem title="L_ListItem" />
<Gauge label="L_Gauge" />
<ChatDivider label="L_ChatDivider" />
<StatusBarItem label="L_StatusBarItem" />
<DockItem label="L_DockItem" />
<InspectorGroup title="L_InspectorGroup" />
<PropFloat label="L_PropFloat" />
<PropInt label="L_PropInt" />
<PropText label="L_PropText" />
<PropBool label="L_PropBool" />
<PropEnum label="L_PropEnum" />
<PropVec label="L_PropVec" />
<Button>{"Ticket ##42"}</Button>
<Checkbox label={notes} />
<Button label="C#" />
<Button label="Static ##7" />
<Knob>{"Knob ##1"}</Knob>
<Knob>{caption}</Knob>
</Scroll>
