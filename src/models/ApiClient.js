const MongoBase = require('../lib/MongoBase');
const EncryptionService = require('../services/EncryptionService');
const DateHelper = require('../utils/DateHelper');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

class ApiClient extends MongoBase {
    constructor(mongoClient) {
        super(mongoClient, process.env.DB_NAME, 'api_clients', {
            client_id: true,
            user_id: 1,
            is_active: 1
        });

        /***
        this.enableEncryption(
            ['client_id', 'user_id', 'name', 'is_active', 'is_live', 'policies], 
            'api_master_key',               
            ['client_id', 'user_id', 'name', 'is_active', 'is_live', 'policies]                               
        );
        **/
        this.date = new DateHelper();
    }

    async getByClientId(clientId) {
        return await this.findOne({ client_id: clientId });
    }

    /**
     * Generate Secure Credentials
     * @returns {Object} { clientId, plainSecret } - Secret shown ONLY ONCE
     */
    async generateCredentials(userId, name, isLive, policies = {}) {

        const prefix = isLive ? 'live_' : 'test_';
        
        const clientId = prefix + crypto.randomBytes(32).toString('hex');
        const plainSecret = crypto.randomBytes(64).toString('hex');
        const secretHash = EncryptionService.hash(plainSecret);

        const env_status = (env === 'live') ? true : false;
      
        const doc = {
            user_id: userId,
            name: name,
            client_id: clientId,
            secret_hash: secretHash,
            is_active: true,
            is_live: isLive,
            created_at: this.date.timestampTimeNow(),
            policies: {
                allowed_ips: policies.allowed_ips || [], // CIDR or Single IP
                rate_limit_rpm: policies.rate_limit_rpm || 60,
                scopes: policies.scopes || ['read']
            }
        };

        await this.insertOne(doc);
        return { clientId, plainSecret }; 
    }
}

module.exports = ApiClient;