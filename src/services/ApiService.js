const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const ipaddr = require('ipaddr.js');
const EncryptionService = require('./EncryptionService');
const RedisService = require('./RedisService');
const RabbitService = require('./RabbitService');
const DateHelper = require('../utils/DateHelper');

class ApiService {
    constructor(models) {
        this.User = models.User;
        this.Cards = models.Cards;

        this.date = new DateHelper(); 
    }

    async createCard(params) {
        const {
            userId, userName, wallet, walletChoice, pinPublicKey,
            currencies, paymentMode,
            maxTxAmount, dailySpendLimit, dailyTxLimit, slippageBps,
            transferDelay, isLive, device
        } = params;

        if (!wallet || !pinPublicKey) {
            throw ApiService.error(400, 'Wallet address and PIN key are required');
        }

        if (!Array.isArray(currencies) || currencies.length === 0) {
            throw ApiService.error(400, 'Select at least one currency');
        }

        const validPaymentModes = ['MerchantTokenOnly', 'AnyAcceptedToken'];
        if (!validPaymentModes.includes(paymentMode)) {
            throw ApiService.error(400, 'Invalid payment mode');
        }

        const txLimit = Number.isFinite(dailyTxLimit) ? dailyTxLimit : 50;
        const slippage = Number.isFinite(slippageBps) ? slippageBps : 50;
        const xferDelay = Number.isFinite(transferDelay) ? transferDelay : 86400;

        // ── Persist ─────────────────────────────────────────────────
        const card = await this.Cards.create({
            user_id: userId,
            name: userName || 'ZionDefi Card',
            wallet: wallet,
            wallet_choice: walletChoice || 'existing',
            pin_public_key: pinPublicKey,
            currencies,
            payment_mode: paymentMode,
            max_transaction_amount: maxTxAmount || '0',
            daily_spend_limit: dailySpendLimit || '0',
            daily_transaction_limit: txLimit,
            slippage_tolerance_bps: slippage,
            transfer_delay: xferDelay,
            address: null,
            is_primary: false
        }, {
            ip: device?.ip || 'unknown',
            ua: device?.ua || 'unknown'
        });

        // ── Enqueue deployment ──────────────────────────────────────
        await this._publishDeploy('ziondefi.card.deploy', 'card.deploy', {
            card_id: card.card_id,
            user_id: userId,
            wallet: wallet,
            pin_public_key: pinPublicKey,
            currencies,
            payment_mode: paymentMode,
            max_transaction_amount: maxTxAmount || '0',
            daily_spend_limit: dailySpendLimit || '0',
            daily_transaction_limit: txLimit,
            slippage_tolerance_bps: slippage,
            transfer_delay: xferDelay,
            is_live: isLive !== false
        });

        return { card_id: card.card_id };
    }

    /**
     * REDEPLOY CARD
     * Resets a failed/pending card and re-queues for deployment.
     *
     * @param {Object} params
     * @param {string} params.userId  — Authenticated user ID (ownership check)
     * @param {string} params.cardId  — Card to redeploy
     * @param {boolean} params.isLive — Network flag
     * @returns {{ card_id: string }}
     */
    async redeployCard(params) {
        const { userId, cardId, isLive } = params;

        if (!cardId) {
            throw ApiService.error(400, 'card_id is required');
        }

        const card = await this.Cards.findOne({ card_id: cardId, user_id: userId });

        if (!card) {
            throw ApiService.error(404, 'Card not found');
        }

        const redeployable = ['failed', 'pending_deployment'];
        if (!redeployable.includes(card.status)) {
            throw ApiService.error(400, 'Card is not in a redeployable state');
        }

        await this.Cards.resetToPending(cardId);

        await this._publishDeploy('ziondefi.card.redeploy', 'card.redeploy', {
            card_id: card.card_id,
            user_id: card.user_id,
            wallet: card.wallet,
            pin_public_key: card.pin_public_key,
            currencies: card.currencies,
            payment_mode: card.payment_mode,
            max_transaction_amount: card.max_transaction_amount,
            daily_spend_limit: card.daily_spend_limit,
            daily_transaction_limit: card.daily_transaction_limit,
            slippage_tolerance_bps: card.slippage_tolerance_bps,
            transfer_delay: card.transfer_delay || 86400,
            is_live: isLive !== false
        });

        return { card_id: cardId };
    }

    // ── Internals ───────────────────────────────────────────────────

    /**
     * Publish deploy job to RabbitMQ.
     * Swallows queue errors — the card is persisted and can be retried.
     */
    async _publishDeploy(queueName, routeKey, payload) {
        try {
            await RabbitService.publish(queueName, routeKey, payload);
        } catch (err) {
            console.error('[ApiService] Queue publish failed:', err.message);
        }
    }

    async getCard(userId, cardId){
        try {
            const card = await this.Cards.retrieveByUserId(userId, cardId);
            if (!card) {
                return null;
            }
            return card;
        } catch (err) {
            throw err;
        }
    }

    async getCardByUser(userId){
        try {
            const card = await this.Cards.getCardByUser(userId);
            return card || null;
        } catch (err) {
            throw err;
        }
    }

    /**
     * Create a structured error with HTTP status code.
     */
    static error(code, message) {
        const err = new Error(message);
        err.statusCode = code;
        return err;
    }
}


module.exports = ApiService;