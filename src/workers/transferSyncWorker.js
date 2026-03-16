'use strict';

const Cards               = require('../models/Cards');
const Transactions        = require('../models/Transactions');
const StarknetCardService = require('../services/StarknetCardService');
const PriceOracle         = require('../utils/PriceOracle');
const DateHelper          = require('../utils/DateHelper');

const POLL_INTERVAL_MS   = parseInt(process.env.TRANSFER_POLL_MS   || 60_000);  // 1 min per cycle
const INTER_CARD_DELAY   = parseInt(process.env.TRANSFER_CARD_DELAY || 2_000);  // 2 s between cards
const MAX_BLOCK_RANGE    = parseInt(process.env.TRANSFER_MAX_BLOCKS || 500);     // max blocks per scan
const INITIAL_LOOKBACK   = parseInt(process.env.TRANSFER_LOOKBACK   || 5_000);  // first-run lookback

// In-memory state shared across cycles for the same process lifetime
const _lastScannedBlock  = new Map(); // cardAddress → blockNumber
const _failCounts        = new Map(); // cardAddress → consecutiveFailures
const MAX_CONSECUTIVE_FAILS = 3;

const date = new DateHelper();

/**
 * Boot the sync loop.
 * Called once from workers/index.js after MongoDB is ready.
 *
 * @param {import('mongodb').MongoClient} mongoClient
 */
function startTransferSyncWorker(mongoClient) {
    console.log('[TransferSync] Worker started.');

    // Stagger the first tick so it doesn't race server startup
    setTimeout(function tick() {
        runCycle(mongoClient).catch(err => {
            console.error('[TransferSync] Cycle error:', err.message);
        }).finally(() => {
            setTimeout(tick, POLL_INTERVAL_MS);
        });
    }, 10_000); // first run at T+10s
}

// ─── Core cycle ───────────────────────────────────────────────────────────────

async function runCycle(mongoClient) {
    const prices = await PriceOracle.fetchLivePrices().catch(() => ({}));
    const databases = [
        { db: process.env.MONGO_DB, isLive: true },
        { db: process.env.DB_NAME_SANDBOX, isLive: false },
    ].filter(d => d.db);

    for (const { db, isLive } of databases) {
        const cardsModel = new Cards(mongoClient);
        cardsModel.useDatabase(db);

        const cards = await cardsModel.findAll(
            { status: 'active', address: { $ne: null } },
            { limit: 200, sort: { updated_at: 1 } }
        );

        for (const card of cards) {
            const addr = card.address;
            if (!addr) continue;

            if ((_failCounts.get(addr) || 0) >= MAX_CONSECUTIVE_FAILS) continue;
            card._isLive = isLive;

            await syncCard(mongoClient, card, prices);
            await sleep(INTER_CARD_DELAY);
        }
    }
}

// ─── Per-card sync ────────────────────────────────────────────────────────────

async function syncCard(mongoClient, card, prices) {
    const addr   = card.address;
    const isLive = card._isLive ?? (card.is_live === true);

    try {
        const net = isLive ? 'mainnet' : 'sepolia';
        const svc = await StarknetCardService.create({ cardAddress: addr, isLive });

        // Determine scan range
        const latestBlock = (await svc.provider.getBlock('latest')).block_number;
        const lastBlock   = _lastScannedBlock.get(addr) ?? (latestBlock - INITIAL_LOOKBACK);
        const fromBlock   = lastBlock + 1;

        if (fromBlock > latestBlock) return; // nothing new

        // Cap the range to avoid overwhelming the node
        const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, latestBlock);
        console.log(`[TransferSync] ${addr.slice(0, 10)}… scanning ${net} blocks ${fromBlock}-${toBlock}`);

        const { credits, debits } = await svc.getTransferEvents(fromBlock, toBlock, prices);

        const all = [...credits, ...debits];
        if (all.length) {
            await persistEvents(mongoClient, card, all, isLive);
        }

        // Advance the cursor even if no events — blocks were scanned
        _lastScannedBlock.set(addr, toBlock);
        _failCounts.set(addr, 0);

        if (all.length) {
            console.log(`[TransferSync] ${addr.slice(0, 10)}… blocks ${fromBlock}-${toBlock}: +${credits.length} credits, -${debits.length} debits`);
        }

    } catch (err) {
        const fails = (_failCounts.get(addr) || 0) + 1;
        _failCounts.set(addr, fails);
        // Only log full message on first failure; after that log just a short note
        if (fails === 1) {
            console.warn(`[TransferSync] ${addr.slice(0, 10)}… sync failed: ${err.message?.split('\n')[0] || err.message}`);
        } else if (fails >= MAX_CONSECUTIVE_FAILS) {
            console.warn(`[TransferSync] ${addr.slice(0, 10)}… ${fails} consecutive failures — pausing this card until next restart.`);
        }
    }
}

// ─── Persist events → Transactions collection ─────────────────────────────────

async function persistEvents(mongoClient, card, events, isLive) {
    const txModel = new Transactions(mongoClient);
    if (!isLive) txModel.useDatabase(process.env.DB_NAME_SANDBOX);

    const now = date.timestampTimeNow();

    for (const ev of events) {
        const onchainRef = `${ev.tx_hash}:${ev.event_index ?? '0'}:${ev.token_address}`;

        const isCredit = ev.type === 'credit';

        const doc = {
            user_id:          card.user_id,
            contract_address: card.address,
            merchant_id:      null,
            onchain_ref:      onchainRef,
            amount:           ev.amount_human,
            currency:         ev.token_symbol,
            fee:              0,
            net_amount:       ev.amount_human,
            amount_usd:       ev.amount_usd,
            price_usd:        ev.price_usd,
            type:    isCredit ? 'deposit'    : 'payment',
            channel: isCredit ? 'on_chain_in': 'on_chain_out',
            status:  'succeeded',   
            token_address:   ev.token_address,
            token_symbol:    ev.token_symbol,
            from_address:    ev.from_address,
            to_address:      ev.to_address,
            block_number:    ev.block_number,
            approval_hash:   ev.tx_hash,
            is_recurring:    false,
            subscription_id: null,
            merchant_payout: {},
            billing_details: {},
            metadata:        { synced_from_chain: true, decimals: ev.decimals, amount_raw: ev.amount_raw },
            meta_private:    {},
            device_fingerprint: { ip: 'chain', agent: 'transfer-sync-worker', fingerprint: null },
            timeline: [{
                status:    'succeeded',
                note:      `${isCredit ? 'Incoming' : 'Outgoing'} ${ev.token_symbol} transfer detected on-chain`,
                timestamp: now,
            }],
            created_at:  now,
            updated_at:  now,
        };

        try {
            await txModel.insertOne(doc);
        } catch (err) {
            // Duplicate key from a race — safe to ignore
            if (!err.message?.includes('duplicate') && !err.message?.includes('E11000')) {
                console.warn('[TransferSync] insertOne error:', err.message);
            }
        }
    }
}

// ─── Util ─────────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = startTransferSyncWorker;
