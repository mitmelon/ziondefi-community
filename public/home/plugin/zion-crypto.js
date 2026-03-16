/**
 * ZionCrypto — Client-Side Key Generation
 * =========================================
 *
 *
 * Two namespaces:
 *
 *   ZionCrypto.Pin     — Deterministic PIN key derivation & signing.
 *                         PIN keys can always be re-derived from PIN + address.
 *                         Nothing to back up.
 *
 *   ZionCrypto.Wallet  — Starknet account (wallet) creation.
 *                         Generates a 12-word BIP-39 mnemonic seed phrase.
 *                         The mnemonic IS the backup. User MUST write it down.
 *                         Losing it = losing the wallet permanently.
 *
 * What gets sent to the server:
 *   - PIN public key only
 *   - Wallet public key only
 *   - PIN signatures (sigR, sigS) for each transaction
 *
 * What NEVER leaves the device:
 *   - PIN (numeric)
 *   - PIN private key (re-derivable from PIN)
 *   - Wallet mnemonic / private key
 *
 * Dependencies:
 *   <script src="/home/plugin/starknet.bundle.min.js"></script>
 *   <script src="/home/plugin/zion-crypto.js"></script>
 */
(function (global) {
    'use strict';

    if (typeof global.StarknetLib === 'undefined') {
        throw new Error(
            'ZionCrypto: StarknetLib not found. ' +
            'Load starknet.bundle.min.js before zion-crypto.js.'
        );
    }

    const { ec, hash, num } = global.StarknetLib;

    const TAG = Object.freeze({
        PIN_DERIVATION: '0x50494e5f44455249564154494f4e5f5631', // 'PIN_DERIVATION_V1'
        VERIFY:         '0x564552494659',                        // 'VERIFY'
        ROTATE:         '0x524f54415445',                        // 'ROTATE'
    });

    const Pin = Object.freeze({

        /**
         * Derive a deterministic ECDSA key pair from a PIN and user address.
         *
         * @param {string|number} pin         — numeric PIN (e.g. 123456)
         * @param {string}        userAddress — user's Starknet wallet address (hex)
         * @returns {{ privateKey: string, publicKey: string }} hex strings
         *
         * @example
         *   const { privateKey, publicKey } = ZionCrypto.Pin.deriveKeys(123456, '0xABC...');
         *   // Send publicKey to server for card deployment.
         *   // privateKey stays on device — used only for signing.
         */
        deriveKeys(pin, userAddress) {
            if (!pin && pin !== 0) throw new Error('PIN is required.');
            if (!userAddress) throw new Error('User address is required.');

            const pinFelt = hash.starknetKeccak(pin.toString());
            const seed = hash.computePoseidonHashOnElements([
                TAG.PIN_DERIVATION,
                num.toHex(pinFelt),
                userAddress,
            ]);
            const privateKey = num.toHex(seed);
            const publicKey = ec.starkCurve.getStarkKey(privateKey);
            return { privateKey, publicKey };
        },

        /**
         * Sign a VERIFY challenge
         *
         * @param {string}        privateKey — from deriveKeys()
         * @param {string|bigint} nonce      — fetch via server: card.getPinNonce(userAddress)
         * @returns {{ sigR: string, sigS: string }} hex strings → send to server
         */
        signVerify(privateKey, nonce) {
            if (!privateKey) throw new Error('Private key is required.');
            
            const VERIFY_FELT = BigInt('0x564552494659');
            const nonceBigInt = BigInt(nonce);
            
            const messageHash = hash.computePoseidonHashOnElements([
                VERIFY_FELT,
                nonceBigInt
            ]);
    
            const signature = ec.starkCurve.sign(messageHash, privateKey);
            
            return {
                sigR: num.toHex(signature.r),
                sigS: num.toHex(signature.s),
            };
        },

        /**
         * Sign a ROTATE challenge (change PIN).
         *
         * Matches on-chain: Poseidon('ROTATE', newPublicKey, nonce) → ECDSA sign with OLD key.
         *
         * @param {string}        oldPrivateKey — current PIN private key
         * @param {string}        newPublicKey  — from deriveKeys(newPin, address).publicKey
         * @param {string|bigint} nonce         — current on-chain nonce
         * @returns {{ sigR: string, sigS: string }}
         *
         * @example
         *   const oldKeys = ZionCrypto.Pin.deriveKeys(oldPin, address);
         *   const newKeys = ZionCrypto.Pin.deriveKeys(newPin, address);
         *   const { sigR, sigS } = ZionCrypto.Pin.signRotation(
         *       oldKeys.privateKey, newKeys.publicKey, nonce
         *   );
         *   // Send { newPublicKey: newKeys.publicKey, sigR, sigS } to server
         */
        signRotation(oldPrivateKey, newPublicKey, nonce) {
            if (!oldPrivateKey) throw new Error('Old private key is required.');
            if (!newPublicKey) throw new Error('New public key is required.');

            const messageHash = hash.computePoseidonHashOnElements([
                TAG.ROTATE,
                newPublicKey,
                typeof nonce === 'string' ? nonce : num.toHex(nonce),
            ]);
            const sig = ec.starkCurve.sign(messageHash, oldPrivateKey);
            return {
                sigR: num.toHex(sig.r),
                sigS: num.toHex(sig.s),
            };
        },
    });

    global.ZionCrypto = Object.freeze({
        Pin
    });

})(typeof globalThis !== 'undefined' ? globalThis : self);
