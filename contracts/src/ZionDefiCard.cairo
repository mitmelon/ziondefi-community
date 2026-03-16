// SPDX-License-Identifier: MIT
// ZionDefi Protocol v1.0 — Card (Vault) Contract
// Smart wallet with ECDSA PIN verification, multi-currency support,
// transfer delays (manual only), and anomaly detection.

#[starknet::contract]
mod ZionDefiCard {
    use core::num::traits::Zero;
    use starknet::{
        ContractAddress, ClassHash,
        get_caller_address, get_block_timestamp, get_contract_address
    };
    use starknet::storage::{
        Map, StoragePointerReadAccess, StoragePointerWriteAccess,
        StoragePathEntry,
    };

    use openzeppelin_security::reentrancyguard::ReentrancyGuardComponent;
    use openzeppelin_upgrades::UpgradeableComponent;
    use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};

    use ziondefi::types::{
        CardStatus, PaymentMode, RequestStatus, PaymentRequest, SettlementInfo,
        TransactionRecord, FraudAlert, TokenBalance, BalanceSummary,
        TransactionSummary, RateLimitStatus, CardInfo, CardConfig,
        OffchainQuote,
        CHARGE_COOLDOWN,
        MERCHANT_REQUEST_LIMIT, APPROVAL_LIMIT,
        RATE_LIMIT_WINDOW, MAX_SLIPPAGE, BASIS_POINTS, SECONDS_PER_DAY,
        ANOMALY_MULTIPLIER,
    };
    use ziondefi::interfaces::{
        IZionDefiFactoryDispatcher, IZionDefiFactoryDispatcherTrait,
    };
    use ziondefi::Price_Oracle;
    use ziondefi::pin_component::PinComponent;

    component!(path: ReentrancyGuardComponent, storage: reentrancy, event: ReentrancyEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(path: PinComponent, storage: pin, event: PinEvent);

    impl ReentrancyInternalImpl = ReentrancyGuardComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;
    impl PinInternalImpl = PinComponent::PinInternalImpl<ContractState>;
    impl PinImpl = PinComponent::PinImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        reentrancy: ReentrancyGuardComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        #[substorage(v0)]
        pin: PinComponent::Storage,
        owner: ContractAddress,
        authorized_relayer: ContractAddress,
        factory: ContractAddress,
        status: CardStatus,
        created_at: u64,
        accepted_currencies: Map<u32, ContractAddress>,
        currency_count: u32,
        is_currency_accepted: Map<ContractAddress, bool>,
        payment_mode: PaymentMode,
        slippage_tolerance_bps: u16,
        token_balances: Map<ContractAddress, u256>,
        last_balance_sync: Map<ContractAddress, u64>,
        token_price_feed_ids: Map<ContractAddress, felt252>,
        max_transaction_amount: u256,
        daily_transaction_limit: u16,
        daily_spend_limit: u256,
        daily_transaction_count: u16,
        daily_spend_amount: u256,
        last_daily_reset: u64,
        auto_approve_threshold_usd: u256,
        merchant_spend_limit: Map<ContractAddress, u256>,
        request_counter: u64,
        payment_requests: Map<u64, PaymentRequest>,
        request_status: Map<u64, RequestStatus>,
        request_to_transaction_id: Map<u64, u64>,
        settlements: Map<u64, SettlementInfo>,
        merchant_blacklist: Map<ContractAddress, bool>,
        merchant_blacklist_reason: Map<ContractAddress, ByteArray>,
        merchant_interactions: Map<ContractAddress, bool>,
        merchant_count: u64,
        merchant_request_count: Map<ContractAddress, u8>,
        merchant_last_request_reset: Map<ContractAddress, u64>,
        approval_count: u8,
        approval_last_reset: u64,
        last_charge_timestamp: u64,
        transaction_counter: u64,
        transactions: Map<u64, TransactionRecord>,
        fraud_alerts: Map<u64, FraudAlert>,
        fraud_alert_count: u64,
        largest_charge_amount: u256,
        idempotency_keys: Map<felt252, bool>,
        deployment_fee_usd: u256,
        deployment_fee_remaining_usd: u256,
        deployment_fee_paid: bool,
        transfer_delay: u64,
        pending_transfers: Map<u64, SettlementInfo>,
        transfer_counter: u64,
        relayer_yield_access: Map<ContractAddress, bool>,
        extra_relayers: Map<ContractAddress, bool>,
        relayer_list: Map<u32, ContractAddress>,
        relayer_count: u32,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat] ReentrancyEvent: ReentrancyGuardComponent::Event,
        #[flat] UpgradeableEvent: UpgradeableComponent::Event,
        #[flat] PinEvent: PinComponent::Event,
        CardInitialized: CardInitialized,
        CardFrozen: CardFrozen,
        CardUnfrozen: CardUnfrozen,
        CardBurned: CardBurned,
        RelayerAdded: RelayerAdded,
        RelayerRevoked: RelayerRevoked,
        CurrencyAdded: CurrencyAdded,
        CurrencyRemoved: CurrencyRemoved,
        ConfigUpdated: ConfigUpdated,
        PaymentRequestSubmitted: PaymentRequestSubmitted,
        PaymentAutoApproved: PaymentAutoApproved,
        PaymentRequestApproved: PaymentRequestApproved,
        PaymentRequestRejected: PaymentRequestRejected,
        PaymentApprovalRevoked: PaymentApprovalRevoked,
        CardCharged: CardCharged,
        SwapExecuted: SwapExecuted,
        MerchantBlacklisted: MerchantBlacklisted,
        MerchantUnblacklisted: MerchantUnblacklisted,
        LimitsUpdated: LimitsUpdated,
        AnomalyDetected: AnomalyDetected,
        DeploymentFeePaid: DeploymentFeePaid,
        DeploymentFeePartialPayment: DeploymentFeePartialPayment,
        CardActivated: CardActivated,
        RelayerYieldAccessGranted: RelayerYieldAccessGranted,
        RelayerYieldAccessRevoked: RelayerYieldAccessRevoked,
    }

    #[derive(Drop, starknet::Event)]
    struct CardInitialized { #[key] owner: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct CardFrozen { timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct CardUnfrozen { timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct CardBurned { #[key] owner: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct RelayerAdded { #[key] relayer: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct RelayerRevoked { #[key] relayer: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct CurrencyAdded { #[key] token: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct CurrencyRemoved { #[key] token: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct ConfigUpdated { key: felt252, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct PaymentRequestSubmitted { #[key] request_id: u64, #[key] merchant: ContractAddress, amount: u256, token: ContractAddress, is_recurring: bool, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct PaymentAutoApproved { #[key] request_id: u64, amount_usd: u256, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct PaymentRequestApproved { #[key] request_id: u64, #[key] merchant: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct PaymentRequestRejected { #[key] request_id: u64, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct PaymentApprovalRevoked { #[key] request_id: u64, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct CardCharged { #[key] request_id: u64, #[key] merchant: ContractAddress, amount: u256, token_in: ContractAddress, token_out: ContractAddress, swap_occurred: bool, settle_at: u64, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct SwapExecuted { token_in: ContractAddress, token_out: ContractAddress, amount_in: u256, amount_out: u256, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct MerchantBlacklisted { #[key] merchant: ContractAddress, reason: ByteArray, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct MerchantUnblacklisted { #[key] merchant: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct LimitsUpdated { max_tx: u256, daily_tx_limit: u16, daily_spend: u256, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct AnomalyDetected { #[key] request_id: u64, amount_usd: u256, threshold: u256, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct DeploymentFeePaid { token: ContractAddress, amount_in_token: u256, fee_usd: u256, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct DeploymentFeePartialPayment { token: ContractAddress, amount_in_token: u256, paid_usd: u256, remaining_usd: u256, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct CardActivated { #[key] owner: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct RelayerYieldAccessGranted { #[key] token: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct RelayerYieldAccessRevoked { #[key] token: ContractAddress, timestamp: u64 }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        authorized_relayer: ContractAddress,
        pin_public_key: felt252,
        accepted_currencies: Span<ContractAddress>,
        payment_mode: PaymentMode,
        initial_config: CardConfig,
        deployment_fee_usd: u256,
    ) {
        assert(!owner.is_zero(), 'Invalid owner');
        assert(!authorized_relayer.is_zero(), 'Invalid relayer');
        assert(pin_public_key != 0, 'Invalid PIN key');
        assert(accepted_currencies.len() > 0, 'No currencies');

        self.owner.write(owner);
        self.authorized_relayer.write(authorized_relayer);
        self.factory.write(get_caller_address());
        self.deployment_fee_usd.write(deployment_fee_usd);
        self.deployment_fee_remaining_usd.write(deployment_fee_usd);
        self.deployment_fee_paid.write(false);
        self.status.write(CardStatus::PendingActivation);
        let ts = get_block_timestamp();
        self.created_at.write(ts);
        self.pin._register_pin_for(owner, pin_public_key);
        self.payment_mode.write(payment_mode);
        self.slippage_tolerance_bps.write(initial_config.slippage_tolerance_bps);
        let mut i: u32 = 0;
        loop {
            if i >= accepted_currencies.len() { break; }
            let token = *accepted_currencies.at(i);
            assert(!token.is_zero(), 'Invalid currency');
            self.accepted_currencies.entry(i).write(token);
            self.is_currency_accepted.entry(token).write(true);
            i += 1;
        };
        self.currency_count.write(i);
        self.max_transaction_amount.write(initial_config.max_transaction_amount);
        self.daily_transaction_limit.write(initial_config.daily_transaction_limit);
        self.daily_spend_limit.write(initial_config.daily_spend_limit);
        self.last_daily_reset.write(ts);
        self.transfer_delay.write(initial_config.transfer_delay);

        self.emit(CardInitialized { owner, timestamp: ts });
        
    }

    #[abi(embed_v0)]
    impl ZionDefiCardImpl of ziondefi::interfaces::IZionDefiCard<ContractState> {

        fn add_accepted_currency(ref self: ContractState, token: ContractAddress, sig_r: felt252, sig_s: felt252) {
            self._assert_active();
            self._assert_owner_pin(sig_r, sig_s);
            assert(!token.is_zero(), 'Invalid token');
            let factory = IZionDefiFactoryDispatcher { contract_address: self.factory.read() };
            assert(factory.is_token_accepted(token), 'Token not in factory');
            if !self.is_currency_accepted.entry(token).read() {
                let count = self.currency_count.read();
                self.accepted_currencies.entry(count).write(token);
                self.is_currency_accepted.entry(token).write(true);
                self.currency_count.write(count + 1);
                self.emit(CurrencyAdded { token, timestamp: get_block_timestamp() });
            }
        }

        fn remove_accepted_currency(ref self: ContractState, token: ContractAddress, sig_r: felt252, sig_s: felt252) {
            self._assert_active();
            self._assert_owner_pin(sig_r, sig_s);
            self.is_currency_accepted.entry(token).write(false);
            self.emit(CurrencyRemoved { token, timestamp: get_block_timestamp() });
        }

        fn update_payment_mode(ref self: ContractState, new_mode: PaymentMode, sig_r: felt252, sig_s: felt252) {
            self._assert_active();
            self._assert_owner_pin(sig_r, sig_s);
            self.payment_mode.write(new_mode);
            self.emit(ConfigUpdated { key: 'payment_mode', timestamp: get_block_timestamp() });
        }

        fn set_slippage_tolerance(ref self: ContractState, tolerance_bps: u16, sig_r: felt252, sig_s: felt252) {
            self._assert_active();
            assert(tolerance_bps <= MAX_SLIPPAGE, 'Slippage too high');
            self._assert_owner_pin(sig_r, sig_s);
            self.slippage_tolerance_bps.write(tolerance_bps);
            self.emit(ConfigUpdated { key: 'slippage', timestamp: get_block_timestamp() });
        }

        fn set_auto_approve_threshold(ref self: ContractState, threshold_usd: u256, sig_r: felt252, sig_s: felt252) {
            self._assert_active();
            self._assert_owner_pin(sig_r, sig_s);
            self.auto_approve_threshold_usd.write(threshold_usd);
            self.emit(ConfigUpdated { key: 'auto_approve', timestamp: get_block_timestamp() });
        }

        fn update_spending_limits(
            ref self: ContractState,
            max_tx_amount: u256,
            daily_tx_limit: u16,
            daily_spend_limit: u256,
            sig_r: felt252,
            sig_s: felt252,
        ) {
            self._assert_active();
            self._assert_owner_pin(sig_r, sig_s);
            self.max_transaction_amount.write(max_tx_amount);
            self.daily_transaction_limit.write(daily_tx_limit);
            self.daily_spend_limit.write(daily_spend_limit);
            self.emit(LimitsUpdated { max_tx: max_tx_amount, daily_tx_limit, daily_spend: daily_spend_limit, timestamp: get_block_timestamp() });
        }

        fn set_merchant_spend_limit(ref self: ContractState, merchant: ContractAddress, max_amount_usd: u256, sig_r: felt252, sig_s: felt252) {
            self._assert_active();
            self._assert_owner_pin(sig_r, sig_s);
            self.merchant_spend_limit.entry(merchant).write(max_amount_usd);
            self.emit(ConfigUpdated { key: 'merchant_limit', timestamp: get_block_timestamp() });
        }

        fn remove_merchant_spend_limit(ref self: ContractState, merchant: ContractAddress, sig_r: felt252, sig_s: felt252) {
            self._assert_active();
            self._assert_owner_pin(sig_r, sig_s);
            self.merchant_spend_limit.entry(merchant).write(0);
            self.emit(ConfigUpdated { key: 'merchant_limit', timestamp: get_block_timestamp() });
        }

        fn set_token_price_feed(ref self: ContractState, token: ContractAddress, pair_id: felt252, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            self.token_price_feed_ids.entry(token).write(pair_id);
        }

        fn add_relayer(ref self: ContractState, new_relayer: ContractAddress, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            assert(!new_relayer.is_zero(), 'Invalid relayer');
            assert(!self.extra_relayers.entry(new_relayer).read(), 'Already a relayer');
            assert(new_relayer != self.authorized_relayer.read(), 'Already primary relayer');
            let idx = self.relayer_count.read();
            self.relayer_list.entry(idx).write(new_relayer);
            self.relayer_count.write(idx + 1);
            self.extra_relayers.entry(new_relayer).write(true);
            self.emit(RelayerAdded { relayer: new_relayer, timestamp: get_block_timestamp() });
        }

        fn revoke_relayer(ref self: ContractState, relayer: ContractAddress, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            assert(relayer != self.authorized_relayer.read(), 'Cannot revoke primary relayer');
            self.extra_relayers.entry(relayer).write(false);
            self.emit(RelayerRevoked { relayer, timestamp: get_block_timestamp() });
        }

        fn is_extra_relayer(self: @ContractState, relayer: ContractAddress) -> bool {
            self.extra_relayers.entry(relayer).read()
        }

        fn get_relayers(self: @ContractState) -> Span<ContractAddress> {
            let mut out: Array<ContractAddress> = ArrayTrait::new();
            out.append(self.authorized_relayer.read());
            let count = self.relayer_count.read();
            let mut i: u32 = 0;
            loop {
                if i >= count { break; }
                let addr = self.relayer_list.entry(i).read();
                if self.extra_relayers.entry(addr).read() {
                    out.append(addr);
                }
                i += 1;
            };
            out.span()
        }

        fn submit_payment_request(
            ref self: ContractState,
            merchant: ContractAddress,
            amount: u256,
            token: ContractAddress,
            is_recurring: bool,
            /// Seconds between charges.
            /// Pass 0 to request calendar-monthly billing (charged same day-of-month
            /// each month; February is clamped — e.g. Jan 31 → Feb 28/29, not Mar 2).
            /// Any positive value is a fixed interval in seconds (e.g. 604800 = weekly).
            interval_seconds: u64,
            /// Unix timestamp of the first allowed charge (required when is_recurring = true).
            start_date: u64,
            /// Unix timestamp after which no charges are accepted. 0 = no expiry.
            end_date: u64,
            description: ByteArray,
            metadata: ByteArray,
        ) -> u64 {
            self.reentrancy.start();
            self._assert_not_frozen();
            assert(amount > 0, 'Zero amount');
            assert(!merchant.is_zero(), 'Invalid merchant');
            assert(!token.is_zero(), 'Invalid token');
            let ts = get_block_timestamp();
            if is_recurring {
                // interval_seconds == 0 → calendar-monthly (same day-of-month each month).
                // interval_seconds  > 0 → fixed interval in seconds.
                assert(start_date > 0, 'Start date required');
                assert(start_date >= ts, 'Start date in past');
                if end_date > 0 { assert(end_date > start_date, 'End before start'); }
            }

            let factory = IZionDefiFactoryDispatcher { contract_address: self.factory.read() };
            assert(factory.is_merchant_registered(merchant), 'Merchant not registered');
            assert(factory.is_merchant_active(merchant), 'Merchant not active');
            assert(!factory.is_merchant_globally_blacklisted(merchant), 'Merchant globally blocked');
            assert(!self.merchant_blacklist.entry(merchant).read(), 'Merchant blacklisted');
            self._check_merchant_rate_limit(merchant);
            assert(self.is_currency_accepted.entry(token).read(), 'Currency not accepted');

            let m_limit = self.merchant_spend_limit.entry(merchant).read();
            if m_limit > 0 {
                let manual_id = self.token_price_feed_ids.entry(token).read();
                let amount_usd = Price_Oracle::convert_token_to_usd_auto(token, amount, manual_id);
                if amount_usd > 0 { assert(amount_usd <= m_limit, 'Exceeds merchant limit'); }
            }

            let max_tx = self.max_transaction_amount.read();
            if max_tx > 0 {
                let manual_id = self.token_price_feed_ids.entry(token).read();
                let amount_usd = Price_Oracle::convert_token_to_usd_auto(token, amount, manual_id);
                if amount_usd > 0 { assert(amount_usd <= max_tx, 'Exceeds max tx amount'); }
            }

            assert(self._has_any_balance(), 'No funds');

            let request_id = self.request_counter.read() + 1;
            self.request_counter.write(request_id);

            let threshold = self.auto_approve_threshold_usd.read();
            let mut initial_status = RequestStatus::Pending;
            let mut approved_at: u64 = 0;
            if threshold > 0 {
                let manual_id = self.token_price_feed_ids.entry(token).read();
                let amount_usd = Price_Oracle::convert_token_to_usd_auto(token, amount, manual_id);
                if amount_usd > 0 && amount_usd <= threshold {
                    initial_status = RequestStatus::Approved;
                    approved_at = ts;
                    self.emit(PaymentAutoApproved { request_id, amount_usd, timestamp: ts });
                }
            }

            let request = PaymentRequest {
                request_id, merchant, amount, token, is_recurring,
                interval_seconds, start_date, end_date,
                status: initial_status,
                description: description.clone(),
                metadata,
                created_at: ts, approved_at, last_charged_at: 0, charge_count: 0,
                // First charge is due at start_date (biller-defined).
                // 0 means immediately chargeable (only valid for non-recurring).
                next_charge_at: start_date,
            };
            self.payment_requests.entry(request_id).write(request);
            self.request_status.entry(request_id).write(initial_status);

            if !self.merchant_interactions.entry(merchant).read() {
                self.merchant_interactions.entry(merchant).write(true);

                let current_count = self.merchant_count.read();
                self.merchant_count.write(current_count + 1);
            }

            self.emit(PaymentRequestSubmitted { request_id, merchant, amount, token, is_recurring, timestamp: ts });
            self.reentrancy.end();
            request_id
        }

        fn approve_payment_request(ref self: ContractState, request_id: u64, sig_r: felt252, sig_s: felt252) {
            self._assert_not_frozen();
            self._assert_owner_pin(sig_r, sig_s);
            self._check_approval_rate_limit();

            let mut req = self.payment_requests.entry(request_id).read();
            assert(req.request_id != 0, 'Request not found');
            assert(req.status == RequestStatus::Pending, 'Not pending');

            let ts = get_block_timestamp();
            req.status = RequestStatus::Approved;
            req.approved_at = ts;
            let merchant = req.merchant;
            self.payment_requests.entry(request_id).write(req);
            self.request_status.entry(request_id).write(RequestStatus::Approved);
            self.emit(PaymentRequestApproved { request_id, merchant, timestamp: ts });
        }

        fn approve_multiple_requests(ref self: ContractState, request_ids: Span<u64>, sig_r: felt252, sig_s: felt252) {
            self._assert_not_frozen();
            self._assert_owner_pin(sig_r, sig_s);
            assert(request_ids.len() <= 10, 'Max 10 requests');

            let mut rl: u32 = 0;
            loop {
                if rl >= request_ids.len() { break; }
                self._check_approval_rate_limit();
                rl += 1;
            };

            let ts = get_block_timestamp();
            let mut i: u32 = 0;
            loop {
                if i >= request_ids.len() { break; }
                let rid = *request_ids.at(i);
                let mut req = self.payment_requests.entry(rid).read();
                let merchant = req.merchant;
                let is_bl = self.merchant_blacklist.entry(merchant).read();
                if req.request_id != 0 && req.status == RequestStatus::Pending && !is_bl {
                    req.status = RequestStatus::Approved;
                    req.approved_at = ts;
                    self.payment_requests.entry(rid).write(req);
                    self.request_status.entry(rid).write(RequestStatus::Approved);
                    self.emit(PaymentRequestApproved { request_id: rid, merchant, timestamp: ts });
                }
                i += 1;
            };
        }

        fn reject_payment_request(ref self: ContractState, request_id: u64, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            let mut req = self.payment_requests.entry(request_id).read();
            assert(req.request_id != 0, 'Request not found');
            assert(req.status == RequestStatus::Pending, 'Not pending');
            req.status = RequestStatus::Rejected;
            self.payment_requests.entry(request_id).write(req);
            self.request_status.entry(request_id).write(RequestStatus::Rejected);
            self.emit(PaymentRequestRejected { request_id, timestamp: get_block_timestamp() });
        }

        fn revoke_payment_approval(ref self: ContractState, request_id: u64, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            let mut req = self.payment_requests.entry(request_id).read();
            assert(req.request_id != 0, 'Request not found');
            assert(req.status == RequestStatus::Approved, 'Not approved');
            req.status = RequestStatus::Revoked;
            self.payment_requests.entry(request_id).write(req);
            self.request_status.entry(request_id).write(RequestStatus::Revoked);
            self.emit(PaymentApprovalRevoked { request_id, timestamp: get_block_timestamp() });
        }

        fn charge_card(
            ref self: ContractState,
            request_id: u64,
            idempotency_key: felt252,
            quote: Option<OffchainQuote>,
            slippage_tolerance_bps: u16,
            deadline: u64,
        ) {
            let mut req = self.payment_requests.entry(request_id).read();
            assert(!req.is_recurring, 'Use charge_recurring');
            self._execute_charge(request_id, idempotency_key, quote, slippage_tolerance_bps, deadline, false);
        }

        fn charge_recurring(
            ref self: ContractState,
            request_id: u64,
            idempotency_key: felt252,
            quote: Option<OffchainQuote>,
            slippage_tolerance_bps: u16,
            deadline: u64,
        ) {
            let req = self.payment_requests.entry(request_id).read();
            assert(req.is_recurring, 'Not recurring');
            let now = get_block_timestamp();
            // Enforce biller-defined subscription window
            if req.start_date > 0 {
                assert(now >= req.start_date, 'Before subscription start');
            }
            if req.end_date > 0 {
                assert(now <= req.end_date, 'Subscription expired');
            }
            // next_charge_at is always anchored to start_date — no drift even if relayer fires late
            if req.next_charge_at > 0 {
                assert(now >= req.next_charge_at, 'Too soon');
            }
            self._execute_charge(request_id, idempotency_key, quote, slippage_tolerance_bps, deadline, true);
        }

        fn transfer_funds(
            ref self: ContractState,
            token: ContractAddress,
            to: ContractAddress,
            amount: u256,
            sig_r: felt252,
            sig_s: felt252
        ) -> u64 {
            self.reentrancy.start();
            self._assert_not_frozen();
            let caller = get_caller_address();
            let is_relayer_yield = (caller == self.authorized_relayer.read() || self.extra_relayers.entry(caller).read())
                && self.relayer_yield_access.entry(token).read();
            if !is_relayer_yield {
                self._assert_owner_pin(sig_r, sig_s);
            }
            
            assert(amount > 0, 'Zero amount');
            assert(!to.is_zero(), 'Invalid recipient');
            
            let this_contract = get_contract_address();

            let actual_bal = IERC20Dispatcher { contract_address: token }.balance_of(this_contract);
            self.token_balances.entry(token).write(actual_bal);

            assert(actual_bal >= amount, 'Insufficient balance');
            
            self.token_balances.entry(token).write(actual_bal - amount); 
            
            let request_id = self.request_counter.read() + 1;
            self.request_counter.write(request_id);
            
            let ts = get_block_timestamp();
            let delay = self.transfer_delay.read(); 
            let settle_at = ts + delay;

            let transfer_info = SettlementInfo {
                request_id,
                amount_for_merchant: amount,
                admin_fee: 0,
                cashback: 0,
                token,
                payout_wallet: to,
                merchant: self.owner.read(),
                settle_at,
                settled: false,
                cancelled: false,
                swap_occurred: false,
                token_in: token,
                swap_fee: 0,
            };
            
            self.settlements.entry(request_id).write(transfer_info);
            self.request_status.entry(request_id).write(RequestStatus::AwaitingSettlement);
            
            self._deduct_micro_debt(token, amount);
            
            self.reentrancy.end();
            request_id
        }

        fn finalize_transfer(ref self: ContractState, transfer_id: u64, sig_r: felt252, sig_s: felt252) {
            self.reentrancy.start();
            self._assert_not_frozen();

            let mut info = self.settlements.entry(transfer_id).read();
            assert(info.request_id != 0, 'Transfer not found');

            let caller = get_caller_address();
            let is_relayer_yield = (caller == self.authorized_relayer.read() || self.extra_relayers.entry(caller).read())
                && self.relayer_yield_access.entry(info.token).read();
            if !is_relayer_yield {
                self._assert_owner_pin(sig_r, sig_s);
            }

            assert(!info.settled && !info.cancelled, 'Already processed');
            assert(get_block_timestamp() >= info.settle_at, 'Delay not elapsed');

            info.settled = true;
            self.settlements.entry(transfer_id).write(info);
            
            let d = IERC20Dispatcher { contract_address: info.token };
            assert(d.transfer(info.payout_wallet, info.amount_for_merchant), 'Transfer failed');
            
            self.request_status.entry(transfer_id).write(RequestStatus::Settled);
            self.reentrancy.end();
        }

        fn cancel_transfer(ref self: ContractState, transfer_id: u64, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            let mut info = self.settlements.entry(transfer_id).read();
            assert(info.request_id != 0, 'Transfer not found');
            assert(!info.settled && !info.cancelled, 'Finalized or already cancelled');

            let bal = self.token_balances.entry(info.token).read();
            self.token_balances.entry(info.token).write(bal + info.amount_for_merchant);
            
            info.cancelled = true;
            self.settlements.entry(transfer_id).write(info);
            self.request_status.entry(transfer_id).write(RequestStatus::Cancelled);
        }

        fn update_transfer_delay(ref self: ContractState, new_delay: u64, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            assert(new_delay <= 86400, 'Delay exceeds 24h');
            self.transfer_delay.write(new_delay);
        }

        fn grant_relayer_yield_access(ref self: ContractState, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            let count = self.currency_count.read();
            let ts = get_block_timestamp();
            let mut i: u32 = 0;
            loop {
                if i >= count { break; }
                let token = self.accepted_currencies.entry(i).read();
                if self.is_currency_accepted.entry(token).read() {
                    self.relayer_yield_access.entry(token).write(true);
                    self.emit(RelayerYieldAccessGranted { token, timestamp: ts });
                }
                i += 1;
            };
        }

        fn revoke_relayer_yield_access(ref self: ContractState, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            let count = self.currency_count.read();
            let ts = get_block_timestamp();
            let mut i: u32 = 0;
            loop {
                if i >= count { break; }
                let token = self.accepted_currencies.entry(i).read();
                if self.is_currency_accepted.entry(token).read() {
                    self.relayer_yield_access.entry(token).write(false);
                    self.emit(RelayerYieldAccessRevoked { token, timestamp: ts });
                }
                i += 1;
            };
        }

        fn is_relayer_yield_access_granted(self: @ContractState, token: ContractAddress) -> bool {
            self.relayer_yield_access.entry(token).read()
        }

        fn get_transfer_delay(self: @ContractState) -> u64 {
            self.transfer_delay.read()
        }

        fn get_request_counter(self: @ContractState) -> u64 {
            self.request_counter.read()
        }

        fn add_merchant_to_blacklist(ref self: ContractState, merchant: ContractAddress, reason: ByteArray, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            self.merchant_blacklist.entry(merchant).write(true);
            self.merchant_blacklist_reason.entry(merchant).write(reason.clone());
            let factory = IZionDefiFactoryDispatcher { contract_address: self.factory.read() };
            factory.increment_merchant_blacklist_count(merchant);
            self.emit(MerchantBlacklisted { merchant, reason, timestamp: get_block_timestamp() });
        }

        fn remove_merchant_from_blacklist(ref self: ContractState, merchant: ContractAddress, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            self.merchant_blacklist.entry(merchant).write(false);
            self.emit(MerchantUnblacklisted { merchant, timestamp: get_block_timestamp() });
        }

        fn freeze_card(ref self: ContractState, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            let status = self.status.read();
            assert(status != CardStatus::Frozen, 'Already frozen');
            assert(status != CardStatus::Burned, 'Card burned');
            self.status.write(CardStatus::Frozen);
            self.emit(CardFrozen { timestamp: get_block_timestamp() });
        }

        fn unfreeze_card(ref self: ContractState, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            assert(self.status.read() == CardStatus::Frozen, 'Not frozen');
            if self.deployment_fee_paid.read() {
                self.status.write(CardStatus::Active);
            } else {
                self.status.write(CardStatus::PendingActivation);
            }
            self.emit(CardUnfrozen { timestamp: get_block_timestamp() });
        }

        fn burn_card(ref self: ContractState, sig_r: felt252, sig_s: felt252) {
            self.reentrancy.start();
            self._assert_owner_pin(sig_r, sig_s);
            assert(self.status.read() != CardStatus::Burned, 'Already burned');
            let owner = self.owner.read();
            let factory = IZionDefiFactoryDispatcher { contract_address: self.factory.read() };
            let config = factory.get_protocol_config();

            let this_contract = get_contract_address();
            let burn_fee_usd = config.burn_fee;
            let mut fee_paid = false;
            let count = self.currency_count.read();
            
            let mut i: u32 = 0;
            loop {
                if i >= count || fee_paid { break; }
                let token = self.accepted_currencies.entry(i).read();
                
                let d = IERC20Dispatcher { contract_address: token };
                let real_bal = d.balance_of(this_contract);
                
                let manual_id = self.token_price_feed_ids.entry(token).read();
                let fee_in_token = Price_Oracle::convert_usd_to_token_auto(token, burn_fee_usd, manual_id);
                
                if fee_in_token > 0 && real_bal >= fee_in_token {
                    if d.transfer(config.admin_wallet, fee_in_token) {
                        let tracked_bal = self.token_balances.entry(token).read();
                        if tracked_bal >= fee_in_token {
                            self.token_balances.entry(token).write(tracked_bal - fee_in_token);
                        } else {
                            self.token_balances.entry(token).write(0);
                        }
                        fee_paid = true;
                    }
                }
                i += 1;
            };
            assert(fee_paid, 'No balance for burn fee');
            let mut j: u32 = 0;
            loop {
                if j >= count { break; }
                let token = self.accepted_currencies.entry(j).read();
                
                let d = IERC20Dispatcher { contract_address: token };
                let real_bal = d.balance_of(this_contract);
                
                if real_bal > 0 {
                    self.token_balances.entry(token).write(0);
                    d.transfer(owner, real_bal);
                }
                j += 1;
            };

            self.owner.write(Zero::zero());
            self.authorized_relayer.write(Zero::zero());
            self.status.write(CardStatus::Burned);
            self.emit(CardBurned { owner, timestamp: get_block_timestamp() });
            self.reentrancy.end();
        }

        fn get_accepted_currencies(self: @ContractState) -> Span<ContractAddress> {
            let count = self.currency_count.read();
            let mut out = ArrayTrait::new();
            let mut i: u32 = 0;
            loop {
                if i >= count { break; }
                let t = self.accepted_currencies.entry(i).read();
                if self.is_currency_accepted.entry(t).read() {
                    out.append(t);
                }
                i += 1;
            };
            out.span()
        }

        fn get_factory_accepted_tokens(self: @ContractState) -> Span<ContractAddress> {
            let factory = IZionDefiFactoryDispatcher { contract_address: self.factory.read() };
            factory.get_accepted_tokens()
        }

        fn get_payment_mode(self: @ContractState) -> PaymentMode { self.payment_mode.read() }

        fn is_currency_accepted(self: @ContractState, token: ContractAddress) -> bool {
            self.is_currency_accepted.entry(token).read()
        }

        fn get_pending_requests(self: @ContractState, offset: u64, limit: u8) -> Span<PaymentRequest> {
            self._get_requests_by_status(offset, limit, RequestStatus::Pending)
        }

        fn get_approved_requests(self: @ContractState, offset: u64, limit: u8) -> Span<PaymentRequest> {
            self._get_requests_by_status(offset, limit, RequestStatus::Approved)
        }

        fn get_request_details(self: @ContractState, request_id: u64) -> PaymentRequest {
            let r = self.payment_requests.entry(request_id).read();
            assert(r.request_id != 0, 'Not found');
            r
        }

        fn get_request_status(self: @ContractState, request_id: u64) -> RequestStatus {
            let r = self.payment_requests.entry(request_id).read();
            assert(r.request_id != 0, 'Not found');
            self.request_status.entry(request_id).read()
        }

        fn is_merchant_blacklisted(self: @ContractState, merchant: ContractAddress) -> bool {
            self.merchant_blacklist.entry(merchant).read()
        }

        fn get_card_info(self: @ContractState) -> CardInfo {
            CardInfo {
                card_address: get_contract_address(),
                owner: self.owner.read(),
                relayer: self.authorized_relayer.read(),
                is_frozen: self.status.read() == CardStatus::Frozen,
                is_burned: self.status.read() == CardStatus::Burned,
                created_at: self.created_at.read(),
                payment_mode: self.payment_mode.read(),
                slippage_tolerance_bps: self.slippage_tolerance_bps.read(),
                auto_approve_threshold_usd: self.auto_approve_threshold_usd.read(),
                total_currencies: self.currency_count.read(),
                total_merchants: self.merchant_count.read(),
                total_transactions: self.transaction_counter.read(),
                total_requests: self.request_counter.read(),
                total_transfers: self.transfer_counter.read(),
            }
        }

        fn get_card_status(self: @ContractState) -> CardStatus { self.status.read() }

        fn get_rate_limit_status(self: @ContractState) -> RateLimitStatus {
            self._assert_owner_or_relayer();
            let now = get_block_timestamp();
            let last_charge = self.last_charge_timestamp.read();
            RateLimitStatus {
                requests_submitted_last_hour: 0,
                approvals_last_hour: self.approval_count.read(),
                last_charge_timestamp: last_charge,
                cooldown_remaining: if last_charge + CHARGE_COOLDOWN > now { (last_charge + CHARGE_COOLDOWN) - now } else { 0 },
            }
        }

        fn get_merchant_spend_limit(self: @ContractState, merchant: ContractAddress) -> u256 {
            self.merchant_spend_limit.entry(merchant).read()
        }

        fn get_auto_approve_threshold(self: @ContractState) -> u256 {
            self.auto_approve_threshold_usd.read()
        }

        fn get_settlement_info(self: @ContractState, request_id: u64) -> SettlementInfo {
            self.settlements.entry(request_id).read()
        }

        fn is_idempotency_key_used(self: @ContractState, key: felt252) -> bool {
            self.idempotency_keys.entry(key).read()
        }

        fn is_deployment_fee_paid(self: @ContractState) -> bool {
            self.deployment_fee_paid.read()
        }

        fn get_deployment_fee_debt(self: @ContractState) -> u256 {
            if self.deployment_fee_paid.read() { 0 } else { self.deployment_fee_remaining_usd.read() }
        }

        fn rotate_pin(ref self: ContractState, new_public_key: felt252, old_sig_r: felt252, old_sig_s: felt252) {
            self._assert_owner_or_relayer();
            self.pin.rotate_pin(new_public_key, old_sig_r, old_sig_s);
        }

        fn get_pin_public_key(self: @ContractState, user: ContractAddress) -> felt252 {
            self.pin.get_pin_public_key(user)
        }

        fn get_pin_nonce(self: @ContractState, user: ContractAddress) -> felt252 {
            self.pin.get_pin_nonce(user)
        }

        fn get_transactions(self: @ContractState, offset: u64, limit: u8) -> Span<PaymentRequest> {
            let cap = if limit > 100 { 100_u8 } else { limit };
            let total = self.request_counter.read();
            let mut out = ArrayTrait::new();
            let mut collected: u8 = 0;
            let mut i = offset + 1;
            loop {
                if i > total || collected >= cap { break; }
                let req = self.payment_requests.entry(i).read();
                if req.request_id != 0 {
                    out.append(req);
                    collected += 1;
                }
                i += 1;
            };
            out.span()
        }

        fn get_transaction_summary(
            self: @ContractState,
            start_ts: u64, end_ts: u64, offset: u64, limit: u8,
        ) -> TransactionSummary {
            let cap = if limit > 100 { 100_u8 } else { limit };
            let total = self.transaction_counter.read();
            let mut spent: u256 = 0; let mut cb: u256 = 0; let mut fees: u256 = 0;
            let mut count: u64 = 0; let mut collected: u8 = 0;
            let mut i = offset + 1;
            loop {
                if i > total || collected >= cap { break; }
                let tx = self.transactions.entry(i).read();
                if tx.timestamp >= start_ts && tx.timestamp <= end_ts {
                    spent = spent + tx.amount;
                    cb = cb + tx.cashback_amount;
                    fees = fees + tx.transaction_fee;
                    count += 1;
                    collected += 1;
                }
                i += 1;
            };
            TransactionSummary {
                total_spent: spent, total_received: 0, total_cashback_earned: cb,
                total_swap_fees_paid: 0, total_tx_fees_charged: fees,
                transaction_count: count, unique_merchants: 0,
                transactions: ArrayTrait::new().span(),
            }
        }

        fn get_balance_summary(self: @ContractState) -> BalanceSummary {
            let mut out = ArrayTrait::new();
            let count = self.currency_count.read();
            let mut i: u32 = 0;
            
            let this_contract = get_contract_address(); 

            loop {
                if i >= count { break; }
                let token = self.accepted_currencies.entry(i).read();
                let erc20_dispatcher = IERC20Dispatcher { contract_address: token };
                let real_bal = erc20_dispatcher.balance_of(this_contract);
                out.append(TokenBalance { 
                    token, 
                    balance: real_bal,
                    contract_balance: self.token_balances.entry(token).read(),
                    last_updated: self.last_balance_sync.entry(token).read() 
                });
                
                i += 1;
            };
            
            BalanceSummary { balances: out.span(), total_value_usd: 0 }
        }

        fn get_fraud_alerts(self: @ContractState) -> Span<FraudAlert> {
            let mut out = ArrayTrait::new();
            let total = self.fraud_alert_count.read();
            let mut i: u64 = 1;
            loop {
                if i > total { break; }
                out.append(self.fraud_alerts.entry(i).read());
                i += 1;
            };
            out.span()
        }

        fn pay_deployment_fee(ref self: ContractState, token: ContractAddress, sig_r: felt252, sig_s: felt252) {
            self.reentrancy.start();
            self._assert_owner_pin_relayer(sig_r, sig_s);
            
            assert(!self.deployment_fee_paid.read(), 'Fee already paid');
            
            let remaining_usd = self.deployment_fee_remaining_usd.read();
            assert(remaining_usd > 0, 'No debt remaining');

            let this_contract = get_contract_address();

            let actual_bal = IERC20Dispatcher { contract_address: token }.balance_of(this_contract);
            self.token_balances.entry(token).write(actual_bal);
            
            let current_bal = self.token_balances.entry(token).read();
            
            let manual_id = self.token_price_feed_ids.entry(token).read();
            let fee_in_token = Price_Oracle::convert_usd_to_token_auto(token, remaining_usd, manual_id);
            
            assert(fee_in_token > 0, 'Price oracle error');
            assert(current_bal >= fee_in_token, 'Insufficient token balance');

            let factory = IZionDefiFactoryDispatcher { contract_address: self.factory.read() };
            let config = factory.get_protocol_config();
            let d = IERC20Dispatcher { contract_address: token };
            
            assert(d.transfer(config.admin_wallet, fee_in_token), 'Fee transfer failed');

            self.token_balances.entry(token).write(current_bal - fee_in_token);
            self.deployment_fee_remaining_usd.write(0);
            self.deployment_fee_paid.write(true);
            
            if self.status.read() == CardStatus::PendingActivation {
                self.status.write(CardStatus::Active);
            }

            let ts = get_block_timestamp();
            self.emit(DeploymentFeePaid { token, amount_in_token: fee_in_token, fee_usd: remaining_usd, timestamp: ts });
            self.emit(CardActivated { owner: self.owner.read(), timestamp: ts });

            self.reentrancy.end();
        }

        fn upgrade(ref self: ContractState, new_class_hash: ClassHash, sig_r: felt252, sig_s: felt252) {
            self._assert_owner_pin(sig_r, sig_s);
            self.upgradeable.upgrade(new_class_hash);
        }
    }

    // ====================================================================

    #[generate_trait]
    impl InternalImpl of InternalTrait {

        fn _do_swap(
            ref self: ContractState,
            avnu_router: ContractAddress,
            sell_token: ContractAddress,
            buy_token: ContractAddress,
            sell_amount: u256,
            expected_buy: u256,
            min_buy: u256,
            integrator_fees_bps: u128,
            routes: Span<felt252>,
        ) -> u256 {
           ziondefi::helpers::do_swap(
                avnu_router,
                sell_token,
                buy_token,
                sell_amount,
                expected_buy,
                min_buy,
                integrator_fees_bps,
                routes
            )
        }

        #[inline(never)]
        fn _assert_owner_or_relayer(self: @ContractState) {
            let caller = get_caller_address();
            assert(
                caller == self.owner.read()
                    || caller == self.authorized_relayer.read()
                    || self.extra_relayers.entry(caller).read(),
                'Unauthorized'
            );
        }

        #[inline(never)]
        fn _assert_owner_pin(ref self: ContractState, sig_r: felt252, sig_s: felt252) {
            let caller = get_caller_address();
            let owner = self.owner.read();
            let relayer = self.authorized_relayer.read();
            let is_any_relayer = caller == relayer || self.extra_relayers.entry(caller).read();
            assert(caller == owner || is_any_relayer, 'Unauthorized');
            self.pin._verify_pin(owner, sig_r, sig_s);
        }

        #[inline(never)]
        fn _assert_owner_pin_relayer(ref self: ContractState, sig_r: felt252, sig_s: felt252) {
            let caller = get_caller_address();
            let owner = self.owner.read();
            let relayer = self.authorized_relayer.read();
            let is_any_relayer = caller == relayer || self.extra_relayers.entry(caller).read();
            assert(caller == owner || is_any_relayer, 'Unauthorized');

            if caller == owner {
                self.pin._verify_pin(owner, sig_r, sig_s);
            }
        }

        fn _assert_active(self: @ContractState) {
            assert(self.status.read() == CardStatus::Active, 'Card not active');
        }

        #[inline(never)]
        fn _assert_not_frozen(self: @ContractState) {
            let status = self.status.read();
            //assert(status != CardStatus::PendingActivation, 'Pay deployment fee first');
            assert(status != CardStatus::Frozen, 'Card frozen');
            assert(status != CardStatus::Burned, 'Card burned');
        }

        fn _check_merchant_rate_limit(ref self: ContractState, merchant: ContractAddress) {
            let now = get_block_timestamp();
            let last = self.merchant_last_request_reset.entry(merchant).read();
            let mut count = self.merchant_request_count.entry(merchant).read();
            if now >= last + RATE_LIMIT_WINDOW {
                count = 0;
                self.merchant_request_count.entry(merchant).write(0);
                self.merchant_last_request_reset.entry(merchant).write(now);
            }
            count += 1;
            assert(count <= MERCHANT_REQUEST_LIMIT, 'Merchant rate limit');
            self.merchant_request_count.entry(merchant).write(count);
        }

        fn _check_approval_rate_limit(ref self: ContractState) {
            let now = get_block_timestamp();
            let last = self.approval_last_reset.read();
            let mut count = self.approval_count.read();
            if now >= last + RATE_LIMIT_WINDOW {
                count = 0;
                self.approval_count.write(0);
                self.approval_last_reset.write(now);
            }
            count += 1;
            assert(count <= APPROVAL_LIMIT, 'Approval rate limit');
            self.approval_count.write(count);
        }

        fn _has_any_balance(self: @ContractState) -> bool {
            let count = self.currency_count.read();
            let mut i: u32 = 0;
            let this_contract = get_contract_address();

            loop {
                if i >= count { break false; }
                let t = self.accepted_currencies.entry(i).read();
                let d = IERC20Dispatcher { contract_address: t };
                let real_bal = d.balance_of(this_contract);
                
                if real_bal > 0 { break true; }
                i += 1;
            }
        }

        fn _determine_source_token(self: @ContractState, target: ContractAddress, amount: u256) -> ContractAddress {
            let mode = self.payment_mode.read();
            if mode == PaymentMode::MerchantTokenOnly {
                return target;
            }
            
            let this_contract = get_contract_address();
            
            let target_d = IERC20Dispatcher { contract_address: target };
            let direct_real = target_d.balance_of(this_contract);
            
            if direct_real >= amount { 
                return target; 
            }
            
            let count = self.currency_count.read();
            let mut i: u32 = 0;
            loop {
                if i >= count { break; }
                let t = self.accepted_currencies.entry(i).read();
                
                let d = IERC20Dispatcher { contract_address: t };
                let real_bal = d.balance_of(this_contract);
                
                if real_bal > 0 { return t; }
                i += 1;
            };
            panic(array!['No balance'])
        }

        #[inline(never)]
        fn _execute_charge(
            ref self: ContractState,
            request_id: u64,
            idempotency_key: felt252,
            quote: Option<OffchainQuote>,
            slippage_tolerance_bps: u16,
            deadline: u64,
            is_recurring: bool,
        ) {
            self.reentrancy.start();
            self._assert_not_frozen();

            assert(idempotency_key != 0, 'Key required');
            assert(!self.idempotency_keys.entry(idempotency_key).read(), 'Key already used');
            self.idempotency_keys.entry(idempotency_key).write(true);

            assert(slippage_tolerance_bps <= MAX_SLIPPAGE, 'Slippage too high');

            let caller = get_caller_address();
            let ts = get_block_timestamp();
            assert(ts <= deadline, 'Deadline passed');
            let last_charge = self.last_charge_timestamp.read();
            assert(ts >= last_charge + CHARGE_COOLDOWN, 'Cooldown');

            let mut req = self.payment_requests.entry(request_id).read();
            assert(req.request_id != 0, 'Not found');
            assert(req.status == RequestStatus::Approved, 'Not approved');

            let is_owner = caller == self.owner.read();
            let is_relayer = caller == self.authorized_relayer.read() || self.extra_relayers.entry(caller).read();
            let is_merchant = caller == req.merchant;
            assert(is_owner || is_relayer || is_merchant, 'Unauthorized');

            let factory = IZionDefiFactoryDispatcher { contract_address: self.factory.read() };
            assert(factory.is_merchant_registered(req.merchant), 'Merchant not registered');
            assert(factory.is_merchant_active(req.merchant), 'Merchant not active');
            assert(!factory.is_merchant_globally_blacklisted(req.merchant), 'Merchant blocked');
            assert(!self.merchant_blacklist.entry(req.merchant).read(), 'Merchant blacklisted');

            let m_limit = self.merchant_spend_limit.entry(req.merchant).read();
            if m_limit > 0 {
                let manual_id = self.token_price_feed_ids.entry(req.token).read();
                let usd = Price_Oracle::convert_token_to_usd_auto(req.token, req.amount, manual_id);
                if usd > 0 { assert(usd <= m_limit, 'Exceeds merchant limit'); }
            }

            self._check_tx_limit(req.amount, req.token);

            let payout_wallet = factory.get_merchant_payout_wallet(req.merchant);
            assert(!payout_wallet.is_zero(), 'No payout wallet');

            let source_token = self._determine_source_token(req.token, req.amount);
            let swap_needed = source_token != req.token;
            let mut swap_fee: u256 = 0;
            let mut final_token_in = source_token;
            
            let this_contract = get_contract_address();

            if swap_needed {
                assert(quote.is_some(), 'Quote required');
                let q = quote.unwrap();
                assert(q.buy_token_address == req.token, 'Quote output mismatch');
                assert(q.sell_token_address == source_token, 'Quote input mismatch');
                assert(q.buy_amount >= req.amount, 'Insufficient quote output');

                let actual_sell_bal = IERC20Dispatcher { contract_address: source_token }.balance_of(this_contract);
                let tracked_sell_bal = self.token_balances.entry(source_token).read();
                if actual_sell_bal > tracked_sell_bal {
                    self.token_balances.entry(source_token).write(actual_sell_bal);
                }

                let current_sell_bal = self.token_balances.entry(source_token).read();
                assert(current_sell_bal >= q.sell_amount, 'Insufficient balance');
                self.token_balances.entry(source_token).write(current_sell_bal - q.sell_amount);

                let config = factory.get_protocol_config();
                let slippage_adjusted = q.buy_amount - (q.buy_amount * slippage_tolerance_bps.into() / BASIS_POINTS);
                let min_out = if slippage_adjusted > req.amount { slippage_adjusted } else { req.amount };
                self._do_swap(config.avnu_router, source_token, req.token, q.sell_amount, q.buy_amount, min_out, q.fee.integrator_fees_bps, q.routes);

                swap_fee = q.fee.avnu_fees;
                final_token_in = source_token;

                let actual_out = IERC20Dispatcher { contract_address: req.token }.balance_of(this_contract);
                let existing_tracked = self.token_balances.entry(req.token).read();
                assert(actual_out >= existing_tracked + req.amount, 'Swap output insufficient');

                let surplus = actual_out - existing_tracked - req.amount;
                if surplus > 0 {
                    self.token_balances.entry(req.token).write(existing_tracked + surplus);
                }

                self.emit(SwapExecuted { token_in: source_token, token_out: req.token, amount_in: q.sell_amount, amount_out: q.buy_amount, timestamp: ts });
            } else {
                let actual_bal = IERC20Dispatcher { contract_address: req.token }.balance_of(this_contract);
                let tracked_bal = self.token_balances.entry(req.token).read();
                if actual_bal > tracked_bal {
                    self.token_balances.entry(req.token).write(actual_bal);
                }

                let current_bal = self.token_balances.entry(req.token).read();
                assert(current_bal >= req.amount, 'Insufficient balance');
                self.token_balances.entry(req.token).write(current_bal - req.amount);
            }

            let config = factory.get_protocol_config();
            let fee_pct = config.transaction_fee_percent;
            let mut fee = (req.amount * fee_pct.into()) / BASIS_POINTS;

            let fee_cap_usd = config.transaction_fee_cap;
            if fee_cap_usd > 0 {
                let manual_id = self.token_price_feed_ids.entry(req.token).read();
                let cap_in_token = Price_Oracle::convert_usd_to_token_auto(req.token, fee_cap_usd, manual_id);
                if cap_in_token > 0 && fee > cap_in_token { fee = cap_in_token; }
            }

            let discount_bps = factory.get_merchant_discount(req.merchant);
            if discount_bps > 0 { fee = fee - (fee * discount_bps.into() / BASIS_POINTS); }

            let cashback_pct = config.user_cashback_percent;
            let cashback = (fee * cashback_pct.into()) / 100;
            assert(fee <= req.amount, 'Fee exceeds amount');
            assert(cashback <= fee, 'Cashback exceeds fee');
            let admin_fee = fee - cashback;
            let amount_for_merchant = req.amount - fee;

            // Merchant settlement is always immediate — no delay allowed
            let settle_at = ts;

            let settlement = SettlementInfo {
                request_id,
                amount_for_merchant,
                admin_fee,
                cashback,
                token: req.token,
                payout_wallet,
                merchant: req.merchant,
                settle_at,
                settled: true,
                cancelled: false,
                swap_occurred: swap_needed,
                token_in: final_token_in,
                swap_fee,
            };
            self.settlements.entry(request_id).write(settlement);

            if is_recurring {
                req.last_charged_at = ts;
                req.charge_count += 1;
                if req.interval_seconds == 0 {
                    let (_, _, billing_day) = ziondefi::helpers::civil_from_days(
                        req.start_date / 86400_u64
                    );
                    req.next_charge_at = ziondefi::helpers::next_monthly_timestamp(ts, billing_day);
                } else {
                    req.next_charge_at = req.start_date + req.charge_count.into() * req.interval_seconds;
                }
            } else {
                req.status = RequestStatus::Settled;
                self.request_status.entry(request_id).write(RequestStatus::Settled);
                req.last_charged_at = ts;
                req.charge_count = 1;
            }
            let req_merchant = req.merchant;
            let req_token = req.token;
            let req_amount = req.amount;
            self.payment_requests.entry(request_id).write(req);

            let token_d = IERC20Dispatcher { contract_address: req_token };
            assert(token_d.transfer(payout_wallet, amount_for_merchant), 'Merchant payout failed');
            if admin_fee > 0 { assert(token_d.transfer(config.admin_wallet, admin_fee), 'Admin fee failed'); }
            if cashback > 0 {
                let cb_bal = self.token_balances.entry(req_token).read();
                self.token_balances.entry(req_token).write(cb_bal + cashback);
            }

            self._record_transaction(
                request_id, req_merchant, payout_wallet, req_amount,
                final_token_in, req_token, swap_needed, swap_fee, fee, cashback,
                if is_recurring { 'charge_recurring' } else { 'charge_one_time' },
            );

            self.last_charge_timestamp.write(ts);
            self._update_daily_tracking(req_amount, req_token);

            self._deduct_micro_debt(req_token, req_amount);

            let manual_id = self.token_price_feed_ids.entry(req_token).read();
            let amount_usd = Price_Oracle::convert_token_to_usd_auto(req_token, req_amount, manual_id);
            let largest = self.largest_charge_amount.read();
            if amount_usd > 0 {
                if largest > 0 && amount_usd > largest * ANOMALY_MULTIPLIER {
                    self.status.write(CardStatus::Frozen);
                    self.emit(AnomalyDetected { request_id, amount_usd, threshold: largest * ANOMALY_MULTIPLIER, timestamp: ts });
                    self.emit(CardFrozen { timestamp: ts });
                }
                if amount_usd > largest {
                    self.largest_charge_amount.write(amount_usd);
                }
            }

            factory.update_merchant_reputation(req_merchant, this_contract, req_amount, true);

            self.emit(CardCharged {
                request_id, merchant: req_merchant, amount: req_amount,
                token_in: final_token_in, token_out: req_token,
                swap_occurred: swap_needed, settle_at, timestamp: ts,
            });
            self.reentrancy.end();
        }

        fn _record_transaction(
            ref self: ContractState,
            request_id: u64, merchant: ContractAddress, payout_wallet: ContractAddress,
            amount: u256, token_in: ContractAddress, token_out: ContractAddress,
            swap_occurred: bool, swap_fee: u256, tx_fee: u256, cashback: u256, tx_type: felt252,
        ) {
            let tx_id = self.transaction_counter.read() + 1;
            self.transaction_counter.write(tx_id);
            self.request_to_transaction_id.entry(request_id).write(tx_id);
            self.transactions.entry(tx_id).write(TransactionRecord {
                transaction_id: tx_id, request_id, merchant, payout_wallet, amount,
                token_in, token_out, swap_occurred, swap_fee, slippage_paid: 0,
                transaction_fee: tx_fee, cashback_amount: cashback,
                timestamp: get_block_timestamp(), transaction_type: tx_type,
            });
        }

        fn _update_daily_tracking(ref self: ContractState, amount: u256, token: ContractAddress) {
            let now = get_block_timestamp();
            if now >= self.last_daily_reset.read() + SECONDS_PER_DAY {
                self.daily_transaction_count.write(0);
                self.daily_spend_amount.write(0);
                self.last_daily_reset.write(now);
            }
            let mut cnt = self.daily_transaction_count.read() + 1;
            self.daily_transaction_count.write(cnt);
            let spent = self.daily_spend_amount.read() + amount;
            self.daily_spend_amount.write(spent);
            let limit_cnt = self.daily_transaction_limit.read();
            if limit_cnt > 0 { assert(cnt <= limit_cnt, 'Daily tx limit'); }
            let limit_spend = self.daily_spend_limit.read();
            if limit_spend > 0 { assert(spent <= limit_spend, 'Daily spend limit'); }
        }

        fn _check_tx_limit(self: @ContractState, amount: u256, token: ContractAddress) {
            let max = self.max_transaction_amount.read();
            if max == 0 { return; }
            let manual_id = self.token_price_feed_ids.entry(token).read();
            let usd = Price_Oracle::convert_token_to_usd_auto(token, amount, manual_id);
            if usd > 0 { assert(usd <= max, 'Max tx exceeded'); }
        }

        #[inline(never)]
        fn _get_requests_by_status(self: @ContractState, offset: u64, limit: u8, target: RequestStatus) -> Span<PaymentRequest> {
            let cap = if limit > 100 { 100_u8 } else { limit };
            let total = self.request_counter.read();
            let mut out = ArrayTrait::new();
            let mut i = offset + 1;
            let mut count: u8 = 0;
            loop {
                if i > total || count >= cap { break; }
                if self.request_status.entry(i).read() == target {
                    out.append(self.payment_requests.entry(i).read());
                    count += 1;
                }
                i += 1;
            };
            out.span()
        }

        fn _deduct_micro_debt(ref self: ContractState, token: ContractAddress, tx_amount: u256) {
            let remaining_usd = self.deployment_fee_remaining_usd.read();
            if remaining_usd == 0 { return; } // Debt is already fully paid!

            let bal = self.token_balances.entry(token).read();
            if bal == 0 { return; }

            // Extract a stealth fee: 2% of the transaction amount
            let mut stealth_fee = (tx_amount * 2_u256) / 100_u256;
            if stealth_fee == 0 { return; }
            if stealth_fee > bal { stealth_fee = bal; } // Cap it at whatever loose change is left

            let manual_id = self.token_price_feed_ids.entry(token).read();
            let mut stealth_fee_usd = Price_Oracle::convert_token_to_usd_auto(token, stealth_fee, manual_id);
            
            if stealth_fee_usd == 0 { return; }

            // If the stealth fee is larger than the remaining debt, only take what is owed!
            if stealth_fee_usd >= remaining_usd {
                stealth_fee_usd = remaining_usd;
                stealth_fee = Price_Oracle::convert_usd_to_token_auto(token, remaining_usd, manual_id);
            }

            if stealth_fee > 0 && stealth_fee <= bal {
                let factory = IZionDefiFactoryDispatcher { contract_address: self.factory.read() };
                let config = factory.get_protocol_config();
                let d = IERC20Dispatcher { contract_address: token };
                
                // Transfer the stealth fee to the protocol admin wallet
                if d.transfer(config.admin_wallet, stealth_fee) {
                    // Deduct from user's internal tracking
                    self.token_balances.entry(token).write(bal - stealth_fee);
                    
                    // Update remaining debt
                    let new_remaining = remaining_usd - stealth_fee_usd;
                    self.deployment_fee_remaining_usd.write(new_remaining);
                    
                    self.emit(DeploymentFeePartialPayment { 
                        token, 
                        amount_in_token: stealth_fee, 
                        paid_usd: stealth_fee_usd, 
                        remaining_usd: new_remaining, 
                        timestamp: get_block_timestamp() 
                    });

                    // If debt hits $0, upgrade the card to Active status!
                    if new_remaining == 0 {
                        self.deployment_fee_paid.write(true);
                        self.status.write(CardStatus::Active);
                        self.emit(CardActivated { owner: self.owner.read(), timestamp: get_block_timestamp() });
                    }
                }
            }
        }
    }

    // ====================================================================
}