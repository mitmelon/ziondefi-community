const MongoBase = require('../lib/MongoBase');

class Session extends MongoBase {
    constructor(mongoClient) {
        super(mongoClient, process.env.MONGO_DB, 'sessions', {
            stoken: true,
            user_id: 1,
            expire: 1
        });
    }

    async setSession(token, userId, expire, createdAt, device = []) {
        return await this.insertOne({
            stoken: token,
            user_id: userId,
            expire: expire,
            created_at: createdAt,
            updated_at: createdAt, // Added for consistency
            device: device
        });
    }

    async getSession(sessionToken, currentTime) {
        const auth = await this.findOne({
            stoken: sessionToken,
            expire: { $gt: currentTime }
        });
        return (auth && auth.user_id) ? auth : false;
    }

    async getSessionByUserId(userId, currentTime) {
        const auth = await this.findOne({
            user_id: userId,
            expire: { $gt: currentTime }
        });
        return (auth && auth.user_id) ? auth : false;
    }

    async addMoreSessionTime(token, userId, expire, updatedAt) {
        return await this.updateOne(
            { stoken: token, user_id: userId },
            {
                $set: { 
                    expire: expire,
                    updated_at: updatedAt
                }
            }
        );
    }

    async destroySession(token) {
        return await this.delete('deleteOne', { stoken: token });
    }
}

module.exports = Session;