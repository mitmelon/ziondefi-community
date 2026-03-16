/**
 * StakeTracker — MongoDB-based stake position tracker
 * 
 * Tracks all stakes, compounds, and rewards for a card contract.
 * Uses MongoDB for persistence instead of Redis.
 */

const StakePosition = require('../models/StakePosition');

class StakeTracker {
    constructor(cardAddress, cardId, ownerUserId, mongoClient, isLive) {
        this.cardAddress = cardAddress;
        this.cardId = cardId;
        this.ownerUserId = ownerUserId;
        this.stakeModel = new StakePosition(mongoClient);
        if (isLive === false) {
            this.stakeModel.useDatabase(process.env.DB_NAME_SANDBOX);
        }
    }

    /**
     * Record a new stake
     */
    async recordStake(data) {
        const stake = await this.stakeModel.create({
            card_address: this.cardAddress,
            card_id: this.cardId,
            owner_user_id: this.ownerUserId,
            pool_address: data.poolAddress,
            token_address: data.tokenAddress,
            token_symbol: data.tokenSymbol,
            validator_name: data.validatorName,
            amount_staked: data.amountStaked,
            tx_hash: data.txHash,
            explorer_url: data.explorerUrl,
        });

        console.log(`[StakeTracker] Recorded stake: ${data.amountStaked} ${data.tokenSymbol} in ${data.poolAddress}`);
        return stake;
    }

    /**
     * Record a compound operation (claim + re-stake)
     */
    async recordCompound(poolAddress, rewardsAmount, txHash, explorerUrl) {
        const stake = await this.stakeModel.getByPool(this.cardAddress, poolAddress);
        
        if (!stake) {
            console.warn(`[StakeTracker] No active stake found for pool ${poolAddress}`);
            return null;
        }

        await this.stakeModel.recordCompound(stake.stake_id, rewardsAmount, txHash, explorerUrl);
        
        console.log(`[StakeTracker] Recorded compound: +${rewardsAmount} ${stake.token_symbol}`);
        console.log(`[StakeTracker] Total lifetime rewards: ${stake.total_rewards_claimed + rewardsAmount} ${stake.token_symbol}`);
        
        return stake;
    }

    /**
     * Mark a stake as inactive (fully exited)
     */
    async markExited(poolAddress, txHash, explorerUrl) {
        const stake = await this.stakeModel.getByPool(this.cardAddress, poolAddress);
        
        if (!stake) {
            console.warn(`[StakeTracker] No active stake found for pool ${poolAddress}`);
            return null;
        }

        await this.stakeModel.markExited(stake.stake_id, txHash, explorerUrl);
        console.log(`[StakeTracker] Marked stake as exited: ${stake.token_symbol} from ${poolAddress}`);
        
        return stake;
    }

    /**
     * Get all currently active stakes
     */
    async getActiveStakes() {
        return this.stakeModel.getActiveStakes(this.cardAddress);
    }

    /**
     * Get complete staking history (active + exited)
     */
    async getAllStakes() {
        return this.stakeModel.getAllStakes(this.cardAddress);
    }

    /**
     * Get total amount staked across all pools
     */
    async getTotalStaked() {
        return this.stakeModel.getTotalStaked(this.cardAddress);
    }

    /**
     * Get total rewards claimed across all stakes
     */
    async getTotalRewardsClaimed() {
        return this.stakeModel.getTotalRewardsClaimed(this.cardAddress);
    }

    /**
     * Get stakes grouped by token symbol
     */
    async getStakesByToken() {
        const stakes = await this.getActiveStakes();
        const grouped = {};
        
        for (const stake of stakes) {
            if (!grouped[stake.token_symbol]) {
                grouped[stake.token_symbol] = [];
            }
            grouped[stake.token_symbol].push(stake);
        }
        
        return grouped;
    }

    /**
     * Get comprehensive statistics
     */
    async getStats() {
        return this.stakeModel.getStats(this.cardAddress);
    }
}

module.exports = StakeTracker;