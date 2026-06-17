/**
 * Kore Authentication System
 * 
 * Handles user registration, login, MFA, session tokens, and permissions
 * 
 * @version 0.500 - [KORE_VERSION_INCREMENT_ON_UPDATE]
 */

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');

class Auth {
  /**
   * Authentication system constructor
   * 
   * Note: Auth is instantiated fresh on each initialization (not a singleton).
   * All initialization happens in constructor.
   */
  constructor(korePool, cryptoUtils, securityConfig, logAuditFn, jwtSigningKey) {
    this.korePool = korePool;
    this.crypto = cryptoUtils;
    this.config = securityConfig;
    this.logAudit = logAuditFn;
    this.jwtSigningKey = jwtSigningKey;
  }

  /**
   * Initialize method for consistency with other subsystems
   * Auth is stateless and creates fresh instance, so this is a no-op
   */
  async initialize() {
    // No-op: all setup happens in constructor
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
      name: `${email}`,
      issuer: 'Kore',
      length: 32
    });
    
    return {
      secret: secret.base32,
      ascii: secret.ascii,
      otpauth_url: secret.otpauth_url
    };
  }

  /**
   * Generate QR code as data URL
   */
  async generateQRCode(otpauth_url) {
    try {
      const qrCode = await QRCode.toDataURL(otpauth_url);
      return qrCode;
    } catch (err) {
      global.consoleLog('Auth', `Error generating QR code: ${err.message}`, 1);
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

  // ========== ENTITY MANAGEMENT (Generic + Backward Compatible) ==========

  /**
   * Generic entity creation - handles users, groups, organizations, etc.
   * Schema defines table structure, field mappings, and special logic
   */
  async createEntity(entityType, data, createdBy) {
    try {
      const schemas = {
        user: {
          table: 'users',
          idField: 'userId',
          requiredFields: ['email', 'fullName'],
          defaults: { status: 'invited' },
          specialLogic: async (id, data) => {
            const inviteToken = crypto.randomBytes(32).toString('hex');
            const inviteTokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
            const inviteExpiresAt = new Date(Date.now() + this.config.invite.expirationHours * 60 * 60 * 1000);
            return { inviteToken, inviteTokenHash, inviteExpiresAt };
          }
        },
        group: {
          table: 'user_groups',
          idField: 'groupId',
          requiredFields: ['name'],
          fieldMap: { groupName: 'name' },
          defaults: { active: 1 }
        }
      };

      const schema = schemas[entityType];
      if (!schema) throw new Error(`Unknown entity type: ${entityType}`);

      const id = crypto.randomUUID();
      let fields = { ...schema.defaults, ...data };
      
      // Map field names if needed
      if (schema.fieldMap) {
        Object.entries(schema.fieldMap).forEach(([from, to]) => {
          if (fields[from]) {
            fields[to] = fields[from];
            delete fields[from];
          }
        });
      }

      // Validate required fields
      for (const field of schema.requiredFields) {
        if (!fields[field]) throw new Error(`${field} is required`);
      }

      // Handle special logic (e.g., invite tokens)
      let specialData = {};
      if (schema.specialLogic) {
        const allSpecialData = await schema.specialLogic(id, fields);
        // Only store database-appropriate fields, not transient ones like inviteToken
        if (entityType === 'user') {
          specialData = {
            inviteTokenHash: allSpecialData.inviteTokenHash,
            inviteExpiresAt: allSpecialData.inviteExpiresAt
          };
          // Keep inviteToken for response but not for DB storage
          specialData._inviteToken = allSpecialData.inviteToken;
        } else {
          specialData = allSpecialData;
        }
      }

      // Build and execute INSERT query
      const dbSpecialData = Object.fromEntries(
        Object.entries(specialData).filter(([k]) => !k.startsWith('_'))
      );
      const columns = [schema.idField, ...Object.keys(fields), ...Object.keys(dbSpecialData), 'createdAt', 'createdBy'];
      const values = [id, ...Object.values(fields), ...Object.values(dbSpecialData), createdBy];
      const placeholders = columns.map(c => c === 'createdAt' ? 'NOW()' : '?').join(', ');
      const columnList = columns.map(c => c === 'createdAt' ? 'createdAt' : c).join(', ');
      
      const query = `INSERT INTO \`${schema.table}\` (${columnList}) VALUES (${placeholders})`;
      await this.korePool.execute(query, values);

      await this.logAudit(`${entityType}_created`, entityType, id, fields[schema.requiredFields[0]], createdBy, fields, null);
      global.consoleLog('Auth', `${entityType.charAt(0).toUpperCase() + entityType.slice(1)} created: ${id}`, 3);
      
      // Prepare response: include inviteToken if present, exclude internal fields starting with _
      const responseSpecialData = {};
      if (specialData._inviteToken) {
        responseSpecialData.inviteToken = specialData._inviteToken;
      }
      // Include stored fields in response
      Object.entries(specialData).forEach(([k, v]) => {
        if (!k.startsWith('_')) {
          responseSpecialData[k] = v;
        }
      });
      
      return { [schema.idField]: id, ...data, ...responseSpecialData };
    } catch (err) {
      global.consoleLog('Auth', `ERROR creating ${entityType}: ${err.message}`, 1);
      throw err;
    }
  }

  /**
   * Generic entity update - handles users, groups, organizations, etc.
   */
  async updateEntity(entityType, id, data, updatedBy) {
    try {
      const schemas = {
        user: {
          table: 'users',
          idField: 'userId',
          fieldMap: {}
        },
        group: {
          table: 'user_groups',
          idField: 'groupId',
          fieldMap: { groupName: 'name' }
        }
      };

      const schema = schemas[entityType];
      if (!schema) throw new Error(`Unknown entity type: ${entityType}`);

      let fields = { ...data };

      // Map field names if needed
      if (schema.fieldMap) {
        Object.entries(schema.fieldMap).forEach(([from, to]) => {
          if (fields[from]) {
            fields[to] = fields[from];
            delete fields[from];
          }
        });
      }

      // Handle special serialization
      if (entityType === 'user' && fields.groupIds) {
        fields.groupIds = Array.isArray(fields.groupIds) ? JSON.stringify(fields.groupIds) : '[]';
      }

      // Handle boolean to int conversion
      if (typeof fields.active === 'boolean') {
        fields.active = fields.active ? 1 : 0;
      }

      // Build and execute UPDATE query
      const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
      const values = [...Object.values(fields), updatedBy || null, id];
      const query = `UPDATE \`${schema.table}\` SET ${setClause}, updatedAt = NOW(), updatedBy = ? WHERE ${schema.idField} = ?`;
      
      await this.korePool.execute(query, values);
      await this.logAudit(`${entityType}_updated`, entityType, id, null, null, data, null);
      global.consoleLog('Auth', `${entityType.charAt(0).toUpperCase() + entityType.slice(1)} updated: ${id}`, 3);
      
      return { success: true };
    } catch (err) {
      global.consoleLog('Auth', `ERROR updating ${entityType}: ${err.message}`, 1);
      throw err;
    }
  }

  /**
   * Create user (backward compatibility wrapper)
   */
  async createUser(email, fullName, createdBy) {
    return this.createEntity('user', { email, fullName }, createdBy);
  }

  /**
   * Update user (backward compatibility wrapper)
   */
  async updateUser(userId, email, fullName, active, groupIds, updatedBy) {
    return this.updateEntity('user', userId, { email, fullName, active, groupIds }, updatedBy);
  }

  /**
   * Create group (backward compatibility wrapper)
   */
  async createGroup(groupName, description, createdBy) {
    return this.createEntity('group', { groupName, description }, createdBy);
  }

  /**
   * Update group (backward compatibility wrapper)
   */
  async updateGroup(groupId, groupName, description, active, updatedBy) {
    return this.updateEntity('group', groupId, { groupName, description, active }, updatedBy);
  }

  /**
   * Send invite email (generates token, updates DB, sends email)
   */
  async sendInviteEmail(userId, email, fullName) {
    try {
      const inviteToken = crypto.randomBytes(32).toString('hex');
      const inviteTokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
      const inviteExpiresAt = new Date(Date.now() + this.config.invite.expirationHours * 60 * 60 * 1000);
      
      // Update database with new token
      const query = `
        UPDATE kore_sys.users 
        SET inviteTokenHash = ?, inviteExpiresAt = ?, updatedAt = NOW()
        WHERE userId = ?
      `;
      
      await this.korePool.execute(query, [
        inviteTokenHash,
        inviteExpiresAt,
        userId
      ]);
      
      await this.logAudit('invite_sent', 'user', userId, null, null, 
        { action: 'Invite email sent' }, null);
      
      // Send email asynchronously (don't block)
      (async () => {
        try {
          const setupLink = `https://app.equinoxits.com:1139/usersetup?token=${inviteToken}`;
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
                <p style="font-size: 12px; color: #999999; margin: 0; text-align: center;">This link expires in ${this.config.invite.expirationHours} hours.</p>
            </td>
        </tr>
    </table>
</body>
</html>`;

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
              'Authorization': 'Bearer ' + inviteToken
            },
            rejectUnauthorized: false
          };

          const emailReq = https.request(options, (emailRes) => {
            let data = '';
            emailRes.on('data', chunk => data += chunk);
            emailRes.on('end', () => {
              if (emailRes.statusCode === 200 || emailRes.statusCode === 201) {
                global.consoleLog('Auth', `Invite email sent to ${email}`, 3);
              } else {
                global.consoleLog('Auth', `Email send returned status ${emailRes.statusCode}`, 1);
              }
            });
          });

          emailReq.on('error', (err) => {
            global.consoleLog('Auth', `Error sending invite email: ${err.message}`, 1);
          });

          emailReq.write(payload);
          emailReq.end();
        } catch (err) {
          global.consoleLog('Auth', `Error in sendInviteEmail task: ${err.message}`, 1);
        }
      })();
      
      return { inviteToken, inviteExpiresAt };
    } catch (err) {
      global.consoleLog('Auth', `ERROR sending invite email: ${err.message}`, 1);
      throw err;
    }
  }

  /**
   * Resend invite to user
   */
  async resendInvite(userId) {
    try {
      // Get user info
      const userQuery = `SELECT email, fullName FROM kore_sys.users WHERE userId = ?`;
      const [userRows] = await this.korePool.execute(userQuery, [userId]);
      
      if (!userRows || userRows.length === 0) {
        throw new Error('User not found');
      }
      
      const { email, fullName } = userRows[0];
      
      // Send invite (generates token, updates DB, sends email)
      return await this.sendInviteEmail(userId, email, fullName);
    } catch (err) {
      global.consoleLog('Auth', `ERROR resending invite:: ${err.message}`, 1);
      throw err;
    }
  }

  /**
   * Complete account setup (password + MFA)
   */
  /**
   * Validate invite token (check if it exists and is not expired)
   * Returns { valid: boolean, message?: string, email?: string }
   */
  async validateInviteToken(inviteToken) {
    try {
      const inviteTokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
      
      const [userRows] = await this.korePool.execute(
        'SELECT userId, email, inviteExpiresAt FROM users WHERE inviteTokenHash = ?',
        [inviteTokenHash]
      );
      
      if (!userRows[0]) {
        return {
          valid: false,
          message: 'Invalid or expired invite token'
        };
      }
      
      const user = userRows[0];
      
      // Check expiration
      if (new Date() > new Date(user.inviteExpiresAt)) {
        return {
          valid: false,
          message: 'Invite token has expired. Please request a new invitation.'
        };
      }
      
      return {
        valid: true,
        email: user.email
      };
    } catch (err) {
      return {
        valid: false,
        message: 'Error validating invite token'
      };
    }
  }

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
      
      global.consoleLog('Auth', `Setup completed for user: ${user.email}`, 3);
      
      return {
        success: true,
        userId: user.userId,
        backupCodes: plainCodes
      };
    } catch (err) {
      global.consoleLog('Auth', `ERROR completing setup:: ${err.message}`, 1);
      throw err;
    }
  }

  // ========== AUTHENTICATION ==========

  /**
   * Login with email, password, and MFA code
   */
  async login(email, password, mfaCode, userAgent = null, ipAddress = null) {
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

      // Check session limit and manage concurrent sessions
      const maxSessions = this.config.session?.maxConcurrentSessions || 2;
      
      const [sessionRows] = await this.korePool.execute(
        'SELECT refreshTokenHash, lastUsedAt FROM refresh_tokens WHERE userId = ? ORDER BY lastUsedAt ASC',
        [user.userId]
      );

      let activeSessions = sessionRows.length;
      let willExceedLimit = activeSessions >= maxSessions;
      let oldestSessionHash = null;
      
      // Note which session would be deleted, but don't delete yet
      if (willExceedLimit && sessionRows.length > 0) {
        oldestSessionHash = sessionRows[0].refreshTokenHash;
      }

      // Only insert new refresh token (don't delete yet - wait for client confirmation)
      const refreshTokenId = crypto.randomUUID();
      await this.korePool.execute(
        'INSERT INTO refresh_tokens (refreshTokenId, userId, refreshTokenHash, userAgent, ipAddress, createdAt, lastUsedAt, expiresAt) VALUES (?, ?, ?, ?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))',
        [refreshTokenId, user.userId, refreshTokenHash, userAgent || null, ipAddress || null, this.config.session.reloginTokenExpiryDays]
      );

      await this.logAudit('login', 'user', user.userId, null, user.userId, { action: 'User logged in', ipAddress, userAgent }, null);

      global.consoleLog('Auth', `User logged in: ${email}`, 3);

      return {
        userId: user.userId,
        sessionToken,
        refreshToken,
        activeSessions,
        maxSessions,
        willExceedLimit,
        oldestSessionHash  // Send hash so client can request deletion if confirmed
      };
    } catch (err) {
      global.consoleLog('Auth', `ERROR during login:: ${err.message}`, 1);
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
      global.consoleLog('Auth', `ERROR validating session token:: ${err.message}`, 1);
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

      global.consoleLog('Auth', `Session refreshed for user: ${userId}`, 3);

      return {
        sessionToken: newSessionToken
      };
    } catch (err) {
      global.consoleLog('Auth', `ERROR refreshing session:: ${err.message}`, 1);
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

      // Find refresh token session record
      const query = 'SELECT userId, expiresAt FROM refresh_tokens WHERE refreshTokenHash = ?';
      const [rows] = await this.korePool.execute(query, [refreshTokenHash]);

      if (!rows || rows.length === 0) {
        throw new Error('Invalid refresh token');
      }

      const tokenRecord = rows[0];
      const userId = tokenRecord.userId;

      // Check if token is expired
      const expiresAt = new Date(tokenRecord.expiresAt);
      if (Date.now() > expiresAt.getTime()) {
        // Delete expired token
        await this.korePool.execute(
          'DELETE FROM refresh_tokens WHERE refreshTokenHash = ?',
          [refreshTokenHash]
        );
        throw new Error('Refresh token expired');
      }

      // Get user details
      const userQuery = 'SELECT userId, status, active FROM users WHERE userId = ?';
      const [userRows] = await this.korePool.execute(userQuery, [userId]);

      if (!userRows || userRows.length === 0) {
        throw new Error('User not found');
      }

      const user = userRows[0];

      // Check if user is still active
      if (!user.active || user.status === 'inactive') {
        throw new Error('User account is inactive');
      }

      // Generate new session token
      const newSessionToken = this.generateSessionToken(userId);

      // Update lastUsedAt timestamp for this refresh token
      await this.korePool.execute(
        'UPDATE refresh_tokens SET lastUsedAt = NOW() WHERE refreshTokenHash = ?',
        [refreshTokenHash]
      );

      global.consoleLog('Auth', `Session refreshed with refresh token for user: ${userId}`, 3);

      return {
        sessionToken: newSessionToken
      };
    } catch (err) {
      global.consoleLog('Auth', `ERROR refreshing with refresh token:: ${err.message}`, 1);
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

      global.consoleLog('Auth', `MFA reset for user ${user.email} by ${resetBy}`, 3);

      return { success: true, userId, email: user.email };
    } catch (err) {
      global.consoleLog('Auth', `ERROR resetting MFA:: ${err.message}`, 1);
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

      global.consoleLog('Auth', `Account unlocked for user ${user.email} by ${unlockedBy}`, 3);

      return { success: true, userId, email: user.email };
    } catch (err) {
      global.consoleLog('Auth', `ERROR unlocking user:: ${err.message}`, 1);
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

          global.consoleLog('Auth', `Account auto-unlocked for user ${user.email}`, 3);

          return { unlocked: true, userId };
        }
      }

      return { unlocked: false };
    } catch (err) {
      global.consoleLog('Auth', `ERROR checking auto-unlock:: ${err.message}`, 1);
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
      global.consoleLog('Auth', `ERROR getting user groups:: ${err.message}`, 1);
      return [];
    }
  }

  /**
   * Get user's permissions (direct + via groups)
   * @param {string} userId
   * @param {boolean} includeRevoked - If true, includes revoked permissions (default: false)
   */
  async getUserPermissions(userId, includeRevoked = false) {
    try {
      const query = `
        SELECT resource, action, scope, effect, revokedAt, targetType, targetId
        FROM permissions 
        WHERE (targetType = 'user' AND targetId = ?) 
           OR (targetType = 'group' AND targetId IN (
             SELECT JSON_UNQUOTE(JSON_EXTRACT(groupIds, CONCAT('$[', idx, ']')))
             FROM users, 
             (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4) AS indices
             WHERE users.userId = ?
             AND JSON_EXTRACT(groupIds, CONCAT('$[', idx, ']')) IS NOT NULL
           ))
        ${includeRevoked ? '' : 'AND revokedAt IS NULL'}
      `;
      
      const [rows] = await this.korePool.execute(query, [userId, userId]);

      // Collect scope IDs needing name lookup, grouped by resource type
      const workflowIds  = [...new Set(rows.filter(r => r.resource === 'workflow'  && r.scope).map(r => r.scope))];
      const formIds      = [...new Set(rows.filter(r => r.resource === 'form'      && r.scope).map(r => r.scope))];
      const datatableIds = [...new Set(rows.filter(r => r.resource === 'datatable' && r.scope).map(r => r.scope))];
      const groupIds     = [...new Set(rows.filter(r => r.targetType === 'group').map(r => r.targetId))];

      const workflowMap  = {};
      const formMap      = {};
      const datatableMap = {};
      const groupMap     = {};

      if (workflowIds.length) {
        const placeholders = workflowIds.map(() => '?').join(',');
        const [wRows] = await this.korePool.execute(
          `SELECT id, name FROM kore_sys.workflows WHERE id IN (${placeholders})`,
          workflowIds
        );
        wRows.forEach(r => { workflowMap[r.id] = r.name; });
      }

      if (formIds.length) {
        const placeholders = formIds.map(() => '?').join(',');
        const [fRows] = await this.korePool.execute(
          `SELECT id, name FROM kore_sys.forms WHERE id IN (${placeholders})`,
          formIds
        );
        fRows.forEach(r => { formMap[r.id] = r.name; });
      }

      if (datatableIds.length) {
        const placeholders = datatableIds.map(() => '?').join(',');
        const [dRows] = await this.korePool.execute(
          `SELECT id, name FROM kore_sys.datatables WHERE id IN (${placeholders})`,
          datatableIds
        );
        dRows.forEach(r => { datatableMap[r.id] = r.name; });
      }

      if (groupIds.length) {
        const placeholders = groupIds.map(() => '?').join(',');
        const [gRows] = await this.korePool.execute(
          `SELECT groupId, name FROM kore_sys.user_groups WHERE groupId IN (${placeholders})`,
          groupIds
        );
        gRows.forEach(r => { groupMap[r.groupId] = r.name; });
      }

      const mapped = rows.map(row => {
        let scopeName = null;
        if (row.resource === 'workflow' && row.scope && workflowMap[row.scope]) {
          scopeName = workflowMap[row.scope];
        } else if (row.resource === 'form' && row.scope && formMap[row.scope]) {
          scopeName = formMap[row.scope];
        } else if (row.resource === 'datatable' && row.scope && datatableMap[row.scope]) {
          scopeName = datatableMap[row.scope];
        }

        const source = row.targetType === 'group'
          ? { type: 'group', groupId: row.targetId, groupName: groupMap[row.targetId] || row.targetId }
          : { type: 'user' };

        return {
          resource: row.resource,
          action: row.action,
          scope: row.scope,
          scope_name: scopeName,
          effect: row.effect,
          source,
          ...(includeRevoked && { revokedAt: row.revokedAt })
        };
      });

      // Sort by resource, then scope_name/scope, then action
      mapped.sort((a, b) => {
        const r = (a.resource || '').localeCompare(b.resource || '');
        if (r !== 0) return r;
        const s = (a.scope_name || a.scope || '').localeCompare(b.scope_name || b.scope || '');
        if (s !== 0) return s;
        return (a.action || '').localeCompare(b.action || '');
      });

      return mapped;
    } catch (err) {
      global.consoleLog('Auth', `ERROR getting user permissions:: ${err.message}`, 1);
      return [];
    }
  }

  /**
   * Check if user has permission
   * Explicit 'deny' always takes precedence over 'allow'
   * Scope can be NULL (applies to entire resource) or a JSON object for specific scope
   */
  /**
   * Generic permissions query with flexible filtering
   * Supports filters with suffixes: None (=), Not (!=), In (IN), NotIn (NOT IN)
   * 
   * Example:
   *   getPermissions({ resource: 'workflow', scope: workflowId, effect: 'deny' })
   *   getPermissions({ targetType: 'group', actionIn: ['view', 'create'] })
   *   getPermissions({ permissionId: 'xxx', revokedAtNot: null })
   */
  async getPermissions(filters = {}) {
    try {
      const conditions = [];
      const params = [];
      
      // Valid base field names
      const validFields = ['permissionId', 'targetType', 'targetId', 'resource', 'scope', 'action', 'effect', 'grantedAt', 'grantedBy', 'revokedAt', 'revokedBy'];

      // Build WHERE conditions from filters
      for (const [key, value] of Object.entries(filters)) {
        // Parse field name and suffix
        let field = null;
        let operator = '=';
        
        for (const validField of validFields) {
          if (key === validField) {
            field = validField;
            operator = '=';
            break;
          } else if (key === validField + 'Not') {
            field = validField;
            operator = '!=';
            break;
          } else if (key === validField + 'In') {
            field = validField;
            operator = 'IN';
            break;
          } else if (key === validField + 'NotIn') {
            field = validField;
            operator = 'NOT IN';
            break;
          }
        }

        if (!field) {
          throw new Error(`Invalid filter field: ${key}`);
        }

        // Build condition based on operator
        if (operator === '=') {
          conditions.push(`p.${field} = ?`);
          params.push(value);
        } else if (operator === '!=') {
          conditions.push(`p.${field} != ?`);
          params.push(value);
        } else if (operator === 'IN') {
          if (!Array.isArray(value) || value.length === 0) {
            throw new Error(`${key} must be a non-empty array`);
          }
          const placeholders = value.map(() => '?').join(',');
          conditions.push(`p.${field} IN (${placeholders})`);
          params.push(...value);
        } else if (operator === 'NOT IN') {
          if (!Array.isArray(value) || value.length === 0) {
            throw new Error(`${key} must be a non-empty array`);
          }
          const placeholders = value.map(() => '?').join(',');
          conditions.push(`p.${field} NOT IN (${placeholders})`);
          params.push(...value);
        }
      }

      // Build WHERE clause
      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      const query = `
        SELECT 
          p.permissionId, p.targetType, p.targetId, p.resource, p.scope, p.action, p.effect, 
          p.grantedAt, p.grantedBy, p.revokedAt, p.revokedBy,
          CASE 
            WHEN p.targetType = 'group' THEN ug.name
            WHEN p.targetType = 'user' THEN u.fullName
            ELSE NULL
          END as targetName
        FROM kore_sys.permissions p
        LEFT JOIN kore_sys.user_groups ug ON p.targetType = 'group' AND ug.groupId = p.targetId
        LEFT JOIN kore_sys.users u ON p.targetType = 'user' AND u.userId = p.targetId
        ${whereClause}
        ORDER BY p.grantedAt DESC
      `;

      const connection = await this.korePool.getConnection();
      try {
        const [rows] = await connection.execute(query, params);

        // Resolve scope names for workflow, form, and datatable resource types
        const workflowIds  = [...new Set(rows.filter(r => r.resource === 'workflow'  && r.scope).map(r => r.scope))];
        const formIds      = [...new Set(rows.filter(r => r.resource === 'form'      && r.scope).map(r => r.scope))];
        const datatableIds = [...new Set(rows.filter(r => r.resource === 'datatable' && r.scope).map(r => r.scope))];

        const workflowMap  = {};
        const formMap      = {};
        const datatableMap = {};

        if (workflowIds.length) {
          const placeholders = workflowIds.map(() => '?').join(',');
          const [wRows] = await connection.execute(
            `SELECT id, name FROM kore_sys.workflows WHERE id IN (${placeholders})`,
            workflowIds
          );
          wRows.forEach(r => { workflowMap[r.id] = r.name; });
        }

        if (formIds.length) {
          const placeholders = formIds.map(() => '?').join(',');
          const [fRows] = await connection.execute(
            `SELECT id, name FROM kore_sys.forms WHERE id IN (${placeholders})`,
            formIds
          );
          fRows.forEach(r => { formMap[r.id] = r.name; });
        }

        if (datatableIds.length) {
          const placeholders = datatableIds.map(() => '?').join(',');
          const [dRows] = await connection.execute(
            `SELECT id, name FROM kore_sys.datatables WHERE id IN (${placeholders})`,
            datatableIds
          );
          dRows.forEach(r => { datatableMap[r.id] = r.name; });
        }

        return rows.map(row => {
          let scope_name = null;
          if (row.resource === 'workflow' && row.scope && workflowMap[row.scope]) {
            scope_name = workflowMap[row.scope];
          } else if (row.resource === 'form' && row.scope && formMap[row.scope]) {
            scope_name = formMap[row.scope];
          } else if (row.resource === 'datatable' && row.scope && datatableMap[row.scope]) {
            scope_name = datatableMap[row.scope];
          }
          return { ...row, scope_name };
        });

      } finally {
        connection.release();
      }

    } catch (error) {
      global.consoleLog('Auth', `Error getting permissions: ${error.message}`, 1);
      throw error;
    }
  }

  /**
   * Check if client IP is allowed based on whitelist configuration
   * allowedIPs: null/empty (allow all), or JSON array of IPs/CIDR/["whitelist.internal", "whitelist.api", etc.]
   */
  async isIPAllowed(clientIP, allowedIPs) {
    try {
      // If no restrictions, allow
      if (!allowedIPs) {
        return true;
      }

      let ips = [];
      
      // Parse allowedIPs if it's a string
      if (typeof allowedIPs === 'string') {
        try {
          ips = JSON.parse(allowedIPs);
        } catch (e) {
          global.consoleLog('Auth', `Failed to parse allowedIPs: ${e.message}`, 2);
          return false;
        }
      } else if (Array.isArray(allowedIPs)) {
        ips = allowedIPs;
      } else {
        return false;
      }

      if (!Array.isArray(ips) || ips.length === 0) {
        return true;
      }

      // Expand whitelist references (whitelist.internal, whitelist.api, etc.)
      let ipsToCheck = [];
      let cachedWhitelists = null; // Cache to avoid multiple DB fetches
      let whitelistQueryFailed = false;
      
      for (const ip of ips) {
        if (ip.startsWith('whitelist.')) {
          // Extract category name (e.g., "whitelist.internal" → "internal")
          const category = ip.substring('whitelist.'.length);
          
          // Fetch whitelists from system_config if not cached
          if (cachedWhitelists === null && !whitelistQueryFailed) {
            try {
              const [configRows] = await this.korePool.execute(
                'SELECT whitelists FROM kore_sys.system_config LIMIT 1'
              );
              
              if (configRows.length > 0 && configRows[0].whitelists) {
                cachedWhitelists = typeof configRows[0].whitelists === 'string'
                  ? JSON.parse(configRows[0].whitelists)
                  : configRows[0].whitelists;
              } else {
                cachedWhitelists = {};
              }
            } catch (err) {
              global.consoleLog('Auth', `Failed to fetch system whitelists: ${err.message}`, 2);
              global.consoleLog('Auth', `Whitelist references will not be expanded. Treat allowedIPs as direct IP addresses.`, 2);
              whitelistQueryFailed = true;
              cachedWhitelists = {};
            }
          }
          
          // Add IPs from the requested category (if found)
          if (cachedWhitelists && cachedWhitelists[category] && Array.isArray(cachedWhitelists[category])) {
            ipsToCheck.push(...cachedWhitelists[category]);
          } else if (whitelistQueryFailed) {
            // If whitelist query failed, skip this reference and don't block access
            global.consoleLog('Auth', `Skipping whitelist reference '${ip}' - system not configured`, 2);
          }
        } else {
          ipsToCheck.push(ip);
        }
      }

      // Check if clientIP matches any in the list
      for (const ipRule of ipsToCheck) {
        if (this.isIPMatch(clientIP, ipRule)) {
          return true;
        }
      }

      return false;

    } catch (err) {
      global.consoleLog('Auth', `Error checking IP allowance: ${err.message}`, 1);
      return false;
    }
  }

  /**
   * Check if clientIP matches an IP rule (exact match or CIDR)
   */
  isIPMatch(clientIP, ipRule) {
    // Exact match
    if (clientIP === ipRule) {
      return true;
    }

    // CIDR match (simple implementation)
    if (ipRule.includes('/')) {
      try {
        const [network, maskStr] = ipRule.split('/');
        const mask = parseInt(maskStr, 10);

        if (this.isIPv4(clientIP) && this.isIPv4(network)) {
          return this.isIPv4InCIDR(clientIP, network, mask);
        }
      } catch (e) {
        global.consoleLog('Auth', `Invalid CIDR: ${ipRule}`, 2);
      }
    }

    return false;
  }

  /**
   * Simple IPv4 CIDR check
   */
  isIPv4InCIDR(ip, network, mask) {
    const ipParts = ip.split('.').map(Number);
    const netParts = network.split('.').map(Number);

    if (ipParts.length !== 4 || netParts.length !== 4) {
      return false;
    }

    let maskBits = 32 - mask;
    for (let i = 0; i < 4; i++) {
      const shift = Math.max(0, 8 - maskBits);
      if ((ipParts[i] >> shift) !== (netParts[i] >> shift)) {
        return false;
      }
      maskBits = Math.max(0, maskBits - 8);
    }

    return true;
  }

  /**
   * Check if string is valid IPv4
   */
  isIPv4(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => {
      const n = parseInt(p, 10);
      return n >= 0 && n <= 255;
    });
  }

  async hasPermission(userId, resource, action, scope = null) {
    try {
      // Build action condition: match specific action OR wildcard if checking specific action
      const actionCondition = action === '*' 
        ? `action = ?`
        : `(action = ? OR action = '*')`;
      
      // Precedence: User permissions > Group permissions > Default allow
      
      // 1. Check for USER DENY (highest priority)
      const userDenyQuery = `
        SELECT COUNT(*) as count 
        FROM kore_sys.permissions 
        WHERE targetType = 'user' AND targetId = ?
        AND resource = ? 
        AND ${actionCondition}
        AND effect = 'deny'
        AND (scope IS NULL ${scope ? `OR scope = ?` : ''})
        AND revokedAt IS NULL
      `;
      
      const userDenyParams = [userId, resource, action];
      if (scope) userDenyParams.push(scope);
      
      const [userDenyRows] = await this.korePool.execute(userDenyQuery, userDenyParams);
      if (userDenyRows[0].count > 0) {
        return false; // User deny always blocks
      }
      
      // 2. Check for USER ALLOW
      const userAllowQuery = `
        SELECT COUNT(*) as count 
        FROM kore_sys.permissions 
        WHERE targetType = 'user' AND targetId = ?
        AND resource = ? 
        AND ${actionCondition}
        AND effect = 'allow'
        AND (scope IS NULL ${scope ? `OR scope = ?` : ''})
        AND revokedAt IS NULL
      `;
      
      const userAllowParams = [userId, resource, action];
      if (scope) userAllowParams.push(scope);
      
      const [userAllowRows] = await this.korePool.execute(userAllowQuery, userAllowParams);
      if (userAllowRows[0].count > 0) {
        return true; // User allow always permits
      }
      
      // 3. Get user's groups
      const userQuery = `SELECT groupIds FROM kore_sys.users WHERE userId = ?`;
      const [userRows] = await this.korePool.execute(userQuery, [userId]);
      
      if (userRows.length === 0) {
        // User not found, use default logic
        const anyAllowQuery = `
          SELECT COUNT(*) as count 
          FROM kore_sys.permissions 
          WHERE resource = ? 
          AND ${actionCondition}
          AND effect = 'allow'
          AND (scope IS NULL ${scope ? `OR scope = ?` : ''})
          AND revokedAt IS NULL
        `;
        
        const anyAllowParams = [resource, action];
        if (scope) anyAllowParams.push(scope);
        
        const [anyAllowRows] = await this.korePool.execute(anyAllowQuery, anyAllowParams);
        return anyAllowRows[0].count === 0; // Default allow if no rules exist
      }
      
      let groupIds = [];
      if (userRows[0].groupIds) {
        try {
          groupIds = typeof userRows[0].groupIds === 'string' 
            ? JSON.parse(userRows[0].groupIds) 
            : userRows[0].groupIds;
        } catch (parseErr) {
          global.consoleLog('Auth', `Failed to parse groupIds for user ${userId}: ${parseErr.message}`, 2);
          groupIds = [];
        }
      }
      
      if (groupIds.length === 0) {
        // No groups, check default logic
        const anyAllowQuery = `
          SELECT COUNT(*) as count 
          FROM kore_sys.permissions 
          WHERE resource = ? 
          AND ${actionCondition}
          AND effect = 'allow'
          AND (scope IS NULL ${scope ? `OR scope = ?` : ''})
          AND revokedAt IS NULL
        `;
        
        const anyAllowParams = [resource, action];
        if (scope) anyAllowParams.push(scope);
        
        const [anyAllowRows] = await this.korePool.execute(anyAllowQuery, anyAllowParams);
        return anyAllowRows[0].count === 0; // Default allow if no rules exist
      }
      
      // 4. Check for GROUP DENY
      const groupDenyQuery = `
        SELECT COUNT(*) as count 
        FROM kore_sys.permissions 
        WHERE targetType = 'group' AND targetId IN (${groupIds.map(() => '?').join(',')})
        AND resource = ? 
        AND ${actionCondition}
        AND effect = 'deny'
        AND (scope IS NULL ${scope ? `OR scope = ?` : ''})
        AND revokedAt IS NULL
      `;
      
      const groupDenyParams = [...groupIds, resource, action];
      if (scope) groupDenyParams.push(scope);
      
      const [groupDenyRows] = await this.korePool.execute(groupDenyQuery, groupDenyParams);
      if (groupDenyRows[0].count > 0) {
        return false; // Group deny blocks
      }
      
      // 5. Check for GROUP ALLOW
      const groupAllowQuery = `
        SELECT COUNT(*) as count 
        FROM kore_sys.permissions 
        WHERE targetType = 'group' AND targetId IN (${groupIds.map(() => '?').join(',')})
        AND resource = ? 
        AND ${actionCondition}
        AND effect = 'allow'
        AND (scope IS NULL ${scope ? `OR scope = ?` : ''})
        AND revokedAt IS NULL
      `;
      
      const groupAllowParams = [...groupIds, resource, action];
      if (scope) groupAllowParams.push(scope);
      
      const [groupAllowRows] = await this.korePool.execute(groupAllowQuery, groupAllowParams);
      if (groupAllowRows[0].count > 0) {
        return true; // Group allow permits
      }
      
      // 6. Check default logic: if ANY allow rules exist, default is deny; otherwise allow
      const anyAllowQuery = `
        SELECT COUNT(*) as count 
        FROM kore_sys.permissions 
        WHERE resource = ? 
        AND ${actionCondition}
        AND effect = 'allow'
        AND (scope IS NULL ${scope ? `OR scope = ?` : ''})
        AND revokedAt IS NULL
      `;
      
      const anyAllowParams = [resource, action];
      if (scope) anyAllowParams.push(scope);
      
      const [anyAllowRows] = await this.korePool.execute(anyAllowQuery, anyAllowParams);
      return anyAllowRows[0].count === 0; // Default allow if no rules exist
      
    } catch (err) {
      global.consoleLog('Auth', `ERROR checking permission:: ${err.message}`, 1);
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
          global.consoleLog('Auth', `Parsed passwordHistory: ${JSON.stringify(passwordHistory)}`, 4);
        } catch (e) {
          global.consoleLog('Auth', `ERROR parsing passwordHistory: ${e.message}`, 1);
          passwordHistory = [];
        }
      } else {
        global.consoleLog('Auth', `No passwordHistory in user record`, 4);
      }
      
      // Ensure passwordHistory is a valid array
      if (!Array.isArray(passwordHistory)) {
        global.consoleLog('Auth', `passwordHistory is not an array, resetting to []`, 4);
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
      global.consoleLog('Auth', `passwordHistory after unshift: ${JSON.stringify(passwordHistory)}`, 4);
      
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
      
      global.consoleLog('Auth', `Password changed for user: ${user.email}`, 3);
      
      return { success: true };
    } catch (err) {
      global.consoleLog('Auth', `ERROR changing password:: ${err.message}`, 1);
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
        let userEmail = 'user@kore'; // fallback
        let body = '';
        
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = body ? JSON.parse(body) : {};
                
                // Case 1: Email provided directly (MFA reset)
                if (data.email) {
                    userEmail = data.email;
                }
                // Case 2: Token provided (initial setup) - look up email from token
                else if (data.token) {
                    const inviteTokenHash = crypto.createHash('sha256').update(data.token).digest('hex');
                    const [userRows] = await global.auth.korePool.execute(
                        'SELECT email FROM users WHERE inviteTokenHash = ?',
                        [inviteTokenHash]
                    );
                    if (userRows[0]) {
                        userEmail = userRows[0].email;
                    }
                }
                
                // Generate TOTP secret with actual user email
                const secret = global.auth.generateTOTPSecret(userEmail);
                const qrCode = await global.auth.generateQRCode(secret.otpauth_url);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    secret: secret.secret,
                    qrCode: qrCode
                }));
            } catch (err) {
                global.consoleLog('Auth', `ERROR generating TOTP:: ${err.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleGenerateTOTP:: ${err.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * HTTP Handlers for Auth endpoints
 */

/**
 * POST /auth/logout
 * Clear session and logout - delete refresh token from database
 */
async function handleLogout(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        const refreshToken = getRefreshTokenFromCookies(req.headers.cookie);
        
        if (refreshToken) {
            // Hash and delete the refresh token from the database
            const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
            await global.auth.korePool.execute(
                'DELETE FROM refresh_tokens WHERE refreshTokenHash = ?',
                [refreshTokenHash]
            );
            global.consoleLog('Auth', `Refresh token deleted for user logout`, 3);
        }
        
        // Clear both sessionToken and refreshToken cookies
        res.setHeader('Set-Cookie', [
            'sessionToken=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
            'refreshToken=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
        ]);
        
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Logged out' }));
    } catch (err) {
        global.consoleLog('Auth', `ERROR during logout:: ${err.message}`, 1);
        // Still clear cookies even if DB delete fails
        res.setHeader('Set-Cookie', [
            'sessionToken=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
            'refreshToken=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
        ]);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Logged out' }));
    }
}

/**
 * POST /auth/delete-oldest-session
 * Delete a specific old session by hash (called after user confirms login at capacity)
 */
async function handleDeleteOldestSession(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        // Validate session token to get userId
        const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        if (!sessionToken) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Not authenticated' }));
            return;
        }
        
        const validation = await global.auth.validateSessionToken(sessionToken);
        if (!validation.valid) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Invalid session' }));
            return;
        }
        
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { oldestSessionHash } = JSON.parse(body);
                
                if (!oldestSessionHash) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'oldestSessionHash required' }));
                    return;
                }
                
                // Delete the oldest session
                await global.auth.korePool.execute(
                    'DELETE FROM refresh_tokens WHERE userId = ? AND refreshTokenHash = ?',
                    [validation.userId, oldestSessionHash]
                );
                
                global.consoleLog('Auth', `Deleted oldest session for user: ${validation.userId}`, 3);
                
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, message: 'Oldest session deleted' }));
            } catch (err) {
                global.consoleLog('Auth', `ERROR deleting oldest session:: ${err.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleDeleteOldestSession:: ${err.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
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
        global.consoleLog('Auth', `Token Refresh: FAILED - ${err.message}`, 4);
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
                global.consoleLog('Auth', `ERROR in handleChangePassword:: ${err.message}`, 1);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleChangePassword:: ${err.message}`, 1);
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
    <link rel="icon" type="image/png" href="/img/favicon.png">
    <script type="module" src="/lib/base.js"></script>
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
            padding: 20px !important;
            background-color: var(--bg-primary) !important;
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
                
                <div class="form-group">
                    <label>MFA Code (6 digits)</label>
                    <input type="text" id="mfaCode" placeholder="000000" maxlength="6" pattern="[0-9]{6}" onkeypress="if(event.key==='Enter') handleLogin()">
                </div>
                
                <div id="loginError" class="error"></div>
                
                <div class="button-group">
                    <button class="btn" onclick="handleLogin()">Sign In</button>
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
            const mfaCode = document.getElementById('mfaCode').value;
            const errorDiv = document.getElementById('loginError');
            
            errorDiv.textContent = '';
            
            if (!email || !password || !mfaCode) {
                errorDiv.textContent = 'Email, password, and MFA code required';
                return;
            }
            
            try {
                const response = await fetch('/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, mfaCode })
                });
                
                const data = await response.json();
                
                console.log('Login response logged');
                
                if (!response.ok) {
                    // If MFA setup is required (account was reset)
                    if (data.error === 'MFA_RESET') {
                        errorDiv.textContent = 'MFA setup required. Redirecting...';
                        setTimeout(() => {
                            window.location.href = '/usersetup?email=' + encodeURIComponent(email);
                        }, 1500);
                        return;
                    }
                    
                    errorDiv.textContent = data.error || 'Login failed';
                    return;
                }
                

                // Check if password change is required
                if (data.requiresPasswordChange) {
                    // Check if we're about to exceed session limit
                    if (data.willExceedLimit && data.oldestSessionHash) {
                        const message = "You currently have " + data.activeSessions + " session(s) active.\\nYour maximum is " + data.maxSessions + ".\\n\\nProceeding will eliminate your oldest session.\\n\\nContinue?";
                        
                        if (!confirm(message)) {
                            errorDiv.textContent = 'Login cancelled. New session was not activated.';
                            // Logout to delete the tokens we just created
                            fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
                            return;
                        }
                        
                        // User confirmed - delete the oldest session
                        try {
                            await fetch('/auth/delete-oldest-session', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ oldestSessionHash: data.oldestSessionHash }),
                                credentials: 'include'
                            });
                        } catch (err) {
                            console.log('Error deleting oldest session');
                        }
                    }
                    
                    currentEmail = email;
                    currentPassword = password;
                    document.getElementById('loginStep').style.display = 'none';
                    document.getElementById('passwordChangeStep').classList.add('active');
                    document.getElementById('currentPassword').focus();
                    return;
                }
                
                currentEmail = email;
                currentPassword = password;
                
                // No MFA required, login is complete
                if (data.userId) {
                    localStorage.setItem('kore_userId', data.userId);
                }
                    
                    // Check if we're about to exceed session limit - prompt BEFORE it happens
                    if (data.willExceedLimit && data.oldestSessionHash) {
                        const title = "Session Limit Exceeded";
                        const message = "You currently have " + data.activeSessions + " session(s) active. Your maximum is " + data.maxSessions + ". Proceeding will eliminate your oldest session.";
                        
                        showConfirm(title, message, async () => {
                            // User confirmed - delete the oldest session
                            try {
                                const deleteResponse = await fetch('/auth/delete-oldest-session', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ oldestSessionHash: data.oldestSessionHash }),
                                    credentials: 'include'
                                });
                                
                                if (!deleteResponse.ok) {
                                    console.log('Failed to delete oldest session, but proceeding anyway');
                                }
                            } catch (err) {
                                console.log('Error deleting oldest session');
                            }
                            
                            // Proceed to redirect
                            const urlParams = new URLSearchParams(window.location.search);
                            const redirectUrl = urlParams.get('redirect');
                            
                            if (redirectUrl) {
                                window.location.href = redirectUrl;
                            } else {
                                window.location.href = '/';
                            }
                        }, "Continue");
                        return;  // Don't redirect yet - wait for user choice
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
                
                // Check if we're about to exceed session limit - prompt BEFORE redirecting
                if (data.willExceedLimit && data.oldestSessionHash) {
                    const title = "Session Limit Exceeded";
                    const message = "You currently have " + data.activeSessions + " session(s) active. Your maximum is " + data.maxSessions + ". Proceeding will eliminate your oldest session.";
                    
                    showConfirm(title, message, async () => {
                        // User confirmed - delete the oldest session
                        try {
                            const deleteResponse = await fetch('/auth/delete-oldest-session', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ oldestSessionHash: data.oldestSessionHash }),
                                credentials: 'include'
                            });
                            
                            if (!deleteResponse.ok) {
                                console.log('Failed to delete oldest session, but proceeding anyway');
                            }
                        } catch (err) {
                            console.log('Error deleting oldest session');
                        }
                        
                        // Proceed to redirect
                        const urlParams = new URLSearchParams(window.location.search);
                        const redirectUrl = urlParams.get('redirect');
                        
                        if (redirectUrl) {
                            window.location.href = redirectUrl;
                        } else {
                            window.location.href = '/';
                        }
                    }, "Continue");
                    return;  // Don't redirect yet - wait for user choice
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
            document.getElementById('passwordChangeError').textContent = '';
            
            document.getElementById('loginStep').style.display = 'block';
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
                let sessionToken = null;
                
                // Try to get token from request body first
                if (body) {
                    try {
                        const parsed = JSON.parse(body);
                        sessionToken = parsed.sessionToken;
                    } catch (parseErr) {
                        // Body parsing failed, will try cookies
                    }
                }
                
                // If no token in body, try to get from cookies
                if (!sessionToken) {
                    sessionToken = getSessionTokenFromCookies(req.headers.cookie);
                }
                
                if (!sessionToken) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Session token required' }));
                    return;
                }
                
                const result = await global.auth.validateSessionToken(sessionToken);
                
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (err) {
                global.consoleLog('Auth', `ERROR validating token:: ${err.message}`, 1);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleValidateSessionToken:: ${err.message}`, 1);
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
                global.consoleLog('Auth', `ERROR in resetMFA:: ${err.message}`, 1);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleAdminResetMFA:: ${err.message}`, 1);
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
                global.consoleLog('Auth', `ERROR in unlockUser:: ${err.message}`, 1);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleAdminUnlockUser:: ${err.message}`, 1);
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
        // Extract client information
        const userAgent = req.headers['user-agent'] || null;
        const ipAddress = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                         req.socket?.remoteAddress || 
                         req.connection?.remoteAddress || 
                         null;
        
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
                
                const result = await global.auth.login(email, password, mfaCode, userAgent, ipAddress);
                
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
                      global.consoleLog('Auth', `Password expired for user: ${email} (age: ${Math.floor(ageDays)} days, limit: ${passwordExpiration} days)`, 3);
                      
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
                          activeSessions: result.activeSessions,
                          maxSessions: result.maxSessions,
                          willExceedLimit: result.willExceedLimit,
                          oldestSessionHash: result.oldestSessionHash,
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
                    refreshToken: result.refreshToken,
                    activeSessions: result.activeSessions,
                    maxSessions: result.maxSessions,
                    willExceedLimit: result.willExceedLimit,
                    oldestSessionHash: result.oldestSessionHash
                }));
            } catch (err) {
                // MFA code required is a warning, not an error
                const logLevel = err.message === 'MFA code required' ? 2 : 1;
                global.consoleLog('Auth', `ERROR in login:: ${err.message}`, logLevel);
                
                // Special case: MFA is required - return 200 with requiresMFA flag
                if (err.message === 'MFA code required') {
                    res.writeHead(200);
                    res.end(JSON.stringify({ 
                        requiresMFA: true,
                        message: 'MFA code required'
                    }));
                    return;
                }
                
                res.writeHead(401);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleLogin:: ${err.message}`, 1);
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
        const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        const validation = validateUserSessionToken(sessionToken);

        if (!validation.valid) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

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
                
                const result = await global.auth.createUser(email, fullName, validation.userId);
                
                // Send invite email
                await global.auth.sendInviteEmail(result.userId, email, fullName);
                
                res.writeHead(201);
                res.end(JSON.stringify({
                    success: true,
                    userId: result.userId,
                    message: 'User created and invite sent'
                }));
            } catch (err) {
                global.consoleLog('Auth', `ERROR creating user:: ${err.message}`, 1);
                
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
        global.consoleLog('Auth', `ERROR in handleCreateUser:: ${err.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * POST /users/:id/send-invite
 * Admin sends/resends invite to user
 */
async function handleSendInvite(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        const urlParts = req.url.split('/');
        const userId = urlParts[2];
        
        const result = await global.auth.resendInvite(userId);
        
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            message: 'Invite sent successfully',
            inviteExpiresAt: result.inviteExpiresAt
        }));
    } catch (err) {
        global.consoleLog('Auth', `ERROR sending invite:: ${err.message}`, 1);
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
                global.consoleLog('Auth', `ERROR updating user:: ${err.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleUpdateUser:: ${err.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * POST /groups
 * Create a new group
 */
async function handleCreateGroup(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        const validation = validateUserSessionToken(sessionToken);

        if (!validation.valid) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { groupName, description } = JSON.parse(body);
                
                if (!groupName) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Group name required' }));
                    return;
                }
                
                const result = await global.auth.createGroup(groupName, description, validation.userId);
                
                res.writeHead(201);
                res.end(JSON.stringify({
                    success: true,
                    groupId: result.groupId,
                    groupName: result.groupName,
                    description: result.description
                }));
            } catch (err) {
                global.consoleLog('Auth', `ERROR creating group:: ${err.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleCreateGroup:: ${err.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * PUT /groups/:id
 * Update group details (groupName, description, active)
 */
async function handleUpdateGroup(req, res, groupId) {
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
                const { groupName, description, active } = data;
                
                if (!groupName) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Group name is required' }));
                    return;
                }
                
                const result = await global.auth.updateGroup(groupId, groupName, description, active, null);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: 'Group updated successfully'
                }));
            } catch (err) {
                global.consoleLog('Auth', `ERROR updating group:: ${err.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleUpdateGroup:: ${err.message}`, 1);
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
        
        // If it's a new invite (has token), validate the token upfront
        if (token) {
            const validation = await global.auth.validateInviteToken(token);
            if (!validation.valid) {
                res.writeHead(400);
                res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kore Setup</title>
    <link rel="icon" type="image/png" href="/img/favicon.png">
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
        
        .error-heading {
            text-align: center;
            color: #dc3545;
        }
    </style>
    <script>
        // Inject base_css.js component styles
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
            
            <div class="step active">
                <h2 class="error-heading">Invite Expired</h2>
                <div class="form-group">
                    <p style="color: var(--text-muted); font-size: 12px; line-height: 1.5; margin: 15px 0;">
                        Invite token has expired. Please contact your administrator for a new invitation.
                    </p>
                </div>
            </div>
        </div>
    </div>
</body>
</html>
                `);
                return;
            }
        }
        
        res.writeHead(200);
        res.end(getSetupFormHTML(token || '', email || ''));
    } catch (err) {
        global.consoleLog('Auth', `ERROR rendering setup form:: ${err.message}`, 1);
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
                global.consoleLog('Auth', `ERROR in MFA reset:: ${err.message}`, 1);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleMFAResetComplete:: ${err.message}`, 1);
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
                global.consoleLog('Auth', `ERROR completing setup:: ${err.message}`, 1);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleCompleteSetup:: ${err.message}`, 1);
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
    <link rel="icon" type="image/png" href="/img/favicon.png">
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
        // Inject base_css.js component styles
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
                <label style="display: block; margin-bottom: 10px; font-size: 12px; color: var(--text-muted); font-weight: 500;">Scan QR Code</label>
                <div id="qrCodeContainer" style="display: flex; justify-content: center; margin-bottom: 15px;">
                    <img id="qrCode" src="" alt="QR Code" style="width: 200px; height: 200px; border: 1px solid #314a59; border-radius: 6px; background-color: #172035;">
                </div>
                <label style="display: block; margin-bottom: 10px; font-size: 12px; color: var(--text-muted); font-weight: 500;">Or enter Secret Key manually</label>
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
                <div style="display: flex; justify-content: center; margin-top: 25px;">
                    <div style="background-color: white; border-radius: 100px; border: 2px solid var(--brand-light); padding: 10px 25px; display: flex; justify-content: center; align-items: center;">
                        <a href="#" onclick="showBackupCodesConfirmation(); return false;" style="color: var(--brand-light); text-decoration: none; font-size: 13px; font-weight: 900;">Proceed to Kore</a>
                    </div>
                </div>
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
            const payload = {};
            
            // For MFA reset, we have the email
            if (isMFAReset && email) {
                payload.email = email;
            }
            // For initial setup, we have the token
            else if (token) {
                payload.token = token;
            }
            
            const response = await fetch('/auth/generate-totp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            totpSecret = data.secret;
            
            // Display secret key
            document.getElementById('secretCode').textContent = totpSecret;
            
            // Display QR code if available
            if (data.qrCode) {
                document.getElementById('qrCode').src = data.qrCode;
            }
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
        
        function showBackupCodesConfirmation() {
            const confirmed = confirm('Please confirm you have copied your backup codes to a safe location');
            if (confirmed) {
                // Redirect to main app
                window.location.href = '/';
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
/**
 * Handle GET /kore/page-permissions - retrieve all page permissions
 */
async function handleGetPagePermissions(req, res) {
  try {
    // Verify user is authenticated and has permission
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);
    
    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Check if user has permission to view page permissions
    const hasPermission = await global.auth.hasPermission(validation.userId, 'permissions', 'view', 'all');
    
    if (!hasPermission) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    // Query page permissions
    const query = `
      SELECT 
        wp.id, wp.title, wp.path,
        p.permissionId, p.targetType, p.targetId, p.action, p.effect, p.scope, p.grantedAt, p.grantedBy,
        CASE 
          WHEN p.targetType = 'group' THEN ug.name
          WHEN p.targetType = 'user' THEN u.fullName
          ELSE NULL
        END as targetName
      FROM kore_sys.web_pages wp
      LEFT JOIN kore_sys.permissions p ON p.resource = 'page' AND p.scope = wp.path
      LEFT JOIN kore_sys.user_groups ug ON p.targetType = 'group' AND ug.groupId = p.targetId
      LEFT JOIN kore_sys.users u ON p.targetType = 'user' AND u.userId = p.targetId
      WHERE wp.path NOT IN ('BASE', '/notfound', '/forbidden')
        AND wp.active = TRUE
      ORDER BY wp.path, p.grantedAt DESC
    `;

    const connection = await global.auth.korePool.getConnection();
    try {
      const [rows] = await connection.execute(query);

      // Transform flat results into nested structure
      const pagePermissions = {};

      for (const row of rows) {
        const pagePath = row.path;

        // Initialize page if not exists
        if (!pagePermissions[pagePath]) {
          pagePermissions[pagePath] = {
            id: row.id,
            title: row.title,
            path: row.path,
            permissions: []
          };
        }

        // Add permission if it exists
        if (row.permissionId) {
          pagePermissions[pagePath].permissions.push({
            permissionId: row.permissionId,
            targetType: row.targetType,
            targetId: row.targetId,
            targetName: row.targetName,
            action: row.action,
            effect: row.effect,
            scope: row.scope,
            grantedAt: row.grantedAt,
            grantedBy: row.grantedBy
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pagePermissions, null, 2));

    } finally {
      connection.release();
    }

  } catch (error) {
    global.consoleLog('Auth', `Error getting page permissions: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Handle PUT /kore/permissions - batch update permissions (generic for any resource)
 */
async function handleUpdatePermissions(req, res) {
  global.consoleLog('Auth', `handleUpdatePermissions called for: ${req.url}`, 4);
  try {
    // Verify user is authenticated
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);
    
    global.consoleLog('Auth', `Token validation: ${validation.valid ? 'valid' : 'invalid'}`, 4);
    
    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Check permission
    const hasPermission = await global.auth.hasPermission(validation.userId, 'permissions', 'view', 'all');
    global.consoleLog('Auth', `Permission check: ${hasPermission}`, 4);
    
    if (!hasPermission) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    // Parse request body
    let payload = '';
    req.on('data', chunk => {
      payload += chunk.toString();
    });

    req.on('end', async () => {
      try {
        global.consoleLog('Auth', `Raw payload: ${JSON.stringify(payload)}`, 4);
        const { resource, inserts, updates, deletes } = JSON.parse(payload);
        global.consoleLog('Auth', `Parsed request - resource: ${resource} inserts: ${inserts?.length} updates: ${updates?.length} deletes: ${deletes?.length}`, 4);

        if (!resource) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing resource type' }));
          return;
        }

        const connection = await global.auth.korePool.getConnection();
        try {
          await connection.beginTransaction();

          // Process deletes/revokes
          if (deletes && deletes.length > 0) {
            global.consoleLog('Auth', `Processing ${deletes.length} deletes`, 4);
            for (const permissionId of deletes) {
              await connection.execute(
                'UPDATE kore_sys.permissions SET revokedAt = NOW(), revokedBy = ? WHERE permissionId = ?',
                [validation.userId, permissionId]
              );
            }
          }

          // Process inserts and updates
          if (inserts && inserts.length > 0) {
            global.consoleLog('Auth', `Processing ${inserts.length} inserts`, 4);
            for (const perm of inserts) {
              await connection.execute(
                'INSERT INTO kore_sys.permissions (targetType, targetId, resource, action, effect, scope, grantedAt, grantedBy) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)',
                [perm.targetType, perm.targetId, resource, perm.action || 'view', perm.effect, perm.scope, validation.userId]
              );
            }
          }

          if (updates && updates.length > 0) {
            global.consoleLog('Auth', `Processing ${updates.length} updates`, 4);
            for (const perm of updates) {
              // Build dynamic UPDATE query based on what fields are being changed
              const updateFields = [];
              const updateParams = [];
              
              // Check which fields are present and add them to the update
              if (perm.targetType !== undefined) {
                updateFields.push('targetType = ?');
                updateParams.push(perm.targetType);
              }
              if (perm.targetId !== undefined) {
                updateFields.push('targetId = ?');
                updateParams.push(perm.targetId);
              }
              if (perm.resource !== undefined) {
                updateFields.push('resource = ?');
                updateParams.push(perm.resource);
              }
              if (perm.scope !== undefined) {
                updateFields.push('scope = ?');
                updateParams.push(perm.scope);
              }
              if (perm.action !== undefined) {
                updateFields.push('action = ?');
                updateParams.push(perm.action);
              }
              if (perm.effect !== undefined) {
                updateFields.push('effect = ?');
                updateParams.push(perm.effect);
              }
              if (perm.revokedBy !== undefined) {
                updateFields.push('revokedBy = ?');
                updateParams.push(perm.revokedBy);
                // If revoking, also set revokedAt
                if (perm.revokedBy && !perm.revokedAt) {
                  updateFields.push('revokedAt = NOW()');
                }
              }
              
              if (updateFields.length === 0) {
                global.consoleLog('Auth', `No fields to update for permission: ${perm.permissionId}`, 4);
                continue;
              }

              // Add the WHERE clause parameters
              updateParams.push(perm.permissionId);
              updateParams.push(resource);

              const updateQuery = `UPDATE kore_sys.permissions SET ${updateFields.join(', ')} WHERE permissionId = ? AND resource = ?`;
              global.consoleLog('Auth', `Updating permission: ${perm.permissionId} with query: ${updateQuery}`, 4);
              
              const result = await connection.execute(updateQuery, updateParams);
              global.consoleLog('Auth', `Update result: ${JSON.stringify(result[0])}`, 4);
            }
          }

          await connection.commit();
          global.consoleLog('Auth', `Transaction committed successfully`, 4);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Permissions updated' }));

        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }

      } catch (error) {
        global.consoleLog('Auth', `Error updating permissions: ${error.message}`, 1);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });

  } catch (error) {
    global.consoleLog('Auth', `Error handling permissions update: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Handle GET /kore/users/:userId/permissions - get all permissions for a user (direct + group)
 */
async function handleGetUserPermissions(req, res) {
  try {
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);

    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const hasPermission = await global.auth.hasPermission(validation.userId, 'permissions', 'view', 'all');
    if (!hasPermission) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    const userId = req.url.split('/')[3];
    const urlObj = new URL(req.url, 'http://localhost');
    const includeRevoked = urlObj.searchParams.get('includeRevoked') === 'true';

    const permissions = await global.auth.getUserPermissions(userId, includeRevoked);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(permissions));

  } catch (error) {
    global.consoleLog('Auth', `Error handling get user permissions: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Handle POST /kore/permissions - query permissions with flexible filters
 */
async function handleGetPermissionsQuery(req, res) {
  try {
    // Verify user is authenticated
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);
    
    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Check permission to view permissions
    const hasPermission = await global.auth.hasPermission(validation.userId, 'permissions', 'view', 'all');
    
    if (!hasPermission) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    // Parse request body
    let payload = '';
    req.on('data', chunk => {
      payload += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const filters = JSON.parse(payload || '{}');

        // Query permissions with the provided filters
        const permissions = await global.auth.getPermissions(filters);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(permissions, null, 2));

      } catch (error) {
        global.consoleLog('Auth', `Error querying permissions: ${error.message}`, 1);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });

  } catch (error) {
    global.consoleLog('Auth', `Error handling permissions query: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Handle GET /kore/whitelists - Get available whitelist categories
 */
async function handleGetWhitelists(req, res) {
  try {
    const query = `SELECT whitelists FROM kore_sys.system_config LIMIT 1`;
    const [rows] = await global.auth.korePool.execute(query);

    let categories = [];
    if (rows.length > 0 && rows[0].whitelists) {
      try {
        const whitelists = typeof rows[0].whitelists === 'string' 
          ? JSON.parse(rows[0].whitelists) 
          : rows[0].whitelists;
        
        // Extract the category names from the whitelist object
        if (typeof whitelists === 'object' && whitelists !== null) {
          categories = Object.keys(whitelists);
        }
      } catch (parseErr) {
        global.consoleLog('Auth', `Failed to parse whitelists: ${parseErr.message}`, 2);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ whitelists: categories }));

  } catch (error) {
    global.consoleLog('Auth', `Error getting whitelists: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Handle GET /kore/allowed-ips - Get allowedIPs for a resource
 * Query params: table, idColumn, id
 * Example: /kore/allowed-ips?table=web_pages&idColumn=path&id=/workflows
 */
async function handleGetAllowedIPs(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const table = url.searchParams.get('table');
    const idColumn = url.searchParams.get('idColumn');
    const id = url.searchParams.get('id');

    // Validate required parameters
    if (!table || !idColumn || !id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'table, idColumn, and id are required' }));
      return;
    }

    // Whitelist allowed tables to prevent SQL injection
    const allowedTables = {
      'web_pages': ['path', 'id'],
      'workflows': ['workflowId', 'id'],
      'forms': ['formId', 'id'],
      // Add more as needed
    };

    if (!allowedTables[table]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Table '${table}' is not allowed` }));
      return;
    }

    if (!allowedTables[table].includes(idColumn)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Column '${idColumn}' is not allowed for table '${table}'` }));
      return;
    }

    // Query the table for allowedIPs
    const query = `SELECT allowedIPs FROM kore_sys.${table} WHERE ${idColumn} = ?`;
    const [rows] = await global.auth.korePool.execute(query, [id]);

    if (rows.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Resource not found in ${table}` }));
      return;
    }

    const allowedIPs = rows[0].allowedIPs;
    let parsedIPs = [];
    
    if (allowedIPs) {
      try {
        parsedIPs = typeof allowedIPs === 'string' ? JSON.parse(allowedIPs) : allowedIPs;
      } catch (e) {
        parsedIPs = allowedIPs; // Return as-is if not JSON
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ allowedIPs: parsedIPs }));

  } catch (error) {
    global.consoleLog('Auth', `Error getting allowed IPs: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Handle PUT /kore/allowed-ips - Update allowedIPs for a resource
 * Body: {table, idColumn, id, allowedIPs}
 */
async function handleSaveAllowedIPs(req, res) {
  try {
    let payload = '';
    req.on('data', chunk => {
      payload += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const { table, idColumn, id, allowedIPs } = JSON.parse(payload);

        // Validate required parameters
        if (!table || !idColumn || !id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'table, idColumn, and id are required' }));
          return;
        }

        // Whitelist allowed tables to prevent SQL injection
        const allowedTables = {
          'web_pages': ['path', 'id'],
          'workflows': ['workflowId', 'id'],
          'forms': ['formId', 'id'],
          // Add more as needed
        };

        if (!allowedTables[table]) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Table '${table}' is not allowed` }));
          return;
        }

        if (!allowedTables[table].includes(idColumn)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Column '${idColumn}' is not allowed for table '${table}'` }));
          return;
        }

        // Serialize allowedIPs if it's an array
        const serializedIPs = Array.isArray(allowedIPs) ? JSON.stringify(allowedIPs) : allowedIPs;

        // Update the table
        const query = `UPDATE kore_sys.${table} SET allowedIPs = ? WHERE ${idColumn} = ?`;
        const [result] = await global.auth.korePool.execute(query, [serializedIPs, id]);

        if (result.affectedRows === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Resource not found in ${table}` }));
          return;
        }

        global.consoleLog('Auth', `Updated allowedIPs for ${table}.${idColumn} = ${id}`, 4);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'allowedIPs updated successfully' }));

      } catch (error) {
        global.consoleLog('Auth', `Error saving allowed IPs: ${error.message}`, 1);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });

  } catch (error) {
    global.consoleLog('Auth', `Error handling save allowed-ips request: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Handle POST /kore/has-permission - check if user has permission
 * Required: userId
 * One-of required: permissionId OR resource
 * If resource: action is required, scope is optional
 * If permissionId: all other inputs are ignored
 */
async function handleHasPermission(req, res) {
  try {
    let payload = '';
    req.on('data', chunk => {
      payload += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const { userId, permissionId, resource, action, scope } = JSON.parse(payload);

        // Validate required userId
        if (!userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'userId is required' }));
          return;
        }

        let hasPermission = false;

        // If permissionId provided, check if it exists and belongs to user
        if (permissionId) {
          global.consoleLog('Auth', `Checking permissionId: ${permissionId} for user: ${userId}`, 4);
          const permissions = await global.auth.getPermissions({ permissionId });
          
          if (permissions.length > 0) {
            const perm = permissions[0];
            // Check if permission applies to user (directly or via group)
            if (perm.targetType === 'user' && perm.targetId === userId) {
              hasPermission = perm.effect === 'allow';
            } else if (perm.targetType === 'group') {
              // Check if user is in the group
              const userGroups = await global.auth.getUserGroups(userId);
              hasPermission = userGroups.includes(perm.targetId) && perm.effect === 'allow';
            }
          }
        } 
        // If resource provided, check permission
        else if (resource) {
          if (!action) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'action is required when resource is provided' }));
            return;
          }

          // Convert scope "*" to null (matches permissions with NULL scope = applies to all)
          const checkScope = (scope === '*') ? null : (scope || null);
          
          // Convert action "*" to check for full control (action="*" in database)
          const checkAction = action;
          
          global.consoleLog('Auth', `Checking permission for user: ${userId} resource: ${resource} action: ${checkAction} scope: ${checkScope}`, 4);
          
          // For page resources, check IP whitelist first (hard gate)
          if (resource === 'page' && checkScope) {
            try {
              const clientIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                               req.socket?.remoteAddress || 
                               req.connection?.remoteAddress || 
                               'unknown';
              
              global.consoleLog('Auth', `Page resource detected, checking IP whitelist for: ${clientIP} on page: ${checkScope}`, 4);
              
              // Query the web_pages table for allowedIPs
              const pageQuery = `SELECT allowedIPs FROM kore_sys.web_pages WHERE path = ? AND active = TRUE`;
              const [pageRows] = await global.auth.korePool.execute(pageQuery, [checkScope]);
              
              if (pageRows.length > 0 && pageRows[0].allowedIPs) {
                const ipAllowed = await global.auth.isIPAllowed(clientIP, pageRows[0].allowedIPs);
                global.consoleLog('Auth', `IP check result for ${clientIP}: ${ipAllowed}`, 4);
                
                if (!ipAllowed) {
                  global.consoleLog('Auth', `IP check failed for ${clientIP} on page: ${checkScope}`, 4);
                  hasPermission = false;
                  // Return early since IP check is a hard gate
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ hasPermission }));
                  return;
                }
              }
            } catch (ipCheckError) {
              global.consoleLog('Auth', `Error during IP check for page: ${ipCheckError.message}`, 1);
              // If IP check fails unexpectedly, deny access
              hasPermission = false;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ hasPermission }));
              return;
            }
          }
          
          // IP check passed (or not applicable), proceed with user/group permission check
          hasPermission = await global.auth.hasPermission(userId, resource, checkAction, checkScope);
        }
        // Missing both permissionId and resource
        else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Either permissionId or resource is required' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hasPermission }));

      } catch (error) {
        global.consoleLog('Auth', `Error checking permission: ${error.message}`, 1);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });

  } catch (error) {
    global.consoleLog('Auth', `Error handling has-permission request: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

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
    } else if (req.method === 'POST' && req.url === '/auth/delete-oldest-session') {
        handleDeleteOldestSession(req, res);
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
    } else if (req.method === 'POST' && req.url.match(/^\/admin\/users\/[a-fA-F0-9-]+\/reset-mfa$/)) {
        const userId = req.url.split('/')[3];
        handleAdminResetMFA(req, res, userId);
        return true;
    } else if (req.method === 'POST' && req.url.match(/^\/admin\/users\/[a-fA-F0-9-]+\/unlock$/)) {
        const userId = req.url.split('/')[3];
        handleAdminUnlockUser(req, res, userId);
        return true;
    } else if (req.method === 'POST' && req.url === '/users') {
        handleCreateUser(req, res);
        return true;
    } else if (req.method === 'POST' && req.url.match(/^\/users\/[a-fA-F0-9-]+\/send-invite$/)) {
        handleSendInvite(req, res);
        return true;
    } else if (req.method === 'PUT' && req.url.match(/^\/users\/[a-fA-F0-9-]+$/)) {
        const userId = req.url.split('/')[2];
        handleUpdateUser(req, res, userId);
        return true;
    } else if (req.method === 'POST' && req.url === '/groups') {
        handleCreateGroup(req, res);
        return true;
    } else if (req.method === 'PUT' && req.url.match(/^\/groups\/[a-fA-F0-9-]+$/)) {
        const groupId = req.url.split('/')[2];
        handleUpdateGroup(req, res, groupId);
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
    } else if (req.method === 'GET' && req.url === '/kore/page-permissions') {
        handleGetPagePermissions(req, res);
        return true;
    } else if (req.method === 'PUT' && req.url === '/kore/permissions') {
        handleUpdatePermissions(req, res);
        return true;
    } else if (req.method === 'GET' && req.url.match(/^\/kore\/users\/[a-fA-F0-9-]+\/permissions(\?.*)?$/)) {
        handleGetUserPermissions(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/kore/permissions') {
        handleGetPermissionsQuery(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/kore/has-permission') {
        handleHasPermission(req, res);
        return true;
    } else if (req.method === 'GET' && req.url === '/kore/whitelists') {
        handleGetWhitelists(req, res);
        return true;
    } else if (req.method === 'GET' && req.url.startsWith('/kore/allowed-ips')) {
        handleGetAllowedIPs(req, res);
        return true;
    } else if (req.method === 'PUT' && req.url === '/kore/allowed-ips') {
        handleSaveAllowedIPs(req, res);
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