/**
 * SpendingAnalyzer.js — AI-Powered Spending Pattern Analysis
 * 
 * Monitors on-chain spending habits and predicts future spending needs.
 * Automatically adjusts staking buffers to ensure card always has enough liquidity.
 * 
 * Uses AWS Nova 2 Lite to analyze transaction patterns and make predictions.
 */

const StarknetCardService = require('../services/StarknetCardService');
const NovaDecisionEngine = require('./NovaDecisionEngine');
const AgentLogs = require('../models/AgentLogs');

const DEFAULT_BUFFER_PERCENT = 30;
const ANALYSIS_LOOKBACK_DAYS = 30;

class SpendingAnalyzer {
    constructor(cardAddress, cardId, ownerUserId, mongoClient, isLive = 'mainnet') {
        this.cardAddress = cardAddress;
        this.cardId = cardId;
        this.ownerUserId = ownerUserId;
        this.agentLogs = new AgentLogs(mongoClient);
        if (isLive === 'testnet') {
            this.agentLogs.useDatabase(process.env.DB_NAME_SANDBOX);
        }

        this.nova = new NovaDecisionEngine({
            region: process.env.AWS_REGION,
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        });
    }

    /**
     * Analyze spending patterns and adjust buffer if needed
     */
    async analyzeAndAdjustBuffer(yieldAgent) {
        console.log(`[SpendingAnalyzer] Analyzing spending for ${this.cardAddress}`);

        try {
            // 1. Fetch transaction history
            const endDate = Math.floor(Date.now() / 1000);
            const startDate = endDate - (ANALYSIS_LOOKBACK_DAYS * 24 * 60 * 60);

            const cardService = await StarknetCardService.create({
                cardAddress: this.cardAddress,
                isLive: yieldAgent.isLive,
            });

            const txSummary = await cardService.getTransactionSummary(
                startDate,
                endDate,
                0,
                500
            );

            // Get current balances
            const balances = await cardService.getBalanceSummary();

            // Get active stakes
            const activeStakes = await yieldAgent.tracker.getActiveStakes();

            // Ask Nova to analyze spending patterns and predict future needs
            const analysis = await this._analyzeWithNova({
                txSummary,
                balances,
                activeStakes,
                lookbackDays: ANALYSIS_LOOKBACK_DAYS,
            });

            await this._logActivity('spending_analysis_complete', analysis.summary, {
                should_adjust: analysis.shouldAdjust,
                current_buffer_percent: analysis.currentBufferPercent,
                recommended_buffer_percent: analysis.recommendedBufferPercent,
                prediction: analysis.prediction,
            });

            // Execute buffer adjustment if needed
            if (analysis.shouldAdjust) {
                const adjustmentResult = await this._executeBufferAdjustment(
                    yieldAgent,
                    analysis
                );

                return {
                    shouldAdjust: true,
                    analysis,
                    adjustment: adjustmentResult,
                };
            }

            return {
                shouldAdjust: false,
                analysis,
            };

        } catch (err) {
            console.error('[SpendingAnalyzer] Analysis failed:', err);
            await this._logActivity('spending_analysis_error', `Analysis error: ${err.message}`, {
                error: err.message,
            });
            throw err;
        }
    }

    /**
     * Use Nova AI to analyze spending patterns
     */
    async _analyzeWithNova(data) {
        const { txSummary, balances, activeStakes, lookbackDays } = data;

        const prompt = `You are analyzing spending patterns for a DeFi smart card to optimize staking buffers.

**TRANSACTION SUMMARY (Last ${lookbackDays} days):**
- Total Spent: ${txSummary.totalSpent}
- Total Received: ${txSummary.totalReceived}
- Transaction Count: ${txSummary.transactionCount}
- Unique Merchants: ${txSummary.uniqueMerchants}
- Daily Average Spend: ${this._calculateDailyAverage(txSummary.totalSpent, lookbackDays)}

**CURRENT BALANCES:**
${JSON.stringify(balances.balances, null, 2)}

**ACTIVE STAKES:**
${JSON.stringify(activeStakes, null, 2)}

**CURRENT BUFFER STRATEGY:**
- 30% of each token kept liquid for payments
- 70% staked for yield

**YOUR TASK:**
Analyze the spending pattern and predict future liquidity needs. Consider:
1. Is spending increasing, decreasing, or stable?
2. Are there recurring payments that might increase?
3. Given the transaction frequency and amounts, is 30% buffer sufficient?
4. Should we unstake some funds to increase the buffer?
5. Or can we stake more (reduce buffer) if spending is low?

Respond in JSON:
{
  "shouldAdjust": true/false,
  "currentBufferPercent": 30,
  "recommendedBufferPercent": 25-50,
  "prediction": "spending_increasing" | "spending_stable" | "spending_decreasing",
  "reasoning": "brief explanation",
  "summary": "one-sentence summary for user",
  "urgency": "low" | "medium" | "high"
}

Rules:
- Buffer must be between 25% (minimum for safety) and 50% (maximum)
- Only recommend adjustment if confidence is high
- Consider transaction count AND amounts
- Factor in number of unique merchants (more = more unpredictable spending)`;

        const response = await this.nova._callNova(prompt);
        return this._parseSpendingAnalysis(response);
    }

    /**
     * Parse Nova's spending analysis response
     */
    _parseSpendingAnalysis(text) {
        try {
            const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);

            return {
                shouldAdjust: parsed.shouldAdjust ?? false,
                currentBufferPercent: parsed.currentBufferPercent ?? DEFAULT_BUFFER_PERCENT,
                recommendedBufferPercent: parsed.recommendedBufferPercent ?? DEFAULT_BUFFER_PERCENT,
                prediction: parsed.prediction || 'spending_stable',
                reasoning: parsed.reasoning || 'No analysis provided',
                summary: parsed.summary || 'Spending analysis complete',
                urgency: parsed.urgency || 'low',
            };
        } catch (err) {
            console.warn('[SpendingAnalyzer] Failed to parse Nova response:', err.message);
            return {
                shouldAdjust: false,
                currentBufferPercent: DEFAULT_BUFFER_PERCENT,
                recommendedBufferPercent: DEFAULT_BUFFER_PERCENT,
                prediction: 'spending_stable',
                reasoning: `Parse error: ${err.message}`,
                summary: 'Analysis incomplete',
                urgency: 'low',
            };
        }
    }

    /**
     * Execute buffer adjustment by unstaking or restaking
     */
    async _executeBufferAdjustment(yieldAgent, analysis) {
        const { recommendedBufferPercent, currentBufferPercent, urgency } = analysis;

        console.log(`[SpendingAnalyzer] Adjusting buffer from ${currentBufferPercent}% to ${recommendedBufferPercent}%`);

        const activeStakes = await yieldAgent.tracker.getActiveStakes();

        if (recommendedBufferPercent > currentBufferPercent) {
            // Need MORE buffer — unstake some funds
            console.log('[SpendingAnalyzer] Increasing buffer by unstaking...');
            return this._unstakeForBuffer(yieldAgent, activeStakes, recommendedBufferPercent, urgency);
        } else {
            // Need LESS buffer — stake more funds
            console.log('[SpendingAnalyzer] Decreasing buffer by staking more...');
            return this._stakeExcessBuffer(yieldAgent, recommendedBufferPercent);
        }
    }

    /**
     * Unstake funds to increase buffer
     */
    async _unstakeForBuffer(yieldAgent, activeStakes, targetBufferPercent, urgency) {
        const results = [];

        for (const stake of activeStakes) {
            try {
                // Calculate how much to unstake
                const bufferIncrease = targetBufferPercent - DEFAULT_BUFFER_PERCENT;
                const unstakeAmount = (stake.amount_staked * bufferIncrease) / 100;

                if (unstakeAmount < 1) {
                    console.log(`[SpendingAnalyzer] Unstake amount too small for ${stake.token_symbol}, skipping`);
                    continue;
                }

                console.log(`[SpendingAnalyzer] Unstaking ${unstakeAmount} ${stake.token_symbol} for buffer increase`);

                // Initiate exit
                const exitIntent = await yieldAgent.cardService.exitStakingPoolIntent(
                    stake.pool_address,
                    stake.token_address,
                    unstakeAmount.toString(),
                    yieldAgent.relayerAccount,
                    'relayer_pays'
                );

                await this._logActivity('buffer_adjustment_unstake', `Unstaking ${unstakeAmount} ${stake.token_symbol} to increase buffer`, {
                    token: stake.token_symbol,
                    amount: unstakeAmount,
                    from_buffer: DEFAULT_BUFFER_PERCENT,
                    to_buffer: targetBufferPercent,
                    urgency,
                    tx_hash: exitIntent.txHash,
                });

                results.push({
                    token: stake.token_symbol,
                    action: 'unstake_initiated',
                    amount: unstakeAmount,
                    txHash: exitIntent.txHash,
                });

            } catch (err) {
                console.error(`[SpendingAnalyzer] Unstake failed for ${stake.token_symbol}:`, err.message);
                results.push({
                    token: stake.token_symbol,
                    action: 'unstake_failed',
                    error: err.message,
                });
            }
        }

        return results;
    }

    /**
     * Stake excess buffer
     */
    async _stakeExcessBuffer(yieldAgent, targetBufferPercent) {
        console.log('[SpendingAnalyzer] Staking excess buffer...');
        
        // This will trigger the normal staking cycle with the new buffer target
        // We can pass the new buffer percentage to the staking logic
        const result = await yieldAgent.runStakingCycle();

        await this._logActivity('buffer_adjustment_stake', `Reduced buffer to ${targetBufferPercent}% by staking more`, {
            new_buffer: targetBufferPercent,
            actions: result.actions,
        });

        return result.actions;
    }

    /**
     * Calculate daily average spend
     */
    _calculateDailyAverage(totalSpent, days) {
        if (!totalSpent || days === 0) return '0';
        const total = typeof totalSpent === 'string' ? parseFloat(totalSpent) : totalSpent;
        return (total / days).toFixed(2);
    }

    /**
     * Log activity
     */
    async _logActivity(action, description, metadata = {}) {
        try {
            await this.agentLogs.create({
                agent_id: 'spending_analyzer',
                card_id: this.cardId,
                card_address: this.cardAddress,
                owner_user_id: this.ownerUserId,
                action,
                description,
                metadata,
            });
        } catch (err) {
            console.error('[SpendingAnalyzer] Failed to log activity:', err.message);
        }
    }
}

module.exports = SpendingAnalyzer;