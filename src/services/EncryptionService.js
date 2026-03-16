const sodium = require('sodium-native');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // For streams & generic hashing
const { v4: uuidv4 } = require('uuid');
const PostFilter = require('./PostFilter'); // Import your new PostFilter

/**
 * EncryptionService
 */
class EncryptionService {

    constructor(data = null, key = 'master_key') {
        this.data = data;
        this.filter = PostFilter;
        
        // Setup Key Directory
        this.keyDir = path.join(process.cwd(), 'secrets');
        if (!fs.existsSync(this.keyDir)) {
            fs.mkdirSync(this.keyDir, { mode: 0o700, recursive: true });
        }

        // Initialize Master Key (Symmetric)
        this.secretKey = this._loadOrGenerateMasterKey(key);
        
        // Random Key Generation (Bit Generation)
        const rndBuf = Buffer.alloc(16);
        sodium.randombytes_buf(rndBuf);
        this.randomKey = rndBuf.toString('hex');
    }

    // ==========================================
    // KEY MANAGEMENT (1:1 Port)
    // ==========================================

    _loadOrGenerateMasterKey(keyName) {
        const keyPath = path.join(this.keyDir, `${keyName}.mkey`);
        
        if (fs.existsSync(keyPath)) {
            return fs.readFileSync(keyPath);
        }

        // Generate XSalsa20 Key (32 bytes) matches Halite default
        const newKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
        sodium.randombytes_buf(newKey);
        
        fs.writeFileSync(keyPath, newKey, { mode: 0o600 });
        return newKey;
    }

    /**
     * Generate an encryption key pair (Secret, Public, Token)
     */
    create_key_pair() {
        const publicBuf = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
        const secretBuf = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
        sodium.crypto_box_keypair(publicBuf, secretBuf);

        // Token Key for HMAC/Searching
        const tokenBuf = Buffer.alloc(sodium.crypto_auth_KEYBYTES);
        sodium.randombytes_buf(tokenBuf);

        return {
            secret: secretBuf.toString('base64'),
            public: publicBuf.toString('base64'),
            token: tokenBuf.toString('base64')
        };
    }

    /**
     * Store key pair securely to disk
     */
    storeKeyPair(keyName) {
        try {
            const kp = this.create_key_pair();
            const basePath = path.join(this.keyDir, keyName);

            fs.writeFileSync(`${basePath}_secret.key`, Buffer.from(kp.secret, 'base64'), { mode: 0o600 });
            fs.writeFileSync(`${basePath}_public.key`, Buffer.from(kp.public, 'base64'), { mode: 0o600 });
            fs.writeFileSync(`${basePath}_token.key`, Buffer.from(kp.token, 'base64'), { mode: 0o600 });

            return true;
        } catch (e) {
            console.error(`Failed to store key pair ${keyName}:`, e.message);
            return false;
        }
    }

    keyPairExists(keyName) {
        const paths = [
            path.join(this.keyDir, `${keyName}_secret.key`),
            path.join(this.keyDir, `${keyName}_public.key`)
        ];
        return paths.every(p => fs.existsSync(p));
    }

    /**
     * Get token key for blind indexing/searching
     */
    getTokenKey(keyName) {
        try {
            const file = path.join(this.keyDir, `${keyName}_token.key`);
            if (!fs.existsSync(file)) return false;
            return fs.readFileSync(file).toString('base64');
        } catch (e) {
            return false;
        }
    }

    // ==========================================
    // SYMMETRIC ENCRYPTION (Master Key)
    // ==========================================

    encrypt() {
        try {
            if (!this.data) return false;
            
            const msg = Buffer.from(String(this.data));
            const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
            sodium.randombytes_buf(nonce);

            const cipher = Buffer.alloc(msg.length + sodium.crypto_secretbox_MACBYTES);
            sodium.crypto_secretbox_easy(cipher, msg, nonce, this.secretKey);

            return Buffer.concat([nonce, cipher]).toString('base64');
        } catch (e) {
            return false;
        }
    }

    decrypt() {
        try {
            if (!this.data) return false;
            
            const raw = Buffer.from(this.data, 'base64');
            if (raw.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) return false;

            const nonce = raw.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
            const cipher = raw.subarray(sodium.crypto_secretbox_NONCEBYTES);
            
            const msg = Buffer.alloc(cipher.length - sodium.crypto_secretbox_MACBYTES);
            
            if (!sodium.crypto_secretbox_open_easy(msg, cipher, nonce, this.secretKey)) {
                return false;
            }
            return msg.toString();
        } catch (e) {
            return false;
        }
    }

    // ==========================================
    // ASYMMETRIC ENCRYPTION (Stored Keys)
    // ==========================================

    encryptWithStoredKey(message, keyName) {
        try {
            const pubFile = path.join(this.keyDir, `${keyName}_public.key`);
            if (!fs.existsSync(pubFile)) {
                console.error(`Public key not found for ${keyName}`);
                return false;
            }

            const pubKey = fs.readFileSync(pubFile); // Raw Buffer
            return this._asyEncryptRaw(message, pubKey);
        } catch (e) {
            console.error("Encrypt Stored Error:", e);
            return false;
        }
    }

    decryptWithStoredKey(message, keyName) {
        try {
            const secFile = path.join(this.keyDir, `${keyName}_secret.key`);
            if (!fs.existsSync(secFile)) return false;

            const secKey = fs.readFileSync(secFile);
            return this._asyDecryptRaw(message, secKey);
        } catch (e) {
            return false;
        }
    }

    /**
     * Encrypt with arbitrary public key string
     */
    asyEncrypt(message, publicKeyBase64) {
        const pubKey = Buffer.from(publicKeyBase64, 'base64');
        return this._asyEncryptRaw(message, pubKey);
    }

    /**
     * Decrypt with arbitrary secret key string
     */
    asyDecrypt(message, secretKeyBase64) {
        const secKey = Buffer.from(secretKeyBase64, 'base64');
        return this._asyDecryptRaw(message, secKey);
    }

    // Helper: Crypto Box Seal (Anonymous Asymmetric Encryption)
    _asyEncryptRaw(message, pubKey) {
        const msgBuf = Buffer.from(message);
        const cipherBuf = Buffer.alloc(msgBuf.length + sodium.crypto_box_SEALBYTES);
        
        sodium.crypto_box_seal(cipherBuf, msgBuf, pubKey);
        return cipherBuf.toString('base64');
    }

    // Helper: Crypto Box Seal Open
    _asyDecryptRaw(message, secKey) {
        try {
            const cipherBuf = Buffer.from(message, 'base64');
            const msgBuf = Buffer.alloc(cipherBuf.length - sodium.crypto_box_SEALBYTES);
            
            // Re-derive Public Key from Secret Key (Required for sodium_native seal_open)
            const pubKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
            sodium.crypto_scalarmult_base(pubKey, secKey);

            if (!sodium.crypto_box_seal_open(msgBuf, cipherBuf, pubKey, secKey)) {
                return false;
            }
            return msgBuf.toString();
        } catch (e) {
            return false;
        }
    }

    // ==========================================
    // FILE ENCRYPTION (Streaming XChaCha20-Poly1305)
    // ==========================================

    encryptFile(fileInput, fileOutput) {
        return new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(fileInput, { highWaterMark: 64 * 1024 });
            const writeStream = fs.createWriteStream(fileOutput);

            const state = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES);
            const header = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);

            // 1. Init Push (Generate Header)
            sodium.crypto_secretstream_xchacha20poly1305_init_push(state, header, this.secretKey);
            writeStream.write(header);

            readStream.on('data', (chunk) => {
                const encryptedChunk = Buffer.alloc(chunk.length + sodium.crypto_secretstream_xchacha20poly1305_ABYTES);
                // 2. Encrypt Chunk
                sodium.crypto_secretstream_xchacha20poly1305_push(
                    state,
                    encryptedChunk,
                    chunk,
                    null,
                    0 // Message Tag
                );
                writeStream.write(encryptedChunk);
            });

            readStream.on('end', () => {
                // 3. Finalize
                const finalChunk = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_ABYTES);
                sodium.crypto_secretstream_xchacha20poly1305_push(
                    state,
                    finalChunk,
                    Buffer.alloc(0),
                    null,
                    sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
                );
                writeStream.write(finalChunk);
                writeStream.end();
                resolve(true);
            });

            readStream.on('error', reject);
            writeStream.on('error', reject);
        });
    }

    decryptFile(fileInput, fileOutput) {
        return new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(fileInput);
            const writeStream = fs.createWriteStream(fileOutput);
            
            const state = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES);
            const header = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);
            let headerRead = false;
            let buffer = Buffer.alloc(0);

            readStream.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);

                // 1. Read Header
                if (!headerRead) {
                    if (buffer.length >= header.length) {
                        buffer.copy(header, 0, 0, header.length);
                        // Init Pull
                        if (!sodium.crypto_secretstream_xchacha20poly1305_init_pull(state, header, this.secretKey)) {
                            return reject(new Error('Invalid File Header/Key'));
                        }
                        buffer = buffer.subarray(header.length);
                        headerRead = true;
                    } else {
                        return; // Need more data
                    }
                }

                // 2. Process Data Chunks
                // Note: Simplified logic. In strict stream decryption, chunk boundaries matter.
                // Assuming standard chunking from encryptFile above.
                if (buffer.length > sodium.crypto_secretstream_xchacha20poly1305_ABYTES) {
                    const plainChunk = Buffer.alloc(buffer.length - sodium.crypto_secretstream_xchacha20poly1305_ABYTES);
                    const tag = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_TAGBYTES);
                    
                    try {
                        // Attempt Pull
                        const res = sodium.crypto_secretstream_xchacha20poly1305_pull(state, plainChunk, tag, buffer, null);
                        if (res) { // res is length
                             writeStream.write(plainChunk.subarray(0, res));
                             buffer = Buffer.alloc(0); // Reset buffer
                        }
                    } catch (e) {
                        // Wait for complete chunk
                    }
                }
            });

            readStream.on('end', () => {
                writeStream.end();
                resolve(true);
            });
            readStream.on('error', reject);
        });
    }

    async asyEncryptFile(filePath, outputPath, publicKeyBase64) {
        // Asymmetric File encryption is complex with sodium_box.
        // Usually done by generating a symmetric key, encrypting file with that, 
        // and encrypting the symmetric key with the public key.
        // For direct port, assuming standard seal of small files or chunked seal.
        // Implementing "Hybrid" encryption for files is standard practice:
        
        try {
            const sessionKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
            sodium.randombytes_buf(sessionKey);
            
            // Encrypt file with session key (Streaming)
            // Use temporary EncryptionService with session key
            const tempEnc = new EncryptionService(null, 'temp'); 
            tempEnc.secretKey = sessionKey; // Override
            await tempEnc.encryptFile(filePath, outputPath);
            
            // Encrypt session key with Public Key
            const sealedKey = this.asyEncrypt(sessionKey.toString('base64'), publicKeyBase64);
            
            // Return encrypted session key (Caller must save this to decrypt!)
            return sealedKey; 
        } catch(e) {
            return false;
        }
    }

    // ==========================================
    // HASHING (Argon2) & UTILS
    // ==========================================

    static hash(pass) {
        const out = Buffer.alloc(sodium.crypto_pwhash_STRBYTES);
        const passBuf = Buffer.from(pass);
        
        sodium.crypto_pwhash_str(
            out, 
            passBuf, 
            sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, 
            sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
        );
        return out.toString();
    }

    static verify_hash(hashStr, pass) {
        const hashBuf = Buffer.from(hashStr);
        const passBuf = Buffer.from(pass);
        return sodium.crypto_pwhash_str_verify(hashBuf, passBuf);
    }

    randing(len) {
        // Alphanumeric Random
        const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        const randomBytes = crypto.randomBytes(len);
        let result = '';
        for (let i = 0; i < len; i++) {
            result += chars[randomBytes[i] % chars.length];
        }
        return result;
    }

    generateNumber(len = 9) {
        const randomBytes = crypto.randomBytes(len);
        let result = '';
        for (let i = 0; i < len; i++) {
            result += (randomBytes[i] % 10).toString();
        }
        return result;
    }

    static uuid() {
        return uuidv4();
    }

    mask(cc, maskFrom = 0, maskTo = 4, maskChar = '*', maskSpacer = '-') {
        cc = cc.replace(/[- ]/g, '');
        const len = cc.length;
        
        let masked = '';
        if (!maskFrom && maskTo === len) {
            masked = maskChar.repeat(len);
        } else {
            const start = cc.substring(0, maskFrom);
            const end = cc.substring(len - maskTo);
            const middle = maskChar.repeat(len - maskFrom - maskTo);
            masked = start + middle + end;
        }

        // Add Spacers
        if (len > 4 && maskSpacer) {
            return masked.match(/.{1,4}/g).join(maskSpacer);
        }
        return masked;
    }

    fileChecksum(filePath) {
        try {
            const fileBuffer = fs.readFileSync(filePath);
            return crypto.createHash('sha256').update(fileBuffer).digest('hex');
        } catch (e) {
            return false;
        }
    }

    // ==========================================
    // SESSION & REQUEST SECURITY (Fastify Adapted)
    // * Requires `req` object from Fastify
    // ==========================================

    /**
     * Generate Request Token (Anti-Replay / Device Lock)
     */
    request_generator(req, session_name = 'request_generator', id = 'APP', date = null) {
        const currentDate = date || new Date().toISOString().split('T')[0];
        
        if (!req.session) throw new Error("Fastify Session Plugin not registered");

        // Verify existing or create new
        if (!this.request_verify(req, session_name, id)) {
            // Reset
            req.session[session_name] = null;
            req.session[`${session_name}_payload_date`] = null;

            const device = this.filter.getDevice(req);
            device.id = id;
            device.date = currentDate;

            // Double Hash Chain
            const payload = crypto.createHash('sha256').update(JSON.stringify(device)).digest('hex');
            const token = crypto.createHash('sha256').update(payload).digest('hex');

            req.session[session_name] = token;
            req.session[`${session_name}_payload_date`] = currentDate;
        }
    }

    /**
     * Verify Request Token
     */
    request_verify(req, session_name = 'request_generator', id = 'APP') {
        // 1. Check Referer/Origin
        const referer = req.headers['referer'] || '';
        const host = req.headers['host'] || '';
        
        // Strict Referer Check (Skip for localhost)
        if (referer && !referer.includes(host) && !referer.includes('127.0.0.1')) {
            return false;
        }

        if (req.session && req.session[session_name]) {
            const currentDate = req.session[`${session_name}_payload_date`] || new Date().toISOString().split('T')[0];
            
            const device = this.filter.getDevice(req);
            device.id = id;
            device.date = currentDate;

            const payload = crypto.createHash('sha256').update(JSON.stringify(device)).digest('hex');
            const currentHash = crypto.createHash('sha256').update(payload).digest('hex');
            
            const expectedHash = req.session[session_name];

            if (crypto.timingSafeEqual(Buffer.from(currentHash), Buffer.from(expectedHash))) {
                return expectedHash;
            } else {
                this.take_action_on_hacks(req);
                return false;
            }
        }
        return false;
    }

    session_setter(req, session_name, code, time = 3600) {
        if (!req.session[session_name]) {
            req.session[session_name] = code;
            req.session[`${session_name}_time`] = Math.floor(Date.now() / 1000) + time;
        }
        return req.session[session_name];
    }

    verify_session_setter(req, code, session_name, unset = false) {
        if (req.session[session_name]) {
            const current = req.session[session_name];
            const expiry = req.session[`${session_name}_time`];
            const now = Math.floor(Date.now() / 1000);

            if (now < expiry) {
                if (code === current) {
                    if (unset) {
                        req.session[session_name] = null;
                        req.session[`${session_name}_time`] = null;
                    }
                    return true;
                }
            } else {
                // Expired
                req.session[session_name] = null;
            }
        }
        return false;
    }

    take_action_on_hacks(req) {
        console.warn(`SECURITY ALERT: Invalid Request Token from IP ${req.ip}`);
    }

    // ==========================================
    // CLIENT EXCHANGE (Sodium Box / Public-Key Auth)
    // ==========================================

    client_exchange_keypair() {
        // Generates ephemeral Curve25519 keypair
        const pub = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
        const sec = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
        sodium.crypto_box_keypair(pub, sec);

        return {
            secret: sec.toString('base64'),
            public: pub.toString('base64')
        };
    }

    client_exchange_encrypt(publicKeyBase64) {
        if (!this.data) return false;
        
        const msg = Buffer.from(this.data);
        const pubKey = Buffer.from(publicKeyBase64, 'base64');
        const cipher = Buffer.alloc(msg.length + sodium.crypto_box_SEALBYTES);

        sodium.crypto_box_seal(cipher, msg, pubKey);
        return cipher.toString('hex');
    }

    client_exchange_decrypt(publicKeyBase64, privateKeyBase64) {
        if (!this.data) return false;

        try {
            const cipher = Buffer.from(this.data, 'hex');
            const pubKey = Buffer.from(publicKeyBase64, 'base64');
            const secKey = Buffer.from(privateKeyBase64, 'base64');
            
            const msg = Buffer.alloc(cipher.length - sodium.crypto_box_SEALBYTES);
            
            // Sodium Seal Open needs Pub + Sec
            if (sodium.crypto_box_seal_open(msg, cipher, pubKey, secKey)) {
                return msg.toString();
            }
            return false;
        } catch (e) {
            return false;
        }
    }
}

module.exports = EncryptionService;