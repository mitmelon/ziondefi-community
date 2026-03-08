// SPDX-License-Identifier: MIT
// ZionDefi Protocol v2.0 — Factory Contract
// Handles card deployment, merchant registry, accepted-token management,
// global protocol configuration, and settlement-delay policies.

#[starknet::contract]
mod ZionDefiFactory {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StoragePointerReadAccess, StoragePointerWriteAccess,
        StoragePathEntry,
    };
    use starknet::{
        ContractAddress, get_caller_address, get_block_timestamp,
        ClassHash, syscalls::deploy_syscall, get_contract_address,
    };

    use openzeppelin_access::ownable::OwnableComponent;
    use openzeppelin_security::pausable::PausableComponent;
    use openzeppelin_upgrades::UpgradeableComponent;
    use openzeppelin_upgrades::interface::IUpgradeable;
    use ziondefi::types::{
        PaymentMode, CardConfig, ProtocolConfig, MerchantReputation,
        MerchantInfo, MerchantReputationFull,
    };

    // ====================================================================
    // COMPONENTS
    // ====================================================================

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: PausableComponent, storage: pausable, event: PausableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    // OwnableImpl is intentionally NOT embedded publicly — transfer_ownership and
    // renounce_ownership are disabled. Owner is immutable after deployment.
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;

    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // ====================================================================
    // STORAGE
    // ====================================================================

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        pausable: PausableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,

        // Protocol fees
        deployment_fee: u256,
        transaction_fee_percent: u16,
        transaction_fee_cap: u256,
        user_cashback_percent: u8,
        burn_fee: u256,

        // Protocol addresses
        authorized_relayer: ContractAddress,
        avnu_router: ContractAddress,
        admin_wallet: ContractAddress,

        // Card deployment
        vault_class_hash: ClassHash,
        total_cards_deployed: u64,
        card_exists: Map<ContractAddress, bool>,

        // Accepted tokens (globally — cards may only accept these)
        accepted_tokens: Map<u32, ContractAddress>,
        accepted_token_count: u32,
        is_token_accepted: Map<ContractAddress, bool>,
        token_pair_id: Map<ContractAddress, felt252>,

        // Merchant registry
        merchant_registered: Map<ContractAddress, bool>,
        merchant_info: Map<ContractAddress, MerchantInfo>,
        merchant_payout_wallet: Map<ContractAddress, ContractAddress>,
        merchant_discount: Map<ContractAddress, u16>,
        merchant_reputation: Map<ContractAddress, MerchantReputationFull>,
        total_merchants: u64,

        // Global blacklist
        global_merchant_blacklist: Map<ContractAddress, bool>,
        blacklist_reason: Map<ContractAddress, ByteArray>,

        // User registry — only registered users may deploy cards
        registered_users: Map<ContractAddress, bool>,
    }

    // ====================================================================
    // EVENTS
    // ====================================================================

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat] OwnableEvent: OwnableComponent::Event,
        #[flat] PausableEvent: PausableComponent::Event,
        #[flat] UpgradeableEvent: UpgradeableComponent::Event,
        CardCreated: CardCreated,
        FeeUpdated: FeeUpdated,
        RelayerUpdated: RelayerUpdated,
        AVNURouterUpdated: AVNURouterUpdated,
        UserRegistered: UserRegistered,
        UserDeregistered: UserDeregistered,
        TokenAdded: TokenAdded,
        TokenRemoved: TokenRemoved,
        MerchantRegistered: MerchantRegistered,
        MerchantUpdated: MerchantUpdated,
        MerchantPayoutWalletUpdated: MerchantPayoutWalletUpdated,
        MerchantDiscountSet: MerchantDiscountSet,
        MerchantGloballyBlacklisted: MerchantGloballyBlacklisted,
        MerchantGloballyUnblacklisted: MerchantGloballyUnblacklisted,
        MerchantReputationUpdated: MerchantReputationUpdated,
        VaultClassHashUpdated: VaultClassHashUpdated,
    }

    #[derive(Drop, starknet::Event)]
    struct CardCreated { #[key] card_address: ContractAddress, #[key] owner: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct FeeUpdated { key: felt252, value: u256, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct RelayerUpdated { old_relayer: ContractAddress, #[key] new_relayer: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct AVNURouterUpdated { old_router: ContractAddress, #[key] new_router: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct UserRegistered { #[key] user: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct UserDeregistered { #[key] user: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct TokenAdded { #[key] token: ContractAddress, pair_id: felt252, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct TokenRemoved { #[key] token: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct MerchantRegistered { #[key] merchant: ContractAddress, payout_wallet: ContractAddress, business_name: ByteArray, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct MerchantUpdated { #[key] merchant: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct MerchantPayoutWalletUpdated { #[key] merchant: ContractAddress, old_wallet: ContractAddress, new_wallet: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct MerchantDiscountSet { #[key] merchant: ContractAddress, discount_bps: u16, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct MerchantGloballyBlacklisted { #[key] merchant: ContractAddress, reason: ByteArray, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct MerchantGloballyUnblacklisted { #[key] merchant: ContractAddress, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct MerchantReputationUpdated { #[key] merchant: ContractAddress, #[key] card: ContractAddress, reputation_score: u16, timestamp: u64 }
    #[derive(Drop, starknet::Event)]
    struct VaultClassHashUpdated { old_class_hash: ClassHash, new_class_hash: ClassHash, timestamp: u64 }

    // ====================================================================
    // CONSTRUCTOR
    // ====================================================================

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        authorized_relayer: ContractAddress,
        vault_class_hash: ClassHash,
        admin_wallet: ContractAddress,
    ) {
        self.ownable.initializer(owner);
        assert(!vault_class_hash.is_zero(), 'Invalid class hash');
        assert(!admin_wallet.is_zero(), 'Invalid admin wallet');
        assert(!authorized_relayer.is_zero(), 'Invalid relayer');

        self.vault_class_hash.write(vault_class_hash);
        self.admin_wallet.write(admin_wallet);
        self.authorized_relayer.write(authorized_relayer);

        // Default protocol fees (USD, 8 decimals — Pragma)
        self.deployment_fee.write(2_00000000);       // $2
        self.transaction_fee_percent.write(40);       // 0.4%
        self.transaction_fee_cap.write(10_00000000);  // $10
        self.user_cashback_percent.write(10);         // 10% of fee
        self.burn_fee.write(1_00000000);              // $1
    }

    // ====================================================================
    // EXTERNAL IMPLEMENTATION
    // ====================================================================

    #[abi(embed_v0)]
    impl ZionDefiFactoryImpl of ziondefi::interfaces::IZionDefiFactory<ContractState> {

        fn create_card(
             ref self: ContractState,
             owner: ContractAddress,
             authorized_relayer: ContractAddress,
             pin_public_key: felt252,
             accepted_currencies: Span<ContractAddress>,
             payment_mode: PaymentMode,
             initial_config: CardConfig,
        ) -> ContractAddress {
            self.pausable.assert_not_paused();
            self._assert_registered_user();
            
            let ts = get_block_timestamp();

            assert(!owner.is_zero(), 'Invalid owner');
            assert(!authorized_relayer.is_zero(), 'Invalid relayer');
            assert(pin_public_key != 0, 'Invalid PIN key');
            assert(accepted_currencies.len() > 0, 'No currencies');
            assert(initial_config.slippage_tolerance_bps <= 1000, 'Slippage too high');

            // Validate all requested currencies are factory-accepted
            let mut i: u32 = 0;
            loop {
                if i >= accepted_currencies.len() { break; }
                let token = *accepted_currencies.at(i);
                assert(self.is_token_accepted.entry(token).read(), 'Token not accepted');
                i += 1;
            };

            let deployment_fee_usd = self.deployment_fee.read();

            // Build constructor calldata
            let mut calldata = ArrayTrait::new();
            calldata.append(owner.into()); // owner
            calldata.append(authorized_relayer.into());  // relayer
            calldata.append(pin_public_key); // pin_public_key

            Serde::serialize(@accepted_currencies.len(), ref calldata);
            let mut j: u32 = 0;
            loop {
                if j >= accepted_currencies.len() { break; }
                calldata.append((*accepted_currencies.at(j)).into());
                j += 1;
            };
            Serde::serialize(@payment_mode, ref calldata);
            Serde::serialize(@initial_config, ref calldata);
            Serde::serialize(@deployment_fee_usd, ref calldata);

            let (card_address, _) = deploy_syscall(
                self.vault_class_hash.read(),
                (self.total_cards_deployed.read() + 1).into(),
                calldata.span(), false,
            ).expect('Deploy failed');

            self.card_exists.entry(card_address).write(true);
            let count = self.total_cards_deployed.read();
            self.total_cards_deployed.write(count + 1);

            self.emit(CardCreated { card_address, owner, timestamp: ts });
            card_address
        }

        fn set_deployment_fee(ref self: ContractState, new_fee: u256) {
            self.ownable.assert_only_owner();
            self.deployment_fee.write(new_fee);
            self.emit(FeeUpdated { key: 'deployment_fee', value: new_fee, timestamp: get_block_timestamp() });
        }

        fn set_transaction_fee_percent(ref self: ContractState, new_percent: u16) {
            self.ownable.assert_only_owner();
            assert(new_percent <= 1000, 'Fee too high');
            self.transaction_fee_percent.write(new_percent);
            self.emit(FeeUpdated { key: 'tx_fee_pct', value: new_percent.into(), timestamp: get_block_timestamp() });
        }

        fn set_transaction_fee_cap(ref self: ContractState, new_cap: u256) {
            self.ownable.assert_only_owner();
            self.transaction_fee_cap.write(new_cap);
            self.emit(FeeUpdated { key: 'tx_fee_cap', value: new_cap, timestamp: get_block_timestamp() });
        }

        fn set_user_cashback_percent(ref self: ContractState, new_percent: u8) {
            self.ownable.assert_only_owner();
            assert(new_percent <= 100, 'Invalid pct');
            self.user_cashback_percent.write(new_percent);
            self.emit(FeeUpdated { key: 'cashback_pct', value: new_percent.into(), timestamp: get_block_timestamp() });
        }

        fn set_burn_fee(ref self: ContractState, new_fee: u256) {
            self.ownable.assert_only_owner();
            self.burn_fee.write(new_fee);
            self.emit(FeeUpdated { key: 'burn_fee', value: new_fee, timestamp: get_block_timestamp() });
        }

        fn set_avnu_router(ref self: ContractState, avnu_router: ContractAddress) {
            self.ownable.assert_only_owner();
            assert(!avnu_router.is_zero(), 'Invalid router');
            let old = self.avnu_router.read();
            self.avnu_router.write(avnu_router);
            self.emit(AVNURouterUpdated { old_router: old, new_router: avnu_router, timestamp: get_block_timestamp() });
        }

        fn set_vault_class_hash(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            assert(!new_class_hash.is_zero(), 'Invalid class hash');
            let old = self.vault_class_hash.read();
            self.vault_class_hash.write(new_class_hash);
            self.emit(VaultClassHashUpdated { old_class_hash: old, new_class_hash, timestamp: get_block_timestamp() });
        }

        fn pause(ref self: ContractState) { self.ownable.assert_only_owner(); self.pausable.pause(); }
        fn unpause(ref self: ContractState) { self.ownable.assert_only_owner(); self.pausable.unpause(); }

        fn update_authorized_relayer(ref self: ContractState, new_relayer: ContractAddress) {
            self.ownable.assert_only_owner();
            assert(!new_relayer.is_zero(), 'Invalid relayer');
            let old = self.authorized_relayer.read();
            self.authorized_relayer.write(new_relayer);
            self.emit(RelayerUpdated { old_relayer: old, new_relayer, timestamp: get_block_timestamp() });
        }

        fn register_user(ref self: ContractState, user: ContractAddress) {
            self._assert_relayer();
            assert(!user.is_zero(), 'Invalid user');
            assert(!self.registered_users.entry(user).read(), 'Already registered');
            self.registered_users.entry(user).write(true);
            self.emit(UserRegistered { user, timestamp: get_block_timestamp() });
        }

        fn deregister_user(ref self: ContractState, user: ContractAddress) {
            self._assert_relayer();
            self.registered_users.entry(user).write(false);
            self.emit(UserDeregistered { user, timestamp: get_block_timestamp() });
        }

        fn is_registered_user(self: @ContractState, user: ContractAddress) -> bool {
            self.registered_users.entry(user).read()
        }

        fn add_accepted_token(ref self: ContractState, token: ContractAddress, pair_id: felt252) {
            self._assert_relayer();
            assert(!token.is_zero(), 'Invalid token');
            if !self.is_token_accepted.entry(token).read() {
                let count = self.accepted_token_count.read();
                self.accepted_tokens.entry(count).write(token);
                self.is_token_accepted.entry(token).write(true);
                self.token_pair_id.entry(token).write(pair_id);
                self.accepted_token_count.write(count + 1);
                self.emit(TokenAdded { token, pair_id, timestamp: get_block_timestamp() });
            }
        }

        fn remove_accepted_token(ref self: ContractState, token: ContractAddress) {
            self._assert_relayer();
            self.is_token_accepted.entry(token).write(false);
            self.emit(TokenRemoved { token, timestamp: get_block_timestamp() });
        }

        fn register_merchant(
            ref self: ContractState,
            merchant: ContractAddress,
            payout_wallet: ContractAddress,
            business_name: ByteArray,
            contact_email: ByteArray,
            kyc_verified: bool,
        ) {
            self._assert_relayer();
            assert(!merchant.is_zero(), 'Invalid merchant');
            assert(!payout_wallet.is_zero(), 'Invalid wallet');
            assert(!self.merchant_registered.entry(merchant).read(), 'Already registered');

            let ts = get_block_timestamp();
            let info = MerchantInfo {
                merchant_address: merchant, payout_wallet,
                business_name: business_name.clone(), contact_email,
                registered_at: ts, is_active: true, kyc_verified,
            };
            self.merchant_info.entry(merchant).write(info);
            self.merchant_registered.entry(merchant).write(true);
            self.merchant_payout_wallet.entry(merchant).write(payout_wallet);

            let rep = MerchantReputationFull {
                total_transactions: 0, successful_transactions: 0,
                failed_transactions: 0, disputed_transactions: 0,
                total_volume: 0, blacklist_count: 0, reputation_score: 500,
                last_transaction: 0, cards_interacted: 0,
            };
            self.merchant_reputation.entry(merchant).write(rep);
            self.total_merchants.write(self.total_merchants.read() + 1);
            self.emit(MerchantRegistered { merchant, payout_wallet, business_name, timestamp: ts });
        }

        fn remove_merchant(ref self: ContractState, merchant: ContractAddress) {
            self._assert_relayer();
            assert(self.merchant_registered.entry(merchant).read(), 'Not registered');
            self.merchant_registered.entry(merchant).write(false);
            let mut info = self.merchant_info.entry(merchant).read();
            info.is_active = false;
            self.merchant_info.entry(merchant).write(info);
            self.emit(MerchantUpdated { merchant, timestamp: get_block_timestamp() });
        }

        fn update_merchant_info(
            ref self: ContractState,
            merchant: ContractAddress,
            business_name: ByteArray,
            contact_email: ByteArray,
            kyc_verified: bool,
        ) {
            self._assert_relayer();
            assert(self.merchant_registered.entry(merchant).read(), 'Not registered');
            let mut info = self.merchant_info.entry(merchant).read();
            info.business_name = business_name;
            info.contact_email = contact_email;
            info.kyc_verified = kyc_verified;
            self.merchant_info.entry(merchant).write(info);
            self.emit(MerchantUpdated { merchant, timestamp: get_block_timestamp() });
        }

        fn update_merchant_payout_wallet(ref self: ContractState, merchant: ContractAddress, new_payout_wallet: ContractAddress) {
            self._assert_relayer();
            assert(self.merchant_registered.entry(merchant).read(), 'Not registered');
            assert(!new_payout_wallet.is_zero(), 'Invalid wallet');
            let old = self.merchant_payout_wallet.entry(merchant).read();
            self.merchant_payout_wallet.entry(merchant).write(new_payout_wallet);
            let mut info = self.merchant_info.entry(merchant).read();
            info.payout_wallet = new_payout_wallet;
            self.merchant_info.entry(merchant).write(info);
            self.emit(MerchantPayoutWalletUpdated { merchant, old_wallet: old, new_wallet: new_payout_wallet, timestamp: get_block_timestamp() });
        }

        fn activate_merchant(ref self: ContractState, merchant: ContractAddress) {
            self._assert_relayer();
            assert(self.merchant_registered.entry(merchant).read(), 'Not registered');
            let mut info = self.merchant_info.entry(merchant).read();
            info.is_active = true;
            self.merchant_info.entry(merchant).write(info);
            self.emit(MerchantUpdated { merchant, timestamp: get_block_timestamp() });
        }

        fn deactivate_merchant(ref self: ContractState, merchant: ContractAddress) {
            self._assert_relayer();
            assert(self.merchant_registered.entry(merchant).read(), 'Not registered');
            let mut info = self.merchant_info.entry(merchant).read();
            info.is_active = false;
            self.merchant_info.entry(merchant).write(info);
            self.emit(MerchantUpdated { merchant, timestamp: get_block_timestamp() });
        }

        fn set_merchant_discount(ref self: ContractState, merchant: ContractAddress, discount_bps: u16) {
            self._assert_relayer();
            assert(self.merchant_registered.entry(merchant).read(), 'Not registered');
            assert(discount_bps <= 10000, 'Invalid discount');
            self.merchant_discount.entry(merchant).write(discount_bps);
            self.emit(MerchantDiscountSet { merchant, discount_bps, timestamp: get_block_timestamp() });
        }

        fn remove_merchant_discount(ref self: ContractState, merchant: ContractAddress) {
            self._assert_relayer();
            self.merchant_discount.entry(merchant).write(0);
            self.emit(MerchantDiscountSet { merchant, discount_bps: 0, timestamp: get_block_timestamp() });
        }

        fn globally_blacklist_merchant(ref self: ContractState, merchant: ContractAddress, reason: ByteArray) {
            self._assert_relayer();
            self.global_merchant_blacklist.entry(merchant).write(true);
            self.blacklist_reason.entry(merchant).write(reason.clone());
            let mut info = self.merchant_info.entry(merchant).read();
            info.is_active = false;
            self.merchant_info.entry(merchant).write(info);
            self.emit(MerchantGloballyBlacklisted { merchant, reason, timestamp: get_block_timestamp() });
        }

        fn globally_unblacklist_merchant(ref self: ContractState, merchant: ContractAddress) {
            self._assert_relayer();
            self.global_merchant_blacklist.entry(merchant).write(false);
            let mut info = self.merchant_info.entry(merchant).read();
            info.is_active = true;
            self.merchant_info.entry(merchant).write(info);
            self.emit(MerchantGloballyUnblacklisted { merchant, timestamp: get_block_timestamp() });
        }

        fn set_merchant_reputation(ref self: ContractState, merchant: ContractAddress, reputation_score: u16) {
            self._assert_relayer();
            assert(self.merchant_registered.entry(merchant).read(), 'Not registered');
            let mut rep = self.merchant_reputation.entry(merchant).read();
            rep.reputation_score = if reputation_score > 1000 { 1000 } else { reputation_score };
            self.merchant_reputation.entry(merchant).write(rep);
            self.emit(MerchantReputationUpdated { merchant, card: get_contract_address(), reputation_score: rep.reputation_score, timestamp: get_block_timestamp() });
        }

        fn update_merchant_reputation(ref self: ContractState, merchant: ContractAddress, user: ContractAddress, amount: u256, is_successful: bool) {
            assert(self.card_exists.entry(get_caller_address()).read(), 'Not a card');
            let mut rep = self.merchant_reputation.entry(merchant).read();
            rep.total_transactions += 1;
            if is_successful {
                rep.successful_transactions += 1;
                rep.total_volume += amount;
            } else {
                rep.failed_transactions += 1;
            }
            rep.last_transaction = get_block_timestamp();

            // Reputation formula: success_rate * 700 + volume_factor * 200 + recency * 100 - penalties
            let success_rate = if rep.total_transactions > 0 {
                (rep.successful_transactions * 700) / rep.total_transactions
            } else { 0 };
            let volume_factor: u64 = if rep.total_volume > 1_000_000_000000 { 200 } else {
                ((rep.total_volume * 200) / 1_000_000_000000).try_into().unwrap()
            };
            let recency: u64 = if get_block_timestamp() - rep.last_transaction < 2_592_000 { 100 } else { 0 };
            let penalty: u64 = (rep.blacklist_count * 50).into();
            let raw = success_rate + volume_factor + recency;
            rep.reputation_score = if raw > penalty { (raw - penalty).try_into().unwrap() } else { 0 };
            if rep.reputation_score > 1000 { rep.reputation_score = 1000; }
            self.merchant_reputation.entry(merchant).write(rep);
            self.emit(MerchantReputationUpdated { merchant, card: get_caller_address(), reputation_score: rep.reputation_score, timestamp: get_block_timestamp() });
        }

        fn increment_merchant_blacklist_count(ref self: ContractState, merchant: ContractAddress) {
            assert(self.card_exists.entry(get_caller_address()).read(), 'Not a card');
            let mut rep = self.merchant_reputation.entry(merchant).read();
            rep.blacklist_count += 1;
            let penalty: u16 = (rep.blacklist_count * 50).try_into().unwrap();
            if rep.reputation_score > penalty { rep.reputation_score -= penalty; } else { rep.reputation_score = 0; }
            self.merchant_reputation.entry(merchant).write(rep);
        }

        fn get_protocol_config(self: @ContractState) -> ProtocolConfig {
            ProtocolConfig {
                admin_wallet: self.admin_wallet.read(),
                burn_fee: self.burn_fee.read(),
                transaction_fee_percent: self.transaction_fee_percent.read(),
                transaction_fee_cap: self.transaction_fee_cap.read(),
                user_cashback_percent: self.user_cashback_percent.read(),
                avnu_router: self.avnu_router.read(),
            }
        }

        fn is_merchant_registered(self: @ContractState, merchant: ContractAddress) -> bool {
            self.merchant_registered.entry(merchant).read()
        }

        fn is_merchant_active(self: @ContractState, merchant: ContractAddress) -> bool {
            if !self.merchant_registered.entry(merchant).read() { return false; }
            let info = self.merchant_info.entry(merchant).read();
            info.is_active
        }

        fn is_merchant_globally_blacklisted(self: @ContractState, merchant: ContractAddress) -> bool {
            self.global_merchant_blacklist.entry(merchant).read()
        }

        fn get_merchant_info(self: @ContractState, merchant: ContractAddress) -> MerchantInfo {
            assert(self.merchant_registered.entry(merchant).read(), 'Not registered');
            self.merchant_info.entry(merchant).read()
        }

        fn get_merchant_payout_wallet(self: @ContractState, merchant: ContractAddress) -> ContractAddress {
            self.merchant_payout_wallet.entry(merchant).read()
        }

        fn get_merchant_discount(self: @ContractState, merchant: ContractAddress) -> u16 {
            self.merchant_discount.entry(merchant).read()
        }

        fn get_merchant_reputation(self: @ContractState, merchant: ContractAddress) -> MerchantReputation {
            let full = self.merchant_reputation.entry(merchant).read();
            MerchantReputation { reputation_score: full.reputation_score, total_processed: full.total_volume }
        }

        fn is_card_deployed(self: @ContractState, card: ContractAddress) -> bool {
            self.card_exists.entry(card).read()
        }

        fn get_total_cards_deployed(self: @ContractState) -> u64 { self.total_cards_deployed.read() }
        fn get_vault_class_hash(self: @ContractState) -> ClassHash { self.vault_class_hash.read() }
        fn get_total_merchants(self: @ContractState) -> u64 { self.total_merchants.read() }
        fn get_owner(self: @ContractState) -> ContractAddress { self.ownable.owner() }

        fn is_token_accepted(self: @ContractState, token: ContractAddress) -> bool {
            self.is_token_accepted.entry(token).read()
        }

        fn get_accepted_tokens(self: @ContractState) -> Span<ContractAddress> {
            let count = self.accepted_token_count.read();
            let mut out = ArrayTrait::new();
            let mut i: u32 = 0;
            loop {
                if i >= count { break; }
                let t = self.accepted_tokens.entry(i).read();
                if self.is_token_accepted.entry(t).read() { out.append(t); }
                i += 1;
            };
            out.span()
        }
    }

    // ====================================================================
    // UPGRADEABLE
    // ====================================================================

    #[abi(embed_v0)]
    impl UpgradeableImpl of IUpgradeable<ContractState> {
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            self.upgradeable.upgrade(new_class_hash);
        }
    }

    // ====================================================================
    // INTERNAL HELPERS
    // ====================================================================

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _assert_relayer(self: @ContractState) {
            assert(get_caller_address() == self.authorized_relayer.read(), 'Relayer only');
        }

        fn _assert_registered_user(self: @ContractState) {
            let caller = get_caller_address();
            assert(self.registered_users.entry(caller).read() || caller == self.authorized_relayer.read(), 'User not registered');
        }
    }
}
