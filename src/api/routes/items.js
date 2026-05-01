import { Router } from 'express';
import { pool } from '../../db.js';

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
 * GET /items/search
 * Search for craftable items by name or ID
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

        const searchTerm = `%${q.toUpperCase()}%`;
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
                    AND (UPPER(i.id) LIKE $1 OR UPPER(COALESCE(i.name, '')) LIKE $1)
                ORDER BY
                    CASE WHEN UPPER(i.id) = $2 THEN 0 ELSE 1 END,
                    i.tier DESC,
                    i.name
                LIMIT $3
            `;
            params = [searchTerm, q.toUpperCase(), limit];
        } else {
            query = `
                SELECT i.id, i.name, i.tier, i.enchantment,
                    (SELECT COUNT(*) FROM recipes r WHERE r.item_id = i.id) AS resource_count
                FROM items i
                WHERE (UPPER(i.id) LIKE $1 OR UPPER(COALESCE(i.name, '')) LIKE $1)
                ORDER BY
                    CASE WHEN UPPER(i.id) = $2 THEN 0 ELSE 1 END,
                    i.tier DESC,
                    i.name
                LIMIT $3
            `;
            params = [searchTerm, q.toUpperCase(), limit];
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
