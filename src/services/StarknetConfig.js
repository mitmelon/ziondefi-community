/**
 * StarknetConfig — Centralized network configuration resolver.
 *
 * Resolves the correct RPC URL, factory address, relayer/owner keys,
 * and token addresses based on the user's environment mode (live vs test).
 *
 * Convention:
 *   • Mainnet (is_live === true) :  STARKNET_RPC_URL, FACTORY_CONTRACT_ADDRESS, TOKEN_ETH, …
 *   • Testnet (is_live === false):  TESTNET_STARKNET_RPC_URL, TESTNET_FACTORY_CONTRACT_ADDRESS, TESTNET_TOKEN_ETH, …
 *
 * Usage:
 *   const config = StarknetConfig.resolve(req.user.is_live);
 *   // → { rpcUrl, factoryAddress, relayerAddress, relayerPrivateKey, ownerAddress, ownerPrivateKey, tokens }
 */

class StarknetConfig {
    /**
     * Resolve all StarkNet env vars for the given network mode.
     *
     * @param {boolean} isLive — true for mainnet, false for testnet/sandbox
     * @returns {{ rpcUrl: string, factoryAddress: string, relayerAddress: string, relayerPrivateKey: string, ownerAddress: string, ownerPrivateKey: string, tokens: Record<string, string> }}
     */
    static resolve(isLive = true) {
        const prefix = isLive ? '' : 'TESTNET_';

        return {
            rpcUrl:            process.env[`${prefix}STARKNET_RPC_URL`]          || process.env.STARKNET_RPC_URL,
            factoryAddress:    process.env[`${prefix}FACTORY_CONTRACT_ADDRESS`]  || process.env.FACTORY_CONTRACT_ADDRESS,
            relayerAddress:    process.env[`${prefix}RELAYER_ACCOUNT_ADDRESS`]   || process.env.RELAYER_ACCOUNT_ADDRESS,
            relayerPrivateKey: process.env[`${prefix}RELAYER_PRIVATE_KEY`]       || process.env.RELAYER_PRIVATE_KEY,
            ownerAddress:      process.env[`${prefix}OWNER_ACCOUNT_ADDRESS`]     || process.env.OWNER_ACCOUNT_ADDRESS,
            ownerPrivateKey:   process.env[`${prefix}OWNER_PRIVATE_KEY`]         || process.env.OWNER_PRIVATE_KEY,
            tokens:            StarknetConfig.resolveTokens(isLive),
        };
    }

    /**
     * Resolve token symbol → contract address map for the given network.
     *
     * @param {boolean} isLive
     * @returns {Record<string, string>}
     */
    static resolveTokens(isLive = true) {
        const prefix = isLive ? '' : 'TESTNET_';
        return {
            ETH:    process.env[`${prefix}TOKEN_ETH`]    || '',
            STRK:   process.env[`${prefix}TOKEN_STRK`]   || '',
            USDC:   process.env[`${prefix}TOKEN_USDC`]   || '',
            USDT:   process.env[`${prefix}TOKEN_USDT`]   || '',
            DAI:    process.env[`${prefix}TOKEN_DAI`]     || '',
            WBTC:   process.env[`${prefix}TOKEN_WBTC`]   || '',
            LORDS:  process.env[`${prefix}TOKEN_LORDS`]   || '',
            WSTETH: process.env[`${prefix}TOKEN_WSTETH`]  || '',
        };
    }

    /**
     * Resolve an array of currency symbols to contract addresses for the given network.
     *
     * @param {string[]} symbols — e.g. ['ETH', 'USDC']
     * @param {boolean} isLive
     * @returns {string[]} — contract addresses (unknown/empty symbols are skipped)
     */
    static resolveCurrencyAddresses(symbols, isLive = true) {
        const tokens = StarknetConfig.resolveTokens(isLive);
        const resolved = [];
        for (const sym of symbols) {
            const addr = tokens[sym.toUpperCase()];
            if (!addr) {
                console.warn(`[StarknetConfig] Unknown or unconfigured currency for ${isLive ? 'mainnet' : 'testnet'}: ${sym}`);
                continue;
            }
            resolved.push(addr);
        }
        return resolved;
    }

    /**
     * Quick label for logging.
     * @param {boolean} isLive
     * @returns {string}
     */
    static networkLabel(isLive) {
        return isLive ? 'MAINNET' : 'TESTNET';
    }
}

module.exports = StarknetConfig;
