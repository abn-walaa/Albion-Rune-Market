import axios from 'axios';
import { pool } from './db.js';

const ITEMS_URL = 'https://raw.githubusercontent.com/broderickhyman/ao-bin-dumps/master/items.json';
const BATCH_SIZE = 1000; // Safe batch size for PostgreSQL

async function batchInsert(client, table, columns, values, onConflict) {
    if (values.length === 0) return;

    const colCount = columns.length;

    for (let i = 0; i < values.length; i += BATCH_SIZE) {
        const batch = values.slice(i, i + BATCH_SIZE);
        const placeholders = batch
            .map((_, idx) => `(${columns.map((_, c) => `$${idx * colCount + c + 1}`).join(',')})`)
            .join(',');

        await client.query(
            `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders} ${onConflict}`,
            batch.flat()
        );
    }
}

export async function fetchItems() {
    const { data } = await axios.get(ITEMS_URL);

    // Extract items from nested structure
    const equipmentItems = data.items?.equipmentitem || [];
    const simpleItems = data.items?.simpleitem || [];
    const consumableItems = data.items?.consumableitem || [];
    const allItems = [...equipmentItems, ...simpleItems, ...consumableItems];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const itemValues = [];
        const recipeValues = [];

        for (const item of allItems) {
            const uniqueName = item['@uniquename'];
            if (!uniqueName) continue;

            // Extract tier and enchantment from name
            const tierMatch = uniqueName.match(/^T(\d+)/);
            const enchMatch = uniqueName.match(/@(\d+)$/);

            // Extract base crafting requirements
            // Can be object or array (for refined resources)
            let craftReqs = item.craftingrequirements;
            if (craftReqs && !Array.isArray(craftReqs)) {
                craftReqs = [craftReqs];
            }

            // Get amount_crafted (how many items produced per craft)
            // Potions = 5, Meals = 10, Equipment = 1
            let amountCrafted = 1;
            if (craftReqs && craftReqs[0]) {
                amountCrafted = parseInt(craftReqs[0]['@amountcrafted']) || 1;
            }

            itemValues.push([
                uniqueName,
                null,
                tierMatch ? parseInt(tierMatch[1]) : null,
                enchMatch ? parseInt(enchMatch[1]) : 0,
                amountCrafted,
            ]);

            if (craftReqs) {
                // Take first recipe variant (usually the standard one)
                const craftReq = craftReqs[0];
                if (craftReq?.craftresource) {
                    const resources = Array.isArray(craftReq.craftresource)
                        ? craftReq.craftresource
                        : [craftReq.craftresource];

                    for (const res of resources) {
                        if (res['@uniquename'] && res['@count']) {
                            recipeValues.push([
                                uniqueName,
                                res['@uniquename'],
                                parseInt(res['@count']),
                            ]);
                        }
                    }
                }
            }

            // Extract enchantment recipes
            if (item.enchantments?.enchantment) {
                const enchants = Array.isArray(item.enchantments.enchantment)
                    ? item.enchantments.enchantment
                    : [item.enchantments.enchantment];

                for (const ench of enchants) {
                    const enchLevel = ench['@enchantmentlevel'];
                    const enchItemId = `${uniqueName}@${enchLevel}`;
                    const enchCraft = ench.craftingrequirements;

                    // Get amount_crafted for enchanted item
                    let enchAmountCrafted = 1;
                    if (enchCraft && enchCraft['@amountcrafted']) {
                        enchAmountCrafted = parseInt(enchCraft['@amountcrafted']) || 1;
                    }

                    // Add enchanted item to items table
                    itemValues.push([
                        enchItemId,
                        null,
                        tierMatch ? parseInt(tierMatch[1]) : null,
                        parseInt(enchLevel),
                        enchAmountCrafted,
                    ]);

                    if (enchCraft?.craftresource) {
                        const resources = Array.isArray(enchCraft.craftresource)
                            ? enchCraft.craftresource
                            : [enchCraft.craftresource];

                        for (const res of resources) {
                            if (res['@uniquename'] && res['@count']) {
                                recipeValues.push([
                                    enchItemId,
                                    res['@uniquename'],
                                    parseInt(res['@count']),
                                ]);
                            }
                        }
                    }
                }
            }
        }

        // Batch insert items
        await batchInsert(
            client,
            'items',
            ['id', 'name', 'tier', 'enchantment', 'amount_crafted'],
            itemValues,
            'ON CONFLICT (id) DO UPDATE SET amount_crafted = EXCLUDED.amount_crafted'
        );

        // Clear and batch insert recipes
        await client.query('DELETE FROM recipes');
        await batchInsert(
            client,
            'recipes',
            ['item_id', 'resource_id', 'resource_count'],
            recipeValues,
            'ON CONFLICT (item_id, resource_id) DO UPDATE SET resource_count = EXCLUDED.resource_count'
        );

        await client.query('COMMIT');
        console.log(`Items: ${itemValues.length}, Recipes: ${recipeValues.length}`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('fetchItems failed:', err);
        throw err;
    } finally {
        client.release();
    }
}
