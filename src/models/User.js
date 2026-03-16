const MongoBase = require('../lib/MongoBase');

class User extends MongoBase {
    constructor(mongoClient) {
        // 1. Hardcode DB and Collection Name here ONCE
        super(mongoClient, process.env.MONGO_DB, 'users', {
            email: true,
            username: true,
            company: 1,
            account_type: 1
        });

        // 2. Configure Encryption here ONCE
        /***
        this.enableEncryption(
            ['name', 'email', 'username', 'company', 'account_type', 'security'], 
            'user_master_key',               
            ['email', 'username', 'company', 'account_type', 'security']                               
        );
        **/
    }

    async findByEmail(email) {
        // Email is plain text in your logic, so standard find
        return await this.findOne({ email: email });
    }

    /**
     * Retrieve a user's Telegram chat ID for bot notifications.
     * Returns null if the user hasn't linked their Telegram account.
     *
     * @param {string} userId
     * @returns {Promise<string|null>}
     */
    async getTelegramId(userId) {
        const user = await this.findOne(
            { user_id: userId },
            { projection: { telegram_chat_id: 1, _id: 0 } }
        );
        return user?.telegram_chat_id || null;
    }
}

module.exports = User;