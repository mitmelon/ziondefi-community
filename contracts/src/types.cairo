// SPDX-License-Identifier: MIT
// ZionDefi Protocol v2.0 — Shared Types
// All structs, enums, and constants used across the protocol.

use starknet::ContractAddress;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Maximum consecutive failed PIN attempts before lockout.
pub const MAX_FAILED_ATTEMPTS: u8 = 3;
/// Lockout duration in seconds after max failed PIN attempts.
pub const LOCKOUT_DURATION: u64 = 3600; // 1 hour
/// Minimum cooldown between successive charge operations (seconds).
pub const CHARGE_COOLDOWN: u64 = 30;
/// Max payment requests a single merchant may submit per rate-limit window.
pub const MERCHANT_REQUEST_LIMIT: u8 = 10;
/// Max payment approvals per rate-limit window.
pub const APPROVAL_LIMIT: u8 = 20;
/// Rate-limit sliding window in seconds.
pub const RATE_LIMIT_WINDOW: u64 = 3600;
/// Maximum allowed slippage in basis points (10%).
pub const MAX_SLIPPAGE: u16 = 1000;
/// Basis-point denominator.
pub const BASIS_POINTS: u256 = 10_000;
/// Seconds in one day.
pub const SECONDS_PER_DAY: u64 = 86_400;
/// Anomaly multiplier — if a charge exceeds largest_charge * this factor, auto-freeze.
pub const ANOMALY_MULTIPLIER: u256 = 3;
pub const DEFAULT_TRANSFER_DELAY: u64 = 1800; // 30 minutes [cite: 447]


// ============================================================================
// ENUMS
// ============================================================================

/// Lifecycle status of a card.
#[derive(Copy, Drop, Serde, starknet::Store, PartialEq)]
pub enum CardStatus {
   #[default]
    None,
    PendingActivation,
    Active,
    Frozen,
    Burned,
}

/// Determines how the card selects the source token for a payment.
/// - `MerchantTokenOnly` — user must hold the exact token the merchant requests.
/// - `AnyAcceptedToken`  — card may swap from any held token to the merchant token.
#[derive(Copy, Drop, Serde, starknet::Store, PartialEq)]
pub enum PaymentMode {
    #[default]
    None,
    MerchantTokenOnly,
    AnyAcceptedToken,
}

/// Status of a payment request through its lifecycle.
#[derive(Copy, Drop, Serde, starknet::Store, PartialEq)]
pub enum RequestStatus {
    #[default]
    None,
    /// Request has been submitted and awaits approval.
    Pending,
    /// Owner / relayer has approved the request.
    Approved,
    /// Owner / relayer has rejected the request.
    Rejected,
    /// Charge executed; funds reserved while settlement delay elapses.
    AwaitingSettlement,
    /// Settlement completed — merchant has been paid.
    Settled,
    /// Payment cancelled during settlement delay or due to freeze / blacklist.
    Cancelled,
    /// Approval revoked before charge.
    Revoked,
}

// ============================================================================
// STRUCTS — Card Domain
// ============================================================================

/// On-chain payment request submitted by a merchant.
#[derive(Drop, Serde, starknet::Store)]
pub struct PaymentRequest {
    pub request_id: u64,
    pub merchant: ContractAddress,
    /// Amount in the merchant's requested token (raw token units).
    pub amount: u256,
    /// Token the merchant wishes to receive.
    pub token: ContractAddress,
    pub is_recurring: bool,
    /// Seconds between each recurring charge (e.g. 86400 = daily, 604800 = weekly).
    /// Must be > 0 for recurring requests; zero for one-time payments.
    pub interval_seconds: u64,
    /// Unix timestamp — earliest the first charge may fire (set by biller). 0 = immediate.
    pub start_date: u64,
    /// Unix timestamp — subscription expiry; no charges accepted after this. 0 = no expiry.
    pub end_date: u64,
    pub status: RequestStatus,
    pub description: ByteArray,
    pub metadata: ByteArray,
    pub created_at: u64,
    pub approved_at: u64,
    pub last_charged_at: u64,
    pub charge_count: u32,
    /// Next charge due timestamp — always anchored to start_date.
    /// next_charge_at = start_date + charge_count * interval_seconds
    /// Scheduler queries this to know exactly when to fire charge_recurring.
    pub next_charge_at: u64,
}

/// Holds details of a pending settlement awaiting delay expiry.
#[derive(Copy, Drop, Serde, starknet::Store)]
pub struct SettlementInfo {
    pub request_id: u64,
    /// Net amount to send to the merchant after fees.
    pub amount_for_merchant: u256,
    /// Admin (ZionDefi) fee to transfer.
    pub admin_fee: u256,
    /// Cashback portion that was credited to the owner during charge.
    pub cashback: u256,
    /// The token that will be transferred at settlement.
    pub token: ContractAddress,
    /// Merchant payout wallet.
    pub payout_wallet: ContractAddress,
    pub merchant: ContractAddress,
    /// Timestamp at which settlement becomes processable.
    pub settle_at: u64,
    pub settled: bool,
    pub cancelled: bool,
    /// Whether a DEX swap was executed during the charge step.
    pub swap_occurred: bool,
    /// Source token if a swap was needed.
    pub token_in: ContractAddress,
    /// Swap fee paid to DEX.
    pub swap_fee: u256,
}

/// Immutable record of a completed transaction.
#[derive(Drop, Serde, starknet::Store)]
pub struct TransactionRecord {
    pub transaction_id: u64,
    pub request_id: u64,
    pub merchant: ContractAddress,
    pub payout_wallet: ContractAddress,
    pub amount: u256,
    pub token_in: ContractAddress,
    pub token_out: ContractAddress,
    pub swap_occurred: bool,
    pub swap_fee: u256,
    pub slippage_paid: u256,
    pub transaction_fee: u256,
    pub cashback_amount: u256,
    pub timestamp: u64,
    pub transaction_type: felt252,
}

/// Fraud detection alert.
#[derive(Drop, Serde, starknet::Store)]
pub struct FraudAlert {
    pub alert_id: u64,
    pub request_id: u64,
    pub merchant: ContractAddress,
    pub alert_type: felt252,
    pub severity: u8,
    pub message: ByteArray,
    pub timestamp: u64,
    pub auto_blocked: bool,
}

/// Lightweight fraud evaluation result (not stored).
#[derive(Drop, Serde)]
pub struct FraudScore {
    pub risk_level: u8,
    pub flags: Span<felt252>,
    pub recommendation: felt252,
}

/// Token balance snapshot.
#[derive(Drop, Serde)]
pub struct TokenBalance {
    pub token: ContractAddress,
    pub balance: u256,
    pub contract_balance: u256,
    pub last_updated: u64,
}

/// Aggregate balance summary returned to the owner.
#[derive(Drop, Serde)]
pub struct BalanceSummary {
    pub balances: Span<TokenBalance>,
    pub total_value_usd: u256,
}

/// Aggregate transaction summary for a time window.
#[derive(Drop, Serde)]
pub struct TransactionSummary {
    pub total_spent: u256,
    pub total_received: u256,
    pub total_cashback_earned: u256,
    pub total_swap_fees_paid: u256,
    pub total_tx_fees_charged: u256,
    pub transaction_count: u64,
    pub unique_merchants: u32,
    pub transactions: Span<TransactionRecord>,
}

/// Snapshot of rate-limit counters.
#[derive(Drop, Serde)]
pub struct RateLimitStatus {
    pub requests_submitted_last_hour: u8,
    pub approvals_last_hour: u8,
    pub last_charge_timestamp: u64,
    pub cooldown_remaining: u64,
}

/// Public card metadata.
#[derive(Drop, Serde)]
pub struct CardInfo {
    pub card_address: ContractAddress,
    pub owner: ContractAddress,
    pub relayer: ContractAddress,
    pub is_frozen: bool,
    pub is_burned: bool,
    pub created_at: u64,
    pub payment_mode: PaymentMode,
    pub slippage_tolerance_bps: u16,
    pub auto_approve_threshold_usd: u256,
    pub total_currencies: u32,

    //Comprehensive
    pub total_merchants: u64,
    pub total_transactions: u64,
    pub total_requests: u64,
    pub total_transfers: u64,
}

/// Initial configuration supplied at card creation.
#[derive(Drop, Serde, starknet::Store)]
pub struct CardConfig {
    pub max_transaction_amount: u256,
    pub daily_transaction_limit: u16,
    pub daily_spend_limit: u256,
    pub slippage_tolerance_bps: u16,
    pub transfer_delay: u64,
}

// ============================================================================
// STRUCTS — Factory / Protocol Domain
// ============================================================================

/// Global protocol configuration returned by the factory.
#[derive(Drop, Serde, Copy)]
pub struct ProtocolConfig {
    pub admin_wallet: ContractAddress,
    pub burn_fee: u256,
    pub transaction_fee_percent: u16,
    pub transaction_fee_cap: u256,
    pub user_cashback_percent: u8,
    pub avnu_router: ContractAddress,
}

/// Compact merchant reputation snapshot used by the card contract.
#[derive(Drop, Serde, Copy)]
pub struct MerchantReputation {
    pub reputation_score: u16,
    pub total_processed: u256,
}

/// Merchant info stored on the factory.
#[derive(Drop, Serde, starknet::Store)]
pub struct MerchantInfo {
    pub merchant_address: ContractAddress,
    pub payout_wallet: ContractAddress,
    pub business_name: ByteArray,
    pub contact_email: ByteArray,
    pub registered_at: u64,
    pub is_active: bool,
    pub kyc_verified: bool,
}

/// Full reputation tracking for a merchant on the factory.
#[derive(Copy, Drop, Serde, starknet::Store)]
pub struct MerchantReputationFull {
    pub total_transactions: u64,
    pub successful_transactions: u64,
    pub failed_transactions: u64,
    pub disputed_transactions: u64,
    pub total_volume: u256,
    pub blacklist_count: u32,
    pub reputation_score: u16,
    pub last_transaction: u64,
    pub cards_interacted: u32,
}

// ============================================================================
// STRUCTS — AVNU Swap
// ============================================================================

/// Off-chain quote supplied by the relayer for a DEX swap.
///
/// `routes` contains the **pre-serialized** AVNU v2 route data (including the
/// `Array<Route>` length prefix).  The relayer obtains this directly from the
/// AVNU API and passes it verbatim so the contract can forward it to the AVNU
/// Exchange contract via a low-level `call_contract_syscall`.
///
/// This avoids replicating AVNU's complex type hierarchy (Route → RouteSwap
/// enum → DirectSwap / BranchSwap with custom Serde) inside the ZionDefi
/// crate, and guarantees wire-format compatibility with any AVNU version.
#[derive(Copy, Drop, Serde)]
pub struct OffchainQuote {
    pub sell_token_address: ContractAddress,
    pub buy_token_address: ContractAddress,
    pub sell_amount: u256,
    pub buy_amount: u256,
    pub price_impact: u256,
    pub fee: AvnuFee,
    pub routes: Span<felt252>,
}

/// Fee breakdown in an AVNU quote.
#[derive(Copy, Drop, Serde)]
pub struct AvnuFee {
    pub fee_token: ContractAddress,
    pub avnu_fees: u256,
    pub avnu_fees_bps: u128,
    pub integrator_fees: u256,
    pub integrator_fees_bps: u128,
}