import crypto from 'crypto';
import { config } from './config';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

/**
 * Encrypts a private key using the master encryption key
 */
export function encrypt(privateKey: string): string {
    const key = Buffer.from(config.encryptionKey, 'hex');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Return IV + encrypted data
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypts an encrypted private key
 */
export function decrypt(encryptedData: string): string {
    const key = Buffer.from(config.encryptionKey, 'hex');
    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts[1];

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
