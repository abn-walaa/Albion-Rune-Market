/**
 * Live Price Fetcher
 * Fetches prices directly from the Albion Online Data API
 */

import { api } from './apiClient.js';

const API_REGION = process.env.API_REGION || 'west';
const BASE_URL = `https://${API_REGION}.albion-online-data.com/api/v2/stats/prices`;

const CITIES = [
    'Caerleon',
    'Bridgewatch',
    'Martlock',
    'Thetford',
    'Fort Sterling',
    'Lymhurst',
    'Brecilien',
    'Black Market'
];

const ROYAL_CITIES = [
    'Caerleon',
    'Bridgewatch',
    'Martlock',
    'Thetford',
    'Fort Sterling',
    'Lymhurst',
    'Brecilien'
];

// Max items per API request (URL length limit)
const BATCH_SIZE = 100;

/**
 * Fetch live prices for specific items from the Albion API
 * @param {string[]} itemIds - Array of item IDs to fetch prices for
 * @param {number|number[]} quality - Quality level(s) (1-5)
 * @returns {Promise<Object>} - Map of item_id -> { city -> price_data }
 */
export async function fetchLivePrices(itemIds, quality = 1) {
    if (!itemIds || itemIds.length === 0) {
        return {};
    }

    const priceMap = {};
    const qualities = Array.isArray(quality) ? quality.join(',') : quality;

    // Batch requests if too many items
    for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
        const batch = itemIds.slice(i, i + BATCH_SIZE);

        try {
            const url = `${BASE_URL}/${batch.join(',')}.json`;
            const { data } = await api.get(url, {
                params: {
                    locations: CITIES.join(','),
                    qualities: qualities
                }
            });

            if (!data || data.length === 0) continue;

            for (const row of data) {
                // Skip invalid dates
                if (row.sell_price_min_date === '0001-01-01T00:00:00' &&
                    row.buy_price_max_date === '0001-01-01T00:00:00') {
                    continue;
                }

                if (!priceMap[row.item_id]) {
                    priceMap[row.item_id] = {};
                }

                priceMap[row.item_id][row.city] = {
                    sell_price_min: row.sell_price_min,
                    sell_price_min_date: row.sell_price_min_date.startsWith('0001-01-01') ? null : row.sell_price_min_date,
                    buy_price_max: row.buy_price_max,
                    buy_price_max_date: row.buy_price_max_date.startsWith('0001-01-01') ? null : row.buy_price_max_date,
                    quality: row.quality
                };
            }
        } catch (error) {
            console.error(`Error fetching batch ${i}-${i + BATCH_SIZE}:`, error.message);
        }
    }

    return priceMap;
}

/**
 * Fetch live prices for a single item
 * @param {string} itemId - Item ID
 * @param {number} quality - Quality level
 * @returns {Promise<Object>} - { city -> price_data }
 */
export async function fetchLiveItemPrice(itemId, quality = 1) {
    const priceMap = await fetchLivePrices([itemId], quality);
    return priceMap[itemId] || {};
}

/**
 * Find best transport routes from live prices
 * @param {Object} priceMap - Price map from fetchLivePrices
 * @param {Object} options - Filter options
 * @returns {Array} - Array of profitable routes
 */
export function findTransportRoutes(priceMap, options = {}) {
    const {
        minProfit = 1000,
        maxProfitPercent = 100,
        minBuyPrice = 100,
        maxBuyPrice = 10000000,
        limit = 50
    } = options;

    const routes = [];

    for (const [itemId, cityPrices] of Object.entries(priceMap)) {
        // Find best buy (lowest sell_price_min) and best sell (highest sell_price_min)
        let bestBuy = null;
        let bestSell = null;

        for (const city of ROYAL_CITIES) {
            const price = cityPrices[city];
            if (!price || price.sell_price_min <= 0) continue;

            if (!bestBuy || price.sell_price_min < bestBuy.price) {
                bestBuy = { city, price: price.sell_price_min, date: price.sell_price_min_date };
            }
            if (!bestSell || price.sell_price_min > bestSell.price) {
                bestSell = { city, price: price.sell_price_min, date: price.sell_price_min_date };
            }
        }

        if (!bestBuy || !bestSell || bestBuy.city === bestSell.city) continue;

        const profit = bestSell.price - bestBuy.price;
        const profitPercent = Math.round((profit / bestBuy.price) * 10000) / 100;

        if (profit < minProfit) continue;
        if (profitPercent > maxProfitPercent) continue;
        if (bestBuy.price < minBuyPrice || bestBuy.price > maxBuyPrice) continue;

        routes.push({
            item_id: itemId,
            buy_city: bestBuy.city,
            sell_city: bestSell.city,
            buy_price: bestBuy.price,
            sell_price: bestSell.price,
            profit,
            profit_percent: profitPercent,
            buy_date: bestBuy.date,
            sell_date: bestSell.date
        });
    }

    // Sort by profit and limit
    routes.sort((a, b) => b.profit - a.profit);
    return routes.slice(0, limit);
}

/**
 * Find Black Market routes from live prices
 * @param {Object} priceMap - Price map from fetchLivePrices
 * @param {Object} options - Filter options
 * @returns {Array} - Array of profitable BM routes
 */
export function findBlackMarketRoutes(priceMap, options = {}) {
    const {
        minProfit = 1000,
        maxProfitPercent = 200,
        maxBuyPrice = 10000000,
        limit = 50
    } = options;

    const routes = [];

    for (const [itemId, cityPrices] of Object.entries(priceMap)) {
        const bmPrice = cityPrices['Black Market'];
        if (!bmPrice || bmPrice.buy_price_max <= 0) continue;

        // Find cheapest royal city to buy from
        let bestBuy = null;
        for (const city of ROYAL_CITIES) {
            const price = cityPrices[city];
            if (!price || price.sell_price_min <= 0) continue;

            if (!bestBuy || price.sell_price_min < bestBuy.price) {
                bestBuy = { city, price: price.sell_price_min, date: price.sell_price_min_date };
            }
        }

        if (!bestBuy) continue;

        const profit = bmPrice.buy_price_max - bestBuy.price;
        const profitPercent = Math.round((profit / bestBuy.price) * 10000) / 100;

        if (profit < minProfit) continue;
        if (profitPercent > maxProfitPercent) continue;
        if (bestBuy.price > maxBuyPrice) continue;

        routes.push({
            item_id: itemId,
            buy_city: bestBuy.city,
            sell_city: 'Black Market',
            buy_price: bestBuy.price,
            sell_price: bmPrice.buy_price_max,
            profit,
            profit_percent: profitPercent,
            buy_date: bestBuy.date,
            sell_date: bmPrice.buy_price_max_date
        });
    }

    routes.sort((a, b) => b.profit - a.profit);
    return routes.slice(0, limit);
}

export { CITIES, ROYAL_CITIES };
