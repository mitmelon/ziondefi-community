const fp = require('fastify-plugin');
const jwt = require('jsonwebtoken');

async function authGuard(fastify, options) {
    fastify.decorateRequest('user', null);
    fastify.decorateRequest('isApi', false);

    fastify.addHook('onRequest', async (req, reply) => {
        //Bypass Public Routes & Assets
        if (req.url.startsWith('/public') || req.url.startsWith('/assets')) return;
        
        const { auth, dashboard, apiService, postFilter } = req;
        
        const sessionKey = 'ziondefi_session';
        const rawCookie = req.cookies[sessionKey];
        const rawHeaderToken = req.headers['x-session-token'];
        
        // Sanitize Browser Tokens
        const browserToken = postFilter.strip(rawCookie || rawHeaderToken);
        
        let user = null;
        let isLive = true; // Default to Live

        // Fingerprint Device
        const currentDevice = postFilter.getDevice(req);
        
        // Validate Session
        const result = await auth.loggedin(browserToken, currentDevice);

        if (result && result.status) {
            user = result.user;
            isLive = user.is_live;
            req.sessionToken = result.session;

            // Sliding Window: Refresh Cookie
            reply.setCookie(sessionKey, result.session, {
                path: '/',
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: result.maxAge 
            });
        }
        
        if (user) {
            req.user = user;

            // Only switch if User/Client is explicitly in Test Mode
            if (isLive === false) {
                const sandboxDbName = process.env.DB_NAME_SANDBOX;

                if (req.models.Transactions) req.models.Transactions.useDatabase(sandboxDbName);

                if (req.models.Cards) req.models.Cards.useDatabase(sandboxDbName);

                if (req.models.Bridge) req.models.Bridge.useDatabase(sandboxDbName);

                if (req.models.AgentLogs) req.models.AgentLogs.useDatabase(sandboxDbName);

                if (req.models.StakePosition) req.models.StakePosition.useDatabase(sandboxDbName);
                
                req.log.debug(`[Context] Mode: SANDBOX | User: ${user.user_id}`);
            }

            // Setup Locals for View Engine
            reply.locals = reply.locals || {};
            reply.locals.user = user;

        } else {
            // Clear invalid session cookie if it existed
            if (browserToken) {
                reply.clearCookie(sessionKey, { path: '/' });
            }

            // API or AJAX Request -> Return JSON 401
            if (req.url.startsWith('/api') || req.headers['content-type'] === 'application/json') {
                return reply.code(401).send({ error: "Unauthorized", message: "Authentication required" });
            }
            
            // Standard Browser Request -> Redirect to Login
            const isProtectedRoute = req.url.startsWith('/home') || req.url.startsWith('/logout');
            if (isProtectedRoute) {
                return reply.redirect('/login');
            }
        }
    });
}

module.exports = fp(authGuard);