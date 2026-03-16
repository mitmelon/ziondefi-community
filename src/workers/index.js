/**
 * Worker Index — Start all background workers
 */

const RabbitService = require('../services/RabbitService');
const handleCardDeploy = require('./cardDeployWorker');
const startTransferSync = require('./transferSyncWorker');
const yieldAgentWorker = require('./yieldAgentWorker');

async function startAllWorkers(mongoClient) {
    console.log('[Workers] Starting all RabbitMQ consumers...');

    // ── Card deploy worker ─────────────────────────────────────────────────
    await RabbitService.consume(
        'ziondefi.card.deploy',
        'card.deploy',
        (data, currentAttempt, maxAttempts) =>
            handleCardDeploy(data, mongoClient, currentAttempt, maxAttempts)
    );

    // ── Card redeploy worker ────────────────
    await RabbitService.consume(
        'ziondefi.card.redeploy',
        'card.redeploy',
        (data, currentAttempt, maxAttempts) =>
            handleCardDeploy(data, mongoClient, currentAttempt, maxAttempts)
    );

    // ── Transfer sync worker ────────────────
    startTransferSync(mongoClient);

    // ── Yield Agent Enable/Disable workers ────────────────────────────────
    await RabbitService.consume(
        'ziondefi.agent.enable',
        'agent.enable',
        (data) => yieldAgentWorker.handleEnableAgent(data, mongoClient)
    );
 
    await RabbitService.consume(
        'ziondefi.agent.disable',
        'agent.disable',
        (data) => yieldAgentWorker.handleDisableAgent(data)
    );

    console.log('[Workers] All workers online.');
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[Workers] SIGTERM received, stopping agents...');
    yieldAgentWorker.stopAllAgents();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[Workers] SIGINT received, stopping agents...');
    yieldAgentWorker.stopAllAgents();
    process.exit(0);
});

module.exports = startAllWorkers;