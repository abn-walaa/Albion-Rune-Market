import { Router } from 'express';
import { fetchPrices } from '../../fetchPrices.js';
import { pool } from '../../db.js';

const router = Router();

// Sync state
let syncState = {
    isRunning: false,
    lastSync: null,
    lastError: null,
    priceCount: 0
};

/**
 * GET /sync/status
 * Get current sync status
 */
router.get('/status', async (req, res) => {
    try {
        // Get price count and latest update time from DB
        const { rows } = await pool.query(`
            SELECT
                COUNT(*) as total_prices,
                MAX(GREATEST(sell_price_min_date, buy_price_max_date)) as latest_update
            FROM market_prices
            WHERE sell_price_min_date IS NOT NULL OR buy_price_max_date IS NOT NULL
        `);

        res.json({
            isRunning: syncState.isRunning,
            lastSync: syncState.lastSync,
            lastError: syncState.lastError,
            totalPrices: parseInt(rows[0].total_prices) || 0,
            latestUpdate: rows[0].latest_update
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /sync/prices
 * Trigger a manual price sync
 */
router.post('/prices', async (req, res) => {
    if (syncState.isRunning) {
        return res.status(409).json({
            error: 'Sync already in progress',
            isRunning: true
        });
    }

    // Start sync in background
    syncState.isRunning = true;
    syncState.lastError = null;

    res.json({
        message: 'Sync started',
        isRunning: true
    });

    // Run sync asynchronously
    try {
        await fetchPrices();
        syncState.lastSync = new Date().toISOString();
        syncState.lastError = null;
    } catch (error) {
        syncState.lastError = error.message;
        console.error('Manual sync failed:', error);
    } finally {
        syncState.isRunning = false;
    }
});

export default router;
