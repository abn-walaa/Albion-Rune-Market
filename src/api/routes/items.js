import { Router } from 'express';
import { pool } from '../../db.js';
import { fetchLivePrices, ROYAL_CITIES } from '../../livePrice.js';

const router = Router();

router.get('/', async (req, res) => {
    const { limit = 100, offset = 0 } = req.query;

    const { rows } = await pool.query(
        `
    SELECT id, name, tier, enchantment
    FROM items
    ORDER BY id
    LIMIT $1 OFFSET $2
    `,
        [limit, offset]
    );

    res.json(rows);
});

/**
 * GET /items/search/live
 * Search for items with live price data from Albion API
 * ?q=leather bag
 * ?craftable=true (only items with recipes)
 */
router.get('/search/live', async (req, res) => {
    try {
        const { q, limit = 15, craftable = 'true' } = req.query;

        if (!q || q.length < 2) {
            return res.status(400).json({ error: 'Query must be at least 2 characters' });
        }

        // Create search terms for both formats (spaces and underscores)
        const searchWithSpaces = `%${q.toUpperCase()}%`;
        const searchWithUnderscores = `%${q.toUpperCase().replace(/\s+/g, '_')}%`;
        const onlyCraftable = craftable === 'true';

        let query;
        let params;

        if (onlyCraftable) {
            query = `
                SELECT i.id, i.name, i.tier, i.enchantment,
                    (SELECT COUNT(*) FROM recipes r WHERE r.item_id = i.id) AS resource_count
                FROM items i
                WHERE EXISTS (SELECT 1 FROM recipes r WHERE r.item_id = i.id)
                    AND (
                        UPPER(i.id) LIKE $1
                        OR UPPER(i.id) LIKE $2
                        OR UPPER(COALESCE(i.name, '')) LIKE $1
                        OR UPPER(REPLACE(COALESCE(i.name, ''), ' ', '_')) LIKE $2
                    )
                ORDER BY
                    CASE
                        WHEN UPPER(i.id) = $3 THEN 0
                        WHEN UPPER(i.name) = $4 THEN 1
                        WHEN UPPER(i.name) LIKE $1 THEN 2
                        ELSE 3
                    END,
                    i.tier DESC,
                    i.name
                LIMIT $5
            `;
            params = [searchWithSpaces, searchWithUnderscores, q.toUpperCase().replace(/\s+/g, '_'), q.toUpperCase(), limit];
        } else {
            query = `
                SELECT i.id, i.name, i.tier, i.enchantment,
                    (SELECT COUNT(*) FROM recipes r WHERE r.item_id = i.id) AS resource_count
                FROM items i
                WHERE (
                    UPPER(i.id) LIKE $1
                    OR UPPER(i.id) LIKE $2
                    OR UPPER(COALESCE(i.name, '')) LIKE $1
                    OR UPPER(REPLACE(COALESCE(i.name, ''), ' ', '_')) LIKE $2
                )
                ORDER BY
                    CASE
                        WHEN UPPER(i.id) = $3 THEN 0
                        WHEN UPPER(i.name) = $4 THEN 1
                        WHEN UPPER(i.name) LIKE $1 THEN 2
                        ELSE 3
                    END,
                    i.tier DESC,
                    i.name
                LIMIT $5
            `;
            params = [searchWithSpaces, searchWithUnderscores, q.toUpperCase().replace(/\s+/g, '_'), q.toUpperCase(), limit];
        }

        const { rows } = await pool.query(query, params);

        if (rows.length === 0) {
            return res.json({
                query: q,
                count: 0,
                results: [],
                source: 'live_api'
            });
        }

        // Fetch live prices for the found items
        const itemIds = rows.map(r => r.id);
        const priceMap = await fetchLivePrices(itemIds, 1);

        // Build results with live prices
        const results = rows.map(r => {
            const prices = priceMap[r.id] || {};

            // Find best buy price (lowest sell_price_min across cities)
            let bestBuyPrice = null;
            let bestBuyCity = null;
            let bestSellPrice = null;
            let bestSellCity = null;

            for (const city of ROYAL_CITIES) {
                const cityPrice = prices[city];
                if (!cityPrice) continue;

                if (cityPrice.sell_price_min > 0) {
                    if (!bestBuyPrice || cityPrice.sell_price_min < bestBuyPrice) {
                        bestBuyPrice = cityPrice.sell_price_min;
                        bestBuyCity = city;
                    }
                    if (!bestSellPrice || cityPrice.sell_price_min > bestSellPrice) {
                        bestSellPrice = cityPrice.sell_price_min;
                        bestSellCity = city;
                    }
                }
            }

            return {
                id: r.id,
                name: r.name || r.id,
                tier: r.tier,
                enchantment: r.enchantment,
                craftable: parseInt(r.resource_count) > 0,
                resource_count: parseInt(r.resource_count),
                live_price: {
                    best_buy: bestBuyPrice,
                    best_buy_city: bestBuyCity,
                    best_sell: bestSellPrice,
                    best_sell_city: bestSellCity,
                    spread: bestSellPrice && bestBuyPrice ? bestSellPrice - bestBuyPrice : null
                }
            };
        });

        res.json({
            query: q,
            count: results.length,
            results,
            source: 'live_api'
        });

    } catch (error) {
        console.error('Error in /items/search/live:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /items/search
 * Search for craftable items by name or ID (database prices)
 * ?q=leather bag
 * ?q=T4_BAG
 * ?craftable=true (only items with recipes)
 */
router.get('/search', async (req, res) => {
    try {
        const { q, limit = 20, craftable = 'true' } = req.query;

        if (!q || q.length < 2) {
            return res.status(400).json({ error: 'Query must be at least 2 characters' });
        }

        // Create search terms for both formats (spaces and underscores)
        const searchWithSpaces = `%${q.toUpperCase()}%`;
        const searchWithUnderscores = `%${q.toUpperCase().replace(/\s+/g, '_')}%`;
        const onlyCraftable = craftable === 'true';

        let query;
        let params;

        if (onlyCraftable) {
            // Only return items that have recipes
            query = `
                SELECT i.id, i.name, i.tier, i.enchantment,
                    (SELECT COUNT(*) FROM recipes r WHERE r.item_id = i.id) AS resource_count
                FROM items i
                WHERE EXISTS (SELECT 1 FROM recipes r WHERE r.item_id = i.id)
                    AND (
                        UPPER(i.id) LIKE $1
                        OR UPPER(i.id) LIKE $2
                        OR UPPER(COALESCE(i.name, '')) LIKE $1
                        OR UPPER(REPLACE(COALESCE(i.name, ''), ' ', '_')) LIKE $2
                    )
                ORDER BY
                    CASE
                        WHEN UPPER(i.id) = $3 THEN 0
                        WHEN UPPER(i.name) = $4 THEN 1
                        WHEN UPPER(i.name) LIKE $1 THEN 2
                        ELSE 3
                    END,
                    i.tier DESC,
                    i.name
                LIMIT $5
            `;
            params = [searchWithSpaces, searchWithUnderscores, q.toUpperCase().replace(/\s+/g, '_'), q.toUpperCase(), limit];
        } else {
            query = `
                SELECT i.id, i.name, i.tier, i.enchantment,
                    (SELECT COUNT(*) FROM recipes r WHERE r.item_id = i.id) AS resource_count
                FROM items i
                WHERE (
                    UPPER(i.id) LIKE $1
                    OR UPPER(i.id) LIKE $2
                    OR UPPER(COALESCE(i.name, '')) LIKE $1
                    OR UPPER(REPLACE(COALESCE(i.name, ''), ' ', '_')) LIKE $2
                )
                ORDER BY
                    CASE
                        WHEN UPPER(i.id) = $3 THEN 0
                        WHEN UPPER(i.name) = $4 THEN 1
                        WHEN UPPER(i.name) LIKE $1 THEN 2
                        ELSE 3
                    END,
                    i.tier DESC,
                    i.name
                LIMIT $5
            `;
            params = [searchWithSpaces, searchWithUnderscores, q.toUpperCase().replace(/\s+/g, '_'), q.toUpperCase(), limit];
        }

        const { rows } = await pool.query(query, params);

        res.json({
            query: q,
            count: rows.length,
            results: rows.map(r => ({
                id: r.id,
                name: r.name || r.id,
                tier: r.tier,
                enchantment: r.enchantment,
                craftable: parseInt(r.resource_count) > 0
            }))
        });

    } catch (error) {
        console.error('Error in /items/search:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
