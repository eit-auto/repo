/**
 * Encryption utilities for sensitive credentials
 * Uses symmetric encryption (AES-256-GCM) with key from environment
 */

const crypto = require('crypto');

class CryptoUtils {
    constructor(encryptionKey) {
        if (!encryptionKey) {
            throw new Error('ENCRYPTION_KEY environment variable is required');
        }
        
        // Derive a 32-byte key from the provided key
        this.key = crypto.createHash('sha256').update(encryptionKey).digest();
    }

    /**
     * Encrypt sensitive data
     * @param {string} plaintext - Data to encrypt
     * @returns {string} Base64-encoded encrypted data with IV and auth tag
     */
    encrypt(plaintext) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        
        let encrypted = cipher.update(plaintext, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        
        // Format: iv:authTag:encrypted (all hex-encoded)
        return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    }

    /**
     * Decrypt sensitive data
     * @param {string} encrypted - Base64-encoded encrypted data
     * @returns {string} Decrypted plaintext
     */
    decrypt(encrypted) {
        try {
            const parts = encrypted.split(':');
            if (parts.length !== 3) {
                throw new Error('Invalid encrypted data format');
            }

            const iv = Buffer.from(parts[0], 'hex');
            const authTag = Buffer.from(parts[1], 'hex');
            const ciphertext = parts[2];

            const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
            decipher.setAuthTag(authTag);

            let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (error) {
            throw new Error(`Decryption failed: ${error.message}`);
        }
    }

    /**
     * Encrypt a JSON object and return as base64
     */
    encryptJson(obj) {
        return this.encrypt(JSON.stringify(obj));
    }

    /**
     * Decrypt and parse JSON
     */
    decryptJson(encrypted) {
        const plaintext = this.decrypt(encrypted);
        return JSON.parse(plaintext);
    }
}

module.exports = CryptoUtils;