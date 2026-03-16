/**
 * StarknetCardService — ZionDefi Card SDK powered by Starkzap
 *
 * All blockchain interactions use the Starkzap SDK instead of starknet.js directly.
 * Starkzap provides built-in support for paymaster-sponsored transactions, plus a
 * convenient wallet interface that abstracts away signer management and fee handling.
 *
 * USAGE:
 *   const card = await StarknetCardService.create({ cardAddress });
 *   await card.approvePaymentRequest(requestId, sigR, sigS);
 */

// ─── starknet.js — only calldata helpers
const { uint256, CairoCustomEnum, CallData, hash, num } = require('starknet');

let _starkzap = null;
async function _getStarkzap() {
    if (!_starkzap) _starkzap = await import('starkzap');
    return _starkzap;
}

let StarkZap, StarkSigner, Wallet, Amount, fromAddress, sepoliaTokens,
    mainnetTokens, sepoliaValidators, mainnetValidators, ArgentPreset, Contract, ChainId;

const _starkzapReady = _getStarkzap().then(m => {
    StarkZap = m.StarkZap;
    StarkSigner = m.StarkSigner;
    Wallet = m.Wallet;
    Amount = m.Amount;
    fromAddress = m.fromAddress;
    sepoliaTokens = m.sepoliaTokens;
    mainnetTokens = m.mainnetTokens;
    sepoliaValidators = m.sepoliaValidators;
    mainnetValidators = m.mainnetValidators;
    ArgentPreset = m.ArgentPreset;
    Contract = m.Contract;
    ChainId = m.ChainId;
});

const redis = require('./RedisService');
const StarknetConfig = require('./StarknetConfig');
const priceOracle = require('../utils/PriceOracle');

const ABI_CACHE_TTL = 3600;
const ABI_KEY_PREFIX = 'abi2:';

/** Normalise any address to lowercase hex without leading-zero padding issues. */
function normalizeAddress(addr) {
    if (!addr) return null;
    return '0x' + BigInt(addr.toString()).toString(16).toLowerCase();
}

/** Wrap a raw bigint/string amount in a Starkzap Amount for display. */
function toAmount(raw, token) {
    return Amount.fromRaw(BigInt(raw.toString()), token);
}

class StarknetCardService {

    /**
     * @param {object} opts
     * @param {string}   opts.cardAddress        — deployed card contract address
     * @param {boolean}  [opts.isLive=true]      — true = mainnet, false = sepolia
     * @param {string}   [opts.nodeUrl]          — custom RPC URL (auto-resolved if omitted)
     * @param {string}   [opts.relayerAddress]   — relayer account address
     * @param {string}   [opts.relayerPrivateKey]— relayer private key
     * @param {string}   [opts.paymasterUrl]     — AVNU paymaster URL (enables sponsored tx)
     * @param {string}   [opts.paymasterApiKey]  — AVNU paymaster API key
     * @param {object[]} [opts.abi]              — pre-fetched ABI (set by create())
     */
    constructor(opts = {}) {
        const isLive = opts.isLive !== undefined ? opts.isLive : true;
        const netConfig = StarknetConfig.resolve(isLive);

        this.isLive = isLive;
        this.cardAddress = opts.cardAddress;
        if (!opts.abi) throw new Error('Use StarknetCardService.create() instead of new');
        if (!this.cardAddress) throw new Error('cardAddress is required');

        this.abi = opts.abi;

        // ── Build Starkzap SDK — let Starkzap use its built-in RPC unless
        //    explicitly overridden via opts.nodeUrl.
        this.sdk = StarknetCardService._makeSdk(isLive, {
            rpcUrl: netConfig.nodeUrl,
            paymasterUrl: opts.paymasterUrl || netConfig.paymasterUrl,
            paymasterApiKey: opts.paymasterApiKey || netConfig.paymasterApiKey,
        });
        this.network = isLive ? 'mainnet' : 'sepolia';
        this.tokens = isLive ? mainnetTokens : sepoliaTokens;

        // ── Relayer wallet (used for most card write calls) ───────────────────
        const relayerAddr = opts.relayerAddress || netConfig.relayerAddress;
        const relayerPk = opts.relayerPrivateKey || netConfig.relayerPrivateKey;

        this._relayerAddr = relayerAddr;
        this._relayerPk = relayerPk;
        this._relayerWallet = null; // lazy — see _getRelayerWallet()

        // Read-only RPC provider (for view calls & ABI fetch)
        this.provider = this.sdk.getProvider();
    }

    /**
     * Async factory — fetches and caches the card ABI, then returns a service instance.
     */
    static async create(opts = {}) {
        await _starkzapReady;
        const isLive = opts.isLive !== undefined ? opts.isLive : true;
        const netConfig = StarknetConfig.resolve(isLive);

        // Let Starkzap use its built-in RPC; only override with explicit nodeUrl
        const provider = StarknetCardService._makeSdk(isLive, {
            rpcUrl: netConfig.nodeUrl,
        }).getProvider();
        const cardAddress = opts.cardAddress;
        if (!cardAddress) throw new Error('cardAddress is required');

        const addrCacheKey = `${ABI_KEY_PREFIX}addr:${cardAddress.toLowerCase()}`;
        let abi = await redis.get(addrCacheKey);
        if (abi) return new StarknetCardService({ ...opts, abi });

        try {
            const classHash = await provider.getClassHashAt(cardAddress);
            const hashCacheKey = `${ABI_KEY_PREFIX}${classHash}`;

            abi = await redis.get(hashCacheKey);
            if (!abi) {
                const contractClass = await provider.getClassAt(cardAddress);
                abi = typeof contractClass.abi === 'string'
                    ? JSON.parse(contractClass.abi)
                    : contractClass.abi;
                await redis.set(hashCacheKey, abi, ABI_CACHE_TTL);
            }

            await redis.set(addrCacheKey, abi, ABI_CACHE_TTL * 24);
            return new StarknetCardService({ ...opts, abi });
        } catch (rpcErr) {
            try {
                const contractClass = await provider.getClassAt(cardAddress);
                abi = typeof contractClass.abi === 'string'
                    ? JSON.parse(contractClass.abi)
                    : contractClass.abi;
                await redis.set(addrCacheKey, abi, ABI_CACHE_TTL * 24);
                return new StarknetCardService({ ...opts, abi });
            } catch (_) {
                throw rpcErr;
            }
        }
    }

    /**
     * Return a cached Starkzap WalletInterface for the relayer.
     * Wallets are connected lazily so the constructor stays synchronous.
     */
    async _getRelayerWallet(feeMode = 'user_pays') {
        if (!this._relayerAddr || !this._relayerPk) {
            throw new Error('Relayer credentials not configured');
        }
        if (!this._relayerWallet) {
            this._relayerWallet = await Wallet.create({
                account: { signer: new StarkSigner(this._relayerPk) },
                accountAddress: this._relayerAddr,
                provider: this.sdk.provider,
                config: this.sdk.config,
                ...(feeMode && { feeMode }),
            });
        }
        return this._relayerWallet;
    }

    /**
     * Connect a one-shot wallet for an arbitrary caller (owner account, etc.)
     * The caller provides their own private key in secure server contexts.
     *
     * @param {object} callerAccount  — { address, privateKey } from the request context
     * @param {string} [feeMode]      — 'user_pays' | 'sponsored'
     */
    async _connectCallerWallet(callerAccount, feeMode = 'user_pays') {
        return Wallet.create({
            account: { signer: new StarkSigner(callerAccount.privateKey) },
            accountAddress: callerAccount.address,
            provider: this.sdk.provider,
            config: this.sdk.config,
            ...(feeMode && { feeMode }),
        });
    }

    /**
     * Resolve the wallet to use.
     * If callerAccount is provided use it; otherwise use relayer.
     */
    async _resolveWallet(callerAccount, feeMode) {
        if (callerAccount) return this._connectCallerWallet(callerAccount, feeMode);
        return this._getRelayerWallet(feeMode);
    }

    /**
     * Execute a raw contract call via Starkzap wallet.execute([call]).
     * Returns { txHash, receipt, explorerUrl }.
     */
    async _execute(wallet, call, feeMode) {
        const execOpts = feeMode ? { feeMode } : {};
        const tx = await wallet.execute([call], execOpts);
        await tx.wait();
        const receipt = await tx.receipt();
        return {
            txHash: tx.hash,
            explorerUrl: tx.explorerUrl,
            receipt,
        };
    }

    /**
     * Build a low-level Call object for the card contract.
     */
    _cardCall(entrypoint, calldata = []) {
        return {
            contractAddress: this.cardAddress,
            entrypoint,
            calldata: CallData.compile(calldata),
        };
    }

    /**
     * Resolve PIN signature arguments.
     * Always passes (sigR, sigS) — defaults to '0x0' if not provided.
     */
    _resolvePin(sigR, sigS) {
        return { r: sigR || '0x0', s: sigS || '0x0' };
    }

    /**
    * Perform a read-only contract call.
    * @param {string} entrypoint - Function name
    * @param {Array} calldata - Function arguments  
    * @param {Wallet} [wallet] - Optional authenticated wallet for caller address
    */
    async _view(entrypoint, calldata = [], wallet = null) {
        const call = this._cardCall(entrypoint, calldata);
        if (wallet) return wallet.callContract(call);
        return this.provider.callContract(call);
    }

    /**
     * Look up actual fee from a past transaction hash.
     */
    async getGasCost(txHash) {
        const receipt = await this.provider.getTransactionReceipt(txHash);
        return {
            txHash,
            status: receipt.finality_status,
            actualFee: receipt.actual_fee?.amount?.toString() ?? '0',
            feeUnit: receipt.actual_fee?.unit ?? 'FRI',
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // A. CARD CONFIGURATION
    // ──────────────────────────────────────────────────────────────────────────

    async addAcceptedCurrency(token, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('add_accepted_currency', [token, r, s]));
    }

    async removeAcceptedCurrency(token, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('remove_accepted_currency', [token, r, s]));
    }

    async updatePaymentMode(mode, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const modeEnum = new CairoCustomEnum({ [mode]: {} });
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('update_payment_mode', [modeEnum, r, s]));
    }

    async setSlippageTolerance(toleranceBps, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('set_slippage_tolerance', [toleranceBps, r, s]));
    }

    async setAutoApproveThreshold(thresholdUsd, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        // Contract compares against Pragma USD (8 decimals) — must scale by 1e8.
        return this._execute(wallet, this._cardCall('set_auto_approve_threshold', [
            StarknetCardService.usdToU256(thresholdUsd), r, s,
        ]));
    }

    async updateSpendingLimits(maxTxAmount, dailyTxLimit, dailySpendLimit, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        // maxTxAmount and dailySpendLimit are in human dollars — scale to USD×10^8.
        return this._execute(wallet, this._cardCall('update_spending_limits', [
            StarknetCardService.usdToU256(maxTxAmount),
            dailyTxLimit,
            StarknetCardService.usdToU256(dailySpendLimit),
            r, s,
        ]));
    }

    async setMerchantSpendLimit(merchant, maxAmountUsd, sigR, sigS, ownerAccount) {
        if (!ownerAccount) throw new Error('setMerchantSpendLimit requires ownerAccount');
        const wallet = await this._connectCallerWallet(ownerAccount);
        // maxAmountUsd is in human dollars — scale to USD×10^8 for on-chain comparison.
        return this._execute(wallet, this._cardCall('set_merchant_spend_limit', [
            merchant, StarknetCardService.usdToU256(maxAmountUsd), sigR, sigS,
        ]));
    }

    async removeMerchantSpendLimit(merchant, sigR, sigS, ownerAccount) {
        if (!ownerAccount) throw new Error('removeMerchantSpendLimit requires ownerAccount');
        const wallet = await this._connectCallerWallet(ownerAccount);
        return this._execute(wallet, this._cardCall('remove_merchant_spend_limit', [merchant, sigR, sigS]));
    }

    async setTokenPriceFeed(token, pairId, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('set_token_price_feed', [token, pairId, r, s]));
    }

    async setTransferDelay(delaySeconds, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('update_transfer_delay', [delaySeconds, r, s]));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // B. RELAYER MANAGEMENT
    // ──────────────────────────────────────────────────────────────────────────

    /** Add an extra relayer. Owner PIN required. */
    async addRelayer(newRelayer, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('add_relayer', [newRelayer, r, s]));
    }

    /** Revoke an extra relayer. Owner PIN required. Cannot revoke the primary relayer. */
    async revokeRelayer(relayer, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('revoke_relayer', [relayer, r, s]));
    }

    /** Returns the primary relayer followed by all active extra relayers. */
    async getRelayers() {
        return this._view('get_relayers', []);
    }

    async isExtraRelayer(relayer) {
        return this._view('is_extra_relayer', [relayer]);
    }

    /** Upgrade the card contract. Owner PIN required. */
    async upgradeCard(newClassHash, sigR, sigS, ownerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = ownerAccount
            ? await this._connectCallerWallet(ownerAccount)
            : await this._getRelayerWallet();
        return this._execute(wallet, this._cardCall('upgrade', [newClassHash, r, s]));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // C. PAYMENT REQUESTS
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * @param {number} intervalSeconds  Seconds between charges.
     *   Pass 0 for calendar-monthly billing: the contract charges on the same day-of-month
     *   each month, derived from startDate (e.g. start Jan 31 → Feb 28/29, not Mar 2).
     *   Any positive value is a fixed interval in seconds (e.g. 86400=daily, 604800=weekly).
     * @param {number} startDate        Unix timestamp of first allowed charge. Required when isRecurring=true.
     * @param {number} endDate          Unix timestamp of subscription expiry (0 = no expiry).
     */
    async submitPaymentRequest(merchant, amount, token, isRecurring, intervalSeconds, startDate, endDate, description, metadata, callerAccount) {
        const wallet = await this._resolveWallet(callerAccount);
        const call = this._cardCall('submit_payment_request', [
            merchant,
            uint256.bnToUint256(BigInt(amount)),
            token,
            isRecurring,
            intervalSeconds ?? 0,
            startDate ?? 0,
            endDate ?? 0,
            description || '',
            metadata || '',
        ]);

        const tx = await wallet.execute([call]);
        await tx.wait();
        const receipt = await tx.receipt();

        return {
            txHash: tx.hash,
            receipt,
            // request_id comes back as the first felt in the response array
            requestId: receipt.events?.[0]?.data?.[0]
                ? Number(receipt.events[0].data[0])
                : null,
        };
    }

    async approvePaymentRequest(requestId, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('approve_payment_request', [requestId, r, s]));
    }

    async approveMultipleRequests(requestIds, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('approve_multiple_requests', [requestIds, r, s]));
    }

    async rejectPaymentRequest(requestId, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('reject_payment_request', [requestId, r, s]));
    }

    async revokePaymentApproval(requestId, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('revoke_payment_approval', [requestId, r, s]));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // D. CHARGE & PAYMENT
    // ──────────────────────────────────────────────────────────────────────────

    async chargeCard(requestId, opts = {}) {
        const wallet = await this._resolveWallet(opts.account);
        const key = opts.idempotencyKey || StarknetCardService.generateIdempotencyKey();
        const slippage = opts.slippageBps || 100;
        const deadline = opts.deadlineSeconds
            ? Math.floor(Date.now() / 1000) + opts.deadlineSeconds
            : Math.floor(Date.now() / 1000) + 300;

        const quote = opts.quote
            ? { variant: { Some: StarknetCardService.buildQuote(opts.quote) } }
            : { variant: { None: {} } };

        return this._execute(wallet, this._cardCall('charge_card', [
            requestId, key, quote, slippage, deadline,
        ]));
    }

    async chargeRecurring(requestId, opts = {}) {
        const wallet = await this._resolveWallet(opts.account);
        const key = opts.idempotencyKey || StarknetCardService.generateIdempotencyKey();
        const slippage = opts.slippageBps || 100;
        const deadline = opts.deadlineSeconds
            ? Math.floor(Date.now() / 1000) + opts.deadlineSeconds
            : Math.floor(Date.now() / 1000) + 300;

        const quote = opts.quote
            ? { variant: { Some: StarknetCardService.buildQuote(opts.quote) } }
            : { variant: { None: {} } };

        return this._execute(wallet, this._cardCall('charge_recurring', [
            requestId, key, quote, slippage, deadline,
        ]));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // E. FUNDS MANAGEMENT
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Relayer-initiated yield withdrawal: transfer token from the card to the
     * relayer's own address.  Requires relayer yield access to be granted for
     * this token (no PIN needed — the contract checks relayer_yield_access).
     *
     * @param {string} tokenAddress  — ERC-20 token contract address
     * @param {string} amountHuman   — Human-readable amount (e.g. "10.5")
     * @param {object} [callerAccount] — defaults to configured relayer wallet
     */
    async withdrawFunds(tokenAddress, amountHuman, callerAccount) {
        if (!this._relayerAddr) throw new Error('Relayer address not configured');
        const token = this._resolveTokenByAddress(tokenAddress);
        const amountRaw = Amount.parse(amountHuman, token).toBase();

        let predictedTransferId = null;
        try {
            const counterRaw = await this._view('get_request_counter');
            const counter = Array.isArray(counterRaw) ? counterRaw[0] : counterRaw;
            predictedTransferId = (BigInt(counter) + 1n).toString();
        } catch (_) { /* non-fatal — caller falls back to querying getPendingTransfer */ }

        const wallet = await this._resolveWallet(callerAccount);
        const result = await this._execute(wallet, this._cardCall('transfer_funds', [
            tokenAddress,
            this._relayerAddr,
            uint256.bnToUint256(amountRaw),
            '0x0',
            '0x0',
        ]));

        return { ...result, transferId: predictedTransferId };
    }

    /**
     * Owner-initiated transfer: send token from the card to any recipient.
     * Requires owner PIN signature.
     *
     * @param {string} tokenAddress  — ERC-20 token contract address
     * @param {string} amountHuman   — Human-readable amount (e.g. "10.5")
     * @param {string} recipient     — Destination address
     * @param {string} sigR          — PIN ECDSA r component
     * @param {string} sigS          — PIN ECDSA s component
     * @param {object} [callerAccount]
     */
    async transferFunds(tokenAddress, amountHuman, recipient, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const token = this._resolveTokenByAddress(tokenAddress);
        const amountRaw = Amount.parse(amountHuman, token).toBase();
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('transfer_funds', [
            tokenAddress,
            recipient,
            uint256.bnToUint256(amountRaw),
            r,
            s,
        ]));
    }

    async executeTransfer(transferId, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('execute_transfer', [transferId, r, s]));
    }

    async cancelTransfer(transferId, sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('cancel_transfer', [transferId, r, s]));
    }

    /**
     * Finalize a queued transfer once its delay period has elapsed.
     * Called by the relayer (no PIN required — on-chain yield-access bypass applies).
     * The relayer passes sig_r = sig_s = 0x0; the contract skips PIN verification
     * because the caller is the authorized_relayer and yield access is granted.
     *
     * @param {string|number} transferId  — The u64 transfer/request ID returned by withdrawFunds
     * @param {object} [callerAccount]    — Defaults to relayer wallet
     */
    async finalizeTransfer(transferId, callerAccount) {
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('finalize_transfer', [transferId, '0x0', '0x0']));
    }

    // ── Yield Access ────────────────────────────────────────────────────────
    // User grants/revokes the relayer's ability to transfer a specific token
    // without PIN (for protocol yield strategies).

    async grantRelayerYieldAccess(sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('grant_relayer_yield_access', [r, s]));
    }

    async revokeRelayerYieldAccess(sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('revoke_relayer_yield_access', [r, s]));
    }

    async getRequestCounter() { return this._view('get_request_counter'); }

    async isRelayerYieldAccessGranted(token) {
        return this._view('is_relayer_yield_access_granted', [token]);
    }

    async getTransferDelay() {
        return this._view('get_transfer_delay');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // F. MERCHANT BLACKLIST
    // ──────────────────────────────────────────────────────────────────────────

    async addMerchantToBlacklist(merchant, reason, sigR, sigS, ownerAccount) {
        const wallet = await this._connectCallerWallet(ownerAccount);
        return this._execute(wallet, this._cardCall('add_merchant_to_blacklist', [merchant, reason, sigR, sigS]));
    }

    async removeMerchantFromBlacklist(merchant, sigR, sigS, ownerAccount) {
        const wallet = await this._connectCallerWallet(ownerAccount);
        return this._execute(wallet, this._cardCall('remove_merchant_from_blacklist', [merchant, sigR, sigS]));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // H. CARD LIFECYCLE
    // ──────────────────────────────────────────────────────────────────────────

    async freezeCard(sigR, sigS, callerAccount) {
        const { r, s } = this._resolvePin(sigR, sigS);
        const wallet = await this._resolveWallet(callerAccount);
        return this._execute(wallet, this._cardCall('freeze_card', [r, s]));
    }

    async unfreezeCard(sigR, sigS, ownerAccount) {
        if (!ownerAccount) throw new Error('unfreezeCard requires ownerAccount');
        const wallet = await this._connectCallerWallet(ownerAccount);
        return this._execute(wallet, this._cardCall('unfreeze_card', [sigR, sigS]));
    }

    async burnCard(sigR, sigS, ownerAccount) {
        if (!ownerAccount) throw new Error('burnCard requires ownerAccount');
        const wallet = await this._connectCallerWallet(ownerAccount);
        return this._execute(wallet, this._cardCall('burn_card', [sigR, sigS]));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // I. PIN MANAGEMENT
    // ──────────────────────────────────────────────────────────────────────────

    async rotatePin(newPublicKey, oldSigR, oldSigS, ownerAccount) {
        const wallet = await this._connectCallerWallet(ownerAccount);
        return this._execute(wallet, this._cardCall('rotate_pin', [newPublicKey, oldSigR, oldSigS]));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // J. VIEW FUNCTIONS (read-only, no signer required)
    // ──────────────────────────────────────────────────────────────────────────
    async getPinPublicKey(user) {
        const wallet = await this._getRelayerWallet();
        const result = await this._view('get_pin_public_key', [user], wallet);
        return '0x' + BigInt(result[0]).toString(16);
    }

    async getPinNonce(user) {
        const wallet = await this._getRelayerWallet();
        const result = await this._view('get_pin_nonce', [user], wallet);
        return Number(result);
    }

    async getAcceptedCurrencies() { return this._view('get_accepted_currencies'); }
    async getFactoryAcceptedTokens() { return this._view('get_factory_accepted_tokens'); }
    async getPaymentMode() { return this._view('get_payment_mode'); }
    async isCurrencyAccepted(token) { return this._view('is_currency_accepted', [token]); }
    async getCardStatus() { return this._view('get_card_status'); }
    async isIdempotencyKeyUsed(key) { return this._view('is_idempotency_key_used', [key]); }
    async isDeploymentFeePaid() { return this._view('is_deployment_fee_paid'); }
    async getDeploymentFeeDebt() { return this._view('get_deployment_fee_debt'); }
    async isMerchantBlacklisted(merchant) { return this._view('is_merchant_blacklisted', [merchant]); }
    async getAutoApproveThreshold() { return this._view('get_auto_approve_threshold'); }
    async getMerchantSpendLimit(merchant) { return this._view('get_merchant_spend_limit', [merchant]); }

    async getPendingRequests(offset = 0, limit = 20) {
        return this._view('get_pending_requests', [offset, limit]);
    }

    async getApprovedRequests(offset = 0, limit = 20) {
        return this._view('get_approved_requests', [offset, limit]);
    }

    async getTransactions(offset = 0, limit = 20) {
        return this._view('get_transactions', [offset, limit]);
    }

    async getRequestDetails(requestId) {
        const r = await this._view('get_request_details', [requestId]);
        return {
            requestId: Number(r[0]),
            merchant: r[1],
            amount: r[2],
            merchantToken: r[3],
            isRecurring: Boolean(r[4]),
            status: r[5],
            description: r[6],
            metadata: r[7],
            createdAt: Number(r[8]),
            approvedAt: Number(r[9]),
            lastChargedAt: Number(r[10]),
            chargeCount: Number(r[11]),
        };
    }

    async getSettlementInfo(requestId) {
        const r = await this._view('get_settlement_info', [requestId]);
        return {
            requestId: Number(r[0]),
            amountForMerchant: r[1],
            adminFee: r[2],
            cashback: r[3],
            token: r[4],
            payoutWallet: r[5],
            merchant: r[6],
            settleAt: Number(r[7]),
            settled: Boolean(r[8]),
            cancelled: Boolean(r[9]),
            swapOccurred: Boolean(r[10]),
            tokenIn: r[11],
            swapFee: r[12],
        };
    }

    async getPendingTransfer(transferId) {
        const r = await this._view('get_pending_transfer', [transferId]);
        return {
            transferId: Number(r[0]),
            token: r[1],
            amount: r[2],
            recipient: r[3],
            createdAt: Number(r[4]),
            executeAfter: Number(r[5]),
            executed: Boolean(r[6]),
            cancelled: Boolean(r[7]),
        };
    }

    async getCardInfo() {
        const r = await this._view('get_card_info');
        return {
            cardAddress: r[0],
            owner: r[1],
            relayer: r[2],
            isFrozen: Boolean(r[3]),
            isBurned: Boolean(r[4]),
            createdAt: Number(r[5]),
            paymentMode: r[6],
            slippageToleranceBps: Number(r[7]),
            autoApproveThresholdUsd: r[8],
            totalCurrencies: Number(r[9]),
            totalMerchants: Number(r[10]),
            totalTransactions: Number(r[11]),
            totalRequests: Number(r[12]),
            totalTransfers: Number(r[13]),
        };
    }

    async getRateLimitStatus() {
        const r = await this._view('get_rate_limit_status');
        return {
            isLocked: Boolean(r[0]),
            failedAttempts: Number(r[1]),
            lockoutUntil: Number(r[2]),
            requestsSubmittedLastHour: Number(r[3]),
            approvalsLastHour: Number(r[4]),
            lastChargeTimestamp: Number(r[5]),
            cooldownRemaining: Number(r[6]),
        };
    }

    async getBalanceSummary() {
        const res = await this._view('get_balance_summary');
        const n = Number(BigInt(res[0]));
        const balances = [];
        // TokenBalance now contains: token, balance(u256), contract_balance(u256), last_updated
        // Each u256 is returned as two felts (low, high) so stride = 6
        for (let i = 0; i < n; i++) {
            const base = 1 + i * 6;
            const token = res[base];
            const balance = BigInt(res[base + 1]) + (BigInt(res[base + 2]) << 128n);
            const contractBalance = BigInt(res[base + 3]) + (BigInt(res[base + 4]) << 128n);
            const lastUpdated = Number(BigInt(res[base + 5]));
            balances.push({ token, balance, contract_balance: contractBalance, last_updated: lastUpdated });
        }
        const tvBase = 1 + n * 6;
        const totalValueUsd = BigInt(res[tvBase]) + (BigInt(res[tvBase + 1]) << 128n);
        return { balances, totalValueUsd };
    }

    async getTransactionSummary(startTs, endTs, offset = 0, limit = 50) {
        const res = await this._view('get_transaction_summary', [startTs, endTs, offset, limit]);
        return {
            totalSpent: res[0],
            totalReceived: res[1],
            totalCashbackEarned: res[2],
            totalSwapFeesPaid: res[3],
            totalTxFeesCharged: res[4],
            transactionCount: Number(res[5]),
            uniqueMerchants: Number(res[6]),
            transactions: res[7],
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // K. CHARGE PREPARATION
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Prepare all the info needed before calling chargeCard().
     * Replicates the contract's _determine_source_token logic off-chain.
     */
    async prepareCharge(requestId) {
        const [request, balanceSummary, paymentModeRaw] = await Promise.all([
            this.getRequestDetails(requestId),
            this.getBalanceSummary(),
            this.getPaymentMode(),
        ]);

        const merchantToken = normalizeAddress(request.merchantToken || request.merchant_token);
        const amount = BigInt(request.amount.toString());

        const balMap = {};
        for (const b of balanceSummary.balances) {
            balMap[normalizeAddress(b.token)] = BigInt(b.balance.toString());
        }

        let modeStr = 'AnyAcceptedToken';
        if (paymentModeRaw !== undefined && paymentModeRaw !== null) {
            if (typeof paymentModeRaw === 'bigint' || typeof paymentModeRaw === 'number') {
                const idx = Number(paymentModeRaw);
                if (idx === 1) modeStr = 'MerchantTokenOnly';
                if (idx === 2) modeStr = 'AnyAcceptedToken';
            } else if (typeof paymentModeRaw === 'string') {
                modeStr = paymentModeRaw;
            } else if (paymentModeRaw.activeVariant) {
                modeStr = paymentModeRaw.activeVariant;
            } else if (typeof paymentModeRaw === 'object') {
                const keys = Object.keys(paymentModeRaw).filter(k => !['variant', 'activeVariant'].includes(k));
                if (keys.length) modeStr = keys[0];
            }
        }

        let sourceToken = merchantToken;
        const directBalance = balMap[merchantToken] || 0n;

        if (modeStr !== 'MerchantTokenOnly' && directBalance < amount) {
            const currencies = await this.getAcceptedCurrencies();
            const alt = currencies.find(t => (balMap[normalizeAddress(t)] || 0n) > 0n);
            if (alt) sourceToken = normalizeAddress(alt);
        }

        return {
            request,
            merchantToken,
            sourceToken,
            swapNeeded: sourceToken !== merchantToken,
            sourceBalance: balMap[sourceToken] || 0n,
            balances: balanceSummary.balances,
            paymentMode: modeStr,
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // L. BALANCES & STATS
    // ──────────────────────────────────────────────────────────────────────────

    async getFormattedCardBalances() {
        const cacheKey = `balances:${this.cardAddress}`;
        const cached = await redis.get(cacheKey);
        //if (cached) return JSON.parse(cached);

        const summary = await this.getBalanceSummary();
        const livePrices = await priceOracle.fetchLivePrices();

        let totalUsd = 0;
        const tokens = [];

        for (const item of summary.balances) {
            const normAddr = normalizeAddress(item.token);
            const tokenMeta = this._resolveTokenByAddress(normAddr);
            const symbol = tokenMeta?.symbol ?? 'UNKNOWN';
            const price = livePrices[symbol] ?? 0;

            const amt = Amount.fromRaw(BigInt(item.balance.toString()), tokenMeta ?? { decimals: 18, symbol });
            const decBalance = parseFloat(amt.toUnit());
            const usdValue = decBalance * price;

            totalUsd += usdValue;
            tokens.push({
                address: normAddr,
                symbol,
                balance: amt.toFormatted(true),
                balanceRaw: item.balance.toString(),
                usdValue: usdValue.toFixed(2),
                pricePerToken: price,
                lastUpdated: Number(item.last_updated),
            });
        }

        const result = { totalUsd: totalUsd.toFixed(2), tokens };
        await redis.set(cacheKey, JSON.stringify(result), 3600);
        return result;
    }

    async getComprehensiveStats() {
        const cacheKey = `comprehensive_stats_${this.cardAddress}`;
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const info = await this.getCardInfo();

        const stats = {
            total_merchants: Number(info.totalMerchants || 0),
            total_transactions: Number(info.totalTransactions || 0),
            total_requests_submitted: 0,
            total_approved_requests: 0,
            total_pending_requests: 0,
            total_rejected_requests: 0,
            total_cancelled_requests: 0,
            total_settled_requests: 0,
            total_active_recurring_payments: 0,
            total_inactive_recurring_payments: 0,
            total_transfers_made: 0,
            total_pending_transfers: 0,
            total_cancelled_transfers: 0,
            total_spent_usd: '0.00',
        };

        const spentPerToken = {};
        let offset = 0;

        while (true) {
            const batch = await this.getTransactions(offset, 100);
            if (!batch || batch.length === 0) break;

            for (const req of batch) {
                const reqId = Number(req.request_id || req.requestId);
                if (reqId === 0) continue;
                stats.total_requests_submitted++;

                const statusKey = req.status?.variant ? Object.keys(req.status.variant)[0] : req.status;
                const isRecurring = Boolean(req.is_recurring || req.isRecurring);

                if (statusKey === 'Pending') stats.total_pending_requests++;
                else if (statusKey === 'Approved'
                    || statusKey === 'AwaitingSettlement') stats.total_approved_requests++;
                else if (statusKey === 'Rejected') stats.total_rejected_requests++;
                else if (statusKey === 'Cancelled'
                    || statusKey === 'Revoked') stats.total_cancelled_requests++;
                else if (statusKey === 'Settled') {
                    stats.total_settled_requests++;
                    const addr = normalizeAddress(req.token || req.merchantToken);
                    const amt = BigInt(req.amount.toString());
                    spentPerToken[addr] = (spentPerToken[addr] || 0n) + amt;
                }

                if (isRecurring) {
                    if (['Approved', 'AwaitingSettlement'].includes(statusKey)) {
                        stats.total_active_recurring_payments++;
                    } else if (['Cancelled', 'Revoked', 'Rejected'].includes(statusKey)) {
                        stats.total_inactive_recurring_payments++;
                    }
                }
            }

            if (batch.length < 100) break;
            offset += 100;
        }

        const livePrices = await priceOracle.fetchLivePrices();
        const tokenDecimals = { ETH: 18, STRK: 18, USDC: 6, USDT: 6, DAI: 18, WBTC: 8, LORDS: 18, WSTETH: 18 };
        const networkTokens = StarknetConfig.resolveTokens(this.isLive);

        const addressToToken = {};
        for (const [sym, addr] of Object.entries(networkTokens)) {
            if (addr) addressToToken[normalizeAddress(addr)] = { symbol: sym, decimals: tokenDecimals[sym] || 18 };
        }

        let totalSpentUsd = 0;
        for (const [address, rawAmount] of Object.entries(spentPerToken)) {
            const meta = addressToToken[address] || { symbol: 'UNKNOWN', decimals: 18 };
            const price = livePrices[meta.symbol] || 0;
            const decimal = Number(rawAmount) / (10 ** meta.decimals);
            totalSpentUsd += decimal * price;
        }

        stats.total_spent_usd = totalSpentUsd.toFixed(2);
        await redis.set(cacheKey, JSON.stringify(stats), 3600);
        return stats;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // STAKING — powered by Starkzap SDK
    // ──────────────────────────────────────────────────────────────────────────

    async getStakeableTokens() {
        return this.sdk.stakingTokens();
    }

    /** List all known validator presets for this network. */
    getValidators() {
        const presets = this.isLive ? mainnetValidators : sepoliaValidators;
        return Object.values(presets).map(v => ({
            name: v.name,
            stakerAddress: v.stakerAddress,
        }));
    }

    async getStakerPools(stakerAddress) {
        return this.sdk.getStakerPools(stakerAddress);
    }

    async enterStakingPool(poolAddress, tokenAddress, amountHuman, callerAccount, feeMode = 'user_pays') {
        const wallet = await this._connectCallerWallet(callerAccount, feeMode);
        const token = this._resolveTokenByAddress(tokenAddress);
        const tx = await wallet.enterPool(fromAddress(poolAddress), Amount.parse(amountHuman, token));
        await tx.wait();
        return { txHash: tx.hash, explorerUrl: tx.explorerUrl };
    }

    async addToStakingPool(poolAddress, tokenAddress, amountHuman, callerAccount, feeMode = 'user_pays') {
        const wallet = await this._connectCallerWallet(callerAccount, feeMode);
        const token = this._resolveTokenByAddress(tokenAddress);
        const tx = await wallet.addToPool(fromAddress(poolAddress), Amount.parse(amountHuman, token));
        await tx.wait();
        return { txHash: tx.hash, explorerUrl: tx.explorerUrl };
    }

    async stake(poolAddress, tokenAddress, amountHuman, callerAccount, feeMode = 'user_pays') {
        const wallet = await this._connectCallerWallet(callerAccount, feeMode);
        const token = this._resolveTokenByAddress(tokenAddress);
        const tx = await wallet.stake(fromAddress(poolAddress), Amount.parse(amountHuman, token));
        await tx.wait();
        return { txHash: tx.hash, explorerUrl: tx.explorerUrl };
    }

    async claimStakingRewards(poolAddress, callerAccount, feeMode = 'user_pays') {
        const wallet = await this._connectCallerWallet(callerAccount, feeMode);
        const position = await wallet.getPoolPosition(fromAddress(poolAddress));

        if (!position || position.rewards.isZero()) {
            return { claimed: false, reason: 'No rewards available' };
        }

        const tx = await wallet.claimPoolRewards(fromAddress(poolAddress));
        await tx.wait();
        return {
            claimed: true,
            rewards: position.rewards.toFormatted(),
            txHash: tx.hash,
            explorerUrl: tx.explorerUrl,
        };
    }

    async exitStakingPoolIntent(poolAddress, tokenAddress, amountHuman, callerAccount, feeMode = 'user_pays') {
        const wallet = await this._connectCallerWallet(callerAccount, feeMode);
        const token = this._resolveTokenByAddress(tokenAddress);
        const tx = await wallet.exitPoolIntent(fromAddress(poolAddress), Amount.parse(amountHuman, token));
        await tx.wait();
        return { txHash: tx.hash, explorerUrl: tx.explorerUrl };
    }

    async exitStakingPool(poolAddress, callerAccount, feeMode = 'user_pays') {
        const wallet = await this._connectCallerWallet(callerAccount, feeMode);
        const position = await wallet.getPoolPosition(fromAddress(poolAddress));

        if (!position?.unpoolTime) {
            return { exited: false, reason: 'No pending exit. Call exitStakingPoolIntent first.' };
        }

        if (new Date() < position.unpoolTime) {
            return {
                exited: false,
                reason: `Exit window not reached yet. Available at: ${position.unpoolTime.toISOString()}`,
                unpoolTime: position.unpoolTime,
            };
        }

        const tx = await wallet.exitPool(fromAddress(poolAddress));
        await tx.wait();
        return { exited: true, txHash: tx.hash, explorerUrl: tx.explorerUrl };
    }

    /**
     * Transfer tokens from the relayer wallet back to the card contract address.
     *
     * This is the final step of the return fund flow after staking:
     *
     *   exitStakingPoolIntent()  [start unbonding]
     *   exitStakingPool()        [tokens land in relayer wallet]
     *   ─→ returnFundsToCard()   [ERC-20 transfer: relayer → card contract]
     *
     * The relayer wallet must have received the tokens from exitStakingPool()
     * before this is called.
     *
     * @param {string} tokenAddress    — ERC-20 token contract address
     * @param {string} amountHuman     — Human-readable amount, e.g. "10.5"
     * @param {string} cardAddress     — Destination card contract address
     * @param {string} callerAccount   — Relayer account (address or private-key pair)
     * @param {string} [feeMode]       — Fee payment mode (default: 'relayer_pays')
     * @returns {Promise<{txHash:string, explorerUrl:string}>}
     */
    async returnFundsToCard(tokenAddress, amountHuman, cardAddress, callerAccount, feeMode = 'relayer_pays') {
        const wallet = await this._connectCallerWallet(callerAccount, feeMode);
        const token = this._resolveTokenByAddress(tokenAddress);

        const tx = await wallet
            .tx()
            .transfer(token, [{
                to: fromAddress(cardAddress),
                amount: Amount.parse(amountHuman, token)
            }])
            .send({ feeMode });

        await tx.wait();
        return { txHash: tx.hash, explorerUrl: tx.explorerUrl };
    }

    async getStakingPosition(poolAddress, callerAccount) {
        const wallet = await this._connectCallerWallet(callerAccount);
        const position = await wallet.getPoolPosition(fromAddress(poolAddress));

        if (!position) return null;

        return {
            staked: position.staked.toFormatted(),
            rewards: position.rewards.toFormatted(),
            total: position.total.toFormatted(),
            unpooling: position.unpooling.toFormatted(),
            unpoolTime: position.unpoolTime ?? null,
            commissionPercent: position.commissionPercent,
            hasRewards: !position.rewards.isZero(),
            canExit: position.unpoolTime ? new Date() >= position.unpoolTime : false,
            raw: {
                staked: position.staked.toBase().toString(),
                rewards: position.rewards.toBase().toString(),
                total: position.total.toBase().toString(),
            },
        };
    }

    async isPoolMember(poolAddress, callerAccount) {
        const wallet = await this._connectCallerWallet(callerAccount);
        return wallet.isPoolMember(fromAddress(poolAddress));
    }

    async getPoolCommission(poolAddress) {
        const wallet = await this._getRelayerWallet();
        return wallet.getPoolCommission(fromAddress(poolAddress));
    }

    async transferAndStake(poolAddress, tokenAddress, stakeAmount, recipientAddress, transferAmount, callerAccount, feeMode = 'user_pays') {
        const wallet = await this._connectCallerWallet(callerAccount, feeMode);
        const token = this._resolveTokenByAddress(tokenAddress);

        let builder = wallet.tx();

        if (recipientAddress && transferAmount) {
            builder = builder.transfer(token, [{
                to: fromAddress(recipientAddress),
                amount: Amount.parse(transferAmount, token),
            }]);
        }

        builder = builder.stake(fromAddress(poolAddress), Amount.parse(stakeAmount, token));

        const tx = await builder.send({ feeMode });
        await tx.wait();
        return { txHash: tx.hash, explorerUrl: tx.explorerUrl };
    }

    /**
     * Single point of StarkZap SDK construction.
     *
     * @param {boolean} isLive
     * @param {object}  [opts]
     * @param {string}  [opts.rpcUrl]          — custom RPC endpoint
     * @param {string}  [opts.paymasterUrl]    — AVNU paymaster URL
     * @param {string}  [opts.paymasterApiKey] — AVNU paymaster API key
     * @returns {StarkZap}
     */
    static _makeSdk(isLive, { rpcUrl, paymasterUrl, paymasterApiKey } = {}) {
        const config = { network: isLive ? 'mainnet' : 'sepolia' };
        if (rpcUrl) {
            config.rpcUrl = rpcUrl;
            config.chainId = isLive ? ChainId.MAINNET : ChainId.SEPOLIA;
        }
        if (paymasterUrl) {
            config.paymaster = { nodeUrl: paymasterUrl };
            if (paymasterApiKey) config.paymaster.apiKey = paymasterApiKey;
        }
        return new StarkZap(config);
    }

    /**
     * Discover staking pools without needing a card contract.
     * Uses the SDK directly for protocol-level queries (stakeable tokens,
     * validators, delegated pools). Safe to call even when the card is
     * burned or unreachable on-chain.
     *
     * @param {boolean} [isLive=true]
     * @returns {Promise<{stakeableTokens: Array, validators: Array, pools: Array}>}
     */
    async discoverStakingPools(isLive = true) {
        await _starkzapReady;
        const sdk = StarknetCardService._makeSdk(isLive);

        const stakeableTokens = await sdk.stakingTokens();
        const presets = isLive ? mainnetValidators : sepoliaValidators;
        const validators = Object.values(presets).map(v => ({
            name:          v.name,
            stakerAddress: v.stakerAddress,
        }));

        const allPools = [];
        for (const validator of validators) {
            try {
                const pools = await sdk.getStakerPools(validator.stakerAddress);
                for (const pool of (pools || [])) {
                    // pool.address may be a Starkzap Address object — extract the hex string
                    let poolAddr = pool.address || pool;
                    if (typeof poolAddr === 'object' && poolAddr !== null) {
                        poolAddr = poolAddr.address
                            || poolAddr.contract_address
                            || poolAddr.value
                            || poolAddr.hex
                            || Object.values(poolAddr).find(v => typeof v === 'string' && v.startsWith('0x'))
                            || null;
                    }
                    if (typeof poolAddr !== 'string') {
                        poolAddr = poolAddr?.toString?.() || null;
                    }
                    // Normalize to hex string
                    if (poolAddr && !poolAddr.startsWith('0x')) {
                        try { poolAddr = '0x' + BigInt(poolAddr).toString(16); } catch { poolAddr = null; }
                    }
                    if (!poolAddr) continue;

                    allPools.push({
                        pool_address:      poolAddr,
                        validator_name:    validator.name,
                        validator_address: validator.stakerAddress,
                    });
                }
            } catch (_) { /* skip unreachable validator */ }
        }

        return { stakeableTokens, validators, pools: allPools };
    }

    /**
     * Register a user so they may deploy their own cards via create_card.
     * Must be called by the relayer. `isLive` defaults to true.
     */
    static async registerUser(userAddress, isLive = true) {
        return StarknetCardService._factoryRelayerCall('register_user', [userAddress], isLive);
    }

    /** Revoke a previously registered user. Relayer-only. */
    static async deregisterUser(userAddress, isLive = true) {
        return StarknetCardService._factoryRelayerCall('deregister_user', [userAddress], isLive);
    }

    /** Check whether an address is registered to deploy cards. */
    static async isRegisteredUser(userAddress, isLive = true) {
        return StarknetCardService._factoryView('is_registered_user', [userAddress], isLive);
    }

    /** Internal: execute a write call on the factory contract using the relayer wallet. */
    static async _factoryRelayerCall(entrypoint, calldata, isLive = true) {
        const netConfig = StarknetConfig.resolve(isLive);
        const networkLabel = StarknetConfig.networkLabel(isLive);
        const { factoryAddress: factoryAddr, relayerAddress: relayerAddr, relayerPrivateKey: relayerPk } = netConfig;
        if (!factoryAddr) return { success: false, error: `${networkLabel}_FACTORY_CONTRACT_ADDRESS not configured` };
        if (!relayerAddr || !relayerPk) return { success: false, error: `${networkLabel} relayer credentials not configured` };
        const sdk = StarknetCardService._makeSdk(isLive);
        const relayerWallet = await Wallet.create({
            account: { signer: new StarkSigner(relayerPk) },
            accountAddress: relayerAddr,
            provider: sdk.provider,
            config: sdk.config,
        });
        const tx = await relayerWallet.execute([{ contractAddress: factoryAddr, entrypoint, calldata: CallData.compile(calldata) }]);
        await tx.wait();
        return { success: true, txHash: tx.hash };
    }

    /** Internal: execute a view call on the factory contract. */
    static async _factoryView(entrypoint, calldata, isLive = true) {
        const netConfig = StarknetConfig.resolve(isLive);
        const { factoryAddress: factoryAddr } = netConfig;
        const sdk = StarknetCardService._makeSdk(isLive);
        const provider = sdk.getProvider();
        return provider.callContract({ contractAddress: factoryAddr, entrypoint, calldata: CallData.compile(calldata) });
    }

    static async deployCard(cardData) {
        await _starkzapReady;
        const isLive = cardData.is_live !== undefined ? cardData.is_live : true;
        const netConfig = StarknetConfig.resolve(isLive);
        const networkLabel = StarknetConfig.networkLabel(isLive);

        const factoryAddr = netConfig.factoryAddress;
        const relayerAddr = netConfig.relayerAddress;
        const relayerPk = netConfig.relayerPrivateKey;

        if (!factoryAddr) return { success: false, error: `${networkLabel}_FACTORY_CONTRACT_ADDRESS not configured` };
        if (!relayerAddr) return { success: false, error: `${networkLabel}_RELAYER_ACCOUNT_ADDRESS not configured` };
        if (!relayerPk) return { success: false, error: `${networkLabel}_RELAYER_PRIVATE_KEY not configured` };

        // Let Starkzap use its built-in RPC; only paymaster needs config
        const sdk = StarknetCardService._makeSdk(isLive, {
            paymasterUrl: netConfig.paymasterUrl,
            paymasterApiKey: netConfig.paymasterApiKey,
        });

        const relayerWallet = await Wallet.create({
            account: { signer: new StarkSigner(relayerPk) },
            accountAddress: relayerAddr,
            provider: sdk.provider,
            config: sdk.config,
        });

        try {
            const provider = sdk.getProvider();
            const abiCacheKey = `${ABI_KEY_PREFIX}factory_v5:${factoryAddr}`;
            let factoryAbi = await redis.get(abiCacheKey);
            if (!factoryAbi) {
                const factoryClass = await provider.getClassAt(factoryAddr);
                factoryAbi = typeof factoryClass.abi === 'string'
                    ? JSON.parse(factoryClass.abi)
                    : factoryClass.abi;
                await redis.set(abiCacheKey, factoryAbi, ABI_CACHE_TTL);
            }

            const currencyAddresses = StarknetCardService.resolveCurrencyAddresses(cardData.currencies || [], isLive);
            if (!currencyAddresses.length) return { success: false, error: 'No valid currencies resolved' };

            const paymentModeVariant = new CairoCustomEnum({
                [cardData.payment_mode || 'MerchantTokenOnly']: {},
            });

            const maxTxU256 = StarknetCardService.usdToU256(cardData.max_transaction_amount || 0);
            const dailySpndU256 = StarknetCardService.usdToU256(cardData.daily_spend_limit || 0);

            const relayerForCard = cardData.is_live
                ? process.env.RELAYER_ACCOUNT_ADDRESS
                : process.env.TESTNET_RELAYER_ACCOUNT_ADDRESS;

            let pinPublicKey = cardData.pin_public_key;
            if (typeof pinPublicKey === 'string') {
                pinPublicKey = pinPublicKey.toLowerCase().startsWith('0x')
                    ? pinPublicKey
                    : '0x' + pinPublicKey;
                pinPublicKey = num.toHex(BigInt(pinPublicKey));
            } else if (typeof pinPublicKey === 'number' || typeof pinPublicKey === 'bigint') {
                pinPublicKey = num.toHex(BigInt(pinPublicKey));
            }

            if (pinPublicKey.length < 10) {
                return { success: false, error: 'Invalid pin public key length' };
            }

            const call = {
                contractAddress: factoryAddr,
                entrypoint: 'create_card',
                calldata: CallData.compile([
                    cardData.wallet,
                    relayerForCard,
                    pinPublicKey,
                    currencyAddresses,
                    paymentModeVariant,
                    {
                        max_transaction_amount: maxTxU256,
                        daily_transaction_limit: parseInt(cardData.daily_transaction_limit) || 50,
                        daily_spend_limit: dailySpndU256,
                        slippage_tolerance_bps: parseInt(cardData.slippage_tolerance_bps) || 50,
                        transfer_delay: cardData.transfer_delay !== undefined ? parseInt(cardData.transfer_delay) : 86400,
                    },
                ]),
            };

            console.log(`[StarknetCardService] Deploying card ${cardData.card_id} on ${networkLabel}…`);

            const tx = await relayerWallet.execute([call]);
            await tx.wait();
            const receipt = await tx.receipt();

            const execStatus = receipt.execution_status ?? receipt.executionStatus;
            if (execStatus && execStatus !== 'SUCCEEDED') {
                const revertReason = receipt.revert_reason ?? receipt.revertReason ?? 'unknown';
                console.error(`[StarknetCardService] Transaction reverted: ${revertReason}`);
                return {
                    success: false,
                    error: `Transaction reverted on-chain: ${revertReason}`,
                    transaction_hash: tx.hash,
                    explorerUrl: tx.explorerUrl,
                    execution_status: execStatus,
                };
            }

            let contractAddress = null;
            if (receipt.events && receipt.events.length > 0) {
                try {
                    const factory = new Contract(factoryAbi, factoryAddr, provider);
                    const parsedEvents = factory.parseEvents(receipt);
                    for (const parsed of parsedEvents) {
                        const eventData = parsed.CardCreated || parsed['ZionDefiFactory::CardCreated'];
                        if (eventData && eventData.card_address) {
                            contractAddress = '0x' + BigInt(eventData.card_address).toString(16);
                            break;
                        }
                    }
                } catch (e) {
                    console.warn('[StarknetCardService] ABI parse failed, falling back to manual extraction');
                }

                if (!contractAddress) {
                    for (const event of receipt.events) {
                        const fromAddr = event.from_address ? '0x' + BigInt(event.from_address).toString(16).toLowerCase() : null;
                        const factoryNorm = '0x' + BigInt(factoryAddr).toString(16).toLowerCase();

                        if (fromAddr === factoryNorm) {
                            const searchSpace = [
                                ...(event.keys ? event.keys.slice(1) : []),
                                ...(event.data || []),
                            ];
                            for (const val of searchSpace) {
                                const hexStr = BigInt(val).toString(16);
                                if (hexStr.length > 40) {
                                    contractAddress = '0x' + hexStr;
                                    break;
                                }
                            }
                            if (contractAddress) break;
                        }
                    }
                }
            }

            if (!contractAddress) {
                console.error('[StarknetCardService] CardCreated event not found in receipt');
                return {
                    success: false,
                    error: 'Deployment succeeded but CardCreated event was not found — check factory ABI',
                    transaction_hash: tx.hash,
                    explorerUrl: tx.explorerUrl,
                };
            }

            const actualFee = receipt.actual_fee;
            const feeAmountRaw = BigInt(actualFee?.amount ?? actualFee ?? '0');
            const feeUnit = actualFee?.unit ?? 'FRI';

            let gasFeeStrk = 0;
            let gasFeeUsd = '0.00';

            try {
                gasFeeStrk = Number(feeAmountRaw) / 1e18;
                const prices = await priceOracle.fetchLivePrices();
                const strkUsd = prices['STRK'] ?? 0;
                gasFeeUsd = (gasFeeStrk * strkUsd).toFixed(6);
            } catch (_) { /* price fetch failure is non-fatal */ }

            const gasFee = {
                amount: feeAmountRaw.toString(),
                unit: feeUnit,
                strk: gasFeeStrk.toFixed(8),
                usd: gasFeeUsd,
            };

            console.log(`[StarknetCardService] Card deployed: ${contractAddress}`);
            console.log(`[StarknetCardService] Gas paid: ${gasFee.strk} STRK (~$${gasFee.usd})`);
            console.log(`[StarknetCardService] Explorer: ${tx.explorerUrl}`);

            return {
                success: true,
                contract_address: contractAddress,
                transaction_hash: tx.hash,
                explorerUrl: tx.explorerUrl,
                execution_status: execStatus ?? 'SUCCEEDED',
                gas: gasFee,
            };

        } catch (err) {
            console.error('[StarknetCardService] Deploy error:', err);
            return { success: false, error: err.message || 'Unknown deployment error' };
        }
    }


    static generateIdempotencyKey() {
        const bytes = require('crypto').randomBytes(31);
        return '0x' + bytes.toString('hex');
    }

    static buildQuote(q) {
        return {
            sell_token_address: q.sellTokenAddress,
            buy_token_address: q.buyTokenAddress,
            sell_amount: uint256.bnToUint256(BigInt(q.sellAmount)),
            buy_amount: uint256.bnToUint256(BigInt(q.buyAmount)),
            price_impact: uint256.bnToUint256(BigInt(q.priceImpact || 0)),
            fee: {
                fee_token: q.fee?.feeToken || q.sellTokenAddress,
                avnu_fees: uint256.bnToUint256(BigInt(q.fee?.avnuFees || 0)),
                avnu_fees_bps: q.fee?.avnuFeesBps || 0,
                integrator_fees: uint256.bnToUint256(BigInt(q.fee?.integratorFees || 0)),
                integrator_fees_bps: q.fee?.integratorFeesBps || 0,
            },
            routes: q.routes || [],
        };
    }

    static usdToU256(dollars) {
        const scaled = BigInt(Math.round(parseFloat(dollars || 0) * 1e8));
        return uint256.bnToUint256(scaled);
    }

    static getCurrencyAddresses(isLive = true) {
        return StarknetConfig.resolveTokens(isLive);
    }

    static resolveCurrencyAddresses(symbols, isLive = true) {
        return StarknetConfig.resolveCurrencyAddresses(symbols, isLive);
    }

    async getTransferEvents(fromBlock, toBlock = null, prices = null) {
        const TRANSFER_KEY = hash.getSelectorFromName('Transfer');
        const normCard = normalizeAddress(this.cardAddress);

        const latestBlock = await this.provider.getBlock('latest');
        const toBlockNum = toBlock ?? latestBlock.block_number;

        if (fromBlock > toBlockNum) {
            return { credits: [], debits: [], fromBlock, toBlock: toBlockNum };
        }

        if (!prices) {
            const oracle = new priceOracle();
            prices = await oracle.fetchLivePrices().catch(() => ({}));
        }

        const tokenConfig = StarknetConfig.resolveTokens(this.isLive);
        const tokenEntries = Object.entries(tokenConfig)
            .filter(([, addr]) => !!addr)
            .map(([symbol, addr]) => ({ symbol, address: normalizeAddress(addr) }));

        const credits = [];
        const debits = [];

        for (const tok of tokenEntries) {
            if (!tok.address) continue;
            const all = await this._fetchEvents({
                tokenAddress: tok.address,
                tokenSymbol: tok.symbol,
                keys: [[TRANSFER_KEY]],
                fromBlock,
                toBlock: toBlockNum,
                prices,
            });

            for (const ev of all) {
                if (ev.to_address === normCard) credits.push({ ...ev, type: 'credit' });
                else if (ev.from_address === normCard) debits.push({ ...ev, type: 'debit' });
            }

            await new Promise(r => setTimeout(r, 150));
        }

        return { credits, debits, fromBlock, toBlock: toBlockNum };
    }

    async _fetchEvents({ tokenAddress, tokenSymbol, keys, fromBlock, toBlock, prices }) {
        const MAX_PAGES = 5;
        const CHUNK_SIZE = 100;
        const results = [];
        let continuation;
        let page = 0;

        const tokenObj = this._resolveTokenByAddress(tokenAddress);
        const decimals = tokenObj.decimals ?? 18;
        const price = prices[tokenSymbol] ||
            prices[tokenSymbol.toLowerCase()] ||
            prices[tokenSymbol.toUpperCase()] || 0;

        do {
            const params = {
                address: tokenAddress,
                keys,
                from_block: { block_number: fromBlock },
                to_block: { block_number: toBlock },
                chunk_size: CHUNK_SIZE,
            };
            if (continuation) params.continuation_token = continuation;

            let response;
            try {
                response = await this.provider.getEvents(params);
            } catch (_) {
                break;
            }

            for (const ev of (response?.events || [])) {
                const fromAddr = normalizeAddress(ev.keys?.[1]);
                const toAddr = normalizeAddress(ev.keys?.[2]);

                if (!fromAddr || !toAddr) continue;

                const amtLow = BigInt(ev.data?.[0] || '0x0');
                const amtHigh = BigInt(ev.data?.[1] || '0x0');
                const rawBig = amtLow + (amtHigh << 128n);
                const amtHuman = Number(rawBig) / (10 ** decimals);
                const amtUsd = amtHuman * price;

                results.push({
                    tx_hash: ev.transaction_hash,
                    block_number: ev.block_number,
                    event_index: ev.event_index ?? null,
                    block_hash: ev.block_hash ?? null,
                    token_address: tokenAddress,
                    token_symbol: tokenSymbol,
                    decimals,
                    from_address: fromAddr,
                    to_address: toAddr,
                    amount_raw: rawBig.toString(),
                    amount_human: amtHuman,
                    amount_usd: amtUsd,
                    price_usd: price,
                });
            }

            continuation = response?.continuation_token;
            page++;
        } while (continuation && page < MAX_PAGES);

        return results;
    }


    /**
     * Look up a Starkzap Token object by contract address.
     * Falls back to a minimal synthetic token if not found in presets.
     */
    _resolveTokenByAddress(address) {
        const normAddr = normalizeAddress(address);
        for (const token of Object.values(this.tokens)) {
            if (normalizeAddress(token.address.toString()) === normAddr) {
                return token;
            }
        }
        // Synthetic fallback (decimals unknown — caller should override)
        return { decimals: 18, symbol: 'UNKNOWN', address };
    }
}

module.exports = StarknetCardService;