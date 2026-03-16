/**
 * StakePosition.js — MongoDB model for staking positions
 */

const MongoBase  = require('../lib/MongoBase');
const DateHelper = require('../utils/DateHelper');
const EncryptionService = require('../services/EncryptionService');

class StakePosition extends MongoBase {
    constructor(mongoClient) {
        super(mongoClient, process.env.MONGO_DB, 'stake_positions', {
            stake_id:      true,
            card_address:  1,
            pool_address:  1,
            token_address: 1,
            token_symbol:  1,
            validator_name: 1,
            is_active:     1,
            owner_user_id: 1,
            card_id:       1,
            created_at:    -1
        });

        this.date = new DateHelper();
    }

    /**
     * Create a new stake position record
     */
    async create(data) {
        const now = this.date.timestampTimeNow();
        
        const stake = {
            stake_id: data.stake_id || this._generateStakeId(),
            card_address: data.card_address,
            card_id: data.card_id,
            owner_user_id: data.owner_user_id,
            pool_address: data.pool_address,
            token_address: data.token_address,
            token_symbol: data.token_symbol,
            validator_name: data.validator_name,
            amount_staked: data.amount_staked,
            tx_hash: data.tx_hash,
            explorer_url: data.explorer_url,
            total_rewards_claimed: 0,
            last_compounded_at: null,
            is_active: true,
            created_at: now,
            staked_at: now,
            updated_at: now,
        };

        const result = await this.insertOne(stake);
        return result;
    }

    /**
     * Record a compound operation (claim + re-stake)
     */
    async recordCompound(stakeId, rewardsAmount, txHash, explorerUrl) {
        const stake = await this.findOne({ stake_id: stakeId });
        
        if (!stake) {
            throw new Error(`Stake ${stakeId} not found`);
        }

        const now = this.date.timestampTimeNow();
        const newTotalRewards = (stake.total_rewards_claimed || 0) + rewardsAmount;

        return this.updateOne(
            { stake_id: stakeId },
            {
                total_rewards_claimed: newTotalRewards,
                last_compounded_at: now,
                last_compound_tx: txHash,
                last_compound_url: explorerUrl,
                updated_at: now,
            }
        );
    }

    /**
     * Mark a stake as exited
     */
    async markExited(stakeId, txHash, explorerUrl) {
        const now = this.date.timestampTimeNow();
        
        return this.updateOne(
            { stake_id: stakeId },
            {
                is_active: false,
                exited_at: now,
                exit_tx_hash: txHash,
                exit_explorer_url: explorerUrl,
                updated_at: now,
            }
        );
    }

    /**
     * Get all active stakes for a card
     */
    async getActiveStakes(cardAddress) {
        return this.findAll({
            card_address: cardAddress,
            is_active: true,
        });
    }

    /**
     * Get all stakes (active + exited) for a card
     */
    async getAllStakes(cardAddress) {
        return this.findAll({ card_address: cardAddress });
    }

    /**
     * Get stake by pool address
     */
    async getByPool(cardAddress, poolAddress) {
        return this.findOne({
            card_address: cardAddress,
            pool_address: poolAddress,
            is_active: true,
        });
    }

    /**
     * Get stakes by token
     */
    async getByToken(cardAddress, tokenSymbol) {
        return this.findAll({
            card_address: cardAddress,
            token_symbol: tokenSymbol,
            is_active: true,
        });
    }

    /**
     * Get total staked amount across all active stakes
     */
    async getTotalStaked(cardAddress) {
        const stakes = await this.getActiveStakes(cardAddress);
        return stakes.reduce((sum, s) => sum + (s.amount_staked || 0), 0);
    }

    /**
     * Get total rewards claimed across all stakes
     */
    async getTotalRewardsClaimed(cardAddress) {
        const stakes = await this.getAllStakes(cardAddress);
        return stakes.reduce((sum, s) => sum + (s.total_rewards_claimed || 0), 0);
    }

    /**
     * Find stakes by user and card
     */
    async findByUserCard(userId, cardId) {
        return this.findAll({
            owner_user_id: userId,
            card_id: cardId,
            is_active: true,
        });
    }

    /**
     * Get stake statistics
     */
    async getStats(cardAddress) {
        const stakes = await this.getAllStakes(cardAddress);
        const activeStakes = stakes.filter(s => s.is_active);
        
        return {
            total_stakes: stakes.length,
            active_stakes: activeStakes.length,
            exited_stakes: stakes.length - activeStakes.length,
            total_amount_staked: activeStakes.reduce((sum, s) => sum + (s.amount_staked || 0), 0),
            total_rewards_claimed: stakes.reduce((sum, s) => sum + (s.total_rewards_claimed || 0), 0),
        };
    }

    /**
     * Generate unique stake ID
     */
    _generateStakeId() {
        return EncryptionService.uuid();
    }
}

module.exports = StakePosition;