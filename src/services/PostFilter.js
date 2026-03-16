const sanitizeHtml = require('sanitize-html');
const DeviceDetector = require('device-detector-js');
const validator = require('validator');
const dns = require('dns').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * PostFilter
 * Handles Input Sanitization, Anti-XSS, Injection Prevention & Fingerprinting
 */
class PostFilter {
    constructor() {
        this.deviceDetector = new DeviceDetector();
        
        // NODE.JS & SYSTEM Injection Patterns (Replaces PHP patterns)
        this.dangerousPatterns = [
            // Javascript Code Execution
            /eval\s*\(/gi,
            /setTimeout\s*\(/gi,
            /setInterval\s*\(/gi,
            /Function\s*\(/gi,
            /new\s+Function/gi,
            
            // Node.js System Access
            /process\./gi,
            /process\['/gi,
            /child_process/gi,
            /require\s*\(/gi,
            /spawn\s*\(/gi,
            /exec\s*\(/gi,
            /fs\./gi,
            /fs\['/gi,
            /__dirname/gi,
            /__filename/gi,
            /module\.exports/gi,
            
            // SQL Injection (Universal)
            /\b(union\s+select|insert\s+into|update\s+set|delete\s+from|drop\s+table|truncate\s+table)\b/gi,
            /--/g, // SQL Comments
            
            // NoSQL Injection (MongoDB specific keys in string format)
            /\$where/g,
            /\$ne/g,
            /\$gt/g,
            /\$lt/g,
            /\$regex/g,
            /\$expr/g
        ];
    }

    /**
     * Check if string is empty or null
     */
    nothing(str) {
        return !str || str.toString().trim().length === 0;
    }

    /**
     * Aggressive String Stripping (XSS + Injection)
     * @param {string} value 
     * @param {boolean} onlyTextAndWhiteSpace 
     */
    strip(value, onlyTextAndWhiteSpace = false) {
        if (value === null || value === undefined) return value;
        if (typeof value !== 'string') value = String(value);

        // 1. Clean UTF-8/Control Characters (Remove all except Tab/Newlines)
        // \x00-\x08\x0B\x0C\x0E-\x1F\x7F matches control chars
        value = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

        // 2. Strict Alphanumeric Filter (Optional)
        if (onlyTextAndWhiteSpace) {
            value = value.replace(/[^a-zA-Z0-9\s-]/g, '');
        }

        // 3. Apply Node/SQL Security Filter
        return this.comprehensiveStringFilter(value);
    }

    /**
     * Remove Dangerous Patterns and Escape HTML
     */
    comprehensiveStringFilter(input) {
        if (!input) return '';

        let clean = input;
        
        // Remove Dangerous Patterns
        this.dangerousPatterns.forEach(pattern => {
            clean = clean.replace(pattern, '');
        });

        // HTML Entity Encode (Prevents XSS in View)
        return validator.escape(clean);
    }

    /**
     * JSON Sanitizer (Recursive)
     * Handles Objects, Arrays, and Strings inside JSON
     */
    sanitizeJsonData(data) {
        if (data === null) return null;

        // Handle Arrays
        if (Array.isArray(data)) {
            return data.map(item => this.sanitizeJsonData(item));
        }

        // Handle Objects
        if (typeof data === 'object') {
            const cleanObj = {};
            for (const [key, val] of Object.entries(data)) {
                // Prevent Prototype Pollution
                if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
                
                const cleanKey = this.strip(key, true);
                if (cleanKey) {
                    cleanObj[cleanKey] = this.sanitizeJsonData(val);
                }
            }
            return cleanObj;
        }

        // Handle Strings
        if (typeof data === 'string') {
            // Check for URL (Preserve valid URLs)
            if (validator.isURL(data)) {
                return this.isValidDomain(data) ? data : null;
            }
            
            // Check for Emojis
            if (this.containsEmoji(data)) {
                const sanitizedEmoji = this.sanitizeEmojis(data);
                if (!sanitizedEmoji) return null;
                return sanitizedEmoji;
            }

            return this.strip(data);
        }

        return data; // Numbers, Booleans are safe
    }

    /**
     * Emoji Sanitizer
     * Removes invalid unicode while preserving valid emojis
     */
    sanitizeEmojis(input) {
        // Regex for valid Emoji ranges
        const emojiRegex = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;
        const textRegex = /[a-zA-Z0-9\s.,!?-]/g;
        
        let sanitized = '';
        for (const char of input) {
            if (char.match(emojiRegex) || char.match(textRegex)) {
                sanitized += char;
            }
        }
        return sanitized;
    }

    containsEmoji(input) {
        return /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu.test(input);
    }

    /**
     * HTML Sanitizer (HTMLPurifier equivalent)
     * Uses sanitize-html with strict config
     */
    htmlSanitize(input) {
        if (!input) return '';
        
        // If no HTML tags, just strip
        if (!/<[a-z][\s\S]*>/i.test(input)) {
            return this.comprehensiveStringFilter(input);
        }

        return sanitizeHtml(input, {
            allowedTags: ['p', 'b', 'i', 'u', 'a', 'ul', 'ol', 'li', 'br', 'strong', 'em', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'img', 'pre', 'code', 'hr'],
            allowedAttributes: {
                'a': ['href', 'title'],
                'img': ['src', 'alt', 'title', 'width', 'height']
            },
            allowedSchemes: ['http', 'https', 'mailto'],
            allowProtocolRelative: false,
            disallowedTagsMode: 'discard',
            // Enforce blank target for links
            transformTags: {
                'a': sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' })
            }
        });
    }

    /**
     * File Name Sanitizer
     * Prevents Directory Traversal & Shell Execution via filenames
     */
    sanitizeFileName(filename, replacement = '_', maxLength = 255) {
        if (!filename) return null;
        
        // Remove path info
        filename = path.basename(filename);

        // Remove System Reserved Chars
        filename = filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, replacement);

        // Prevent Double Dots
        filename = filename.replace(/\.\.+/g, replacement);
        
        // Handle Extensions
        const ext = path.extname(filename).toLowerCase();
        const dangerousExts = ['.php', '.js', '.exe', '.sh', '.bat', '.cmd', '.dll', '.cgi', '.pl', '.py', '.jar'];
        
        if (dangerousExts.includes(ext)) {
            // Neutralize dangerous extensions
            filename = filename + '.txt'; 
        }

        // Trim length
        if (filename.length > maxLength) {
            filename = filename.substring(0, maxLength);
        }

        return filename;
    }

    /**
     * Email Validation (RFC + DNS MX Check)
     */
    async validateEmail(email) {
        if (!validator.isEmail(email)) return false;
        
        const domain = email.split('@')[1];
        if (!domain) return false;

        try {
            // Perform DNS MX Lookup
            const records = await dns.resolveMx(domain);
            return records && records.length > 0;
        } catch (e) {
            return false;
        }
    }

    validatePhone(phone) {
        // Strip everything except numbers and +
        const sanitized = phone.replace(/[^0-9+]/g, '');
        // Basic length check (International standards usually 10-15 chars)
        return sanitized.length >= 10 && sanitized.length <= 15;
    }

    validateName(name) {
        const trimmed = name.trim();
        // Check length and assure at least two names (First Last)
        if (trimmed.length > 50 || trimmed.length < 3) return false;
        return trimmed.split(' ').length >= 2;
    }

    validateDomain(domain) {
        // Regex for valid domain (RFC 1035)
        const regex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
        return regex.test(domain);
    }

    isValidDomain(url) {
        try {
            const parsed = new URL(url);
            // Allow Localhost for dev
            if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
            
            // Allow S3 or Trusted CDNs
            if (url.includes('amazonaws.com') || url.includes('cloudinary.com')) return true;

            return this.validateDomain(parsed.hostname);
        } catch (e) {
            return false;
        }
    }

    /**
     * Device Fingerprinting
     * Compatible with Fastify Request object
     */
    getDevice(req) {
        const ua = req.headers['user-agent'] || '';
        // Fastify handles IP via req.ip (trust proxy must be enabled in app config)
        const ip = req.ip || '127.0.0.1'; 
        
        const result = this.deviceDetector.parse(ua);

        let clientFp = null;
        if (req.body && req.body.fingerprint) {
            clientFp = req.body.fingerprint;
        } else if (req.cookies && req.cookies['x_device_id']) {
            clientFp = req.cookies['x_device_id'];
        }

        return {
            ip: ip,
            ua: ua,
            browser: result.client?.name || 'Unknown',
            browser_version: result.client?.version || '',
            os: result.os?.name || 'Unknown',
            os_version: result.os?.version || '',
            device_type: result.device?.type || 'desktop',
            brand: result.device?.brand || '',
            model: result.device?.model || '',
            is_bot: result.bot !== null,
            bot_info: result.bot || null,
            fingerprint_hash: clientFp || this._generateFingerprintHash(req, result)
        };
    }

    _generateFingerprintHash(req, deviceData) {
        // Create a unique hash based on available headers + IP + Device Info
        const material = [
            req.ip,
            req.headers['user-agent'],
            req.headers['accept-language'],
            req.headers['accept-encoding'],
            deviceData.client?.name,
            deviceData.os?.name,
            deviceData.device?.type
        ].join('|');
        
        return crypto.createHash('sha256').update(material).digest('hex');
    }
}

module.exports = new PostFilter();

