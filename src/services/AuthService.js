const PostFilter = require('./PostFilter');
const EncryptionService = require('./EncryptionService');
const RateLimiter = require('./RateLimiter');
const Firewall = require('./Firewall');
const crypto = require('crypto');
const DateHelper = require('../utils/DateHelper'); 
const { RpcProvider, typedData } = require('starknet');

class AuthService {
    constructor(dbModels) {
        this.User = dbModels.User;
        this.Session = dbModels.Session;
        this.Security = dbModels.Security;
        
        this.rl = new RateLimiter(this.Security);
        this.fw = new Firewall(this.Security);
        this.enc = new EncryptionService(); 
        this.date = new DateHelper(); 
    }

    /**
     * Verify Login Session
     */
    async loggedin(sessionToken, currentDevice) {
        if (!sessionToken) return false;

        const cleanToken = PostFilter.strip(sessionToken);
        const now = this.date.timestampTimeNow(); 

        const auth = await this.Session.getSession(cleanToken, now);

        if (!auth || !auth.user_id) return false;

        // Fingerprint Rotation Logic
        const storedFp = auth.device?.fingerprint_hash;
        const currentFp = currentDevice.fingerprint_hash;

        if (storedFp && currentFp && storedFp !== currentFp) {
            const storedIp = auth.device?.ip;
            const currentIp = currentDevice.ip;

            if (storedIp === currentIp) {
                 this.Session.updateOne(
                    { stoken: cleanToken },
                    { $set: { 'device.fingerprint_hash': currentFp } }
                 ).catch(console.error);
            } else {
                 await this.Session.destroySession(cleanToken);
                 return false;
            }
        }

        try {

            const SESSION_MINUTES = 60; 
            const MAX_AGE_SECONDS = SESSION_MINUTES * 60;

            const userData = await this.User.findOne({ user_id: auth.user_id }); 
            if (!userData) return false;

            const newExpire = this.date.addMinute(SESSION_MINUTES);
           
            this.Session.addMoreSessionTime(cleanToken, auth.user_id, newExpire, now).catch(console.error);

            return {
                status: true,
                user: userData,
                user_id: auth.user_id,
                session: cleanToken,
                timezone: userData.timezone || 'UTC',
                maxAge: MAX_AGE_SECONDS
            };
        } catch (e) {
            return false;
        }
    }

    /**
     * Login Logic
     */
    async login(username, password, device) {
        try {
            const ipIdentifier = device.ip || 'unknown';
            const fpIdentifier = device.fingerprint || 'unknown';

            if (await this.fw.isBlocked(ipIdentifier)) return { status: false, error: 'access_denied' };
            
            const allowIp = await this.rl.limit(ipIdentifier, 'METHOD_POST');
            const allowFp = await this.rl.limit(fpIdentifier, 'METHOD_POST');

            if (!allowIp || !allowFp) {
                await this.fw.block(ipIdentifier, 'Suspicious login activity');
                return { status: false, error: 'too_many_attempts' };
            }

            const user = await this.User.findOne({
                $or: [{ username: username }, { email: username }]
            });

            if (!user) return { status: false, error: 'invalid_credentials' };
            if (user.status === 0) return { status: false, error: "account_inactive", review: true };
            if (user.status !== 1) return { status: false, error: "account_locked", locked: true };

            const validPass = EncryptionService.verify_hash(user.pass, password);
            if (!validPass) return { status: false, error: 'invalid_credentials' };

            if (user.security && user.security.status === true) {
                return { status: true, security: true, payload: { user: user.user_id, device } };
            }

            const sessionToken = await this.setSession(user.user_id, device);
            if (!sessionToken) return { status: false, error: 'server_error' };

            return {
                status: true,
                security: false,
                message: "Login successful.",
                user: user.user_id,
                token: sessionToken
            };

        } catch (e) {
            console.error("Login Error:", e);
            return { status: false, error: "server_error" };
        }
    }

    /**
     * Set Session
     */
    async setSession(userId, device) {
        const now = this.date.timestampTimeNow(); // Update
        
        const existToken = await this.Session.getSessionByUserId(userId, now);
        if (existToken) {
            const oldFp = existToken.device?.fingerprint;
            const newFp = device.fingerprint;
            if (oldFp && newFp && oldFp === newFp) {
                return existToken.stoken;
            }
            await this.Session.destroySession(existToken.stoken);
        }

        const token = this.enc.randing(32);
        const expire = this.date.addMinute(120); // Update

        await this.Session.setSession(token, userId, expire, now, device);
        return token;
    }

    /**
     * REGISTER USER
     */
    async register(name, pass, company, identity, refId = '') {
        const User = this.User;
        const Security = this.Security;

        const ipIdentifier = identity.ip || 'unknown';
        const fpIdentifier = identity.fingerprint || 'unknown';

        if (await this.fw.isBlocked(ipIdentifier)) {
            return { status: false, error: 'access_denied' };
        }
        const allowIp = await this.rl.limit(ipIdentifier, 'METHOD_REGISTER'); 
        const allowFp = await this.rl.limit(fpIdentifier, 'METHOD_REGISTER');

        if (!allowIp || !allowFp) {
            await this.fw.block(ipIdentifier, 'Mass Registration Spam');
            return { status: false, error: "too_many_attempts" };
        }

        const key = this.enc.uuid(); 
        const username = 'zd-' + this.enc.randing(8).toLowerCase();
        
        const codex = crypto.createHash('sha256').update(key + email).digest('hex');
        
        const secData = JSON.stringify({
            fingerprint: identity.fingerprint,
            registered_device: identity,
            codex: codex
        });

        const hash = crypto.createHash('sha256').update(secData).digest('hex');
        
        // Encryption
        const encryptor = new EncryptionService(secData); 
        const securityEnc = encryptor.encrypt(); 

        if (!securityEnc) {
            console.error('encryption_failed');
            return { status: false, error: "server_error" };
        }

        const passwordHash = EncryptionService.hash(pass);

        const credentials = {
            user_id: key,
            name: name,
            username: username,
            pass: passwordHash,
            company: company,
            status: 0,
            account_type: 'user',
            stage: 'boarding',
            created_at: this.date.timestampTimeNow(), // Update
            security: {
                sec_data: securityEnc,
                data_hash: hash,
                status: false
            },
            referrals: [],
            referred_by: refId,
            is_live: false
        };

        await User.insertOne(credentials);

        const code = this.enc.randing(8).toLowerCase();
        const encryptService = new EncryptionService(JSON.stringify({ key: key, code: code }));
        const codeEncrypted = encryptService.encrypt();
        
        const vToken = this.enc.randing(32);
        
        await Security.createVerification({
            vToken: vToken,
            user_id: key,
            code: code,
            type: 'account_opening',
            device: identity,
            expire: this.date.addMinute(10), // Update
            status: 0
        });

        if (refId && refId.length > 0) {
            const referrer = await User.findOne({ username: refId });
            if (referrer && referrer.status === 1) {
                await User.updateOne(
                    { user_id: referrer.user_id },
                    { 
                        $push: { 
                            referrals: {
                                user: key,
                                claimed: false,
                                amount: parseFloat(process.env.REF_BONUS_AMOUNT || '0.00'),
                                status: 'unpaid',
                                currency: process.env.REF_BONUS_CURRENCY || 'USD',
                                created_at: this.date.timestampTimeNow(),
                                updated_at: this.date.timestampTimeNow()
                            }
                        } 
                    }
                );
            }
        }
       
        return { status: true, key: key, code: codeEncrypted, payload: hash };
    }

    async loginWithWallet(address, signature, typedDataMessage, device) {
        try {
            if (!address || !signature || !typedDataMessage) {
                return { status: false, error: 'invalid_signature_data' };
            }

            let normalizedAddr;
            try {
                normalizedAddr = "0x" + BigInt(address).toString(16).toLowerCase();
            } catch (err) {
                console.error("Address Normalization Failed:", err);
                return { status: false, error: 'invalid_address_format' };
            }

            const provider = new RpcProvider({ 
                nodeUrl: process.env.STARKNET_RPC_URL 
            });

            let sigArray = signature;
            if (typeof signature === 'string') {
                try {
                    const parsed = JSON.parse(signature);
                    if (Array.isArray(parsed)) sigArray = parsed;
                    else sigArray = [signature]; // Fallback
                } catch (e) {
                    sigArray = [signature];
                }
            } else if (!Array.isArray(signature)) {
                sigArray = [signature];
            }

            let typedDataObj = typedDataMessage;
            if (typeof typedDataMessage === 'string') {
                try { typedDataObj = JSON.parse(typedDataMessage); } catch(e) {}
            }

            try {
                // Calculate Hash
                const messageHash = typedData.getMessageHash(typedDataObj, address);
                
                const result = await provider.callContract({
                    contractAddress: address,
                    entrypoint: 'is_valid_signature',
                    calldata: [messageHash, sigArray.length, ...sigArray]
                });

                const resultBigInt = BigInt(result[0]);
                const MAGIC_VALID = 0x56414c4944n; 

                if (resultBigInt === 0n) {
                    console.warn(`Signature Rejected by Contract (Returned 0)`);
                    return { status: false, error: 'signature_verification_failed' };
                }

            } catch (rpcError) {
                if (rpcError.message.includes('Contract not found') || rpcError.message.includes('is not deployed')) {
                    return { status: false, error: 'account_not_deployed' };
                }
                return { status: false, error: 'signature_verification_failed' };
            }
           
            let user = await this.User.findOne({ 
                'security.wallet_address': normalizedAddr 
            });

            if (!user) {
                const key = this.enc.uuid();
                const username = 'zd-' + this.enc.randing(8).toLowerCase();

                const codex = crypto.createHash('sha256').update(key + normalizedAddr).digest('hex');
        
                const secData = JSON.stringify({
                    fingerprint: device.fingerprint,
                    registered_device: device,
                    codex: codex
                });

                const hash = crypto.createHash('sha256').update(secData).digest('hex');
                
                // Encryption
                const encryptor = new EncryptionService(secData); 
                const securityEnc = encryptor.encrypt(); 

                if (!securityEnc) {
                    return { status: false, error: "server_error" };
                }

                const passwordHash = EncryptionService.hash(this.enc.uuid());
                const credentials = {
                    user_id: key,
                    name: 'ZionDefi User', 
                    email: `${normalizedAddr}@${process.env.APP_DOMAIN}`, 
                    username: username,
                    pass: passwordHash,
                    company: null,
                    status: 1, 
                    account_type: 'user',
                    stage: 'boarding',
                    created_at: this.date.timestampTimeNow(),
                    security: {
                        sec_data: securityEnc,
                        data_hash: hash,
                        status: false,
                        wallet_address: normalizedAddr,
                        wallet_provider: device.wallet_provider
                    },
                    referrals: [],
                    referred_by: '',
                    is_live: false
                };

                await this.User.insertOne(credentials);
                user = await this.User.findOne({ user_id: key });
            }

            if (user.status === 0) return { status: false, error: "account_inactive" };
            if (user.status !== 1) return { status: false, error: "account_locked" };

            const sessionToken = await this.setSession(user.user_id, device);
            if (!sessionToken) return { status: false, error: 'server_error' };

            return {
                status: true,
                message: "Wallet login successful.",
                user: user.user_id,
                token: sessionToken
            };

        } catch (e) {
            console.error("Wallet Login System Error:", e);
            return { status: false, error: "server_error" };
        }
    }

    async incrementAddressValidationAttempts(userId) {
        try {
            await this.User.updateOne(
                { user_id: userId },
                { $inc: { 'security.address_validation_attempts': 1 } }
            );
        } catch (e) {
            console.error("Increment Address Validation Attempts Error:", e);
        }
    }
}

module.exports = AuthService;