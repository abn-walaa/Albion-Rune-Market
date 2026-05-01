/**
 * ALBION MARKET ORACLE
 * Dashboard Application
 */

const API_BASE = 'http://localhost:3000';

// State
let currentTab = 'normal';
let profitHistory = JSON.parse(localStorage.getItem('profitHistory') || '[]');
let chartInstance = null;
let currentModalItem = { type: null, itemId: null };

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    checkApiConnection();
    initChart();
    loadData();
    updateProfitTracker();

    // Event listeners
    document.getElementById('refresh-btn').addEventListener('click', loadData);
    document.getElementById('sync-btn').addEventListener('click', syncPrices);
    document.getElementById('sell-city').addEventListener('change', loadData);
    document.getElementById('premium-toggle').addEventListener('change', loadData);
    document.getElementById('tier-filter').addEventListener('change', loadData);
    document.getElementById('return-rate').addEventListener('change', loadData);
    document.getElementById('fee-per-100').addEventListener('change', loadData);

    // Check sync status on load
    checkSyncStatus();

    // Item search (crafting panel)
    const searchInput = document.getElementById('item-search');
    searchInput.addEventListener('input', debounce(handleSearch, 300));
    searchInput.addEventListener('focus', () => {
        const results = document.getElementById('search-results');
        if (results.innerHTML) results.classList.add('active');
    });

    // Global search
    const globalSearchInput = document.getElementById('global-item-search');
    globalSearchInput.addEventListener('input', debounce(handleGlobalSearch, 300));
    globalSearchInput.addEventListener('focus', () => {
        const results = document.getElementById('global-search-results');
        if (results.innerHTML) results.classList.add('active');
    });

    // Close search on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            document.getElementById('search-results').classList.remove('active');
        }
        if (!e.target.closest('.global-search-container')) {
            document.getElementById('global-search-results').classList.remove('active');
        }
    });

    // Auto-refresh every 5 minutes
    setInterval(loadData, 5 * 60 * 1000);
});

// ============================================
// API CONNECTION
// ============================================

async function checkApiConnection() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();

        document.getElementById('connection-status').innerHTML = `
            <span class="status-dot"></span>
            <span>CONNECTED</span>
        `;
        document.getElementById('api-status').textContent = 'API: Online';
        document.getElementById('last-sync').textContent = new Date().toLocaleTimeString();
    } catch (error) {
        document.getElementById('connection-status').innerHTML = `
            <span class="status-dot" style="background: var(--negative)"></span>
            <span style="color: var(--negative)">OFFLINE</span>
        `;
        document.getElementById('api-status').textContent = 'API: Offline';
    }
}

// ============================================
// ITEM SEARCH
// ============================================

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

async function handleSearch(e) {
    const query = e.target.value.trim();
    const resultsContainer = document.getElementById('search-results');

    if (query.length < 2) {
        resultsContainer.classList.remove('active');
        resultsContainer.innerHTML = '';
        return;
    }

    resultsContainer.innerHTML = '<div class="search-loading">Fetching live prices...</div>';
    resultsContainer.classList.add('active');

    try {
        // Use live search endpoint for real-time prices
        const response = await fetch(`${API_BASE}/items/search/live?q=${encodeURIComponent(query)}&craftable=true&limit=15`);
        const data = await response.json();

        if (data.results && data.results.length > 0) {
            resultsContainer.innerHTML = data.results.map(item => {
                const livePrice = item.live_price || {};
                const priceDisplay = livePrice.best_buy
                    ? `<span class="live-price">${formatSilver(livePrice.best_buy)}</span>`
                    : '<span class="no-price">No price</span>';

                return `
                <div class="search-result-item" onclick="selectSearchItem('${item.id}')">
                    <div class="item-info">
                        <span class="item-name">${item.name || formatItemName(item.id)}</span>
                        <span class="item-id">${item.id}</span>
                    </div>
                    <div class="item-meta">
                        ${priceDisplay}
                        <span class="item-tier">T${item.tier}${item.enchantment ? '.' + item.enchantment : ''}</span>
                    </div>
                </div>
            `}).join('');

            // Add live indicator
            if (data.source === 'live_api') {
                resultsContainer.insertAdjacentHTML('afterbegin',
                    '<div class="search-live-indicator"><span class="live-dot"></span> LIVE PRICES</div>');
            }
        } else {
            resultsContainer.innerHTML = '<div class="search-no-results">No craftable items found</div>';
        }
    } catch (error) {
        console.error('Search error:', error);
        resultsContainer.innerHTML = '<div class="search-no-results">Search failed</div>';
    }
}

function selectSearchItem(itemId) {
    // Clear search
    document.getElementById('item-search').value = '';
    document.getElementById('search-results').classList.remove('active');

    // Refresh crafting table with latest live data
    loadData();

    // Show item details
    showItemDetails('crafting', itemId);
}

// ============================================
// GLOBAL SEARCH
// ============================================

async function handleGlobalSearch(e) {
    const query = e.target.value.trim();
    const resultsContainer = document.getElementById('global-search-results');

    if (query.length < 2) {
        resultsContainer.classList.remove('active');
        resultsContainer.innerHTML = '';
        return;
    }

    resultsContainer.innerHTML = '<div class="search-loading">Fetching live prices...</div>';
    resultsContainer.classList.add('active');

    try {
        // Search all items with live prices
        const response = await fetch(`${API_BASE}/items/search/live?q=${encodeURIComponent(query)}&craftable=false&limit=20`);
        const data = await response.json();

        if (data.results && data.results.length > 0) {
            // Separate craftable and non-craftable items
            const craftable = data.results.filter(item => item.resource_count > 0);
            const nonCraftable = data.results.filter(item => !item.resource_count || item.resource_count === 0);

            let html = '';

            // Add live indicator
            if (data.source === 'live_api') {
                html += '<div class="search-live-indicator"><span class="live-dot"></span> LIVE PRICES</div>';
            }

            if (craftable.length > 0) {
                html += '<div class="search-category">Craftable Items</div>';
                html += craftable.map(item => {
                    const livePrice = item.live_price || {};
                    const priceDisplay = livePrice.best_buy
                        ? `<span class="live-price">${formatSilver(livePrice.best_buy)}</span>`
                        : '';

                    return `
                    <div class="search-result-item" onclick="selectGlobalSearchItem('${item.id}', true)">
                        <div class="item-info">
                            <span class="item-name">${item.name || formatItemName(item.id)}</span>
                            <span class="item-id">${item.id}</span>
                        </div>
                        <div class="item-meta">
                            ${priceDisplay}
                            <span class="item-craftable">Craftable</span>
                            <span class="item-tier">T${item.tier}${item.enchantment ? '.' + item.enchantment : ''}</span>
                        </div>
                    </div>
                `}).join('');
            }

            if (nonCraftable.length > 0) {
                html += '<div class="search-category">Resources & Materials</div>';
                html += nonCraftable.map(item => {
                    const livePrice = item.live_price || {};
                    const priceDisplay = livePrice.best_buy
                        ? `<span class="live-price">${formatSilver(livePrice.best_buy)}</span>`
                        : '';

                    return `
                    <div class="search-result-item" onclick="selectGlobalSearchItem('${item.id}', false)">
                        <div class="item-info">
                            <span class="item-name">${item.name || formatItemName(item.id)}</span>
                            <span class="item-id">${item.id}</span>
                        </div>
                        <div class="item-meta">
                            ${priceDisplay}
                            <span class="item-tier">T${item.tier}${item.enchantment ? '.' + item.enchantment : ''}</span>
                        </div>
                    </div>
                `}).join('');
            }

            resultsContainer.innerHTML = html;
        } else {
            resultsContainer.innerHTML = '<div class="search-no-results">No items found</div>';
        }
    } catch (error) {
        console.error('Global search error:', error);
        resultsContainer.innerHTML = '<div class="search-no-results">Search failed</div>';
    }
}

function selectGlobalSearchItem(itemId, isCraftable) {
    // Clear search
    document.getElementById('global-item-search').value = '';
    document.getElementById('global-search-results').classList.remove('active');

    // Refresh all tables with latest live data
    loadData();

    // Show item details
    if (isCraftable) {
        showItemDetails('crafting', itemId);
    } else {
        showItemDetails('transport', itemId);
    }
}

// ============================================
// PRICE SYNC
// ============================================

async function syncPrices() {
    const btn = document.getElementById('sync-btn');

    try {
        btn.disabled = true;
        btn.innerHTML = '<span class="btn-icon spinning">&#8635;</span> SYNCING...';

        const response = await fetch(`${API_BASE}/sync/prices`, { method: 'POST' });
        const data = await response.json();

        if (response.status === 409) {
            btn.innerHTML = '<span class="btn-icon spinning">&#8635;</span> IN PROGRESS...';
        } else if (data.message) {
            btn.innerHTML = '<span class="btn-icon spinning">&#8635;</span> SYNCING...';
        }

        // Poll for completion
        pollSyncStatus();

    } catch (error) {
        console.error('Sync failed:', error);
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">&#8595;</span> SYNC FAILED';
        setTimeout(() => {
            btn.innerHTML = '<span class="btn-icon">&#8595;</span> SYNC PRICES';
        }, 3000);
    }
}

async function checkSyncStatus() {
    try {
        const response = await fetch(`${API_BASE}/sync/status`);
        const data = await response.json();

        if (data.latestUpdate) {
            const date = new Date(data.latestUpdate);
            document.getElementById('last-sync').textContent = date.toLocaleTimeString();
        }

        if (data.isRunning) {
            const btn = document.getElementById('sync-btn');
            btn.disabled = true;
            btn.innerHTML = '<span class="btn-icon spinning">&#8635;</span> SYNCING...';
            pollSyncStatus();
        }
    } catch (error) {
        console.error('Failed to check sync status:', error);
    }
}

function pollSyncStatus() {
    const pollInterval = setInterval(async () => {
        try {
            const response = await fetch(`${API_BASE}/sync/status`);
            const data = await response.json();

            if (!data.isRunning) {
                clearInterval(pollInterval);
                const btn = document.getElementById('sync-btn');
                btn.disabled = false;

                if (data.lastError) {
                    btn.innerHTML = '<span class="btn-icon">&#10006;</span> SYNC FAILED';
                    setTimeout(() => {
                        btn.innerHTML = '<span class="btn-icon">&#8595;</span> SYNC PRICES';
                    }, 3000);
                } else {
                    btn.innerHTML = '<span class="btn-icon">&#10004;</span> SYNC COMPLETE';
                    document.getElementById('last-sync').textContent = new Date().toLocaleTimeString();

                    // Reload data after sync
                    setTimeout(() => {
                        btn.innerHTML = '<span class="btn-icon">&#8595;</span> SYNC PRICES';
                        loadData();
                    }, 2000);
                }
            }
        } catch (error) {
            clearInterval(pollInterval);
        }
    }, 3000);
}

// ============================================
// DATA LOADING
// ============================================

async function loadData() {
    const params = getParams();

    showLoading();

    try {
        // Load all data in parallel
        const [crafting, transport, blackmarket] = await Promise.all([
            fetchCraftingData(params),
            fetchTransportData(params),
            fetchBlackMarketData(params)
        ]);

        // Update tables
        updateCraftingTable(crafting);
        updateTransportTable(transport);
        updateBlackMarketTable(blackmarket);

        // Generate recommendations
        generateRecommendations(crafting, transport, blackmarket, params);

        // Update stats
        const totalOpportunities =
            (crafting?.count || 0) +
            (transport?.count || 0) +
            (blackmarket?.count || 0);
        document.getElementById('total-opportunities').textContent = totalOpportunities;
        document.getElementById('last-sync').textContent = new Date().toLocaleTimeString();

    } catch (error) {
        console.error('Error loading data:', error);
        showError('Failed to load market data. Check API connection.');
    }
}

function getParams() {
    const sellCity = document.getElementById('sell-city').value || 'Lymhurst';
    const budget = document.getElementById('budget').value || 1000000;
    const minProfit = document.getElementById('min-profit').value || 1000;
    const tier = document.getElementById('tier-filter').value;
    const premium = document.getElementById('premium-toggle').checked;
    const returnRate = document.getElementById('return-rate').value || 15;
    const feePer100 = document.getElementById('fee-per-100').value || 50;

    return {
        sell_city: sellCity,
        max_buy_price: budget,
        min_profit: minProfit,
        tier: tier || undefined,
        premium: premium,
        return_rate: returnRate,
        fee_per_100: feePer100,
        limit: 20
    };
}

async function fetchCraftingData(params) {
    const queryParams = new URLSearchParams({
        sell_city: params.sell_city,
        min_profit: params.min_profit,
        premium: params.premium,
        return_rate: params.return_rate,
        fee_per_100: params.fee_per_100,
        limit: params.limit
    });

    if (params.tier) queryParams.append('tier', params.tier);

    // Use live API for crafting prices (uses "Cheapest Mix" for resources)
    const response = await fetch(`${API_BASE}/crafting/live/profit?${queryParams}`);
    return response.json();
}

async function fetchTransportData(params) {
    const queryParams = new URLSearchParams({
        min_profit: params.min_profit,
        min_buy_price: 1000,
        max_buy_price: params.max_buy_price,
        limit: params.limit,
        max_profit_percent: 100
    });

    if (params.tier) queryParams.append('tier', params.tier);

    // Use live API for transport prices
    const response = await fetch(`${API_BASE}/prices/live/transport?${queryParams}`);
    return response.json();
}

async function fetchBlackMarketData(params) {
    const queryParams = new URLSearchParams({
        min_profit: params.min_profit,
        max_buy_price: params.max_buy_price,
        limit: params.limit,
        max_profit_percent: 200
    });

    if (params.tier) queryParams.append('tier', params.tier);

    // Use live API for black market prices
    const response = await fetch(`${API_BASE}/prices/live/black-market?${queryParams}`);
    return response.json();
}

// ============================================
// TABLE UPDATES
// ============================================

function updateCraftingTable(data) {
    const tbody = document.getElementById('crafting-body');
    const panel = document.querySelector('.crafting-panel .panel-header h2');

    // Update header with live indicator
    if (data?.source === 'live_api') {
        panel.innerHTML = '<span class="icon">&#9874;</span> CRAFTING PROFITS <span class="live-badge">LIVE</span>';
    } else {
        panel.innerHTML = '<span class="icon">&#9874;</span> CRAFTING PROFITS';
    }

    if (!data?.results?.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No profitable crafts found</td></tr>';
        return;
    }

    tbody.innerHTML = data.results.map(item => `
        <tr onclick="showItemDetails('crafting', '${item.item_id}')">
            <td class="item-name" title="${item.item_id}">${formatItemName(item.item_name || item.item_id)}</td>
            <td>${formatSilver(item.effective_cost || item.raw_cost)}</td>
            <td>${formatSilver(item.sell_price)}</td>
            <td class="profit ${item.profit < 0 ? 'negative' : ''}">${formatSilver(item.profit)}</td>
            <td class="roi">${item.profit_percent || 0}%</td>
        </tr>
    `).join('');
}

function updateTransportTable(data) {
    const tbody = document.getElementById('transport-body');
    const panel = document.querySelector('.transport-panel .panel-header h2');

    // Update header with live indicator
    if (data?.source === 'live_api') {
        panel.innerHTML = '<span class="icon">&#128666;</span> TRANSPORT ROUTES <span class="live-badge">LIVE</span>';
    } else {
        panel.innerHTML = '<span class="icon">&#128666;</span> TRANSPORT ROUTES';
    }

    if (!data?.results?.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No profitable routes found</td></tr>';
        return;
    }

    tbody.innerHTML = data.results.map(item => `
        <tr onclick="showItemDetails('transport', '${item.item_id}')">
            <td class="item-name" title="${item.item_id}">${formatItemName(item.item_name || item.item_id)}</td>
            <td class="city">${item.buy_city}</td>
            <td class="city">${item.sell_city}</td>
            <td class="profit">${formatSilver(item.profit)}</td>
            <td class="roi">${item.profit_percent}%</td>
        </tr>
    `).join('');
}

function updateBlackMarketTable(data) {
    const tbody = document.getElementById('blackmarket-body');
    const panel = document.querySelector('.blackmarket-panel .panel-header h2');

    // Update header with live indicator
    if (data?.source === 'live_api') {
        panel.innerHTML = '<span class="icon">&#9760;</span> BLACK MARKET <span class="live-badge">LIVE</span>';
    } else {
        panel.innerHTML = '<span class="icon">&#9760;</span> BLACK MARKET';
    }

    if (!data?.results?.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No Black Market deals found</td></tr>';
        return;
    }

    tbody.innerHTML = data.results.map(item => `
        <tr onclick="showItemDetails('blackmarket', '${item.item_id}')">
            <td class="item-name" title="${item.item_id}">${formatItemName(item.item_name || item.item_id)}</td>
            <td class="city">${item.buy_city}</td>
            <td>${formatSilver(item.sell_price)}</td>
            <td class="profit">${formatSilver(item.profit)}</td>
            <td class="roi">${item.profit_percent}%</td>
        </tr>
    `).join('');
}

// ============================================
// RECOMMENDATIONS
// ============================================

function generateRecommendations(crafting, transport, blackmarket, params) {
    const recommendations = [];
    const budget = parseInt(params.max_buy_price);

    // Process crafting
    if (crafting?.results) {
        crafting.results.slice(0, 5).forEach(item => {
            const cost = parseInt(item.effective_cost || item.raw_cost);
            if (cost <= budget && item.profit > 0) {
                recommendations.push({
                    type: 'CRAFTING',
                    item: item.item_name || item.item_id,
                    itemId: item.item_id,
                    profit: parseInt(item.profit),
                    roi: parseFloat(item.profit_percent) || 0,
                    details: `Craft in ${params.city}`,
                    score: (parseFloat(item.profit_percent) || 0) * Math.log10(parseInt(item.profit) + 1)
                });
            }
        });
    }

    // Process transport
    if (transport?.results) {
        transport.results.slice(0, 5).forEach(item => {
            const cost = parseInt(item.buy_price);
            if (cost <= budget) {
                recommendations.push({
                    type: 'TRANSPORT',
                    item: item.item_name || item.item_id,
                    itemId: item.item_id,
                    profit: parseInt(item.profit),
                    roi: parseFloat(item.profit_percent),
                    details: `${item.buy_city} → ${item.sell_city}`,
                    score: parseFloat(item.profit_percent) * Math.log10(parseInt(item.profit) + 1)
                });
            }
        });
    }

    // Process black market
    if (blackmarket?.results) {
        blackmarket.results.slice(0, 5).forEach(item => {
            const cost = parseInt(item.buy_price);
            if (cost <= budget) {
                recommendations.push({
                    type: 'BLACK MARKET',
                    item: item.item_name || item.item_id,
                    itemId: item.item_id,
                    profit: parseInt(item.profit),
                    roi: parseFloat(item.profit_percent),
                    details: `Buy at ${item.buy_city}`,
                    score: parseFloat(item.profit_percent) * Math.log10(parseInt(item.profit) + 1)
                });
            }
        });
    }

    // Sort by score and take top 10
    recommendations.sort((a, b) => b.score - a.score);
    const topRecs = recommendations.slice(0, 10);

    // Update UI
    const container = document.getElementById('recommendations-list');
    document.getElementById('rec-count').textContent = topRecs.length;

    if (topRecs.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <span>No recommendations match your criteria</span>
            </div>
        `;
        return;
    }

    container.innerHTML = topRecs.map(rec => `
        <div class="rec-card" onclick="showItemDetails('${rec.type.toLowerCase().replace(' ', '')}', '${rec.itemId}')">
            <div class="rec-type">${rec.type}</div>
            <div class="rec-item">${formatItemName(rec.item)}</div>
            <div class="rec-details">
                <span>${rec.details}</span>
            </div>
            <div class="rec-details">
                <span class="rec-profit">+${formatSilver(rec.profit)}</span>
                <span class="rec-roi">${rec.roi.toFixed(1)}% ROI</span>
            </div>
        </div>
    `).join('');
}

// ============================================
// ITEM DETAILS MODAL
// ============================================

async function showItemDetails(type, itemId) {
    const modal = document.getElementById('item-modal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    // Store current item for refresh
    currentModalItem = { type, itemId };

    title.textContent = formatItemName(itemId);
    body.innerHTML = '<div class="loading-state"><div class="loader"></div><span>Fetching live prices...</span></div>';
    modal.classList.add('active');

    try {
        const premium = document.getElementById('premium-toggle').checked;
        const returnRate = document.getElementById('return-rate').value || 15;
        const sellCity = document.getElementById('sell-city').value || 'Lymhurst';

        if (type === 'crafting' || type === 'blackmarket') {
            // Use live API for crafting prices (not local database)
            const feePer100 = document.getElementById('fee-per-100').value || 50;
            const response = await fetch(`${API_BASE}/crafting/live/${itemId}?premium=${premium}&return_rate=${returnRate}&fee_per_100=${feePer100}`);
            const data = await response.json();

            // Store data globally for city selection updates
            window.currentCraftingData = data;

            const cities = ['Bridgewatch', 'Martlock', 'Thetford', 'Fort Sterling', 'Lymhurst', 'Caerleon', 'Brecilien'];
            const cityAbbrev = {
                'Bridgewatch': 'BW',
                'Martlock': 'ML',
                'Thetford': 'TF',
                'Fort Sterling': 'FS',
                'Lymhurst': 'LH',
                'Caerleon': 'CL',
                'Brecilien': 'BR',
                'Black Market': 'BM'
            };

            const amountCrafted = data.item.amount_crafted || 1;

            body.innerHTML = `
                <div class="detail-section">
                    ${data.source === 'live_api' ? `
                    <div class="live-indicator">
                        <span class="live-dot"></span> LIVE PRICES
                    </div>
                    ` : ''}
                    <div class="detail-row">
                        <span class="detail-label">Item</span>
                        <span class="detail-value">${data.item.name || itemId}${amountCrafted > 1 ? ` <span class="craft-qty">(crafts ${amountCrafted})</span>` : ''}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Settings</span>
                        <span class="detail-value" id="modal-settings-display">${data.settings.return_rate} return, ${data.settings.fee_per_100}/100 fee, ${data.settings.tax} tax</span>
                    </div>
                    <div class="detail-row highlight" id="modal-best-profit">
                        ${data.recommendation.best_sell_order ? `
                        <span class="detail-label">Best Profit</span>
                        <span class="detail-value positive">+${formatSilver(data.recommendation.best_sell_order.profit)} in ${data.recommendation.best_sell_order.city}</span>
                        ` : '<span class="detail-label">Best Profit</span><span class="detail-value">-</span>'}
                    </div>
                </div>

                <div class="city-selector">
                    <label>Buy from:</label>
                    <select id="modal-buy-city" onchange="updateModalPrices()">
                        <option value="cheapest">Cheapest Mix</option>
                        ${cities.map(c => `<option value="${c}">${c}</option>`).join('')}
                    </select>
                    <label>Craft:</label>
                    <input type="number" id="modal-craft-qty" value="1" min="1" max="9999" style="width: 50px;" onchange="updateModalPrices()">×
                    <label>Return:</label>
                    <input type="number" id="modal-return-rate" value="${returnRate}" min="0" max="70" style="width: 50px;" onchange="updateModalPrices()">%
                    <label>Fee/100:</label>
                    <input type="number" id="modal-fee-per-100" value="${data.settings.fee_per_100 || 50}" min="0" max="9999" step="0.1" style="width: 60px;" onchange="updateModalPrices()">
                    <label class="premium-label">
                        <input type="checkbox" id="modal-premium" ${premium ? 'checked' : ''} onchange="updateModalPrices()">
                        Premium
                    </label>
                </div>

                <h4 class="section-title">RESOURCES (Buy Prices per City)</h4>
                <div class="city-table-container">
                    <table class="city-table" id="resources-table">
                        <thead>
                            <tr>
                                <th>Resource</th>
                                <th>Qty</th>
                                ${cities.map(c => `<th class="city-col" data-city="${c}">${cityAbbrev[c]}</th>`).join('')}
                            </tr>
                        </thead>
                        <tbody>
                            ${data.resources.map(r => `
                                <tr>
                                    <td class="resource-name">${formatItemName(r.resource_name || r.resource_id)}</td>
                                    <td class="qty">${r.count}</td>
                                    ${cities.map(c => {
                                        const p = r.prices[c];
                                        const isCheapest = r.cheapest && r.cheapest.city === c;
                                        return `<td class="city-col ${isCheapest ? 'cheapest' : ''} ${!p ? 'no-price' : ''}" data-city="${c}">${p ? formatSilver(p.total_price) : '-'}</td>`;
                                    }).join('')}
                                </tr>
                            `).join('')}
                            <tr class="total-row">
                                <td colspan="2"><strong>TOTAL</strong></td>
                                ${cities.map(c => {
                                    const cost = data.cost_per_city[c];
                                    return `<td class="city-col" data-city="${c}">${cost ? formatSilver(cost) : '-'}</td>`;
                                }).join('')}
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div id="selected-cost-display" class="detail-section" style="margin-top: 0.5rem;">
                    ${data.cheapest_total.cost ? `
                    <div class="detail-row">
                        <span class="detail-label">Buying from</span>
                        <span class="detail-value">Cheapest Mix</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Total Cost</span>
                        <span class="detail-value">${formatSilver(data.cheapest_total.cost)} → ${formatSilver(data.cheapest_total.effective_cost)} effective</span>
                    </div>
                    ` : ''}
                </div>

                <h4 class="section-title">SELL PRICES${amountCrafted > 1 ? ` <span class="craft-qty">(×${amountCrafted} per craft)</span>` : ''}</h4>
                <div class="city-table-container">
                    <table class="city-table sell-table">
                        <thead>
                            <tr>
                                <th>City</th>
                                <th>Sell Order</th>
                                <th>Instant Sell</th>
                                <th>Profit (Order)</th>
                                <th>Profit (Instant)</th>
                            </tr>
                        </thead>
                        <tbody id="sell-prices-body">
                            ${data.sell_prices.map(s => {
                                const isBestOrder = data.recommendation.best_sell_order && data.recommendation.best_sell_order.city === s.city;
                                const isBestInstant = data.recommendation.best_instant && data.recommendation.best_instant.city === s.city;
                                return `
                                <tr>
                                    <td>${s.city}</td>
                                    <td>${formatSilver(s.sell_price)}${amountCrafted > 1 ? ` <small>×${amountCrafted}</small>` : ''}</td>
                                    <td>${formatSilver(s.instant_sell_price)}${amountCrafted > 1 ? ` <small>×${amountCrafted}</small>` : ''}</td>
                                    <td class="${isBestOrder ? 'best' : ''} ${s.profit_if_sell_order > 0 ? 'positive' : s.profit_if_sell_order < 0 ? 'negative' : ''}">${s.profit_if_sell_order !== null ? formatSilver(s.profit_if_sell_order) : '-'}</td>
                                    <td class="${isBestInstant ? 'best' : ''} ${s.profit_if_instant > 0 ? 'positive' : s.profit_if_instant < 0 ? 'negative' : ''}">${s.profit_if_instant !== null ? formatSilver(s.profit_if_instant) : '-'}</td>
                                </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        } else {
            // Transport - show LIVE prices from all cities
            const response = await fetch(`${API_BASE}/prices/live/${itemId}`);
            const data = await response.json();

            // Convert prices object to array format
            const pricesArray = Object.entries(data.prices || {}).map(([city, priceData]) => ({
                city,
                sell_price_min: priceData.sell_price_min,
                buy_price_max: priceData.buy_price_max,
                sell_price_min_date: priceData.sell_price_min_date,
                buy_price_max_date: priceData.buy_price_max_date
            })).filter(p => p.sell_price_min > 0 || p.buy_price_max > 0);

            if (pricesArray.length > 0) {
                // Sort by sell price to find best buy/sell
                const sortedBySell = [...pricesArray].sort((a, b) => (a.sell_price_min || Infinity) - (b.sell_price_min || Infinity));
                const cheapestBuy = sortedBySell[0];
                const sortedByBuy = [...pricesArray].sort((a, b) => (b.sell_price_min || 0) - (a.sell_price_min || 0));
                const bestSell = sortedByBuy[0];

                const profit = (bestSell?.sell_price_min || 0) - (cheapestBuy?.sell_price_min || 0);

                body.innerHTML = `
                    <div class="detail-section">
                        <div class="live-indicator">
                            <span class="live-dot"></span> LIVE PRICES
                        </div>
                        <div class="detail-row highlight">
                            <span class="detail-label">Best Route</span>
                            <span class="detail-value">${cheapestBuy?.city} → ${bestSell?.city}</span>
                        </div>
                        <div class="detail-row">
                            <span class="detail-label">Profit</span>
                            <span class="detail-value ${profit > 0 ? 'positive' : 'negative'}">${formatSilver(profit)}</span>
                        </div>
                    </div>

                    <h4 class="section-title">PRICES BY CITY</h4>
                    <div class="city-table-container">
                        <table class="city-table">
                            <thead>
                                <tr>
                                    <th>City</th>
                                    <th>Sell Order</th>
                                    <th>Instant Sell</th>
                                    <th>Last Update</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${pricesArray.map(item => `
                                    <tr>
                                        <td>${item.city}</td>
                                        <td class="${item.city === cheapestBuy?.city ? 'cheapest' : ''}">${formatSilver(item.sell_price_min)}</td>
                                        <td>${formatSilver(item.buy_price_max)}</td>
                                        <td>${item.sell_price_min_date ? new Date(item.sell_price_min_date).toLocaleString() : '-'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                `;
            } else {
                body.innerHTML = '<div class="empty-state">No price data available</div>';
            }
        }
    } catch (error) {
        body.innerHTML = `<div class="empty-state">Error loading details: ${error.message}</div>`;
    }
}

function closeModal() {
    document.getElementById('item-modal').classList.remove('active');
    window.currentCraftingData = null;
    currentModalItem = { type: null, itemId: null };
}

// Refresh item details modal with latest live prices
async function refreshItemDetails() {
    if (!currentModalItem.type || !currentModalItem.itemId) return;

    const btn = document.getElementById('modal-refresh-btn');
    const icon = btn.querySelector('.btn-icon');

    // Add spinning animation
    icon.classList.add('spinning');
    btn.disabled = true;

    try {
        await showItemDetails(currentModalItem.type, currentModalItem.itemId);
    } finally {
        icon.classList.remove('spinning');
        btn.disabled = false;
    }
}

// Refresh crafting table with latest live prices
async function refreshCraftingTable() {
    const btn = document.querySelector('.btn-refresh-table');
    const originalText = btn.innerHTML;

    // Add spinning animation
    btn.innerHTML = '<span class="spinning">&#8635;</span>';
    btn.disabled = true;

    try {
        const params = getParams();
        const data = await fetchCraftingData(params);
        updateCraftingTable(data);

        // Update last sync time
        document.getElementById('last-sync').textContent = new Date().toLocaleTimeString();
    } catch (error) {
        console.error('Error refreshing crafting table:', error);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

function updateModalPrices() {
    const selectedCity = document.getElementById('modal-buy-city').value;
    const data = window.currentCraftingData;
    if (!data) return;

    const cities = ['Bridgewatch', 'Martlock', 'Thetford', 'Fort Sterling', 'Lymhurst', 'Caerleon', 'Brecilien'];
    // Use modal-specific settings
    const premium = document.getElementById('modal-premium').checked;
    const returnRate = parseFloat(document.getElementById('modal-return-rate').value) || 15;
    const feePer100 = parseFloat(document.getElementById('modal-fee-per-100').value) || 50;
    const craftQty = parseInt(document.getElementById('modal-craft-qty').value) || 1;
    const taxPercent = premium ? 4 : 8;
    const amountCrafted = data.item.amount_crafted || 1;
    const totalItemsProduced = amountCrafted * craftQty;

    // Update settings display
    const settingsDisplay = document.getElementById('modal-settings-display');
    if (settingsDisplay) {
        settingsDisplay.textContent = `${returnRate}% return, ${feePer100}/100 fee, ${taxPercent}% tax`;
    }

    // Highlight selected city column
    document.querySelectorAll('.city-col').forEach(el => {
        el.classList.remove('selected-city');
        if (selectedCity !== 'cheapest' && el.dataset.city === selectedCity) {
            el.classList.add('selected-city');
        }
    });

    // Calculate cost based on selected city
    let totalCost;
    if (selectedCity === 'cheapest') {
        totalCost = data.cheapest_total.cost;
    } else {
        totalCost = data.cost_per_city[selectedCity];
    }

    if (!totalCost) {
        document.getElementById('selected-cost-display').innerHTML =
            `<span class="no-price">No prices available for ${selectedCity}</span>`;
        return;
    }

    const effectiveCostPerCraft = Math.round(totalCost * (100 - returnRate) / 100);
    const totalResourceCost = totalCost * craftQty;
    const totalEffectiveCost = effectiveCostPerCraft * craftQty;

    // Update cost display
    document.getElementById('selected-cost-display').innerHTML = `
        <div class="detail-row">
            <span class="detail-label">Buying from</span>
            <span class="detail-value">${selectedCity === 'cheapest' ? 'Cheapest Mix' : selectedCity}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Cost per craft</span>
            <span class="detail-value">${formatSilver(totalCost)} → ${formatSilver(effectiveCostPerCraft)} effective</span>
        </div>
        ${craftQty > 1 ? `
        <div class="detail-row highlight">
            <span class="detail-label">Total (${craftQty}× crafts = ${totalItemsProduced} items)</span>
            <span class="detail-value">${formatSilver(totalResourceCost)} → ${formatSilver(totalEffectiveCost)} effective</span>
        </div>
        ` : ''}
    `;

    // Update sell prices with new profit calculations
    const sellTableBody = document.getElementById('sell-prices-body');
    if (sellTableBody) {
        let bestProfit = { city: null, profit: -Infinity };

        const rows = data.sell_prices.map(s => {
            const sellPrice = s.sell_price || 0;
            const instantSellPrice = s.instant_sell_price || 0;

            // Calculate profit based on selected buy city (per single craft)
            const revenuePerCraft = sellPrice * amountCrafted;
            const instantRevenuePerCraft = instantSellPrice * amountCrafted;
            const taxPerCraft = Math.round(sellPrice * taxPercent / 100) * amountCrafted;

            // Albion fee formula: nutrition = item_value / 10, fee = (nutrition / 100) * fee_per_100
            const nutrition = sellPrice / 10;
            const craftingFeePerCraft = Math.round((nutrition / 100) * feePer100);

            const profitPerCraft = revenuePerCraft - taxPerCraft - craftingFeePerCraft - effectiveCostPerCraft;
            const profitInstantPerCraft = instantRevenuePerCraft - craftingFeePerCraft - effectiveCostPerCraft;

            // Total for craftQty
            const totalProfit = profitPerCraft * craftQty;
            const totalProfitInstant = profitInstantPerCraft * craftQty;

            // Track best profit
            if (totalProfit > bestProfit.profit) {
                bestProfit = { city: s.city, profit: totalProfit };
            }

            return `
                <tr>
                    <td>${s.city}</td>
                    <td>${formatSilver(sellPrice)}${totalItemsProduced > 1 ? ` <small>×${totalItemsProduced}</small>` : ''}</td>
                    <td>${formatSilver(instantSellPrice)}${totalItemsProduced > 1 ? ` <small>×${totalItemsProduced}</small>` : ''}</td>
                    <td class="${totalProfit > 0 ? 'positive' : totalProfit < 0 ? 'negative' : ''}">${formatSilver(totalProfit)}${craftQty > 1 ? ` <small>(${formatSilver(profitPerCraft)}/craft)</small>` : ''}</td>
                    <td class="${totalProfitInstant > 0 ? 'positive' : totalProfitInstant < 0 ? 'negative' : ''}">${formatSilver(totalProfitInstant)}${craftQty > 1 ? ` <small>(${formatSilver(profitInstantPerCraft)}/craft)</small>` : ''}</td>
                </tr>
            `;
        });

        sellTableBody.innerHTML = rows.join('');

        // Update best profit display
        const bestProfitDisplay = document.getElementById('modal-best-profit');
        if (bestProfitDisplay && bestProfit.city) {
            bestProfitDisplay.innerHTML = `
                <span class="detail-label">Best Profit</span>
                <span class="detail-value ${bestProfit.profit > 0 ? 'positive' : 'negative'}">${bestProfit.profit > 0 ? '+' : ''}${formatSilver(bestProfit.profit)} in ${bestProfit.city}</span>
            `;
        }
    }
}

// Close modal on outside click
document.getElementById('item-modal').addEventListener('click', (e) => {
    if (e.target.id === 'item-modal') closeModal();
});

// ============================================
// PROFIT TRACKER
// ============================================

function initChart() {
    const ctx = document.getElementById('profit-chart').getContext('2d');

    // Create gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, 'rgba(244, 208, 63, 0.3)');
    gradient.addColorStop(1, 'rgba(244, 208, 63, 0)');

    // Get last 7 days of data
    const labels = [];
    const data = [];

    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        labels.push(date.toLocaleDateString('en', { weekday: 'short' }));

        const dayProfits = profitHistory.filter(p => p.date.startsWith(dateStr));
        const dayTotal = dayProfits.reduce((sum, p) => sum + p.amount, 0);
        data.push(dayTotal);
    }

    chartInstance = {
        labels,
        data,
        gradient,
        ctx,
        draw: function() {
            const width = ctx.canvas.width;
            const height = ctx.canvas.height;
            const padding = 40;
            const chartWidth = width - padding * 2;
            const chartHeight = height - padding * 2;

            ctx.clearRect(0, 0, width, height);

            // Find max value
            const maxValue = Math.max(...this.data, 1);

            // Draw grid lines
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.lineWidth = 1;

            for (let i = 0; i <= 4; i++) {
                const y = padding + (chartHeight / 4) * i;
                ctx.beginPath();
                ctx.moveTo(padding, y);
                ctx.lineTo(width - padding, y);
                ctx.stroke();
            }

            // Draw line
            ctx.beginPath();
            ctx.strokeStyle = '#F4D03F';
            ctx.lineWidth = 2;

            const points = [];
            this.data.forEach((value, i) => {
                const x = padding + (chartWidth / (this.data.length - 1 || 1)) * i;
                const y = padding + chartHeight - (value / maxValue) * chartHeight;
                points.push({ x, y });

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });
            ctx.stroke();

            // Fill area
            ctx.lineTo(points[points.length - 1].x, padding + chartHeight);
            ctx.lineTo(points[0].x, padding + chartHeight);
            ctx.fillStyle = this.gradient;
            ctx.fill();

            // Draw points
            points.forEach(point => {
                ctx.beginPath();
                ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#F4D03F';
                ctx.fill();
                ctx.strokeStyle = '#0a0a0f';
                ctx.lineWidth = 2;
                ctx.stroke();
            });

            // Draw labels
            ctx.fillStyle = '#5A5A5A';
            ctx.font = '11px Rajdhani';
            ctx.textAlign = 'center';

            this.labels.forEach((label, i) => {
                const x = padding + (chartWidth / (this.labels.length - 1 || 1)) * i;
                ctx.fillText(label, x, height - 10);
            });
        }
    };

    chartInstance.draw();

    // Redraw on resize
    window.addEventListener('resize', () => {
        if (chartInstance) chartInstance.draw();
    });
}

function updateProfitTracker() {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const todayProfits = profitHistory.filter(p => p.date.startsWith(today));
    const weekProfits = profitHistory.filter(p => p.date >= weekAgo);
    const totalProfits = profitHistory;

    const todayTotal = todayProfits.reduce((sum, p) => sum + p.amount, 0);
    const weekTotal = weekProfits.reduce((sum, p) => sum + p.amount, 0);
    const totalTotal = totalProfits.reduce((sum, p) => sum + p.amount, 0);

    document.getElementById('today-profit').textContent = formatSilver(todayTotal, true);
    document.getElementById('week-profit').textContent = formatSilver(weekTotal, true);
    document.getElementById('total-profit').textContent = formatSilver(totalTotal);

    if (chartInstance) {
        // Update chart data
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            const dayProfits = profitHistory.filter(p => p.date.startsWith(dateStr));
            chartInstance.data[6 - i] = dayProfits.reduce((sum, p) => sum + p.amount, 0);
        }
        chartInstance.draw();
    }
}

function logProfit() {
    const input = document.getElementById('profit-input');
    const type = document.getElementById('profit-type').value;
    const amount = parseInt(input.value);

    if (!amount || isNaN(amount)) {
        input.style.borderColor = 'var(--negative)';
        setTimeout(() => input.style.borderColor = '', 1000);
        return;
    }

    profitHistory.push({
        date: new Date().toISOString(),
        amount: amount,
        type: type
    });

    localStorage.setItem('profitHistory', JSON.stringify(profitHistory));
    input.value = '';
    updateProfitTracker();

    // Visual feedback
    input.style.borderColor = 'var(--positive)';
    setTimeout(() => input.style.borderColor = '', 1000);
}

// ============================================
// TAB SWITCHING
// ============================================

function switchTab(panel, tab) {
    currentTab = tab;

    // Update button states
    document.querySelectorAll(`[data-tab^="${panel}"]`).forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');

    // Reload data
    loadData();
}

// ============================================
// UTILITIES
// ============================================

function formatSilver(amount, showSign = false) {
    if (amount === null || amount === undefined) return '-';

    const num = parseInt(amount);
    const sign = showSign && num > 0 ? '+' : '';

    if (Math.abs(num) >= 1000000) {
        // Show 2 decimals for millions
        return sign + (num / 1000000).toFixed(2) + 'M';
    } else if (Math.abs(num) >= 10000) {
        // 10K+ shows 1 decimal
        return sign + (num / 1000).toFixed(1) + 'K';
    } else if (Math.abs(num) >= 1000) {
        // 1K-10K shows 2 decimals for more precision
        return sign + (num / 1000).toFixed(2) + 'K';
    }
    return sign + num.toLocaleString();
}

function formatItemName(name) {
    if (!name) return 'Unknown';

    // Convert T4_BAG@1 to "T4 Bag .1"
    return name
        .replace(/_/g, ' ')
        .replace(/@(\d+)/, ' .$1')
        .replace(/\b(\w)/g, l => l.toUpperCase())
        .replace(/^T(\d+)\s/, 'T$1 ');
}

function showLoading() {
    document.getElementById('recommendations-list').innerHTML = `
        <div class="loading-state">
            <div class="loader"></div>
            <span>Analyzing market opportunities...</span>
        </div>
    `;
}

function showError(message) {
    document.getElementById('recommendations-list').innerHTML = `
        <div class="empty-state" style="color: var(--negative)">
            <span>${message}</span>
        </div>
    `;
}
