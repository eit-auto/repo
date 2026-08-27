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

/**
 * Same 6-char lowercase-alphanumeric convention as resources.js's
 * generateId() (docs/workflows) - kept as a local copy rather than a
 * shared import since auth.js and resources.js don't currently share a
 * utils module for this. Used by createEntity() for new user/group ids,
 * replacing crypto.randomUUID(). NOTE: several route-matching regexes in
 * this file ([a-zA-Z0-9-]+) were widened specifically to keep matching
 * both this format and pre-existing UUID-format ids already in the DB -
 * see the /users/:id, /groups/:id, and related admin routes below. If a
 * narrower character set is ever used here, those regexes don't need to
 * shrink back (they're already permissive enough), but a WIDER one would
 * need those regexes revisited again.
 */
function generateId(prefix = '') {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = prefix ? prefix + '-' : '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

/**
 * Maps a resource type to the "admin" action that counts as being allowed
 * to manage that resource's own permissions (see Auth.canManagePermissionsFor
 * below), without needing the blanket 'permissions'/'view'/'all' grant.
 *
 * 'menu' -> 'admin' mirrors the resources.js User Menus admin editor, whose
 * own content-editing gate is hasPermission(userId, 'menu', 'admin', null).
 * Add one entry here for each future resource-scoped admin editor (e.g.
 * workflows, forms) - no endpoint changes needed elsewhere.
 */
const RESOURCE_PERMISSION_ADMIN_ACTIONS = {
  menu: 'admin'
};

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

      const id = generateId();
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

      if (entityType === 'group') {
        this.invalidateGroupsCache();
      }
      
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
      if ((entityType === 'user' || entityType === 'group') && fields.groupIds) {
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

      // A group's own groupIds (its parents, for nested-group support - see
      // hasPermission()) just changed, or the group's active state did -
      // either way, the cached parent-graph hasPermission() relies on is
      // now stale. Gated to entityType === 'group' since a user update has
      // nothing to do with this cache.
      if (entityType === 'group') {
        this.invalidateGroupsCache();
      }
      
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
  async updateGroup(groupId, groupName, description, active, groupIds, updatedBy) {
    return this.updateEntity('group', groupId, { groupName, description, active, groupIds }, updatedBy);
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
  async login(email, password, mfaCode, userAgent = null, ipAddress = null, existingRefreshToken = null) {
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
      const maxSessions = this.config.session?.maxConcurrentSessions || 2;

      let refreshToken;
      let activeSessions = 0;
      let willExceedLimit = false;
      let oldestSessionHash = null;
      let matchedExistingSession = false;

      // If the browser already presents a valid, unexpired refresh token for this
      // user, treat this as the same browser reconnecting: rotate that existing
      // row in place instead of inserting a new one. This keeps repeat logins
      // from the same device from ever counting against the concurrent-session
      // limit or piling up stale rows.
      if (existingRefreshToken) {
        const existingHash = crypto.createHash('sha256').update(existingRefreshToken).digest('hex');
        const [existingRows] = await this.korePool.execute(
          'SELECT refreshTokenId FROM refresh_tokens WHERE userId = ? AND refreshTokenHash = ? AND expiresAt > NOW()',
          [user.userId, existingHash]
        );

        if (existingRows[0]) {
          matchedExistingSession = true;
          const generated = this.generateRefreshToken(user.userId);
          refreshToken = generated.token;

          await this.korePool.execute(
            'UPDATE refresh_tokens SET refreshTokenHash = ?, userAgent = ?, ipAddress = ?, lastUsedAt = NOW(), expiresAt = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE refreshTokenId = ?',
            [generated.hash, userAgent || null, ipAddress || null, this.config.session.reloginTokenExpiryDays, existingRows[0].refreshTokenId]
          );

          global.consoleLog('Auth', `Recognized existing session for user, refreshed in place: ${email}`, 3);
        }
      }

      if (!matchedExistingSession) {
        const generated = this.generateRefreshToken(user.userId);
        refreshToken = generated.token;

        // Check session limit and manage concurrent sessions.
        // Only count sessions that haven't expired - an expired row should
        // never count against the limit even if it hasn't been cleaned up yet.
        const [sessionRows] = await this.korePool.execute(
          'SELECT refreshTokenHash, lastUsedAt FROM refresh_tokens WHERE userId = ? AND expiresAt > NOW() ORDER BY lastUsedAt ASC',
          [user.userId]
        );

        activeSessions = sessionRows.length;
        willExceedLimit = activeSessions >= maxSessions;

        // Note which session would be deleted, but don't delete yet
        if (willExceedLimit && sessionRows.length > 0) {
          oldestSessionHash = sessionRows[0].refreshTokenHash;
        }

        // Only insert new refresh token (don't delete yet - wait for client confirmation)
        const refreshTokenId = crypto.randomUUID();
        await this.korePool.execute(
          'INSERT INTO refresh_tokens (refreshTokenId, userId, refreshTokenHash, userAgent, ipAddress, createdAt, lastUsedAt, expiresAt) VALUES (?, ?, ?, ?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))',
          [refreshTokenId, user.userId, generated.hash, userAgent || null, ipAddress || null, this.config.session.reloginTokenExpiryDays]
        );
      }

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
      if (!groupIds) return [];
      // mysql2 can return a native JSON column already parsed into a real
      // array/object, not a string - unconditionally calling JSON.parse()
      // on that coerces it to a string first (String(['a']) -> "a") and
      // then fails to parse that as JSON. Handle both shapes.
      if (Array.isArray(groupIds)) return groupIds;
      if (typeof groupIds === 'string') {
        try { return JSON.parse(groupIds); } catch { return []; }
      }
      return [];
    } catch (err) {
      global.consoleLog('Auth', `ERROR getting user groups:: ${err.message}`, 1);
      return [];
    }
  }

  /**
   * Nested group support for hasPermission(). kore_sys.user_groups.groupIds
   * (same shape/name as users.groupIds - an array of parent group ids
   * this group inherits from, e.g. ["pht0hl","1ertj5"]) makes the groups
   * table itself a graph, not a flat list - a group's own membership
   * grants come from whatever it's nested under, same as a user's do from
   * their direct groups.
   *
   * Cached: this table is small and changes rarely, and hasPermission()
   * is on the hot path for nearly every request, so re-fetching every
   * group's parent list on every permission check would be wasteful.
   * TTL below is a safety-net fallback only - the real invalidation path
   * is invalidateGroupsCache(), which the single group-management surface
   * this app has must call after any create/update/delete on
   * kore_sys.user_groups. Until that call is wired in on that end, edits to a
   * group's own nesting take up to GROUPS_CACHE_TTL_MS to be reflected
   * here rather than being immediate.
   */
  static GROUPS_CACHE_TTL_MS = 5 * 60 * 1000;

  async _loadGroupsParentMap() {
    const now = Date.now();
    if (this._groupsCache && now < this._groupsCacheExpiry) {
      return this._groupsCache;
    }

    const [rows] = await this.korePool.execute(
      `SELECT groupId, groupIds FROM kore_sys.user_groups WHERE active = 1`
    );

    const map = new Map(); // groupId -> [parentGroupId, ...]
    for (const row of rows) {
      let parents = [];
      // Same already-parsed-array issue as getUserGroups() above - mysql2
      // can hand back a native JSON column already deserialized, not a
      // string. This was previously swallowing to [] on every row via the
      // catch below rather than crashing (no logging here to say so),
      // meaning nested-group resolution was likely always silently
      // returning empty parent lists for every group, not actually
      // working, until this got fixed alongside getUserGroups().
      if (Array.isArray(row.groupIds)) {
        parents = row.groupIds;
      } else if (typeof row.groupIds === 'string' && row.groupIds) {
        try {
          parents = JSON.parse(row.groupIds);
          if (!Array.isArray(parents)) parents = [];
        } catch {
          parents = [];
        }
      }
      map.set(row.groupId, parents);
    }

    this._groupsCache = map;
    this._groupsCacheExpiry = now + Auth.GROUPS_CACHE_TTL_MS;
    return map;
  }

  /**
   * Call after any create/update/delete affecting kore_sys.user_groups (in
   * particular, a group's own groupIds/nesting) so the next permission
   * check picks up the change immediately rather than waiting out
   * GROUPS_CACHE_TTL_MS. Cheap and safe to call more often than strictly
   * necessary - it just clears the cache, the next _loadGroupsParentMap()
   * call repopulates it.
   */
  invalidateGroupsCache() {
    this._groupsCache = null;
    this._groupsCacheExpiry = 0;
  }

  /**
   * BFS out from a user's direct groups through the (cached) parent
   * graph, returning every reachable group id mapped to its SHORTEST
   * distance from the user (direct groups = distance 0). Cycle-safe: a
   * group reached again at an equal-or-greater distance than already
   * recorded is skipped rather than re-queued, so a cycle in the group
   * graph (accidental or otherwise) can't loop forever - it just stops
   * contributing once every reachable node has its shortest distance.
   *
   * Distance is what nearest-group-wins precedence in hasPermission()
   * keys off - see the precedence comment there for why a flat "any
   * group deny/allow" rule stopped being safe once groups can nest.
   */
  async _getEffectiveGroupDistances(userId) {
    const directGroupIds = await this.getUserGroups(userId);
    const parentMap = await this._loadGroupsParentMap();

    const distances = new Map(); // groupId -> shortest distance found
    const queue = directGroupIds.map(id => ({ id, distance: 0 }));

    while (queue.length > 0) {
      const { id, distance } = queue.shift();
      if (distances.has(id) && distances.get(id) <= distance) continue;
      distances.set(id, distance);

      const parents = parentMap.get(id) || [];
      for (const parentId of parents) {
        queue.push({ id: parentId, distance: distance + 1 });
      }
    }

    return distances;
  }

  /**
   * Get user's permissions (direct + via groups)
   * @param {string} userId
   */
  async getUserPermissions(userId) {
    try {
      const query = `
        SELECT resource, action, scope, effect, targetType, targetId
        FROM permissions 
        WHERE (targetType = 'user' AND targetId = ?) 
           OR (targetType = 'group' AND targetId IN (
             SELECT JSON_UNQUOTE(JSON_EXTRACT(groupIds, CONCAT('$[', idx, ']')))
             FROM users, 
             (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4) AS indices
             WHERE users.userId = ?
             AND JSON_EXTRACT(groupIds, CONCAT('$[', idx, ']')) IS NOT NULL
           ))
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
          source
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
   *   getPermissions({ permissionId: 'xxx' })
   */
  async getPermissions(filters = {}) {
    try {
      const conditions = [];
      const params = [];
      
      // Valid base field names
      const validFields = ['permissionId', 'targetType', 'targetId', 'resource', 'scope', 'action', 'effect', 'grantedAt', 'grantedBy'];

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
          if (value === null) {
            conditions.push(`p.${field} IS NULL`);
          } else {
            conditions.push(`p.${field} = ?`);
            params.push(value);
          }
        } else if (operator === '!=') {
          if (value === null) {
            conditions.push(`p.${field} IS NOT NULL`);
          } else {
            conditions.push(`p.${field} != ?`);
            params.push(value);
          }
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
          p.grantedAt, p.grantedBy,
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

  /**
   * Resolves a permission decision from already-fetched target rows (user-
   * and group-targeted permission rows applicable to ONE scope), using the
   * same precedence hasPermission() always has: user-deny > user-allow >
   * nearest-group-wins > no-applicable-rule. Returns true/false when a rule
   * applies, or undefined when neither the user nor any of their (nested)
   * groups have one - in which case the caller must fall back to the
   * default-allow-unless-any-allow-exists-elsewhere check itself, since that
   * check is a separate query the caller may or may not need to run.
   *
   * Pulled out of hasPermission() so hasPermissions() (the batch path) can
   * reuse the exact same precedence logic against rows it fetched in bulk,
   * rather than re-deriving it and risking the two drifting apart.
   */
  _resolveFromTargetRows(targetRows, groupDistances) {
    if (targetRows.some(r => r.targetType === 'user' && r.effect === 'deny')) {
      return false; // User deny always blocks
    }
    if (targetRows.some(r => r.targetType === 'user' && r.effect === 'allow')) {
      return true; // User allow always permits
    }

    const groupRows = targetRows.filter(r => r.targetType === 'group');
    if (groupRows.length > 0) {
      const nearestDistance = Math.min(...groupRows.map(r => groupDistances.get(r.targetId)));
      const nearestRows = groupRows.filter(r => groupDistances.get(r.targetId) === nearestDistance);
      if (nearestRows.some(r => r.effect === 'deny')) return false; // Nearest group deny blocks
      if (nearestRows.some(r => r.effect === 'allow')) return true; // Nearest group allow permits
    }

    return undefined; // No applicable user or group rule - caller decides the default
  }

  async hasPermission(userId, resource, action, scope = null) {
    try {
      // Build action condition: match specific action OR wildcard if checking specific action
      const actionCondition = action === '*' 
        ? `action = ?`
        : `(action = ? OR action = '*')`;

      // Effective groups: the user's direct groups plus every group
      // they're nested under transitively (see _getEffectiveGroupDistances),
      // each mapped to its shortest distance from the user. Computed before
      // the main query, since group matching can no longer be a single
      // inline JSON_CONTAINS against the user's own raw groupIds now that a
      // user can match a group they're not directly in - see
      // kore_sys.user_groups.groupIds (added for nested-group support).
      const groupDistances = await this._getEffectiveGroupDistances(userId);
      const effectiveGroupIds = [...groupDistances.keys()];

      // Precedence: user-deny > user-allow > nearest-group-wins (below) >
      // default-allow-unless-any-allow-exists-elsewhere.
      //
      // Nearest-group-wins: once a user can match a group through more than
      // one path (nested groups, not just direct membership), a flat "any
      // group deny anywhere blocks, else any group allow anywhere permits"
      // rule stops being safe - a distant ancestor group's deny could
      // silently override a closer, more specific group's allow that was
      // clearly meant to take precedence. So instead: among every matching
      // group row (deny or allow, at any distance), find the SMALLEST
      // distance present. Only rows at that nearest distance get a say - a
      // deny among them blocks, otherwise an allow among them permits. A
      // row at a greater distance never overrides one at a lesser distance,
      // regardless of deny/allow - "deny beats allow" only applies among
      // rows tied at the same (nearest) distance.
      //
      // OPTIMIZED (still the case despite the above): this remains a single
      // combined query for every user-targeted AND group-targeted row, not
      // one query per candidate group - effectiveGroupIds is passed as one
      // IN (...) list.
      // (The actual deny/allow/nearest-group precedence resolution itself
      // now lives in _resolveFromTargetRows(), shared with hasPermissions().)

      let targetRowsQuery = `
        SELECT targetType, targetId, effect
        FROM kore_sys.permissions
        WHERE resource = ?
        AND ${actionCondition}
        AND (scope = '*' OR scope IS NULL ${scope ? `OR scope = ?` : ''})
        AND (
          (targetType = 'user' AND targetId = ?)
      `;

      const targetRowsParams = [resource, action];
      if (scope) targetRowsParams.push(scope);
      targetRowsParams.push(userId);

      if (effectiveGroupIds.length > 0) {
        const placeholders = effectiveGroupIds.map(() => '?').join(',');
        targetRowsQuery += ` OR (targetType = 'group' AND targetId IN (${placeholders}))`;
        targetRowsParams.push(...effectiveGroupIds);
      }
      targetRowsQuery += `)`;

      const [targetRows] = await this.korePool.execute(targetRowsQuery, targetRowsParams);

      const resolved = this._resolveFromTargetRows(targetRows, groupDistances);
      if (resolved !== undefined) return resolved;

      // Neither the user nor any of their (nested) groups have an
      // applicable rule. Default logic, unchanged and hierarchy-agnostic:
      // if ANY allow rule exists anywhere for this resource+action+scope
      // (targeting someone else entirely), default is deny; otherwise,
      // default is allow.
      const anyAllowQuery = `
        SELECT COUNT(*) as count 
        FROM kore_sys.permissions 
        WHERE resource = ? 
        AND ${actionCondition}
        AND effect = 'allow'
        AND (scope = '*' OR scope IS NULL ${scope ? `OR scope = ?` : ''})
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

  /**
   * Batched version of hasPermission() - evaluates many (resource, action,
   * scope) checks for the SAME user in one pass, instead of one
   * hasPermission() call per check. Exists because hasPermission() re-fetches
   * this user's direct groups (via _getEffectiveGroupDistances) on every
   * single call, and issues up to two more queries on top of that - none of
   * which needs to be repeated when checking, say, 9 scopes of the same
   * resource+action for the same request (e.g. gating every tab on the
   * Settings page).
   *
   * @param {string} userId
   * @param {Array<{resource: string, action: string, scope: (string|null)}>} checks
   * @returns {Promise<Array<{resource: string, action: string, scope: (string|null), hasPermission: boolean}>>}
   *          Results are returned in the same order as `checks`.
   */
  async hasPermissions(userId, checks) {
    if (!Array.isArray(checks) || checks.length === 0) return [];

    try {
      // Computed once for the whole batch, not once per check - this is
      // the main saving, since it's the part hasPermission() can't cache
      // across calls (only the group parent-map is cached; a user's own
      // direct group membership is re-queried every call).
      const groupDistances = await this._getEffectiveGroupDistances(userId);
      const effectiveGroupIds = [...groupDistances.keys()];

      // Normalize scope once, keeping each check's original index so
      // results can be reassembled in the caller's input order below -
      // grouping by (resource, action) next necessarily loses that order,
      // and checks aren't guaranteed unique (the same resource/action/scope
      // could legitimately appear twice), so index is the only reliable key.
      const normalized = checks.map((check, index) => ({
        index,
        resource: check.resource,
        action: check.action,
        scope: (check.scope === '*' || check.scope === undefined) ? null : (check.scope || null)
      }));

      // Group by (resource, action) - that pair is what the two queries
      // below filter on, so checks sharing a pair (the common case: gating
      // N scopes of the same resource+action) are answered from ONE query
      // each, covering every scope in the group at once, instead of one
      // query per scope.
      const groups = new Map();
      for (const item of normalized) {
        const key = `${item.resource}\u0000${item.action}`;
        if (!groups.has(key)) {
          groups.set(key, { resource: item.resource, action: item.action, items: [] });
        }
        groups.get(key).items.push(item);
      }

      const results = new Array(checks.length);

      for (const { resource, action, items } of groups.values()) {
        const actionCondition = action === '*' ? `action = ?` : `(action = ? OR action = '*')`;

        // Every target row for this resource+action, across every scope in
        // this group (including scope = '*' and scope IS NULL rows, both
        // of which apply to every scope - see the per-item filter below) -
        // one query instead of one per scope.
        let targetRowsQuery = `
          SELECT scope, targetType, targetId, effect
          FROM kore_sys.permissions
          WHERE resource = ?
          AND ${actionCondition}
          AND (
            (targetType = 'user' AND targetId = ?)
        `;
        const targetRowsParams = [resource, action, userId];
        if (effectiveGroupIds.length > 0) {
          const placeholders = effectiveGroupIds.map(() => '?').join(',');
          targetRowsQuery += ` OR (targetType = 'group' AND targetId IN (${placeholders}))`;
          targetRowsParams.push(...effectiveGroupIds);
        }
        targetRowsQuery += `)`;

        const [allTargetRows] = await this.korePool.execute(targetRowsQuery, targetRowsParams);

        // Same consolidation for the default-allow-unless-any-allow-exists
        // fallback - one query per (resource, action) pair, covering every
        // scope in this group, instead of one per scope.
        const [anyAllowRows] = await this.korePool.execute(
          `SELECT scope FROM kore_sys.permissions
           WHERE resource = ? AND ${actionCondition} AND effect = 'allow'`,
          [resource, action]
        );
        const anyAllowScopes = new Set(anyAllowRows.map(r => r.scope));

        for (const item of items) {
          const targetRows = allTargetRows.filter(r => r.scope === '*' || r.scope === null || r.scope === item.scope);
          const resolved = this._resolveFromTargetRows(targetRows, groupDistances);
          const hasPermission = resolved !== undefined
            ? resolved
            : !(anyAllowScopes.has('*') || anyAllowScopes.has(null) || anyAllowScopes.has(item.scope));
          results[item.index] = { resource: item.resource, action: item.action, scope: item.scope, hasPermission };
        }
      }

      return results;
    } catch (err) {
      global.consoleLog('Auth', `ERROR checking batch permissions:: ${err.message}`, 1);
      return checks.map(check => ({
        resource: check.resource,
        action: check.action,
        scope: (check.scope === '*' || check.scope === undefined) ? null : (check.scope || null),
        hasPermission: false
      }));
    }
  }

  /**
   * Whether userId is allowed to manage permissions (view/insert/update/
   * revoke rows in kore_sys.permissions) for a given resource type.
   *
   * Two-tier check:
   *   1. 'permissions'/'view'/'all' - the blanket grant. Always sufficient,
   *      for any resource. This is the superuser override.
   *   2. Otherwise, fall back to whatever narrower "admin" permission is
   *      registered for that specific resource type in
   *      RESOURCE_PERMISSION_ADMIN_ACTIONS below - e.g. a user with
   *      'menu'/'admin' (the same grant that already lets them edit menu
   *      content) can also manage menu-scoped permissions, without needing
   *      the broader "manage every resource's permissions" grant.
   *
   * To extend this to a future resource-scoped admin editor (e.g.
   * workflows), add one entry to RESOURCE_PERMISSION_ADMIN_ACTIONS below -
   * no endpoint changes needed.
   *
   * @param {string} userId
   * @param {string} resource - the resource type being requested (e.g. 'menu', 'page')
   * @returns {Promise<boolean>}
   */
  async canManagePermissionsFor(userId, resource) {
    if (await this.hasPermission(userId, 'permissions', 'view', 'all')) return true;

    const narrowAction = RESOURCE_PERMISSION_ADMIN_ACTIONS[resource];
    if (!narrowAction) return false;

    return this.hasPermission(userId, resource, narrowAction, null);
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
            mustChangePassword = 0,
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
   * Admin sets a password directly for another user.
   *
   * Deliberately NOT a variant of changePassword(): there is no old password to
   * verify, because the whole point is that the user can't produce one. Format
   * rules and the no-reuse history check still apply, so an admin can't set a
   * password the user would be blocked from setting themselves.
   *
   * Side effects beyond the credential itself, all intentional:
   *  - Unlocks the account (clears lockedUntil / failed attempts, restores
   *    'active' from 'locked'). An admin resetting a locked user's password
   *    means they want that account usable again; making them click Unlock
   *    separately is a step that gets forgotten.
   *  - Revokes every refresh token for the user. An admin-initiated reset
   *    implies the old credential is lost or suspect, and a live refresh token
   *    outlives a password change entirely - the token survives, the session
   *    keeps working, and the reset accomplishes nothing. (Note changePassword()
   *    does NOT do this; whether it should is a separate question.)
   *  - Optionally sets mustChangePassword, forcing a change at next login.
   *
   * Status is only restored to 'active' from 'locked' - an 'inactive' or
   * 'invited' account is left in that state, since resetting a password
   * shouldn't silently reactivate a disabled user or bypass invite setup.
   *
   * @param {string} userId - user whose password is being set
   * @param {string} newPassword
   * @param {string} setBy - acting admin's userId, from the validated session
   * @param {boolean} forceChange - require a change at next login
   */
  async adminSetPassword(userId, newPassword, setBy, forceChange = false) {
    try {
      if (!userId || !setBy) {
        throw new Error('userId and setBy required');
      }
      if (!newPassword) {
        throw new Error('New password is required');
      }

      const [userRows] = await this.korePool.execute(
        'SELECT userId, email, status, passwordHash, passwordSalt, passwordSetAt, passwordHistory FROM users WHERE userId = ?',
        [userId]
      );

      if (!userRows[0]) {
        throw new Error('User not found');
      }

      const user = userRows[0];

      // Format rules
      const passwordValidation = this.validatePassword(newPassword);
      if (!passwordValidation.valid) {
        throw new Error(`Password invalid: ${passwordValidation.errors.join(', ')}`);
      }

      // Parse existing history (driver may hand back a string or a parsed object)
      let passwordHistory = [];
      if (user.passwordHistory) {
        try {
          passwordHistory = typeof user.passwordHistory === 'string'
            ? JSON.parse(user.passwordHistory)
            : user.passwordHistory;
        } catch (e) {
          global.consoleLog('Auth', `ERROR parsing passwordHistory: ${e.message}`, 1);
          passwordHistory = [];
        }
      }
      if (!Array.isArray(passwordHistory)) passwordHistory = [];

      // No-reuse check, same rule the user would face
      const historyCheck = this.validatePasswordHistory(newPassword, passwordHistory);
      if (!historyCheck.valid) {
        throw new Error(historyCheck.reason);
      }

      const { hash: newHash, salt: newSalt } = this.hashPassword(newPassword);

      // Push the outgoing credential onto history, matching changePassword's
      // date formatting so entries stay comparable across both paths
      const tz = global.timezone || 'UTC';
      let setAtValue;
      if (user.passwordSetAt) {
        setAtValue = new Date(user.passwordSetAt).toLocaleString('en-US', { timeZone: tz });
      } else {
        setAtValue = new Date().toLocaleString('en-US', { timeZone: tz });
      }

      if (user.passwordHash && user.passwordSalt) {
        passwordHistory.unshift({
          hash: user.passwordHash,
          salt: user.passwordSalt,
          setAt: setAtValue
        });
      }

      const historyCount = this.config.password?.historyCount || 10;
      const oldPwdAge = this.config.password?.oldPwdAge || 90;

      passwordHistory = passwordHistory.filter((entry, index) => {
        if (index < historyCount) return true;
        try {
          const ageDays = (Date.now() - new Date(entry.setAt).getTime()) / (1000 * 60 * 60 * 24);
          if (ageDays < oldPwdAge) return true;
        } catch (e) {
          return true;
        }
        return false;
      });

      const conn = await this.korePool.getConnection();
      try {
        await conn.beginTransaction();

        await conn.execute(
          `UPDATE users
             SET passwordHash = ?,
                 passwordSalt = ?,
                 passwordSetAt = NOW(),
                 passwordHistory = ?,
                 mustChangePassword = ?,
                 passwordFailedAttempts = 0,
                 passwordFailedLastAt = NULL,
                 lockedUntil = NULL,
                 status = CASE WHEN status = 'locked' THEN 'active' ELSE status END,
                 updatedAt = NOW(),
                 updatedBy = ?
           WHERE userId = ?`,
          [newHash, newSalt, JSON.stringify(passwordHistory), forceChange ? 1 : 0, setBy, userId]
        );

        const [revoked] = await conn.execute(
          'DELETE FROM refresh_tokens WHERE userId = ?',
          [userId]
        );

        await conn.commit();

        await this.logAudit('password_reset_by_admin', 'user', userId, user.email, setBy, {
          action: 'Admin set a new password',
          forceChange: !!forceChange,
          sessionsRevoked: revoked.affectedRows,
          wasLocked: user.status === 'locked'
        }, null);

        global.consoleLog('Auth', `Password set for ${user.email} by ${setBy} (forceChange=${!!forceChange}, ${revoked.affectedRows} session(s) revoked)`, 3);

        return {
          success: true,
          userId,
          email: user.email,
          forceChange: !!forceChange,
          sessionsRevoked: revoked.affectedRows,
          unlocked: user.status === 'locked'
        };
      } catch (error) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          global.consoleLog('Auth', `Rollback failed during adminSetPassword for ${userId}: ${rollbackError.message}`, 1);
        }
        throw error;
      } finally {
        conn.release();
      }
    } catch (err) {
      global.consoleLog('Auth', `ERROR setting password:: ${err.message}`, 1);
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
    <script type="module" src="/lib/base_css.js"></script>
    <script type="module" src="/lib/base.js"></script>
    <style>
        body {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px !important;
            background-color: var(--bg-secondary) !important;
        }
        
        .login-container {
            width: 100%;
            max-width: 400px;
        }
        
        .logo-header {
            background-color: white;
            border-radius: 100px;
            border: 2px solid var(--brand-light);
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
            padding: 75px 30px 30px 30px !important;
            border: 2px solid var(--brand-light) !important;
            border-top-left-radius: 0;
            border-top-right-radius: 0;
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
        
        .login-panel .btn {
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
        
        .login-panel .btn:hover {
            opacity: 0.9;
        }
        
        .login-panel .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .login-panel .btn-secondary {
            background-color: var(--border-primary);
        }
        
        .error {
            color: var(--status-red-input);
            font-size: 12px;
            margin-top: 5px;
        }
        
        .success {
            color: var(--status-green);
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
        
        .password-expired-notice {
            margin-bottom: 15px;
            color: var(--status-red-input);
            font-size: 12px;
        }
        
        .result-row {
            margin-bottom: 10px;
        }
        
        .result-row:last-child {
            margin-bottom: 0;
        }
        
        .result-success {
            margin-bottom: 10px;
            color: var(--status-green);
        }
        
        .button-group.spaced {
            margin-top: 15px;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="logo-header">
            <img src="/img/kore-logo.png" alt="Kore Logo">
        </div>
        
        <div class="panel-level-1 login-panel">
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
                <div class="password-expired-notice">
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
                <div class="result-success">? Login successful!</div>
                <div class="result-row">
                    <strong>User ID:</strong><br>
                    <span id="resultUserId"></span>
                </div>
                <div class="result-row">
                    <strong>Session Token:</strong><br>
                    <span id="resultSessionToken"></span>
                </div>
                <div class="result-row">
                    <strong>Relogin Token:</strong><br>
                    <span id="resultReloginToken"></span>
                </div>
                <div class="button-group spaced">
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
                
                // PHASE 2: no localStorage identity write. The session cookie is
                // the only thing that identifies the user; the client no longer
                // holds a copy that could drift from it.
                    
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
                
                // PHASE 2: no localStorage identity write - the session cookie
                // is the only thing that identifies the user.
                
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
                
                // Password changed successfully, complete login.
                // PHASE 2: no localStorage identity write. This line previously
                // stored currentEmail under the kore_userId key - an email
                // where every consumer expected a UUID - which is what broke
                // the dashboard and portal header after any forced password
                // change. The key no longer exists; identity comes from the
                // session cookie.
                
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
 * Authorize an already-authenticated request against a permission.
 * Sends 403 and returns false when denied; callers should return immediately.
 *
 * Mirrors resources.js's authorizeMenuAdmin() pattern rather than repeating
 * the same four lines in every handler. Note this is authorization ONLY -
 * the caller must have already validated the session and be passing a userId
 * that came from validateUserSessionToken(), never from the request body.
 *
 * @param {object} res
 * @param {string} userId - from the validated session
 * @param {string} resource
 * @param {string} action
 * @param {string|null} scope
 * @returns {Promise<boolean>}
 */
async function authorizeRequest(res, userId, resource, action, scope = null) {
    const allowed = await global.auth.hasPermission(userId, resource, action, scope);
    if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return false;
    }
    return true;
}

/**
 * POST /admin/users/:userId/reset-mfa
 * Admin resets user's MFA
 */
async function handleAdminResetMFA(req, res, userId) {
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
                if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'users'))) return;

                // resetBy comes from the validated session, NOT the request body.
                // It was previously read from the posted JSON, which meant the
                // audit trail recorded whatever string the caller supplied - and
                // combined with the missing session check above, an anonymous
                // caller could reset any user's MFA and attribute it to anyone.
                const result = await global.auth.resetMFA(userId, validation.userId);
                
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
                if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'users'))) return;

                // unlockedBy from the validated session, not the body - see
                // handleAdminResetMFA above for why.
                const result = await global.auth.unlockUser(userId, validation.userId);
                
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
 * POST /admin/users/:userId/set-password
 * Admin sets a new password directly for a user.
 * Body: { newPassword, forceChange }
 *
 * The acting admin comes from the validated session, never the body - the
 * password itself is the only thing this endpoint takes on trust.
 */
async function handleAdminSetPassword(req, res, userId) {
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
                if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'users'))) return;

                const { newPassword, forceChange } = JSON.parse(body || '{}');

                if (!newPassword) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'newPassword is required' }));
                    return;
                }

                const result = await global.auth.adminSetPassword(
                    userId,
                    newPassword,
                    validation.userId,
                    forceChange === true || forceChange === 'true'
                );

                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (err) {
                // Validation failures (format rules, password reuse) are the
                // expected error here and belong in the response so the admin
                // can correct them; 400 rather than 500 for that reason.
                global.consoleLog('Auth', `ERROR in adminSetPassword:: ${err.message}`, 1);
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } catch (err) {
        global.consoleLog('Auth', `ERROR in handleAdminSetPassword:: ${err.message}`, 1);
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
                
                const existingRefreshToken = getRefreshTokenFromCookies(req.headers.cookie);
                const result = await global.auth.login(email, password, mfaCode, userAgent, ipAddress, existingRefreshToken);
                
                // Check whether a password change is required before proceeding.
                // Two independent triggers, both landing in the same branch:
                //   - mustChangePassword: set by an admin via adminSetPassword()
                //   - password age beyond config.password.passwordExpiration
                const [userRows] = await global.auth.korePool.execute(
                  'SELECT passwordSetAt, mustChangePassword FROM users WHERE userId = ?',
                  [result.userId]
                );
                
                if (userRows[0]) {
                  const passwordExpiration = global.auth.config.password?.passwordExpiration || 0;
                  const adminForced = userRows[0].mustChangePassword === 1;

                  let expired = false;
                  if (passwordExpiration > 0) {
                    const passwordSetAt = new Date(userRows[0].passwordSetAt);
                    const now = new Date();
                    const ageMs = now - passwordSetAt;
                    const ageDays = ageMs / (1000 * 60 * 60 * 24);
                    expired = ageDays > passwordExpiration;
                    if (expired) {
                      global.consoleLog('Auth', `Password expired for user: ${email} (age: ${Math.floor(ageDays)} days, limit: ${passwordExpiration} days)`, 3);
                    }
                  }

                  if (adminForced || expired) {
                      if (adminForced) {
                        global.consoleLog('Auth', `Password change required for user: ${email} (set by admin)`, 3);
                      }
                      
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
                          message: adminForced
                            ? 'An administrator requires you to change your password'
                            : 'Password has expired and must be changed'
                      }));
                      return;
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
                if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'users'))) return;

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
        const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        const validation = validateUserSessionToken(sessionToken);

        if (!validation.valid) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        const urlParts = req.url.split('/');
        const userId = urlParts[2];
        
        if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'users'))) return;

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
        const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        const validation = validateUserSessionToken(sessionToken);

        if (!validation.valid) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'users'))) return;

                const data = JSON.parse(body);
                const { email, fullName, active, groupIds } = data;
                
                if (!email) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Email is required' }));
                    return;
                }
                
                // NOTE: this accepts groupIds, so it is a direct write into the
                // authorization model - adding a userId to the Admins group is a
                // full privilege escalation. It previously had NO session check at
                // all, making that reachable anonymously.
                const result = await global.auth.updateUser(userId, email, fullName, active, groupIds, validation.userId);
                
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
                if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'groups'))) return;

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
 * Update group details (groupName, description, active, groupIds)
 */
async function handleUpdateGroup(req, res, groupId) {
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
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'groups'))) return;

                const data = JSON.parse(body);
                const { groupName, description, active, groupIds } = data;
                
                if (!groupName) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Group name is required' }));
                    return;
                }
                
                // groupIds here is the group NESTING graph - editing it changes
                // what every member of this group inherits. Same escalation shape
                // as handleUpdateUser; previously reachable with no session at all.
                const result = await global.auth.updateGroup(groupId, groupName, description, active, groupIds, validation.userId);
                
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
    <script type="module" src="/lib/base_css.js"></script>
    <script type="module" src="/lib/base.js"></script>
    <style>
        body {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            background-color: var(--bg-secondary) !important;
        }
        
        .setup-container {
            width: 100%;
            max-width: 400px;
        }
        
        .logo-header {
            background-color: white;
            border-radius: 100px;
            border: 2px solid var(--brand-light);
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
            padding: 50px 30px 30px 30px !important;
            border: 2px solid var(--brand-light) !important;
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
            color: var(--status-red-input);
            font-size: 12px;
            margin-top: 5px;
        }
        
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        
        .setup-panel .btn {
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
        
        .setup-panel .btn:hover {
            opacity: 0.9;
        }
        
        .setup-panel .btn-secondary {
            background-color: var(--border-primary);
        }
        
        .error-heading {
            text-align: center;
            color: var(--status-red-input);
        }
        
        .setup-notice {
            color: var(--text-muted);
            font-size: 12px;
            line-height: 1.5;
            margin: 15px 0;
        }
    </style>
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
                    <p class="setup-notice">
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
    <script type="module" src="/lib/base_css.js"></script>
    <script type="module" src="/lib/base.js"></script>
    <style>
        body {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            background-color: var(--bg-secondary) !important;
        }
        
        .setup-container {
            width: 100%;
            max-width: 400px;
        }
        
        .logo-header {
            background-color: white;
            border-radius: 100px;
            border: 2px solid var(--brand-light);
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
            padding: 50px 30px 30px 30px !important;
            border: 2px solid var(--brand-light) !important;
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
            color: var(--status-red-input);
            font-size: 12px;
            margin-top: 5px;
        }
        
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        
        .setup-panel .btn {
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
        
        .setup-panel .btn:hover {
            opacity: 0.9;
        }
        
        .setup-panel .btn-secondary {
            background-color: var(--border-primary);
        }
        
        .field-label {
            display: block;
            margin-bottom: 10px;
            font-size: 12px;
            color: var(--text-muted);
            font-weight: 500;
        }
        
        .qr-code-container {
            display: flex;
            justify-content: center;
            margin-bottom: 15px;
        }
        
        .qr-code-image {
            width: 200px;
            height: 200px;
            border: 1px solid var(--border-primary);
            border-radius: 6px;
            background-color: var(--bg-panel3);
        }
        
        .secret-code-box {
            word-break: break-all;
            padding: 12px;
            font-family: monospace;
            font-size: 12px;
            background-color: var(--bg-panel3);
            border: 1px solid var(--border-primary);
            border-radius: 6px;
            margin-bottom: 15px;
        }
        
        .backup-codes-box {
            padding: 12px;
            font-family: monospace;
            font-size: 11px;
            background-color: var(--bg-panel3);
            border: 1px solid var(--border-primary);
            border-radius: 6px;
            white-space: pre-wrap;
        }
        
        .proceed-row {
            display: flex;
            justify-content: center;
            margin-top: 25px;
        }
        
        .proceed-pill {
            background-color: white;
            border-radius: 100px;
            border: 2px solid var(--brand-light);
            padding: 10px 25px;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        
        .proceed-link {
            color: var(--brand-light);
            text-decoration: none;
            font-size: 13px;
            font-weight: 900;
        }
    </style>
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
                <label class="field-label">Scan QR Code</label>
                <div id="qrCodeContainer" class="qr-code-container">
                    <img id="qrCode" src="" alt="QR Code" class="qr-code-image">
                </div>
                <label class="field-label">Or enter Secret Key manually</label>
                <div class="panel-level-3 secret-code-box" id="secretCode"></div>
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
                <div class="panel-level-3 backup-codes-box" id="backupCodes"></div>
                <div class="proceed-row">
                    <div class="proceed-pill">
                        <a href="#" onclick="showBackupCodesConfirmation(); return false;" class="proceed-link">Proceed to Kore</a>
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
 * Handle GET /kore/permission-resources - the permission_resources catalog
 * (Stage A of the Settings Permissions tab plan - see Permissions System
 * Guide.md §9). Flat list, no per-item nesting needed unlike page
 * permissions above. Gated the same as page-permissions viewing
 * ('permissions'/'view'/'all') since this catalog exists specifically to
 * drive the permissions-management UI - not meaningfully sensitive data on
 * its own (resource names/labels/scoping conventions, not actual grants),
 * but there's no reason for it to be reachable by someone who can't
 * otherwise view permissions at all.
 */
async function handleGetPermissionResources(req, res) {
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

    const [rows] = await global.auth.korePool.execute(
      `SELECT resource, label, description, scopeType, scopeLabel,
              scopeSourceEndpoint, scopeSourceValueField, scopeSourceLabelField,
              validActions
       FROM kore_sys.permission_resources
       WHERE active = TRUE
       ORDER BY label ASC`
    );

    // validActions is a native JSON column - already a real array via
    // mysql2, not a string. Do NOT unconditionally JSON.parse() this - see
    // Permissions System Guide.md §2's "gotcha worth remembering, hard".
    // Defensive branch here anyway in case a future write path (or a
    // differently-configured connection) ever hands back a string instead.
    const resources = rows.map(row => ({
      ...row,
      validActions: Array.isArray(row.validActions)
        ? row.validActions
        : (typeof row.validActions === 'string' ? (() => { try { return JSON.parse(row.validActions); } catch { return []; } })() : [])
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resources));
  } catch (error) {
    global.consoleLog('Auth', `Error getting permission resources: ${error.message}`, 1);
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

        // Permission check happens here (not before body parsing) because
        // it's keyed on the specific resource type being written - see
        // Auth.canManagePermissionsFor for the two-tier logic (blanket
        // 'permissions'/'view'/'all' grant, or a narrower per-resource
        // 'admin' grant such as 'menu'/'admin').
        const canManage = await global.auth.canManagePermissionsFor(validation.userId, resource);
        global.consoleLog('Auth', `Permission check for resource '${resource}': ${canManage}`, 4);

        if (!canManage) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }

        const connection = await global.auth.korePool.getConnection();
        try {
          await connection.beginTransaction();

          const ipAddress = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                             req.socket?.remoteAddress ||
                             req.connection?.remoteAddress ||
                             null;

          // Process deletes - hard delete, not soft-revoke. The full row
          // is fetched and logged to audit_log BEFORE deleting, since
          // once the row is gone this is the only place that content
          // still exists. See the "hard delete vs active flag" decision
          // this replaced - deliberate, not an oversight: this app is in
          // beta with a single person managing permissions currently, so
          // the tradeoff (settings.js's "Revoked" permissions-viewer
          // section - see viewUserPermissions/viewGroupPermissions - will
          // now always render empty, since there's no revoked row left
          // to show) was accepted rather than kept working via a
          // parallel active flag.
          if (deletes && deletes.length > 0) {
            global.consoleLog('Auth', `Processing ${deletes.length} deletes`, 4);
            const placeholders = deletes.map(() => '?').join(',');
            const [rowsToDelete] = await connection.execute(
              `SELECT permissionId, targetType, targetId, resource, scope, action, effect, grantedAt, grantedBy
               FROM kore_sys.permissions WHERE permissionId IN (${placeholders})`,
              deletes
            );
            for (const row of rowsToDelete) {
              await global.auth.logAudit(
                'permission_revoked', 'permission', row.permissionId,
                `${row.resource} (${row.action}, ${row.effect})`,
                validation.userId,
                {
                  targetType: row.targetType, targetId: row.targetId,
                  resource: row.resource, scope: row.scope,
                  action: row.action, effect: row.effect,
                  grantedAt: row.grantedAt, grantedBy: row.grantedBy
                },
                ipAddress
              );
            }
            await connection.execute(
              `DELETE FROM kore_sys.permissions WHERE permissionId IN (${placeholders})`,
              deletes
            );
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
              // A "revoke via update" (perm.revokedBy set) is now the same
              // hard-delete path as the deletes array above, not a field
              // update - the revokedAt/revokedBy columns are no longer
              // written anywhere. Fetch, audit-log, delete, then skip the
              // normal field-by-field UPDATE below entirely for this item.
              if (perm.revokedBy) {
                const [rowsToDelete] = await connection.execute(
                  `SELECT permissionId, targetType, targetId, resource, scope, action, effect, grantedAt, grantedBy
                   FROM kore_sys.permissions WHERE permissionId = ? AND resource = ?`,
                  [perm.permissionId, resource]
                );
                if (rowsToDelete.length > 0) {
                  const row = rowsToDelete[0];
                  await global.auth.logAudit(
                    'permission_revoked', 'permission', row.permissionId,
                    `${row.resource} (${row.action}, ${row.effect})`,
                    validation.userId,
                    {
                      targetType: row.targetType, targetId: row.targetId,
                      resource: row.resource, scope: row.scope,
                      action: row.action, effect: row.effect,
                      grantedAt: row.grantedAt, grantedBy: row.grantedBy
                    },
                    ipAddress
                  );
                  await connection.execute(
                    'DELETE FROM kore_sys.permissions WHERE permissionId = ? AND resource = ?',
                    [perm.permissionId, resource]
                  );
                }
                continue;
              }

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
/**
 * GET /auth/me
 * Return the currently logged-in user, resolved from the session cookie.
 *
 * REVIEW PHASE 2. This replaces base.js's getCurrentUserData(), which took a
 * sessionToken argument but did NOT use it for identity - it read
 * localStorage.kore_userId and interpolated that straight into
 * `SELECT ... FROM users WHERE userId = '${userId}'`, sent to /sqlquery. That
 * made the client the authority on who it was, which is wrong twice over: the
 * value can be edited from the browser console (so it was also an injection
 * point), and it can silently drift from the actual session - which is exactly
 * what happened after a forced password change, when the login page stored an
 * email in that key and every identity-dependent call started failing.
 *
 * No permission check: a user reading their own record needs no grant, and
 * this endpoint cannot be pointed at anyone else - the id comes from the
 * validated token, never from the request. Deliberately returns only what the
 * UI needs for display and self-identification; anything sensitive stays out
 * regardless of the caller's privileges.
 */
async function handleGetMe(req, res) {
  try {
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);

    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const [rows] = await global.auth.korePool.execute(
      `SELECT userId, email, fullName, status, active, groupIds, preferences, stack,
              mfaEnabled, lastLoginAt
         FROM users
        WHERE userId = ?`,
      [validation.userId]
    );

    if (!rows[0]) {
      // Valid signed token for a user that no longer exists - deleted or
      // recreated since the token was issued. Treat as unauthenticated rather
      // than 404: the session is the thing that's invalid.
      global.consoleLog('Auth', `/auth/me: no user row for session userId ${validation.userId}`, 2);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const user = rows[0];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      userId: user.userId,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      active: user.active === 1,
      groupIds: user.groupIds || [],
      preferences: user.preferences || {},
      stack: user.stack || {},
      mfaEnabled: user.mfaEnabled === 1,
      lastLoginAt: user.lastLoginAt,
      // Legacy aliases: getCurrentUserData() returned snake_case keys and
      // several callers destructure them. Kept so this endpoint can be dropped
      // in as a replacement without touching every consumer at once.
      user_id: user.userId,
      full_name: user.fullName
    }));

  } catch (error) {
    global.consoleLog('Auth', `Error handling /auth/me: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * PUT /auth/me/profile
 * Update the current user's own display name and email.
 * Body: { fullName, email }
 *
 * PHASE 2. Replaces base.js's updateUserProfile(), which built
 * `UPDATE users SET fullName = ..., email = ... WHERE userId = '<localStorage>'`
 * in the browser. The target row was chosen by the client, so a user could
 * rewrite another user's record - including their email, which is the login
 * identifier. Here the id comes from the session and cannot be supplied.
 *
 * Note this deliberately preserves the existing capability for a user to change
 * their own email. That is what the previous code allowed; whether self-service
 * email change SHOULD be permitted without re-verification is a separate policy
 * question, flagged in the review TODO rather than changed silently here.
 */
async function handleUpdateMyProfile(req, res) {
  try {
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);

    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const fullName = data.fullName || data.full_name;
        const email = data.email;

        if (!fullName || !email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'fullName and email are required' }));
          return;
        }

        await global.auth.korePool.execute(
          'UPDATE users SET fullName = ?, email = ?, updatedAt = NOW(), updatedBy = ? WHERE userId = ?',
          [fullName, email, validation.userId, validation.userId]
        );

        await global.auth.logAudit('profile_updated', 'user', validation.userId, email,
          validation.userId, { action: 'User updated their own profile' }, null);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        // Duplicate email hits the UNIQUE index on users.email - report it as a
        // 400 the user can act on rather than a generic 500.
        const isDuplicate = error.code === 'ER_DUP_ENTRY';
        global.consoleLog('Auth', `Error updating own profile: ${error.message}`, 1);
        res.writeHead(isDuplicate ? 400 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: isDuplicate ? 'That email address is already in use' : 'Internal server error'
        }));
      }
    });
  } catch (error) {
    global.consoleLog('Auth', `Error handling profile update: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * PUT /auth/me/preferences
 * Merge a partial preferences object into the current user's preferences.
 * Body: the keys to set, e.g. { notifications: {...} } or { dashboard_layout: [...] }
 *
 * PHASE 2. Replaces two separate browser-composed paths - base.js's
 * updateUserNotificationPreferences() and user_dash.js's JSON_SET layout write -
 * both of which targeted `WHERE userId = '<localStorage>'`.
 *
 * Merge happens in SQL via JSON_MERGE_PATCH rather than read-modify-write in
 * the client, so two tabs updating different preference keys can't clobber each
 * other. MERGE_PATCH (not MERGE_PRESERVE) so that setting a key REPLACES it -
 * an array like dashboard_layout must be overwritten wholesale, not appended to.
 */
async function handleUpdateMyPreferences(req, res) {
  try {
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);

    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const patch = JSON.parse(body || '{}');

        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Body must be an object of preference keys' }));
          return;
        }

        await global.auth.korePool.execute(
          `UPDATE users
              SET preferences = JSON_MERGE_PATCH(COALESCE(preferences, '{}'), CAST(? AS JSON)),
                  updatedAt = NOW()
            WHERE userId = ?`,
          [JSON.stringify(patch), validation.userId]
        );

        const [rows] = await global.auth.korePool.execute(
          'SELECT preferences FROM users WHERE userId = ?',
          [validation.userId]
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, preferences: rows[0] ? rows[0].preferences : {} }));
      } catch (error) {
        global.consoleLog('Auth', `Error updating own preferences: ${error.message}`, 1);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  } catch (error) {
    global.consoleLog('Auth', `Error handling preferences update: ${error.message}`, 1);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

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
    const permissions = await global.auth.getUserPermissions(userId);

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

    // Parse request body
    let payload = '';
    req.on('data', chunk => {
      payload += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const filters = JSON.parse(payload || '{}');

        // Permission check happens here (not before body parsing) because
        // the narrow per-resource bypass in canManagePermissionsFor only
        // applies when the query is scoped to one unambiguous resource
        // type (filters.resource as a plain string). Anything broader -
        // no resource filter, a resourceIn array, etc. - falls back to
        // requiring the blanket 'permissions'/'view'/'all' grant, so a
        // narrow 'menu'/'admin' grant can't be used to read permissions
        // for other resource types it wasn't meant to cover.
        const singleResource = typeof filters.resource === 'string' ? filters.resource : null;
        const canManage = singleResource
          ? await global.auth.canManagePermissionsFor(validation.userId, singleResource)
          : await global.auth.hasPermission(validation.userId, 'permissions', 'view', 'all');

        if (!canManage) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }

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
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);

    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'security'))) return;

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
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);

    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'security'))) return;

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
    // This endpoint writes a SECURITY CONTROL - allowedIPs is what keeps
    // internal-only pages internal on an externally-reachable service. It
    // previously had no authentication whatsoever, so an anonymous caller
    // could null out the IP gating on any page, workflow, or form, or lock
    // everyone out by setting a bogus value. A permission check (who may
    // change IP gating) is still outstanding - see the review TODO.
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);

    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

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

        if (!(await authorizeRequest(res, validation.userId, 'settings', 'edit', 'security'))) return;

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
 * Page resource's IP-whitelist hard gate, factored out of
 * handleHasPermission()'s single-check path so the batch path below can
 * apply the same per-item gate without duplicating it. Returns true when
 * access is allowed (including when the page has no whitelist configured -
 * not a gate at all in that case), false when it's denied.
 */
async function isPageIPAllowed(req, checkScope) {
  try {
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                     req.socket?.remoteAddress ||
                     req.connection?.remoteAddress ||
                     'unknown';

    global.consoleLog('Auth', `Page resource detected, checking IP whitelist for: ${clientIP} on page: ${checkScope}`, 4);

    const pageQuery = `SELECT allowedIPs FROM kore_sys.web_pages WHERE path = ? AND active = TRUE`;
    const [pageRows] = await global.auth.korePool.execute(pageQuery, [checkScope]);

    if (pageRows.length > 0 && pageRows[0].allowedIPs) {
      const ipAllowed = await global.auth.isIPAllowed(clientIP, pageRows[0].allowedIPs);
      global.consoleLog('Auth', `IP check result for ${clientIP}: ${ipAllowed}`, 4);
      return ipAllowed;
    }

    return true; // No whitelist configured for this page - not a gate
  } catch (ipCheckError) {
    global.consoleLog('Auth', `Error during IP check for page: ${ipCheckError.message}`, 1);
    return false; // Fail closed, matching the original single-check behavior
  }
}

/**
 * Handle POST /kore/has-permission - check if user has permission
 * Required: userId
 * One-of required: permissionId OR resource OR checks
 * If resource: action is required, scope is optional
 * If permissionId: all other inputs are ignored
 * If checks: an array of {resource, action, scope} - batched equivalent of
 *   the resource/action/scope form, evaluated together in one pass against
 *   global.auth.hasPermissions() rather than one hasPermission() call per
 *   item. Returns { results: [{resource, action, scope, hasPermission}, ...] }
 *   in the same order as `checks`. permissionId/resource are ignored if
 *   checks is provided.
 */
async function handleHasPermission(req, res) {
  try {
    let payload = '';
    req.on('data', chunk => {
      payload += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const { userId: requestedUserId, permissionId, resource, action, scope, checks } = JSON.parse(payload);

        const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        const validation = validateUserSessionToken(sessionToken);

        if (!validation.valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        // PHASE 2: the subject is ALWAYS the session user. This endpoint
        // previously took userId from the request body, which made it an oracle
        // over the whole permission model - anyone could enumerate exactly what
        // any user is allowed to do, which is a map of where to attack.
        //
        // A body userId is now ignored rather than rejected, so callers that
        // still send one keep working while they are migrated; a mismatch is
        // logged at level 2 so those call sites can be found.
        //
        // This endpoint answers "what may I do", which every page needs in order
        // to decide which controls to render, so it stays open to all
        // authenticated users. Inspecting ANOTHER user's permissions is a
        // separate concern served by GET /users/:id/permissions, which is gated
        // on permissions/view/all.
        if (requestedUserId && requestedUserId !== validation.userId) {
          global.consoleLog('Auth',
            `has-permission: ignoring body userId ${requestedUserId}, answering for session user ${validation.userId}`, 2);
        }

        const userId = validation.userId;

        // Batched form - checked first since it's a distinct response shape
        // ({ results: [...] } rather than { hasPermission }).
        if (Array.isArray(checks)) {
          if (checks.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [] }));
            return;
          }

          for (const c of checks) {
            if (!c || !c.resource || !c.action) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'each entry in checks requires resource and action' }));
              return;
            }
          }

          const normalizedChecks = checks.map(c => ({
            resource: c.resource,
            action: c.action,
            scope: (c.scope === '*') ? null : (c.scope || null)
          }));

          // Page resource's IP whitelist is a per-item hard gate (same as
          // the single-check path below) - resolved up front per item, so
          // items that fail it never reach global.auth.hasPermissions() at
          // all, and items that pass (or aren't 'page' checks) are batched
          // together into one call.
          const ipGateDenied = new Array(normalizedChecks.length).fill(false);
          for (let i = 0; i < normalizedChecks.length; i++) {
            const c = normalizedChecks[i];
            if (c.resource === 'page' && c.scope) {
              const allowed = await isPageIPAllowed(req, c.scope);
              if (!allowed) ipGateDenied[i] = true;
            }
          }

          const toLookup = normalizedChecks.filter((c, i) => !ipGateDenied[i]);
          const lookupResults = toLookup.length > 0
            ? await global.auth.hasPermissions(userId, toLookup)
            : [];

          let lookupIdx = 0;
          const results = normalizedChecks.map((c, i) => {
            if (ipGateDenied[i]) {
              return { resource: c.resource, action: c.action, scope: c.scope, hasPermission: false };
            }
            return lookupResults[lookupIdx++];
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results }));
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
            const ipAllowed = await isPageIPAllowed(req, checkScope);
            if (!ipAllowed) {
              // Return early since IP check is a hard gate
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ hasPermission: false }));
              return;
            }
          }
          
          // IP check passed (or not applicable), proceed with user/group permission check
          hasPermission = await global.auth.hasPermission(userId, resource, checkAction, checkScope);
        }
        // Missing permissionId, resource, and checks
        else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'One of permissionId, resource, or checks is required' }));
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
    } else if (req.method === 'GET' && req.url === '/auth/me') {
        handleGetMe(req, res);
        return true;
    } else if (req.method === 'PUT' && req.url === '/auth/me/profile') {
        handleUpdateMyProfile(req, res);
        return true;
    } else if (req.method === 'PUT' && req.url === '/auth/me/preferences') {
        handleUpdateMyPreferences(req, res);
        return true;
    } else if (req.method === 'POST' && req.url === '/auth/validate-token') {
        handleValidateSessionToken(req, res);
        return true;
    } else if (req.method === 'POST' && req.url.match(/^\/admin\/users\/[a-zA-Z0-9-]+\/reset-mfa$/)) {
        const userId = req.url.split('/')[3];
        handleAdminResetMFA(req, res, userId);
        return true;
    } else if (req.method === 'POST' && req.url.match(/^\/admin\/users\/[a-zA-Z0-9-]+\/unlock$/)) {
        const userId = req.url.split('/')[3];
        handleAdminUnlockUser(req, res, userId);
        return true;
    } else if (req.method === 'POST' && req.url.match(/^\/admin\/users\/[a-zA-Z0-9-]+\/set-password$/)) {
        const userId = req.url.split('/')[3];
        handleAdminSetPassword(req, res, userId);
        return true;
    } else if (req.method === 'POST' && req.url === '/users') {
        handleCreateUser(req, res);
        return true;
    } else if (req.method === 'POST' && req.url.match(/^\/users\/[a-zA-Z0-9-]+\/send-invite$/)) {
        handleSendInvite(req, res);
        return true;
    } else if (req.method === 'PUT' && req.url.match(/^\/users\/[a-zA-Z0-9-]+$/)) {
        const userId = req.url.split('/')[2];
        handleUpdateUser(req, res, userId);
        return true;
    } else if (req.method === 'POST' && req.url === '/groups') {
        handleCreateGroup(req, res);
        return true;
    } else if (req.method === 'PUT' && req.url.match(/^\/groups\/[a-zA-Z0-9-]+$/)) {
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
    } else if (req.method === 'GET' && req.url === '/kore/permission-resources') {
        handleGetPermissionResources(req, res);
        return true;
    } else if (req.method === 'PUT' && req.url === '/kore/permissions') {
        handleUpdatePermissions(req, res);
        return true;
    } else if (req.method === 'GET' && req.url.match(/^\/kore\/users\/[a-zA-Z0-9-]+\/permissions(\?.*)?$/)) {
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
 *
 * Verifies the HMAC signature before trusting anything in the payload. This
 * previously decoded parts[1] and returned payload.userId without checking
 * parts[2] at all - which meant ANY caller could mint a token by base64ing
 * `{"userId":"<any id>","exp":<future>}` into `a.<payload>.b` and be
 * authenticated as that user. Every consumer of this function was affected:
 * resources.js's authenticate() (all form/workflow/datatable/doc/menu/
 * workflow_util handlers), web.js page serving, and auth.js's own users/
 * groups/permissions handlers - and since permission checks run against the
 * returned userId, claiming membership in an admin group was enough to
 * bypass the entire authorization model.
 *
 * Same algorithm as the class method Auth.validateSessionToken() (see
 * ~line 887) - kept in sync deliberately. The signing key is read from
 * global.auth rather than a constructor arg because this is a standalone
 * export used by middleware that has no Auth instance; process.env is the
 * fallback for the same reason kore.js passes it in at construction.
 *
 * Fails CLOSED if no signing key is available (e.g. called before
 * global.auth is constructed) - an unsigned-but-well-formed token must
 * never be treated as valid just because the key was missing.
 */
function validateUserSessionToken(token) {
    try {
        if (!token) return { valid: false };

        const parts = token.split('.');
        if (parts.length !== 3) return { valid: false };

        const signingKey = (global.auth && global.auth.jwtSigningKey) || process.env.JWT_SIGNING_KEY;
        if (!signingKey) {
            global.consoleLog('Auth', 'validateUserSessionToken: no signing key available - rejecting token', 1);
            return { valid: false };
        }

        const [header, body, providedSignature] = parts;

        const expectedSignature = crypto
            .createHmac('sha256', signingKey)
            .update(`${header}.${body}`)
            .digest('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');

        if (providedSignature !== expectedSignature) {
            return { valid: false };
        }

        const payload = JSON.parse(Buffer.from(body, 'base64').toString());
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