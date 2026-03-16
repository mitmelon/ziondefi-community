// ─── Shared response helpers ────────────────────────────────────────

const CardItemResponse = {
    type: 'object',
    properties: {
        card_id:    { type: 'string' },
        address:    { type: 'string' },
        status:     { type: 'string' },
        name:       { type: 'string' },
        created_at: { type: 'integer' },
        is_live:    { type: 'boolean' }
    }
};

// ─── API Schemas (JSON body, JWT auth — no CSRF) ────────────────────

const GetCardsSchema = {
    description: 'Get recently used cards',
    tags: ['cards'],
    security: [{ bearerAuth: [] }],
    querystring: {
        type: 'object',
        properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
        }
    },
    response: {
        200: {
            type: 'object',
            properties: {
                code:   { type: 'integer' },
                status: { type: 'string' },
                mode:   { type: 'string' },
                count:  { type: 'integer' },
                data:   { type: 'array', items: CardItemResponse }
            }
        }
    }
};

/**
 * API: Create Card
 * Accepts a JSON body with typed fields.
 * currencies is a native array (API clients send real JSON, not form-encoded strings).
 */
const ApiCreateCardSchema = {
    description: 'Create a new ZionDefi card and queue for blockchain deployment',
    tags: ['cards'],
    security: [{ bearerAuth: [] }],
    body: {
        type: 'object',
        required: ['owner', 'pin_public_key', 'currencies', 'payment_mode'],
        additionalProperties: false,
        properties: {
            owner:                  { type: 'string', minLength: 10, maxLength: 130 },
            wallet_choice:          { type: 'string', enum: ['existing', 'generate'], default: 'existing' },
            pin_public_key:         { type: 'string', minLength: 10, maxLength: 130 },
            currencies:             { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 1, maxItems: 20 },
            payment_mode:           { type: 'string', enum: ['MerchantTokenOnly', 'AnyAcceptedToken'] },
            settlement_mode:        { type: 'string', enum: ['Immediate', 'Delayed'], default: 'Immediate' },
            max_transaction_amount: { type: 'string', pattern: '^[0-9]+$', default: '0' },
            daily_spend_limit:      { type: 'string', pattern: '^[0-9]+$', default: '0' },
            daily_transaction_limit:{ type: 'integer', minimum: 1, maximum: 10000, default: 50 },
            slippage_tolerance_bps: { type: 'integer', minimum: 0, maximum: 10000, default: 50 },
            transfer_delay:         { type: 'integer', minimum: 0, maximum: 2592000, default: 86400 },
            settlement_delay:       { type: 'integer', minimum: 0, maximum: 2592000, default: 1800 }
        }
    },
    response: {
        200: {
            type: 'object',
            properties: {
                code:    { type: 'integer' },
                message: { type: 'string' },
                card_id: { type: 'string' }
            }
        }
    }
};

/**
 * API: Redeploy Card
 */
const ApiRedeployCardSchema = {
    description: 'Redeploy a failed card to the blockchain',
    tags: ['cards'],
    security: [{ bearerAuth: [] }],
    body: {
        type: 'object',
        required: ['card_id'],
        additionalProperties: false,
        properties: {
            card_id: { type: 'string', minLength: 5 }
        }
    },
    response: {
        200: {
            type: 'object',
            properties: {
                code:    { type: 'integer' },
                message: { type: 'string' },
                card_id: { type: 'string' }
            }
        }
    }
};

// ─── Dashboard Schemas (form-encoded, CSRF token present) ───────────

/**
 * Dashboard: Create Card
 * Form-encoded: currencies arrives as a JSON string, numeric fields as strings.
 */
const DashboardCreateCardSchema = {
    description: 'Create card from dashboard form',
    tags: ['cards'],
    body: {
        type: 'object',
        required: ['owner', 'pin_public_key', 'currencies', 'payment_mode'],
        properties: {
            owner:                  { type: 'string', minLength: 10, maxLength: 130 },
            wallet_choice:          { type: 'string', enum: ['existing', 'generate'] },
            pin_public_key:         { type: 'string', minLength: 10, maxLength: 130 },
            currencies:             { type: 'string', minLength: 2 },           // JSON-encoded array
            payment_mode:           { type: 'string', enum: ['MerchantTokenOnly', 'AnyAcceptedToken'] },
            max_transaction_amount: { type: 'string', default: '0' },
            daily_spend_limit:      { type: 'string', default: '0' },
            daily_transaction_limit:{ type: 'integer', minimum: 1, maximum: 10000, default: 50 },
            slippage_tolerance_bps: { type: 'integer', minimum: 0, maximum: 10000, default: 50 },
            transfer_delay:         { type: 'integer', minimum: 0, maximum: 2592000, default: 86400 },
            settlement_delay:       { type: 'integer', default: 0 },
            _csrf:                  { type: 'string' }
        }
    }
};

/**
 * Dashboard: Redeploy Card
 */
const DashboardRedeployCardSchema = {
    description: 'Redeploy card from dashboard',
    tags: ['cards'],
    body: {
        type: 'object',
        required: ['card_id'],
        properties: {
            card_id: { type: 'string', minLength: 5 },
            _csrf:   { type: 'string' }
        }
    }
};

module.exports = {
    GetCardsSchema,
    ApiCreateCardSchema,
    ApiRedeployCardSchema,
    DashboardCreateCardSchema,
    DashboardRedeployCardSchema
};