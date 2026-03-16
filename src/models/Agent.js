/**
 * Agent.js — ZionDefi Agent Registry Model
 *
 */

const MongoBase  = require('../lib/MongoBase');
const DateHelper = require('../utils/DateHelper');

class Agent extends MongoBase {
    constructor(mongoClient) {
        super(mongoClient, process.env.MONGO_DB, 'agents', {
            agent_id:      true,   
            name:          1,
            type:          1,
            enabled:       1,
            owner_user_id: 1,
            card_id:       1,
            created_at:    -1
        });

        this.date = new DateHelper();
    }

    async create(data) {
        const now     = this.date.timestampTimeNow();
        data.created_at = now;

        const result = await this.insertOne(data);
        return result;
    }

    async enable(agentId) {
        return this.updateOne(
            { agent_id: agentId },
            { enabled: true, updated_at: this.date.timestampTimeNow() }
        );
    }

    async disable(agentId) {
        return this.updateOne(
            { agent_id: agentId },
            { enabled: false, updated_at: this.date.timestampTimeNow() }
        );
    }

    async findById(agentId) {
        return this.findOne({ agent_id: agentId });
    }

    async findEnabled() {
        return this.findAll({ enabled: true });
    }

    async findByType(type) {
        return this.findAll({ type });
    }

    async findByCard(userId, cardId) {
        return this.findOne({ owner_user_id: userId, card_id: cardId });
    }

    async findByCardAndType(userId, cardId, type) {
        return this.findOne({ owner_user_id: userId, card_id: cardId, type: type });
    }

    async findByCardAndName(userId, cardId, name) {
        return this.findOne({ owner_user_id: userId, card_id: cardId, name: name });
    }
}

module.exports = Agent;
