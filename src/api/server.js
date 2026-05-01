import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import healthRoute from './routes/health.js';
import itemsRoute from './routes/items.js';
import pricesRoute from './routes/prices.js';
import craftingRoute from './routes/crafting.js';
import syncRoute from './routes/sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startApi() {
    const app = express();

    app.use(cors());
    app.use(express.json());

    // Serve static files from public folder
    app.use(express.static(path.join(__dirname, '../../public')));

    app.use('/health', healthRoute);
    app.use('/items', itemsRoute);
    app.use('/prices', pricesRoute);
    app.use('/crafting', craftingRoute);
    app.use('/sync', syncRoute);

    const port = process.env.API_PORT || 3000;
    app.listen(port, () => {
        console.log(`REST API running on port ${port}`);
    });
}
