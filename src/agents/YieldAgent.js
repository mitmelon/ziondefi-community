/**
 * YieldAgent — Autonomous Staking Manager for ZionDefi Cards
 * 
 * Uses AWS Nova 2 Lite for intelligent decision-making and StarknetCardService
 * for blockchain operations. Automatically withdraws idle funds, stakes them,
 * and compounds rewards while maintaining a 30% buffer for liquidity.
 * 
 */

const StarknetCardService = require('../services/StarknetCardService');
const StakeTracker = require('./StakeTracker');
const NovaDecisionEngine = require('./NovaDecisionEngine');
const AgentLogs = require('../models/AgentLogs');

const BUFFER_PERCENT = 30; // Keep 30% liquid for payments
const MIN_STAKE_USD = 10;  // Minimum $10 to stake (avoid dust)
const COMPOUND_THRESHOLD_USD = 5; // Compound when rewards > $5

class YieldAgent {
    /**
     * @param {object} config
     * @param {string} config.cardAddress        — Card contract address
     * @param {object} config.card               — Card object from database
     * @param {string} config.ownerUserId        — Owner user ID
     * @param {string} config.agentId            — Agent ID from database
     * @param {string} config.agentName          — Agent name from database
     * @param {string} config.relayerAddress     — Relayer wallet address
     * @param {string} config.relayerPrivateKey  — Relayer private key
     * @param {object} config.mongoClient        — MongoDB client instance
     * @param {boolean} [config.isLive=true]     — Mainnet or Sepolia
     * @param {string} [config.awsRegion]        — AWS region for Nova
     * @param {string} [config.awsAccessKeyId]   — AWS credentials
     * @param {string} [config.awsSecretAccessKey]
     */
    constructor(config) {
        this.cardAddress = config.card.address;
        this.card = config.card;
        this.ownerUserId = config.ownerUserId;
        this.agentId = config.agentId;
        this.agentName = config.agentName;
        this.relayerAccount = {
            address: config.relayerAddress,
            privateKey: config.relayerPrivateKey,
        };
        this.isLive = config.isLive !== undefined ? config.isLive : true;
        
        if (!config.mongoClient) {
            throw new Error('mongoClient is required');
        }
        
        this.cardService = null; // Lazy-initialized
        this.tracker = new StakeTracker(
            config.card.address,
            config.card.card_id,
            config.ownerUserId,
            config.mongoClient,
            config.isLive
        );
        this.agentLogs = new AgentLogs(config.mongoClient);
        if (config.isLive === false) {
            this.agentLogs.useDatabase(process.env.DB_NAME_SANDBOX);
        }

        this.nova = new NovaDecisionEngine({
            region: config.awsRegion,
            accessKeyId: config.awsAccessKeyId,
            secretAccessKey: config.awsSecretAccessKey,
        });
    }

    /**
     * Initialize the card service and load staking state.
     */
    async initialize() {
        console.log(`[YieldAgent] Initializing for card ${this.cardAddress}...`);
        
        this.cardService = await StarknetCardService.create({
            cardAddress: this.cardAddress,
            relayerAddress: this.relayerAccount.address,
            relayerPrivateKey: this.relayerAccount.privateKey,
            isLive: this.isLive,
        });

        console.log(`[YieldAgent] Loaded ${this.tracker.getActiveStakes().length} active stakes`);
        console.log(`[YieldAgent] Ready ✓`);
    }

    /**
     * MAIN WORKFLOW: Analyze card balances, withdraw excess funds, and stake.
     * Returns a summary of actions taken.
     */
    async runStakingCycle() {
        console.log('\n[YieldAgent] ═══ Starting Staking Cycle ═══\n');

        await this._logActivity('staking_cycle_started', 'Starting automated staking cycle', {
            card_address: this.cardAddress,
            agent_name: this.agentName,
        });

        try {
            // Fetch card balances
            const balances = await this.cardService.getBalanceSummary();
            if (!balances.balances || balances.balances.length === 0) {
                console.log('[YieldAgent] No balances found. Nothing to stake.');
                await this._logActivity('staking_cycle_skipped', 'No balances found on card', {
                    reason: 'empty_balance',
                });
                return { success: true, actions: [] };
            }

            // Discover stakeable tokens and pools
            const stakeableTokens = await this.cardService. discoverStakingPools(this.isLive);
            const validators = this.cardService.getValidators();

            // Ask Nova to analyze and decide which tokens to stake
            const decision = await this.nova.analyzeStakingOpportunity({
                balances: balances.balances,
                stakeableTokens,
                validators,
                bufferPercent: BUFFER_PERCENT,
                minStakeUsd: MIN_STAKE_USD,
            });

            if (!decision.shouldStake || decision.recommendations.length === 0) {
                console.log('[YieldAgent] Nova recommends no staking at this time.');
                console.log(`[YieldAgent] Reason: ${decision.reasoning}`);
                await this._logActivity('staking_cycle_skipped', `Nova recommendation: ${decision.reasoning}`, {
                    reason: 'no_stake_opportunity',
                    nova_reasoning: decision.reasoning,
                });
                return { success: true, actions: [], reasoning: decision.reasoning };
            }

            await this._logActivity('staking_analysis_complete', `Nova recommended ${decision.recommendations.length} stake(s)`, {
                recommendations_count: decision.recommendations.length,
                nova_reasoning: decision.reasoning,
            });

            // Execute staking for each recommendation
            const actions = [];
            for (const rec of decision.recommendations) {
                try {
                    const action = await this._executeStake(rec);
                    actions.push(action);
                } catch (err) {
                    console.error(`[YieldAgent] Stake failed for ${rec.tokenSymbol}:`, err.message);
                    await this._logActivity('stake_failed', `Failed to stake ${rec.tokenSymbol}: ${err.message}`, {
                        token: rec.tokenSymbol,
                        error: err.message,
                    });
                    actions.push({
                        token: rec.tokenSymbol,
                        success: false,
                        error: err.message,
                    });
                }
            }

            const successCount = actions.filter(a => a.success).length;
            await this._logActivity('staking_cycle_complete', `Completed staking cycle: ${successCount}/${actions.length} successful`, {
                total_actions: actions.length,
                successful: successCount,
                failed: actions.length - successCount,
            });

            console.log(`\n[YieldAgent] ═══ Cycle Complete: ${actions.length} actions ═══\n`);
            return { success: true, actions, reasoning: decision.reasoning };

        } catch (err) {
            console.error('[YieldAgent] Staking cycle failed:', err);
            await this._logActivity('staking_cycle_error', `Staking cycle error: ${err.message}`, {
                error: err.message,
                stack: err.stack,
            });
            return { success: false, error: err.message };
        }
    }

    /**
     * COMPOUND WORKFLOW: Check all active stakes and compound rewards when profitable.
     */
    async runCompoundCycle() {
        console.log('\n[YieldAgent] ═══ Starting Compound Cycle ═══\n');

        await this._logActivity('compound_cycle_started', 'Starting automated compound cycle', {
            card_address: this.cardAddress,
        });

        try {
            const activeStakes = await this.tracker.getActiveStakes();
            if (activeStakes.length === 0) {
                console.log('[YieldAgent] No active stakes to compound.');
                await this._logActivity('compound_cycle_skipped', 'No active stakes found', {
                    reason: 'no_active_stakes',
                });
                return { success: true, compounded: [] };
            }

            await this._logActivity('compound_check_started', `Checking ${activeStakes.length} active stake(s) for rewards`, {
                stakes_count: activeStakes.length,
            });

            const compounded = [];

            for (const stake of activeStakes) {
                try {
                    // Fetch current position from blockchain
                    const position = await this.cardService.getStakingPosition(
                        stake.pool_address,
                        this.relayerAccount
                    );

                    if (!position || !position.hasRewards) {
                        console.log(`[YieldAgent] ${stake.token_symbol} pool has no rewards yet.`);
                        continue;
                    }

                    // Ask Nova whether to compound
                    const shouldCompound = await this.nova.shouldCompoundRewards({
                        stake,
                        position,
                        compoundThresholdUsd: COMPOUND_THRESHOLD_USD,
                    });

                    if (!shouldCompound.compound) {
                        console.log(`[YieldAgent] Nova: skip compound for ${stake.token_symbol}`);
                        console.log(`[YieldAgent] Reason: ${shouldCompound.reasoning}`);
                        await this._logActivity('compound_skipped', `Nova skipped ${stake.token_symbol}: ${shouldCompound.reasoning}`, {
                            token: stake.token_symbol,
                            pool: stake.pool_address,
                            rewards: position.rewards,
                            nova_reasoning: shouldCompound.reasoning,
                        });
                        continue;
                    }

                    // Claim rewards
                    console.log(`[YieldAgent] Claiming ${position.rewards} rewards from ${stake.token_symbol} pool...`);
                    const claimResult = await this.cardService.claimStakingRewards(
                        stake.pool_address,
                        this.relayerAccount,
                        'relayer_pays'
                    );

                    if (!claimResult.claimed) {
                        console.log(`[YieldAgent] Claim skipped: ${claimResult.reason}`);
                        continue;
                    }

                    // Re-stake the claimed rewards
                    console.log(`[YieldAgent] Re-staking ${position.rewards} into pool...`);
                    const stakeResult = await this.cardService.stake(
                        stake.pool_address,
                        stake.token_address,
                        position.rewards.toString(),
                        this.relayerAccount,
                        'relayer_pays'
                    );

                    // Update tracker
                    const rewardsNum = parseFloat(position.rewards.toString().replace(/[^\d.-]/g, ''));
                    await this.tracker.recordCompound(
                        stake.pool_address,
                        rewardsNum,
                        stakeResult.txHash,
                        stakeResult.explorerUrl
                    );

                    await this._logActivity('compound_success', `Successfully compounded ${position.rewards} ${stake.token_symbol}`, {
                        token: stake.token_symbol,
                        pool: stake.pool_address,
                        rewards: position.rewards,
                        rewards_amount: rewardsNum,
                        tx_hash: stakeResult.txHash,
                        explorer_url: stakeResult.explorerUrl,
                    });

                    compounded.push({
                        token: stake.token_symbol,
                        pool: stake.pool_address,
                        rewards: position.rewards,
                        txHash: stakeResult.txHash,
                        explorerUrl: stakeResult.explorerUrl,
                    });

                    console.log(`[YieldAgent] ✓ Compounded ${position.rewards} ${stake.token_symbol}`);

                } catch (err) {
                    console.error(`[YieldAgent] Compound failed for ${stake.token_symbol}:`, err.message);
                    await this._logActivity('compound_failed', `Failed to compound ${stake.token_symbol}: ${err.message}`, {
                        token: stake.token_symbol,
                        pool: stake.pool_address,
                        error: err.message,
                    });
                    compounded.push({
                        token: stake.token_symbol,
                        success: false,
                        error: err.message,
                    });
                }
            }

            const successCount = compounded.filter(c => !c.error).length;
            await this._logActivity('compound_cycle_complete', `Compound cycle complete: ${successCount}/${compounded.length} successful`, {
                total_compounded: compounded.length,
                successful: successCount,
                failed: compounded.length - successCount,
            });

            console.log(`\n[YieldAgent] ═══ Compound Complete: ${compounded.length} compounded ═══\n`);
            return { success: true, compounded };

        } catch (err) {
            console.error('[YieldAgent] Compound cycle failed:', err);
            await this._logActivity('compound_cycle_error', `Compound cycle error: ${err.message}`, {
                error: err.message,
                stack: err.stack,
            });
            return { success: false, error: err.message };
        }
    }

    /**
     * Retrieve all staking positions with current on-chain data.
     */
    async getStakingReport() {
        const activeStakes = this.tracker.getActiveStakes();
        const report = [];

        for (const stake of activeStakes) {
            try {
                const position = await this.cardService.getStakingPosition(
                    stake.poolAddress,
                    this.relayerAccount
                );

                report.push({
                    ...stake,
                    currentPosition: position,
                    lifetimeRewards: stake.totalRewardsClaimed,
                    lastCompound: stake.lastCompoundedAt,
                });
            } catch (err) {
                report.push({
                    ...stake,
                    error: err.message,
                });
            }
        }

        return {
            totalActiveStakes: activeStakes.length,
            stakes: report,
        };
    }

    /**
     * EMERGENCY UNSTAKE: Triggered by market monitor during bad conditions
     * Unstakes funds and returns them to the card contract for safety
     */
    async emergencyUnstake(marketCondition) {
        console.log('\n[YieldAgent] ═══ EMERGENCY UNSTAKE TRIGGERED ═══\n');
        console.log(`[YieldAgent] Reason: ${marketCondition.reasoning}`);
        console.log(`[YieldAgent] Severity: ${marketCondition.severity}`);

        await this._logActivity('emergency_unstake_triggered', `Market emergency: ${marketCondition.reasoning}`, {
            severity: marketCondition.severity,
            market_condition: marketCondition.marketCondition,
            tokens_to_unstake: marketCondition.tokensToUnstake,
            percentage: marketCondition.percentageToUnstake,
        });

        try {
            const activeStakes = await this.tracker.getActiveStakes();
            const unstakeResults = [];

            for (const stake of activeStakes) {
                // Only unstake tokens flagged by market monitor
                if (marketCondition.tokensToUnstake.length > 0 &&
                    !marketCondition.tokensToUnstake.includes(stake.token_symbol)) {
                    console.log(`[YieldAgent] Skipping ${stake.token_symbol} (not flagged for emergency unstake)`);
                    continue;
                }

                try {
                    console.log(`[YieldAgent] Emergency unstaking ${stake.token_symbol} from pool ${stake.pool_address}`);

                    // Get current position
                    const position = await this.cardService.getStakingPosition(
                        stake.pool_address,
                        this.relayerAccount
                    );

                    if (!position) {
                        console.warn(`[YieldAgent] No position found for ${stake.token_symbol}`);
                        continue;
                    }

                    // Calculate amount to unstake
                    const stakedAmount = parseFloat(position.staked.replace(/[^\d.-]/g, ''));
                    const unstakeAmount = (stakedAmount * marketCondition.percentageToUnstake) / 100;

                    // Initiate exit
                    console.log(`[YieldAgent] Exiting ${unstakeAmount} ${stake.token_symbol}...`);
                    const exitIntent = await this.cardService.exitStakingPoolIntent(
                        stake.pool_address,
                        stake.token_address,
                        unstakeAmount.toString(),
                        this.relayerAccount,
                        'relayer_pays'
                    );

                    await this._logActivity('emergency_unstake_initiated', `Unstake initiated: ${unstakeAmount} ${stake.token_symbol}`, {
                        token: stake.token_symbol,
                        amount: unstakeAmount,
                        percentage: marketCondition.percentageToUnstake,
                        tx_hash: exitIntent.txHash,
                        explorer_url: exitIntent.explorerUrl,
                    });

                    unstakeResults.push({
                        token: stake.token_symbol,
                        success: true,
                        action: 'exit_initiated',
                        amount: unstakeAmount,
                        txHash: exitIntent.txHash,
                        explorerUrl: exitIntent.explorerUrl,
                    });

                } catch (err) {
                    console.error(`[YieldAgent] Emergency unstake failed for ${stake.token_symbol}:`, err.message);
                    await this._logActivity('emergency_unstake_failed', `Failed to unstake ${stake.token_symbol}: ${err.message}`, {
                        token: stake.token_symbol,
                        error: err.message,
                    });
                    unstakeResults.push({
                        token: stake.token_symbol,
                        success: false,
                        error: err.message,
                    });
                }
            }

            const successCount = unstakeResults.filter(r => r.success).length;
            await this._logActivity('emergency_unstake_complete', `Emergency unstake complete: ${successCount}/${unstakeResults.length} successful`, {
                total: unstakeResults.length,
                successful: successCount,
                failed: unstakeResults.length - successCount,
            });

            console.log(`\n[YieldAgent] ═══ Emergency Unstake Complete: ${unstakeResults.length} actions ═══\n`);
            return { success: true, unstakeResults };

        } catch (err) {
            console.error('[YieldAgent] Emergency unstake failed:', err);
            await this._logActivity('emergency_unstake_error', `Emergency unstake error: ${err.message}`, {
                error: err.message,
                stack: err.stack,
            });
            return { success: false, error: err.message };
        }
    }

    /**
     * Internal: Execute a single stake operation from Nova's recommendation.
     */
    async _executeStake(recommendation) {
        const {
            tokenSymbol,
            tokenAddress,
            amountToStake,
            poolAddress,
            validatorName,
            bufferLeft,
        } = recommendation;

        console.log(`\n[YieldAgent] Staking ${amountToStake} ${tokenSymbol}`);
        console.log(`[YieldAgent] Pool: ${poolAddress}`);
        console.log(`[YieldAgent] Validator: ${validatorName}`);
        console.log(`[YieldAgent] Buffer left: ${bufferLeft}`);

        // Check if yield access is granted
        const yieldGranted = await this.cardService.isRelayerYieldAccessGranted(tokenAddress);
        if (!yieldGranted) {
            throw new Error(
                `Relayer yield access not granted for ${tokenSymbol}. ` +
                `User must call grantRelayerYieldAccess(${tokenAddress}) first.`
            );
        }

        // Withdraw from card to relayer wallet
        console.log(`[YieldAgent] Withdrawing ${amountToStake} ${tokenSymbol} from card...`);
        const withdrawResult = await this.cardService.withdrawFunds(
            tokenAddress,
            amountToStake,
            null // uses relayer wallet by default
        );

        console.log(`[YieldAgent] Withdraw tx: ${withdrawResult.explorerUrl}`);

        // Wait for transfer delay, then finalize
        const transferDelay = await this.cardService.getTransferDelay();
        const delaySeconds = Array.isArray(transferDelay) ? Number(transferDelay[0]) : Number(transferDelay);

        if (delaySeconds > 0) {
            console.log(`[YieldAgent] Waiting ${delaySeconds}s for transfer delay...`);
            await this._sleep(delaySeconds * 1000);

            console.log(`[YieldAgent] Finalizing transfer ${withdrawResult.transferId}...`);
            await this.cardService.finalizeTransfer(withdrawResult.transferId, null);
        }

        // Check if already a pool member
        const isMember = await this.cardService.isPoolMember(poolAddress, this.relayerAccount);

        let stakeTx;
        if (!isMember) {
            // First time: enterPool
            stakeTx = await this.cardService.enterStakingPool(
                poolAddress,
                tokenAddress,
                amountToStake.toString(),
                this.relayerAccount,
                'relayer_pays'
            );
        } else {
            // Already member: just stake
            stakeTx = await this.cardService.stake(
                poolAddress,
                tokenAddress,
                amountToStake.toString(),
                this.relayerAccount,
                'relayer_pays'
            );
        }

        console.log(`[YieldAgent] Stake tx: ${stakeTx.explorerUrl}`);

        await this.tracker.recordStake({
            poolAddress,
            tokenAddress,
            tokenSymbol,
            validatorName,
            amountStaked: parseFloat(amountToStake.replace(/[^\d.-]/g, '')),
            txHash: stakeTx.txHash,
            explorerUrl: stakeTx.explorerUrl,
        });

        await this._logActivity('stake_success', `Successfully staked ${amountToStake} ${tokenSymbol}`, {
            token: tokenSymbol,
            pool: poolAddress,
            validator: validatorName,
            amount_staked: amountToStake,
            buffer_left: bufferLeft,
            tx_hash: stakeTx.txHash,
            explorer_url: stakeTx.explorerUrl,
        });

        console.log(`[YieldAgent] ✓ Stake complete for ${tokenSymbol}\n`);

        return {
            token: tokenSymbol,
            success: true,
            amountStaked: amountToStake,
            pool: poolAddress,
            validator: validatorName,
            txHash: stakeTx.txHash,
            explorerUrl: stakeTx.explorerUrl,
        };
    }

    /**
     * Log agent activity to MongoDB for tracking and auditing
     */
    async _logActivity(action, description, metadata = {}) {
        try {
            await this.agentLogs.create({
                agent_id: this.agentId,
                agent_name: this.agentName,
                card_id: this.card.card_id,
                card_address: this.cardAddress,
                owner_user_id: this.ownerUserId,
                action,
                description,
                metadata,
                network: this.isLive ? 'mainnet' : 'sepolia',
            });
        } catch (err) {
            console.error('[YieldAgent] Failed to log activity:', err.message);
        }
    }

    /**
     * Utility: sleep for ms milliseconds.
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = YieldAgent;