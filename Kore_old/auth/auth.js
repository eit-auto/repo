/**
 * Kore Authentication System
 * 
 * Handles user registration, login, MFA, session tokens, and permissions
 */

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');

class Auth {
  constructor(korePool, cryptoUtils, securityConfig, logAuditFn) {
    this.korePool = korePool;
    this.crypto = cryptoUtils;
    this.config = securityConfig;
    this.logAudit = logAuditFn;
  }

  // ========== PASSWORD MANAGEMENT ==========
  
  /**
   * Validate password against security config requirements
   */
  validatePassword(password) {
    const errors = [];
    const cfg = this.config.password;
    
    if (password.length < cfg.minLength) {
      errors.push(`Password must be at least ${cfg.minLength} characters`);
    }
    
    if (cfg.requireUppercase && !/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }
    
    if (cfg.requireNumbersOrSpecial) {
      const hasNumber = /[0-9]/.test(password);
      const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
      if (!hasNumber && !hasSpecial) {
        errors.push('Password must contain at least one number or special character');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Hash a password with salt
   */
  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto
      .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
      .toString('hex');
    
    return { hash, salt };
  }

  /**
   * Verify password against stored hash
   */
  verifyPassword(plainPassword, storedHash, salt) {
    const hash = crypto
      .pbkdf2Sync(plainPassword, salt, 10000, 64, 'sha512')
      .toString('hex');
    
    return hash === storedHash;
  }

  // ========== TOTP / MFA ==========

  /**
   * Generate a new TOTP secret for a user
   */
  generateTOTPSecret(email) {
    const secret = speakeasy.generateSecret({
      name: `Kore (${email})`,
      issuer: 'Kore',
      length: 32
    });
    
    return {
      secret: secret.base32,
      ascii: secret.ascii
    };
  }

  /**
   * Generate QR code as data URL
   */
  async generateQRCode(secret, email) {
    const otpauth_url = speakeasy.otpauthURL({
      secret: secret,
      encoding: 'base32',
      label: `Kore (${email})`,
      issuer: 'Kore'
    });
    
    try {
      const qrCode = await QRCode.toDataURL(otpauth_url);
      return qrCode;
    } catch (err) {
      console.error('Error generating QR code:', err);
      throw err;
    }
  }

  /**
   * Verify TOTP code with clock skew tolerance
   */
  verifyTOTPCode(secret, code) {
    const cfg = this.config.mfa;
    
    return speakeasy.totp.verify({
      secret: secret,
      encoding: 'base32',
      token: code,
      window: cfg.allowedClockSkew || 1
    });
  }

  /**
   * Generate backup codes for account recovery
   */
  generateBackupCodes(count = 8) {
    const codes = [];
    const hashes = [];
    
    for (let i = 0; i < count; i++) {
      // Generate random 8-character alphanumeric code
      const code = crypto.randomBytes(6).toString('hex').toUpperCase().substring(0, 8);
      const hash = crypto.createHash('sha256').update(code).digest('hex');
      
      codes.push(code);
      hashes.push(hash);
    }
    
    return {
      plainCodes: codes,  // Show to user
      hashedCodes: hashes // Store in DB
    };
  }

  // ========== INVITE / SETUP ==========

  /**
   * Create a new user and send invite
   */
  async createUser(email, fullName, createdBy) {
    try {
      const inviteToken = crypto.randomBytes(32).toString('hex');
      const inviteTokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
      const inviteExpiresAt = new Date(Date.now() + this.config.invite.expirationHours * 60 * 60 * 1000);
      const userId = crypto.randomUUID();
      
      const query = `
        INSERT INTO users 
        (userId, email, fullName, status, inviteToken, inviteTokenHash, inviteExpiresAt, createdAt, createdBy)
        VALUES (?, ?, ?, 'invited', ?, ?, ?, NOW(), ?)
      `;
      
      await this.korePool.execute(query, [
        userId,
        email,
        fullName,
        inviteToken,
        inviteTokenHash,
        inviteExpiresAt,
        createdBy
      ]);
      
      await this.logAudit('user_created', 'user', userId, fullName, createdBy, 
        { email: email }, null);
      
      console.log(`[${new Date().toISOString()}] User created: ${email} (${userId})`);
      
      return {
        userId,
        inviteToken,
        inviteExpiresAt
      };
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR creating user:`, err.message);
      throw err;
    }
  }

  /**
   * Resend invite to user
   */
  async resendInvite(userId) {
    try {
      const inviteToken = crypto.randomBytes(32).toString('hex');
      const inviteTokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
      const inviteExpiresAt = new Date(Date.now() + this.config.invite.expirationHours * 60 * 60 * 1000);
      
      const query = `
        UPDATE users 
        SET inviteToken = ?, inviteTokenHash = ?, inviteExpiresAt = ?, updatedAt = NOW()
        WHERE userId = ?
      `;
      
      await this.korePool.execute(query, [
        inviteToken,
        inviteTokenHash,
        inviteExpiresAt,
        userId
      ]);
      
      await this.logAudit('invite_resent', 'user', userId, null, null, 
        { action: 'Invite resent' }, null);
      
      console.log(`[${new Date().toISOString()}] Invite resent for user: ${userId}`);
      
      return {
        inviteToken,
        inviteExpiresAt
      };
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR resending invite:`, err.message);
      throw err;
    }
  }

  /**
   * Complete account setup (password + MFA)
   */
  async completeSetup(inviteToken, password, totpSecret, mfaCode) {
    try {
      // Hash invite token to lookup user
      const inviteTokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
      
      // Find user by token
      const [userRows] = await this.korePool.execute(
        'SELECT userId, email, inviteExpiresAt FROM users WHERE inviteTokenHash = ?',
        [inviteTokenHash]
      );
      
      if (!userRows[0]) {
        throw new Error('Invalid or expired invite token');
      }
      
      const user = userRows[0];
      
      // Check expiration
      if (new Date() > new Date(user.inviteExpiresAt)) {
        throw new Error('Invite token has expired');
      }
      
      // Validate password
      const passwordValidation = this.validatePassword(password);
      if (!passwordValidation.valid) {
        throw new Error(`Password invalid: ${passwordValidation.errors.join(', ')}`);
      }
      
      // Verify TOTP code
      if (!this.verifyTOTPCode(totpSecret, mfaCode)) {
        throw new Error('Invalid MFA code');
      }
      
      // Hash password
      const { hash: passwordHash, salt: passwordSalt } = this.hashPassword(password);
      
      // Generate backup codes
      const { plainCodes, hashedCodes } = this.generateBackupCodes(this.config.mfa.backupCodeCount);
      
      // Encrypt TOTP secret and backup codes
      const encryptedSecret = this.crypto.encrypt(totpSecret);
      const encryptedBackupCodes = this.crypto.encrypt(JSON.stringify(hashedCodes));
      
      // Update user
      const query = `
        UPDATE users 
        SET status = 'active',
            passwordHash = ?,
            passwordSalt = ?,
            mfaEnabled = true,
            totpSecret = ?,
            totpBackupCodes = ?,
            passwordSetAt = NOW(),
            inviteToken = NULL,
            inviteTokenHash = 'USED',
            inviteExpiresAt = NULL,
            updatedAt = NOW()
        WHERE userId = ?
      `;
      
      await this.korePool.execute(query, [
        passwordHash,
        passwordSalt,
        encryptedSecret,
        encryptedBackupCodes,
        user.userId
      ]);
      
      await this.logAudit('setup_completed', 'user', user.userId, null, user.userId,
        { action: 'Account setup completed' }, null);
      
      console.log(`[${new Date().toISOString()}] Setup completed for user: ${user.email}`);
      
      return {
        success: true,
        userId: user.userId,
        backupCodes: plainCodes
      };
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR completing setup:`, err.message);
      throw err;
    }
  }

  // ========== AUTHENTICATION ==========

  /**
   * Login with email, password, and MFA code
   */
  async login(email, password, mfaCode) {
    try {
      // Find user by email
      const [userRows] = await this.korePool.execute(
        'SELECT userId, passwordHash, passwordSalt, status, lockedUntil, mfaEnabled, totpSecret, passwordFailedAttempts FROM users WHERE email = ?',
        [email]
      );

      if (!userRows[0]) {
        throw new Error('Invalid email or password');
      }

      const user = userRows[0];

      // Check if account is locked
      if (user.status === 'locked' || user.lockedUntil) {
        if (user.lockedUntil && new Date() > new Date(user.lockedUntil)) {
          // Auto-unlock
          await this.korePool.execute('UPDATE users SET status = ?, lockedUntil = NULL, passwordFailedAttempts = 0 WHERE userId = ?', 
            ['active', user.userId]);
        } else {
          throw new Error('Account is locked');
        }
      }

      // Check if account needs MFA setup
      if (user.status === 'mfa_reset') {
        throw new Error('MFA_RESET');
      }

      if (user.status !== 'active') {
        throw new Error(`Account is ${user.status}`);
      }

      // Verify password
      if (!this.verifyPassword(password, user.passwordHash, user.passwordSalt)) {
        // Increment failed attempts
        const newAttempts = (user.passwordFailedAttempts || 0) + 1;
        
        if (newAttempts >= this.config.password.failureLimit) {
          await this.korePool.execute(
            'UPDATE users SET status = ?, lockedUntil = DATE_ADD(NOW(), INTERVAL ? MINUTE), passwordFailedAttempts = ? WHERE userId = ?',
            ['locked', this.config.lockout.durationMinutes, newAttempts, user.userId]
          );
          throw new Error('Too many failed attempts. Account locked.');
        } else {
          await this.korePool.execute('UPDATE users SET passwordFailedAttempts = ?, passwordFailedLastAt = NOW() WHERE userId = ?',
            [newAttempts, user.userId]);
        }
        
        throw new Error('Invalid email or password');
      }

      // Verify MFA code if enabled
      if (user.mfaEnabled) {
        if (!mfaCode) {
          throw new Error('MFA code required');
        }

        // Decrypt TOTP secret
        const decryptedSecret = this.crypto.decrypt(user.totpSecret);
        
        if (!this.verifyTOTPCode(decryptedSecret, mfaCode)) {
          // Increment MFA failed attempts
          const mfaAttempts = (user.mfaFailedAttempts || 0) + 1;
          
          if (mfaAttempts >= this.config.mfa.failureLimit) {
            await this.korePool.execute(
              'UPDATE users SET status = ?, lockedUntil = DATE_ADD(NOW(), INTERVAL ? MINUTE), mfaFailedAttempts = ? WHERE userId = ?',
              ['locked', this.config.lockout.durationMinutes, mfaAttempts, user.userId]
            );
            throw new Error('Too many failed MFA attempts. Account locked.');
          } else {
            await this.korePool.execute('UPDATE users SET mfaFailedAttempts = ?, mfaFailedLastAt = NOW() WHERE userId = ?',
              [mfaAttempts, user.userId]);
          }
          
          throw new Error('Invalid MFA code');
        }
      }

      // Reset failed attempts on successful login
      await this.korePool.execute(
        'UPDATE users SET passwordFailedAttempts = 0, mfaFailedAttempts = 0, lastLoginAt = NOW() WHERE userId = ?',
        [user.userId]
      );

      // Generate tokens
      const sessionToken = this.generateSessionToken(user.userId);
      const reloginToken = this.generateReloginToken(user.userId);

      await this.logAudit('login', 'user', user.userId, null, user.userId, { action: 'User logged in' }, null);

      console.log(`[${new Date().toISOString()}] User logged in: ${email}`);

      return {
        userId: user.userId,
        sessionToken,
        reloginToken
      };
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR during login:`, err.message);
      throw err;
    }
  }

  /**
   * Generate JWT session token
   */
  generateSessionToken(userId) {
    const now = Date.now();
    const expiresAt = now + (this.config.session.sessionTokenExpiryMinutes * 60 * 1000);
    
    const payload = {
      userId,
      iat: Math.floor(now / 1000),
      exp: Math.floor(expiresAt / 1000)
    };

    // Simple JWT (no signature for now, can add signing later)
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64');
    
    return `${header}.${body}.`;
  }

  /**
   * Generate relogin token (long-lived)
   */
  generateReloginToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    // Store mapping in memory or DB later
    // For now, just return token
    return token;
  }

  /**
   * Validate session token
   */
  async validateSessionToken(token) {
    try {
      if (!token) {
        return { valid: false };
      }

      // Parse JWT (simple parsing, no verification for now)
      const parts = token.split('.');
      if (parts.length !== 3) {
        return { valid: false };
      }

      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const now = Math.floor(Date.now() / 1000);

      if (!payload.userId || payload.exp < now) {
        return { valid: false };
      }

      return {
        valid: true,
        userId: payload.userId,
        expiresAt: payload.exp * 1000
      };
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR validating session token:`, err.message);
      return { valid: false };
    }
  }

  /**
   * Refresh session with relogin token
   */
  async refreshSessionToken(reloginToken) {
    try {
      if (!reloginToken) {
        throw new Error('Relogin token required');
      }

      // TODO: Validate relogin token against stored tokens
      // For now, just generate new session token (implement DB storage later)
      
      // Extract userId from token metadata (simplified)
      // In production, store token->userId mapping in DB
      throw new Error('Token refresh not yet implemented - need token storage');
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR refreshing token:`, err.message);
      throw err;
    }
  }

  // ========== MFA MANAGEMENT ==========

  /**
   * Reset user's MFA (force re-setup on next login)
   */
  async resetMFA(userId, resetBy) {
    try {
      if (!userId || !resetBy) {
        throw new Error('userId and resetBy required');
      }

      const [userRows] = await this.korePool.execute(
        'SELECT userId, email, status FROM users WHERE userId = ?',
        [userId]
      );

      if (!userRows[0]) {
        throw new Error('User not found');
      }

      const user = userRows[0];

      // Update user: clear MFA, set status to mfa_reset
      await this.korePool.execute(
        'UPDATE users SET mfaEnabled = false, totpSecret = NULL, totpBackupCodes = NULL, status = ?, updatedAt = NOW() WHERE userId = ?',
        ['mfa_reset', userId]
      );

      await this.logAudit('mfa_reset', 'user', userId, user.email, resetBy, { action: 'Admin reset MFA' }, null);

      console.log(`[${new Date().toISOString()}] MFA reset for user ${user.email} by ${resetBy}`);

      return { success: true, userId, email: user.email };
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR resetting MFA:`, err.message);
      throw err;
    }
  }

  // ========== ACCOUNT LOCKOUT ==========

  /**
   * Unlock a locked user account
   */
  async unlockUser(userId, unlockedBy) {
    try {
      if (!userId || !unlockedBy) {
        throw new Error('userId and unlockedBy required');
      }

      const [userRows] = await this.korePool.execute(
        'SELECT userId, email, status FROM users WHERE userId = ?',
        [userId]
      );

      if (!userRows[0]) {
        throw new Error('User not found');
      }

      const user = userRows[0];

      // Unlock account
      await this.korePool.execute(
        'UPDATE users SET status = ?, lockedUntil = NULL, passwordFailedAttempts = 0, mfaFailedAttempts = 0, updatedAt = NOW() WHERE userId = ?',
        ['active', userId]
      );

      await this.logAudit('account_unlocked', 'user', userId, user.email, unlockedBy, { action: 'Admin unlocked account' }, null);

      console.log(`[${new Date().toISOString()}] Account unlocked for user ${user.email} by ${unlockedBy}`);

      return { success: true, userId, email: user.email };
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR unlocking user:`, err.message);
      throw err;
    }
  }

  /**
   * Check if account should be auto-unlocked
   */
  async checkAndAutoUnlock(userId) {
    try {
      const [userRows] = await this.korePool.execute(
        'SELECT userId, email, status, lockedUntil FROM users WHERE userId = ?',
        [userId]
      );

      if (!userRows[0]) {
        return { unlocked: false };
      }

      const user = userRows[0];

      if (user.status === 'locked' && user.lockedUntil) {
        if (new Date() > new Date(user.lockedUntil)) {
          // Auto-unlock
          await this.korePool.execute(
            'UPDATE users SET status = ?, lockedUntil = NULL, passwordFailedAttempts = 0, mfaFailedAttempts = 0, updatedAt = NOW() WHERE userId = ?',
            ['active', userId]
          );

          await this.logAudit('account_auto_unlocked', 'user', userId, user.email, 'system', { action: 'Auto-unlock due to timeout expiry' }, null);

          console.log(`[${new Date().toISOString()}] Account auto-unlocked for user ${user.email}`);

          return { unlocked: true, userId };
        }
      }

      return { unlocked: false };
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR checking auto-unlock:`, err.message);
      throw err;
    }
  }

  // ========== PERMISSIONS / AUTHORIZATION ==========

  /**
   * Get user's groups
   */
  async getUserGroups(userId) {
    try {
      const query = 'SELECT groupIds FROM users WHERE userId = ?';
      const [rows] = await this.korePool.execute(query, [userId]);
      
      if (!rows[0]) return [];
      
      const groupIds = rows[0].groupIds;
      return groupIds ? JSON.parse(groupIds) : [];
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR getting user groups:`, err.message);
      return [];
    }
  }

  /**
   * Get user's permissions (direct + via groups)
   */
  async getUserPermissions(userId) {
    try {
      const query = `
        SELECT DISTINCT resource, action 
        FROM permissions 
        WHERE (targetType = 'user' AND targetId = ?) 
           OR (targetType = 'group' AND targetId IN (
             SELECT JSON_UNQUOTE(JSON_EXTRACT(groupIds, CONCAT('$[', idx, ']')))
             FROM users, 
             (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4) AS indices
             WHERE users.userId = ?
             AND JSON_EXTRACT(groupIds, CONCAT('$[', idx, ']')) IS NOT NULL
           ))
        AND revokedAt IS NULL
      `;
      
      const [rows] = await this.korePool.execute(query, [userId, userId]);
      return rows.map(row => ({ resource: row.resource, action: row.action }));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR getting user permissions:`, err.message);
      return [];
    }
  }

  /**
   * Check if user has permission
   */
  async hasPermission(userId, resource, action) {
    try {
      const query = `
        SELECT COUNT(*) as count 
        FROM permissions 
        WHERE ((targetType = 'user' AND targetId = ?) 
           OR (targetType = 'group' AND targetId IN (
             SELECT JSON_UNQUOTE(JSON_EXTRACT(groupIds, CONCAT('$[', idx, ']')))
             FROM users, 
             (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4) AS indices
             WHERE users.userId = ?
             AND JSON_EXTRACT(groupIds, CONCAT('$[', idx, ']')) IS NOT NULL
           )))
        AND resource = ? 
        AND action = ? 
        AND revokedAt IS NULL
      `;
      
      const [rows] = await this.korePool.execute(query, [userId, userId, resource, action]);
      return rows[0].count > 0;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR checking permission:`, err.message);
      return false;
    }
  }

  // ========== SERVICE ACCOUNTS ==========

  /**
   * Create a service account
   */
  async createServiceAccount(userId, name, description, createdBy) {
    // Implement
  }

  /**
   * Validate service account API key/secret
   */
  async validateServiceAccount(apiKey, apiSecret) {
    // Implement
  }

  /**
   * Rotate service account key
   */
  async rotateServiceAccountKey(serviceAccountId, rotatedBy) {
    // Implement
  }

}

/**
 * POST /auth/generate-totp
 * Generate TOTP secret and QR code for setup form
 */
async function handleGenerateTOTP(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        // For now, generate generic TOTP without email
        const secret = global.auth.generateTOTPSecret('user@kore');
        const qrCode = await global.auth.generateQRCode(secret.secret, 'user@kore');
        
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            secret: secret.secret,
            qrCode: qrCode
        }));
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR generating TOTP:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * HTTP Handlers for Auth endpoints
 */

/**
 * GET /auth/login-form
 * Serve login form HTML
 */
function handleLoginForm(req, res) {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kore Login</title>
    <script src="/lib/base.css"></script>
    <style>
        :root {
            --brand-dark: #002b59;
            --brand-light: #0070b9;
            --brand-lighter: #4cb5ff;
            --bg-primary: #191A24;
            --bg-input: #152030;
            --bg-panel1: #1d3250;
            --bg-panel2: #192740;
            --bg-panel3: #172035;
            --text-primary: #ffffff;
            --text-muted: #82acd7;
            --text-header: #c6def3;
            --border-primary: #314a59;
            --border-bright: rgba(0, 112, 185, 0.9);
        }
    </style>
    <script>
        // Inject base.css component styles
        if (typeof componentStyles !== 'undefined') {
            const styleEl = document.createElement('style');
            styleEl.textContent = componentStyles;
            document.head.appendChild(styleEl);
        }
    </script>
    <style>
        :root {
            --brand-dark: #002b59;
            --brand-light: #0070b9;
            --brand-lighter: #4cb5ff;
            --bg-primary: #191A24;
            --bg-input: #152030;
            --bg-panel1: #1d3250;
            --text-primary: #ffffff;
            --text-muted: #82acd7;
            --border-primary: #314a59;
        }
        
        body {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
        }
        
        .login-container {
            width: 100%;
            max-width: 400px;
        }
        
        .logo-header {
            background-color: white;
            border-radius: 100px;
            border: 2px solid #0070b9;
            padding: 15px 0;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 8px 0 -65px 0;
            width: 100%;
            box-sizing: border-box;
            position: relative;
            z-index: 10;
        }
        
        .logo-header img {
            height: 100px;
            width: auto;
        }
        
        .login-panel {
            padding: 50px 30px 30px 30px;
            border: 2px solid #0070b9 !important;
            border-top-left-radius: 0;
            border-top-right-radius: 0;
        }
        
        .login-panel h1 {
            margin: 30px 0 15px 0;
            font-size: 24px;
            color: var(--text-primary);
            text-align: center;
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-size: 12px;
            color: var(--text-muted);
            font-weight: 500;
        }
        
        .form-group input {
            width: 100%;
            padding: 8px;
            background-color: var(--bg-input);
            border: 1px solid var(--border-primary);
            border-radius: 4px;
            color: var(--text-primary);
            font-size: 12px;
            box-sizing: border-box;
        }
        
        .form-group input:focus {
            outline: none;
            background-color: #132035;
            border-color: var(--brand-light);
        }
        
        .mfa-section {
            display: none;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid var(--border-primary);
        }
        
        .mfa-section.active {
            display: block;
        }
        
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        
        .btn {
            flex: 1;
            padding: 8px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            color: white;
            background-color: var(--brand-light);
            transition: opacity 0.2s ease;
        }
        
        .btn:hover {
            opacity: 0.9;
        }
        
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .btn-secondary {
            background-color: var(--border-primary);
        }
        
        .error {
            color: #dc3545;
            font-size: 12px;
            margin-top: 5px;
        }
        
        .success {
            color: #4caf50;
            font-size: 12px;
            margin-top: 5px;
        }
        
        .result-section {
            display: none;
            margin-top: 20px;
            padding: 15px;
            background-color: var(--bg-input);
            border: 1px solid var(--border-primary);
            border-radius: 4px;
            font-size: 11px;
            font-family: monospace;
            word-break: break-all;
        }
        
        .result-section.active {
            display: block;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="logo-header">
            <img src="/img/kore-logo.png" alt="Kore Logo">
        </div>
        
        <div class="panel-level-1 login-panel">
            <h1>Login</h1>
            
            <div id="loginStep">
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="email" placeholder="user@example.com" onkeypress="if(event.key==='Enter') handleLogin()">
                </div>
                
                <div class="form-group">
                    <label>Password</label>
                    <input type="password" id="password" onkeypress="if(event.key==='Enter') handleLogin()">
                </div>
                
                <div id="loginError" class="error"></div>
                
                <div class="button-group">
                    <button class="btn" onclick="handleLogin()">Sign In</button>
                </div>
            </div>
            
            <div id="mfaStep" class="mfa-section">
                <div class="form-group">
                    <label>MFA Code (6 digits)</label>
                    <input type="text" id="mfaCode" placeholder="000000" maxlength="6" pattern="[0-9]{6}" onkeypress="if(event.key==='Enter') handleMFA()">
                </div>
                
                <div id="mfaError" class="error"></div>
                
                <div class="button-group">
                    <button class="btn" onclick="handleMFA()">Verify MFA</button>
                    <button class="btn btn-secondary" onclick="resetLogin()">Back</button>
                </div>
            </div>
            
            <div id="resultStep" class="result-section">
                <div style="margin-bottom: 10px; color: #4caf50;">? Login successful!</div>
                <div style="margin-bottom: 10px;">
                    <strong>User ID:</strong><br>
                    <span id="resultUserId"></span>
                </div>
                <div style="margin-bottom: 10px;">
                    <strong>Session Token:</strong><br>
                    <span id="resultSessionToken"></span>
                </div>
                <div>
                    <strong>Relogin Token:</strong><br>
                    <span id="resultReloginToken"></span>
                </div>
                <div class="button-group" style="margin-top: 15px;">
                    <button class="btn btn-secondary" onclick="resetLogin()">New Login</button>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let currentEmail = '';
        let currentPassword = '';
        
        async function handleLogin() {
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const errorDiv = document.getElementById('loginError');
            
            errorDiv.textContent = '';
            
            if (!email || !password) {
                errorDiv.textContent = 'Email and password required';
                return;
            }
            
            try {
                const response = await fetch('/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    // If MFA setup is required (account was reset)
                    if (data.error === 'MFA_RESET') {
                        errorDiv.textContent = 'MFA setup required. Redirecting...';
                        setTimeout(() => {
                            window.location.href = '/usersetup?email=' + encodeURIComponent(email);
                        }, 1500);
                        return;
                    }
                    
                    // If MFA is required, show MFA prompt
                    if (data.error === 'MFA code required') {
                        currentEmail = email;
                        currentPassword = password;
                        
                        document.getElementById('loginStep').style.display = 'none';
                        document.getElementById('mfaStep').classList.add('active');
                        document.getElementById('mfaCode').focus();
                        return;
                    }
                    
                    errorDiv.textContent = data.error || 'Login failed';
                    return;
                }
                
                currentEmail = email;
                currentPassword = password;
                
                document.getElementById('loginStep').style.display = 'none';
                document.getElementById('mfaStep').classList.add('active');
                document.getElementById('mfaCode').focus();
                
            } catch (err) {
                errorDiv.textContent = 'Network error: ' + err.message;
            }
        }
        
        async function handleMFA() {
            const mfaCode = document.getElementById('mfaCode').value;
            const errorDiv = document.getElementById('mfaError');
            
            errorDiv.textContent = '';
            
            if (!mfaCode || mfaCode.length !== 6) {
                errorDiv.textContent = 'MFA code must be 6 digits';
                return;
            }
            
            try {
                const response = await fetch('/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email: currentEmail,
                        password: currentPassword,
                        mfaCode: mfaCode
                    })
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    errorDiv.textContent = data.error || 'MFA verification failed';
                    return;
                }
                
                // Show success
                document.getElementById('mfaStep').classList.remove('active');
                document.getElementById('resultStep').classList.add('active');
                document.getElementById('resultUserId').textContent = data.userId;
                document.getElementById('resultSessionToken').textContent = data.sessionToken;
                document.getElementById('resultReloginToken').textContent = data.reloginToken;
                
            } catch (err) {
                errorDiv.textContent = 'Network error: ' + err.message;
            }
        }
        
        function resetLogin() {
            document.getElementById('email').value = '';
            document.getElementById('password').value = '';
            document.getElementById('mfaCode').value = '';
            document.getElementById('loginError').textContent = '';
            document.getElementById('mfaError').textContent = '';
            
            document.getElementById('loginStep').style.display = 'block';
            document.getElementById('mfaStep').classList.remove('active');
            document.getElementById('resultStep').classList.remove('active');
            
            document.getElementById('email').focus();
        }
    </script>
</body>
</html>`);
}

/**
 * POST /auth/validate-token
 * Validate session token
 */
async function handleValidateSessionToken(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { sessionToken } = JSON.parse(body);
                
                if (!sessionToken) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Session token required' }));
                    return;
                }
                
                const result = await global.auth.validateSessionToken(sessionToken);
                
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error(`[${new Date().toISOString()}] ERROR validating token:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR in handleValidateSessionToken:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * POST /admin/users/:userId/reset-mfa
 * Admin resets user's MFA
 */
async function handleAdminResetMFA(req, res, userId) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { resetBy } = JSON.parse(body || '{}');
                
                if (!resetBy) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'resetBy (admin userId) required' }));
                    return;
                }
                
                const result = await global.auth.resetMFA(userId, resetBy);
                
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error(`[${new Date().toISOString()}] ERROR in resetMFA:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR in handleAdminResetMFA:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * POST /admin/users/:userId/unlock
 * Admin unlocks user account
 */
async function handleAdminUnlockUser(req, res, userId) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { unlockedBy } = JSON.parse(body || '{}');
                
                if (!unlockedBy) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'unlockedBy (admin userId) required' }));
                    return;
                }
                
                const result = await global.auth.unlockUser(userId, unlockedBy);
                
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error(`[${new Date().toISOString()}] ERROR in unlockUser:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR in handleAdminUnlockUser:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * POST /auth/login
 * Login with email, password, and MFA code
 */
async function handleLogin(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { email, password, mfaCode } = JSON.parse(body);
                
                if (!email || !password) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Email and password required' }));
                    return;
                }
                
                const result = await global.auth.login(email, password, mfaCode);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    userId: result.userId,
                    sessionToken: result.sessionToken,
                    reloginToken: result.reloginToken
                }));
            } catch (err) {
                console.error(`[${new Date().toISOString()}] ERROR in login:`, err.message);
                res.writeHead(401);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR in handleLogin:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * POST /users
 * Admin creates a new user and sends invite
 */
async function handleCreateUser(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { email, fullName } = JSON.parse(body);
                
                if (!email || !fullName) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Email and fullName required' }));
                    return;
                }
                
                const result = await global.auth.createUser(email, fullName, '00000000-0000-0000-0000-000000000001');
                
                // Send invite email
                const setupLink = `https://app.equinoxits.com:1139/usersetup?token=${result.inviteToken}`;
                const emailHTML = `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        table { border-collapse: collapse; width: 100%; max-width: 500px; }
    </style>
</head>
<body>
    <table style="background-color: #1d3250; color: #FFFFFF; border: 1px solid #314a59;">
        <tr>
            <td style="background-color: #0c2134; border-bottom: 1px solid #314a59; padding: 15px; text-align: center;">
                <h1 style="font-size: 25px; margin: 0; color: #FFFFFF;">Welcome to Kore!</h1>
            </td>
        </tr>
        <tr>
            <td style="padding: 15px;">
                <p style="margin: 0 0 15px 0; line-height: 1.5; color: #FFFFFF;">Hello <strong>${fullName}</strong>,</p>
                <p style="margin: 0 0 15px 0; line-height: 1.5; color: #FFFFFF;">Your account has been created. Click below to complete your setup:</p>
                <p style="text-align: center; margin: 15px 0;">
                    <a href="${setupLink}" style="display: inline-block; background-color: #0070b9; color: white; padding: 10px 20px; text-decoration: none; font-weight: bold;">Complete Setup</a>
                </p>
                <p style="margin: 0 0 10px 0; line-height: 1.5; color: #FFFFFF;">Or copy this link:</p>
                <p style="background-color: #192740; border: 1px solid #314a59; padding: 12px; word-break: break-all; font-size: 12px; color: #FFFFFF; font-family: monospace; margin: 0 0 15px 0;">${setupLink}</p>
                <p style="font-size: 12px; color: #999999; margin: 0; text-align: center;">This link expires in 24 hours.</p>
            </td>
        </tr>
    </table>
</body>
</html>`;

                // Send email asynchronously (don't block response)
                (async () => {
                  try {
                    const https = require('https');
                    const payload = JSON.stringify({
                      profile: 'default',
                      to: email,
                      subject: 'Welcome to Kore - Complete Your Account Setup',
                      html: emailHTML
                    });

                    const options = {
                      hostname: 'localhost',
                      port: 1139,
                      path: '/kore/email/smtp',
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        'Authorization': 'Bearer ' + result.inviteToken
                      },
                      rejectUnauthorized: false
                    };

                    const emailReq = https.request(options, (emailRes) => {
                      let data = '';
                      emailRes.on('data', chunk => data += chunk);
                      emailRes.on('end', () => {
                        if (emailRes.statusCode === 200 || emailRes.statusCode === 201) {
                          console.log(`[${new Date().toISOString()}] Invite email sent to ${email}`);
                        } else {
                          console.error(`[${new Date().toISOString()}] Email send returned status ${emailRes.statusCode}`);
                        }
                      });
                    });

                    emailReq.on('error', (err) => {
                      console.error(`[${new Date().toISOString()}] Error sending invite email:`, err.message);
                    });

                    emailReq.write(payload);
                    emailReq.end();
                  } catch (err) {
                    console.error(`[${new Date().toISOString()}] Error in email task:`, err.message);
                  }
                })();
                
                res.writeHead(201);
                res.end(JSON.stringify({
                    success: true,
                    userId: result.userId,
                    inviteToken: result.inviteToken,
                    inviteExpiresAt: result.inviteExpiresAt
                }));
            } catch (err) {
                console.error(`[${new Date().toISOString()}] ERROR creating user:`, err.message);
                
                let statusCode = 400;
                let errorMessage = err.message;
                
                if (err.code === 'ER_DUP_ENTRY') {
                    statusCode = 409;
                    errorMessage = 'Email already exists';
                }
                
                res.writeHead(statusCode);
                res.end(JSON.stringify({ error: errorMessage }));
            }
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR in handleCreateUser:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * POST /users/:id/resend-invite
 * Admin resends invite to user
 */
async function handleResendInvite(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        const urlParts = req.url.split('/');
        const userId = urlParts[2];
        
        const result = await global.auth.resendInvite(userId);
        
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            inviteToken: result.inviteToken,
            inviteExpiresAt: result.inviteExpiresAt
        }));
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR resending invite:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * GET /usersetup?token=xxx
 * Render account setup form
 */
async function handleUserSetupForm(req, res) {
    res.setHeader('Content-Type', 'text/html');
    
    try {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const token = urlParams.get('token');
        const email = urlParams.get('email');
        
        if (!token && !email) {
            res.writeHead(400);
            res.end('<h1>Invalid request: token or email required</h1>');
            return;
        }
        
        res.writeHead(200);
        res.end(getSetupFormHTML(token || '', email || ''));
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR rendering setup form:`, err.message);
        res.writeHead(500);
        res.end(`<h1>Error: ${err.message}</h1>`);
    }
}

/**
 * POST /auth/mfa-reset-complete
 * Complete MFA reset for user
 */
async function handleMFAResetComplete(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { email, totpSecret, mfaCode } = JSON.parse(body);
                
                if (!email || !totpSecret || !mfaCode) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Email, totpSecret, and mfaCode required' }));
                    return;
                }
                
                // Find user by email in mfa_reset state
                const [userRows] = await global.auth.korePool.execute(
                    'SELECT userId FROM users WHERE email = ? AND status = ?',
                    [email, 'mfa_reset']
                );
                
                if (!userRows[0]) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'User not found or not in MFA reset state' }));
                    return;
                }
                
                const userId = userRows[0].userId;
                
                // Verify MFA code
                if (!global.auth.verifyTOTPCode(totpSecret, mfaCode)) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid MFA code' }));
                    return;
                }
                
                // Generate backup codes
                const { plainCodes, hashedCodes } = global.auth.generateBackupCodes();
                
                // Encrypt and save
                const encryptedSecret = global.auth.crypto.encrypt(totpSecret);
                const encryptedBackupCodes = global.auth.crypto.encrypt(JSON.stringify(hashedCodes));
                
                // Update user
                await global.auth.korePool.execute(
                    'UPDATE users SET status = ?, mfaEnabled = true, totpSecret = ?, totpBackupCodes = ?, updatedAt = NOW() WHERE userId = ?',
                    ['active', encryptedSecret, encryptedBackupCodes, userId]
                );
                
                await global.auth.logAudit('mfa_reset_completed', 'user', userId, email, userId, { action: 'User completed MFA reset' }, null);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    userId: userId,
                    backupCodes: plainCodes
                }));
            } catch (err) {
                console.error(`[${new Date().toISOString()}] ERROR in MFA reset:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR in handleMFAResetComplete:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * POST /usersetup/complete
 * User completes account setup
 */
async function handleCompleteSetup(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { inviteToken, password, totpSecret, mfaCode } = JSON.parse(body);
                
                if (!inviteToken || !password || !totpSecret || !mfaCode) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'All fields required' }));
                    return;
                }
                
                const result = await global.auth.completeSetup(inviteToken, password, totpSecret, mfaCode);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    userId: result.userId,
                    backupCodes: result.backupCodes
                }));
            } catch (err) {
                console.error(`[${new Date().toISOString()}] ERROR completing setup:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR in handleCompleteSetup:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * Generate setup form HTML
 */
function getSetupFormHTML(token, email = '') {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kore Setup</title>
    <script src="/lib/base.css"></script>
    <style>
        :root {
            --brand-dark: #002b59;
            --brand-light: #0070b9;
            --brand-lighter: #4cb5ff;
            --bg-primary: #191A24;
            --bg-input: #152030;
            --bg-panel1: #1d3250;
            --text-primary: #ffffff;
            --text-muted: #82acd7;
            --border-primary: #314a59;
        }
        
        body {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
        }
        
        .setup-container {
            width: 100%;
            max-width: 400px;
        }
        
        .logo-header {
            background-color: white;
            border-radius: 100px;
            border: 2px solid #0070b9;
            padding: 15px 0;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 8px 0 -65px 0;
            width: 100%;
            box-sizing: border-box;
            position: relative;
            z-index: 10;
        }
        
        .logo-header img {
            height: 100px;
            width: auto;
        }
        
        .setup-panel {
            padding: 50px 30px 30px 30px;
            border: 2px solid #0070b9 !important;
            border-top-left-radius: 0;
            border-top-right-radius: 0;
        }
        
        .setup-panel h1 {
            margin: 30px 0 15px 0;
            font-size: 24px;
            color: var(--text-primary);
            text-align: center;
            display: none;
        }
        
        .setup-panel h2 {
            font-size: 14px;
            margin-top: 60px;
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-size: 12px;
            color: var(--text-muted);
            font-weight: 500;
        }
        
        .form-group input {
            width: 100%;
            padding: 8px;
            background-color: var(--bg-input);
            border: 1px solid var(--border-primary);
            border-radius: 4px;
            color: var(--text-primary);
            font-size: 12px;
            box-sizing: border-box;
        }
        
        .form-group input:focus {
            outline: none;
            background-color: #132035;
            border-color: var(--brand-light);
        }
        
        .step {
            display: none;
        }
        
        .step.active {
            display: block;
        }
        
        .error {
            color: #dc3545;
            font-size: 12px;
            margin-top: 5px;
        }
        
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        
        .btn {
            flex: 1;
            padding: 8px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            color: white;
            background-color: var(--brand-light);
            transition: opacity 0.2s ease;
        }
        
        .btn:hover {
            opacity: 0.9;
        }
        
        .btn-secondary {
            background-color: var(--border-primary);
        }
    </style>
    <script>
        // Inject base.css component styles
        if (typeof componentStyles !== 'undefined') {
            const styleEl = document.createElement('style');
            styleEl.textContent = componentStyles;
            document.head.appendChild(styleEl);
        }
    </script>
</head>
<body>
    <div class="setup-container">
        <div class="logo-header">
            <img src="/img/kore-logo.png" alt="Kore Logo">
        </div>
        
        <div class="panel-level-1 setup-panel">
            <h1>Setup</h1>
            
            <div id="step1" class="step active">
                <h2>Step 1: Set Password</h2>
                <div class="form-group">
                    <label>Password</label>
                    <input type="password" id="password" onkeypress="if(event.key==='Enter') nextStep()">
                </div>
                <div class="form-group">
                    <label>Confirm Password</label>
                    <input type="password" id="passwordConfirm" onkeypress="if(event.key==='Enter') nextStep()">
                </div>
                <div id="passwordError" class="error"></div>
                <div class="button-group">
                    <button class="btn" onclick="nextStep()">Next: MFA Setup</button>
                </div>
            </div>
            
            <div id="step2" class="step">
                <h2>Step 2: Setup MFA</h2>
                <label style="display: block; margin-bottom: 10px; font-size: 12px; color: var(--text-muted); font-weight: 500;">Secret Key</label>
                <div class="panel-level-3" id="secretCode" style="word-break: break-all; padding: 12px; font-family: monospace; font-size: 12px; background-color: #172035; border: 1px solid #314a59; border-radius: 6px; margin-bottom: 15px;"></div>
                <div class="form-group">
                    <label>6-digit code from authenticator</label>
                    <input type="text" id="mfaCode" maxlength="6" pattern="[0-9]{6}" onkeypress="if(event.key==='Enter') completeSetup()">
                </div>
                <div id="mfaError" class="error"></div>
                <div class="button-group">
                    <button class="btn" onclick="completeSetup()">Complete</button>
                    <button class="btn btn-secondary" onclick="previousStep()">Back</button>
                </div>
            </div>
            
            <div id="step3" class="step">
                <h2>Setup Complete!</h2>
                <p><strong>Save these backup codes:</strong></p>
                <div class="panel-level-3" id="backupCodes" style="padding: 12px; font-family: monospace; font-size: 11px; background-color: #172035; border: 1px solid #314a59; border-radius: 6px; white-space: pre-wrap;"></div>
            </div>
        </div>
    </div>
    
    <script>
        const token = '${token}';
        const email = '${email}';
        const isMFAReset = email && !token;
        let totpSecret = null;
        
        // Initialize UI based on mode
        window.addEventListener('DOMContentLoaded', () => {
            if (isMFAReset) {
                document.getElementById('step1').style.display = 'none';
                document.getElementById('step2').classList.add('active');
                const heading = document.querySelector('#step2 h2');
                if (heading) {
                    heading.textContent = 'Re-setup Multi-Factor Authentication for ' + email;
                }
                generateMFASecret();
            }
        });
        
        async function nextStep() {
            if (isMFAReset) {
                await generateMFASecret();
                showStep(2);
                return;
            }
            
            const pwd = document.getElementById('password').value;
            const pwdConfirm = document.getElementById('passwordConfirm').value;
            
            if (!pwd || !pwdConfirm) {
                document.getElementById('passwordError').textContent = 'Both passwords required';
                return;
            }
            
            if (pwd !== pwdConfirm) {
                document.getElementById('passwordError').textContent = 'Passwords do not match';
                return;
            }
            
            await generateMFASecret();
            showStep(2);
        }
        
        async function generateMFASecret() {
            const response = await fetch('/auth/generate-totp', { method: 'POST' });
            const data = await response.json();
            totpSecret = data.secret;
            document.getElementById('secretCode').textContent = totpSecret;
        }
        
        function previousStep() {
            showStep(1);
        }
        
        async function completeSetup() {
            const pwd = document.getElementById('password').value;
            const mfaCode = document.getElementById('mfaCode').value;
            
            if (!mfaCode || mfaCode.length !== 6) {
                document.getElementById('mfaError').textContent = 'Enter 6-digit code';
                return;
            }
            
            try {
                let endpoint = '/usersetup/complete';
                let payload = { inviteToken: token, password: pwd, totpSecret: totpSecret, mfaCode: mfaCode };
                
                if (isMFAReset) {
                    endpoint = '/auth/mfa-reset-complete';
                    payload = { email: email, totpSecret: totpSecret, mfaCode: mfaCode };
                }
                
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (!response.ok) throw new Error('Setup failed');
                
                const data = await response.json();
                document.getElementById('backupCodes').textContent = data.backupCodes.join('\\n');
                showStep(3);
            } catch (err) {
                document.getElementById('mfaError').textContent = 'Error: ' + err.message;
            }
        }
        
        function showStep(n) {
            ['step1', 'step2', 'step3'].forEach(id => {
                document.getElementById(id).classList.remove('active');
            });
            document.getElementById('step' + n).classList.add('active');
        }
    </script>
</body>
</html>`;
}

/**
 * Route auth requests
 * Returns true if handled, false if not an auth route
 */
function routeAuthRequest(req, res) {
    if (req.method === 'GET' && req.url === '/login') {
        handleLoginForm(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/auth/login') {
        handleLogin(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/auth/validate-token') {
        handleValidateSessionToken(req, res);
        return true;
    } else if (req.method === 'POST' && req.url.match(/^\/admin\/users\/[a-f0-9-]+\/reset-mfa$/)) {
        const userId = req.url.split('/')[3];
        handleAdminResetMFA(req, res, userId);
        return true;
    } else if (req.method === 'POST' && req.url.match(/^\/admin\/users\/[a-f0-9-]+\/unlock$/)) {
        const userId = req.url.split('/')[3];
        handleAdminUnlockUser(req, res, userId);
        return true;
    } else if (req.method === 'POST' && req.url === '/users') {
        handleCreateUser(req, res);
        return true;
    } else if (req.method === 'POST' && req.url.match(/^\/users\/[a-f0-9-]+\/resend-invite$/)) {
        handleResendInvite(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/auth/generate-totp') {
        handleGenerateTOTP(req, res);
        return true;
    } else if (req.method === 'GET' && req.url.startsWith('/usersetup?')) {
        handleUserSetupForm(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/auth/mfa-reset-complete') {
        handleMFAResetComplete(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/usersetup/complete') {
        handleCompleteSetup(req, res);
        return true;
    }
    
    return false;
}

module.exports = Auth;
module.exports.routeAuthRequest = routeAuthRequest;