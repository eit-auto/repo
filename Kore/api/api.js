/**
 * API Subsystem
 * Handles API authentication, API key validation, and API member management
 * 
 * Responsibilities:
 * - Load and cache API members from database
 * - Validate API keys with origin and domain
 * - Validate service accounts (API key + secret)
 * - CRUD operations for API members
 * - Rate limiting exceptions for API calls
 * 
 * Provides /api/auth/validate endpoint and related operations
 * Replaces deprecated /auth endpoint from kore.js
 */

const fs = require('fs');
const path = require('path');

class API {
  /**
   * Constructor
   * @param {mysql.Pool} korePool - Connection pool for kore_sys database
   */
  constructor(korePool) {
    this.korePool = korePool;
    this.membersCache = [];
    this.cacheLoadedAt = null;
  }

  /**
   * Initialize API subsystem
   * Loads API members cache from database
   * Called during startup and on reload
   */
  async initialize() {
    try {
      await this.loadApiMembersCache();
    } catch (error) {
      global.consoleLog('API', `ERROR initializing API subsystem: ${error.message}`, 1);
      throw error;
    }
  }

  /**
   * Load API members from database into cache
   * Queries api-members table for all enabled members
   * 
   * @returns {Promise<void>}
   */
  async loadApiMembersCache() {
    try {
      const connection = await this.korePool.getConnection();
      try {
        const [rows] = await connection.query('SELECT * FROM `api-members` WHERE enabled = true');
        this.membersCache = rows || [];
        this.cacheLoadedAt = new Date();
      } finally {
        connection.release();
      }
    } catch (error) {
      global.consoleLog('API', `ERROR loading API members cache: ${error.message}`, 1);
      this.membersCache = [];
      throw error;
    }
  }

  /**
   * Reload API members cache from database
   * Used when API member configuration changes
   * 
   * @returns {Promise<{success: boolean, count: number, error?: string}>}
   */
  async reloadCache() {
    try {
      await this.loadApiMembersCache();
      return {
        success: true,
        count: this.membersCache.length,
        reloadedAt: this.cacheLoadedAt
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        count: 0
      };
    }
  }

  /**
   * Get single API member from cache
   * Looks up member by API key, origin, and domain
   * 
   * @param {string} apiKey - The API key to validate
   * @param {string} origin - The origin/application identifier
   * @param {string} domain - The domain (extracted from user email)
   * @returns {Object|null} API member object or null if not found
   */
  getApiMember(apiKey, origin, domain) {
    return this.membersCache.find(member => 
      member.api_key === apiKey && 
      member.origin === origin && 
      member.domain === domain
    );
  }

  /**
   * List all API members
   * @returns {Array} Array of API member objects
   */
  listApiMembers() {
    return this.membersCache;
  }

  /**
   * Get API member by ID from database
   * Used for detailed retrieval including sensitive fields
   * 
   * @param {string} memberId - The API member ID (UUID)
   * @returns {Promise<Object|null>}
   */
  async getApiMemberById(memberId) {
    try {
      const connection = await this.korePool.getConnection();
      try {
        const [rows] = await connection.query(
          'SELECT * FROM `api-members` WHERE id = ?',
          [memberId]
        );
        return rows[0] || null;
      } finally {
        connection.release();
      }
    } catch (error) {
      global.consoleLog('API', `ERROR fetching API member: ${error.message}`, 1);
      throw error;
    }
  }

  /**
   * Create new API member
   * 
   * @param {Object} memberData - API member data
   * @param {string} memberData.origin - Application/origin identifier
   * @param {string} memberData.domain - Domain for this member
   * @param {string} memberData.api_key - API key
   * @param {string} memberData.api_secret - API secret (hashed before storage)
   * @param {string} memberData.description - Description of this API member
   * @param {boolean} memberData.enabled - Whether enabled
   * @returns {Promise<{id: string, ...}>}
   */
  async createApiMember(memberData) {
    try {
      const connection = await this.korePool.getConnection();
      try {
        const memberId = require('crypto').randomUUID();
        
        // Hash the API secret if provided
        const apiSecret = memberData.api_secret ? 
          require('crypto').createHash('sha256').update(memberData.api_secret).digest('hex') : 
          null;

        await connection.query(
          `INSERT INTO \`api-members\` 
           (id, origin, domain, api_key, api_secret, description, enabled, created_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            memberId,
            memberData.origin,
            memberData.domain,
            memberData.api_key,
            apiSecret,
            memberData.description || null,
            memberData.enabled !== false ? 1 : 0
          ]
        );

        // Reload cache
        await this.loadApiMembersCache();

        return {
          id: memberId,
          origin: memberData.origin,
          domain: memberData.domain,
          api_key: memberData.api_key,
          description: memberData.description,
          enabled: memberData.enabled !== false
        };
      } finally {
        connection.release();
      }
    } catch (error) {
      global.consoleLog('API', `ERROR creating API member: ${error.message}`, 1);
      throw error;
    }
  }

  /**
   * Update existing API member
   * 
   * @param {string} memberId - The API member ID
   * @param {Object} updateData - Fields to update
   * @returns {Promise<{success: boolean, ...}>}
   */
  async updateApiMember(memberId, updateData) {
    try {
      const connection = await this.korePool.getConnection();
      try {
        const updates = [];
        const values = [];

        if (updateData.origin !== undefined) {
          updates.push('origin = ?');
          values.push(updateData.origin);
        }
        if (updateData.domain !== undefined) {
          updates.push('domain = ?');
          values.push(updateData.domain);
        }
        if (updateData.api_key !== undefined) {
          updates.push('api_key = ?');
          values.push(updateData.api_key);
        }
        if (updateData.api_secret !== undefined) {
          const hashedSecret = require('crypto')
            .createHash('sha256')
            .update(updateData.api_secret)
            .digest('hex');
          updates.push('api_secret = ?');
          values.push(hashedSecret);
        }
        if (updateData.description !== undefined) {
          updates.push('description = ?');
          values.push(updateData.description);
        }
        if (updateData.enabled !== undefined) {
          updates.push('enabled = ?');
          values.push(updateData.enabled ? 1 : 0);
        }

        if (updates.length === 0) {
          return { success: true, message: 'No updates provided' };
        }

        values.push(memberId);
        updates.push('updated_at = NOW()');

        await connection.query(
          `UPDATE \`api-members\` SET ${updates.join(', ')} WHERE id = ?`,
          values
        );

        // Reload cache
        await this.loadApiMembersCache();

        return { success: true, message: 'API member updated' };
      } finally {
        connection.release();
      }
    } catch (error) {
      global.consoleLog('API', `ERROR updating API member: ${error.message}`, 1);
      throw error;
    }
  }

  /**
   * Delete API member
   * 
   * @param {string} memberId - The API member ID
   * @returns {Promise<{success: boolean, ...}>}
   */
  async deleteApiMember(memberId) {
    try {
      const connection = await this.korePool.getConnection();
      try {
        await connection.query(
          'DELETE FROM `api-members` WHERE id = ?',
          [memberId]
        );

        // Reload cache
        await this.loadApiMembersCache();

        return { success: true, message: 'API member deleted' };
      } finally {
        connection.release();
      }
    } catch (error) {
      global.consoleLog('API', `ERROR deleting API member: ${error.message}`, 1);
      throw error;
    }
  }

  /**
   * Validate API key with origin and domain
   * Used by /api/auth/validate endpoint
   * 
   * @param {string} apiKey - The API key to validate
   * @param {string} origin - The origin/application identifier
   * @param {string} domain - The domain
   * @returns {Promise<{valid: boolean, member?: Object, error?: string}>}
   */
  async validateApiKey(apiKey, origin, domain) {
    try {
      const member = this.getApiMember(apiKey, origin, domain);
      
      if (!member) {
        return {
          valid: false,
          error: 'Invalid API key, origin, or domain combination'
        };
      }

      return {
        valid: true,
        member: {
          id: member.id,
          origin: member.origin,
          domain: member.domain,
          description: member.description
        }
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Validate service account using API key and secret
   * Used for machine-to-machine authentication
   * 
   * @param {string} apiKey - The API key
   * @param {string} apiSecret - The API secret (plain text)
   * @returns {Promise<{valid: boolean, member?: Object, error?: string}>}
   */
  async validateServiceAccount(apiKey, apiSecret) {
    try {
      // Hash the provided secret
      const hashedSecret = require('crypto')
        .createHash('sha256')
        .update(apiSecret)
        .digest('hex');

      // Find member by key and validate secret
      const member = this.membersCache.find(m => 
        m.api_key === apiKey && m.api_secret === hashedSecret
      );

      if (!member) {
        return {
          valid: false,
          error: 'Invalid API key or secret'
        };
      }

      return {
        valid: true,
        member: {
          id: member.id,
          origin: member.origin,
          domain: member.domain,
          description: member.description
        }
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Check if API key is in rate-limit whitelist
   * API keys in whitelist bypass standard rate limiting
   * 
   * @param {string} apiKey - The API key to check
   * @returns {boolean}
   */
  isApiKeyWhitelisted(apiKey) {
    return this.membersCache.some(member => 
      member.api_key === apiKey && member.whitelist_rate_limit === 1
    );
  }
}

// ============================================================
// HTTP REQUEST HANDLERS
// ============================================================

/**
 * Get timestamp for logging
 * Uses global function if available, otherwise formats current time
 */
function getTimestamp() {
    if (global.getTimestamp) return global.getTimestamp();
    return new Date().toISOString();
}

/**
 * Validate API key via x-kore-token header
 * POST /api/auth/validate
 * 
 * Request body:
 *   {
 *     origin: "string",
 *     domain: "string"
 *   }
 * 
 * Returns:
 *   {
 *     valid: boolean,
 *     member?: { id, origin, domain, description },
 *     error?: string
 *   }
 */
async function handleValidateApiKey(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kore-Token');
    res.setHeader('Content-Type', 'application/json');

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const apiKey = req.headers['x-kore-token'];
    
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        try {
            if (!apiKey) {
                res.writeHead(401);
                res.end(JSON.stringify({
                    valid: false,
                    error: 'Missing x-kore-token header'
                }));
                return;
            }

            const data = JSON.parse(body);
            const { origin, domain } = data;

            if (!origin || !domain) {
                res.writeHead(400);
                res.end(JSON.stringify({
                    valid: false,
                    error: 'Missing origin or domain in request body'
                }));
                return;
            }

            const result = await global.API.validateApiKey(apiKey, origin, domain);
            
            res.writeHead(result.valid ? 200 : 401);
            res.end(JSON.stringify(result));
        } catch (error) {
            global.consoleLog('API', `ERROR validating API key: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({
                valid: false,
                error: 'Internal server error'
            }));
        }
    });
}

/**
 * List all API members
 * GET /api/members
 */
function handleListApiMembers(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    try {
        const members = global.API.listApiMembers();
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            count: members.length,
            members: members.map(m => ({
                id: m.id,
                origin: m.origin,
                domain: m.domain,
                description: m.description,
                enabled: m.enabled === 1,
                created_at: m.created_at,
                updated_at: m.updated_at
            }))
        }));
    } catch (error) {
        global.consoleLog('API', `ERROR listing API members: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
    }
}

/**
 * Get single API member by ID
 * GET /api/members/:id
 */
async function handleGetApiMember(req, res, memberId) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    try {
        const member = await global.API.getApiMemberById(memberId);
        
        if (!member) {
            res.writeHead(404);
            res.end(JSON.stringify({
                success: false,
                error: 'API member not found'
            }));
            return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            member: {
                id: member.id,
                origin: member.origin,
                domain: member.domain,
                description: member.description,
                enabled: member.enabled === 1,
                created_at: member.created_at,
                updated_at: member.updated_at
                // Note: api_key and api_secret not returned for security
            }
        }));
    } catch (error) {
        global.consoleLog('API', `ERROR getting API member: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
    }
}

/**
 * Create new API member
 * POST /api/members
 */
async function handleCreateApiMember(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        try {
            const data = JSON.parse(body);

            if (!data.origin || !data.domain || !data.api_key) {
                res.writeHead(400);
                res.end(JSON.stringify({
                    success: false,
                    error: 'Missing required fields: origin, domain, api_key'
                }));
                return;
            }

            const member = await global.API.createApiMember(data);
            res.writeHead(201);
            res.end(JSON.stringify({
                success: true,
                member
            }));
        } catch (error) {
            global.consoleLog('API', `ERROR creating API member: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
        }
    });
}

/**
 * Update API member
 * PUT /api/members/:id
 */
async function handleUpdateApiMember(req, res, memberId) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'PUT, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            const result = await global.API.updateApiMember(memberId, data);
            
            res.writeHead(200);
            res.end(JSON.stringify(result));
        } catch (error) {
            global.consoleLog('API', `ERROR updating API member: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
        }
    });
}

/**
 * Delete API member
 * DELETE /api/members/:id
 */
async function handleDeleteApiMember(req, res, memberId) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    try {
        const result = await global.API.deleteApiMember(memberId);
        res.writeHead(200);
        res.end(JSON.stringify(result));
    } catch (error) {
        global.consoleLog('API', `ERROR deleting API member: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
    }
}

/**
 * Reload API members cache
 * POST /api/cache/reload
 */
async function handleReloadApiCache(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    try {
        const result = await global.API.reloadCache();
        
        if (result.success) {
            res.writeHead(200);
        } else {
            res.writeHead(500);
        }
        
        res.end(JSON.stringify(result));
    } catch (error) {
        global.consoleLog('API', `ERROR reloading API cache: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
    }
}

/**
 * Route API requests to appropriate handler
 * @param {http.IncomingMessage} req 
 * @param {http.ServerResponse} res 
 * @returns {boolean} True if handled, false otherwise
 */
function routeApiRequest(req, res) {
    const urlWithoutQuery = req.url.split('?')[0];
    
    // POST /api/auth/validate
    if (req.method === 'POST' && urlWithoutQuery === '/api/auth/validate') {
        handleValidateApiKey(req, res);
        return true;
    }
    
    // GET /api/members
    if (req.method === 'GET' && urlWithoutQuery === '/api/members') {
        handleListApiMembers(req, res);
        return true;
    }
    
    // POST /api/members
    if (req.method === 'POST' && urlWithoutQuery === '/api/members') {
        handleCreateApiMember(req, res);
        return true;
    }
    
    // GET /api/members/:id
    if (req.method === 'GET' && urlWithoutQuery.match(/^\/api\/members\/[a-f0-9-]+$/)) {
        const memberId = urlWithoutQuery.split('/')[3];
        handleGetApiMember(req, res, memberId);
        return true;
    }
    
    // PUT /api/members/:id
    if (req.method === 'PUT' && urlWithoutQuery.match(/^\/api\/members\/[a-f0-9-]+$/)) {
        const memberId = urlWithoutQuery.split('/')[3];
        handleUpdateApiMember(req, res, memberId);
        return true;
    }
    
    // DELETE /api/members/:id
    if (req.method === 'DELETE' && urlWithoutQuery.match(/^\/api\/members\/[a-f0-9-]+$/)) {
        const memberId = urlWithoutQuery.split('/')[3];
        handleDeleteApiMember(req, res, memberId);
        return true;
    }
    
    // POST /api/cache/reload
    if (req.method === 'POST' && urlWithoutQuery === '/api/cache/reload') {
        handleReloadApiCache(req, res);
        return true;
    }
    
    // DEPRECATED: POST /kore/admin/reload-api-members (backward compatibility)
    if (req.method === 'POST' && urlWithoutQuery === '/kore/admin/reload-api-members') {
        global.consoleLog('API', 'DEPRECATED: /kore/admin/reload-api-members - use POST /api/cache/reload instead', 2);
        handleReloadApiCache(req, res);
        return true;
    }
    
    return false;
}

/**
 * Export the API class and routing function
 */
module.exports = API;
module.exports.routeApiRequest = routeApiRequest;