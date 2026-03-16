const MongoBase = require('../lib/MongoBase');

class Security extends MongoBase {
    constructor(mongoClient) {
        super(mongoClient, process.env.MONGO_DB, 'security');
        
        // Encryption Config
        /*** 
        this.enableEncryption(
            ['fingerprint', 'code', 'ip'], 
            'security_system', 
            ['fingerprint', 'code', 'ip']
        );
        */
    }

    async getSecurityByFingerprint(userOrIp) {
        try {
            return await this.findOne({
                $or: [
                    { user: userOrIp },
                    { ip: userOrIp },
                    { fingerprint: userOrIp }
                ]
            });
        } catch (e) {
            console.error("Error fetching security:", e);
            return null;
        }
    }

    // RATE LIMIT METHODS
    async rateLimitExists(key) {
        const doc = await this.findOne({ ratelimit_key: key });
        return !!doc;
    }

    async getRateLimit(key) {
        return await this.findOne({ ratelimit_key: key });
    }

    async updateRateLimit(key, info) {
        info.updated_at = Math.floor(Date.now() / 1000);
        return await this.updateOne(
            { ratelimit_key: key }, 
            { $set: info }
        );
    }

    async createRateLimit(key, info) {
        info.ratelimit_key = key;
        info.created_at = Math.floor(Date.now() / 1000);
        info.updated_at = info.created_at;
        return await this.insertOne(info);
    }

    async deleteRateLimit(key) {
        return await this.delete('deleteOne', { ratelimit_key: key });
    }

    // FIREWALL METHODS
    async firewallBlockExists(ip) {
        const doc = await this.findOne({ ip: ip });
        return !!doc;
    }

    async getFirewallBlock(ip) {
        return await this.findOne({ ip: ip });
    }

    async createFirewallBlock(ip, blockData) {
        const data = { ...blockData, ip: ip, created_at: Math.floor(Date.now() / 1000) };
        return await this.insertOne(data);
    }

    async deleteFirewallBlock(ip) {
        return await this.delete('deleteOne', { ip: ip });
    }

    // VERIFICATION
    async createVerification(verifyData) {
        return await this.insertOne(verifyData);
    }

    async getVerification(criteria) {
        return await this.findOne(criteria);
    }

    async updateSecurity(query, updateData) {
        return await this.updateOne(query, { $set: updateData });
    }
}

module.exports = Security;