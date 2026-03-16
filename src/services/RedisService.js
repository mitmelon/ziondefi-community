const Redis = require('ioredis');

class RedisService {
    constructor() {
        this.client = new Redis(process.env.REDIS_URI || 'redis://localhost:6379', {
            maxRetriesPerRequest: 3,
            enableReadyCheck: true
        });

        this.client.on('error', (err) => console.error('[Redis] System Error:', err));
        this.client.on('connect', () => console.log('[Redis] Connection Secured'));

        this.client.defineCommand('secureRateLimit', {
            numberOfKeys: 1,
            lua: `
                local current = redis.call("INCR", KEYS[1])
                if tonumber(current) == 1 then
                    redis.call("EXPIRE", KEYS[1], ARGV[2])
                end
                if tonumber(current) > tonumber(ARGV[1]) then
                    return 0 -- Blocked
                else
                    return 1 -- Allowed
                end
            `
        });
    }

    /**
     * ATOMIC RATE LIMIT CHECK
     * Returns TRUE if allowed, FALSE if blocked.
     */
    async checkRateLimit(identifier, limit, windowSeconds) {
        // Namespace the key to prevent collisions
        const key = `${process.env.REDIS_PREFIX || 'ziondefi:'}ratelimit:${identifier}`;
        const result = await this.client.secureRateLimit(key, limit, windowSeconds);
        return result === 1; 
    }

    // Secure Set/Get for other caching needs
    async set(key, value, ttlSeconds) {
        const fullKey = `${process.env.REDIS_PREFIX || 'ziondefi:'}${key}`;
        const serialized = JSON.stringify(value);
        await this.client.set(fullKey, serialized, 'EX', ttlSeconds);
    }

    async get(key) {
        const fullKey = `${process.env.REDIS_PREFIX || 'ziondefi:'}${key}`;
        const data = await this.client.get(fullKey);
        try { return JSON.parse(data); } catch { return null; }
    }
}

module.exports = new RedisService();