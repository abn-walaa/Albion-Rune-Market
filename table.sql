-- Items metadata
CREATE TABLE items (
    id TEXT PRIMARY KEY,
    name TEXT,
    tier INT,
    enchantment INT,
    amount_crafted INT DEFAULT 1,  -- How many items produced per craft (potions=5, meals=10)
    created_at TIMESTAMP DEFAULT NOW()
);

-- Crafting recipes (item -> resources)
CREATE TABLE recipes (
    item_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    resource_count INT NOT NULL,
    PRIMARY KEY (item_id, resource_id)
);

CREATE INDEX idx_recipes_item ON recipes(item_id);
CREATE INDEX idx_recipes_resource ON recipes(resource_id);

-- Current market prices (latest snapshot only)
CREATE TABLE market_prices (
    item_id TEXT NOT NULL,
    city TEXT NOT NULL,
    quality INT NOT NULL,
    sell_price_min INT,
    sell_price_min_date TIMESTAMP,
    buy_price_max INT,
    buy_price_max_date TIMESTAMP,
    PRIMARY KEY (item_id, city, quality)
);

CREATE INDEX idx_market_item ON market_prices(item_id);
CREATE INDEX idx_market_city ON market_prices(city);
CREATE INDEX idx_market_sell_date ON market_prices(sell_price_min_date DESC);

-- Hourly price history for charts and volatility detection
CREATE TABLE market_prices_history (
    item_id TEXT NOT NULL,
    city TEXT NOT NULL,
    quality INT NOT NULL,
    hour_bucket TIMESTAMP NOT NULL,
    sell_price_min INT,
    sell_price_max INT,
    sell_price_avg INT,
    buy_price_min INT,
    buy_price_max INT,
    buy_price_avg INT,
    PRIMARY KEY (item_id, city, quality, hour_bucket)
);

CREATE INDEX idx_history_item_time ON market_prices_history(item_id, hour_bucket DESC);
CREATE INDEX idx_history_city ON market_prices_history(city);
