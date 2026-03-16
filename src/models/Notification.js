const MongoBase = require('../lib/MongoBase');

class Notification extends MongoBase {
    constructor(mongoClient) {
        // 1. Hardcode DB and Collection Name here ONCE
        super(mongoClient, process.env.MONGO_DB, 'notifications', {
            note_id: true,
            user_id: 1,
            title: 1,
            message: 1,
            is_read: 1,
            created_at: -1,
        });

        // 2. Configure Encryption here ONCE
        /***
        this.enableEncryption(
            ['title', 'message', 'is_read'], 
            'notification_master_key',               
            ['title', 'message', 'is_read']                               
        );
        **/
    }
}

module.exports = Notification;