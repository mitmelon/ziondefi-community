class RateLimiter {
    constructor(securityModel) {
        this.db = securityModel;
        
        // Constants
        this.LIMITS = {
            GET: { limit: 100, interval: 60 },     // RATE_LIMIT_GET
            POST: { limit: 20, interval: 60 },     // RATE_LIMIT_POST
            OPTIONS: { limit: 100, interval: 60 }, // RATE_LIMIT_OPTIONS
            DEFAULT: { limit: 60, interval: 60 }   // RATE_LIMIT_DEFAULT
        };
    }

    /**
     * Consume a token
     */
    async limit(identifier, action = 'DEFAULT', limit = null, interval = 60) {
        const method = action.split('_')[1] || 'DEFAULT'; // e.g. METHOD_GET -> GET
        const config = this.LIMITS[method] || this.LIMITS.DEFAULT;

        const currentLimit = limit ?? config.limit;
        const currentInterval = interval ?? config.interval;
        const key = `${identifier}_${action}`;
        const now = Math.floor(Date.now() / 1000);

        let remaining = currentLimit;
        let reset = now + currentInterval;

        // 1. Check DB State
        const existing = await this.db.getRateLimit(key);

        if (existing) {
            if (existing.reset > now) {
                // Window active
                remaining = existing.remaining;
                reset = existing.reset;
            } else {
                // Window expired, reset
                remaining = currentLimit;
                reset = now + currentInterval;
            }
        }

        // 2. Consume Token
        const isAccepted = remaining > 0;
        if (isAccepted) {
            remaining--;
        }

        // 3. Persist
        const info = {
            limit: currentLimit,
            remaining: remaining,
            reset: reset
        };

        if (existing) {
            await this.db.updateRateLimit(key, info);
        } else {
            await this.db.createRateLimit(key, info);
        }

        return isAccepted;
    }

    async reset(identifier, action) {
        const key = `${identifier}_${action}`;
        return await this.db.deleteRateLimit(key);
    }
}

module.exports = RateLimiter;