// SPDX-License-Identifier: MIT
// ZionDefi Protocol v1.0 — Price Oracle Utility
// Zero-config Pragma integration for token↔USD conversions.

use starknet::ContractAddress;
use starknet::get_block_timestamp;
use starknet::get_tx_info;
use core::num::traits::Zero;
use pragma_lib::abi::{IPragmaABIDispatcher, IPragmaABIDispatcherTrait};
use pragma_lib::types::DataType;

const SN_MAIN: felt252 = 0x534e5f4d41494e;       // 'SN_MAIN'
const SN_SEPOLIA: felt252 = 0x534e5f5345504f4c4941; // 'SN_SEPOLIA'

fn ORACLE_MAINNET() -> ContractAddress { 0x2a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b.try_into().unwrap() }
fn ORACLE_SEPOLIA() -> ContractAddress { 0x36031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a.try_into().unwrap() }


const PAIR_ETH_USD: felt252 = 19514442401534788;    // "ETH/USD"
const PAIR_BTC_USD: felt252 = 18669995996566340;    // "BTC/USD"
const PAIR_WBTC_USD: felt252 = 6287680677296296772; // "WBTC/USD"
const PAIR_STRK_USD: felt252 = 6004514686061859652; // "STRK/USD"
const PAIR_USDC_USD: felt252 = 6148332971638477636; // "USDC/USD"
const PAIR_USDT_USD: felt252 = 6148333044652917572; // "USDT/USD"
const PAIR_DAI_USD: felt252 = 192274655717179565;   // "DAI/USD"
const PAIR_LORDS_USD: felt252 = 1407668255603079598916; // "LORDS/USD"
const PAIR_WSTETH_USD: felt252 = 412383036120118613857092; // "WSTETH/USD"

// Fixed 1$ Feed (Gas Efficient for Stablecoins if preferred)
const PAIR_FIXED_USD: felt252 = 23917257655180781648846825458055798674244; // "FIXEDRESERVED/USD"

// --- MAINNET TOKENS ---
fn MAINNET_ETH() -> ContractAddress { 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7.try_into().unwrap() }
fn MAINNET_STRK() -> ContractAddress { 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d.try_into().unwrap() }
fn MAINNET_USDC() -> ContractAddress { 0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8.try_into().unwrap() }
fn MAINNET_USDT() -> ContractAddress { 0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8.try_into().unwrap() }
fn MAINNET_DAI() -> ContractAddress { 0x00da114221cb83fa859dbdb4c44beeaa0bb37c7537ad5ae66fe5e0efd20e6eb3.try_into().unwrap() }
fn MAINNET_WBTC() -> ContractAddress { 0x03fe2b97c1fd336e75df0850d7b18053bf81880454a942c41374827f27bd163f.try_into().unwrap() }
fn MAINNET_LORDS() -> ContractAddress { 0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49.try_into().unwrap() }
fn MAINNET_WSTETH() -> ContractAddress { 0x042b8f0484674ca266ac5d08e4ac6a3fe65bd3129795def2dca5c34ecc5f96d2.try_into().unwrap() }

// --- SEPOLIA TOKENS ---
fn SEPOLIA_ETH() -> ContractAddress { 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7.try_into().unwrap() }
fn SEPOLIA_STRK() -> ContractAddress { 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d.try_into().unwrap() }
fn SEPOLIA_USDCE() -> ContractAddress { 0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080.try_into().unwrap() }
fn SEPOLIA_USDC() -> ContractAddress { 0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343.try_into().unwrap() }

// Errors
const PRICE_STALE: felt252 = 'Oracle: Price Stale';
const INVALID_PRICE: felt252 = 'Oracle: Price Zero';

// Detects Chain and returns the correct Pragma Oracle Address
pub fn get_oracle_address() -> ContractAddress {
    let chain_id = get_tx_info().chain_id;
    if chain_id == SN_MAIN {
        return ORACLE_MAINNET();
    } else {
        // Default to Sepolia for safety if unknown (or actual Sepolia)
        return ORACLE_SEPOLIA();
    }
}

// Maps ANY token (Mainnet or Sepolia) to its Pragma Pair ID
pub fn resolve_pair_id(token: ContractAddress) -> felt252 {
    let chain_id = get_tx_info().chain_id;

    if chain_id == SN_MAIN {
        if token == MAINNET_ETH() { return PAIR_ETH_USD; }
        if token == MAINNET_WBTC() { return PAIR_BTC_USD; }
        if token == MAINNET_STRK() { return PAIR_STRK_USD; }
        if token == MAINNET_USDC() { return PAIR_USDC_USD; }
        if token == MAINNET_USDT() { return PAIR_USDT_USD; }
        if token == MAINNET_DAI() { return PAIR_DAI_USD; }
        if token == MAINNET_LORDS() { return PAIR_LORDS_USD; }
        if token == MAINNET_WSTETH() { return PAIR_WSTETH_USD; }
    } else {
        // SEPOLIA MAPPING
        if token == SEPOLIA_ETH() { return PAIR_ETH_USD; }
        if token == SEPOLIA_STRK() { return PAIR_STRK_USD; }
        if token == SEPOLIA_USDC() { return PAIR_USDC_USD; }
        if token == SEPOLIA_USDCE() { return PAIR_USDC_USD; }
    }

    0 // Unknown Token
}

/// Returns `true` when the token has a known Pragma price feed on the current chain.
pub fn is_token_supported(token: ContractAddress) -> bool {
    resolve_pair_id(token) != 0
}

// Fetch Price Helper (Auto-detects Oracle Address)
pub fn get_asset_price(pair_id: felt252) -> (u128, u32) {
    let oracle_addr = get_oracle_address();
    if oracle_addr.is_zero() || pair_id == 0 {
        return (0, 0);
    }

    let oracle = IPragmaABIDispatcher { contract_address: oracle_addr };
    
    // Get Spot Median Price
    let response = oracle.get_data_median(DataType::SpotEntry(pair_id));
    
    // Safety Checks (Return 0,0 instead of crashing if price is bad, let caller handle)
    if response.price == 0 { return (0,0); }
    
    let now = get_block_timestamp();
    // 1 hour freshness check
    // Relax for Fixed/Stable feeds if needed
    if pair_id != PAIR_FIXED_USD {
        if now > response.last_updated_timestamp + 3600 {
            return (0,0); // Stale
        }
    }

    (response.price, response.decimals)
}

// SMART CONVERTER
pub fn convert_usd_to_token_auto(
    token: ContractAddress, 
    usd_amount: u256, 
    manual_pair_id: felt252 
) -> u256 {
    // 1. Try Auto-Resolve
    let mut pair_id = resolve_pair_id(token);
    
    // 2. Fallback to manual override
    if pair_id == 0 {
        pair_id = manual_pair_id;
    }

    if pair_id == 0 { return 0; }

    let (price, price_decimals) = get_asset_price(pair_id);
    
    if price == 0 { return 0; }

    // Get Token Decimals via ERC20 metadata
    let token_decimals = _get_token_decimals(token);

    // Math: (TargetUSD * 10^PriceDecimals * 10^TokenDecimals) / Price
    let price_u256: u256 = price.into();
    let p_decimals_pow = _pow(10, price_decimals);
    let t_decimals_pow = _pow(10, token_decimals.into());

    let numerator = usd_amount * p_decimals_pow * t_decimals_pow;
    let token_amount = numerator / price_u256;

    token_amount
}

// Converts a Token Amount (e.g. 0.5 ETH) into USD (e.g. 1500)
// Returns USD with 8 decimals (standard for Pragma)
pub fn convert_token_to_usd_auto(
    token: ContractAddress, 
    token_amount: u256, 
    manual_pair_id: felt252
) -> u256 {
    // 1. Resolve Pair
    let mut pair_id = resolve_pair_id(token);
    if pair_id == 0 { pair_id = manual_pair_id; }
    if pair_id == 0 { return 0; }

    // 2. Get Price
    let (price, _price_decimals) = get_asset_price(pair_id);
    if price == 0 { return 0; }

    // 3. Get Token Decimals via ERC20 metadata
    let token_decimals = _get_token_decimals(token);

    // 4. Math: (Amount * Price) / 10^TokenDecimals
    // Result matches Price Decimals (usually 8)
    let price_u256: u256 = price.into();
    let t_decimals_pow = _pow(10, token_decimals.into());

    // Formula: (TokenAmount * Price) / TokenDecimals
    let usd_value = (token_amount * price_u256) / t_decimals_pow;
    
    usd_value
}

// Internal Math Helper
fn _pow(base: u256, exp: u32) -> u256 {
    let mut res = 1_u256;
    let mut i = 0;
    loop {
        if i == exp { break; }
        res = res * base;
        i += 1;
    };
    res
}

// Internal helper to get token decimals via a minimal interface
#[starknet::interface]
trait IERC20Decimals<TContractState> {
    fn decimals(self: @TContractState) -> u8;
}

fn _get_token_decimals(token: ContractAddress) -> u8 {
    let d = IERC20DecimalsDispatcher { contract_address: token };
    d.decimals()
}