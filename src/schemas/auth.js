const loginSchema = {
    body: {
        type: 'object',
        required: ['email', 'password', 'fingerprint', '_csrf'], // <--- REQUIRE IT
        properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
            requestUrl: { type: 'string' },
            fingerprint: { type: 'string' },
            _csrf: { type: 'string' },
            'cf-turnstile-response': { type: 'string' }
        }
    }
};

const registerSchema = {
    body: {
        type: 'object',
        required: ['name', 'email', 'password', 'confirm', 'termsCheckbox', 'fingerprint', '_csrf'],
        properties: {
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
            confirm: { type: 'string' },
            org: { type: 'string' },
            termsCheckbox: { type: 'string' },
            referrer: { type: 'string' },
            fingerprint: { type: 'string' },
            _csrf: { type: 'string' },
            'cf-turnstile-response': { type: 'string' }
        }
    }
};

module.exports = { loginSchema, registerSchema };