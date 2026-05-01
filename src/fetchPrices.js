import { pool } from './db.js';
import { api } from './apiClient.js';
import { rateLimit } from './rateLimiter.js';
import { buildBatches } from './batchBuilder.js';

const LOCATIONS = [
    'Caerleon',
    'Bridgewatch',
    'Martlock',
    'Thetford',
    'Fort Sterling',
    'Lymhurst',
    'Brecilien',
    'Black Market'
];

const QUALITIES = [1, 2, 3, 4, 5];
const BATCH_SIZE = 500; // Safe batch size for PostgreSQL

function currentHourUTC() {
    const d = new Date();
    d.setUTCMinutes(0, 0, 0);
    return d;
}

async function batchUpsert(client, values, hourBucket) {
    if (values.length === 0) return;

    for (let i = 0; i < values.length; i += BATCH_SIZE) {
        const batch = values.slice(i, i + BATCH_SIZE);

        // Upsert current prices
        const colsPerRow = 7;
        const placeholders = batch
            .map((_, idx) => `($${idx * colsPerRow + 1},$${idx * colsPerRow + 2},$${idx * colsPerRow + 3},$${idx * colsPerRow + 4},$${idx * colsPerRow + 5},$${idx * colsPerRow + 6},$${idx * colsPerRow + 7})`)
            .join(',');

        await client.query(
            `
            INSERT INTO market_prices (
                item_id, city, quality,
                sell_price_min, sell_price_min_date,
                buy_price_max, buy_price_max_date
            )
            VALUES ${placeholders}
            ON CONFLICT (item_id, city, quality)
            DO UPDATE SET
                sell_price_min = EXCLUDED.sell_price_min,
                sell_price_min_date = EXCLUDED.sell_price_min_date,
                buy_price_max = EXCLUDED.buy_price_max,
                buy_price_max_date = EXCLUDED.buy_price_max_date
            `,
            batch.flat()
        );

        // Insert hourly history
        const historyValues = batch.map(row => [
            row[0], // item_id
            row[1], // city
            row[2], // quality
            hourBucket,
            row[3], // sell_price_min
            row[5], // buy_price_max
        ]);

        const histCols = 6;
        const histPlaceholders = historyValues
            .map((_, idx) => `($${idx * histCols + 1},$${idx * histCols + 2},$${idx * histCols + 3},$${idx * histCols + 4},$${idx * histCols + 5},$${idx * histCols + 6})`)
            .join(',');

        await client.query(
            `
            INSERT INTO market_prices_history (
                item_id, city, quality, hour_bucket,
                sell_price_min, sell_price_max, sell_price_avg,
                buy_price_min, buy_price_max, buy_price_avg
            )
            SELECT
                item_id::text, city::text, quality::int, hour_bucket::timestamp,
                sell_price::int, sell_price::int, sell_price::int,
                buy_price::int, buy_price::int, buy_price::int
            FROM (VALUES ${histPlaceholders}) AS v(item_id, city, quality, hour_bucket, sell_price, buy_price)
            ON CONFLICT (item_id, city, quality, hour_bucket)
            DO UPDATE SET
                sell_price_min = LEAST(market_prices_history.sell_price_min, EXCLUDED.sell_price_min),
                sell_price_max = GREATEST(market_prices_history.sell_price_max, EXCLUDED.sell_price_max),
                sell_price_avg = (market_prices_history.sell_price_avg + EXCLUDED.sell_price_avg) / 2,
                buy_price_min = LEAST(market_prices_history.buy_price_min, EXCLUDED.buy_price_min),
                buy_price_max = GREATEST(market_prices_history.buy_price_max, EXCLUDED.buy_price_max),
                buy_price_avg = (market_prices_history.buy_price_avg + EXCLUDED.buy_price_avg) / 2
            `,
            historyValues.flat()
        );
    }
}

export async function fetchPrices() {
    const client = await pool.connect();
    const hourBucket = currentHourUTC();

    try {
        await client.query('BEGIN');

        const { rows } = await client.query('SELECT id FROM items');
        const itemIds = rows.map(r => r.id);

        if (itemIds.length === 0) {
            console.log('No items in database, skipping price fetch');
            await client.query('COMMIT');
            return;
        }

        const baseUrl = `https://${process.env.API_REGION}.albion-online-data.com/api/v2/stats/prices`;

        const batches = buildBatches(itemIds, baseUrl, LOCATIONS, QUALITIES);

        let totalPrices = 0;

        for (const batch of batches) {
            await rateLimit();

            const { data } = await api.get(
                `${baseUrl}/${batch.join(',')}.json`,
                {
                    params: {
                        locations: LOCATIONS.join(','),
                        qualities: QUALITIES.join(','),
                    },
                }
            );

            if (!data || data.length === 0) continue;

            const filteredData = data.filter(row =>
                row.sell_price_min_date !== '0001-01-01T00:00:00' ||
                row.buy_price_max_date !== '0001-01-01T00:00:00'
            );

            if (filteredData.length === 0) continue;

            const values = filteredData.map(row => [
                row.item_id,
                row.city,
                row.quality,
                row.sell_price_min,
                row.sell_price_min_date.startsWith('0001-01-01') ? null : row.sell_price_min_date,
                row.buy_price_max,
                row.buy_price_max_date.startsWith('0001-01-01') ? null : row.buy_price_max_date,
            ]);

            await batchUpsert(client, values, hourBucket);
            totalPrices += values.length;
        }

        await client.query('COMMIT');
        console.log(`Prices synced: ${totalPrices} at ${new Date().toISOString()}`);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('fetchPrices failed:', err);
        throw err;
    } finally {
        client.release();
    }
}
