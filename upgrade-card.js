#!/usr/bin/env node
/**
 * upgrade-card.js — Upgrade a ZionDefi card contract on testnet
 *
 * Reads the card's on-chain owner, derives PIN keys from PIN + owner address,
 * verifies the derived public key matches on-chain, fetches the nonce,
 * signs a VERIFY proof, and calls upgrade(new_class_hash, sig_r, sig_s).
 *
 * Usage:
 *   node upgrade-card.js \
 *     --card  0xCARD_CONTRACT_ADDRESS \
 *     --pin   123456 \
 *     --hash  0xNEW_CLASS_HASH
 *
 *   Optional:
 *     --wallet 0xOWNER_WALLET   Override the auto-detected on-chain owner
 *     --owner-key 0xPRIV_KEY    Override the tx-signer private key (env default)
 *     --owner-addr 0xADDR       Override the tx-signer address (env default)
 */

require('dotenv').config();
const { ec, hash, num, Account, RpcProvider, CallData } = require('starknet');

// ── Parse CLI args ──────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {};
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i]?.replace(/^--/, '');
        const val = args[i + 1];
        if (key && val) opts[key] = val;
    }
    if (!opts.card) exit('Missing --card  <card contract address>');
    if (!opts.pin)  exit('Missing --pin   <numeric PIN>');
    if (!opts.hash) exit('Missing --hash  <new class hash>');
    return opts;
}

function exit(msg) {
    console.error(`\n  ✗ ${msg}\n`);
    process.exit(1);
}

// ── PIN derivation (mirrors ZionCrypto.Pin.deriveKeys) ──────────────────────
const TAG = {
    PIN_DERIVATION: '0x50494e5f44455249564154494f4e5f5631', // 'PIN_DERIVATION_V1'
    VERIFY:         '0x564552494659',                        // 'VERIFY'
};

function deriveKeys(pin, userAddress) {
    const pinFelt = hash.starknetKeccak(pin.toString());
    const seed = hash.computePoseidonHashOnElements([
        TAG.PIN_DERIVATION,
        num.toHex(pinFelt),
        userAddress,
    ]);
    const privateKey = num.toHex(seed);
    const publicKey  = ec.starkCurve.getStarkKey(privateKey);
    return { privateKey, publicKey };
}

// ── Signing (mirrors ZionCrypto.Pin.signVerify) ─────────────────────────────
function signVerify(privateKey, nonce) {
    const messageHash = hash.computePoseidonHashOnElements([
        TAG.VERIFY,
        typeof nonce === 'string' ? nonce : num.toHex(nonce),
    ]);
    const sig = ec.starkCurve.sign(messageHash, privateKey);
    return {
        sigR: num.toHex(sig.r),
        sigS: num.toHex(sig.s),
    };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs();

    console.log('\n  ╔══════════════════════════════════════════╗');
    console.log('  ║   ZionDefi Card Upgrade — Testnet        ║');
    console.log('  ╚══════════════════════════════════════════╝\n');

    console.log(`  Card address  : ${opts.card}`);
    console.log(`  New class hash: ${opts.hash}\n`);

    // 1. Create card service (testnet)
    console.log('  [1/6] Connecting to card contract …');
    const StarknetCardService = require('./src/services/StarknetCardService');
    const cardService = await StarknetCardService.create({
        cardAddress: opts.card,
        isLive: false,        // testnet
    });

    // 2. Read on-chain owner
    console.log('  [2/6] Reading on-chain card owner …');
    const cardInfo = await cardService.getCardInfo();
    const onChainOwner = cardInfo.owner;
    console.log(`        On-chain owner : ${onChainOwner}`);
    console.log(`        Relayer        : ${cardInfo.relayer}`);

    // Use --wallet override or auto-detected on-chain owner
    const walletAddress = opts.wallet || onChainOwner;
    if (opts.wallet) {
        console.log(`        Using --wallet : ${opts.wallet}  (override)`);
    } else {
        console.log(`        Using on-chain owner for PIN derivation`);
    }

    // 3. Derive PIN key pair
    console.log('  [3/6] Deriving PIN key pair …');
    const { privateKey, publicKey } = deriveKeys(opts.pin, walletAddress);
    console.log(`        Derived pubkey : ${publicKey}`);

    // 4. Verify derived key matches on-chain
    console.log('  [4/6] Verifying PIN public key on-chain …');
    // Try Poseidon first (Map in newer Cairo), then Pedersen (LegacyMap)
    const keyBase = hash.starknetKeccak('pin_user_keys');
    const poseidonKey = hash.computePoseidonHash(keyBase, onChainOwner);
    const pedersenKey = hash.computePedersenHash(keyBase, onChainOwner);

    const poseidonVal = await cardService.provider.getStorageAt(cardService.cardAddress, poseidonKey);
    const pedersenVal = await cardService.provider.getStorageAt(cardService.cardAddress, pedersenKey);

    console.log(`        Poseidon slot  : ${num.toHex(BigInt(poseidonVal))}`);
    console.log(`        Pedersen slot  : ${num.toHex(BigInt(pedersenVal))}`);

    const storedRaw = BigInt(poseidonVal) !== 0n ? poseidonVal : pedersenVal;
    const storedHex = num.toHex(BigInt(storedRaw));
    console.log(`        Stored pubkey  : ${storedHex}`);

    if (BigInt(publicKey) !== BigInt(storedRaw)) {
        console.error('\n  ✗ PIN KEY MISMATCH!');
        console.error(`    Derived : ${publicKey}`);
        console.error(`    On-chain: ${storedHex}`);
        console.error('    The PIN or wallet address is wrong. Check your --pin and --wallet values.\n');
        process.exit(1);
    }
    console.log('        ✓ Keys match');

    // 5. Fetch on-chain nonce & sign
    //    The deployed contract uses LegacyMap (Pedersen), not Map (Poseidon)
    console.log('  [5/6] Fetching PIN nonce & signing proof …');
    const nonceBase    = hash.starknetKeccak('pin_user_nonces');
    const noncePosKey  = hash.computePoseidonHash(nonceBase, onChainOwner);
    const noncePedKey  = hash.computePedersenHash(nonceBase, onChainOwner);
    const noncePosVal  = await cardService.provider.getStorageAt(cardService.cardAddress, noncePosKey);
    const noncePedVal  = await cardService.provider.getStorageAt(cardService.cardAddress, noncePedKey);
    console.log(`        Nonce Poseidon : ${Number(noncePosVal)}`);
    console.log(`        Nonce Pedersen : ${Number(noncePedVal)}`);
    const nonce = BigInt(noncePedVal) !== 0n ? Number(noncePedVal) : Number(noncePosVal);
    console.log(`        Using nonce    : ${nonce}`);

    const { sigR, sigS } = signVerify(privateKey, nonce);
    console.log(`        sig_r: ${sigR}`);
    console.log(`        sig_s: ${sigS}`);

    // 6. Execute upgrade via starknet.js Account directly (bypass Starkzap gas issues)
    console.log('  [6/6] Sending upgrade transaction …');
    const signerAddr = opts['owner-addr'] || process.env.TESTNET_OWNER_ACCOUNT_ADDRESS;
    const signerKey  = opts['owner-key']  || process.env.TESTNET_OWNER_PRIVATE_KEY;

    if (!signerAddr || !signerKey) {
        exit('Transaction signer not configured. Set TESTNET_OWNER_ACCOUNT_ADDRESS / TESTNET_OWNER_PRIVATE_KEY in .env or use --owner-addr / --owner-key');
    }
    console.log(`        Tx signer      : ${signerAddr}`);

    const rpcUrl = process.env.TESTNET_STARKNET_RPC_URL;
    if (!rpcUrl) exit('TESTNET_STARKNET_RPC_URL not set in .env');

    console.log(`        RPC URL        : ${rpcUrl.substring(0, 50)}…`);

    const provider = new RpcProvider({ nodeUrl: rpcUrl });
    const account = new Account({
        provider: { nodeUrl: rpcUrl },
        address: signerAddr,
        signer: signerKey,
    });

    const call = {
        contractAddress: opts.card,
        entrypoint: 'upgrade',
        calldata: CallData.compile([opts.hash, sigR, sigS]),
    };

    console.log('        Estimating fee …');
    const fee = await account.estimateInvokeFee([call]);
    console.log(`        Estimated fee  : ${fee.overall_fee.toString()} ${fee.unit || 'WEI'}`);

    // Apply generous multipliers to avoid "resource bounds not satisfied" on testnet
    const rb = fee.resourceBounds;
    const result = await account.execute([call], {
        resourceBounds: {
            l2_gas: {
                max_amount:         BigInt(rb.l2_gas.max_amount) * 2n,
                max_price_per_unit: BigInt(rb.l2_gas.max_price_per_unit) * 3n,
            },
            l1_gas: {
                max_amount:         BigInt(rb.l1_gas.max_amount || 0) * 2n + 100n,
                max_price_per_unit: BigInt(rb.l1_gas.max_price_per_unit || 0) * 3n + 1000000000000n,
            },
            l1_data_gas: {
                max_amount:         BigInt(rb.l1_data_gas.max_amount || 0) * 2n + 500n,
                max_price_per_unit: BigInt(rb.l1_data_gas.max_price_per_unit || 0) * 3n + 500000000000n,
            },
        },
    });
    console.log(`        Tx hash        : ${result.transaction_hash}`);

    console.log('        Waiting for confirmation …');
    const receipt = await provider.waitForTransaction(result.transaction_hash);

    console.log('\n  ✓ Upgrade successful!');
    console.log(`    Status  : ${receipt.execution_status || receipt.finality_status}`);
    console.log(`    Tx hash : ${result.transaction_hash}`);
    console.log(`    Explorer: ${process.env.EXPLORER_URL_SEPOLIA}/tx/${result.transaction_hash}\n`);
}

main().catch(err => {
    console.error('\n  ✗ Upgrade failed:\n');
    console.error(err);
    process.exit(1);
});
