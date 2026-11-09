import { run, set_app_id } from 'cui-svelte';
import App from './App.svelte';
import { saved_theme } from './store.ts';

// The data folder is named before localStorage is read, so the window opens in the saved theme.
set_app_id('cui-svelte-tasks');
run(App, { title: 'Tasks', width: 520, height: 640, theme: saved_theme() });
