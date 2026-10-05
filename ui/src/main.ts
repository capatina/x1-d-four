import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { client } from './lib/client.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('#app missing from index.html');

mount(App, { target });
client.connect();
