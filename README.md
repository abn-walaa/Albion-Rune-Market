# Albion Market Oracle

A market tracking and profit analysis tool for Albion Online that fetches real-time price data from [albion-online-data.com](https://www.albion-online-data.com/) and calculates crafting profits, transport arbitrage opportunities, and Black Market deals.

## Features

- **Crafting Profit Calculator** - Calculate profit margins for crafted items with material return rate and premium tax support
- **Transport Arbitrage** - Find profitable routes to buy items in one city and sell in another
- **Black Market Analysis** - Identify profitable items to sell on the Black Market
- **Real-time Price Sync** - Automatic price updates every 15 minutes from albion-online-data.com
- **Profit Tracker** - Track your daily/weekly profits with charts
- **Multi-city Support** - Lymhurst, Bridgewatch, Martlock, Fort Sterling, Thetford, Caerleon, Brecilien, and Black Market

## Prerequisites

- [Bun](https://bun.sh/) (JavaScript runtime)
- [PostgreSQL](https://www.postgresql.org/) (version 12 or higher)

## Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd albion-traking-tool
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Setup PostgreSQL Database

Create a new PostgreSQL database:

```bash
# Connect to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE albion;

# Connect to the new database
\c albion

# Exit psql
\q
```

Run the database schema setup:

```bash
psql -U postgres -d albion -f table.sql
```

Or manually execute the contents of `table.sql` in your PostgreSQL client. This creates the following tables:
- `items` - Item metadata (tier, enchantment, amount crafted)
- `recipes` - Crafting recipes linking items to resources
- `market_prices` - Current market prices per city and quality
- `market_prices_history` - Hourly price history for trend analysis

### 4. Configure Environment Variables

Copy the example environment file:

```bash
cp .example.env .env
```

Edit `.env` with your settings:

```env
DATABASE_URL=postgres://postgres:your_password@localhost:5432/albion
API_REGION=west
```

**Environment Variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:1234@localhost:5432/albion` |
| `API_REGION` | Albion Online data region (`west`, `east`, or `europe`) | `west` |
| `API_PORT` | Port for the web server | `3000` |

**API Regions:**
- `west` - Americas server
- `east` - Asia server
- `europe` - Europe server

Choose the region that matches your game server for accurate prices.

### 5. Run the Application

```bash
bun run src/index.js
```

On startup, the application will:
1. Fetch item definitions and recipes from [ao-bin-dumps](https://github.com/broderickhyman/ao-bin-dumps)
2. Start the scheduled price sync (every 15 minutes)
3. Launch the web server on port 3000

### 6. Access the Dashboard

Open your browser and navigate to:

```
http://localhost:3000
```

## Data Sources

### Item Definitions
Fetched from [broderickhyman/ao-bin-dumps](https://github.com/broderickhyman/ao-bin-dumps) on GitHub. Contains all item IDs, crafting recipes, and item properties.

### Market Prices
Fetched from [albion-online-data.com](https://www.albion-online-data.com/) API. This is a community-driven project that collects market prices from players running the [Albion Online Data Client](https://www.albion-online-data.com/).

The API endpoint used:
```
https://{region}.albion-online-data.com/api/v2/stats/prices/{item_ids}
```

## How It Works

### Price Sync
- Prices are automatically synced every 15 minutes via a cron job
- Runs at :00, :15, :30, :45 (UTC aligned)
- You can trigger a manual sync from the dashboard using the "SYNC PRICES" button
- Historical prices are stored hourly for trend analysis

### Profit Calculations
The tool calculates profits considering:
- **Buy prices**: Lowest sell order prices in each city
- **Sell prices**: Sell order prices and instant sell (buy order) prices
- **Market tax**: 4% for premium, 8% for non-premium players
- **Material return rate**: Configurable (default 15% with focus)
- **Amount crafted**: Some items produce multiple units per craft (potions produce 5, meals produce 10)

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | API health check |
| `GET /items/search` | Search for items by name |
| `GET /prices/latest` | Get latest prices for an item |
| `GET /prices/profit/transport` | Get transport arbitrage opportunities |
| `GET /prices/profit/black-market` | Get Black Market opportunities |
| `GET /crafting/profit` | Get crafting profit calculations |
| `GET /crafting/profit/full` | Get full crafting chain profit |
| `GET /crafting/details/:itemId` | Get detailed crafting info for an item |
| `POST /sync/prices` | Trigger manual price sync |
| `GET /sync/status` | Check sync status |

## Project Structure

```
albion-traking-tool/
├── public/                  # Frontend dashboard
│   ├── index.html          # Main HTML
│   ├── app.js              # Dashboard JavaScript
│   └── styles.css          # Styling
├── src/
│   ├── index.js            # Application entry point
│   ├── db.js               # PostgreSQL connection
│   ├── apiClient.js        # Axios HTTP client
│   ├── fetchItems.js       # Fetch items & recipes
│   ├── fetchPrices.js      # Fetch market prices
│   ├── scheduler.js        # Cron job scheduler
│   ├── rateLimiter.js      # API rate limiting
│   ├── batchBuilder.js     # URL batch builder
│   └── api/
│       ├── server.js       # Express server
│       └── routes/         # API route handlers
├── table.sql               # Database schema
├── package.json
└── .env                    # Environment config
```

## Technical Details

### Rate Limiting
- URL-length aware batching (max 4096 chars per request)
- Hard limits enforced: 180 requests/minute, 300 requests/5 minutes
- Average load: ~30-40 requests per sync run

### Database Design
- UPSERT operations prevent duplicates
- Transaction-safe writes
- Indexed for fast frontend queries
- Scales to millions of price records

### Fault Tolerance
- Safe to restart at any time
- Re-runs overwrite same time bucket
- Transactions prevent partial writes

## Troubleshooting

### Database Connection Failed
- Verify PostgreSQL is running: `pg_isready`
- Check your `DATABASE_URL` in `.env`
- Ensure the database exists and tables are created

### No Price Data
- The price data depends on community contributions via the [Albion Online Data Client](https://www.albion-online-data.com/)
- Run a manual sync from the dashboard
- Check that your `API_REGION` matches your game server

### Items Not Loading
- On first run, items are fetched from GitHub
- Check your internet connection
- The items endpoint should show data after startup

## Contributing to Price Data

This tool relies on community-sourced price data. Help the community by running the [Albion Online Data Client](https://www.albion-online-data.com/) while you play. The client captures market prices and uploads them anonymously.

## License

ISC
