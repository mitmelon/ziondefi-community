// Helper: Verify Cloudflare Turnstile
async function verifyTurnstile(token, ip) {
    if (!token) return false;
    try {
        const formData = new FormData();
        formData.append('secret', process.env.TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        formData.append('remoteip', ip);
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { body: formData, method: 'POST' });
        const data = await res.json();
        return data.success;
    } catch (e) {
        return false;
    }
}

module.exports = {
    wallet: async function (req, reply) {
        const { address, signature, typedData, wallet_id, publicKey } = req.body;

        const captchaToken = req.body['cf-turnstile-response'];

        if (!address || !signature || !typedData) {
            return reply.code(400).send({ status: 400, error: req.t('wallet_connection_failed') });
        }

        const isHuman = await verifyTurnstile(captchaToken, req.ip);
        if (!isHuman) {
            //return reply.code(400).send({ status: 400, error: req.t('security_check_failed') });
        }

        const device = req.postFilter.getDevice(req);
        device.fingerprint = address.toLowerCase();
        device.wallet_provider = wallet_id;

        try {
            const result = await req.auth.loginWithWallet(address, signature, typedData, device);

            if (result.status) {
                reply.setCookie('ziondefi_session', result.token, {
                    path: '/',
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    sameSite: 'lax',
                    maxAge: 1800
                });
                return reply.send({ status: 200, redirect: '/home' });
            } else {
                return reply.code(401).send({ status: 401, error: req.t(result.error) });
            }
        } catch (err) {
            req.log.error(err);
            return reply.code(500).send({ status: 500, error: req.t('server_error') });
        }
    },

    showLogin: async (req, reply) => {
        if (req.user) return reply.redirect('/home');
        return reply.view('auth/login.ejs', {
            app_name: process.env.APP_NAME || 'ZionDefi',
            title: req.t('auth.title', { app_name: process.env.APP_NAME }),
            root: '/',
            termsLink: '/terms',
            privacyLink: '/privacy',
        });
    },

    logout: async (req, reply) => {
        reply.clearCookie('ziondefi_session', { path: '/' });
        return reply.view('auth/login.ejs', {
            app_name: process.env.APP_NAME || 'ZionDefi',
            title: req.t('auth.title', { app_name: process.env.APP_NAME }),
            root: '/',
            termsLink: '/terms',
            privacyLink: '/privacy',
        });
    }
};