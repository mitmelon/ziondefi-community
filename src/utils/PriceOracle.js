/**
 * PriceOracle.js
 * Fetches and caches live USD prices for supported Starknet tokens.
 * Uses Redis for distributed caching.
 * Automatically uses CoinGecko Pro if an API key is provided, otherwise falls back to Free tier.
 */
const redis = require('../services/RedisService');

class PriceOracle {
    constructor() {
        this.apiKey = process.env.COINGECKO_API_KEY || null;
        if (this.apiKey) {
            this.baseUrl = 'https://pro-api.coingecko.com/api/v3';
            this.cacheTtl = 10; // 10 seconds TTL for Pro
            console.log('[PriceOracle] Initialized using CoinGecko PRO (Redis TTL: 10s)');
        } else {
            this.baseUrl = 'https://api.coingecko.com/api/v3';
            this.cacheTtl = 60; // 60 seconds TTL for Free tier safety
            console.log('[PriceOracle] Initialized using CoinGecko FREE (Redis TTL: 60s)');
        }
        
        this.coinGeckoIds = {
            'ETH': 'ethereum',
            'STRK': 'starknet',
            'USDC': 'usd-coin',
            'USDT': 'tether',
            'DAI': 'dai',
            'WBTC': 'wrapped-bitcoin',
            'LORDS': 'lords',
            'WSTETH': 'wrapped-steth'
        };

        this.idToSymbol = Object.entries(this.coinGeckoIds).reduce((acc, [sym, id]) => {
            acc[id] = sym;
            return acc;
        }, {});
    }

    async fetchLivePrices() {
        const redisKey = 'oracle:live_prices';

        try {
            const cachedPrices = await redis.get(redisKey);
            if (cachedPrices) {
                return cachedPrices;
            }
            const ids = Object.values(this.coinGeckoIds).join(',');
            const url = `${this.baseUrl}/simple/price?ids=${ids}&vs_currencies=usd`;

            const headers = {
                'Accept': 'application/json'
            };
            
            if (this.apiKey) {
                headers['x-cg-pro-api-key'] = this.apiKey; 
            }

            let response = await fetch(url, { headers });

            // Auto-fallback to free tier if Pro key is rejected
            if ((response.status === 401 || response.status === 403) && this.apiKey) {
                console.warn('[PriceOracle] Pro API key rejected — falling back to free tier');
                response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { headers: { 'Accept': 'application/json' } });
            }

            if (!response.ok) {
                throw new Error(`CoinGecko API responded with status ${response.status}`);
            }

            const data = await response.json();
            const newPrices = {};

            for (const [cgId, priceData] of Object.entries(data)) {
                const symbol = this.idToSymbol[cgId];
                if (symbol && priceData.usd !== undefined) {
                    newPrices[symbol] = priceData.usd;
                }
            }

            if (!newPrices['USDC']) newPrices['USDC'] = 1.00;
            if (!newPrices['USDT']) newPrices['USDT'] = 1.00;
            if (!newPrices['DAI']) newPrices['DAI'] = 1.00;

            await redis.set(redisKey, newPrices, this.cacheTtl);

            return newPrices;

        } catch (error) {
            console.error('[PriceOracle] Error fetching prices:', error.message);
            
            return {
                ETH: 0, STRK: 0, USDC: 1, USDT: 1, DAI: 1, WBTC: 0, LORDS: 0, WSTETH: 0
            };
        }
    }
}

const priceOracle = new PriceOracle();
module.exports = priceOracle;