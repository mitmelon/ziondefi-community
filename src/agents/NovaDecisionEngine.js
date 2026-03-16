/**
 * NovaDecisionEngine — AWS Nova 2 Lite AI for staking decisions
 * 
 * Uses Amazon Nova Lite's speed and efficiency to analyze:
 * - Which tokens to stake based on balance, APY, and risk
 * - When to compound rewards
 * - Optimal pool selection across validators
 */

const {
    BedrockRuntimeClient,
    ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const MODEL_ID = 'us.amazon.nova-lite-v1:0';

class NovaDecisionEngine {
    constructor(config = {}) {
        this.client = new BedrockRuntimeClient({
            region: config.region,
            credentials:
                {
                    accessKeyId: config.accessKeyId,
                    secretAccessKey: config.secretAccessKey,
                }
        });
    }

    _safeStringify(obj, space) {
        return JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v), space);
    }

    /**
     * Ask Nova to analyze balances and recommend which tokens to stake.
     * 
     * Returns:
     * {
     *   shouldStake: boolean,
     *   reasoning: string,
     *   recommendations: [
     *     {
     *       tokenSymbol: 'STRK',
     *       tokenAddress: '0x...',
     *       amountToStake: '10.5',
     *       bufferLeft: '4.5',
     *       poolAddress: '0x...',
     *       validatorName: 'Starkware'
     *     }
     *   ]
     * }
     */
    async analyzeStakingOpportunity(data) {
        const { balances, stakeableTokens, validators, bufferPercent, minStakeUsd } = data;

        const prompt = `You are an AI staking agent called Zara for a DeFi card smart contract on Starknet. Analyze the following data and decide which tokens should be staked.

**CARD BALANCES:**
${this._safeStringify(balances, 2)}

**STAKEABLE TOKENS:**
${this._safeStringify(stakeableTokens, 2)}

**AVAILABLE VALIDATORS:**
${this._safeStringify(validators, 2)}

**STAKING RULES:**
1. Keep ${bufferPercent}% of each token balance as a liquid buffer (for card payments)
2. Only stake if the stakeable amount is worth at least $${minStakeUsd} USD
3. Prefer validators with good reputation (Starkware, Ekubo, etc.)
4. STRK token is the primary staking candidate on Starknet

**YOUR TASK:**
Analyze which tokens have enough balance to stake after reserving the ${bufferPercent}% buffer. For each stakeable token, recommend:
- tokenSymbol (e.g., "STRK")
- tokenAddress (the contract address)
- amountToStake (human-readable amount as string, e.g., "10.5")
- bufferLeft (amount kept liquid)
- poolAddress (must be a plain hex string starting with 0x, taken directly from the pools list above)
- validatorName (validator name)

Respond in JSON format:
{
  "shouldStake": true/false,
  "reasoning": "brief explanation",
  "recommendations": [...]
}

If nothing should be staked (insufficient balance, no stakeable tokens, etc.), set shouldStake to false and explain why.`;

        try {
            const response = await this._callNova(prompt);
            return this._parseStakingDecision(response);
        } catch (err) {
            console.error('[NovaDecisionEngine] Error analyzing staking opportunity:', err);
            return {
                shouldStake: false,
                reasoning: `AI analysis failed: ${err.message}`,
                recommendations: [],
            };
        }
    }

    /**
     * Ask Nova whether to compound rewards for a specific stake.
     * 
     * Returns:
     * {
     *   compound: boolean,
     *   reasoning: string
     * }
     */
    async shouldCompoundRewards(data) {
        const { stake, position, compoundThresholdUsd } = data;

        const prompt = `You are managing a staking position. Decide whether to compound the rewards now.

**STAKE INFO:**
Token: ${stake.tokenSymbol}
Pool: ${stake.poolAddress}
Validator: ${stake.validatorName}
Amount Staked: ${stake.amountStaked}
Lifetime Rewards Claimed: ${stake.totalRewardsClaimed}

**CURRENT POSITION:**
${this._safeStringify(position, 2)}

**COMPOUND RULE:**
Only compound if the estimated USD value of rewards is >= $${compoundThresholdUsd}.

**YOUR TASK:**
Analyze whether compounding now is worth the gas cost. Consider:
- Reward amount
- Gas costs on Starknet (typically low, 0.01-0.05 STRK)
- Opportunity cost of waiting

Respond in JSON:
{
  "compound": true/false,
  "reasoning": "brief explanation"
}`;

        try {
            const response = await this._callNova(prompt);
            return this._parseCompoundDecision(response);
        } catch (err) {
            console.error('[NovaDecisionEngine] Error analyzing compound decision:', err);
            return {
                compound: false,
                reasoning: `AI analysis failed: ${err.message}`,
            };
        }
    }

    /**
     * Internal: Call Nova Lite via Bedrock Converse API.
     */
    async _callNova(prompt) {
        const command = new ConverseCommand({
            modelId: MODEL_ID,
            messages: [
                {
                    role: 'user',
                    content: [{ text: prompt }],
                },
            ],
            inferenceConfig: {
                maxTokens: 2000,
                temperature: 0.3,
                topP: 0.9,
            },
        });

        const response = await this.client.send(command);
        const textContent = response.output?.message?.content?.find(c => c.text);
        
        if (!textContent) {
            throw new Error('Nova returned no text content');
        }

        return textContent.text;
    }

    /**
     * Parse Nova's response into a staking decision object.
     */
    _parseStakingDecision(text) {
        try {
            const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);
            
            return {
                shouldStake: parsed.shouldStake ?? false,
                reasoning: parsed.reasoning || 'No reasoning provided',
                recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
            };
        } catch (err) {
            console.warn('[NovaDecisionEngine] Failed to parse staking decision, defaulting to no-stake');
            return {
                shouldStake: false,
                reasoning: `Parse error: ${err.message}`,
                recommendations: [],
            };
        }
    }

    /**
     * Parse Nova's response into a compound decision object.
     */
    _parseCompoundDecision(text) {
        try {
            const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);
            
            return {
                compound: parsed.compound ?? false,
                reasoning: parsed.reasoning || 'No reasoning provided',
            };
        } catch (err) {
            console.warn('[NovaDecisionEngine] Failed to parse compound decision, defaulting to no-compound');
            return {
                compound: false,
                reasoning: `Parse error: ${err.message}`,
            };
        }
    }
}

module.exports = NovaDecisionEngine;