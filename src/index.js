import dotenv from 'dotenv';
dotenv.config();

import { fetchItems } from './fetchItems.js';
import { startScheduler } from './scheduler.js';
import { startApi } from './api/server.js';

async function start() {
    await fetchItems();
    startScheduler();
    startApi();
}

start();
