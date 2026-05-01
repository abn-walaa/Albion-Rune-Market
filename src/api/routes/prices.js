import { Router } from 'express';
import { pool } from '../../db.js';

const router = Router();

/**
 * GET /prices/latest
 * ?item_id=T4_BAG
 * ?city=Caerleon
 */
router.get('/latest', async (req, res) => {
    const { item_id, city } = req.query;

    if (!item_id) {
        return res.status(400).json({ error: 'item_id required' });
    }

    const params = [item_id];
    let where = 'WHERE item_id = $1';

    if (city) {
        params.push(city);
        where += ` AND city = $${params.length}`;
    }

    const { rows } = await pool.query(
        `SELECT * FROM market_prices ${where} ORDER BY sell_price_min_date DESC`,
        params
    );

    res.json(rows);
});

/**
 * GET /prices/history
 * ?item_id=T4_BAG
 * ?city=Caerleon
 * ?from=2026-04-01
 * ?to=2026-04-17
 */
router.get('/history', async (req, res) => {
    const { item_id, city, from, to } = req.query;

    if (!item_id || !city) {
        return res.status(400).json({ error: 'item_id and city required' });
    }

    const params = [item_id, city];
    let where = 'WHERE item_id = $1 AND city = $2';

    if (from) {
        params.push(from);
        where += ` AND hour_bucket >= $${params.length}`;
    }

    if (to) {
        params.push(to);
        where += ` AND hour_bucket <= $${params.length}`;
    }

    const { rows } = await pool.query(
        `SELECT * FROM market_prices_history ${where} ORDER BY hour_bucket`,
        params
    );

    res.json(rows);
});

/**
 * GET /prices/profit
 */
router.get('/profit', async (req, res) => {
    const { item_id, from_city, to_city, quality = 1 } = req.query;

    if (!item_id || !from_city || !to_city) {
        return res.status(400).json({ error: 'item_id, from_city, and to_city are required' });
    }

    const { rows } = await pool.query(
        `
        SELECT
            buy.buy_price_max AS buy_price,
            sell.sell_price_min AS sell_price,
            sell.sell_price_min_date AS time,
            (sell.sell_price_min - buy.buy_price_max) AS profit,
            ROUND(
                ((sell.sell_price_min - buy.buy_price_max)::numeric /
                NULLIF(buy.buy_price_max, 0)) * 100, 2
            ) AS profit_percent
        FROM market_prices buy
        JOIN market_prices sell
            ON buy.item_id = sell.item_id AND buy.quality = sell.quality
        WHERE buy.item_id = $1
            AND buy.city = $2
            AND sell.city = $3
            AND buy.quality = $4
            AND buy.buy_price_max > 0
            AND sell.sell_price_min > 0
        `,
        [item_id, from_city, to_city, quality]
    );

    if (!rows.length) {
        return res.status(404).json({ error: 'No data available for this item/city pair' });
    }

    res.json({ item_id, from_city, to_city, quality, ...rows[0] });
});

/**
 * GET /prices/profit/best
 */
router.get('/profit/best', async (req, res) => {
    const { item_id, quality = 1, min_profit = 0, limit = 10 } = req.query;

    if (!item_id) {
        return res.status(400).json({ error: 'item_id is required' });
    }

    const { rows } = await pool.query(
        `
        WITH prices AS (
            SELECT city, buy_price_max, sell_price_min, sell_price_min_date
            FROM market_prices
            WHERE item_id = $1 AND quality = $2
                AND buy_price_max > 0 AND sell_price_min > 0
        )
        SELECT
            b.city AS buy_city,
            s.city AS sell_city,
            b.buy_price_max AS buy_price,
            s.sell_price_min AS sell_price,
            (s.sell_price_min - b.buy_price_max) AS profit,
            ROUND(
                ((s.sell_price_min - b.buy_price_max)::numeric / b.buy_price_max) * 100, 2
            ) AS profit_percent,
            s.sell_price_min_date AS time
        FROM prices b
        JOIN prices s ON b.city <> s.city
        WHERE (s.sell_price_min - b.buy_price_max) >= $3
        ORDER BY profit DESC
        LIMIT $4
        `,
        [item_id, quality, min_profit, limit]
    );

    res.json({ item_id, quality, routes: rows });
});

/**
 * GET /prices/profit/top
 * Instant arbitrage (SELL -> SELL)
 */
router.get('/profit/top', async (req, res) => {
    const { quality = 1, min_profit = 0, limit = 10 } = req.query;

    const { rows } = await pool.query(
        `
        WITH prices AS (
            SELECT item_id, city, sell_price_min, sell_price_min_date
            FROM market_prices
            WHERE quality = $1 AND sell_price_min > 0
        ),
        best_buy AS (
            SELECT DISTINCT ON (item_id)
                item_id, city AS buy_city, sell_price_min AS buy_price,
                sell_price_min_date AS buy_order_date
            FROM prices
            ORDER BY item_id, sell_price_min ASC
        ),
        best_sell AS (
            SELECT DISTINCT ON (item_id)
                item_id, city AS sell_city, sell_price_min AS sell_price,
                sell_price_min_date AS sell_order_date
            FROM prices
            ORDER BY item_id, sell_price_min DESC
        )
        SELECT
            b.item_id, b.buy_city, s.sell_city,
            b.buy_price, s.sell_price,
            b.buy_order_date AS snapshot_time,
            (s.sell_price - b.buy_price) AS profit,
            ROUND(((s.sell_price - b.buy_price)::numeric / b.buy_price) * 100, 2) AS profit_percent,
            b.buy_order_date, s.sell_order_date
        FROM best_buy b
        JOIN best_sell s ON b.item_id = s.item_id
        WHERE b.buy_city <> s.sell_city AND (s.sell_price - b.buy_price) >= $2
        ORDER BY profit DESC
        LIMIT $3
        `,
        [quality, min_profit, limit]
    );

    res.json({
        mode: 'instant_sell_to_sell',
        quality,
        count: rows.length,
        results: rows,
    });
});

/**
 * GET /prices/profit/transport
 */
router.get('/profit/transport', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 50;
        const min_profit = parseInt(req.query.min_profit, 10) || 0;
        const quality = parseInt(req.query.quality, 10) || 1;
        const start_city = req.query.start_city || null;
        const end_city = req.query.end_city || null;
        const max_age_hours = parseInt(req.query.max_age_hours, 10) || 6; // Tighter: 6h instead of 24h
        const max_profit_percent = parseInt(req.query.max_profit_percent, 10) || 50; // Tighter: 50% instead of 500%
        const max_buy_price = parseInt(req.query.max_buy_price, 10) || 2000000000;
        const min_buy_price = parseInt(req.query.min_buy_price, 10) || 1000;
        const max_spread_percent = parseInt(req.query.max_spread_percent, 10) || 50; // Tighter: 50% instead of 300%
        const strict_volume_check = req.query.strict_volume_check !== 'false';
        const max_volatility_percent = parseInt(req.query.max_volatility_percent, 10) || 25;
        const exclude_low_volume = req.query.exclude_low_volume !== 'false';

        const LOCATIONS = ['Bridgewatch', 'Martlock', 'Thetford', 'Fort Sterling', 'Lymhurst', 'Caerleon', 'Brecilien'];

        const { rows } = await pool.query(
            `
            WITH snapshot AS (
                SELECT item_id, city, sell_price_min, sell_price_min_date,
                       buy_price_max, buy_price_max_date
                FROM market_prices
                WHERE quality = $1
                    AND city = ANY($7::text[])
                    AND sell_price_min > 0
                    AND sell_price_min_date >= NOW() - INTERVAL '1 hour' * $4
            ),
            past_prices AS (
                SELECT item_id, city, sell_price_avg AS past_sell_price
                FROM market_prices_history
                WHERE hour_bucket = DATE_TRUNC('hour', NOW()) - INTERVAL '2 hours'
                    AND quality = $1
            ),
            all_routes AS (
                SELECT
                    b.item_id,
                    b.city AS buy_city,
                    s.city AS sell_city,
                    b.sell_price_min AS buy_price,
                    s.sell_price_min AS sell_price,
                    b.sell_price_min_date AS snapshot_time,
                    (s.sell_price_min - b.sell_price_min) AS profit,
                    ROUND(((s.sell_price_min - b.sell_price_min)::numeric / b.sell_price_min) * 100, 2) AS profit_percent,
                    ROUND(((b.sell_price_min - b.buy_price_max)::numeric / NULLIF(b.buy_price_max, 0)) * 100, 2) AS origin_spread,
                    ROUND(((s.sell_price_min - s.buy_price_max)::numeric / NULLIF(s.buy_price_max, 0)) * 100, 2) AS dest_spread,
                    ROUND((ABS(b.sell_price_min - p.past_sell_price)::numeric / NULLIF(p.past_sell_price, 0)) * 100, 2) AS origin_volatility,
                    b.sell_price_min_date AS buy_order_date,
                    s.sell_price_min_date AS sell_order_date
                FROM snapshot b
                JOIN snapshot s ON b.item_id = s.item_id AND b.city <> s.city
                LEFT JOIN past_prices p ON b.item_id = p.item_id AND b.city = p.city
                WHERE b.sell_price_min <= $5
                    AND b.sell_price_min >= $6
                    AND ($9::text IS NULL OR b.city = $9)
                    AND ($10::text IS NULL OR s.city = $10)
                    AND (NOT $11::boolean OR (
                        s.buy_price_max > 0
                        AND s.buy_price_max_date >= NOW() - INTERVAL '1 hour' * $4
                        AND ((s.sell_price_min - s.buy_price_max)::numeric / s.buy_price_max) <= 5.0
                    ))
                ${exclude_low_volume ? `AND b.item_id !~ '(ARTEFACT|FURNITURE|JOURNAL|TRASH|TOKEN)'` : ''}
            ),
            best_routes AS (
                SELECT DISTINCT ON (item_id) *
                FROM all_routes
                WHERE profit >= $2
                    AND profit_percent <= $3
                    AND origin_spread <= $8
                    AND (origin_volatility <= $12 OR origin_volatility IS NULL)
                ORDER BY item_id, profit DESC, sell_order_date DESC
            )
            SELECT
                r.item_id,
                CASE WHEN r.item_id LIKE '%@%' THEN i.name || ' .' || SPLIT_PART(r.item_id, '@', 2) ELSE i.name END AS item_name,
                r.buy_city, r.sell_city, r.buy_price, r.sell_price, r.snapshot_time,
                r.profit, r.profit_percent, r.origin_spread, r.dest_spread, r.origin_volatility,
                r.buy_order_date, r.sell_order_date
            FROM best_routes r
            LEFT JOIN items i ON r.item_id = i.id
            ORDER BY r.profit DESC
            LIMIT $13
            `,
            [
                quality, min_profit, max_profit_percent, max_age_hours,
                max_buy_price, min_buy_price, LOCATIONS, max_spread_percent,
                start_city, end_city, strict_volume_check, max_volatility_percent, limit
            ]
        );

        res.json({
            mode: 'sell_to_sell_transport',
            parameters: {
                start_city, end_city, quality, limit, min_profit,
                min_buy_price, max_buy_price, max_age_hours,
                max_profit_percent, max_spread_percent, max_volatility_percent,
                strict_volume_check, exclude_low_volume
            },
            count: rows.length,
            results: rows,
        });

    } catch (error) {
        console.error('Error in /profit/transport:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /prices/profit/black-market
 */
router.get('/profit/black-market', async (req, res) => {
    try {
        const quality = parseInt(req.query.quality, 10) || 1;
        const min_profit = parseInt(req.query.min_profit, 10) || 0;
        const limit = parseInt(req.query.limit, 10) || 10;
        const max_age_hours = parseInt(req.query.max_age_hours, 10) || 24;
        const max_profit_percent = parseInt(req.query.max_profit_percent, 10) || 500;
        const max_buy_price = parseInt(req.query.max_buy_price, 10) || 2000000000;

        const { rows } = await pool.query(
            `
            WITH buyers AS (
                SELECT item_id, city AS buy_city, sell_price_min AS buy_price,
                       sell_price_min_date AS buy_order_date, sell_price_min_date AS snapshot_time
                FROM market_prices
                WHERE city <> 'Black Market'
                    AND quality = $1
                    AND sell_price_min > 0
                    AND sell_price_min_date >= NOW() - INTERVAL '1 hour' * $4
                    AND sell_price_min <= $6
            ),
            sellers AS (
                SELECT item_id, city AS sell_city, buy_price_max AS sell_price,
                       buy_price_max_date AS sell_order_date
                FROM market_prices
                WHERE city = 'Black Market'
                    AND quality = $1
                    AND buy_price_max > 0
                    AND buy_price_max_date >= NOW() - INTERVAL '1 hour' * $4
            ),
            all_routes AS (
                SELECT
                    b.item_id, b.buy_city, s.sell_city, b.buy_price, s.sell_price,
                    b.snapshot_time,
                    (s.sell_price - b.buy_price) AS profit,
                    ROUND(((s.sell_price - b.buy_price)::numeric / b.buy_price) * 100, 2) AS profit_percent,
                    b.buy_order_date, s.sell_order_date
                FROM buyers b
                JOIN sellers s ON b.item_id = s.item_id
            ),
            best_routes AS (
                SELECT DISTINCT ON (item_id) *
                FROM all_routes
                WHERE profit >= $2 AND profit_percent <= $5
                ORDER BY item_id, profit DESC, sell_order_date DESC
            )
            SELECT
                r.item_id, i.name AS item_name, r.buy_city, r.sell_city,
                r.buy_price, r.sell_price, r.snapshot_time, r.profit, r.profit_percent,
                r.buy_order_date, r.sell_order_date
            FROM best_routes r
            LEFT JOIN items i ON r.item_id = i.id
            ORDER BY r.profit DESC
            LIMIT $3
            `,
            [quality, min_profit, limit, max_age_hours, max_profit_percent, max_buy_price]
        );

        res.json({
            mode: 'royal_to_black_market',
            parameters: { quality, min_profit, max_buy_price, max_age_hours, max_profit_percent },
            count: rows.length,
            results: rows,
        });

    } catch (error) {
        console.error('Error in /profit/black-market:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
