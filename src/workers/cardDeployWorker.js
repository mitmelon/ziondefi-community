const Cards = require('../models/Cards');
const StarknetCardService = require('../services/StarknetCardService');

/**
 * Errors that will never succeed on retry — fail immediately rather than
 * burning all retry attempts.
 */
const UNRECOVERABLE_PATTERNS = [
    /exceed balance \(0\)/i,          // relayer has no funds
    /Account is not deployed/i,       // relayer address misconfigured
    /not configured/i,                 // missing env var
    /No valid currencies resolved/i,   // bad card config
    /cardAddress is required/i,
];

function isUnrecoverable(message) {
    return UNRECOVERABLE_PATTERNS.some(p => p.test(message || ''));
}

const handleCardDeploy = async (cardData, mongoClient, currentAttempt, maxAttempts) => {
    console.log(`[Worker] Processing card deploy: ${cardData.card_id} (attempt ${currentAttempt}/${maxAttempts})`);
    
    const cardsModel = new Cards(mongoClient);
    if (cardData.is_live === false) {
        cardsModel.useDatabase(process.env.DB_NAME_SANDBOX);
    }

    try {
        await cardsModel.markDeploying(cardData.card_id);

        const result = await StarknetCardService.deployCard(cardData);

        if (result.success) {
            await cardsModel.confirmDeployment(
                cardData.card_id, 
                result.contract_address, 
                result.transaction_hash, 
                result.gasDetails
            );
            console.log(`[Worker] Card deployed successfully: ${cardData.card_id} → ${result.contract_address}`);
        } else {
            throw new Error(result.error || 'Deployment returned unsuccessful');
        }

    } catch (err) {
        const permanent = currentAttempt >= maxAttempts || isUnrecoverable(err.message);

        if (permanent) {
            const reason = isUnrecoverable(err.message)
                ? `Permanent failure (non-retryable): ${err.message}`
                : err.message;
            console.error(`[Worker] Card deploy permanently failed for ${cardData.card_id}: ${reason}`);
            try {
                await cardsModel.failDeployment(cardData.card_id, reason, currentAttempt);
                console.log(`[Worker] Card status updated to failed in DB: ${cardData.card_id}`);
            } catch (updateErr) {
                console.error('[Worker] Failed to update card status to failed:', updateErr.message);
            }
            // Do NOT rethrow — returning without throwing tells RabbitMQ to ack (no retry)
            return;
        }

        throw err;
    }
};

module.exports = handleCardDeploy;