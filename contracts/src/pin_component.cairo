// SPDX-License-Identifier: MIT
// ZionDefi Protocol v2.0 — PIN Verification Component
// ECDSA-signature-based PIN with nonce replay protection.
// Used as a Starknet component embedded in ZionDefiCard.

#[starknet::interface]
pub trait IPinComponent<TContractState> {
    /// Owner registers their ECDSA public key (one-time setup).
    fn register_pin(ref self: TContractState, public_key: felt252);
    /// Rotate to a new public key; requires signature from the *old* key.
    fn rotate_pin(ref self: TContractState, new_public_key: felt252, signature_r: felt252, signature_s: felt252);
    /// Verify a PIN signature for a given user (increments nonce to prevent replay).
    fn verify_pin(ref self: TContractState, user: starknet::ContractAddress, signature_r: felt252, signature_s: felt252);
    /// Read the stored public key for a user.
    fn get_pin_public_key(self: @TContractState, user: starknet::ContractAddress) -> felt252;
    /// Read the current nonce for a user (useful for off-chain signature construction).
    fn get_pin_nonce(self: @TContractState, user: starknet::ContractAddress) -> felt252;
}

#[starknet::component]
pub mod PinComponent {
    use starknet::{ContractAddress, get_caller_address};
    use starknet::storage::{Map, StoragePointerReadAccess, StoragePointerWriteAccess, StoragePathEntry};
    use core::ecdsa::check_ecdsa_signature;
    use core::poseidon::poseidon_hash_span;

    // ========================================================================
    // STORAGE
    // ========================================================================

    #[storage]
    pub struct Storage {
        /// user → ECDSA public key
        pin_user_keys: Map<ContractAddress, felt252>,
        /// user → monotonic nonce (prevents signature replay)
        pin_user_nonces: Map<ContractAddress, felt252>,
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        PinRegistered: PinRegistered,
        PinRotated: PinRotated,
        PinVerified: PinVerified,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PinRegistered {
        #[key]
        pub user: ContractAddress,
        pub public_key: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PinRotated {
        #[key]
        pub user: ContractAddress,
        pub new_public_key: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PinVerified {
        #[key]
        pub user: ContractAddress,
        pub nonce_used: felt252,
    }

    // ========================================================================
    // EMBEDDABLE EXTERNAL IMPLEMENTATION
    // ========================================================================

    #[embeddable_as(PinImpl)]
    impl PinComponentImpl<
        TContractState, +HasComponent<TContractState>
    > of super::IPinComponent<ComponentState<TContractState>> {

        fn register_pin(ref self: ComponentState<TContractState>, public_key: felt252) {
            let caller = get_caller_address();
            let current_key = self.pin_user_keys.entry(caller).read();
            assert(current_key == 0, 'PIN already registered');
            self.pin_user_keys.entry(caller).write(public_key);
            self.emit(PinRegistered { user: caller, public_key });
        }

        fn rotate_pin(
            ref self: ComponentState<TContractState>,
            new_public_key: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) {
            let caller = get_caller_address();
            let old_pub_key = self.pin_user_keys.entry(caller).read();
            assert(old_pub_key != 0, 'PIN not registered');

            let nonce = self.pin_user_nonces.entry(caller).read();

            // Message = Hash('ROTATE', new_key, nonce)
            let mut hash_input = ArrayTrait::new();
            hash_input.append('ROTATE');
            hash_input.append(new_public_key);
            hash_input.append(nonce);
            let message_hash = poseidon_hash_span(hash_input.span());

            let valid = check_ecdsa_signature(message_hash, old_pub_key, signature_r, signature_s);
            assert(valid, 'Invalid rotation signature');

            self.pin_user_keys.entry(caller).write(new_public_key);
            self.pin_user_nonces.entry(caller).write(nonce + 1);
            self.emit(PinRotated { user: caller, new_public_key });
        }

        fn verify_pin(
            ref self: ComponentState<TContractState>,
            user: ContractAddress,
            signature_r: felt252,
            signature_s: felt252,
        ) {
            let stored_pub_key = self.pin_user_keys.entry(user).read();
            assert(stored_pub_key != 0, 'PIN not registered');

            let nonce = self.pin_user_nonces.entry(user).read();

            // Message = Hash('VERIFY', nonce)
            let mut hash_input = ArrayTrait::new();
            hash_input.append('VERIFY');
            hash_input.append(nonce);
            let message_hash = poseidon_hash_span(hash_input.span());

            let valid = check_ecdsa_signature(message_hash, stored_pub_key, signature_r, signature_s);
            assert(valid, 'Invalid PIN signature');

            // Increment nonce to prevent replay
            self.pin_user_nonces.entry(user).write(nonce + 1);
            self.emit(PinVerified { user, nonce_used: nonce });
        }

        fn get_pin_public_key(self: @ComponentState<TContractState>, user: ContractAddress) -> felt252 {
            self.pin_user_keys.entry(user).read()
        }

        fn get_pin_nonce(self: @ComponentState<TContractState>, user: ContractAddress) -> felt252 {
            self.pin_user_nonces.entry(user).read()
        }
    }

    // ========================================================================
    // INTERNAL HELPERS  (callable from the host contract, not via ABI)
    // ========================================================================

    #[generate_trait]
    pub impl PinInternalImpl<
        TContractState, +HasComponent<TContractState>
    > of PinInternalTrait<TContractState> {
        /// Register a PIN public key for an arbitrary user.
        /// Used in the card constructor to set up the owner's PIN without
        /// requiring the owner to be the immediate caller (factory deploys).
        fn _register_pin_for(
            ref self: ComponentState<TContractState>,
            user: ContractAddress,
            public_key: felt252,
        ) {
            let current_key = self.pin_user_keys.entry(user).read();
            assert(current_key == 0, 'PIN already registered');
            self.pin_user_keys.entry(user).write(public_key);
            self.emit(PinRegistered { user, public_key });
        }

        /// Verify a PIN signature for a user (same logic as external, callable internally).
        fn _verify_pin(
            ref self: ComponentState<TContractState>,
            user: ContractAddress,
            signature_r: felt252,
            signature_s: felt252,
        ) {
            assert(self._try_verify_pin(user, signature_r, signature_s), 'Invalid PIN signature');
        }

        /// Non-panicking PIN verification.  Returns `true` when the
        /// signature is valid and `false` otherwise.  Nonce is only
        /// incremented on success so a failed attempt cannot burn nonces.
        fn _try_verify_pin(
            ref self: ComponentState<TContractState>,
            user: ContractAddress,
            signature_r: felt252,
            signature_s: felt252,
        ) -> bool {
            let stored_pub_key = self.pin_user_keys.entry(user).read();
            if stored_pub_key == 0 { return false; }

            let nonce = self.pin_user_nonces.entry(user).read();

            let mut hash_input = ArrayTrait::new();
            hash_input.append('VERIFY');
            hash_input.append(nonce);
            let message_hash = poseidon_hash_span(hash_input.span());

            let valid = check_ecdsa_signature(message_hash, stored_pub_key, signature_r, signature_s);
            if valid {
                self.pin_user_nonces.entry(user).write(nonce + 1);
                self.emit(PinVerified { user, nonce_used: nonce });
            }
            valid
        }
    }
}
