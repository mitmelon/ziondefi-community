const MongoBase = require('../lib/MongoBase');
const crypto = require('crypto');
const DateHelper = require('../utils/DateHelper');

class Transaction extends MongoBase {
    constructor(mongoClient) {
        // 1. Define Schema & Indexes
        super(mongoClient, process.env.MONGO_DB, 'transactions', {
            trans_id: true,       // Unique Index (The Cursor)
            ref_id: 1,            // External Reference
            user_id: 1,           // Card Owner
            merchant_id: 1,       // Requester
            contract_address: 1,  // The "Card" (Smart Contract)
            status: 1,            // State Machine
            created_at: -1,       // Sort Index (Integer)
            onchain_ref: { unique: true, sparse: true }  // On-chain dedup key
        });

        // 2. Configure Encryption
        // We encrypt sensitive banking data and personal info.
        // We DO NOT encrypt amounts or status (needed for analytics).
        this.enableEncryption(
            ['merchant_payout', 'billing_details', 'meta_private'], 
            'transaction_master_key',             
            ['merchant_payout', 'billing_details']                              
        );

        this.date = new DateHelper();

    }

    /**
     * CREATE TRANSACTION (Merchant Push or User Send)
     * @param {Object} data - Raw transaction payload
     * @param {Object} deviceInfo - Captured via PostFilter
     */
    async create(data, deviceInfo = {}) {
        const dateHelper = new DateHelper();

        const now = dateHelper.timestampTimeNow(); 

        // 1. VALIDATION & OVERFLOW PROTECTION
        // We accept Numbers or Strings, but convert to safe JS Floats
        let amount = parseFloat(data.amount);
        let fee = parseFloat(data.fee || 0);

        // Check for NaN
        if (isNaN(amount) || isNaN(fee)) {
            throw new Error("Invalid Amount: Must be a valid number.");
        }

        // Check for Infinity / Overflow
        if (!isFinite(amount) || !isFinite(fee)) {
            throw new Error("Invalid Amount: Number is too large (Overflow protection).");
        }

        // Check for Safety Limit (JS Safe Integer is ~9 Quadrillion)
        // If you go above this with floats, you lose precision, but it won't crash.
        // We log a warning if it's massive.
        if (amount > Number.MAX_SAFE_INTEGER) {
            console.warn(`[Transaction] Large Amount detected: ${amount}. Precision loss possible.`);
        }

        if (amount <= 0) {
            throw new Error("Invalid Amount: Must be positive.");
        }

        // 2. Generate Secure IDs
        const transId = `txn_${crypto.randomBytes(16).toString('hex')}`;
        // Use provided Ref ID or generate one
        const refId = data.ref_id || `ref_${crypto.randomBytes(8).toString('hex')}`;

        // 3. Construct Record
        const record = {
            trans_id: transId,
            ref_id: refId,
            
            // Identities
            user_id: data.user_id,             // The Payer (Card Owner)
            merchant_id: data.merchant_id || null, // The Payee (If Merchant Push)
            contract_address: data.contract_address, // The StarkNet Contract
            
            // Financials (Standard Mongo Numbers)
            amount: amount,               
            currency: data.currency.toUpperCase(), 
            fee: fee,
            net_amount: amount - fee, // Standard Math

            // State Machine
            status: data.status || 'pending_approval', //
            type: data.type || 'payment',      // payment, refund, subscription
            channel: data.channel || 'api',    // api, web_dashboard, mobile_app
            
            // Subscription Logic (Recurring)
            is_recurring: data.is_recurring || false,
            subscription_id: data.subscription_id || null,
            
            // Sensitive Data (Auto-Encrypted by MongoBase)
            merchant_payout: data.merchant_payout || {}, // { bank_code: "...", account: "..." }
            billing_details: data.billing_details || {}, // { name: "...", address: "..." }
            
            // Metadata
            metadata: data.metadata || {},     // Public metadata
            meta_private: data.meta_private || {}, // Internal system data (Encrypted)
            
            // Blockchain Specifics
            approval_hash: null,               // StarkNet Tx Hash (Added later)
            
            // Security / Audit Trail
            device_fingerprint: {
                ip: deviceInfo.ip || 'unknown',
                agent: deviceInfo.ua || 'unknown',
                fingerprint: deviceInfo.fingerprint || null
            },

            // Immutable Timeline
            timeline: [{
                status: data.status || 'pending_approval',
                note: 'Transaction created via ' + (data.channel || 'api'),
                timestamp: now // Integer
            }],

            created_at: now, // Integer
            updated_at: now  // Integer
        };

        // 4. Insert
        await this.insertOne(record);
        return record;
    }

    /**
     * APPROVE TRANSACTION (User Signs on StarkNet)
     * Transitions from 'pending_approval' -> 'processing'
     */
    async approve(transId, txHash) {
        const dateHelper = new DateHelper();
        const now = dateHelper.timestampTimeNow();

        return await this.updateOne(
            { trans_id: transId },
            { 
                $set: { 
                    status: 'processing', 
                    approval_hash: txHash, // The Proof on Chain
                    updated_at: now
                },
                $push: { 
                    timeline: {
                        status: 'processing',
                        note: `User approved via Contract. Hash: ${txHash}`,
                        timestamp: now
                    }
                }
            }
        );
    }

    /**
     * SETTLE TRANSACTION (Chain Confirmed)
     * Transitions 'processing' -> 'succeeded' OR 'failed'
     */
    async settle(transId, status, note = '') {
        const dateHelper = new DateHelper();
        const now = dateHelper.timestampTimeNow();
        
        const validStatuses = ['succeeded', 'failed'];
        if (!validStatuses.includes(status)) throw new Error('Invalid Settlement Status');

        return await this.updateOne(
            { trans_id: transId },
            { 
                $set: { status: status, updated_at: now },
                $push: { 
                    timeline: {
                        status: status,
                        note: note || 'Blockchain Confirmation Received',
                        timestamp: now
                    }
                }
            }
        );
    }

    /**
     * ANALYTICS: GET VOLUME (Aggregation Pipeline)
     * Calculates total SUCCESSFUL volume instantly. 
     * Ignores pending/refunded.
     */
    async getVolumeStats(userId, period = 'all') {
       
        const match = { 
            user_id: userId, 
            status: 'succeeded',
        };

        if (period === 'today') {
            match.created_at = { $gte: this.date.startOfDayTimestamp() };
        } else if (period === 'month') {
            match.created_at = { $gte: this.date.startOfMonthTimestamp() };
        }

        const pipeline = [
            { $match: match },
            { 
                $group: {
                    _id: null,
                    total_volume: { $sum: "$amount" },
                    total_fees: { $sum: "$fee" },
                    count: { $sum: 1 }
                }
            }
        ];

        const result = await this.aggregate(pipeline);
        return result[0] || { total_volume: 0, total_fees: 0, count: 0 };
    }

    /**
     * LIST TRANSACTIONS (Cursor Pagination)
     * Optimized for infinite scroll and API feeds.
     * @param {string} userId - Owner
     * @param {Object} options - { limit: 20, starting_after: 'txn_123', ... }
     */
    async list(userId, options = {}) {
        const limit = Math.min(parseInt(options.limit) || 20, 100);
        const query = { user_id: userId };

        // 1. Filters
        if (options.contract_address) query.contract_address = options.contract_address;
        if (options.status) query.status = options.status;
        if (options.type) query.type = options.type; // e.g. 'subscription'
        if (options.currency) query.currency = options.currency.toUpperCase();
        
        // 2. Date Range (Integer Comparison)
        if (options.start_date && options.end_date) {
            query.created_at = {
                $gte: parseInt(options.start_date), 
                $lte: parseInt(options.end_date)
            };
        }

        // 3. Cursor Logic (Reverse Chronological)
        // "starting_after" means "Give me older items than this ID"
        if (options.starting_after) {
            const cursor = await this.findOne({ trans_id: options.starting_after });
            if (cursor) {
                query.created_at = { $lt: cursor.created_at };
            }
        }
        // "ending_before" means "Give me newer items than this ID" (Prev Page)
        else if (options.ending_before) {
            const cursor = await this.findOne({ trans_id: options.ending_before });
            if (cursor) {
                query.created_at = { $gt: cursor.created_at };
            }
        }

        // 4. Execution
        const items = await this.find(query, { 
            limit: limit, 
            sort: { created_at: -1 }, // DESC (Newest First)
            projection: { merchant_payout: 0, meta_private: 0 } // Security: Hide sensitive backend data
        });

        // 5. Meta for API
        return {
            has_more: items.length === limit,
            next_cursor: items.length > 0 ? items[items.length - 1].trans_id : null,
            data: items
        };
    }

    /**
     * GET STATEMENT DATA
     * Fetches raw data for PDF generation services.
     */
    async getStatement(userId, startDateTimestamp, endDateTimestamp) {
        const query = {
            user_id: userId,
            status: 'succeeded', // Statements usually only show settled txns
            created_at: {
                $gte: parseInt(startDateTimestamp),
                $lte: parseInt(endDateTimestamp)
            }
        };

        // Fetch all (Stream if large, but array ok for standard statements)
        return await this.find(query, { sort: { created_at: 1 } });
    }

    /**
     * GET SINGLE TRANSACTION
     * Secure retrieval ensuring user ownership
     */
    async retrieve(transId, userId) {
        return await this.findOne({ 
            trans_id: transId, 
            user_id: userId 
        });
    }
}

module.exports = Transaction;