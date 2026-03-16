const DateHelper = { timestampTimeNow: () => Math.floor(Date.now() / 1000) };

class Firewall {
    constructor(securityModel) {
        this.db = securityModel;
        
        this.suspiciousPatterns = {
            user_agents: [
                /(curl|wget|python|zgrab|nikto|sqlmap|arachni|nessus|nmap|acunetix|qualys)/i,
                /(zmeu|brutus|hydra|netsparker|havij|appscan|w3af|burpsuite|metasploit)/i,
                /(<|>|'|%0A|%0D|%27|%3C|%3E|%00)/i
            ],
            payloads: [
                /(union.*select|concat.*\(|information_schema)/i,
                /(alert|script|onerror|onload|eval\()/i,
                /(base64_decode|exec|system|shell_exec|passthru)/i
            ],
            headers: [
                'x-forwarded-for', 'x-client-ip', 'x-real-ip', 
                'client-ip', 'x-forwarded', 'forwarded-for'
            ]
        };
    }

    /**
     * Block an IP
     */
    async block(ip, reason = 'Suspicious activity') {
        const LOGIN_TIMEOUT = 15 * 60; // 15 Minutes
        const now = DateHelper.timestampTimeNow();

        const blockData = {
            reason: reason,
            timestamp: now,
            expires: now + LOGIN_TIMEOUT
        };

        await this.db.createFirewallBlock(ip, blockData);
        return true;
    }

    async unblock(ip) {
        return await this.db.deleteFirewallBlock(ip);
    }

    async isBlocked(ip) {
        const block = await this.db.getFirewallBlock(ip);
        if (block) {
            if (block.expires > DateHelper.timestampTimeNow()) {
                return true;
            }
            // Expired: Clean up
            await this.unblock(ip);
        }
        return false;
    }

    /**
     * Analyze Request Behavior
     * @param {object} req - Fastify Request
     */
    async getBehavior(req) {
        let suspiciousScore = 0;
        const ip = req.ip;

        if (await this.isBlocked(ip)) return 'blocked';

        // 1. User Agent Analysis
        const ua = req.headers['user-agent'] || '';
        for (const pattern of this.suspiciousPatterns.user_agents) {
            if (pattern.test(ua)) suspiciousScore += 2;
        }

        // 2. Request Method & Payload Analysis
        if (req.method === 'POST' && req.body) {
            const bodyStr = JSON.stringify(req.body);
            for (const pattern of this.suspiciousPatterns.payloads) {
                if (pattern.test(bodyStr)) suspiciousScore += 3;
            }
        }

        // 3. Header Analysis
        for (const header of this.suspiciousPatterns.headers) {
            if (req.headers[header]) suspiciousScore += 1;
        }

        // 4. Score Result
        if (suspiciousScore >= 5) {
            await this.block(ip, 'Highly suspicious behavior detected');
            return 'highly_suspicious';
        } else if (suspiciousScore >= 3) {
            return 'suspicious';
        }

        return 'normal';
    }

    hasAttackSignatures(req) {
        const patterns = [
            /(<|%3C)script/i,
            /(document|window)\.(location|on\w+)/i,
            /javascript:[^]*/i,
            /(union|select|insert|drop|delete|update|alter)\s+/i,
            /\/etc\/passwd/i,
            /\/\.\.\//i,
            /\{\{.*\}\}/, // Template Injection
            /\$\{.*\}/
        ];

        // Flatten Request Inputs
        const inputs = [
            ...Object.values(req.query || {}),
            ...Object.values(req.body || {}),
            ...Object.values(req.params || {})
        ].map(v => String(v));

        for (const value of inputs) {
            for (const pattern of patterns) {
                if (pattern.test(value)) return true;
            }
        }
        return false;
    }
}

module.exports = Firewall;