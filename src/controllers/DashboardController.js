const DateHelper = require('../utils/DateHelper');
const EncryptionService = require('../services/EncryptionService');
const Layerswap = require('../utils/Layerswap');
const StarknetCardService = require('../services/StarknetCardService');
const qrcode = require('qrcode');
const RabbitService = require('../services/RabbitService');
const PriceOracle = require('../utils/PriceOracle');

// Module-scoped holder so the YieldAgent instance can be reused across methods
let yieldAgentInstance = null;
module.exports = {

    index: async (req, reply) => {
        const userId = req.user.user_id;
        let is_live = (req.user && req.user.is_live === true) ? 'checked' : '';

        const card = await req.apiService.getCardByUser(userId);
        if (!card) {
            return reply.view('home/start.ejs', {
                app_name: process.env.APP_NAME || 'ZionDefi',
                title: req.t('dashboard.title', { app_name: process.env.APP_NAME }),
                root: '/',
                user: req.user,
                is_live: is_live
            });
        }

        const agentRecord = await req.agent.findByCard(userId, card.card_id);

        if(agentRecord !== null && agentRecord.enabled){
            await RabbitService.publish('agent.enable', {
                agent_id: agentRecord.agent_id,
                agent_name: agentRecord.name,
                card_id: card.card_id,
                owner_user_id: userId,
                card_address: card.address,
                is_live: req.user.is_live
            });
        }

        return reply.view('home/index.ejs', {
            app_name: process.env.APP_NAME || 'ZionDefi',
            title: req.t('dashboard.title', { app_name: process.env.APP_NAME }),
            root: '/',
            user: req.user,
            is_live: is_live,
            card: card,
            isFailed: card.status === 'failed'
        });
    },

    toggleLive: async (req, reply) => {
        try {
            const { live } = req.body;
            const userId = req.user.user_id;

            const isLive = (live === true || live === 'true');
            if(isLive){
                 return reply.code(402).send({ status: 402, error: 'Sorry live mode cannot be activated until smart contract audit completes. We will let you know once audit completes. Thank you.' });
            }

            await req.models.User.updateOne(
                { user_id: userId },
                { $set: { is_live: isLive } }
            );

            if (req.session) {
                req.session.user.is_live = isLive;
            }

            return reply.send({ 
                status: 200, 
                message: 'Mode updated successfully', 
                is_live: JSON.stringify(req.body)
            });
        } catch (err) {
            req.log.error(err);
            return reply.code(500).send({ status: 500, error: 'Failed to update mode' });
        }
    },

    homeview: async (req, reply) => {
        try {
            const userId = req.user.user_id;
            const isLive = req.user.is_live;
            const mode   = isLive ? 'live' : 'sandbox';

            const card = await req.apiService.getCardByUser(userId);
            if (!card || !card.address) {
                return reply.send({ status: 200, mode, balances: {}, stakes: {}, stats: {} });
            }

            let balances = {};
            let stakes   = { positions: [], total_staked_usd: 0, total_yield_usd: 0 };
            let stats    = {};

            const [balancesResult, stakePositions, tokenPrices, txCount] = await Promise.all([
                StarknetCardService.create({ cardAddress: card.address, isLive })
                    .then(svc => svc.getFormattedCardBalances())
                    .catch(err => { req.log.warn({ err }, 'homeview: could not fetch card balances'); return {}; }),

                // Query active stake positions for this card
                req.stakePosition.getActiveStakes(card.address)
                    .catch(err => { req.log.warn({ err }, 'homeview: could not fetch stake positions'); return []; }),

                PriceOracle.fetchLivePrices()
                .catch(err => { req.log.warn({ err }, 'homeview: could not fetch prices'); return {}; }),

                req.models.Transactions.count({ user_id: userId }).catch(() => 0)
            ]);

            balances = balancesResult || {};
           
            // Aggregate staking totals from stake_positions collection
            let totalStakedUsd = 0;
            let totalYieldUsd  = 0;
            const formattedPositions = [];

            for (const pos of (stakePositions || [])) {
                const tokenPrice = tokenPrices[pos.token_symbol] || 1.0;
                const stakedUsd = pos.amount_staked * tokenPrice;
                const yieldUsd = pos.total_rewards_claimed * tokenPrice;

                totalStakedUsd += stakedUsd;
                totalYieldUsd += yieldUsd;

                formattedPositions.push({
                    stake_id: pos.stake_id,
                    pool_address: pos.pool_address,
                    token_symbol: pos.token_symbol,
                    validator_name: pos.validator_name,
                    amount_staked: pos.amount_staked,
                    staked_amount_usd: stakedUsd,
                    total_rewards_claimed: pos.total_rewards_claimed,
                    yield_earned_usd: yieldUsd,
                    last_compounded_at: pos.last_compounded_at,
                    staked_at: pos.staked_at,
                    tx_hash: pos.tx_hash,
                    explorer_url: pos.explorer_url,
                });
            }

            stakes = {
                positions: formattedPositions,
                total_staked_usd: totalStakedUsd,
                total_yield_usd: totalYieldUsd
            };

            // Check if yield agent is active
            const yieldAgent = await req.models.Agent
                .findOne({ owner_user_id: userId, name: 'zara', enabled: true })
                .catch(() => null);
            

            

            stats = {
                total_transactions: txCount,
                agent_active: !!yieldAgent
            };

            return reply.send({ status: 200, mode, balances, stakes, stats });

        } catch (err) {
            req.log.error(err);
            return reply.code(500).send({ error: 'Failed to load dashboard data' });
        }
    },

    getZaraLogs: async (req, reply) => {
        try {
            const userId = req.user.user_id;
            const page = parseInt(req.page) || 1;
            const limit = parseInt(req.limit) || 20;
            const skip = (page - 1) * limit;

            const [data, total] = await Promise.all([
                req.models.AgentLogs.findAll(
                    { owner_user_id: userId, agent_name: 'zara' },
                    { sort: { created_at: -1 }, skip, limit }
                ),
                req.models.AgentLogs.count({ owner_user_id: userId, agent_name: 'zara' })
            ]);

            const date = new DateHelper();

            const totalPages = Math.ceil(total / limit);
            const viewData = (data || []).map(d => ({
                log_id: d.log_id,
                event_type: d.event_type,
                action: d.action,
                summary: d.description.replace('Nova', 'Zara') || null,
                status: d.status || 'info',
                created_at: date.formatDateFromTimestamp(d.created_at, 'dd MMM YYYY HH:mm:ss')
            }));

            return reply.send({
                status: 200,
                data: viewData,
                meta: {
                    current_page: page,
                    per_page: limit,
                    total_results: total,
                    total_pages: totalPages,
                    has_more: page < totalPages
                }
            });
        } catch (err) {
            req.log.error(err);
            return reply.code(500).send({ status: 500, error: 'Failed to load Zara logs' });
        }
    },

    getTransactions: async (req, reply) => {
        try {
            const page  = parseInt(req.query.page)  || 1;
            const limit = parseInt(req.query.limit) || 10;
            const skip  = (page - 1) * limit;
            const userId = req.user.user_id;

            const [data, total] = await Promise.all([
                req.models.Transactions.findAll(
                    { user_id: userId },
                    { sort: { created_at: -1 }, skip, limit }
                ),
                req.models.Transactions.count({ user_id: userId })
            ]);

            return reply.send({
                status: 200,
                data:   data || [],
                meta: {
                    current_page:  page,
                    per_page:      limit,
                    total_results: total,
                    total_pages:   Math.ceil(total / limit) || 0
                }
            });

        } catch (err) {
            req.log.error(err);
            return reply.status(500).send({ status: 500, error: 'Failed to fetch transactions' });
        }
    },

    showCardDepositModal: async (req, reply) => {
        try {
            const userId = req.user.user_id;
            const isLive = req.user.is_live;
            const cardId = req.postFilter.strip(req.body.card_id);
            const datehelper = new DateHelper();

            const result = await req.apiService.getCard(userId, cardId);
             if(!result){
                return reply.code(404).send({
                    status: 404,
                    error: req.t('card.card_not_found') || 'Card not found'
                });
            }

            const cardService = await StarknetCardService.create({
                cardAddress: result.address,
                isLive: isLive
            });

            const ls = new Layerswap(process.env.LAYERSWAP_API_KEY, isLive); 
            const destNetwork = isLive ? 'STARKNET_MAINNET' : 'STARKNET_SEPOLIA';
            
            let bridgeNetworks = [];
            try {
                bridgeNetworks = await ls.getSources(destNetwork); 
            } catch(e) {
                req.log.warn("Layerswap sources fetch failed:", e.message);
            }

            const networks = await ls.getSources('STARKNET_SEPOLIA', 'STRK');
            if(!result){
                return reply.code(404).send({
                    status: 404,
                    error: req.t('card.card_not_found') || 'Card not found'
                });
            }

            const qrDataUrl = await qrcode.toDataURL(result.address, {
                errorCorrectionLevel: 'H',
                width: 250,
                margin: 1,
                color: {
                    dark: ['pending_deployment', 'deploying', 'failed'].includes(result.status) ? '#64748b' : '#000000',
                    light: '#ffffff'
                }
            });

            const modalHtml = await req.server.view('modal/card_deposit.ejs', {
                t: req.t,
                user: req.user,
                cardData: result,
                qrDataUrl: qrDataUrl
            });
            return reply.send({ status: 200, modalHtml: modalHtml, modalId: 'cardDepositModal' });
            

        } catch (err) {
            req.log.error(err);
            return reply.status(500).send({ error: req.t('error.fetching_modal') });
        }

    },

    createCard: async (req, reply) => {
        try {
            const pf = req.postFilter;

            let currencies;
            try {
                currencies = JSON.parse(req.body.currencies);
                if (!Array.isArray(currencies) || currencies.length === 0) {
                    return reply.code(400).send({ status: 400, error: req.t('card.err_select_currency') || 'Select at least one currency' });
                }
            } catch (e) {
                return reply.code(400).send({ status: 400, error: 'Invalid currencies format' });
            }
            const identity = req.postFilter.getDevice(req);

            const result = await req.apiService.createCard({
                userId: req.user.user_id,
                userName: req.user.name,
                wallet: pf.strip(req.body.owner),
                walletChoice: pf.strip(req.body.wallet_choice),
                pinPublicKey: pf.strip(req.body.pin_public_key),
                currencies,
                paymentMode: pf.strip(req.body.payment_mode),
                maxTxAmount: pf.strip(req.body.max_transaction_amount),
                dailySpendLimit: pf.strip(req.body.daily_spend_limit),
                dailyTxLimit: parseInt(pf.strip(req.body.daily_transaction_limit)) || 50,
                slippageBps: parseInt(pf.strip(req.body.slippage_tolerance_bps)) || 50,
                transferDelay: req.body.transfer_delay !== undefined ? parseInt(pf.strip(req.body.transfer_delay)) : 86400,
                isLive: req.user.is_live !== false,
                device: identity
            });

            const cardHtml = await req.server.view('partials/card_creation_loader.ejs', {
                t: req.t,
                user: req.user,
            });
            return reply.send({ status: 200, cardHtml: cardHtml, card_id: result.card_id });

        } catch (err) {
            const code = err.statusCode || 500;
            req.log.error(err);
            return reply.code(code).send({
                status: code,
                error: code >= 500 ? (req.t('server_error') || 'Failed to create card') : err.message
            });
        }
    },

    /**
     * REDEPLOY CARD — delegates to CardService
     */
    redeployCard: async (req, reply) => {
        try {
            const result = await req.apiService.redeployCard({
                userId: req.user.user_id,
                cardId: req.postFilter.strip(req.body.card_id),
                isLive: req.user.is_live !== false
            });

            return reply.send({
                status: 200,
                message: req.t('card.card_requeued') || 'Card redeployment queued. It will be ready soon.',
                card_id: result.card_id
            });

        } catch (err) {
            const code = err.statusCode || 500;
            req.log.error(err);
            return reply.code(code).send({
                status: code,
                error: code >= 500 ? (req.t('card.failed_redeploy') || 'Failed to redeploy card') : err.message
            });
        }
    },

    getCard: async (req, reply) => {
        try {
            const pf = req.postFilter;
            const { id } = req.params;
            const cardId = pf.strip(id);

            const result = await req.apiService.getCard(req.user.user_id, cardId);
            if(!result){
                return reply.code(404).send({
                    status: 404,
                    error: req.t('card.card_not_found') || 'Card not found'
                });
            }
            const explorer =  (req.user.is_live) ? `${process.env.EXPLORER_URL_MAINNET}/contract/${result.address}` : `${process.env.EXPLORER_URL_SEPOLIA}/contract/${result.address}`;
            const network = (req.user.is_live) ? 'mainnet' : 'sepolia';

            const cardData = {
                ...result,
                explorer_url: explorer,
                network: network
            };

            return reply.send({
                status: 200,
                card: cardData
            });
        } catch (err) {
            const code = err.statusCode || 500;
            req.log.error(err);
            return reply.code(code).send({
                status: code,
                error: code >= 500 ? (req.t('server_error') || 'Failed to retrieve card details') : err.message
            });
        }
    },

    getCardBridgeList: async (req, reply) => {
        try {
            const pf = req.postFilter;
            const { id } = req.params;
            const cardId = pf.strip(id);
            const isLive = req.user.is_live !== false;
            const result = await req.apiService.getCard(req.user.user_id, cardId);
            if(!result){
                return reply.code(404).send({
                    status: 404,
                    error: req.t('card.card_not_found') || 'Card not found'
                });
            }

            const ls = new Layerswap(process.env.LAYERSWAP_API_KEY, isLive); 
            const destNetwork = isLive ? 'STARKNET_MAINNET' : 'STARKNET_SEPOLIA';
            let bridgeNetworks = [];

            if (isLive) {
                try {
                    bridgeNetworks = await ls.getSources(destNetwork); 
                } catch(e) {
                    req.log.warn("Layerswap sources fetch failed:", e.message);
                }
            } else {
                //Only ethereum_sepolia supported in testnet. So load that only and make sure if token is usdcs only reject that as its not supported in sepolia. 
                try {
                    const networks = await ls.getSources(destNetwork);
                    bridgeNetworks = networks.filter(n => n.name === 'ETHEREUM_SEPOLIA');
                } catch(e) {
                    req.log.warn("Layerswap sources fetch failed:", e.message);
                }
            }

            const formattedSources = [];
            bridgeNetworks.forEach(network => {
                if (network.tokens && Array.isArray(network.tokens)) {
                    network.tokens.forEach(token => {
                        if(!isLive && token.symbol === 'USDCS') {
                            return;
                        }
                        formattedSources.push({
                            network_name: network.name,
                            network_display_name: network.display_name,
                            asset: token.symbol,
                            logo: network.logo,
                            asset_logo: token.logo,
                            min_amount: token.min_amount || "0.01", 
                        });
                    });
                }
            });
            return reply.send({ status: 200, sources: formattedSources });
        } catch (err) {
            const code = err.statusCode || 500;
            req.log.error(err);
            return reply.code(code).send({
                status: code,
                error: code >= 500 ? (req.t('server_error') || 'Failed to retrieve bridge sources') : err.message
            });
        }
    },

    getBridgeQuote: async (req, reply) => {
        try {
            const pf = req.postFilter;
            const { card_id, source_network, source_token, amount } = req.body;

            const cardId = pf.strip(card_id);
            const result = await req.apiService.getCard(req.user.user_id, cardId);
            if(!result){
                return reply.code(404).send({
                    status: 404,
                    error: req.t('card.card_not_found') || 'Card not found'
                });
            }
            const isLive = req.user.is_live !== false;
            const ls = new Layerswap(process.env.LAYERSWAP_API_KEY, isLive);

            const sourceNetwork = pf.strip(source_network);
            const sourceToken = pf.strip(source_token);
            const parsedAmount = parseFloat(pf.strip(amount));

            if (!sourceNetwork || !sourceToken || !parsedAmount || parsedAmount <= 0) {
                return reply.code(400).send({ status: 400, error: 'Missing required parameters' });
            }

            const destNetwork = isLive ? 'STARKNET_MAINNET' : 'STARKNET_SEPOLIA';

            const quote = await ls.getQuote(sourceNetwork, sourceToken, destNetwork, sourceToken, parsedAmount);
            return reply.send({ status: 200, quote });
        } catch (err) {
            const code = err.statusCode || 500;
            req.log.error(err);
            return reply.code(code).send({
                status: code,
                error: err.message
            });
        }
    },

    createBridgeDeposit: async (req, reply) => {

        const pf = req.postFilter;
        const { card_id, source_network, source_token, amount, source_address } = req.body;

        try{
            const cardId = pf.strip(card_id);
            const result = await req.apiService.getCard(req.user.user_id, cardId);
            if(!result){
                return reply.code(404).send({
                    status: 404,
                    error: req.t('card.card_not_found') || 'Card not found'
                });
            }

            let sourceNetwork = pf.strip(source_network);
            let sourceToken = pf.strip(source_token);
            let sourceAddress = pf.strip(source_address);
            const parsedAmount = parseFloat(pf.strip(amount));

            if (!sourceNetwork || !sourceToken || !parsedAmount || parsedAmount <= 0 || !sourceAddress) {
                return reply.code(400).send({ status: 400, error: 'Missing required parameters' });
            }

            const isLive = req.user.is_live !== false;
            const ls = new Layerswap(process.env.LAYERSWAP_API_KEY, isLive);

            const reference_id = (new EncryptionService()).uuid();
            const swapResponse = await ls.createSwap({
                reference_id: reference_id,
                source_network: sourceNetwork,
                source_token: sourceToken,
                destination_network: isLive ? 'STARKNET_MAINNET' : 'STARKNET_SEPOLIA',
                destination_token: sourceToken,
                destination_address: result.address,
                amount: parsedAmount,
                source_address: sourceAddress
            });

            if (!swapResponse || !swapResponse.deposit_actions || swapResponse.deposit_actions.length === 0) {
                return reply.code(500).send({ status: 500, error: 'Failed to create bridge swap' });
            }

            const identity = req.postFilter.getDevice(req);

            const depositAction = swapResponse.deposit_actions[0];
            const renderData = {
                user_id: req.user.user_id,
                card_id: card_id,
                swap_id: swapResponse.swap.id,
                reference_id: reference_id,
                deposit_address: depositAction.to_address,
                deposit_amount: depositAction.amount,
                deposit_token: depositAction.token.symbol,
                network_name: depositAction.network.display_name,
                status: swapResponse.swap.status,
                received_amount: swapResponse.swap.received_amount,
                source_network: sourceNetwork,
                source_token: sourceToken,
                destination_network: isLive ? 'STARKNET_MAINNET' : 'STARKNET_SEPOLIA',
                destination_token: sourceToken,
                destination_address: result.address,
                amount: parsedAmount,
                source_address: sourceAddress,
                device: identity
            };

            await req.models.Bridge.create(renderData);

            const cardHtml = await req.server.view('partials/bridge_create.ejs', {
                t: req.t,
                app_name: process.env.APP_NAME || 'ZionDefi',
                user: req.user,
                amount: renderData.amount + ' ' + renderData.source_token,
                network: renderData.source_network,
                deposit_address: renderData.deposit_address
            });

            return reply.send({ status: 200, message: 'Bridge deposit initiated', bridge: renderData, html: cardHtml });

        } catch (err) {
            const code = err.statusCode || 500;
            req.log.error(err);
            return reply.code(code).send({
                status: code,
                error: err.message
            });
        }

    },

    getBridgeStatus: async (req, reply) => {
        const pf = req.postFilter;
        const { id } = req.params;
        const swapId = pf.strip(id);
        
        try {
            const bridgeRecord = await req.models.Bridge.retrieve(swapId);
            if(!bridgeRecord){
                return reply.code(404).send({
                    status: 404,
                    error: req.t('card.bridge_not_found') || 'Bridge not found'
                });
            }

            const isLive = req.user.is_live !== false;
            const ls = new Layerswap(process.env.LAYERSWAP_API_KEY, isLive);

            const swapResponse = await ls.getSwapStatus(bridgeRecord.swap_id);
            if (!swapResponse || !swapResponse.swap) {
                return reply.code(500).send({ status: 500, error: 'Failed to fetch bridge status' });
            }

            const updateData = {
                status: swapResponse.swap.status,
                received_amount: swapResponse.swap.received_amount
            }
            
            await req.models.Bridge.updateBridge(bridgeRecord.reference_id, updateData);

            return reply.send({ status: 200, payment: updateData});
        } catch (err) {
            req.log.error(err);
            return reply.code(500).send({
                status: 500,
                error: req.t('card.bridge_not_found') || 'Bridge record not found'
            });
        }
    },

    enableZara: async (req, reply) => {
        try {
            const userId = req.user.user_id;
            const isLive = req.user.is_live;
            const cardId = req.postFilter.strip(req.body.card_id);
            const datehelper = new DateHelper();

            const result = await req.apiService.getCard(userId, cardId);
            if(!result){
                return reply.code(404).send({
                    status: 404,
                    error: req.t('card.card_not_found') || 'Card not found'
                });
            }

            const existingAgent = await req.agent
                .findByCardAndName(userId, cardId, 'zara')
                .catch(() => null);

            const walletAddress = result.wallet;
            const modalHtml = await req.server.view('modal/zara.ejs', {
                t: req.t,
                user: req.user,
                cardData: result,
                walletAddress: walletAddress,
                zara_active: !!(existingAgent && existingAgent.enabled),
            });
            return reply.send({ status: 200, modalHtml: modalHtml, modalId: 'zaraAgentModal-overlay' });
            
        } catch (err) {
            req.log.error(err);
            return reply.status(500).send({ error: req.t('error.fetching_modal') });
        }

    },

    toggleZara: async (req, reply) => {
        try {
            const userId = req.user.user_id;
            const isLive = req.user.is_live;
            const cardId = req.postFilter.strip(req.body.card_id);
            const enable = req.body.zara_enabled === '1';
            const sigR   = req.body.sig_r;
            const sigS   = req.body.sig_s;

            if (!sigR || !sigS) {
                return reply.code(400).send({ status: 400, error: 'PIN signature is required to authorize this action.' });
            }

            const card = await req.apiService.getCard(userId, cardId);
            if (!card) {
                return reply.code(404).send({ status: 404, error: req.t('card.card_not_found') || 'Card not found' });
            }

            const cardService = await StarknetCardService.create({
                cardAddress: card.address,
                isLive: isLive
            });

            if (enable) {
                await cardService.grantRelayerYieldAccess(sigR, sigS);
            } else {
                await cardService.revokeRelayerYieldAccess(sigR, sigS);
            }

            let agent = await req.agent
                .findByCardAndName(userId, cardId, 'zara')
                .catch(() => null);

            if (enable) {
                if (agent) {
                    await req.agent.enableAgent(agent.agent_id);
                    await RabbitService.publish('agent.enable', {
                        agent_id: agent.agent_id,
                        agent_name: agent.name,
                        card_id: cardId,
                        owner_user_id: userId,
                        is_live: isLive,
                    });
                } else {
                    agent = await req.agent.create({
                        agent_id: EncryptionService.uuid(),
                        name: 'zara',
                        type: 'financial',
                        card_id: cardId,
                        skills: ['spending_analysis', 'portfolio_review', 'staking', 'market_sentiment', 'alerts'],
                        owner_user_id: userId,
                        enabled: true,
                        config: {
                            extra: {
                                card_address: card.address || null,
                                is_live:      req.user.is_live || false,
                            }
                        }
                    });

                    await req.agent.enable(agent.agent_id);
                    await RabbitService.publish('agent.enable', {
                        agent_id: agent.agent_id,
                        agent_name: agent.name,
                        card_id: cardId,
                        owner_user_id: userId,
                        is_live: isLive,
                    });
                }

                return reply.send({ status: 200, zara_enabled: true, message: 'Zara activated successfully' });

            } else {
                if (agent) {
                    await req.agent.disable(agent.agent_id);
                    await RabbitService.publish('agent.disable', {
                        agent_id: agent.agent_id,
                        card_id: cardId,
                        is_live: isLive,
                    });
                }
                return reply.send({ status: 200, zara_enabled: false, message: 'Zara deactivated successfully' });
            }

        } catch (err) {
            req.log.error(err);
            return reply.code(500).send({ status: 500, error: 'Failed to toggle Zara agent' });
        }
    },

    getPinNonce: async (req, reply) => {
        try {
            const userId = req.user.user_id;
            const isLive = req.user.is_live;
            const cardId = req.postFilter.strip(req.body.card_id);
           
            const card = await req.apiService.getCard(userId, cardId);
            if (!card) {
                return reply.code(404).send({ status: 404, error: req.t('card.card_not_found') || 'Card not found' });
            }

            const cardService = await StarknetCardService.create({
                cardAddress: card.address,
                isLive: isLive
            });

            const nonce = await cardService.getPinNonce(card.wallet);
            return reply.send({ status: 200, nonce: nonce });
           
        } catch (err) {
            req.log.error(err);
            return reply.code(500).send({ status: 500, error: 'Failed to fetch PIN nonce' });
        }
    },

    getAgentStatus: async (req, reply) => {
        const userId = req.user.user_id;
        const { card_id } = req.query;
 
        try {
            const agentRecord = await req.agent.findByCard(userId, card_id);
 
            if (!agentRecord) {
                return reply.send({
                    success: true,
                    agent_exists: false,
                });
            }
 
            return reply.send({
                success: true,
                agent_exists: true,
                agent: {
                    agent_id: agentRecord.agent_id,
                    name: agentRecord.name,
                    type: agentRecord.type,
                    enabled: agentRecord.enabled,
                    created_at: agentRecord.created_at,
                }
            });
 
        } catch (err) {
            console.error('[HomeController] Get agent status error:', err);
            return reply.status(500).send({
                success: false,
                message: err.message,
            });
        }
    },

    showCardModal: async (req, reply) => {
        try {
            const userId = req.user.user_id;
            const isLive = req.user.is_live;
            const cardAction = req.postFilter.strip(req.body.action);
            const cardId = req.postFilter.strip(req.body.card_id); 
            const datehelper = new DateHelper();

            if (cardAction === 'create' || cardAction === 'deploy') {
                const csrfToken = await reply.generateCsrf();
                const wallets = [];
                try {
                    if (req.user && req.user.security) {
                        const sec = req.user.security;
                        if (sec.wallet_address) {
                            wallets.push({
                                provider: sec.wallet_provider || 'Connected Wallet',
                                address: sec.wallet_address
                            });
                        }
                    }
                } catch (e) {
                    req.log.warn('Failed to build wallets list for create card modal', e.message || e);
                }

                const modalHtml = await req.server.view('modal/create_card.ejs', {
                    t: req.t,
                    user: req.user,
                    root: '/',
                    csrfToken,
                    wallets
                });
                return reply.send({ status: 200, modalHtml: modalHtml, modalId: 'createCardModal' });
            }
        } catch (err) {
            req.log.error(err);
            return reply.status(500).send({ error: req.t('error.fetching_modal') });
        }
    },

}
