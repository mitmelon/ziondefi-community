/**
 * yieldAgentWorker.js — Continuous Yield Agent Background Worker
 * 
 * Runs autonomous staking, compounding, and buffer management for all enabled agents.
 * Each agent runs on its own schedule:
 * - Staking cycle: Every 24 hours
 * - Compound cycle: Every 6 hours
 * - Spending analysis: Every 12 hours
 * - Market monitoring: Every 4 hours (unstake on bad conditions)
 */

const YieldAgent = require('../agents/YieldAgent');
const SpendingAnalyzer = require('../agents/SpendingAnalyzer');
const MarketMonitor = require('../agents/MarketMonitor');
const StarknetConfig = require('../services/StarknetConfig');

// Track running agent intervals
const runningAgents = new Map();

/**
 * Start a continuous agent for a specific card
 */
async function startAgentForCard(agentRecord, card, userId, mongoClient, isLive) {
    const agentKey = `${agentRecord.agent_id}_${card.card_id}`;

    if (runningAgents.has(agentKey)) {
        console.log(`[YieldWorker] Agent ${agentKey} already running`);
        return;
    }

    const network = isLive ? 'mainnet' : 'testnet';
    console.log(`[YieldWorker] Starting agent ${agentKey} on ${network}`);

    const starknetConfig = StarknetConfig.resolve(isLive);
    
    const agent = new YieldAgent({
        cardAddress: card.contract_address,
        card: card,
        ownerUserId: userId,
        agentId: agentRecord.agent_id,
        agentName: agentRecord.name,
        relayerAddress: starknetConfig.relayerAddress,
        relayerPrivateKey: starknetConfig.relayerPrivateKey,
        mongoClient,
        isLive: isLive,
        awsRegion: process.env.AWS_REGION,
        awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    });

    const spendingAnalyzer = new SpendingAnalyzer(
        card.address,
        card.card_id,
        userId,
        mongoClient,
        isLive
    );

    const marketMonitor = new MarketMonitor(isLive);

    try {
        await agent.initialize();
        console.log(`[YieldWorker] Agent ${agentKey} initialized on ${network} ✓`);

        const intervals = {
            staking: setInterval(async () => {
                try {
                    console.log(`[YieldWorker] Staking cycle for ${agentKey} (${network})`);
                    await agent.runStakingCycle();
                } catch (err) {
                    console.error(`[YieldWorker] Staking error ${agentKey}:`, err.message);
                }
            }, 24 * 60 * 60 * 1000),

            compound: setInterval(async () => {
                try {
                    console.log(`[YieldWorker] Compound cycle for ${agentKey} (${network})`);
                    await agent.runCompoundCycle();
                } catch (err) {
                    console.error(`[YieldWorker] Compound error ${agentKey}:`, err.message);
                }
            }, 6 * 60 * 60 * 1000),

            spendingAnalysis: setInterval(async () => {
                try {
                    console.log(`[YieldWorker] Spending analysis for ${agentKey} (${network})`);
                    const analysis = await spendingAnalyzer.analyzeAndAdjustBuffer(agent);
                    if (analysis.shouldAdjust) {
                        console.log(`[YieldWorker] Buffer adjustment for ${agentKey}`);
                    }
                } catch (err) {
                    console.error(`[YieldWorker] Spending error ${agentKey}:`, err.message);
                }
            }, 12 * 60 * 60 * 1000),

            marketMonitor: setInterval(async () => {
                try {
                    console.log(`[YieldWorker] Market monitor for ${agentKey} (${network})`);
                    const marketCondition = await marketMonitor.checkMarketConditions();
                    if (marketCondition.shouldUnstake) {
                        console.log(`[YieldWorker] Emergency unstake for ${agentKey}`);
                        await agent.emergencyUnstake(marketCondition);
                    }
                } catch (err) {
                    console.error(`[YieldWorker] Market error ${agentKey}:`, err.message);
                }
            }, 4 * 60 * 60 * 1000),
        };

        console.log(`[YieldWorker] Running initial staking for ${agentKey}`);
        await agent.runStakingCycle().catch(err => {
            console.error(`[YieldWorker] Initial stake failed ${agentKey}:`, err.message);
        });

        runningAgents.set(agentKey, {
            agent,
            intervals,
            card,
            userId,
            agentRecord,
            network,
            isLive,
            startedAt: Date.now(),
        });

        console.log(`[YieldWorker] Agent ${agentKey} running on ${network} ✓`);

    } catch (err) {
        console.error(`[YieldWorker] Failed to start ${agentKey}:`, err.message);
    }
}

function stopAgent(agentKey) {
    const running = runningAgents.get(agentKey);
    if (!running) return;
    Object.values(running.intervals).forEach(interval => clearInterval(interval));
    runningAgents.delete(agentKey);
    console.log(`[YieldWorker] Stopped ${agentKey} (was on ${running.network})`);
}

function stopAllAgents() {
    console.log(`[YieldWorker] Stopping ${runningAgents.size} agents...`);
    for (const agentKey of runningAgents.keys()) {
        stopAgent(agentKey);
    }
}

function getRunningAgentsStatus() {
    const status = [];
    for (const [agentKey, data] of runningAgents.entries()) {
        status.push({
            agent_key: agentKey,
            agent_id: data.agentRecord.agent_id,
            card_id: data.card.card_id,
            user_id: data.userId,
            network: data.network,
            is_live: data.isLive,
            started_at: data.startedAt,
            uptime_hours: ((Date.now() - data.startedAt) / (1000 * 60 * 60)).toFixed(2),
        });
    }
    return status;
}

/**
 * Handle enable agent event from RabbitMQ
 * 
 * @param {object} data - { agent_id, card_id, owner_user_id, is_live }
 * @param {object} mongoClient - MongoDB client (selected by worker index based on data.is_live)
 */
async function handleEnableAgent(data, mongoClient) {
    const { agent_id, card_id, owner_user_id, is_live } = data;
    
    if (is_live === undefined) {
        console.error('[YieldWorker] CRITICAL: is_live missing from message!');
        return;
    }
    
    const network = is_live ? 'mainnet' : 'testnet';
    console.log(`[YieldWorker] Enable request: ${agent_id} on ${network}`);
    
    try {
        const Agent = require('../models/Agent');
        const Card = require('../models/Cards');
        
        const agentModel = new Agent(mongoClient);
        const cardModel = new Card(mongoClient);

        if (network === 'testnet') {
            cardModel.useDatabase(process.env.DB_NAME_SANDBOX);
        }
        
        const agentRecord = await agentModel.findById(agent_id);
        if (!agentRecord || !agentRecord.enabled) {
            console.warn(`[YieldWorker] Agent ${agent_id} not found or disabled`);
            return;
        }
        
        const card = await cardModel.retrieve(card_id);
        if (!card) {
            console.warn(`[YieldWorker] Card ${card_id} not found`);
            return;
        }
        
        await startAgentForCard(agentRecord, card, owner_user_id, mongoClient, is_live);
        
    } catch (err) {
        console.error(`[YieldWorker] Enable failed for ${agent_id}:`, err.message);
    }
}

async function handleDisableAgent(data) {
    const { agent_id, card_id } = data;
    stopAgent(`${agent_id}_${card_id}`);
}

module.exports = {
    startAgentForCard,
    stopAgent,
    stopAllAgents,
    getRunningAgentsStatus,
    handleEnableAgent,
    handleDisableAgent,
};