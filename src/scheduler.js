import cron from 'node-cron';
import { fetchPrices } from './fetchPrices.js';

export function startScheduler() {
    // Initial fetch on startup
    fetchPrices();

    // Fetch every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
        console.log('Market sync started');
        await fetchPrices();
    });
}
