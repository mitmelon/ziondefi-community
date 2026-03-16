const MongoBase = require('../lib/MongoBase');
const DateHelper = require('../utils/DateHelper');

class ApiToken extends MongoBase {
    constructor(mongoClient) {
        super(mongoClient, process.env.DB_NAME, 'api_tokens', {
            refresh_token: true,
            family_id: 1, // Critical for Reuse Detection
            expires_at: 1
        });

        /***
        this.enableEncryption(
            ['client_id', 'refresh_token', 'family_id', 'is_used', 'revoked'], 
            'apitoken_master_key',               
            ['client_id', 'refresh_token', 'family_id', 'is_used', 'revoked']                               
        );
        **/
       this.date = new DateHelper();
    }

    async saveRefreshToken(clientId, token, familyId, expiresAt) {
        return await this.insertOne({
            client_id: clientId,
            refresh_token: token,
            family_id: familyId,
            expires_at: expiresAt,
            created_at: this.date.timestampTimeNow(),
            updated_at: this.date.timestampTimeNow(),
            is_used: false, // Track usage for rotation
            revoked: false
        });
    }

    async findRefreshToken(token) {
        return await this.findOne({ 
            refresh_token: token,
            expires_at: { $gt: this.date.timestampTimeNow() } // Auto-filter expired
        });
    }

    /**
     * SECURITY: Kill Switch for Token Families
     * If theft is detected, this invalidates the user's entire login chain.
     */
    async revokeFamily(familyId) {
        return await this.updateMany(
            { family_id: familyId }, 
            { $set: { revoked: true, updated_at: this.date.timestampTimeNow()} }
        );
    }

    async markAsUsed(tokenId) {
        return await this.updateOne({ _id: tokenId }, { $set: { is_used: true, updated_at: this.date.timestampTimeNow() } });
    }
}

module.exports = ApiToken;