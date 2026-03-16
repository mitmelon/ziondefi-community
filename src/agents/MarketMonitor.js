/**
 * MarketMonitor.js — Market Condition Monitor with Bybit API Integration
 * 
 * Monitors market conditions using Bybit's public API and triggers emergency 
 * unstaking to protect user funds during market downturns or high volatility.
 * 
 * Uses AWS Nova 2 Lite to analyze market data and make intelligent decisions.
 */

const { RestClientV5 } = require('bybit-api');
const NovaDecisionEngine = require('./NovaDecisionEngine');

// Map Starknet tokens to Bybit trading pairs
const TOKEN_TO_BYBIT_PAIR = {
    'STRK': 'STRKUSDT',
    'ETH': 'ETHUSDT',
    'USDC': 'USDCUSDT',
    'USDT': 'USDTUSDT',
    'DAI': 'DAIUSDT',
    'WBTC': 'BTCUSDT',  // WBTC tracks BTC price
    'LORDS': null,       // Not on Bybit, skip
    'WSTETH': 'ETHUSDT', // WSTETH tracks ETH price
};

class MarketMonitor {
    constructor(isLive = true) {
        this.isLive = isLive;
    
        this.bybit = new RestClientV5({
            testnet: false,
        });
        
        this.nova = new NovaDecisionEngine({
            region: process.env.AWS_REGION,
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        });
    }

    /**
     * Check market conditions and decide if emergency unstaking is needed
     */
    async checkMarketConditions() {
        console.log('[MarketMonitor] Checking market conditions via Bybit API...');

        try {
            // Fetch current market data from Bybit
            const marketData = await this._fetchMarketData();

            // Ask Nova to analyze and decide
            const decision = await this._analyzeWithNova(marketData);
            return decision;

        } catch (err) {
            console.error('[MarketMonitor] Market check failed:', err);
            // On error, default to safe (don't unstake unless certain)
            return {
                shouldUnstake: false,
                reasoning: `Market check error: ${err.message}`,
                severity: 'unknown',
                tokensToUnstake: [],
            };
        }
    }

    /**
     * Fetch real market data from Bybit for all supported tokens
     */
    async _fetchMarketData() {
        const marketData = {
            timestamp: Date.now(),
            tokens: {},
        };

        const tokens = Object.keys(TOKEN_TO_BYBIT_PAIR);

        for (const symbol of tokens) {
            const bybitPair = TOKEN_TO_BYBIT_PAIR[symbol];
            
            if (!bybitPair) {
                console.log(`[MarketMonitor] Skipping ${symbol} (no Bybit pair)`);
                continue;
            }

            try {
                // Fetch 24h ticker data
                const ticker = await this._get24hTicker(bybitPair);
                
                // Fetch 7-day kline data for trend analysis
                const klines = await this._getKlines(bybitPair, 'D', 7);
                
                // Calculate metrics
                const priceChange24h = this._calculatePriceChange24h(ticker);
                const priceChange7d = this._calculatePriceChange7d(klines);
                const volatility = this._calculateVolatility(klines);
                const volumeChange = this._calculateVolumeChange(ticker);

                marketData.tokens[symbol] = {
                    symbol,
                    bybitPair,
                    currentPrice: parseFloat(ticker.lastPrice),
                    priceChange24h,
                    priceChange7d,
                    volatilityIndex: volatility,
                    tradingVolume24h: parseFloat(ticker.volume24h),
                    volumeChange24h: volumeChange,
                    high24h: parseFloat(ticker.highPrice24h),
                    low24h: parseFloat(ticker.lowPrice24h),
                    timestamp: Date.now(),
                };

                console.log(`[MarketMonitor] ${symbol}: ${priceChange24h.toFixed(2)}% (24h), ${priceChange7d.toFixed(2)}% (7d), Vol: ${volatility.toFixed(0)}`);

            } catch (err) {
                console.error(`[MarketMonitor] Failed to fetch data for ${symbol}:`, err.message);
                // Skip this token if API fails
            }
        }

        return marketData;
    }

    /**
     * Get 24-hour ticker data from Bybit
     */
    async _get24hTicker(symbol) {
        try {
            const response = await this.bybit.getTickers({
                category: 'spot',
                symbol: symbol,
            });

            if (!response || !response.result || !response.result.list || !response.result.list[0]) {
                throw new Error(`No ticker data for ${symbol}`);
            }

            return response.result.list[0];
        } catch (err) {
            console.error(`[MarketMonitor] Bybit ticker error for ${symbol}:`, err.message);
            throw err;
        }
    }

    /**
     * Get historical kline/candlestick data
     * 
     * @param {string} symbol - Trading pair (e.g., 'ETHUSDT')
     * @param {string} interval - Kline interval ('D' = daily, '60' = 1 hour)
     * @param {number} limit - Number of candles to fetch
     */
    async _getKlines(symbol, interval, limit) {
        try {
            const response = await this.bybit.getKline({
                category: 'spot',
                symbol: symbol,
                interval: interval,
                limit: limit,
            });

            if (!response || !response.result || !response.result.list) {
                throw new Error(`No kline data for ${symbol}`);
            }

            // Bybit returns klines in reverse chronological order
            // Format: [startTime, open, high, low, close, volume, turnover]
            return response.result.list.reverse().map(k => ({
                timestamp: parseInt(k[0]),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
            }));
        } catch (err) {
            console.error(`[MarketMonitor] Bybit kline error for ${symbol}:`, err.message);
            throw err;
        }
    }

    /**
     * Calculate 24h price change percentage
     */
    _calculatePriceChange24h(ticker) {
        const current = parseFloat(ticker.lastPrice);
        const prevClose = parseFloat(ticker.prevPrice24h);
        
        if (!prevClose || prevClose === 0) return 0;
        
        return ((current - prevClose) / prevClose) * 100;
    }

    /**
     * Calculate 7-day price change percentage
     */
    _calculatePriceChange7d(klines) {
        if (!klines || klines.length < 2) return 0;
        
        const current = klines[klines.length - 1].close;
        const weekAgo = klines[0].open;
        
        if (!weekAgo || weekAgo === 0) return 0;
        
        return ((current - weekAgo) / weekAgo) * 100;
    }

    /**
     * Calculate volatility index (0-100)
     * Based on Average True Range (ATR) relative to price
     */
    _calculateVolatility(klines) {
        if (!klines || klines.length < 2) return 0;
        
        const ranges = klines.map(k => k.high - k.low);
        const avgRange = ranges.reduce((sum, r) => sum + r, 0) / ranges.length;
        const avgPrice = klines.reduce((sum, k) => sum + k.close, 0) / klines.length;
        
        // Volatility as percentage of price, scaled to 0-100
        const volatilityPercent = (avgRange / avgPrice) * 100;
        
        // Scale to 0-100 (assume 10% daily range = volatility index of 100)
        return Math.min(100, volatilityPercent * 10);
    }

    /**
     * Calculate 24h volume change percentage
     */
    _calculateVolumeChange(ticker) {
        // Bybit doesn't provide previous volume directly
        // We can compare current volume to turnover or use kline data
        // For now, return 0 (conservative approach)
        // In production, fetch 2-day klines and compare volumes
        return 0;
    }

    /**
     * Use Nova to analyze market conditions
     */
    async _analyzeWithNova(marketData) {
        const prompt = `You are a market risk analyst for a DeFi staking protocol. Analyze current market conditions from Bybit API and decide if emergency unstaking is needed to protect user funds.

**CURRENT MARKET DATA (Real-time from Bybit):**
${JSON.stringify(marketData, null, 2)}

**UNSTAKING CRITERIA:**
Consider emergency unstaking if:
1. Any staked token drops >20% in 24h (severe dump)
2. Any token drops >35% in 7d (sustained downtrend)
3. Volatility index > 80 (extreme volatility)
4. Multiple tokens showing severe weakness simultaneously

**IMPORTANT:**
- False alarms hurt user returns (missed staking rewards)
- Only trigger on HIGH CONFIDENCE threats
- Small corrections (<10% 24h) are NORMAL
- Consider correlation — if entire market is down 15%, that's different from one token crashing
- STRK is more volatile than ETH/BTC — adjust thresholds accordingly

**YOUR TASK:**
Analyze the REAL market data and decide if emergency unstaking is warranted.

Respond in JSON:
{
  "shouldUnstake": true/false,
  "severity": "low" | "medium" | "high" | "critical",
  "reasoning": "brief explanation of market condition",
  "tokensToUnstake": ["STRK", "ETH"],  // which tokens to unstake
  "percentageToUnstake": 50-100,  // how much to unstake (50% = partial, 100% = full exit)
  "marketCondition": "severe_dump" | "sustained_downtrend" | "extreme_volatility" | "stable"
}

Only set shouldUnstake to true if you are highly confident the market is dangerous.`;

        const response = await this.nova._callNova(prompt);
        return this._parseMarketDecision(response);
    }

    /**
     * Parse Nova's market decision
     */
    _parseMarketDecision(text) {
        try {
            const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);

            return {
                shouldUnstake: parsed.shouldUnstake ?? false,
                severity: parsed.severity || 'low',
                reasoning: parsed.reasoning || 'No analysis provided',
                tokensToUnstake: Array.isArray(parsed.tokensToUnstake) ? parsed.tokensToUnstake : [],
                percentageToUnstake: parsed.percentageToUnstake || 100,
                marketCondition: parsed.marketCondition || 'stable',
            };
        } catch (err) {
            console.warn('[MarketMonitor] Failed to parse Nova response:', err.message);
            return {
                shouldUnstake: false,
                severity: 'unknown',
                reasoning: `Parse error: ${err.message}`,
                tokensToUnstake: [],
                percentageToUnstake: 0,
                marketCondition: 'unknown',
            };
        }
    }

    /**
     * Get supported tokens for this network
     */
    static getSupportedTokens(isLive = true) {
        return Object.keys(TOKEN_TO_BYBIT_PAIR).filter(
            symbol => TOKEN_TO_BYBIT_PAIR[symbol] !== null
        );
    }

    /**
     * Test Bybit API connection
     */
    async testConnection() {
        try {
            console.log('[MarketMonitor] Testing Bybit API connection...');
            const ticker = await this._get24hTicker('ETHUSDT');
            console.log(`[MarketMonitor] ✓ Bybit API working. ETH price: $${ticker.lastPrice}`);
            return { success: true, price: ticker.lastPrice };
        } catch (err) {
            console.error('[MarketMonitor] ✗ Bybit API test failed:', err.message);
            return { success: false, error: err.message };
        }
    }
}

module.exports = MarketMonitor;