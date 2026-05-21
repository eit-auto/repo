/**
 * Kore Authentication System
 * 
 * Handles user registration, login, MFA, session tokens, and permissions
 */

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');

class Auth {
  constructor(korePool, cryptoUtils, securityConfig, logAuditFn, jwtSigningKey) {
    this.korePool = korePool;
    this.crypto = cryptoUtils;
    this.config = securityConfig;
    this.logAudit = logAuditFn;
    this.jwtSigningKey = jwtSigningKey;
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
        (userId, email, fullName, status, inviteTokenHash, inviteExpiresAt, createdAt, createdBy)
        VALUES (?, ?, ?, 'invited', ?, ?, NOW(), ?)
      `;
      
      await this.korePool.execute(query, [
        userId,
        email,
        fullName,
        inviteTokenHash,
        inviteExpiresAt,
        createdBy
      ]);
      
      await this.logAudit('user_created', 'user', userId, fullName, createdBy, 
        { email: email }, null);
      
      console.log(`[${global.getTimestamp()}] User created: ${email} (${userId})`);
      
      return {
        userId,
        inviteToken,
        inviteExpiresAt
      };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR creating user:`, err.message);
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
        SET inviteTokenHash = ?, inviteExpiresAt = ?, updatedAt = NOW()
        WHERE userId = ?
      `;
      
      await this.korePool.execute(query, [
        inviteTokenHash,
        inviteExpiresAt,
        userId
      ]);
      
      await this.logAudit('invite_resent', 'user', userId, null, null, 
        { action: 'Invite resent' }, null);
      
      console.log(`[${global.getTimestamp()}] Invite resent for user: ${userId}`);
      
      return {
        inviteToken,
        inviteExpiresAt
      };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR resending invite:`, err.message);
      throw err;
    }
  }

  /**
   * Update user details (email, fullName, active, groupIds)
   */
  async updateUser(userId, email, fullName, active, groupIds, updatedBy) {
    try {
      const groupIdsJson = Array.isArray(groupIds) ? JSON.stringify(groupIds) : '[]';
      
      const query = `
        UPDATE users 
        SET email = ?, fullName = ?, active = ?, groupIds = ?, updatedAt = NOW(), updatedBy = ?
        WHERE userId = ?
      `;
      
      await this.korePool.execute(query, [
        email,
        fullName || null,
        active ? 1 : 0,
        groupIdsJson,
        updatedBy || null,
        userId
      ]);
      
      await this.logAudit('user_updated', 'user', userId, null, null, 
        { email, fullName, active, groupIds }, null);
      
      console.log(`[${global.getTimestamp()}] User updated: ${userId}`);
      
      return { success: true };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR updating user:`, err.message);
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
      
      // Initialize passwordHistory with the initial password
      const tz = global.timezone || 'UTC';
      const initialSetAt = new Date().toLocaleString('en-US', { timeZone: tz });
      const initialPasswordHistory = JSON.stringify([{
        hash: passwordHash,
        salt: passwordSalt,
        setAt: initialSetAt
      }]);
      
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
            passwordHistory = ?,
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
        initialPasswordHistory,
        user.userId
      ]);
      
      await this.logAudit('setup_completed', 'user', user.userId, null, user.userId,
        { action: 'Account setup completed' }, null);
      
      console.log(`[${global.getTimestamp()}] Setup completed for user: ${user.email}`);
      
      return {
        success: true,
        userId: user.userId,
        backupCodes: plainCodes
      };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR completing setup:`, err.message);
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
      const { token: refreshToken, hash: refreshTokenHash } = this.generateRefreshToken(user.userId);

      // Store refreshTokenHash in database
      await this.korePool.execute(
        'UPDATE users SET refreshTokenHash = ? WHERE userId = ?',
        [refreshTokenHash, user.userId]
      );

      await this.logAudit('login', 'user', user.userId, null, user.userId, { action: 'User logged in' }, null);

      console.log(`[${global.getTimestamp()}] User logged in: ${email}`);

      return {
        userId: user.userId,
        sessionToken,
        refreshToken
      };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR during login:`, err.message);
      throw err;
    }
  }

  /**
   * Generate JWT session token with HMAC signature
   */
  generateSessionToken(userId) {
    const now = Date.now();
    const expiresAt = now + (this.config.session.sessionTokenExpiryMinutes * 60 * 1000);
    
    const payload = {
      userId,
      iat: Math.floor(now / 1000),
      exp: Math.floor(expiresAt / 1000)
    };

    // Create signed JWT
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64');
    
    // Sign the JWT with HMAC-SHA256
    const signature = crypto
      .createHmac('sha256', this.jwtSigningKey)
      .update(`${header}.${body}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    return `${header}.${body}.${signature}`;
  }

  /**
   * Generate refresh token (long-lived, stored as hash)
   */
  generateRefreshToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    
    return {
      token: token,        // Send to client
      hash: hash          // Store in DB
    };
  }

  /**
   * Validate session token with signature verification
   */
  async validateSessionToken(token) {
    try {
      if (!token) {
        return { valid: false };
      }

      // Parse JWT
      const parts = token.split('.');
      if (parts.length !== 3) {
        return { valid: false };
      }

      // Verify signature
      const header = parts[0];
      const body = parts[1];
      const providedSignature = parts[2];
      
      const expectedSignature = crypto
        .createHmac('sha256', this.jwtSigningKey)
        .update(`${header}.${body}`)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      
      if (providedSignature !== expectedSignature) {
        return { valid: false };
      }

      // Parse and validate payload
      const payload = JSON.parse(Buffer.from(body, 'base64').toString());
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
      console.error(`[${global.getTimestamp()}] ERROR validating session token:`, err.message);
      return { valid: false };
    }
  }

  /**
   * Refresh session token
   * Validates expired sessionToken and issues new one if within relogin threshold
   */
  async refreshSessionToken(sessionToken) {
    try {
      if (!sessionToken) {
        throw new Error('Session token required');
      }

      // Parse sessionToken JWT
      const parts = sessionToken.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid token format');
      }

      // Verify signature
      const header = parts[0];
      const body = parts[1];
      const providedSignature = parts[2];
      
      const expectedSignature = crypto
        .createHmac('sha256', this.jwtSigningKey)
        .update(`${header}.${body}`)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      
      if (providedSignature !== expectedSignature) {
        throw new Error('Invalid token signature');
      }

      const payload = JSON.parse(Buffer.from(body, 'base64').toString());

      if (!payload.userId) {
        throw new Error('Invalid token payload');
      }

      const userId = payload.userId;

      // Query user's lastFullLogin from database
      const query = 'SELECT userId, email, status, active, lastLoginAt FROM users WHERE userId = ?';
      const [rows] = await this.korePool.execute(query, [userId]);

      if (!rows || rows.length === 0) {
        throw new Error('User not found');
      }

      const user = rows[0];

      // Check if user is still active
      if (!user.active || user.status === 'inactive') {
        throw new Error('User account is inactive');
      }

      // Check if last full login is within the relogin threshold
      const lastLogin = new Date(user.lastLoginAt);
      const now_ms = Date.now();
      const daysSinceLogin = (now_ms - lastLogin.getTime()) / (1000 * 60 * 60 * 24);
      const reloginThresholdDays = this.config.session.reloginTokenExpiryDays;

      if (daysSinceLogin > reloginThresholdDays) {
        throw new Error('Relogin threshold exceeded. Please log in again.');
      }

      // Generate new session token
      const newSessionToken = this.generateSessionToken(userId);

      console.log(`[${global.getTimestamp()}] Session refreshed for user: ${userId}`);

      return {
        sessionToken: newSessionToken
      };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR refreshing session:`, err.message);
      throw err;
    }
  }

  /**
   * Refresh session token using refresh token
   * Validates refresh token and issues new session token if within relogin threshold
   */
  async refreshSessionTokenWithRefreshToken(refreshToken) {
    try {
      if (!refreshToken) {
        throw new Error('Refresh token required');
      }

      // Hash the refresh token
      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

      // Find user by refresh token hash
      const query = 'SELECT userId, active, status, lastLoginAt FROM users WHERE refreshTokenHash = ?';
      const [rows] = await this.korePool.execute(query, [refreshTokenHash]);

      if (!rows || rows.length === 0) {
        throw new Error('Invalid refresh token');
      }

      const user = rows[0];

      // Check if user is still active
      if (!user.active || user.status === 'inactive') {
        throw new Error('User account is inactive');
      }

      // Check if last full login is within the relogin threshold
      const lastLogin = new Date(user.lastLoginAt);
      const now_ms = Date.now();
      const daysSinceLogin = (now_ms - lastLogin.getTime()) / (1000 * 60 * 60 * 24);
      const reloginThresholdDays = this.config.session.reloginTokenExpiryDays;

      if (daysSinceLogin > reloginThresholdDays) {
        throw new Error('Relogin threshold exceeded. Please log in again.');
      }

      // Generate new session token
      const newSessionToken = this.generateSessionToken(user.userId);

      console.log(`[${global.getTimestamp()}] Session refreshed with refresh token for user: ${user.userId}`);

      return {
        sessionToken: newSessionToken
      };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR refreshing with refresh token:`, err.message);
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

      console.log(`[${global.getTimestamp()}] MFA reset for user ${user.email} by ${resetBy}`);

      return { success: true, userId, email: user.email };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR resetting MFA:`, err.message);
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

      console.log(`[${global.getTimestamp()}] Account unlocked for user ${user.email} by ${unlockedBy}`);

      return { success: true, userId, email: user.email };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR unlocking user:`, err.message);
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

          console.log(`[${global.getTimestamp()}] Account auto-unlocked for user ${user.email}`);

          return { unlocked: true, userId };
        }
      }

      return { unlocked: false };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR checking auto-unlock:`, err.message);
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
      console.error(`[${global.getTimestamp()}] ERROR getting user groups:`, err.message);
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
      console.error(`[${global.getTimestamp()}] ERROR getting user permissions:`, err.message);
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
      console.error(`[${global.getTimestamp()}] ERROR checking permission:`, err.message);
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
   * Change user password (authenticated user only)
   * Validates old password, checks new password against history
   */
  async changePassword(userId, oldPassword, newPassword) {
    try {
      // Fetch user
      const [userRows] = await this.korePool.execute(
        'SELECT userId, email, passwordHash, passwordSalt, passwordSetAt, passwordHistory FROM users WHERE userId = ?',
        [userId]
      );
      
      if (!userRows[0]) {
        throw new Error('User not found');
      }
      
      const user = userRows[0];
      
      // Verify old password
      if (!this.verifyPassword(oldPassword, user.passwordHash, user.passwordSalt)) {
        throw new Error('Current password is incorrect');
      }
      
      // Validate new password format
      const passwordValidation = this.validatePassword(newPassword);
      if (!passwordValidation.valid) {
        throw new Error(`Password invalid: ${passwordValidation.errors.join(', ')}`);
      }
      
      // Parse existing password history
      let passwordHistory = [];
      if (user.passwordHistory) {
        try {
          // MySQL driver may return it as already-parsed object
          if (typeof user.passwordHistory === 'string') {
            passwordHistory = JSON.parse(user.passwordHistory);
          } else {
            passwordHistory = user.passwordHistory;
          }
          console.log(`[${global.getTimestamp()}] Parsed passwordHistory:`, passwordHistory);
        } catch (e) {
          console.log(`[${global.getTimestamp()}] ERROR parsing passwordHistory:`, e.message);
          passwordHistory = [];
        }
      } else {
        console.log(`[${global.getTimestamp()}] No passwordHistory in user record`);
      }
      
      // Ensure passwordHistory is a valid array
      if (!Array.isArray(passwordHistory)) {
        console.log(`[${global.getTimestamp()}] passwordHistory is not an array, resetting to []`);
        passwordHistory = [];
      }
      
      // Validate against password history
      const historyCheck = this.validatePasswordHistory(newPassword, passwordHistory);
      if (!historyCheck.valid) {
        throw new Error(historyCheck.reason);
      }
      
      // Hash with salt
      const { hash: finalPasswordHash, salt: passwordSalt } = this.hashPassword(newPassword);
      
      // Add old password to history and cleanup
      const tz = global.timezone || 'UTC';
      
      // Convert passwordSetAt to the same format as new entries
      let setAtValue = user.passwordSetAt;
      if (user.passwordSetAt && typeof user.passwordSetAt === 'object') {
        // It's a Date object from MySQL
        setAtValue = new Date(user.passwordSetAt).toLocaleString('en-US', { timeZone: tz });
      } else if (user.passwordSetAt && typeof user.passwordSetAt === 'string') {
        // It's a string from MySQL, convert to Date then format
        setAtValue = new Date(user.passwordSetAt).toLocaleString('en-US', { timeZone: tz });
      } else {
        // Fallback to current time
        setAtValue = new Date().toLocaleString('en-US', { timeZone: tz });
      }
      
      passwordHistory.unshift({
        hash: user.passwordHash,
        salt: user.passwordSalt,
        setAt: setAtValue
      });
      console.log(`[${global.getTimestamp()}] passwordHistory after unshift:`, passwordHistory);
      
      // Cleanup: Keep passwords that satisfy EITHER constraint
      const historyCount = this.config.password?.historyCount || 10;
      const oldPwdAge = this.config.password?.oldPwdAge || 90;
      
      passwordHistory = passwordHistory.filter((entry, index) => {
        // Keep if in last historyCount entries
        if (index < historyCount) {
          return true;
        }
        
        // Keep if beyond last historyCount but less than oldPwdAge days old
        try {
          const ageMs = Date.now() - new Date(entry.setAt).getTime();
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          if (ageDays < oldPwdAge) {
            return true;
          }
        } catch (e) {
          // If we can't parse the date, keep it to be safe
          return true;
        }
        
        // Drop if beyond historyCount AND oldPwdAge+ days old
        return false;
      });
      
      // Update user
      const query = `
        UPDATE users 
        SET passwordHash = ?,
            passwordSalt = ?,
            passwordSetAt = NOW(),
            passwordHistory = ?,
            passwordFailedAttempts = 0,
            updatedAt = NOW()
        WHERE userId = ?
      `;
      
      await this.korePool.execute(query, [
        finalPasswordHash,
        passwordSalt,
        JSON.stringify(passwordHistory),
        userId
      ]);
      
      await this.logAudit('password_changed', 'user', userId, null, userId,
        { action: 'User changed their password' }, null);
      
      console.log(`[${global.getTimestamp()}] Password changed for user: ${user.email}`);
      
      return { success: true };
    } catch (err) {
      console.error(`[${global.getTimestamp()}] ERROR changing password:`, err.message);
      throw err;
    }
  }

  /**
   * Validate new password against history
   * Verifies the password against each entry using stored salt
   */
  validatePasswordHistory(newPassword, passwordHistory) {
    if (!passwordHistory || passwordHistory.length === 0) {
      return { valid: true };
    }
    
    for (const entry of passwordHistory) {
      // Verify new password against this history entry
      if (this.verifyPassword(newPassword, entry.hash, entry.salt)) {
        return { 
          valid: false, 
          reason: 'Cannot reuse a recent password' 
        };
      }
    }
    
    return { valid: true };
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
        console.error(`[${global.getTimestamp()}] ERROR generating TOTP:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * HTTP Handlers for Auth endpoints
 */

/**
 * POST /auth/logout
 * Clear session and logout
 */
function handleLogout(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    // Clear both sessionToken and refreshToken cookies
    res.setHeader('Set-Cookie', [
        'sessionToken=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
        'refreshToken=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
    ]);
    
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, message: 'Logged out' }));
}

/**
 * POST /auth/refresh
 * Refresh session token using either sessionToken or refreshToken from cookies
 */
async function handleRefreshToken(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        // Try sessionToken first
        let sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        let result;
        
        if (sessionToken) {
            // Use existing session token to refresh
            result = await global.auth.refreshSessionToken(sessionToken);
        } else {
            // Fall back to refresh token
            const refreshToken = getRefreshTokenFromCookies(req.headers.cookie);
            
            if (!refreshToken) {
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'No session or refresh token found' }));
                return;
            }
            
            result = await global.auth.refreshSessionTokenWithRefreshToken(refreshToken);
        }
        
        // Set new sessionToken as HTTP-only secure cookie
        const cookieOptions = [
            `sessionToken=${result.sessionToken}`,
            'Path=/',
            'HttpOnly',
            'Secure',
            'SameSite=Strict',
            `Max-Age=${global.auth.config.session.sessionTokenExpiryMinutes * 60}`
        ];
        res.setHeader('Set-Cookie', cookieOptions.join('; '));
        
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true
        }));
    } catch (err) {
        const ts = global.getTimestamp ? global.getTimestamp() : new Date().toISOString();
        console.log(`[${ts}] Token Refresh: FAILED - ${err.message}`);
        res.writeHead(401);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * POST /auth/change-password
 * Change user password (authenticated user only)
 */
async function handleChangePassword(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        // Get sessionToken from cookie
        const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        if (!sessionToken) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Not authenticated' }));
            return;
        }
        
        // Validate session token
        const validation = await global.auth.validateSessionToken(sessionToken);
        if (!validation.valid) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Invalid session' }));
            return;
        }
        
        // Parse request body
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1e6) {
                req.connection.destroy();
            }
        });
        
        req.on('end', async () => {
            try {
                const { oldPassword, newPassword } = JSON.parse(body);
                
                if (!oldPassword || !newPassword) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Missing oldPassword or newPassword' }));
                    return;
                }
                
                // Change password
                await global.auth.changePassword(validation.userId, oldPassword, newPassword);
                
                res.writeHead(200);
                res.end(JSON.stringify({ 
                    success: true,
                    message: 'Password changed successfully'
                }));
            } catch (err) {
                console.error(`[${global.getTimestamp()}] ERROR in handleChangePassword:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${global.getTimestamp()}] ERROR in handleChangePassword:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error' }));
    }
}

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
            
            <div id="passwordChangeStep" class="mfa-section">
                <div style="margin-bottom: 15px; color: #dc3545; font-size: 12px;">
                    ⚠ Your password has expired. Please set a new password to continue.
                </div>
                
                <div class="form-group">
                    <label>Current Password</label>
                    <input type="password" id="currentPassword" placeholder="Enter current password" onkeypress="if(event.key==='Enter') handlePasswordChange()">
                </div>
                
                <div class="form-group">
                    <label>New Password</label>
                    <input type="password" id="newPassword" placeholder="Enter new password" onkeypress="if(event.key==='Enter') handlePasswordChange()">
                </div>
                
                <div class="form-group">
                    <label>Confirm New Password</label>
                    <input type="password" id="confirmPassword" placeholder="Confirm new password" onkeypress="if(event.key==='Enter') handlePasswordChange()">
                </div>
                
                <div id="passwordChangeError" class="error"></div>
                
                <div class="button-group">
                    <button class="btn" onclick="handlePasswordChange()">Change Password</button>
                    <button class="btn btn-secondary" onclick="resetLogin()">Cancel</button>
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
                
                // Check if password change is required
                if (data.requiresPasswordChange) {
                    currentEmail = email;
                    currentPassword = password;
                    document.getElementById('loginStep').style.display = 'none';
                    document.getElementById('passwordChangeStep').classList.add('active');
                    document.getElementById('currentPassword').focus();
                    return;
                }
                
                currentEmail = email;
                currentPassword = password;
                
                // Check if MFA is required (successful response without requiresPasswordChange)
                // If no MFA, the login is complete
                if (data.error === 'MFA code required') {
                    document.getElementById('loginStep').style.display = 'none';
                    document.getElementById('mfaStep').classList.add('active');
                    document.getElementById('mfaCode').focus();
                } else if (data.success) {
                    // No MFA required, login is complete
                    if (data.userId) {
                        localStorage.setItem('kore_userId', data.userId);
                    }
                    
                    const urlParams = new URLSearchParams(window.location.search);
                    const redirectUrl = urlParams.get('redirect');
                    
                    if (redirectUrl) {
                        window.location.href = redirectUrl;
                    } else {
                        window.location.href = '/';
                    }
                } else {
                    // MFA required
                    document.getElementById('loginStep').style.display = 'none';
                    document.getElementById('mfaStep').classList.add('active');
                    document.getElementById('mfaCode').focus();
                }
                
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
                
                // Check if password change is required
                if (data.requiresPasswordChange) {
                    document.getElementById('mfaStep').classList.remove('active');
                    document.getElementById('passwordChangeStep').classList.add('active');
                    document.getElementById('currentPassword').focus();
                    return;
                }
                
                // Store userId in localStorage
                if (data.userId) {
                    localStorage.setItem('kore_userId', data.userId);
                }
                
                // Get redirect URL from query params if provided
                const urlParams = new URLSearchParams(window.location.search);
                const redirectUrl = urlParams.get('redirect');
                
                // Redirect to originally requested page or main page
                if (redirectUrl) {
                    window.location.href = redirectUrl;
                } else {
                    window.location.href = '/';
                }
                
            } catch (err) {
                errorDiv.textContent = 'Network error: ' + err.message;
            }
        }
        
        async function handlePasswordChange() {
            const currentPwd = document.getElementById('currentPassword').value;
            const newPwd = document.getElementById('newPassword').value;
            const confirmPwd = document.getElementById('confirmPassword').value;
            const errorDiv = document.getElementById('passwordChangeError');
            
            errorDiv.textContent = '';
            
            // Validation
            if (!currentPwd) {
                errorDiv.textContent = 'Current password is required';
                return;
            }
            
            if (!newPwd) {
                errorDiv.textContent = 'New password is required';
                return;
            }
            
            if (!confirmPwd) {
                errorDiv.textContent = 'Confirm password is required';
                return;
            }
            
            if (newPwd !== confirmPwd) {
                errorDiv.textContent = 'New passwords do not match';
                return;
            }
            
            if (currentPwd === newPwd) {
                errorDiv.textContent = 'New password must be different from current password';
                return;
            }
            
            try {
                const response = await fetch('/auth/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        oldPassword: currentPwd,
                        newPassword: newPwd
                    })
                });
                
                const data = await response.json();
                
                if (!response.ok || !data.success) {
                    errorDiv.textContent = data.error || 'Failed to change password';
                    return;
                }
                
                // Password changed successfully, complete login
                if (currentEmail && currentPassword) {
                    localStorage.setItem('kore_userId', currentEmail);
                }
                
                const urlParams = new URLSearchParams(window.location.search);
                const redirectUrl = urlParams.get('redirect');
                
                if (redirectUrl) {
                    window.location.href = redirectUrl;
                } else {
                    window.location.href = '/';
                }
                
            } catch (err) {
                errorDiv.textContent = 'Network error: ' + err.message;
            }
        }
        
        function resetLogin() {
            document.getElementById('email').value = '';
            document.getElementById('password').value = '';
            document.getElementById('mfaCode').value = '';
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
            document.getElementById('loginError').textContent = '';
            document.getElementById('mfaError').textContent = '';
            document.getElementById('passwordChangeError').textContent = '';
            
            document.getElementById('loginStep').style.display = 'block';
            document.getElementById('mfaStep').classList.remove('active');
            document.getElementById('passwordChangeStep').classList.remove('active');
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
                console.error(`[${global.getTimestamp()}] ERROR validating token:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${global.getTimestamp()}] ERROR in handleValidateSessionToken:`, err.message);
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
                console.error(`[${global.getTimestamp()}] ERROR in resetMFA:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${global.getTimestamp()}] ERROR in handleAdminResetMFA:`, err.message);
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
                console.error(`[${global.getTimestamp()}] ERROR in unlockUser:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${global.getTimestamp()}] ERROR in handleAdminUnlockUser:`, err.message);
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
                
                // Check if password has expired
                const [userRows] = await global.auth.korePool.execute(
                  'SELECT passwordSetAt FROM users WHERE userId = ?',
                  [result.userId]
                );
                
                if (userRows[0]) {
                  const passwordExpiration = global.auth.config.password?.passwordExpiration || 0;
                  if (passwordExpiration > 0) {
                    const passwordSetAt = new Date(userRows[0].passwordSetAt);
                    const now = new Date();
                    const ageMs = now - passwordSetAt;
                    const ageDays = ageMs / (1000 * 60 * 60 * 24);
                    
                    if (ageDays > passwordExpiration) {
                      // Password expired - require password change
                      console.log(`[${global.getTimestamp()}] Password expired for user: ${email} (age: ${Math.floor(ageDays)} days, limit: ${passwordExpiration} days)`);
                      
                      // Set sessionToken and refreshToken cookies but indicate password change required
                      const sessionCookieOptions = [
                          `sessionToken=${result.sessionToken}`,
                          'Path=/',
                          'HttpOnly',
                          'Secure',
                          'SameSite=Strict',
                          `Max-Age=${global.auth.config.session.sessionTokenExpiryMinutes * 60}`
                      ];
                      
                      const refreshCookieOptions = [
                          `refreshToken=${result.refreshToken}`,
                          'Path=/',
                          'HttpOnly',
                          'Secure',
                          'SameSite=Strict',
                          `Max-Age=${global.auth.config.session.reloginTokenExpiryDays * 24 * 60 * 60}`
                      ];
                      
                      res.setHeader('Set-Cookie', [
                          sessionCookieOptions.join('; '),
                          refreshCookieOptions.join('; ')
                      ]);
                      
                      res.writeHead(200);
                      res.end(JSON.stringify({
                          requiresPasswordChange: true,
                          userId: result.userId,
                          sessionToken: result.sessionToken,
                          refreshToken: result.refreshToken,
                          message: 'Password has expired and must be changed'
                      }));
                      return;
                    }
                  }
                }
                
                // Set sessionToken as HTTP-only secure cookie (short-lived)
                const sessionCookieOptions = [
                    `sessionToken=${result.sessionToken}`,
                    'Path=/',
                    'HttpOnly',
                    'Secure',
                    'SameSite=Strict',
                    `Max-Age=${global.auth.config.session.sessionTokenExpiryMinutes * 60}`
                ];
                
                // Set refreshToken as HTTP-only secure cookie (long-lived)
                const refreshCookieOptions = [
                    `refreshToken=${result.refreshToken}`,
                    'Path=/',
                    'HttpOnly',
                    'Secure',
                    'SameSite=Strict',
                    `Max-Age=${global.auth.config.session.reloginTokenExpiryDays * 24 * 60 * 60}`
                ];
                
                // Set both cookies
                res.setHeader('Set-Cookie', [
                    sessionCookieOptions.join('; '),
                    refreshCookieOptions.join('; ')
                ]);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    userId: result.userId,
                    sessionToken: result.sessionToken,
                    refreshToken: result.refreshToken
                }));
            } catch (err) {
                console.error(`[${global.getTimestamp()}] ERROR in login:`, err.message);
                res.writeHead(401);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${global.getTimestamp()}] ERROR in handleLogin:`, err.message);
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
                          console.log(`[${global.getTimestamp()}] Invite email sent to ${email}`);
                        } else {
                          console.error(`[${global.getTimestamp()}] Email send returned status ${emailRes.statusCode}`);
                        }
                      });
                    });

                    emailReq.on('error', (err) => {
                      console.error(`[${global.getTimestamp()}] Error sending invite email:`, err.message);
                    });

                    emailReq.write(payload);
                    emailReq.end();
                  } catch (err) {
                    console.error(`[${global.getTimestamp()}] Error in email task:`, err.message);
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
                console.error(`[${global.getTimestamp()}] ERROR creating user:`, err.message);
                
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
        console.error(`[${global.getTimestamp()}] ERROR in handleCreateUser:`, err.message);
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
        console.error(`[${global.getTimestamp()}] ERROR resending invite:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * PUT /users/:id
 * Update user details (email, fullName, active)
 */
async function handleUpdateUser(req, res, userId) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { email, fullName, active, groupIds } = data;
                
                if (!email) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Email is required' }));
                    return;
                }
                
                const result = await global.auth.updateUser(userId, email, fullName, active, groupIds, null);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: 'User updated successfully'
                }));
            } catch (err) {
                console.error(`[${global.getTimestamp()}] ERROR updating user:`, err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${global.getTimestamp()}] ERROR in handleUpdateUser:`, err.message);
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
        console.error(`[${global.getTimestamp()}] ERROR rendering setup form:`, err.message);
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
                console.error(`[${global.getTimestamp()}] ERROR in MFA reset:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${global.getTimestamp()}] ERROR in handleMFAResetComplete:`, err.message);
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
                console.error(`[${global.getTimestamp()}] ERROR completing setup:`, err.message);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        console.error(`[${global.getTimestamp()}] ERROR in handleCompleteSetup:`, err.message);
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
    if (req.method === 'GET' && (req.url === '/login' || req.url.startsWith('/login?'))) {
        handleLoginForm(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/auth/login') {
        handleLogin(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/auth/logout') {
        handleLogout(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/auth/refresh') {
        handleRefreshToken(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/auth/change-password') {
        handleChangePassword(req, res);
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
    } else if (req.method === 'PUT' && req.url.match(/^\/users\/[a-f0-9-]+$/)) {
        const userId = req.url.split('/')[2];
        handleUpdateUser(req, res, userId);
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

/**
 * Validate user session token from JWT (for middleware use)
 * Returns { valid: boolean, userId?: string }
 */
function validateUserSessionToken(token) {
    try {
        if (!token) return { valid: false };
        
        const parts = token.split('.');
        if (parts.length !== 3) return { valid: false };
        
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        const now = Math.floor(Date.now() / 1000);
        
        if (!payload.userId || payload.exp < now) {
            return { valid: false };
        }
        
        return { valid: true, userId: payload.userId };
    } catch (err) {
        return { valid: false };
    }
}

/**
 * Check if request is for a protected static file (.html)
 */
function isProtectedStaticFile(urlPath) {
    // Public pages (no auth required)
    const publicPages = ['/login', '/usersetup'];
    
    // Check if URL matches public pages
    for (const page of publicPages) {
        if (urlPath === page || urlPath.startsWith(page + '?')) {
            return false;
        }
    }
    
    // Only protect actual .html files
    return urlPath.endsWith('.html');
}

/**
 * Extract session token from cookies
 */
function getSessionTokenFromCookies(cookieHeader) {
    if (!cookieHeader) return null;
    
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
        if (cookie.startsWith('sessionToken=')) {
            return cookie.substring('sessionToken='.length);
        }
    }
    return null;
}

/**
 * Extract refresh token from cookies
 */
function getRefreshTokenFromCookies(cookieHeader) {
    if (!cookieHeader) return null;
    
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
        if (cookie.startsWith('refreshToken=')) {
            return cookie.substring('refreshToken='.length);
        }
    }
    return null;
}

module.exports = Auth;
module.exports.routeAuthRequest = routeAuthRequest;
module.exports.validateUserSessionToken = validateUserSessionToken;
module.exports.isProtectedStaticFile = isProtectedStaticFile;
module.exports.getSessionTokenFromCookies = getSessionTokenFromCookies;
module.exports.getRefreshTokenFromCookies = getRefreshTokenFromCookies;