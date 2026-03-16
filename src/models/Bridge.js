const MongoBase = require('../lib/MongoBase');
const crypto = require('crypto');
const DateHelper = require('../utils/DateHelper');

class Bridge extends MongoBase {
    constructor(mongoClient) {
        super(mongoClient, process.env.MONGO_DB, 'bridge', {
            swap_id: true,
            reference_id: true,              
            status: 1,           
            created_at: -1,
            updated_at: -1
        });

        this.date = new DateHelper();
    }

    async create(data) {
        const now = this.date.timestampTimeNow();
       
        data.created_at = now;
        data.updated_at = now;

        await this.insertOne(data);
        return data;
    }

    async retrieve(reference_id) {
        return await this.findOne({ reference_id: reference_id });
    }

    async updateBridge(reference_id, data) {
        const now = this.date.timestampTimeNow();
        await this.updateOne(
            { reference_id: reference_id },
            { $set: { ...data, updated_at: now } }
        );
        return await this.retrieve(reference_id);
    }


}

module.exports = Bridge;