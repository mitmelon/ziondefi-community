const MongoBase = require('../lib/MongoBase');
const crypto = require('crypto');
const DateHelper = require('../utils/DateHelper');

class Cards extends MongoBase {
    constructor(mongoClient) {
        super(mongoClient, process.env.MONGO_DB, 'cards', {
            card_id: true,       
            address: 1,
            wallet: 1,       
            user_id: 1,          
            status: 1,           
            created_at: -1   
        });

        this.enableEncryption(
            ['card_id', 'user_id', 'amount', 'wallet', 'address'], 
            'card_master_key',             
            ['card_id', 'user_id', 'amount', 'wallet', 'address'] // Deterministic fields for querying,  
        );
        
        this.date = new DateHelper();
    }

    /**
     * CREATE CARD (Deploy Request)
     * Stores the intent to deploy a StarkNet Account/Card
     */
    async create(data, deviceInfo = {}) {
        const now = this.date.timestampTimeNow();
       
        const record = {
            user_id: data.user_id,
            wallet: data.wallet || null,
            amount: data.amount || 0,
            name: data.name,
            color: data.color || 'black',
            status: 'pending_deployment', // pending_deployment, deploying, active, frozen, terminated, failed
            is_primary: data.is_primary || false,

            // Card configuration
            wallet_choice: data.wallet_choice || 'existing',
            pin_public_key: data.pin_public_key || null,
            currencies: data.currencies || [],
            payment_mode: data.payment_mode || 'MerchantTokenOnly',
            max_transaction_amount: data.max_transaction_amount || '0',
            daily_spend_limit: data.daily_spend_limit || '0',
            daily_transaction_limit: data.daily_transaction_limit || 50,
            slippage_tolerance_bps: data.slippage_tolerance_bps || 50,

            // Deployment details
            address: null,
            transaction_hash: null,
            gas_used: null,
            gas_price: null,
            deploy_attempts: 0,
            deploy_error: null,
            deployed_at: null,

            frozen_reason: null,
            device_fingerprint: {
                ip: deviceInfo.ip || 'unknown',
                agent: deviceInfo.ua || 'unknown'
            },
            version: '1.0',
            
            created_at: now,
            updated_at: now
        };

        const existingCard = await this.findOne({ user_id: data.user_id, status: { $in: ['pending_deployment', 'deploying', 'failed'] } });
        if (existingCard) {
            await this.updateOne(
                { card_id: existingCard.card_id },
                { $set: record }
            );
            return this.retrieve(existingCard.card_id);
        }

        const cardId = `crd_${crypto.randomBytes(16).toString('hex')}`;
        record.card_id = cardId;

        await this.insertOne(record);
        return record;
    }

    async retrieve(cardId) {
        return await this.findOne({ card_id: cardId });
    }

    async retrieveByUserId(userId, cardId) {
        return await this.findOne({ card_id: cardId, user_id: userId });
    }

    /**
     * GET THE USER'S SINGLE CARD (no card_id required)
     */
    async getCardByUser(userId) {
        return await this.findOne({ user_id: userId });
    }

    /**
     * GET CARD BY ADDRESS
     */
    async getByAddress(contractAddress) {
        return await this.findOne({ address: contractAddress });
    }

    /**
     * UPDATE STATUS (Freeze/Unfreeze/Activate)
     */
    async updateStatus(cardId, status, reason = null) {
        const updateData = {
            status: status,
            updated_at: this.date.timestampTimeNow()
        };

        if (reason) updateData.frozen_reason = reason;

        return await this.updateOne(
            { card_id: cardId },
            { $set: updateData }
        );
    }

    /**
     * UPDATE BALANCE
     */
    async updateBalance(cardId, newAmount) {
        return await this.updateOne(
            { card_id: cardId },
            { 
                $set: { 
                    amount: newAmount, 
                    updated_at: this.date.timestampTimeNow() 
                } 
            }
        );
    }

    /**
     * UPDATE DEPLOYMENT (When Chain Confirms)
     */
    async confirmDeployment(cardId, contractAddress, txHash, gasDetails = {}) {
        const serialNumber = await this.generateSerialNumber();
        return await this.updateOne(
            { card_id: cardId },
            { 
                $set: { 
                    status: 'active',
                    serial_number: serialNumber,
                    address: contractAddress,
                    transaction_hash: txHash,
                    gas: gasDetails,
                    deploy_error: null,
                    deployed_at: this.date.timestampTimeNow(),
                    updated_at: this.date.timestampTimeNow() 
                } 
            }
        );
    }

    /**
     * MARK DEPLOYMENT FAILED
     */
    async failDeployment(cardId, error, attempts) {
        try {
            return await this.updateOne(
                { card_id: cardId },
                { 
                    $set: { 
                        status: 'failed',
                        deploy_error: error,
                        deploy_attempts: attempts,
                        updated_at: this.date.timestampTimeNow() 
                    } 
                }
            );
        } catch (err) {
            console.error(`[Cards Model] Failed to mark deployment as failed for card ${cardId}:`, err);
            throw err;
        }
    }

    /**
     * MARK AS DEPLOYING (in-progress)
     */
    async markDeploying(cardId) {
        return await this.updateOne(
            { card_id: cardId },
            { 
                $set: { 
                    status: 'deploying',
                    updated_at: this.date.timestampTimeNow() 
                },
                $inc: { deploy_attempts: 1 }
            }
        );
    }

    /**
     * RESET TO PENDING (for redeploy)
     */
    async resetToPending(cardId) {
        return await this.updateOne(
            { card_id: cardId },
            { 
                $set: { 
                    status: 'pending_deployment',
                    deploy_error: null,
                    updated_at: this.date.timestampTimeNow() 
                } 
            }
        );
    }

    /**
     * DELETE CARD (Soft Delete / Terminate)
     * We rarely hard delete financial records.
     */
    async terminate(cardId) {
        return await this.updateOne(
            { card_id: cardId },
            { 
                $set: { 
                    status: 'terminated', 
                    updated_at: this.date.timestampTimeNow() 
                } 
            }
        );
    }

    /**
     * LIST CARDS (Cursor Pagination)
     * Supports filtering by status (Active vs Inactive)
     */
    async list(userId, options = {}) {
        const limit = Math.min(parseInt(options.limit) || 10, 50);
        const query = { user_id: userId };

        if (options.status) {
            if (options.status === 'active') {
                query.status = { $in: ['active', 'frozen', 'pending_deployment'] };
            } else if (options.status === 'inactive') {
                query.status = 'terminated';
            } else {
                // Specific status
                query.status = options.status;
            }
        }

        if (options.starting_after) {
            const cursor = await this.findOne({ card_id: options.starting_after });
            if (cursor) {
                query.created_at = { $lt: cursor.created_at };
            }
        } else if (options.ending_before) {
            const cursor = await this.findOne({ card_id: options.ending_before });
            if (cursor) {
                query.created_at = { $gt: cursor.created_at };
            }
        }

        const items = await this.findAll(query, { 
            limit: limit, 
            sort: { created_at: -1 } 
        });

        return {
            has_more: items.length === limit,
            next_cursor: items.length > 0 ? items[items.length - 1].card_id : null,
            data: items
        };
    }

    /**
     * GET CARD STATISTICS
     * Parallel execution for instant dashboard loading.
     */
    async getCardStats(userId) {
        // Run both queries simultaneously (Non-blocking)
        const [activeCount, inactiveCount] = await Promise.all([
            // 1. Active Cards (Includes Frozen & Pending)
            this.count({ 
                user_id: userId, 
                status: 'active' 
            }),
            
            // 2. Inactive Cards (Terminated/Deleted)
            this.count({ 
                user_id: userId, 
                status: { $in: ['deleted', 'frozen', 'terminated', 'pending_deployment', 'deploying', 'failed'] } 
            })
        ]);

        return {
            active: activeCount,
            inactive: inactiveCount,
            total: activeCount + inactiveCount
        };
    }

    async generateSerialNumber() {
        const timestamp = Date.now().toString(36).toUpperCase();
        const randomStr = crypto.randomBytes(4).toString('hex').toUpperCase();
        return `SN-${timestamp}-${randomStr}`;
    }
}

module.exports = Cards;