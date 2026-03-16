const EncryptionService = require('./EncryptionService');
const RateLimiter = require('./RateLimiter');
const Firewall = require('./Firewall');
const DateHelper = require('../utils/DateHelper'); 

class DashboardService {
    constructor(dbModels) {
        this.User = dbModels.User;
        this.Session = dbModels.Session;
        this.Security = dbModels.Security;
        this.Notification = dbModels.Notification;
        this.Cards = dbModels.Cards;
        
        this.rl = new RateLimiter(this.Security);
        this.fw = new Firewall(this.Security);
        this.enc = new EncryptionService(); 
        this.date = new DateHelper(); 
    }

    async hasUnread(user_id) {
        const count = await this.Notification.count({ 
            user_id: user_id, 
            is_read: false 
        });
        return count > 0;
        
    }

    async notification(user_id, limit = 10) {
        try {
            const notifications = await this.Notification.findAll(
                { 
                    user_id: user_id, 
                    is_read: false 
                }, 
                { 
                    sort: { created_at: -1 }, // Sort Newest First
                    limit: limit              // Limit results
                }
            );

            if (!notifications || notifications.length === 0) {
                return { status: true, all: [] };
            }

            const formattedNotifications = notifications.map(note => ({
                note_id: note.note_id,
                title: note.title,
                message: note.message,
                is_read: note.is_read,
                created_at: this.date.formatDate(note.created_at, 'MMM D, YYYY h:mm A') 
            }));

            return { status: true, all: formattedNotifications };

        } catch (error) {
            console.error("Notification Fetch Error:", error);
            return { status: false, all: [] };
        }
    }
    
}

module.exports = DashboardService;