import { Router } from 'express';
import { pool } from '../../db.js';

const router = Router();

/**
 * GET /crafting/profit
 * Find most profitable items to craft
 *
 * Location:
 * ?city=Bridgewatch        - where to buy resources
 * ?sell_city=Caerleon      - where to sell (default: same as city)
 *
 * Quality:
 * ?quality=1               - item quality (1-5)
 *
 * Crafting mechanics:
 * ?premium=false           - has premium? (reduces tax from 8% to 4%)
 * ?return_rate=15          - % resources returned (15-47 based on spec/focus)
 * ?use_focus=false         - using focus? (affects return rate calculation)
 * ?crafting_fee=10         - station fee % (nutrition cost)
 * ?tax=8                   - market tax % when selling (8% normal, 4% premium)
 *
 * Filters:
 * ?min_profit=1000         - minimum profit after fees
 * ?max_profit_percent=100  - filter unrealistic profits (default 100%)
 * ?limit=20
 * ?max_age_hours=6         - filter stale item prices (default 6h)
 * ?max_resource_age_hours=6
 * ?min_resource_price=100  - avoid fake cheap resources
 * ?max_spread_percent=50   - avoid illiquid markets (default 50%)
 * ?require_buyers=true     - only show items with active buy orders
 * ?min_resources=2         - filter incomplete recipes
 * ?tier=4                  - filter by tier (optional)
 */
router.get('/profit', async (req, res) => {
    try {
        const buy_city = req.query.city || 'Lymhurst';
        const sell_city = req.query.sell_city || buy_city;
        const quality = parseInt(req.query.quality, 10) || 1;

        // Crafting mechanics
        const premium = req.query.premium === 'true';
        const return_rate = parseFloat(req.query.return_rate) || 15;
        const use_focus = req.query.use_focus === 'true';
        const crafting_fee_percent = parseFloat(req.query.crafting_fee) || 10;
        const tax_percent = parseFloat(req.query.tax) || (premium ? 4 : 8);

        // Filters - tighter defaults for realistic results
        const min_profit = parseInt(req.query.min_profit, 10) || 0;
        const max_profit_percent = parseInt(req.query.max_profit_percent, 10) || 100; // Cap unrealistic profits
        const limit = parseInt(req.query.limit, 10) || 20;
        const max_age_hours = parseInt(req.query.max_age_hours, 10) || 6; // Tighter default
        const max_resource_age_hours = parseInt(req.query.max_resource_age_hours, 10) || 6;
        const min_resource_price = parseInt(req.query.min_resource_price, 10) || 10;
        const max_spread_percent = parseInt(req.query.max_spread_percent, 10) || 50; // Tighter default
        const require_buyers = req.query.require_buyers !== 'false'; // Default true
        const min_resources = parseInt(req.query.min_resources, 10) || 2; // Filter incomplete recipes
        const tier = req.query.tier ? parseInt(req.query.tier, 10) : null;

        // Convert percentages to decimals for calculation
        const return_multiplier = (100 - return_rate) / 100; // e.g., 15% return = 0.85 cost
        const fee_multiplier = crafting_fee_percent / 100;
        const tax_multiplier = tax_percent / 100;

        const { rows } = await pool.query(
            `
            WITH resource_prices AS (
                SELECT
                    item_id,
                    sell_price_min AS price,
                    sell_price_min_date,
                    buy_price_max,
                    ROUND(((sell_price_min - buy_price_max)::numeric / NULLIF(buy_price_max, 0)) * 100, 2) AS spread
                FROM market_prices
                WHERE city = $1
                    AND quality = 1
                    AND sell_price_min > $9
                    AND sell_price_min_date >= NOW() - INTERVAL '1 hour' * $8
            ),
            item_prices AS (
                SELECT
                    item_id,
                    sell_price_min AS price,
                    sell_price_min_date,
                    buy_price_max,
                    ROUND(((sell_price_min - buy_price_max)::numeric / NULLIF(buy_price_max, 0)) * 100, 2) AS spread
                FROM market_prices
                WHERE city = $2
                    AND quality = $3
                    AND sell_price_min > 0
                    AND sell_price_min_date >= NOW() - INTERVAL '1 hour' * $7
                    -- Require active buyers if enabled
                    AND (NOT $13::boolean OR buy_price_max > 0)
            ),
            recipe_counts AS (
                -- Count total resources needed per item
                SELECT item_id, COUNT(*) AS total_resources
                FROM recipes
                GROUP BY item_id
            ),
            craft_costs AS (
                SELECT
                    r.item_id,
                    SUM(r.resource_count * rp.price) AS raw_cost,
                    COUNT(*) AS resources_with_price,
                    rc.total_resources,
                    MIN(rp.sell_price_min_date) AS oldest_resource_date,
                    MAX(rp.spread) AS max_resource_spread
                FROM recipes r
                JOIN recipe_counts rc ON r.item_id = rc.item_id
                LEFT JOIN resource_prices rp ON r.resource_id = rp.item_id
                GROUP BY r.item_id, rc.total_resources
                -- Only include items where ALL resources have prices
                HAVING COUNT(rp.price) = rc.total_resources
            ),
            profitable AS (
                SELECT
                    cc.item_id,
                    i.name AS item_name,
                    i.tier,
                    ip.price AS sell_price,

                    -- Costs breakdown
                    cc.raw_cost,
                    ROUND(cc.raw_cost * $4::numeric) AS effective_cost,        -- after return rate
                    ROUND(ip.price * $5::numeric) AS crafting_fee,             -- station fee
                    ROUND(ip.price * $6::numeric) AS market_tax,               -- sell tax

                    -- Net profit
                    ROUND(
                        ip.price * (1 - $6::numeric)                           -- sell price after tax
                        - cc.raw_cost * $4::numeric                            -- resource cost after returns
                        - ip.price * $5::numeric                               -- crafting fee
                    ) AS profit,

                    ROUND(
                        (
                            (ip.price * (1 - $6::numeric) - cc.raw_cost * $4::numeric - ip.price * $5::numeric)
                            / NULLIF(cc.raw_cost * $4::numeric, 0)
                        ) * 100, 2
                    ) AS profit_percent,

                    cc.resources_with_price AS resource_types,
                    ip.sell_price_min_date AS item_price_date,
                    cc.oldest_resource_date,
                    ip.spread AS item_spread,
                    cc.max_resource_spread
                FROM craft_costs cc
                JOIN item_prices ip ON cc.item_id = ip.item_id
                LEFT JOIN items i ON cc.item_id = i.id
                WHERE cc.resources_with_price >= $14  -- Minimum resources filter
                    AND (ip.spread IS NULL OR ip.spread <= $10)
                    AND (cc.max_resource_spread IS NULL OR cc.max_resource_spread <= $10)
                    ${tier ? `AND i.tier = ${tier}` : ''}
            )
            SELECT *
            FROM profitable
            WHERE profit >= $11
                AND (profit_percent IS NULL OR profit_percent <= $15)  -- Cap unrealistic profits
            ORDER BY profit DESC
            LIMIT $12
            `,
            [
                buy_city,           // $1
                sell_city,          // $2
                quality,            // $3
                return_multiplier,  // $4
                fee_multiplier,     // $5
                tax_multiplier,     // $6
                max_age_hours,      // $7
                max_resource_age_hours, // $8
                min_resource_price, // $9
                max_spread_percent, // $10
                min_profit,         // $11
                limit,              // $12
                require_buyers,     // $13
                min_resources,      // $14
                max_profit_percent  // $15
            ]
        );

        res.json({
            mode: 'crafting_profit',
            parameters: {
                buy_city,
                sell_city,
                quality,
                premium,
                return_rate: `${return_rate}%`,
                use_focus,
                crafting_fee: `${crafting_fee_percent}%`,
                market_tax: `${tax_percent}%`,
                min_profit,
                max_profit_percent: `${max_profit_percent}%`,
                max_age_hours,
                max_resource_age_hours,
                min_resource_price,
                max_spread_percent,
                require_buyers,
                min_resources,
                tier
            },
            formula: 'profit = (sell_price × (1 - tax)) - (resource_cost × (1 - return_rate)) - (sell_price × crafting_fee)',
            count: rows.length,
            results: rows,
        });

    } catch (error) {
        console.error('Error in /crafting/profit:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /crafting/profit/blackmarket
 * Crafting specifically for Black Market selling
 * Black Market has no tax, buys via buy orders (buy_price_max)
 */
router.get('/profit/blackmarket', async (req, res) => {
    try {
        const buy_city = req.query.city || 'Caerleon';
        const quality = parseInt(req.query.quality, 10) || 1;

        const premium = req.query.premium === 'true';
        const return_rate = parseFloat(req.query.return_rate) || 15;
        const crafting_fee_percent = parseFloat(req.query.crafting_fee) || 10;
        // Black Market has no tax regardless of premium

        const min_profit = parseInt(req.query.min_profit, 10) || 0;
        const limit = parseInt(req.query.limit, 10) || 20;
        const max_age_hours = parseInt(req.query.max_age_hours, 10) || 12;
        const max_resource_age_hours = parseInt(req.query.max_resource_age_hours, 10) || 6;
        const min_resource_price = parseInt(req.query.min_resource_price, 10) || 10;

        const return_multiplier = (100 - return_rate) / 100;
        const fee_multiplier = crafting_fee_percent / 100;

        const { rows } = await pool.query(
            `
            WITH resource_prices AS (
                SELECT item_id, sell_price_min AS price, sell_price_min_date
                FROM market_prices
                WHERE city = $1
                    AND quality = 1
                    AND sell_price_min > $7
                    AND sell_price_min_date >= NOW() - INTERVAL '1 hour' * $6
            ),
            bm_prices AS (
                -- Black Market buy orders (what they pay us)
                SELECT item_id, buy_price_max AS price, buy_price_max_date
                FROM market_prices
                WHERE city = 'Black Market'
                    AND quality = $2
                    AND buy_price_max > 0
                    AND buy_price_max_date >= NOW() - INTERVAL '1 hour' * $5
            ),
            recipe_counts AS (
                SELECT item_id, COUNT(*) AS total_resources
                FROM recipes
                GROUP BY item_id
            ),
            craft_costs AS (
                SELECT
                    r.item_id,
                    SUM(r.resource_count * rp.price) AS raw_cost,
                    COUNT(rp.price) AS resources_with_price,
                    rc.total_resources
                FROM recipes r
                JOIN recipe_counts rc ON r.item_id = rc.item_id
                LEFT JOIN resource_prices rp ON r.resource_id = rp.item_id
                GROUP BY r.item_id, rc.total_resources
                HAVING COUNT(rp.price) = rc.total_resources
            ),
            profitable AS (
                SELECT
                    cc.item_id,
                    i.name AS item_name,
                    i.tier,
                    bm.price AS bm_buy_price,
                    cc.raw_cost,
                    ROUND(cc.raw_cost * $3::numeric) AS effective_cost,
                    ROUND(bm.price * $4::numeric) AS crafting_fee,
                    ROUND(bm.price - cc.raw_cost * $3::numeric - bm.price * $4::numeric) AS profit,
                    ROUND(
                        ((bm.price - cc.raw_cost * $3::numeric - bm.price * $4::numeric) / NULLIF(cc.raw_cost * $3::numeric, 0)) * 100, 2
                    ) AS profit_percent,
                    bm.buy_price_max_date AS bm_order_date
                FROM craft_costs cc
                JOIN bm_prices bm ON cc.item_id = bm.item_id
                LEFT JOIN items i ON cc.item_id = i.id
            )
            SELECT * FROM profitable
            WHERE profit >= $8
            ORDER BY profit DESC
            LIMIT $9
            `,
            [
                buy_city,               // $1
                quality,                // $2
                return_multiplier,      // $3
                fee_multiplier,         // $4
                max_age_hours,          // $5
                max_resource_age_hours, // $6
                min_resource_price,     // $7
                min_profit,             // $8
                limit                   // $9
            ]
        );

        res.json({
            mode: 'crafting_for_blackmarket',
            note: 'Black Market has no sell tax',
            parameters: {
                buy_city,
                sell_city: 'Black Market',
                quality,
                premium,
                return_rate: `${return_rate}%`,
                crafting_fee: `${crafting_fee_percent}%`,
                min_profit,
                max_age_hours
            },
            count: rows.length,
            results: rows,
        });

    } catch (error) {
        console.error('Error in /crafting/profit/blackmarket:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /crafting/compare
 * Compare crafting same item across different cities
 */
router.get('/compare', async (req, res) => {
    try {
        const { item_id } = req.query;
        if (!item_id) {
            return res.status(400).json({ error: 'item_id required' });
        }

        const sell_city = req.query.sell_city || 'Caerleon';
        const quality = parseInt(req.query.quality, 10) || 1;
        const premium = req.query.premium === 'true';
        const return_rate = parseFloat(req.query.return_rate) || 15;
        const crafting_fee_percent = parseFloat(req.query.crafting_fee) || 10;
        const tax_percent = parseFloat(req.query.tax) || (premium ? 4 : 8);

        const return_multiplier = (100 - return_rate) / 100;
        const fee_multiplier = crafting_fee_percent / 100;
        const tax_multiplier = tax_percent / 100;

        const CITIES = ['Bridgewatch', 'Martlock', 'Thetford', 'Fort Sterling', 'Lymhurst', 'Caerleon', 'Brecilien'];

        const { rows } = await pool.query(
            `
            WITH sell_price AS (
                SELECT sell_price_min AS price
                FROM market_prices
                WHERE item_id = $1 AND city = $2 AND quality = $3
            ),
            recipe_count AS (
                SELECT COUNT(*) AS total FROM recipes WHERE item_id = $1
            ),
            city_costs AS (
                SELECT
                    mp.city AS buy_city,
                    SUM(r.resource_count * mp.sell_price_min) AS raw_cost,
                    MIN(mp.sell_price_min_date) AS oldest_date,
                    COUNT(mp.sell_price_min) AS resources_found
                FROM recipes r
                LEFT JOIN market_prices mp ON r.resource_id = mp.item_id
                    AND mp.quality = 1
                    AND mp.city = ANY($4::text[])
                WHERE r.item_id = $1
                GROUP BY mp.city
            )
            SELECT
                cc.buy_city,
                $2 AS sell_city,
                sp.price AS sell_price,
                cc.raw_cost,
                ROUND(cc.raw_cost * $5::numeric) AS effective_cost,
                ROUND(sp.price * $6::numeric) AS crafting_fee,
                ROUND(sp.price * $7::numeric) AS market_tax,
                ROUND(
                    sp.price * (1 - $7::numeric) - cc.raw_cost * $5::numeric - sp.price * $6::numeric
                ) AS profit,
                cc.oldest_date
            FROM city_costs cc
            CROSS JOIN sell_price sp
            CROSS JOIN recipe_count rc
            WHERE cc.resources_found = rc.total AND cc.raw_cost > 0
            ORDER BY profit DESC
            `,
            [
                item_id,            // $1
                sell_city,          // $2
                quality,            // $3
                CITIES,             // $4
                return_multiplier,  // $5
                fee_multiplier,     // $6
                tax_multiplier      // $7
            ]
        );

        res.json({
            item_id,
            sell_city,
            quality,
            parameters: {
                premium,
                return_rate: `${return_rate}%`,
                crafting_fee: `${crafting_fee_percent}%`,
                market_tax: `${tax_percent}%`
            },
            cities: rows,
        });

    } catch (error) {
        console.error('Error in /crafting/compare:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /crafting/recipe/:item_id
 * Get recipe details with current prices
 */
router.get('/recipe/:item_id', async (req, res) => {
    try {
        const { item_id } = req.params;
        const city = req.query.city || 'Bridgewatch';
        const quality = parseInt(req.query.quality, 10) || 1;
        const premium = req.query.premium === 'true';
        const return_rate = parseFloat(req.query.return_rate) || 15;
        const tax_percent = premium ? 4 : 8;

        const { rows } = await pool.query(
            `
            SELECT
                r.item_id,
                r.resource_id,
                r.resource_count,
                i.name AS resource_name,
                mp.sell_price_min AS resource_price,
                mp.sell_price_min_date AS price_date,
                (r.resource_count * mp.sell_price_min) AS line_cost
            FROM recipes r
            LEFT JOIN items i ON r.resource_id = i.id
            LEFT JOIN market_prices mp ON r.resource_id = mp.item_id
                AND mp.city = $2 AND mp.quality = 1
            WHERE r.item_id = $1
            ORDER BY line_cost DESC
            `,
            [item_id, city]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Recipe not found' });
        }

        const itemPrice = await pool.query(
            `SELECT sell_price_min, buy_price_max, sell_price_min_date
             FROM market_prices
             WHERE item_id = $1 AND city = $2 AND quality = $3`,
            [item_id, city, quality]
        );

        const rawCost = rows.reduce((sum, r) => sum + (parseInt(r.line_cost) || 0), 0);
        const effectiveCost = Math.round(rawCost * (100 - return_rate) / 100);
        const sellPrice = itemPrice.rows[0]?.sell_price_min || 0;
        const buyPrice = itemPrice.rows[0]?.buy_price_max || 0;

        const taxAmount = Math.round(sellPrice * tax_percent / 100);
        const profitAfterTax = sellPrice - taxAmount - effectiveCost;

        res.json({
            item_id,
            city,
            quality,
            premium,
            sell_price: sellPrice,
            instant_sell_price: buyPrice,
            raw_cost: rawCost,
            effective_cost: effectiveCost,
            return_rate: `${return_rate}%`,
            market_tax: `${tax_percent}%`,
            tax_amount: taxAmount,
            profit_if_sell_order: profitAfterTax,
            profit_if_instant_sell: buyPrice - effectiveCost,
            resources: rows,
        });

    } catch (error) {
        console.error('Error in /crafting/recipe:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /crafting/profit/full
 * Calculate profit using FULL crafting chain (raw materials only)
 * Recursively expands all craftable ingredients to their raw components
 */
router.get('/profit/full', async (req, res) => {
    try {
        const buy_city = req.query.city || 'Bridgewatch';
        const sell_city = req.query.sell_city || buy_city;
        const quality = parseInt(req.query.quality, 10) || 1;

        const premium = req.query.premium === 'true';
        const return_rate = parseFloat(req.query.return_rate) || 15;
        const crafting_fee_percent = parseFloat(req.query.crafting_fee) || 10;
        const tax_percent = parseFloat(req.query.tax) || (premium ? 4 : 8);

        const min_profit = parseInt(req.query.min_profit, 10) || 0;
        const limit = parseInt(req.query.limit, 10) || 20;
        const max_age_hours = parseInt(req.query.max_age_hours, 10) || 24;
        const min_resource_price = parseInt(req.query.min_resource_price, 10) || 10;
        const tier = req.query.tier ? parseInt(req.query.tier, 10) : null;

        const return_multiplier = (100 - return_rate) / 100;
        const fee_multiplier = crafting_fee_percent / 100;
        const tax_multiplier = tax_percent / 100;

        const { rows } = await pool.query(
            `
            WITH RECURSIVE craft_tree AS (
                -- Base: all craftable items and their direct ingredients
                SELECT
                    r.item_id AS root_item,
                    r.item_id AS current_item,
                    r.resource_id,
                    r.resource_count::numeric AS total_count,
                    1 AS depth
                FROM recipes r

                UNION ALL

                -- Recursive: expand ingredients that are themselves craftable
                SELECT
                    ct.root_item,
                    r.item_id AS current_item,
                    r.resource_id,
                    ct.total_count * r.resource_count AS total_count,
                    ct.depth + 1
                FROM craft_tree ct
                JOIN recipes r ON r.item_id = ct.resource_id
                WHERE ct.depth < 5  -- Max 5 levels deep
            ),
            -- Get only raw materials (items with no recipe)
            raw_materials AS (
                SELECT
                    ct.root_item,
                    ct.resource_id,
                    SUM(ct.total_count) AS total_count
                FROM craft_tree ct
                WHERE NOT EXISTS (
                    SELECT 1 FROM recipes r WHERE r.item_id = ct.resource_id
                )
                GROUP BY ct.root_item, ct.resource_id
            ),
            -- Get prices for raw materials
            raw_prices AS (
                SELECT
                    item_id,
                    sell_price_min AS price,
                    sell_price_min_date
                FROM market_prices
                WHERE city = $1
                    AND quality = 1
                    AND sell_price_min > $7
                    AND sell_price_min_date >= NOW() - INTERVAL '1 hour' * $6
            ),
            -- Count raw materials per item
            raw_material_counts AS (
                SELECT root_item, COUNT(*) AS total_materials
                FROM raw_materials
                GROUP BY root_item
            ),
            -- Calculate total raw material cost per item
            raw_costs AS (
                SELECT
                    rm.root_item AS item_id,
                    SUM(rm.total_count * rp.price) AS raw_cost,
                    COUNT(rp.price) AS materials_with_price,
                    rmc.total_materials
                FROM raw_materials rm
                JOIN raw_material_counts rmc ON rm.root_item = rmc.root_item
                LEFT JOIN raw_prices rp ON rm.resource_id = rp.item_id
                GROUP BY rm.root_item, rmc.total_materials
                HAVING COUNT(rp.price) = rmc.total_materials
            ),
            -- Get sell prices for crafted items
            item_prices AS (
                SELECT
                    item_id,
                    sell_price_min AS price,
                    sell_price_min_date
                FROM market_prices
                WHERE city = $2
                    AND quality = $3
                    AND sell_price_min > 0
                    AND sell_price_min_date >= NOW() - INTERVAL '1 hour' * $6
            ),
            profitable AS (
                SELECT
                    rc.item_id,
                    i.name AS item_name,
                    i.tier,
                    ip.price AS sell_price,
                    rc.raw_cost,
                    ROUND(rc.raw_cost * $4::numeric) AS effective_cost,
                    ROUND(ip.price * $5::numeric) AS crafting_fee,
                    ROUND(ip.price * $8::numeric) AS market_tax,
                    ROUND(
                        ip.price * (1 - $8::numeric)
                        - rc.raw_cost * $4::numeric
                        - ip.price * $5::numeric
                    ) AS profit,
                    ROUND(
                        (
                            (ip.price * (1 - $8::numeric) - rc.raw_cost * $4::numeric - ip.price * $5::numeric)
                            / NULLIF(rc.raw_cost * $4::numeric, 0)
                        ) * 100, 2
                    ) AS profit_percent,
                    rc.material_types,
                    ip.sell_price_min_date AS item_price_date
                FROM raw_costs rc
                JOIN item_prices ip ON rc.item_id = ip.item_id
                LEFT JOIN items i ON rc.item_id = i.id
                WHERE 1=1
                    ${tier ? `AND i.tier = ${tier}` : ''}
            )
            SELECT * FROM profitable
            WHERE profit >= $9
            ORDER BY profit DESC
            LIMIT $10
            `,
            [
                buy_city,           // $1
                sell_city,          // $2
                quality,            // $3
                return_multiplier,  // $4
                fee_multiplier,     // $5
                max_age_hours,      // $6
                min_resource_price, // $7
                tax_multiplier,     // $8
                min_profit,         // $9
                limit               // $10
            ]
        );

        res.json({
            mode: 'crafting_profit_full_chain',
            note: 'Costs calculated from RAW materials only (recursive)',
            parameters: {
                buy_city,
                sell_city,
                quality,
                premium,
                return_rate: `${return_rate}%`,
                crafting_fee: `${crafting_fee_percent}%`,
                market_tax: `${tax_percent}%`,
                min_profit,
                max_age_hours,
                tier
            },
            count: rows.length,
            results: rows,
        });

    } catch (error) {
        console.error('Error in /crafting/profit/full:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /crafting/chain/:item_id
 * Show the full crafting chain for an item (all raw materials needed)
 */
router.get('/chain/:item_id', async (req, res) => {
    try {
        const { item_id } = req.params;
        const city = req.query.city || 'Bridgewatch';
        const return_rate = parseFloat(req.query.return_rate) || 15;

        const { rows } = await pool.query(
            `
            WITH RECURSIVE craft_tree AS (
                -- Base: direct ingredients
                SELECT
                    r.resource_id,
                    r.resource_count::numeric AS total_count,
                    r.resource_id AS path,
                    1 AS depth
                FROM recipes r
                WHERE r.item_id = $1

                UNION ALL

                -- Recursive: ingredients of ingredients
                SELECT
                    r.resource_id,
                    ct.total_count * r.resource_count,
                    ct.path || ' -> ' || r.resource_id,
                    ct.depth + 1
                FROM craft_tree ct
                JOIN recipes r ON r.item_id = ct.resource_id
                WHERE ct.depth < 5
            ),
            raw_materials AS (
                SELECT
                    ct.resource_id,
                    SUM(ct.total_count) AS total_count,
                    MAX(ct.depth) AS depth
                FROM craft_tree ct
                WHERE NOT EXISTS (
                    SELECT 1 FROM recipes r WHERE r.item_id = ct.resource_id
                )
                GROUP BY ct.resource_id
            )
            SELECT
                rm.resource_id,
                i.name AS resource_name,
                rm.total_count,
                rm.depth AS chain_depth,
                mp.sell_price_min AS unit_price,
                ROUND(rm.total_count * mp.sell_price_min) AS line_cost,
                mp.sell_price_min_date AS price_date
            FROM raw_materials rm
            LEFT JOIN items i ON rm.resource_id = i.id
            LEFT JOIN market_prices mp ON rm.resource_id = mp.item_id
                AND mp.city = $2 AND mp.quality = 1
            ORDER BY line_cost DESC NULLS LAST
            `,
            [item_id, city]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Item has no recipe or not found' });
        }

        const rawCost = rows.reduce((sum, r) => sum + (parseInt(r.line_cost) || 0), 0);
        const effectiveCost = Math.round(rawCost * (100 - return_rate) / 100);

        // Get item sell price
        const itemPrice = await pool.query(
            `SELECT sell_price_min FROM market_prices
             WHERE item_id = $1 AND city = $2 AND quality = 1`,
            [item_id, city]
        );

        const sellPrice = itemPrice.rows[0]?.sell_price_min || 0;

        res.json({
            item_id,
            city,
            note: 'Full crafting chain expanded to raw materials',
            sell_price: sellPrice,
            raw_materials_cost: rawCost,
            effective_cost: effectiveCost,
            return_rate: `${return_rate}%`,
            profit: sellPrice - effectiveCost,
            raw_materials: rows,
        });

    } catch (error) {
        console.error('Error in /crafting/chain:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /crafting/details/:item_id
 * Get full crafting details with prices from ALL cities
 * Shows resources costs per city and sell prices per city
 */
router.get('/details/:item_id', async (req, res) => {
    try {
        const { item_id } = req.params;
        const quality = parseInt(req.query.quality, 10) || 1;
        const premium = req.query.premium === 'true';
        const return_rate = parseFloat(req.query.return_rate) || 15;
        const crafting_fee_percent = parseFloat(req.query.crafting_fee) || 10; // Default 10% crafting fee
        const tax_percent = premium ? 4 : 8;

        const CITIES = ['Bridgewatch', 'Martlock', 'Thetford', 'Fort Sterling', 'Lymhurst', 'Caerleon', 'Brecilien'];

        // Get item info including amount_crafted
        const itemInfo = await pool.query(
            `SELECT id, name, tier, amount_crafted FROM items WHERE id = $1`,
            [item_id]
        );

        if (itemInfo.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const amountCrafted = itemInfo.rows[0].amount_crafted || 1;

        // Get recipe
        const recipeResult = await pool.query(
            `SELECT r.resource_id, r.resource_count, i.name AS resource_name
             FROM recipes r
             LEFT JOIN items i ON r.resource_id = i.id
             WHERE r.item_id = $1
             ORDER BY r.resource_count DESC`,
            [item_id]
        );

        if (recipeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Recipe not found for this item' });
        }

        // Get resource prices from all cities
        const resourceIds = recipeResult.rows.map(r => r.resource_id);
        const resourcePrices = await pool.query(
            `SELECT item_id, city, sell_price_min, sell_price_min_date
             FROM market_prices
             WHERE item_id = ANY($1) AND quality = 1
             ORDER BY item_id, sell_price_min ASC`,
            [resourceIds]
        );

        // Get item sell prices from all cities (including Black Market)
        const allCities = [...CITIES, 'Black Market'];
        const itemPrices = await pool.query(
            `SELECT city, sell_price_min, buy_price_max, sell_price_min_date, buy_price_max_date
             FROM market_prices
             WHERE item_id = $1 AND quality = $2 AND city = ANY($3)
             ORDER BY sell_price_min DESC`,
            [item_id, quality, allCities]
        );

        // Build resource price map: { resource_id: { city: price } }
        const priceMap = {};
        for (const rp of resourcePrices.rows) {
            if (!priceMap[rp.item_id]) priceMap[rp.item_id] = {};
            priceMap[rp.item_id][rp.city] = {
                price: rp.sell_price_min,
                date: rp.sell_price_min_date
            };
        }

        // Build resources array with prices per city
        const resources = recipeResult.rows.map(r => {
            const cityPrices = {};
            let cheapestCity = null;
            let cheapestPrice = Infinity;

            for (const city of CITIES) {
                const priceData = priceMap[r.resource_id]?.[city];
                if (priceData && priceData.price > 0) {
                    cityPrices[city] = {
                        unit_price: priceData.price,
                        total_price: priceData.price * r.resource_count,
                        date: priceData.date
                    };
                    if (priceData.price < cheapestPrice) {
                        cheapestPrice = priceData.price;
                        cheapestCity = city;
                    }
                } else {
                    cityPrices[city] = null;
                }
            }

            return {
                resource_id: r.resource_id,
                resource_name: r.resource_name,
                count: r.resource_count,
                prices: cityPrices,
                cheapest: cheapestCity ? {
                    city: cheapestCity,
                    unit_price: cheapestPrice,
                    total_price: cheapestPrice * r.resource_count
                } : null
            };
        });

        // Calculate total cost per city
        const costPerCity = {};
        for (const city of CITIES) {
            let total = 0;
            let hasAllPrices = true;
            for (const r of resources) {
                if (r.prices[city]) {
                    total += r.prices[city].total_price;
                } else {
                    hasAllPrices = false;
                }
            }
            costPerCity[city] = hasAllPrices ? total : null;
        }

        // Calculate cheapest combination (buy each resource from cheapest city)
        let cheapestTotalCost = 0;
        let allResourcesAvailable = true;
        for (const r of resources) {
            if (r.cheapest) {
                cheapestTotalCost += r.cheapest.total_price;
            } else {
                allResourcesAvailable = false;
            }
        }

        // Build sell prices array
        // For consumables (potions=5, meals=10), we craft multiple items at once
        const effectiveCost = Math.round(cheapestTotalCost * (100 - return_rate) / 100);

        const sellPrices = itemPrices.rows.map(p => {
            const sellPrice = p.sell_price_min || 0;
            const instantSellPrice = p.buy_price_max || 0;

            // Revenue = price per item * amount crafted
            const totalSellRevenue = sellPrice * amountCrafted;
            const totalInstantRevenue = instantSellPrice * amountCrafted;

            // Tax is per item sold (market tax when selling)
            const totalTax = Math.round(sellPrice * tax_percent / 100) * amountCrafted;

            // Crafting fee is based on item value (paid once per craft, not per item)
            // Fee = item_value * crafting_fee_percent / 100
            const craftingFee = Math.round(sellPrice * crafting_fee_percent / 100);

            return {
                city: p.city,
                sell_price: sellPrice,
                instant_sell_price: instantSellPrice,
                sell_date: p.sell_price_min_date,
                buy_date: p.buy_price_max_date,
                crafting_fee: craftingFee,
                // Profit = (sell_price * amount) - tax - crafting_fee - resource_cost
                profit_if_sell_order: allResourcesAvailable ? totalSellRevenue - totalTax - craftingFee - effectiveCost : null,
                profit_if_instant: allResourcesAvailable ? totalInstantRevenue - craftingFee - effectiveCost : null
            };
        });

        // Find best sell city
        const bestSellOrder = sellPrices.filter(s => s.profit_if_sell_order !== null)
            .sort((a, b) => b.profit_if_sell_order - a.profit_if_sell_order)[0];
        const bestInstant = sellPrices.filter(s => s.profit_if_instant !== null)
            .sort((a, b) => b.profit_if_instant - a.profit_if_instant)[0];

        res.json({
            item: {
                id: item_id,
                name: itemInfo.rows[0].name,
                tier: itemInfo.rows[0].tier,
                quality,
                amount_crafted: amountCrafted
            },
            settings: {
                premium,
                return_rate: `${return_rate}%`,
                crafting_fee: `${crafting_fee_percent}%`,
                tax: `${tax_percent}%`
            },
            resources,
            cost_per_city: costPerCity,
            cheapest_total: {
                cost: allResourcesAvailable ? cheapestTotalCost : null,
                effective_cost: allResourcesAvailable ? effectiveCost : null
            },
            sell_prices: sellPrices,
            recommendation: {
                best_sell_order: bestSellOrder ? {
                    city: bestSellOrder.city,
                    profit: bestSellOrder.profit_if_sell_order
                } : null,
                best_instant: bestInstant ? {
                    city: bestInstant.city,
                    profit: bestInstant.profit_if_instant
                } : null
            }
        });

    } catch (error) {
        console.error('Error in /crafting/details:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
