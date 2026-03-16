/**
 * AgentLogs.js — MongoDB model for agent activity logs
 * 
 * Tracks all actions performed by autonomous agents including:
 * - Staking cycles
 * - Compound operations
 * - Nova AI decisions
 * - Errors and failures
 */

const MongoBase  = require('../lib/MongoBase');
const DateHelper = require('../utils/DateHelper');
const EncryptionService = require('../services/EncryptionService');

class AgentLogs extends MongoBase {
    constructor(mongoClient) {
        super(mongoClient, process.env.MONGO_DB, 'agent_logs', {
            log_id:        true,   
            agent_id:      1,
            agent_name:    1,
            card_id:       1,
            card_address:  1,
            owner_user_id: 1,
            action:        1,
            network:       1,
            created_at:    -1
        });

        this.date = new DateHelper();
    }

    /**
     * Create a new agent activity log
     */
    async create(data) {
        const now = this.date.timestampTimeNow();
        
        const log = {
            log_id: data.log_id || this._generateLogId(),
            agent_id: data.agent_id,
            agent_name: data.agent_name || 'unknown_agent', // Optional human-readable name
            card_id: data.card_id,
            card_address: data.card_address,
            owner_user_id: data.owner_user_id,
            action: data.action,                  // e.g., 'staking_cycle_started', 'compound_success'
            description: data.description,        // Human-readable summary
            metadata: data.metadata || {},        // Additional structured data
            network: data.network || 'mainnet',   // 'mainnet' or 'sepolia'
            created_at: now,
        };

        const result = await this.insertOne(log);
        return result;
    }

    /**
     * Get logs for a specific agent
     */
    async getByAgent(agentId, limit = 50) {
        return this.findAll({ agent_id: agentId }, limit);
    }

    /**
     * Get logs for a specific card
     */
    async getByCard(cardId, limit = 50) {
        return this.findAll({ card_id: cardId }, limit);
    }

    /**
     * Get logs by action type
     */
    async getByAction(action, limit = 50) {
        return this.findAll({ action }, limit);
    }

    /**
     * Get recent logs (last N entries)
     */
    async getRecent(limit = 100) {
        return this.findAll({}, limit);
    }

    /**
     * Get logs for a time range
     */
    async getByTimeRange(startTimestamp, endTimestamp, limit = 100) {
        return this.findAll({
            created_at: {
                $gte: startTimestamp,
                $lte: endTimestamp,
            }
        }, limit);
    }

    /**
     * Get all error logs
     */
    async getErrors(limit = 50) {
        return this.findAll({
            action: { $regex: /error|failed/i }
        }, limit);
    }

    /**
     * Get success logs only
     */
    async getSuccesses(limit = 50) {
        return this.findAll({
            action: { $regex: /success|complete/i }
        }, limit);
    }

    /**
     * Get activity summary for a card
     */
    async getCardSummary(cardId) {
        const logs = await this.getByCard(cardId, 1000);
        
        const summary = {
            total_logs: logs.length,
            staking_cycles: logs.filter(l => l.action === 'staking_cycle_started').length,
            compound_cycles: logs.filter(l => l.action === 'compound_cycle_started').length,
            successful_stakes: logs.filter(l => l.action === 'stake_success').length,
            successful_compounds: logs.filter(l => l.action === 'compound_success').length,
            errors: logs.filter(l => l.action.includes('error') || l.action.includes('failed')).length,
            last_activity: logs.length > 0 ? logs[0].created_at : null,
        };

        return summary;
    }

    /**
     * Generate unique log ID
     */
    _generateLogId() {
        return EncryptionService.uuid();
    }
}

module.exports = AgentLogs;