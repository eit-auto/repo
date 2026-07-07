/**
 * Kore Central Automation Platform
 * 
 * Unified integration platform for MeshCentral, ConnectWise Manage API, and database operations.
 * Includes Persephone workflow automation engine.
 * 
 * Endpoints:
 *   POST /auth                - Get session token for authenticated requests
 *   POST /validate            - Validate existing session token
 *   POST /command             - Execute MeshCentral remote commands
 *   POST /query               - Execute Rewst MySQL queries
 *   POST /cwaquery            - Execute ConnectWise Automate MySQL queries
 *   GET  /status              - Server health and status check
 *   GET  /nodes               - List MeshCentral nodes
 *   POST /api-cwm             - ConnectWise Manage API passthrough
 * 
 * Resources Module (Workflow CRUD):
 *   POST   /kore/workflows               - Create new workflow
 *   GET    /kore/workflows/:id           - Get latest workflow version
 *   GET    /kore/workflows/:id/:version  - Get specific workflow version
 *   DELETE /kore/workflows/:id/:version  - Archive workflow version
 * 
 * Persephone Execution Engine:
 *   POST   /engine/execute                    - Execute workflow
 *   GET    /engine/executions                 - List executions
 *   GET    /engine/executions/:executionId    - Get execution status
 *   POST   /engine/executions/:executionId/cancel - Cancel execution
 *   GET    /engine/filters                    - List all filters
 *   GET    /engine/filters/:filterName        - Get specific filter
 *   POST   /engine/render-template            - Render Jinja2 template
 * 
 * @version 0.500 - [KORE_VERSION_INCREMENT_ON_UPDATE]
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const Persephone = require('./persephone/persephone');
const Web = require('./web/web');
const Plugins = require('./plugins/plugins');
const CryptoUtils = require('./crypto-utils');
const Auth = require('./auth/auth');
const API = require('./api/api');
const { routeApiRequest } = require('./api/api');
const { validateUserSessionToken, isProtectedStaticFile, getSessionTokenFromCookies, getRefreshTokenFromCookies } = require('./auth/auth');

// Load environment variables from .env
require('dotenv').config();

/**
 * Get current timestamp formatted in configured timezone
 */
function getTimestamp() {
    const tz = global.timezone || 'UTC';
    return new Date().toLocaleString('en-US', { 
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/(\d+)\/(\d+)\/(\d+),\s(\d+):(\d+):(\d+)/, '$3-$1-$2T$4:$5:$6');
}

// Export to global so auth.js can use it
global.getTimestamp = getTimestamp;

/**
 * Log level mapping
 * String levels from config map to numeric levels for filtering
 */
const LOG_LEVELS = {
    'ERROR': 1,
    'WARN': 2,
    'INFO': 3,
    'DEBUG': 4
};

/**
 * Global console logging function with level filtering
 * Only logs if messageLevel <= global.logLevel
 * 
 * @param {string} subsystem - Subsystem name (e.g., 'API', 'Auth', 'Web')
 * @param {string} message - Log message
 * @param {number} messageLevel - Message level (1=ERROR, 2=WARN, 3=INFO, 4=DEBUG)
 */
function consoleLog(subsystem, message, messageLevel) {
    // Check if this message should be logged based on configured level
    if (messageLevel > global.logLevel) {
        return;
    }
    
    const timestamp = getTimestamp();
    const logMessage = `[${timestamp}] [${subsystem}] ${message}`;
    
    // Determine console method based on message level
    let method = 'log';
    if (messageLevel === 1) {
        method = 'error';
    } else if (messageLevel === 2) {
        method = 'warn';
    }
    
    console[method](logMessage);
}

// Export to global so subsystems can use it
global.consoleLog = consoleLog;
global.LOG_LEVELS = LOG_LEVELS;

// Default log level (will be overridden at startup)
global.logLevel = LOG_LEVELS['INFO'];

// ========== SECURITY CONFIGURATION ==========
// IP Whitelist (no rate limits applied)
const IP_WHITELIST = [
    '3.139.170.31',      // Rewst US
    '13.58.15.14',       // Rewst US
    '18.218.107.198',    // Rewst US
    '192.168.141.',      // Internal subnet (any 192.168.141.x)
    '127.0.0.1',         // Localhost IPv4
    '::1',               // Localhost IPv6
    'internal'           // Internal server calls (plugins.js mock requests)
];

// Rate limiting (requests per minute per IP)
const RATE_LIMITS = {
    '/auth': 10,         // Auth attempts
    'default': 100       // All other endpoints
};

// In-memory request tracking: { "ip": [timestamp1, timestamp2, ...] }
const requestLog = {};

function isIPWhitelisted(ip) {
    return IP_WHITELIST.some(whitelistedIp => {
        if (whitelistedIp.endsWith('.')) {
            // Subnet match (e.g., '192.168.141.')
            return ip.startsWith(whitelistedIp);
        }
        // Exact match
        return ip === whitelistedIp;
    });
}

function checkRateLimit(ip, endpoint) {
    const limit = RATE_LIMITS[endpoint] || RATE_LIMITS['default'];
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    
    // Initialize or clean up old requests
    if (!requestLog[ip]) {
        requestLog[ip] = [];
    }
    
    // Remove requests older than 1 minute
    requestLog[ip] = requestLog[ip].filter(timestamp => now - timestamp < windowMs);
    
    // Check if over limit
    if (requestLog[ip].length >= limit) {
        return {
            allowed: false,
            remaining: 0,
            resetIn: Math.ceil((requestLog[ip][0] + windowMs - now) / 1000)
        };
    }
    
    // Record this request
    requestLog[ip].push(now);
    
    return {
        allowed: true,
        remaining: limit - requestLog[ip].length,
        resetIn: null
    };
}

function stripVariableColumns(result) {
    if (!Array.isArray(result)) {
        return result;
    }
    
    return result.map(row => {
        if (typeof row !== 'object' || row === null) {
            return row;
        }
        
        const cleaned = {};
        for (const key in row) {
            // Strip @ prefix from key names, keep the value
            const cleanKey = key.startsWith('@') ? key.substring(1) : key;
            cleaned[cleanKey] = row[key];
        }
        return cleaned;
    });
}

/**
 * Log an action to audit_log
 */
async function logAudit(action, targetType, targetId, targetName, performedBy, details, ipAddress) {
    try {
        const query = `
            INSERT INTO audit_log 
            (action, targetType, targetId, targetName, performedBy, details, ipAddress, performedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `;
        
        const detailsJSON = typeof details === 'string' ? details : JSON.stringify(details || {});
        
        await korePool.execute(query, [
            action,
            targetType,
            targetId,
            targetName,
            performedBy,
            detailsJSON,
            ipAddress
        ]);
        
        global.consoleLog('Kore', `AUDIT: ${action} on ${targetType}:${targetId} by ${performedBy}`, 3);
        return true;
    } catch (err) {
        global.consoleLog('Kore', `ERROR logging audit: ${err.message}`, 1);
        return false;
    }
}

// Daily logging setup
const LOGS_DIR = 'D:\\Kore\\logs';
let logStream = null;
let currentLogDate = null;

function getLogFilePath() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return path.join(LOGS_DIR, `kore-${year}-${month}-${day}.log`);
}

function ensureLogStream() {
    const now = new Date();
    const today = now.toDateString(); // "Thu Apr 23 2026"
    const logFile = getLogFilePath();
    
    // Check if we need to switch to a new log file (date changed or first time)
    // OR if the current log file was deleted
    if (currentLogDate !== today || !fs.existsSync(logFile)) {
        // Close old stream if it exists
        if (logStream) {
            logStream.end();
        }
        
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(LOGS_DIR)) {
            fs.mkdirSync(LOGS_DIR, { recursive: true });
        }
        
        // Open new stream for today
        try {
            logStream = fs.createWriteStream(logFile, { flags: 'a' });
            
            // Handle stream errors
            logStream.on('error', (err) => {
                // Don't use console.error here - causes infinite recursion
                process.stderr.write(`[${getTimestamp()}] Log stream error: ${err.message}\n`);
                logStream = null;
            });
            
            currentLogDate = today;
        } catch (err) {
            process.stderr.write(`[${getTimestamp()}] ERROR opening log stream: ${err.message}\n`);
            logStream = null;
        }
    }
    
    return logStream;
}

function initializeLogging() {
    // Ensure initial stream is created
    ensureLogStream();
    
    // Redirect console.log
    const originalLog = console.log;
    console.log = function(...args) {
        // Always print to console first
        originalLog.apply(console, args);
        
        // Also write to file
        try {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            const timestamp = `[${getTimestamp()}]`;
            const output = `${timestamp} ${message}\n`;
            
            const stream = ensureLogStream();
            if (stream && !stream.closed) {
                stream.write(output);
            }
        } catch (err) {
            // Silently ignore file write errors to avoid breaking console
        }
    };
    
    // Redirect console.error
    const originalError = console.error;
    console.error = function(...args) {
        // Always print to console first
        originalError.apply(console, args);
        
        // Also write to file
        try {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            const timestamp = `[${getTimestamp()}]`;
            const output = `${timestamp} ERROR: ${message}\n`;
            
            const stream = ensureLogStream();
            if (stream && !stream.closed) {
                stream.write(output);
            }
        } catch (err) {
            // Silently ignore file write errors to avoid breaking console
        }
    };
    
    global.consoleLog('Kore', `Kore logging initialized - ${getLogFilePath()}`, 3);
}

// Initialize logging before anything else
initializeLogging();

// Configuration
const MESHCENTRAL_HOST = 'app.equinoxits.com';
const MESHCENTRAL_PORT = 1138;
const PROXY_PORT = 1139;
const SESSIONS_FILE = 'D:\\Kore\\sessions.json';
const LOG_FILE = 'D:\\Kore\\proxy-errors.log';
const ENABLE_MESHCENTRAL = false;  // Scream test - disable to test if Kore works without MeshCentral

// API Members cache (loaded from database at startup)
let apiMembersCache = null;

// Error logging helper
function logError(message, errorObj = null) {
    const timestamp = getTimestamp();
    const logEntry = `[${timestamp}] ${message}${errorObj ? '\n' + JSON.stringify(errorObj, null, 2) : ''}\n`;
    
    // Log to console
    console.error(logEntry);
    
    // Log to file
    try {
        fs.appendFileSync(LOG_FILE, logEntry);
    } catch (err) {
        console.error(`[${timestamp}] Failed to write to log file: ${err.message}`);
    }
}

// Session file write queue to prevent concurrent writes
const sessionWriteQueue = [];
let isWriting = false;

async function queueSessionWrite(sessionsData) {
    return new Promise((resolve) => {
        sessionWriteQueue.push({ data: sessionsData, resolve });
        processSessionWriteQueue();
    });
}

async function processSessionWriteQueue() {
    if (isWriting || sessionWriteQueue.length === 0) return;
    isWriting = true;
    const { data, resolve } = sessionWriteQueue.shift();
    
    try {
        await fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2));
        resolve(true);
    } catch (error) {
        global.consoleLog('Kore', `Error writing sessions: ${error.message}`, 1);
        resolve(false);
    }
    
    isWriting = false;
    if (sessionWriteQueue.length > 0) {
        setImmediate(processSessionWriteQueue);
    }
}

// Environment variables loaded from .env via dotenv
// Required: KORE_DB_HOST, KORE_DB_PORT, KORE_DB_USER, KORE_DB_PASS, KORE_DB_NAME, ENCRYPTION_KEY
const MESHCENTRAL_USER = '~t:HnFCPNFuaFf3Wr55';
const MESHCENTRAL_PASS = 'l1teqFCwQu5oIigiVAAV';

// Store active WebSocket connections by user/sessionid
const wsConnections = {};
const pendingResponses = {};
const pendingMeshesResolvers = []; // Track meshes promises (they don't echo responseid)

// WebSocket connection pool for command execution
const wsConnectionPool = {};  // userId -> array of pooled connections
const POOL_MAX_CONNECTIONS_PER_USER = 3;  // Allow up to 3 concurrent connections per user
const POOL_IDLE_TIMEOUT_MS = 60000;  // Close idle connections after 60 seconds

// MySQL connection pools
let mysqlPool = null;    // Rewst database pool
let cwaPool = null;      // CWA/LabTech database pool
let korePool = null;     // Kore database pool

if (ENABLE_MESHCENTRAL) {
    console.log(`[${getTimestamp()}] Starting MeshCentral WebSocket Proxy`);
    console.log(`[${getTimestamp()}] MeshCentral: ${MESHCENTRAL_HOST}:${MESHCENTRAL_PORT}`);
    console.log(`[${getTimestamp()}] Proxy listening: 0.0.0.0:${PROXY_PORT}`);
}

// Watchdog timer - logs health every 30 seconds to detect hangs
setInterval(() => {
    const poolCount = Object.keys(wsConnectionPool).length;
    const pendingCount = Object.keys(pendingResponses).length;
    const logMsg = `[${getTimestamp()}] [WATCHDOG] Proxy responsive. Pool users: ${poolCount}, Pending responses: ${pendingCount}`;
    global.consoleLog('Kore', logMsg.replace(/^\[.*?\] /, ''), 4);
}, 30000);

// Global error handlers for service stability
process.on('uncaughtException', (err) => {
    const logMsg = `[${getTimestamp()}] FATAL UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}\n`;
    global.consoleLog('Kore', logMsg.replace(/^\[.*?\] /, ''), 1);
    try {
        fs.appendFileSync('D:\\Kore\\error.log', logMsg);
    } catch (e) {
        global.consoleLog('Kore', `Failed to write error.log: ${e.message}`, 1);
    }
});

/**
 * Authenticate via HTTP to get session cookie
 */
async function getSessionCookie(username = null, password = null) {
    // Use provided credentials or fall back to hardcoded defaults
    const user = username || MESHCENTRAL_USER;
    const pass = password || MESHCENTRAL_PASS;
    
    return new Promise((resolve, reject) => {
        const postData = `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

        const options = {
            hostname: MESHCENTRAL_HOST,
            port: MESHCENTRAL_PORT,
            path: '/',
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        console.log(`[${getTimestamp()}] Authenticating via HTTP to get session cookie...`);

        const req = https.request(options, (res) => {
            let data = '';
            
            console.log(`[${getTimestamp()}] HTTP Login Response Status: ${res.statusCode}`);
            console.log(`[${getTimestamp()}] Set-Cookie headers:`, res.headers['set-cookie']);

            if (res.statusCode !== 200) {
                reject(new Error(`HTTP login failed: ${res.statusCode}`));
                return;
            }

            // Extract session cookie from Set-Cookie header
            const cookies = res.headers['set-cookie'];
            if (!cookies) {
                reject(new Error('No session cookie received'));
                return;
            }

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                console.log(`[${getTimestamp()}] Login response: ${data.substring(0, 100)}`);
                // Extract just the cookie name=value parts (before the semicolon) for all cookies
                const cookieValues = cookies.map(c => c.split(';')[0]).join('; ');
                console.log(`[${getTimestamp()}] Cookie values: ${cookieValues}`);
                resolve(cookieValues); // Return all cookies as Cookie header format
            });
        });

        req.on('error', (err) => {
            console.error(`[${getTimestamp()}] HTTP login error:`, err.message);
            reject(err);
        });

        // Set timeout for HTTP request (60 seconds for slow internal requests)
        req.setTimeout(60000, () => {
            console.error(`[${getTimestamp()}] HTTP login request timeout after 60 seconds`);
            req.destroy();
        });

        req.write(postData);
        req.end();
    });
}

/**
 * Connect to MeshCentral WebSocket with session cookie
 */
async function connectToMeshCentral(cookie) {
    if (!ENABLE_MESHCENTRAL) {
        return Promise.reject(new Error('MeshCentral is disabled'));
    }
    
    return new Promise((resolve, reject) => {
        const meshUrl = `wss://${MESHCENTRAL_HOST}:${MESHCENTRAL_PORT}/control.ashx`;
        const agent = new https.Agent({ rejectUnauthorized: false });

        console.log(`[${getTimestamp()}] Connecting to MeshCentral WebSocket with session cookie...`);

        const ws = new WebSocket(meshUrl, {
            agent,
            headers: {
                'Cookie': cookie
            }
        });

        let loginReceived = false;

        ws.on('open', () => {
            console.log(`[${getTimestamp()}] WebSocket connected, sending login with token credentials...`);
            
            // Send login message with token credentials
            const loginMsg = {
                action: 'login',
                username: MESHCENTRAL_USER,
                password: MESHCENTRAL_PASS
            };
            
            ws.send(JSON.stringify(loginMsg));
            console.log(`[${getTimestamp()}] Login message sent with credentials`);
        });

        ws.on('message', (data) => {
            if (!loginReceived) {
                try {
                    const msg = JSON.parse(data);
                    console.log(`[${getTimestamp()}] Initial message from MeshCentral:`, JSON.stringify(msg).substring(0, 100));
                    
                    // Check if this is a successful login - MeshCentral sends userinfo after successful login
                    if (msg.action === 'userinfo' || msg.action === 'login') {
                        console.log(`[${getTimestamp()}] Login successful`);
                        loginReceived = true;
                        resolve(ws);
                    } else if (msg.action === 'close' || msg.cause) {
                        console.error(`[${getTimestamp()}] Login failed:`, msg.cause || msg.msg);
                        reject(new Error(`Login failed: ${msg.cause || msg.msg}`));
                    }
                } catch (e) {
                    console.log(`[${getTimestamp()}] Non-JSON message received`);
                }
            }
        });

        ws.on('error', (err) => {
            console.error(`[${getTimestamp()}] WebSocket connection error:`, err.message);
            reject(err);
        });

        ws.on('close', () => {
            console.log(`[${getTimestamp()}] WebSocket disconnected from MeshCentral`);
            if (!loginReceived) {
                reject(new Error('WebSocket closed before login'));
            }
        });
    });
}

/**
 * Initialize MySQL connection pool from environment variables
 */
async function initializeMySQLPool() {
    try {
        // Validate required environment variables
        if (!process.env.KORE_DB_HOST || !process.env.KORE_DB_USER || !process.env.KORE_DB_PASS) {
            throw new Error('Missing required environment variables: KORE_DB_HOST, KORE_DB_USER, KORE_DB_PASS');
        }

        if (!process.env.ENCRYPTION_KEY) {
            throw new Error('Missing required environment variable: ENCRYPTION_KEY');
        }

        if (!process.env.JWT_SIGNING_KEY) {
            throw new Error('Missing required environment variable: JWT_SIGNING_KEY');
        }
        
        // Initialize crypto utilities for database credential encryption
        global.cryptoUtils = new CryptoUtils(process.env.ENCRYPTION_KEY);
        
        // Set temporary logLevel to DEBUG until system_config is loaded
        global.logLevel = LOG_LEVELS['DEBUG'];
        
        // Create Kore connection pool (kore_sys database) from environment variables
        korePool = mysql.createPool({
            host: process.env.KORE_DB_HOST,
            port: process.env.KORE_DB_PORT || 3306,
            database: process.env.KORE_DB_NAME || 'kore_sys',
            user: process.env.KORE_DB_USER,
            password: process.env.KORE_DB_PASS,
            waitForConnections: true,
            connectionLimit: 480,
            queueLimit: 100,
            enableKeepAlive: true,
            multipleStatements: true
        });

        // Wrap getConnection globally so every caller gets a timeout
        // instead of queuing indefinitely when the pool is exhausted.
        const _originalGetConnection = korePool.getConnection.bind(korePool);
        korePool.getConnection = function(timeoutMs = 10000) {
            return new Promise(function(resolve, reject) {
                const timer = setTimeout(function() {
                    reject(new Error('Database connection timeout: pool exhausted after ' + timeoutMs + 'ms'));
                }, timeoutMs);
                _originalGetConnection()
                    .then(function(conn) { clearTimeout(timer); resolve(conn); })
                    .catch(function(err) { clearTimeout(timer); reject(err); });
            });
        };

        // Load system configuration from database
        const [systemConfig] = await korePool.query('SELECT * FROM system_config WHERE id = 1');
        if (systemConfig && systemConfig.length > 0) {
            global.systemConfig = systemConfig[0];
            
            // Load timezone for logging
            global.timezone = global.systemConfig.timezone || 'UTC';
            
            // Load logging configuration FIRST so global.logLevel is set before other logs
            let logLevelStr = 'INFO';
            try {
                const loggingConfig = global.systemConfig.logging_config;
                let config = null;
                
                if (typeof loggingConfig === 'string') {
                    config = JSON.parse(loggingConfig);
                } else if (typeof loggingConfig === 'object' && loggingConfig !== null) {
                    config = loggingConfig;
                }
                
                if (config && config.log_level) {
                    logLevelStr = config.log_level.toUpperCase();
                    global.logLevel = LOG_LEVELS[logLevelStr] || LOG_LEVELS['INFO'];
                } else {
                    global.logLevel = LOG_LEVELS['INFO'];
                }
            } catch (error) {
                global.consoleLog('Kore', `WARNING: Could not parse logging_config: ${error.message}`, 2);
                global.logLevel = LOG_LEVELS['INFO'];
            }
            
            // NOW log startup messages with correct log level
            global.consoleLog('Kore', `MySQL connection pool created (${process.env.KORE_DB_HOST}:${process.env.KORE_DB_PORT}/${process.env.KORE_DB_NAME})`, 3);
            global.consoleLog('Kore', 'System configuration loaded from database', 3);
            global.consoleLog('Kore', `Data database: ${global.systemConfig.data_database_name}, Environment: ${global.systemConfig.environment}`, 3);
            global.consoleLog('Kore', `Timezone set to: ${global.timezone}`, 3);
            global.consoleLog('Kore', `Logging level set to: ${logLevelStr} (${global.logLevel})`, 1);
        } else {
            throw new Error('system_config table is empty - please insert default row');
        }
    } catch (error) {
        global.consoleLog('Kore', `ERROR initializing system: ${error.message}`, 1);
        global.consoleLog('Kore', 'Please verify .env file exists with required variables', 1);
        process.exit(1);  // Exit on critical configuration error
    }
}

/**
 * Load API members from database into cache
 * DEPRECATED: Will be moved to API subsystem
 * This function loads API credentials from the kore database for use by the handleAuthRequest endpoint
 * Once API subsystem has its own auth handler, this can be removed
 */
async function loadApiMembersCache() {
    try {
        if (!korePool) {
            global.consoleLog('Kore', 'WARNING: Kore pool not available, cannot load API members cache', 2);
            return;
        }
        
        const connection = await korePool.getConnection();
        try {
            const [rows] = await connection.query('SELECT * FROM `api-members` WHERE enabled = true');
            apiMembersCache = rows;
        } finally {
            connection.release();
        }
    } catch (error) {
        global.consoleLog('Kore', `ERROR loading API members cache: ${error.message}`, 1);
        // Don't exit - auth is still functional with empty cache (will deny all requests)
    }
}

/**
 * Get API member from cache by key, origin, and domain
 * DEPRECATED: Will be moved to API subsystem
 */
function getApiMember(key, origin, domain) {
    if (!apiMembersCache) {
        return null;
    }
    
    return apiMembersCache.find(member => 
        member.enabled && 
        member.key === key && 
        member.origin === origin && 
        member.domain === domain
    );
}

// ========== MODULE SYSTEM ==========


/**
 * Strip Windows banner and command echo from runcommands output
 */
function cleanCommandOutput(rawOutput) {
    if (!rawOutput) return '';
    
    // Split into lines (handle both \r\n and \n)
    let lines = rawOutput.split('\r\n').length > 1 
        ? rawOutput.split('\r\n')
        : rawOutput.split('\n');
    
    // Filter out:
    // 1. Windows version banner
    // 2. Copyright notice
    // 3. Command prompt lines (pattern: ...>command)
    // 4. Prompt-only lines
    const filtered = lines.filter(line => {
        // Skip Windows version banner
        if (line.match(/^Microsoft Windows \[Version/)) return false;
        // Skip copyright notice
        if (line.match(/^\(c\) \d{4} Microsoft Corporation/)) return false;
        // Skip command prompt with command (ends with prompt character followed by text)
        if (line.match(/[>:]\s*\w+/) && line.includes('\\')) return false;
        // Skip empty lines for now (we'll clean them up later)
        return true;
    });
    
    // Remove leading/trailing empty lines and deduplicate consecutive empty lines
    let result = filtered.join('\r\n')
        .replace(/^\r\n+/, '')           // Remove leading blank lines
        .replace(/\r\n+$/, '')           // Remove trailing blank lines
        .replace(/(\r\n){2,}/g, '\r\n'); // Collapse multiple blank lines to single
    
    return result;
}

/**
 * Send runcommands action to execute command on agent
 * @param {Object} commandParams - { nodeId, command, commandType, runAsUser, reply }
 * @returns {Promise<Object>} Response from agent execution
 */
function sendRunCommands(ws, commandParams) {
    return new Promise((resolve, reject) => {
        const responseId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Use nodeId as provided (it should already be in correct format)
        let nodeid = commandParams.nodeId;

        // Determine command type if not specified
        let cmdType = commandParams.commandType || 1; // Default to Windows cmd
        // Type: 1=Windows cmd, 2=PowerShell, 3=Linux shell, 4=Agent console

        // Build runcommands message per meshuser.js specification
        const command = {
            action: 'runcommands',
            nodeids: [nodeid],              // REQUIRED: Array format
            type: cmdType,                   // REQUIRED: Command type
            cmds: commandParams.command,     // REQUIRED: Command string
            runAsUser: commandParams.runAsUser || 0,  // OPTIONAL: 0=AsAgent, 1=UserFirst, 2=UserOnly
            reply: commandParams.reply !== false,      // OPTIONAL: Request output
            responseid: responseId           // Track response
        };

        console.log(`[${getTimestamp()}] Sending runcommands:`, {
            nodeid: nodeid,
            type: cmdType,
            cmds: commandParams.command.substring(0, 50) + '...',
            responseid: responseId
        });

        // Set timeout for response
        const timeout = setTimeout(() => {
            delete pendingResponses[responseId];
            reject(new Error(`Command timeout (${responseId})`));
        }, 90000); // 90 second timeout for slow internal requests

        // Store response handler
        pendingResponses[responseId] = {
            resolve: (data) => {
                clearTimeout(timeout);
                delete pendingResponses[responseId];
                resolve(data);
            },
            reject: (err) => {
                clearTimeout(timeout);
                delete pendingResponses[responseId];
                reject(err);
            }
        };

        try {
            console.log(`[${getTimestamp()}] WebSocket state before send: ${ws.readyState} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`);
            console.log(`[${getTimestamp()}] Attempting to send command to MeshCentral...`);
            ws.send(JSON.stringify(command));
            console.log(`[${getTimestamp()}] Command sent successfully to WebSocket`);
        } catch (err) {
            console.error(`[${getTimestamp()}] *** WEBSOCKET SEND ERROR: ${err.message}`);
            clearTimeout(timeout);
            delete pendingResponses[responseId];
            reject(err);
        }
    });
}

/**
 * Handle MeshCentral messages and route responses
 */
function setupMessageHandler(ws) {
    ws.on('message', (data) => {
        console.log(`[${getTimestamp()}] *** RAW DATA RECEIVED: ${data.length} bytes`);
        console.log(`[${getTimestamp()}] First 200 chars: ${data.toString().substring(0, 200)}`);
        
        try {
            const msg = JSON.parse(data);

            // Log all messages with more detail
            console.log(`[${getTimestamp()}] *** RECEIVED MESSAGE ***`);
            console.log(`[${getTimestamp()}] Message action: ${msg.action}`);
            console.log(`[${getTimestamp()}] Message type: ${msg.type}`);
            console.log(`[${getTimestamp()}] Message responseid: ${msg.responseid}`);
            console.log(`[${getTimestamp()}] Full message:`, JSON.stringify(msg).substring(0, 500));

            // Check for auth errors
            if (msg.action === 'close' && msg.cause === 'noauth') {
                console.error(`[${getTimestamp()}] Authentication failed: noauth`);
                // Reject all pending responses
                for (const responseId in pendingResponses) {
                    pendingResponses[responseId].reject(
                        new Error('Authentication failed: noauth')
                    );
                }
                return;
            }

            // Handle meshes action without responseid (MeshCentral doesn't echo responseid for meshes)
            if (msg.action === 'meshes' && msg.meshes) {
                console.log(`[${getTimestamp()}] Received meshes response (no responseid), resolving ${pendingMeshesResolvers.length} pending promises`);
                while (pendingMeshesResolvers.length > 0) {
                    const resolver = pendingMeshesResolvers.shift();
                    resolver(msg);
                }
            }
            
            // Route response to pending request
            if (msg.responseid && pendingResponses[msg.responseid]) {
                console.log(`[${getTimestamp()}] Routing response to request: ${msg.responseid}`);
                
                const resolver = pendingResponses[msg.responseid];
                // Delete immediately to prevent duplicate processing
                delete pendingResponses[msg.responseid];
                
                // Handle nodes action responses - they contain the nodes data directly
                if (msg.action === 'nodes' && msg.responseid.startsWith('nodes_')) {
                    resolver.resolve(msg);
                }
                // Handle runcommands type with result field
                else if (msg.type === 'runcommands' && msg.result !== undefined) {
                    // If result is JSON, don't clean it — return as-is
                    let cleanedOutput = msg.result;
                    if (msg.result.trim().startsWith('{') || msg.result.trim().startsWith('[')) {
                        // JSON output — use as-is
                    } else {
                        // Regular command output — clean it
                        cleanedOutput = cleanCommandOutput(msg.result);
                    }
                    
                    const previewLength = 500;
                    const preview = cleanedOutput.length > previewLength 
                        ? cleanedOutput.substring(0, previewLength) + `... (${cleanedOutput.length} total characters)`
                        : cleanedOutput;
                    
                    resolver.resolve({
                        success: true,
                        result: cleanedOutput,
                        message: preview
                    });
                } else if (msg.result === 'OK' || msg.result === true) {
                    resolver.resolve({
                        success: true,
                        result: msg.result,
                        message: msg.value || 'Command executed'
                    });
                } else if (msg.result) {
                    resolver.reject(
                        new Error(`Command error: ${msg.result}`)
                    );
                } else if (msg.output) {
                    // Some responses include output field
                    resolver.resolve({
                        success: true,
                        result: msg.output,
                        message: msg.output
                    });
                } else if (Object.keys(msg).length > 1) {
                    // If it's a complex object with nodes data, resolve it
                    resolver.resolve(msg);
                }
            } else if (msg.responseid) {
                console.log(`[${getTimestamp()}] *** UNMATCHED RESPONSEID: ${msg.responseid}, Pending responses: ${Object.keys(pendingResponses).join(', ')}`);
            } else {
                console.log(`[${getTimestamp()}] *** NO RESPONSEID IN MESSAGE, action: ${msg.action}, type: ${msg.type}`);
            }
        } catch (err) {
            console.error(`[${getTimestamp()}] *** PARSE ERROR: ${err.message}`);
            console.error(`[${getTimestamp()}] Failed to parse data:`, data.toString().substring(0, 200));
        }
    });

    ws.on('error', (err) => {
        console.error(`[${getTimestamp()}] WebSocket error:`, err.message);
    });

    ws.on('close', () => {
        console.log(`[${getTimestamp()}] *** WEBSOCKET CLOSED ***`);
        console.log(`[${getTimestamp()}] Pending responses at close: ${Object.keys(pendingResponses).length}`);
        console.log(`[${getTimestamp()}] Pending response IDs: ${Object.keys(pendingResponses).join(', ')}`);
        
        // Reject all pending responses
        for (const responseId in pendingResponses) {
            pendingResponses[responseId].reject(
                new Error('WebSocket connection closed')
            );
        }
    });
}

/**
 * Validate session token and return hardcoded MeshCentral credentials
 * Returns { valid: true, meshUser, meshPass, user } or { valid: false, error }
 */
async function validateSessionAndGetCredentials(sessionToken, user) {
    try {
        if (!sessionToken) {
            return { valid: false, error: 'No session token provided' };
        }
        
        if (!user) {
            return { valid: false, error: 'No user provided' };
        }
        
        // Load sessions from file
        let sessionsData;
        try {
            const sessionsJson = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
            sessionsData = JSON.parse(sessionsJson);
        } catch (error) {
            global.consoleLog('Kore', `Error loading sessions file: ${error.message}`, 1);
            return { valid: false, error: 'Server configuration error' };
        }
        
        // Find matching session
        const session = sessionsData.sessions.find(s => s.token === sessionToken);
        
        if (!session) {
            console.log(`[${getTimestamp()}] Session validation failed: token not found`);
            return { valid: false, error: 'Invalid session token' };
        }
        
        // Check if session has expired
        const now = Date.now();
        if (now > session.expiresAt) {
            console.log(`[${getTimestamp()}] Session validation failed: token expired`);
            return { valid: false, error: 'Session token has expired' };
        }
        
        // Verify user matches
        if (session.user !== user) {
            global.consoleLog('Kore', 'Session validation failed: user mismatch', 2);
            return { valid: false, error: 'User mismatch' };
        }
        
        // Session is valid - return hardcoded MeshCentral credentials
        global.consoleLog('Kore', `Session validated for user: ${session.user}`, 3);
        return {
            valid: true,
            meshUser: MESHCENTRAL_USER,
            meshPass: MESHCENTRAL_PASS,
            user: session.user
        };
        
    } catch (error) {
        global.consoleLog('Kore', `Session validation error: ${error.message}`, 1);
        return { valid: false, error: 'Internal server error' };
    }
}

/**
 * HTTP endpoint for command execution
 * POST /command
 * Body: { nodeId, command, commandType, runAsUser, reply, user }
 * Header: X-Session-Token
 */
/**
 * Get or create a pooled WebSocket connection for a user
 * Reuses existing connections instead of creating new ones per command
 */
async function getOrCreatePooledConnection(user, meshUser, meshPass) {
    if (!wsConnectionPool[user]) {
        wsConnectionPool[user] = [];
    }

    const userPool = wsConnectionPool[user];
    global.consoleLog('Kore', `[POOL] Getting connection for user: ${user}, current pool size: ${userPool.length}`, 4);

    // Check for existing available connection
    for (const pooledConn of userPool) {
        if (pooledConn.ws && pooledConn.ws.readyState === WebSocket.OPEN && !pooledConn.isBusy) {
            global.consoleLog('Kore', `[POOL] Reusing pooled connection for user: ${user}`, 4);
            pooledConn.lastActivity = Date.now();
            return pooledConn;
        }
    }

    // Create new connection if under limit
    if (userPool.length < POOL_MAX_CONNECTIONS_PER_USER) {
        if (!ENABLE_MESHCENTRAL) {
            throw new Error('MeshCentral is disabled - cannot create connection');
        }
        
        global.consoleLog('Kore', `[POOL] Creating new pooled connection for user: ${user} (${userPool.length + 1}/${POOL_MAX_CONNECTIONS_PER_USER})`, 4);
        
        const cookie = await getSessionCookie(meshUser, meshPass);
        const ws = await connectToMeshCentral(cookie);
        setupMessageHandler(ws);

        const pooledConn = {
            id: `pool_${user}_${Date.now()}`,
            user: user,
            ws: ws,
            commandQueue: [],
            isBusy: false,
            lastActivity: Date.now()
        };

        userPool.push(pooledConn);
        global.consoleLog('Kore', `[POOL] New connection created: ${pooledConn.id}`, 4);
        
        // Set up idle timeout cleanup
        pooledConn.idleTimeout = setTimeout(() => {
            closePooledConnection(pooledConn.id);
        }, POOL_IDLE_TIMEOUT_MS);

        return pooledConn;
    }

    // If at limit, return first connection (will queue)
    global.consoleLog('Kore', `[POOL] Connection pool at limit for user: ${user}, queuing on existing connection`, 4);
    return userPool[0];
}

/**
 * Close a pooled connection and remove from pool
 */
function closePooledConnection(connectionId) {
    for (const user in wsConnectionPool) {
        const userPool = wsConnectionPool[user];
        const index = userPool.findIndex(c => c.id === connectionId);
        
        if (index !== -1) {
            const pooledConn = userPool[index];
            global.consoleLog('Kore', `Closing pooled connection: ${connectionId}`, 4);
            
            if (pooledConn.idleTimeout) {
                clearTimeout(pooledConn.idleTimeout);
            }
            
            if (pooledConn.ws && pooledConn.ws.readyState === WebSocket.OPEN) {
                try {
                    pooledConn.ws.close();
                } catch (err) {
                    global.consoleLog('Kore', `Error closing pooled connection: ${err.message}`, 1);
                }
            }
            
            userPool.splice(index, 1);
            
            // Clean up user pool if empty
            if (userPool.length === 0) {
                delete wsConnectionPool[user];
            }
            
            return true;
        }
    }
    return false;
}

/**
 * Queue a command on a pooled connection
 * If not busy, execute immediately. Otherwise, queue for later execution.
 */
async function queueCommandOnConnection(pooledConn, commandParams) {
    return new Promise((resolve, reject) => {
        const queuedCmd = {
            commandParams: commandParams,
            resolve: resolve,
            reject: reject
        };

        pooledConn.commandQueue.push(queuedCmd);
        global.consoleLog('Kore', `[QUEUE] Command queued for user ${pooledConn.user}. Queue length: ${pooledConn.commandQueue.length}, isBusy: ${pooledConn.isBusy}`, 4);

        // If not busy, execute immediately
        if (!pooledConn.isBusy) {
            global.consoleLog('Kore', '[QUEUE] Connection idle, executing queued command immediately', 4);
            executeNextCommandInQueue(pooledConn);
        } else {
            global.consoleLog('Kore', `[QUEUE] Connection busy, command will wait. Queue length: ${pooledConn.commandQueue.length}`, 4);
        }
    });
}

/**
 * Execute the next command in the queue for a pooled connection
 */
async function executeNextCommandInQueue(pooledConn) {
    if (pooledConn.commandQueue.length === 0) {
        global.consoleLog('Kore', `[EXEC] Queue empty, marking connection idle for user: ${pooledConn.user}`, 4);
        pooledConn.isBusy = false;
        
        // Reset idle timeout
        if (pooledConn.idleTimeout) {
            clearTimeout(pooledConn.idleTimeout);
        }
        pooledConn.idleTimeout = setTimeout(() => {
            closePooledConnection(pooledConn.id);
        }, POOL_IDLE_TIMEOUT_MS);
        
        return;
    }

    pooledConn.isBusy = true;
    const queuedCmd = pooledConn.commandQueue.shift();

    try {
        global.consoleLog('Kore', `[EXEC] Executing command from queue. Remaining: ${pooledConn.commandQueue.length}, User: ${pooledConn.user}`, 4);
        
        const result = await sendRunCommands(pooledConn.ws, queuedCmd.commandParams);
        global.consoleLog('Kore', `[EXEC] Command completed successfully for user: ${pooledConn.user}`, 4);
        queuedCmd.resolve(result);
        
        // Execute next command in queue
        executeNextCommandInQueue(pooledConn);
    } catch (error) {
        global.consoleLog('Kore', `[EXEC] Command execution error: ${error.message}`, 1);
        queuedCmd.reject(error);
        
        // Try next command despite error
        executeNextCommandInQueue(pooledConn);
    }
}

/**
 * Authenticate client and validate credentials
 * POST /auth
 */
/**
 * DEPRECATED: handleAuthRequest is deprecated for future removal
 * Will be moved to API subsystem as part of /api/auth/validate endpoint
 * 
 * Validates API keys from x-kore-token or x-proxy-token headers
 * Checks origin and domain against api-members cache
 */
function handleAuthRequest(req, res) {
    const clientIP = req.socket.remoteAddress;
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kore-Token, X-Proxy-Token');
    
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end();
        return;
    }
    
    // Rate limit check for /auth
    if (!isIPWhitelisted(clientIP)) {
        const rateLimitCheck = checkRateLimit(clientIP, '/auth');
        if (!rateLimitCheck.allowed) {
            global.consoleLog('Kore', `Rate limit exceeded for IP ${clientIP} on /auth (limit: 10/min, reset in: ${rateLimitCheck.resetIn}s)`, 2);
            res.writeHead(429, { 
                'Content-Type': 'application/json',
                'Retry-After': rateLimitCheck.resetIn
            });
            res.end(JSON.stringify({ 
                error: 'Rate limit exceeded',
                resetIn: rateLimitCheck.resetIn
            }));
            return;
        }
    }
    
    // Accept both x-proxy-token (legacy) and x-kore-token (new)
    const apiKeyFromHeader = req.headers['x-kore-token'] || req.headers['x-proxy-token'];
    
    // Log deprecation warning if using legacy header
    if (req.headers['x-proxy-token'] && !req.headers['x-kore-token']) {
        global.consoleLog('Kore', 'WARNING: x-proxy-token header is deprecated, please use x-kore-token instead', 2);
    }
    
    global.consoleLog('Kore', '=== AUTH REQUEST ===', 4);
    global.consoleLog('Kore', `API Key header present: ${!!apiKeyFromHeader}`, 4);
    
    // Read request body
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            const originFromBody = data.origin;
            const userFromBody = data.user;
            
            global.consoleLog('Kore', `Origin from body: ${originFromBody}`, 4);
            global.consoleLog('Kore', `User from body: ${userFromBody}`, 4);
            
            // Extract domain from user (e.g., bradf@equinoxits.com -> equinoxits.com)
            let userDomain = null;
            if (userFromBody && userFromBody.includes('@')) {
                userDomain = userFromBody.split('@')[1];
                global.consoleLog('Kore', `Extracted user domain: ${userDomain}`, 4);
            }
            
            // Find matching credential from cache
            const validCred = getApiMember(apiKeyFromHeader, originFromBody, userDomain);
            
            if (!validCred) {
                global.consoleLog('Kore', 'Auth failed: invalid key/origin/domain combination', 2);
                global.consoleLog('Kore', `Provided key: ${apiKeyFromHeader}, origin: ${originFromBody}, domain: ${userDomain}`, 4);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid credentials' }));
                return;
            }
            
            // Generate session token
            const sessionToken = require('crypto').randomBytes(32).toString('hex');
            const expiresIn = 900; // 15 minutes in seconds
            const now = Date.now();
            const expiresAt = now + (expiresIn * 1000);
            
            // Session data to store
            const sessionData = {
                token: sessionToken,
                user: userFromBody,
                origin: originFromBody,
                credentialName: validCred.name,
                createdAt: now,
                expiresAt: expiresAt
            };
            
            // Load existing sessions
            let sessionsData = { sessions: [] };
            try {
                if (fs.existsSync(SESSIONS_FILE)) {
                    const sessionsJson = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
                    sessionsData = JSON.parse(sessionsJson);
                }
            } catch (error) {
                global.consoleLog('Kore', 'Note: Creating new sessions file', 3);
            }
            
            // Add new session
            sessionsData.sessions.push(sessionData);
            
            // Save sessions to file
            try {
                await queueSessionWrite(sessionsData);
                global.consoleLog('Kore', `Session saved for user: ${userFromBody}`, 3);
            } catch (error) {
                global.consoleLog('Kore', `Error saving session: ${error.message}`, 1);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to create session' }));
                return;
            }
            
            // Auth successful
            global.consoleLog('Kore', `Auth successful for: ${validCred.name} (user: ${userFromBody})`, 3);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: 'Authorized', 
                credentialName: validCred.name,
                sessionToken: sessionToken,
                expiresIn: expiresIn
            }));
            
        } catch (error) {
            global.consoleLog('Kore', `Auth error: ${error.message}`, 1);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

/**
 * DEPRECATED: /validate endpoint is deprecated for future removal
 * New code should use: POST /api/auth/validate-token (in auth.js)
 * 
 * Validates session tokens from x-session-token headers
 * Uses legacy session file storage instead of JWT validation
 * 
 * Will be consolidated with auth.js JWT validation when external systems are migrated
 */
function handleValidateSession(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
    
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end();
        return;
    }
    
    const sessionTokenFromHeader = req.headers['x-session-token'];
    
    global.consoleLog('Kore', '=== VALIDATE SESSION REQUEST ===', 4);
    global.consoleLog('Kore', `Session Token header present: ${!!sessionTokenFromHeader}`, 4);
    
    // Read request body
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            const userFromBody = data.user;
            
            global.consoleLog('Kore', `User from body: ${userFromBody}`, 4);
            
            if (!sessionTokenFromHeader) {
                global.consoleLog('Kore', 'Validation failed: no session token provided', 2);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No session token provided' }));
                global.consoleLog('Kore', 'Error response sent (no token)', 4);
                return;
            }
            
            // Load sessions from file
            let sessionsData;
            try {
                const sessionsJson = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
                sessionsData = JSON.parse(sessionsJson);
            } catch (error) {
                global.consoleLog('Kore', `Error loading sessions file: ${error.message}`, 1);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server configuration error' }));
                global.consoleLog('Kore', 'Error response sent (file error)', 4);
                return;
            }
            
            // Find matching session
            const session = sessionsData.sessions.find(s => s.token === sessionTokenFromHeader);
            
            if (!session) {
                global.consoleLog('Kore', 'Validation failed: session token not found', 2);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid session token' }));
                global.consoleLog('Kore', 'Error response sent (token not found)', 4);
                return;
            }
            
            // Check if session has expired
            const now = Date.now();
            if (now > session.expiresAt) {
                global.consoleLog('Kore', 'Validation failed: session token expired', 2);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Session token has expired' }));
                global.consoleLog('Kore', 'Error response sent (expired)', 4);
                return;
            }
            
            // Verify user matches
            if (session.user !== userFromBody) {
                global.consoleLog('Kore', 'Validation failed: user mismatch', 2);
                global.consoleLog('Kore', `Expected: ${session.user}, Got: ${userFromBody}`, 4);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'User mismatch' }));
                global.consoleLog('Kore', 'Error response sent (user mismatch)', 4);
                return;
            }
            
            // Session is valid
            const remainingTime = Math.floor((session.expiresAt - now) / 1000);
            global.consoleLog('Kore', `Session validation successful for user: ${session.user} (${remainingTime}s remaining)`, 3);
            
            const responseData = { 
                status: 'Valid',
                credentialName: session.credentialName,
                user: session.user,
                expiresIn: remainingTime
            };
            
            global.consoleLog('Kore', `Sending response: ${JSON.stringify(responseData)}`, 4);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responseData));
            
            global.consoleLog('Kore', 'Response sent to client', 4);
            
        } catch (error) {
            global.consoleLog('Kore', `Validation error: ${error.message}`, 1);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

/**
 * HTTP endpoint to reload API members cache
 * POST /kore/admin/reload-api-members
 */
/**
 * POST /kore/admin/reload-subsystem
 * Reload one or more subsystems (resources, auth, web, persephone, plugins, or all)
 * 
 * Each subsystem's initialize() function handles:
 * - Draining active operations (if any)
 * - Clearing require.cache
 * - Reloading and reinitializing
 */
async function handleReloadSubsystem(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        // Get subsystem from query parameter
        const url = require('url');
        const parsedUrl = url.parse(req.url, true);
        const subsystem = parsedUrl.query.subsystem || 'auth'; // Default to auth for backwards compatibility
        
        // Validate subsystem
        const validSubsystems = ['resources', 'auth', 'api', 'web', 'persephone', 'plugins', 'all'];
        if (!validSubsystems.includes(subsystem)) {
            res.writeHead(400);
            res.end(JSON.stringify({ 
                status: 'error',
                message: `Invalid subsystem: ${subsystem}. Valid options are: ${validSubsystems.join(', ')}`
            }));
            return;
        }
        
        const results = {
            succeeded: [],
            failed: [],
            warnings: []
        };
        
        // Helper to track results and initialize subsystems
        const initializeSubsystem = async (name) => {
            global.consoleLog('Kore', `Reloading ${name} subsystem...`, 1);
            
            try {
                switch (name) {
                    case 'resources':
                        delete require.cache[require.resolve('./resources/resources')];
                        global.Resources = require('./resources/resources');
                        await global.Resources.initialize();
                        results.succeeded.push(name);
                        break;
                        
                    case 'auth':
                        const [configRows] = await korePool.query('SELECT security_config FROM system_config WHERE id = 1');
                        const securityConfig = configRows[0]?.security_config || {};
                        delete require.cache[require.resolve('./auth/auth')];
                        const Auth = require('./auth/auth');
                        global.auth = new Auth(korePool, global.cryptoUtils, securityConfig, logAudit, process.env.JWT_SIGNING_KEY);
                        await global.auth.initialize();
                        results.succeeded.push(name);
                        break;
                        
                    case 'api':
                        delete require.cache[require.resolve('./api/api')];
                        const API = require('./api/api');
                        global.API = new API(korePool);
                        await global.API.initialize();
                        results.succeeded.push(name);
                        break;
                        
                    case 'web':
                        delete require.cache[require.resolve('./web/web')];
                        const Web = require('./web/web');
                        global.Web = Web;
                        await global.Web.initialize(korePool);
                        results.succeeded.push(name);
                        break;
                        
                    case 'persephone':
                        delete require.cache[require.resolve('./persephone/persephone')];
                        const Persephone = require('./persephone/persephone');
                        global.Persephone = Persephone;
                        await global.Persephone.initialize(korePool, global.Plugins);
                        global.Persephone.initialized = true;
                        results.succeeded.push(name);
                        break;
                        
                    case 'plugins':
                        delete require.cache[require.resolve('./plugins/plugins')];
                        const Plugins = require('./plugins/plugins');
                        global.Plugins = Plugins;
                        await global.Plugins.initialize(korePool, getTimestamp, isIPWhitelisted, checkRateLimit);
                        await global.Plugins.loadAllPlugins();
                        results.succeeded.push(name);
                        break;
                }
                
                global.consoleLog('Kore', `Successfully reloaded ${name} subsystem`, 1);
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                results.failed.push({
                    subsystem: name,
                    error: errorMsg
                });
                global.consoleLog('Kore', `ERROR reloading ${name} subsystem: ${errorMsg}`, 1);
            }
        };
        
        // Reload subsystem(s) in startup order: Resources -> Auth -> API -> Web -> Persephone -> Plugins
        if (subsystem === 'all') {
            await initializeSubsystem('resources');
            await initializeSubsystem('auth');
            await initializeSubsystem('api');
            await initializeSubsystem('web');
            await initializeSubsystem('persephone');
            await initializeSubsystem('plugins');
        } else {
            await initializeSubsystem(subsystem);
        }
        
        // Determine response status based on results
        const hasSuccesses = results.succeeded.length > 0;
        const hasFailures = results.failed.length > 0;
        
        let httpStatus = 200;
        let statusMessage = 'success';
        
        if (hasFailures && !hasSuccesses) {
            httpStatus = 500;
            statusMessage = 'error';
        } else if (hasFailures && hasSuccesses) {
            httpStatus = 207; // 207 Multi-Status
            statusMessage = 'partial_success';
        }
        
        res.writeHead(httpStatus);
        res.end(JSON.stringify({ 
            status: statusMessage,
            message: hasFailures && !hasSuccesses 
                ? `Failed to reload subsystem(s)`
                : `${results.succeeded.length} subsystem(s) reloaded${hasFailures ? ` (${results.failed.length} failed)` : ''}`,
            results: {
                succeeded: results.succeeded,
                failed: results.failed,
                warnings: results.warnings.length > 0 ? results.warnings : undefined
            }
        }));
        
    } catch (error) {
        global.consoleLog('Kore', `CRITICAL ERROR in handleReloadSubsystem: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ 
            status: 'error',
            message: `Critical error during reload: ${error.message}`
        }));
    }
}

/**
 * GET /kore/admin/system-health/modules
 * Returns detailed list of base modules with their full paths
 */
async function handleSystemHealthModules(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        const allModules = Object.keys(require.cache);
        const baseModulesMap = new Map(); // Map of baseName -> fullPath
        
        allModules.forEach(modulePath => {
            // Normalize path separators
            const normalizedPath = modulePath.replace(/\\/g, '/');
            
            // Extract base module name and path
            let baseName = '';
            let basePath = '';
            
            // Check if it's a node_modules package
            if (normalizedPath.includes('node_modules/')) {
                const match = normalizedPath.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)/);
                if (match) {
                    baseName = match[1];
                    // Get the full path up to and including the package name
                    const pathMatch = normalizedPath.match(/(.*node_modules\/(?:@[^\/]+\/)?[^\/]+)/);
                    if (pathMatch) {
                        basePath = pathMatch[1];
                    }
                }
            }
            // Otherwise use the filename or directory
            else {
                // Get just the filename or last meaningful path component
                const parts = normalizedPath.split('/');
                if (parts.length > 0) {
                    baseName = parts[parts.length - 1];
                    basePath = normalizedPath;
                }
            }
            
            // Store the first occurrence of each base module (to avoid duplicates)
            if (baseName && !baseModulesMap.has(baseName)) {
                baseModulesMap.set(baseName, basePath);
            }
        });
        
        // Convert to array of objects with name and path
        const modulesArray = Array.from(baseModulesMap.entries())
            .map(([name, path]) => ({ name, path }));
        
        // Custom sort: kore.js first, then subsystems, then everything else alphabetically
        const sortedModules = modulesArray.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            
            // Priority 1: kore.js comes first
            if (aName === 'kore.js') return -1;
            if (bName === 'kore.js') return 1;
            
            // Priority 2: subsystems in order (resources, auth, web, persephone, plugins)
            const subsystemOrder = { 'resources.js': 0, 'auth.js': 1, 'web.js': 2, 'persephone.js': 3, 'plugins.js': 4 };
            const aSubsystemPriority = subsystemOrder[aName];
            const bSubsystemPriority = subsystemOrder[bName];
            
            if (aSubsystemPriority !== undefined && bSubsystemPriority !== undefined) {
                return aSubsystemPriority - bSubsystemPriority;
            }
            if (aSubsystemPriority !== undefined) return -1;
            if (bSubsystemPriority !== undefined) return 1;
            
            // Priority 3: everything else alphabetically
            return aName.localeCompare(bName);
        });
        
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'success',
            totalBaseModules: sortedModules.length,
            totalLoadedFiles: allModules.length,
            modules: sortedModules
        }));
        
    } catch (error) {
        global.consoleLog('Kore', `ERROR getting module list: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({
            status: 'error',
            message: error.message
        }));
    }
}

/**
 * GET /kore/admin/system-health
 * Returns system health information
 */
async function handleSystemHealth(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        // Calculate uptime in seconds
        const uptimeSeconds = Math.floor(process.uptime());
        const days = Math.floor(uptimeSeconds / 86400);
        const hours = Math.floor((uptimeSeconds % 86400) / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const seconds = uptimeSeconds % 60;
        
        let uptimeString = '';
        if (days > 0) uptimeString += `${days}d `;
        if (hours > 0) uptimeString += `${hours}h `;
        if (minutes > 0) uptimeString += `${minutes}m `;
        uptimeString += `${seconds}s`;
        
        // Get memory usage
        const memUsage = process.memoryUsage();
        const memoryHeapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
        const memoryHeapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
        const memoryExternalMB = (memUsage.external / 1024 / 1024).toFixed(2);
        
        // Get Node.js version
        const nodeVersion = process.version;
        
        // Get Kore version
        const koreVersionContent = fs.readFileSync('./kore.js', 'utf8');
        const koreVersionMatch = koreVersionContent.match(/@version\s+([\d.]+)/);
        const koreVersion = koreVersionMatch ? koreVersionMatch[1] : '0.500';
        
        // Get base module count (not individual files)
        const allModules = Object.keys(require.cache);
        const baseModulesSet = new Set();
        
        allModules.forEach(modulePath => {
            const normalizedPath = modulePath.replace(/\\/g, '/');
            let baseName = '';
            
            if (normalizedPath.includes('node_modules/')) {
                const match = normalizedPath.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)/);
                if (match) baseName = match[1];
            } else {
                const parts = normalizedPath.split('/');
                if (parts.length > 0) baseName = parts[parts.length - 1];
            }
            
            if (baseName) baseModulesSet.add(baseName);
        });
        
        const baseModuleCount = baseModulesSet.size;
        
        // Check subsystem status and versions
        // Auth: Check if instance exists
        // Web: Check if pool is initialized (IIFE singleton)
        // Persephone: Check if initialized flag is set (IIFE singleton)
        
        // Helper function to extract version from module
        const getModuleVersion = (modulePath) => {
            try {
                const moduleContent = require('fs').readFileSync(modulePath, 'utf8');
                const versionMatch = moduleContent.match(/@version\s+([\d.]+)/);
                return versionMatch ? versionMatch[1] : '1.0';
            } catch (error) {
                return '1.0';
            }
        };
        
        const authVersion = getModuleVersion('./auth/auth.js');
        const webVersion = getModuleVersion('./web/web.js');
        const persephoneVersion = getModuleVersion('./persephone/persephone.js');
        const resourcesVersion = getModuleVersion('./resources/resources.js');
        
        const subsystemStatus = {
            resources: {
                status: global.Resources ? 'Initialized' : 'Not Initialized',
                version: resourcesVersion
            },
            auth: {
                status: global.auth ? 'Initialized' : 'Not Initialized',
                version: authVersion
            },
            web: {
                status: (global.Web && global.Web.pool) ? 'Initialized' : 'Not Initialized',
                version: webVersion
            },
            persephone: {
                status: (global.Persephone && global.Persephone.initialized) ? 'Initialized' : 'Not Initialized',
                version: persephoneVersion
            }
        };
        
        // Test korePool connection
        let korePoolStatus = 'Unknown';
        if (korePool) {
            try {
                const [result] = await korePool.query('SELECT 1');
                korePoolStatus = 'Connected';
            } catch (error) {
                korePoolStatus = 'Disconnected';
            }
        } else {
            korePoolStatus = 'Not Initialized';
        }
        
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'success',
            timestamp: new Date().toISOString(),
            uptime: {
                seconds: uptimeSeconds,
                formatted: uptimeString
            },
            koreVersion: koreVersion,
            nodeVersion: nodeVersion,
            memory: {
                heapUsedMB: parseFloat(memoryHeapUsedMB),
                heapTotalMB: parseFloat(memoryHeapTotalMB),
                externalMB: parseFloat(memoryExternalMB)
            },
            modules: {
                count: baseModuleCount
            },
            subsystems: subsystemStatus,
            database: {
                korePool: korePoolStatus
            }
        }));
        
    } catch (error) {
        global.consoleLog('Kore', `ERROR getting system health: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({
            status: 'error',
            message: error.message
        }));
    }
}

/**
 * POST /kore/admin/reload-api-members
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        global.consoleLog('Kore', 'Reloading API members cache...', 3);
        await loadApiMembersCache();
        
        res.writeHead(200);
        res.end(JSON.stringify({ 
            status: 'success',
            message: 'API members cache reloaded',
            cachedMembers: apiMembersCache ? apiMembersCache.length : 0
        }));
    } catch (error) {
        global.consoleLog('Kore', `ERROR reloading API members: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ 
            status: 'error',
            message: error.message
        }));
    }
}

/**
 * HTTP endpoint to load/reload a specific plugin
 * POST /kore/plugins/load?name=pluginName
 */
async function handleLoadPlugin(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        // Get plugin name from query params
        const url = require('url');
        const parsedUrl = url.parse(req.url, true);
        const pluginName = parsedUrl.query.name;
        
        if (!pluginName) {
            res.writeHead(400);
            res.end(JSON.stringify({ 
                status: 'error',
                message: 'Missing plugin name parameter'
            }));
            return;
        }
        
        global.consoleLog('Kore', `Loading plugin: ${pluginName}`, 3);
        const result = await global.Plugins.loadPlugin(pluginName);
        
        res.writeHead(200);
        res.end(JSON.stringify(result));
    } catch (error) {
        global.consoleLog('Kore', `ERROR loading plugin: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ 
            status: 'error',
            message: error.message
        }));
    }
}

/**
 * HTTP endpoint to reload all plugins
 * POST /kore/plugins/reload-all
 */
async function handleReloadAllPlugins(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        global.consoleLog('Kore', 'Reloading all plugins...', 3);
        const result = await global.Plugins.reloadAllPlugins();
        
        res.writeHead(200);
        res.end(JSON.stringify(result));
    } catch (error) {
        global.consoleLog('Kore', `ERROR reloading all plugins: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ 
            status: 'error',
            message: error.message
        }));
    }
}

/**
 * HTTP endpoint to get full details of a specific plugin
 * GET /kore/plugins/details?name=pluginName
 */
async function handleGetPluginDetails(req, res, helpers) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        const url = require('url');
        const parsedUrl = url.parse(req.url, true);
        const pluginName = parsedUrl.query.name;

        if (!pluginName) {
            res.writeHead(400);
            res.end(JSON.stringify({
                error: 'Missing plugin name parameter'
            }));
            return;
        }

        if (!korePool) {
            res.writeHead(500);
            res.end(JSON.stringify({
                error: 'Database connection not available'
            }));
            return;
        }

        const connection = await korePool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT id, name, display_name, description, version, code, routes, rate_limit, config, enabled, created_at, updated_at, created_by, updated_by FROM plugins WHERE name = ?',
                [pluginName]
            );

            if (rows.length === 0) {
                res.writeHead(404);
                res.end(JSON.stringify({
                    error: 'Plugin not found'
                }));
                return;
            }

            const plugin = rows[0];
            res.writeHead(200);
            res.end(JSON.stringify({
                success: true,
                plugin: {
                    id: plugin.id,
                    name: plugin.name,
                    display_name: plugin.display_name,
                    description: plugin.description,
                    version: plugin.version,
                    code: plugin.code,
                    routes: typeof plugin.routes === 'string' ? JSON.parse(plugin.routes) : plugin.routes,
                    rateLimit: plugin.rate_limit,
                    config: typeof plugin.config === 'string' ? JSON.parse(plugin.config) : plugin.config,
                    enabled: plugin.enabled,
                    created_at: plugin.created_at,
                    updated_at: plugin.updated_at,
                    created_by: plugin.created_by,
                    updated_by: plugin.updated_by
                }
            }));
        } finally {
            connection.release();
        }
    } catch (error) {
        global.consoleLog('Kore', `ERROR getting plugin details: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({
            error: error.message
        }));
    }
}

/**
 * Convert ISO datetime string to MySQL format (YYYY-MM-DD HH:MM:SS)
 */
function convertToMySQLDatetime(isoString) {
    if (!isoString) return getTimestamp().replace('T', ' ').split('.')[0];
    
    // Handle both ISO format and already converted format
    const converted = isoString.replace('T', ' ').split('.')[0].replace('Z', '');
    return converted;
}

/**
 * HTTP endpoint to update plugin settings
 * POST /kore/plugins/update?name=pluginName
 */
/**
 * POST /kore/plugins/add
 * Create a new plugin
 * Body: { name, display_name, description, enabled, version, code, config, username }
 */
async function handleAddPlugin(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        return;
    }

    let body = '';
    req.on('data', (chunk) => {
        body += chunk.toString();
        if (body.length > 1e6) {
            req.connection.destroy();
        }
    });

    req.on('end', async () => {
        const connection = await korePool.getConnection();
        try {
            let pluginData;
            try {
                pluginData = JSON.parse(body);
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
                return;
            }

            const { name, display_name, description, enabled, version, code, config, username } = pluginData;

            // Validate required fields
            if (!name || !display_name || !username) {
                res.writeHead(400);
                res.end(JSON.stringify({ 
                    error: 'Missing required fields: name, display_name, username' 
                }));
                return;
            }

            // Check if plugin already exists
            const [existingPlugin] = await connection.query(
                'SELECT id FROM plugins WHERE name = ?',
                [name]
            );

            if (existingPlugin.length > 0) {
                res.writeHead(409);
                res.end(JSON.stringify({ error: 'Plugin with this name already exists' }));
                return;
            }

            // Set timestamps
            const createdAt = getTimestamp();
            const updatedAt = createdAt;

            // Convert enabled to boolean (handle string/number values from forms)
            let enabledValue = 0;
            if (enabled === true || enabled === 1 || enabled === '1' || enabled === 'true' || enabled === 'on') {
                enabledValue = 1;
            }

            // Insert new plugin
            const [insertResult] = await connection.query(
                `INSERT INTO plugins 
                (name, display_name, description, enabled, version, code, config, created_at, updated_at, created_by, updated_by) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    name,
                    display_name,
                    description || null,
                    enabledValue,
                    version || '1.0',
                    code || '',
                    typeof config === 'string' ? config : JSON.stringify(config || {}),
                    createdAt,
                    updatedAt,
                    username,
                    username
                ]
            );

            const pluginId = insertResult.insertId;

            // Load the plugin into memory
            try {
                await global.Plugins.loadPlugin(name);
                global.consoleLog('Kore', `New plugin created and loaded: ${name} (ID: ${pluginId})`, 3);
            } catch (loadError) {
                global.consoleLog('Kore', `Plugin created but failed to load: ${name} - ${loadError.message}`, 2);
                // Plugin is created in DB even if it fails to load
            }

            // Fetch and return the created plugin
            const [createdPluginRows] = await connection.query(
                'SELECT id, name, display_name, description, version, code, config, enabled, created_at, updated_at, created_by, updated_by FROM plugins WHERE id = ?',
                [pluginId]
            );

            const createdPlugin = createdPluginRows[0];
            
            // Parse config if it's a string
            if (typeof createdPlugin.config === 'string') {
                try {
                    createdPlugin.config = JSON.parse(createdPlugin.config);
                } catch (e) {
                    createdPlugin.config = {};
                }
            }

            res.writeHead(201);
            res.end(JSON.stringify({
                success: true,
                message: 'Plugin created successfully',
                plugin: createdPlugin
            }));

        } catch (error) {
            global.consoleLog('Kore', `Error creating plugin: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({ error: error.message }));
        } finally {
            connection.release();
        }
    });
}

async function handleUpdatePlugin(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        return;
    }

    // Parse query string
    const urlParts = req.url.split('?');
    const queryString = urlParts[1] || '';
    const params = new URLSearchParams(queryString);
    const pluginName = params.get('name');
    
    if (!pluginName) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing plugin name in query string' }));
        return;
    }

    const sessionToken = req.headers['x-session-token'];
    if (!sessionToken) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'No session token' }));
        return;
    }

    let body = '';
    req.on('data', (chunk) => {
        body += chunk.toString();
        if (body.length > 1e6) {
            req.connection.destroy();
        }
    });

    req.on('end', async () => {
        const connection = await korePool.getConnection();
        try {
            let updates;
            try {
                updates = JSON.parse(body);
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
                return;
            }

            // Prepare update fields
            const updateFields = [];
            const updateValues = [];

            if (updates.hasOwnProperty('display_name')) {
                updateFields.push('display_name = ?');
                updateValues.push(updates.display_name);
            }

            if (updates.hasOwnProperty('version')) {
                updateFields.push('version = ?');
                updateValues.push(updates.version);
            }

            if (updates.hasOwnProperty('description')) {
                updateFields.push('description = ?');
                updateValues.push(updates.description);
            }

            if (updates.hasOwnProperty('enabled')) {
                updateFields.push('enabled = ?');
                updateValues.push(updates.enabled ? 1 : 0);
            }

            if (updates.hasOwnProperty('config')) {
                updateFields.push('config = ?');
                updateValues.push(JSON.stringify(updates.config));
            }

            if (updates.hasOwnProperty('code')) {
                updateFields.push('code = ?');
                updateValues.push(updates.code);
            }

            if (updates.hasOwnProperty('updated_at')) {
                updateFields.push('updated_at = ?');
                updateValues.push(updates.updated_at);
            }

            if (updates.hasOwnProperty('updated_by')) {
                updateFields.push('updated_by = ?');
                updateValues.push(updates.updated_by);
            }

            if (updateFields.length === 0) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'No valid fields to update' }));
                return;
            }

            // Add plugin name to query values
            updateValues.push(pluginName);

            // Execute update
            const query = `UPDATE plugins SET ${updateFields.join(', ')} WHERE name = ?`;
            global.consoleLog('Kore', `Updating plugin: ${pluginName}`, 3);
            
            const [result] = await connection.query(query, updateValues);

            if (result.affectedRows === 0) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: `Plugin ${pluginName} not found` }));
                return;
            }

            // Get plugin_id for history record
            const [pluginRows] = await connection.query(
                'SELECT id FROM plugins WHERE name = ?',
                [pluginName]
            );

            if (pluginRows.length > 0) {
                const pluginId = pluginRows[0].id;
                
                // If originalConfig provided, save it directly to plugin_history
                if (updates.originalConfig) {
                    const origConfig = updates.originalConfig;
                    
                    // Insert into plugin_history with ON DUPLICATE KEY UPDATE
                    const historyQuery = `
                        INSERT INTO plugin_history (plugin_id, version, display_name, description, enabled, config, created_at, updated_at, created_by, updated_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            display_name = VALUES(display_name),
                            description = VALUES(description),
                            enabled = VALUES(enabled),
                            config = VALUES(config),
                            updated_at = VALUES(updated_at),
                            updated_by = VALUES(updated_by)
                    `;

                    const historyValues = [
                        pluginId,
                        origConfig.version,
                        origConfig.display_name,
                        origConfig.description,
                        origConfig.enabled,
                        origConfig.config ? JSON.stringify(origConfig.config) : null,
                        convertToMySQLDatetime(origConfig.created_at),
                        convertToMySQLDatetime(origConfig.updated_at),
                        origConfig.created_by,
                        origConfig.updated_by
                    ];

                    global.consoleLog('Kore', `DEBUG: Saving plugin_history for ${pluginName} v${origConfig.version}`, 4);

                    try {
                        await connection.query(historyQuery, historyValues);
                        global.consoleLog('Kore', `Plugin history saved for ${pluginName} v${origConfig.version}`, 3);
                    } catch (historyError) {
                        global.consoleLog('Kore', `Warning: Failed to save plugin history: ${historyError.message}`, 2);
                        // Don't fail the entire request if history save fails, just log it
                    }
                }
            }

            res.writeHead(200);
            res.end(JSON.stringify({
                success: true,
                message: `Plugin ${pluginName} updated successfully`,
                timestamp: getTimestamp()
            }));

            global.consoleLog('Kore', `Plugin ${pluginName} updated by ${updates.updated_by}`, 3);
        } catch (error) {
            global.consoleLog('Kore', `ERROR updating plugin: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({
                error: error.message,
                timestamp: getTimestamp()
            }));
        } finally {
            connection.release();
        }
    });
}

/**
 * HTTP endpoint to list all loaded plugins
 * GET /kore/plugins/list
 */
function handleListPlugins(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        const plugins = global.Plugins.listPlugins();
        
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'success',
            pluginsLoaded: plugins.length,
            plugins: plugins
        }));
    } catch (error) {
        global.consoleLog('Kore', `ERROR listing plugins: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ 
            status: 'error',
            message: error.message
        }));
    }
}

/**
 * HTTP handler for plugin requests
 * Routes requests to loaded plugins based on URL
 */
/**
 * POST /kore/email/smtp
 * Send email via configured SMTP profile
 * 
 * Request body:
 * {
 *   "profile": "default",  // SMTP profile name (optional, defaults to "default")
 *   "to": "recipient@example.com",
 *   "subject": "Email Subject",
 *   "plainText": "Plain text body (optional)",
 *   "html": "<h1>HTML body</h1> (optional)",
 *   "from": "sender@example.com (optional)",
 *   "cc": "cc@example.com (optional)",
 *   "bcc": "bcc@example.com (optional)"
 * }
 */
async function handleSendEmail(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        return;
    }

    let body = '';
    req.on('data', (chunk) => {
        body += chunk.toString();
        if (body.length > 1e6) {
            req.connection.destroy();
        }
    });

    req.on('end', async () => {
        const connection = await korePool.getConnection();
        try {
            let emailData;
            try {
                emailData = JSON.parse(body);
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
                return;
            }

            const { profile, to, subject, plainText, html, from, cc, bcc } = emailData;
            const profileName = profile || 'default';

            // Validate required fields
            if (!to || !subject) {
                res.writeHead(400);
                res.end(JSON.stringify({ 
                    error: 'Missing required fields: to, subject' 
                }));
                return;
            }

            // Require at least plainText or html
            if (!plainText && !html) {
                res.writeHead(400);
                res.end(JSON.stringify({
                    error: 'Email must include either plainText or html content'
                }));
                return;
            }

            // Get email configuration from system_config
            const [configRows] = await connection.query(
                'SELECT email_config FROM kore_sys.system_config LIMIT 1'
            );

            if (!configRows || configRows.length === 0) {
                global.consoleLog('Kore', 'Email config not found in system_config', 1);
                res.writeHead(500);
                res.end(JSON.stringify({
                    error: 'Email service configuration not available'
                }));
                return;
            }

            let emailConfig;
            try {
                const configData = configRows[0].email_config;
                emailConfig = typeof configData === 'string' ? JSON.parse(configData) : configData;
            } catch (parseError) {
                global.consoleLog('Kore', `Failed to parse email config: ${parseError.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({
                    error: 'Invalid email configuration'
                }));
                return;
            }

            // Find the requested SMTP profile
            if (!emailConfig.smtp_profiles || !Array.isArray(emailConfig.smtp_profiles)) {
                global.consoleLog('Kore', 'No SMTP profiles found in email config', 1);
                res.writeHead(500);
                res.end(JSON.stringify({
                    error: 'No SMTP profiles configured'
                }));
                return;
            }

            const smtpProfile = emailConfig.smtp_profiles.find(p => p.profile_name === profileName);
            if (!smtpProfile) {
                res.writeHead(404);
                res.end(JSON.stringify({
                    error: `SMTP profile "${profileName}" not found`
                }));
                return;
            }

            // Build PowerShell SMTP send command
            // Use authenticated user as From, set Reply-To for public contact
            const senderEmail = `${smtpProfile.smtp_username}@equinoxits.com`;
            const replyToEmail = smtpProfile.smtp_from || 'noreply@equinoxits.com';
            const emailBody = html || plainText;
            const isHtml = !!html;

            // Escape special characters for PowerShell
            const escapePS = (str) => {
                if (!str) return '""';
                return `@"
${str}
"@`;
            };

            // Escape password for PowerShell string
            const escapePSString = (str) => {
                if (!str) return '""';
                return `"${str.replace(/\$/g, '`$').replace(/"/g, '`"').replace(/`/g, '``')}"`;
            };

            const psCommand = `
[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}
try {
    $smtp = New-Object Net.Mail.SmtpClient("${smtpProfile.smtp_host}", ${parseInt(smtpProfile.smtp_port, 10)})
    $smtp.EnableSSL = $true
    $smtp.DeliveryMethod = [Net.Mail.SmtpDeliveryMethod]::Network
    $smtp.Credentials = New-Object System.Net.NetworkCredential("${smtpProfile.smtp_username}", ${escapePSString(smtpProfile.smtp_password)})
    $message = New-Object Net.Mail.MailMessage
    $message.From = "${senderEmail}"
    $message.ReplyToList.Add("${replyToEmail}")
    $message.To.Add("${to}")
    $message.Subject = "${subject.replace(/"/g, '`"')}"
    $message.Body = ${escapePS(emailBody)}
    $message.IsBodyHtml = $${isHtml}
    ${cc ? `$message.CC.Add("${cc}")` : ''}
    ${bcc ? `$message.Bcc.Add("${bcc}")` : ''}
    $smtp.Send($message)
    Write-Host "Email sent successfully"
} catch {
    Write-Error "SMTP Error: $_"
    exit 1
}
`;

            global.consoleLog('Kore', `Sending email to ${to} with subject: ${subject}`, 3);

            try {
                // Spawn PowerShell process
                const ps = spawn('powershell.exe', [
                    '-NoProfile',
                    '-NoLogo',
                    '-Command',
                    psCommand
                ], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let stdout = '';
                let stderr = '';
                let timedOut = false;

                // Set timeout for PowerShell execution (30 seconds)
                const timeout = setTimeout(() => {
                    timedOut = true;
                    global.consoleLog('Kore', 'PowerShell email send timeout after 30s', 1);
                    ps.kill();
                }, 30000);

                ps.stdout.on('data', (data) => {
                    stdout += data.toString();
                });

                ps.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                ps.on('close', (code) => {
                    clearTimeout(timeout);
                    
                    if (timedOut) {
                        res.writeHead(500);
                        res.end(JSON.stringify({
                            success: false,
                            error: 'Email send timed out after 30 seconds',
                            timestamp: getTimestamp()
                        }));
                        return;
                    }
                    if (code === 0 && !stderr) {
                        global.consoleLog('Kore', `Email sent successfully to ${to}`, 3);

                        res.writeHead(200);
                        res.end(JSON.stringify({
                            success: true,
                            message: 'Email sent successfully',
                            timestamp: getTimestamp()
                        }));
                    } else {
                        let errorMsg = stderr || stdout || `Exit code ${code}`;
                        
                        const smtpErrorMatch = errorMsg.match(/SMTP Error: ([\s\S]*?)(?:\n\s+\+|$)/);
                        if (smtpErrorMatch) {
                            errorMsg = smtpErrorMatch[1].trim();
                            errorMsg = errorMsg.replace(/\n\s+/g, ' ');
                        } else {
                            const lines = errorMsg.split('\n').filter(l => l.trim() && !l.includes('+'));
                            if (lines.length > 0) {
                                errorMsg = lines[lines.length - 1].trim();
                            }
                        }
                        
                        global.consoleLog('Kore', `PowerShell SMTP failed: ${errorMsg}`, 1);
                        
                        res.writeHead(500);
                        res.end(JSON.stringify({
                            success: false,
                            error: errorMsg,
                            timestamp: getTimestamp()
                        }));
                    }
                });

                ps.on('error', (err) => {
                    global.consoleLog('Kore', `PowerShell spawn error: ${err.message}`, 1);
                    
                    res.writeHead(500);
                    res.end(JSON.stringify({
                        success: false,
                        error: `PowerShell execution failed: ${err.message}`,
                        timestamp: getTimestamp()
                    }));
                });

            } catch (psError) {
                global.consoleLog('Kore', `Email handler error: ${psError.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({
                    success: false,
                    error: psError.message,
                    timestamp: getTimestamp()
                }));
            }

                
        } catch (error) {
            global.consoleLog('Kore', `Email handler error: ${error.message}`, 1);

            const statusCode = error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' ? 503 : 500;

            res.writeHead(statusCode);
            res.end(JSON.stringify({
                success: false,
                error: error.message,
                code: error.code,
                timestamp: getTimestamp()
            }));
        } finally {
            connection.release();
        }
    });
}

async function handlePluginRequest(req, res) {
    const clientIP = req.socket.remoteAddress;
    const route = req.url.split('?')[0]; // Remove query params
    
    global.consoleLog('Kore', '=== PLUGIN REQUEST ===', 4);
    global.consoleLog('Kore', `Route: ${route}`, 4);
    
    // Get the plugin handler for this route
    const pluginHandler = global.Plugins.getHandler(route);
    
    if (!pluginHandler) {
        global.consoleLog('Kore', `No plugin handler found for ${route}`, 2);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Plugin not found' }));
        return;
    }
    
    const { plugin, handler } = pluginHandler;
    
    // Check rate limit (plugin-specific or global)
    if (!isIPWhitelisted(clientIP)) {
        const rateLimitEndpoint = route;
        const rateLimitCheck = checkRateLimit(clientIP, rateLimitEndpoint);
        if (!rateLimitCheck.allowed) {
            global.consoleLog('Kore', `Rate limit exceeded for IP ${clientIP} on ${route}`, 2);
            res.writeHead(429, { 
                'Content-Type': 'application/json',
                'Retry-After': rateLimitCheck.resetIn
            });
            res.end(JSON.stringify({ 
                error: 'Rate limit exceeded',
                resetIn: rateLimitCheck.resetIn
            }));
            return;
        }
    }
    
    // Get operation manager for this plugin
    const manager = global.Plugins.getOperationManager(plugin.name);
    if (!manager) {
        global.consoleLog('Kore', `No operation manager for plugin ${plugin.name}`, 1);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Plugin manager not initialized' }));
        return;
    }

    // If reload is queued or reloading, reject the operation
    if (manager.reloadQueued || manager.isReloading) {
        global.consoleLog('Kore', `Operation rejected for ${plugin.name} due to pending reload`, 2);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'Plugin is reloading',
            reloadId: manager.reloadQueued?.id
        }));
        return;
    }

    // Create operation ID
    const opId = `op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    manager.startOperation(opId);
    
    // Create helpers object for the plugin
    const helpers = {
        isIPWhitelisted,
        checkRateLimit,
        config: plugin.config
    };
    
    try {
        // Call the plugin handler
        await handler(req, res, helpers);
    } catch (error) {
        global.consoleLog('Kore', `ERROR in plugin ${plugin.name}: ${error.message}`, 1);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: `Module error: ${error.message}`
            }));
        }
    } finally {
        // End the operation and check if reload should start
        await manager.endOperation(opId);
    }
}

/**
 * HTTP endpoint for server status
 * GET /status
 */
function handleStatusRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const status = {
        status: 'running',
        meshcentral: {
            host: MESHCENTRAL_HOST,
            port: MESHCENTRAL_PORT,
            connected: global.meshWS && global.meshWS.readyState === WebSocket.OPEN
        },
        proxy: {
            port: PROXY_PORT
        },
        timestamp: getTimestamp()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
}

/**
 * HTTP endpoint for plugin operation status
 * GET /api/plugins/status
 */
function handlePluginsStatusRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const status = {};
    for (const plugin of global.Plugins.listPlugins()) {
        const manager = global.Plugins.getOperationManager(plugin.name);
        if (manager) {
            status[plugin.name] = manager.getStatus();
        }
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
}

/**
 * HTTP endpoint for reloading a plugin
 * POST /api/plugins/:name/reload?force=true
 */
async function handleReloadPluginRequest(req, res, pluginName) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const manager = global.Plugins.getOperationManager(pluginName);
    if (!manager) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Plugin not found' }));
        return;
    }

    const urlParams = new URL(req.url, 'http://localhost').searchParams;
    const force = urlParams.get('force') === 'true';

    const reloadId = await manager.enqueueReload(force);

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        reloadId: reloadId,
        message: force ? 'Force reload queued' : 'Reload queued',
        waitingFor: manager.activeOperations.size,
        status: manager.getStatus()
    }));
}

/**
 * HTTP endpoint for reload status
 * GET /api/plugins/:name/reload/:id/status
 */
function handleReloadStatusRequest(req, res, pluginName, reloadId) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const manager = global.Plugins.getOperationManager(pluginName);

    if (!manager) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Plugin not found' }));
        return;
    }

    const reload = manager.reloadQueued;

    if (!reload) {
        // Reload already completed
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'complete' }));
        return;
    }

    if (reload.id !== reloadId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Reload not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: manager.isReloading ? 'reloading' : 'pending',
        waitingFor: manager.activeOperations.size,
        operationIds: Array.from(manager.activeOperations),
        queuedSince: Date.now() - reload.queuedAt
    }));
}

/**
 * HTTP endpoint for reloading all plugins
 * POST /api/plugins/reload-all?force=true
 */
async function handleReloadAllPluginsRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const urlParams = new URL(req.url, 'http://localhost').searchParams;
    const force = urlParams.get('force') === 'true';

    const results = {};
    for (const plugin of global.Plugins.listPlugins()) {
        const manager = global.Plugins.getOperationManager(plugin.name);
        if (manager) {
            results[plugin.name] = await manager.enqueueReload(force);
        }
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        message: 'Reload queued for all plugins',
        reloads: results
    }));
}

/**
 * Query Engine for node filtering
 * Supports: CONTAINS, EQUALS, NOT_CONTAINS, STARTS_WITH, ENDS_WITH
 * Logical operators: AND, OR with parentheses support
 */

class QueryParser {
    constructor(queryString) {
        this.queryString = queryString;
        this.tokens = [];
        this.pos = 0;
    }

    tokenize() {
        const queryString = this.queryString.trim();
        const tokens = [];
        let i = 0;

        while (i < queryString.length) {
            const char = queryString[i];

            // Skip whitespace
            if (/\s/.test(char)) {
                i++;
                continue;
            }

            // Parentheses
            if (char === '(' || char === ')') {
                tokens.push(char);
                i++;
                continue;
            }

            // Quoted strings
            if (char === '"') {
                i++;
                let value = '';
                while (i < queryString.length && queryString[i] !== '"') {
                    value += queryString[i];
                    i++;
                }
                if (i < queryString.length) i++; // Skip closing quote
                tokens.push({ type: 'STRING', value });
                continue;
            }

            // Words (field names, operators, logical operators)
            let word = '';
            while (i < queryString.length && /[a-zA-Z0-9_.]/.test(queryString[i])) {
                word += queryString[i];
                i++;
            }

            if (word) {
                const upper = word.toUpperCase();
                if (['CONTAINS', 'EQUALS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH'].includes(upper)) {
                    tokens.push({ type: 'OPERATOR', value: upper });
                } else if (['AND', 'OR'].includes(upper)) {
                    tokens.push({ type: 'LOGICAL', value: upper });
                } else {
                    tokens.push({ type: 'FIELD', value: word });
                }
                continue;
            }

            i++;
        }

        this.tokens = tokens;
        return tokens;
    }

    parse() {
        this.tokenize();
        this.pos = 0;
        return this.parseOr();
    }

    parseOr() {
        let left = this.parseAnd();

        while (this.pos < this.tokens.length && this.peekLogical() === 'OR') {
            this.consume('OR');
            const right = this.parseAnd();
            left = { type: 'OR', left, right };
        }

        return left;
    }

    parseAnd() {
        let left = this.parseComparison();

        while (this.pos < this.tokens.length && this.peekLogical() === 'AND') {
            this.consume('AND');
            const right = this.parseComparison();
            left = { type: 'AND', left, right };
        }

        return left;
    }

    parseComparison() {
        // Handle parentheses
        if (this.peek() === '(') {
            this.consume('(');
            const expr = this.parseOr();
            this.consume(')');
            return expr;
        }

        const field = this.consumeField();
        const operator = this.consumeOperator();
        const value = this.consumeString();

        return { type: 'COMPARISON', field, operator, value };
    }

    peek() {
        if (this.pos < this.tokens.length) {
            const token = this.tokens[this.pos];
            if (typeof token === 'string') return token;
            return token.value;
        }
        return null;
    }

    peekLogical() {
        if (this.pos < this.tokens.length) {
            const token = this.tokens[this.pos];
            if (token.type === 'LOGICAL') return token.value;
        }
        return null;
    }

    consume(expected) {
        const token = this.tokens[this.pos];
        const value = typeof token === 'string' ? token : token.value;
        if (value !== expected) {
            throw new Error(`Expected "${expected}", got "${value}"`);
        }
        this.pos++;
    }

    consumeField() {
        if (this.pos >= this.tokens.length || this.tokens[this.pos].type !== 'FIELD') {
            throw new Error('Expected field name');
        }
        return this.tokens[this.pos++].value;
    }

    consumeOperator() {
        if (this.pos >= this.tokens.length || this.tokens[this.pos].type !== 'OPERATOR') {
            throw new Error('Expected operator');
        }
        return this.tokens[this.pos++].value;
    }

    consumeString() {
        if (this.pos >= this.tokens.length || this.tokens[this.pos].type !== 'STRING') {
            throw new Error('Expected string value');
        }
        return this.tokens[this.pos++].value;
    }
}

class QueryEvaluator {
    evaluate(ast, node, mesh = null) {
        if (ast.type === 'OR') {
            return this.evaluate(ast.left, node, mesh) || this.evaluate(ast.right, node, mesh);
        }

        if (ast.type === 'AND') {
            return this.evaluate(ast.left, node, mesh) && this.evaluate(ast.right, node, mesh);
        }

        if (ast.type === 'COMPARISON') {
            return this.evaluateComparison(ast, node, mesh);
        }

        throw new Error(`Unknown AST node type: ${ast.type}`);
    }

    evaluateComparison(comp, node, mesh = null) {
        const fieldValue = this.getFieldValue(comp.field, node, mesh);
        if (fieldValue === null || fieldValue === undefined) {
            return false;
        }

        const value = String(fieldValue).toLowerCase();
        const expected = comp.value.toLowerCase();

        switch (comp.operator) {
            case 'CONTAINS':
                return value.includes(expected);
            case 'NOT_CONTAINS':
                return !value.includes(expected);
            case 'EQUALS':
                return value === expected;
            case 'STARTS_WITH':
                return value.startsWith(expected);
            case 'ENDS_WITH':
                return value.endsWith(expected);
            default:
                throw new Error(`Unknown operator: ${comp.operator}`);
        }
    }

    getFieldValue(fieldName, node, mesh = null) {
        // Determine which object to query
        let targetObject = null;
        let pathName = fieldName;

        // Check for explicit prefixes (mesh.*, node.*, or plain)
        if (fieldName.startsWith('mesh.')) {
            if (!mesh) {
                return null; // Can't query mesh if no mesh context
            }
            targetObject = mesh;
            pathName = fieldName.substring(5); // Remove 'mesh.' prefix
        } else if (fieldName.startsWith('node.')) {
            targetObject = node;
            pathName = fieldName.substring(5); // Remove 'node.' prefix
        } else {
            // Plain field name - default to node
            targetObject = node;
        }

        // Navigate the path
        const parts = pathName.split('.');
        let value = targetObject;

        for (const part of parts) {
            if (value === null || value === undefined) {
                return null;
            }
            value = value[part];
        }

        return value;
    }
}

/**
 * Enrich nodes with mesh metadata
 * @param {Object} nodesData - Nodes organized by mesh name
 * @param {Object} meshesData - Raw meshes data from MeshCentral
 * @returns {Object} Nodes with mesh data attached
 */
function enrichNodesWithMeshData(nodesData, meshesData) {
    // Build mesh lookup: meshId (from mesh._id) → mesh object
    const meshLookup = {};
    
    if (meshesData && meshesData.meshes && Array.isArray(meshesData.meshes)) {
        for (const mesh of meshesData.meshes) {
            if (mesh && mesh._id) {
                meshLookup[mesh._id] = mesh;
                console.log(`[${getTimestamp()}] Added mesh to lookup:`, mesh._id.substring(0, 40), `name=${mesh.name}`);
            }
        }
    }

    console.log(`[${getTimestamp()}] Built mesh lookup with ${Object.keys(meshLookup).length} meshes`);
    
    // Log all fields from first mesh for debugging
    if (Object.keys(meshLookup).length > 0) {
        const firstMeshId = Object.keys(meshLookup)[0];
        const firstMesh = meshLookup[firstMeshId];
        console.log(`[${getTimestamp()}] Sample mesh fields:`, Object.keys(firstMesh));
        console.log(`[${getTimestamp()}] Sample mesh data:`, JSON.stringify(firstMesh).substring(0, 800));
    }

    // Attach mesh data to each node
    const enriched = {};
    for (const [meshName, nodes] of Object.entries(nodesData)) {
        console.log(`[${getTimestamp()}] Processing mesh: ${meshName.substring(0, 50)}`);
        
        enriched[meshName] = nodes.map(node => {
            // meshName IS the mesh ID - it's the key from the nodes response
            if (meshLookup[meshName]) {
                console.log(`[${getTimestamp()}]   Node ${node.name}: found mesh in lookup (${meshLookup[meshName].name})`);
                node.mesh = meshLookup[meshName];
            } else {
                console.log(`[${getTimestamp()}]   Node ${node.name}: mesh not in lookup, using meshName fallback`);
                node.mesh = { name: meshName };
            }

            return node;
        });
    }

    return enriched;
}

function filterNodesByQuery(nodesData, queryString) {
    if (!queryString || queryString.trim() === '') {
        return nodesData;
    }

    try {
        const parser = new QueryParser(queryString);
        const ast = parser.parse();
        const evaluator = new QueryEvaluator();

        const filtered = {};

        // nodesData is organized by mesh group
        let firstNode = null;
        for (const [meshName, nodes] of Object.entries(nodesData)) {
            // Log first node structure for debugging
            if (!firstNode && nodes.length > 0) {
                firstNode = nodes[0];
                console.log(`[${getTimestamp()}] Sample node fields:`, Object.keys(firstNode));
            }
            
            const matchingNodes = nodes.filter(node => {
                // Use mesh data attached to the node during enrichment
                const meshContext = node.mesh || { name: meshName };
                
                return evaluator.evaluate(ast, node, meshContext);
            });
            
            if (matchingNodes.length > 0) {
                filtered[meshName] = matchingNodes;
            }
        }

        return filtered;
    } catch (error) {
        console.error(`[${getTimestamp()}] Query parsing error:`, error.message);
        throw new Error(`Invalid query: ${error.message}`);
    }
}

/**
 * HTTP endpoint for retrieving nodes with optional filtering
 * POST /nodes
 */
async function handleNodesRequest(req, res) {
    global.consoleLog('Kore', '=== ENTERING handleNodesRequest ===', 4);
    global.consoleLog('Kore', `Method: ${req.method}, URL: ${req.url}`, 4);
    
    // CORS headers
    global.consoleLog('Kore', 'Setting CORS headers', 4);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');

    if (req.method === 'OPTIONS') {
        global.consoleLog('Kore', 'Handling OPTIONS request', 4);
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        global.consoleLog('Kore', `Error: Non-POST method: ${req.method}`, 2);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        return;
    }

    let body = '';
    req.on('data', (chunk) => {
        body += chunk.toString();
        if (body.length > 1e6) {
            req.connection.destroy();
        }
    });

    req.on('end', async () => {
        try {
            const params = body ? JSON.parse(body) : {};
            
            if (!params.user) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing user parameter' }));
                return;
            }

            // Validate session token
            const sessionToken = req.headers['x-session-token'];
            const validation = await validateSessionAndGetCredentials(sessionToken, params.user);
            
            if (!validation.valid) {
                global.consoleLog('Kore', `Nodes request rejected: ${validation.error}`, 2);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: validation.error }));
                return;
            }

            global.consoleLog('Kore', `Nodes request from user: ${validation.user}`, 3);

            // Get or create WebSocket connection
            if (!ENABLE_MESHCENTRAL) {
                res.writeHead(503);
                res.end(JSON.stringify({ error: 'MeshCentral is disabled' }));
                return;
            }
            
            if (!global.meshWS || global.meshWS.readyState !== WebSocket.OPEN) {
                global.consoleLog('Kore', 'Creating new WebSocket connection for nodes request...', 4);
                const cookie = await getSessionCookie(validation.meshUser, validation.meshPass);
                global.consoleLog('Kore', 'Got session cookie, connecting WebSocket...', 4);
                global.meshWS = await connectToMeshCentral(cookie);
                global.consoleLog('Kore', 'WebSocket connected, setting up message handler...', 4);
                try {
                    setupMessageHandler(global.meshWS);
                    global.consoleLog('Kore', '[IMMEDIATE] setupMessageHandler returned, now proceeding', 4);
                } catch (e) {
                    global.consoleLog('Kore', `[ERROR] Exception in setupMessageHandler: ${e.message} ${e.stack}`, 1);
                    throw e;
                }
            } else {
                global.consoleLog('Kore', 'Reusing existing WebSocket connection', 4);
            }

            global.consoleLog('Kore', '[CHECKPOINT 1] Past setupMessageHandler, about to send nodes request', 4);
            
            // Request nodes list (required)
            try {
                global.consoleLog('Kore', '[CHECKPOINT 2] Calling sendNodesRequest', 4);
                const nodesResult = await sendNodesRequest(global.meshWS);
                global.consoleLog('Kore', '[CHECKPOINT 3] Got nodes response', 4);
                
                // Extract the nodes from the response
                let nodesData = nodesResult.nodes || nodesResult;
                
                // Try to get mesh metadata (non-blocking, optional)
                let meshesResult = null;
                try {
                    global.consoleLog('Kore', 'Requesting mesh metadata...', 4);
                    meshesResult = await Promise.race([
                        sendMeshesRequest(global.meshWS),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Meshes timeout')), 5000))
                    ]);
                    global.consoleLog('Kore', 'Got meshes response', 4);
                } catch (meshError) {
                    global.consoleLog('Kore', `Mesh enrichment failed (non-fatal): ${meshError.message}`, 2);
                    meshesResult = null;
                }
                
                // Enrich nodes with mesh metadata if available
                if (meshesResult) {
                    global.consoleLog('Kore', 'Enriching nodes with mesh metadata', 4);
                    nodesData = enrichNodesWithMeshData(nodesData, meshesResult);
                    global.consoleLog('Kore', 'Nodes enriched successfully', 4);
                } else {
                    global.consoleLog('Kore', 'Skipping mesh enrichment (no mesh data available)', 4);
                }
                
                // Apply query filter if provided
                if (params.query) {
                    global.consoleLog('Kore', `Applying query filter: ${params.query.substring(0, 100)}...`, 4);
                    nodesData = filterNodesByQuery(nodesData, params.query);
                    global.consoleLog('Kore', 'Query filter applied successfully', 4);
                }
                
                global.consoleLog('Kore', 'Writing response header (200)', 4);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                global.consoleLog('Kore', 'Sending response body', 4);
                res.end(JSON.stringify({
                    success: true,
                    result: nodesData,
                    timestamp: getTimestamp()
                }));
                global.consoleLog('Kore', 'Response sent successfully', 3);
            } catch (nodeError) {
                global.consoleLog('Kore', `[ERROR] Exception during nodes request: ${nodeError.message} ${nodeError.stack}`, 1);
                throw nodeError;
            }
        } catch (error) {
            global.consoleLog('Kore', `Nodes request error: ${error.message}`, 1);
            global.consoleLog('Kore', `Error stack: ${error.stack}`, 1);
            
            global.consoleLog('Kore', 'Writing error response (500)', 4);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: error.message,
                timestamp: getTimestamp()
            }));
        }
    });
}

/**
 * Send meshes action to MeshCentral
 * Note: MeshCentral meshes response doesn't echo responseid, so we use a resolver queue
 * @param {WebSocket} ws - WebSocket connection to MeshCentral
 * @returns {Promise<Object>} Meshes data
 */
function sendMeshesRequest(ws) {
    console.log(`[${getTimestamp()}] [DEBUG] sendMeshesRequest called`);
    return new Promise((resolve, reject) => {
        const responseId = `meshes_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const command = {
            action: 'meshes',
            responseid: responseId  // We send it but MC won't echo it back
        };

        console.log(`[${getTimestamp()}] Sending meshes request:`, { responseid: responseId });

        // Register resolver for when meshes response arrives
        pendingMeshesResolvers.push(resolve);

        const timeout = setTimeout(() => {
            // Remove this resolver from queue if timeout fires
            const index = pendingMeshesResolvers.indexOf(resolve);
            if (index > -1) {
                pendingMeshesResolvers.splice(index, 1);
            }
            reject(new Error(`Meshes request timeout (${responseId})`));
        }, 5000);  // 5 second timeout for meshes

        try {
            ws.send(JSON.stringify(command));
        } catch (err) {
            // Remove this resolver if send fails
            const index = pendingMeshesResolvers.indexOf(resolve);
            if (index > -1) {
                pendingMeshesResolvers.splice(index, 1);
            }
            clearTimeout(timeout);
            reject(new Error(`Failed to send meshes request: ${err.message}`));
        }
    });
}

/**
 * Send nodes action to MeshCentral
 * @param {WebSocket} ws - WebSocket connection to MeshCentral
 * @returns {Promise<Object>} Nodes data organized by mesh
 */
function sendNodesRequest(ws) {
    console.log(`[${getTimestamp()}] [DEBUG] sendNodesRequest called`);
    return new Promise((resolve, reject) => {
        console.log(`[${getTimestamp()}] [DEBUG] Creating promise for nodes request`);
        const responseId = `nodes_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Build nodes message
        const command = {
            action: 'nodes',
            responseid: responseId
        };

        console.log(`[${getTimestamp()}] Sending nodes request:`, { responseid: responseId });

        // Set timeout for response
        const timeout = setTimeout(() => {
            delete pendingResponses[responseId];
            reject(new Error(`Nodes request timeout (${responseId})`));
        }, 90000); // 90 second timeout for slow internal requests

        // Store response handler
        pendingResponses[responseId] = {
            resolve: (data) => {
                clearTimeout(timeout);
                delete pendingResponses[responseId];
                resolve(data);
            },
            reject: (err) => {
                clearTimeout(timeout);
                delete pendingResponses[responseId];
                reject(err);
            }
        };

        try {
            ws.send(JSON.stringify(command));
        } catch (err) {
            clearTimeout(timeout);
            delete pendingResponses[responseId];
            reject(new Error(`Failed to send nodes request: ${err.message}`));
        }
    });
}


// Helper function to flatten nested objects (e.g., company.id -> company_id)
function flattenObject(obj, prefix = '') {
    const flattened = {};
    
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const value = obj[key];
            const newKey = prefix ? `${prefix}_${key}` : key;
            
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                // Recursively flatten nested objects
                Object.assign(flattened, flattenObject(value, newKey));
            } else {
                // Add primitive values and arrays as-is
                flattened[newKey] = value;
            }
        }
    }
    
    return flattened;
}

// ===== CWM API Handler (ConnectWise Manage) =====
// ===== CWM API Handler now in /psa-cwm module =====

/**
 * Generalized static file server with configurable base paths and allowed extensions
 * Handles security, content-type detection, and error handling for multiple file repositories
 */
/**
 * Generalized static file server with configurable base paths and allowed extensions
 * DEPRECATED: This functionality has been moved to web.js
 */
// Removed - see web.js for serveStaticFile implementation

const certPath = 'D:\\Kore\\Certs\\webserver-cert-public.crt';
const keyPath = 'D:\\Kore\\Certs\\webserver-cert-private.key';

let serverOptions = null;
try {
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    
    // Try to load CA bundle for full certificate chain (ZeroSSL requires this)
    const caPath = 'D:\\Kore\\Certs\\ca_bundle.crt';
    let ca = null;
    try {
        ca = fs.readFileSync(caPath, 'utf8');
        global.consoleLog('Kore', `CA bundle loaded from ${caPath}`, 3);
    } catch (caErr) {
        global.consoleLog('Kore', `WARNING: CA bundle not found at ${caPath} - cert chain may be incomplete`, 2);
    }
    
    serverOptions = {
        cert: cert,
        key: key
    };
    
    // Add CA chain if available
    if (ca) {
        serverOptions.ca = ca;
    }
    
    global.consoleLog('Kore', 'SSL certificate loaded from ZeroSSL (app.equinoxits.com)', 3);
} catch (err) {
    global.consoleLog('Kore', `ERROR: Could not load certificate: ${err.message}`, 1);
    global.consoleLog('Kore', `Cert path: ${certPath}`, 1);
    global.consoleLog('Kore', `Key path: ${keyPath}`, 1);
    process.exit(1);
}

const requestHandler = async (req, res) => {
    const timestamp = `[${getTimestamp()}]`;
    
    // Minimal logging for important requests only (auth, errors, etc)
    // Static files and routine requests are not logged

    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MeshCentral-User, X-MeshCentral-Pass, X-Kore-Token, X-Proxy-Token, X-Session-Token');
    
    // Add Private Network Access headers for browser security
    res.setHeader('Private-Network-Access-Allow-Origin', '*');
    res.setHeader('Private-Network-Access-Allow-Credentials', 'true');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // ===== STATIC FILE AUTH MIDDLEWARE =====
    // Protect HTML pages with session token validation
    const urlPath = req.url.split('?')[0]; // Remove query params
    if (isProtectedStaticFile(urlPath)) {
        const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        const validation = await global.auth.validateSessionToken(sessionToken);
        
        if (!validation.valid) {
            // Token invalid or expired - try to refresh
            if (sessionToken) {
                try {
                    const refreshed = await global.auth.refreshSessionToken(sessionToken);
                    
                    // Update cookie with new token
                    const cookieOptions = [
                        `sessionToken=${refreshed.sessionToken}`,
                        'Path=/',
                        'HttpOnly',
                        'Secure',
                        'SameSite=Strict',
                        `Max-Age=${global.auth.config.session.sessionTokenExpiryMinutes * 60}`
                    ];
                    res.setHeader('Set-Cookie', cookieOptions.join('; '));
                    
                    // Validate new token
                    const newValidation = await global.auth.validateSessionToken(refreshed.sessionToken);
                    
                    if (newValidation.valid) {
                        req.userId = newValidation.userId;
                        // Continue to the requested page
                    } else {
                        // New token also invalid, redirect to login
                        const redirectUrl = `/login?redirect=${encodeURIComponent(req.url)}`;
                        res.writeHead(302, { 'Location': redirectUrl });
                        res.end();
                        return;
                    }
                } catch (err) {
                    // Refresh failed (outside 7-day window, etc), redirect to login
                    console.log(`[${getTimestamp()}] Auth token refresh failed for ${urlPath}: ${err.message}`);
                    const redirectUrl = `/login?redirect=${encodeURIComponent(req.url)}`;
                    res.writeHead(302, { 'Location': redirectUrl });
                    res.end();
                    return;
                }
            } else {
                // No sessionToken, but check if we have refreshToken
                const refreshToken = getRefreshTokenFromCookies(req.headers.cookie);
                
                if (refreshToken) {
                    try {
                        const refreshed = await global.auth.refreshSessionTokenWithRefreshToken(refreshToken);
                        
                        // Update cookie with new sessionToken
                        const cookieOptions = [
                            `sessionToken=${refreshed.sessionToken}`,
                            'Path=/',
                            'HttpOnly',
                            'Secure',
                            'SameSite=Strict',
                            `Max-Age=${global.auth.config.session.sessionTokenExpiryMinutes * 60}`
                        ];
                        res.setHeader('Set-Cookie', cookieOptions.join('; '));
                        
                        req.userId = refreshed.userId;
                        // Continue to the requested page
                    } catch (err) {
                        console.log(`[${getTimestamp()}] Auth refresh token refresh failed for ${urlPath}: ${err.message}`);
                        const redirectUrl = `/login?redirect=${encodeURIComponent(req.url)}`;
                        res.writeHead(302, { 'Location': redirectUrl });
                        res.end();
                        return;
                    }
                } else {
                    // No token at all, redirect to login
                    const redirectUrl = `/login?redirect=${encodeURIComponent(req.url)}`;
                    res.writeHead(302, { 'Location': redirectUrl });
                    res.end();
                    return;
                }
            }
        } else {
            // Token is valid, store userId in request for later use
            req.userId = validation.userId;
        }
    }
    
    // Route auth requests (auth.js handles internally)
    const { routeAuthRequest } = require('./auth/auth');
    if (routeAuthRequest(req, res)) {
        return;
    }

    // Route API requests (new /api/* endpoints)
    if (routeApiRequest(req, res)) {
        return;
    }

    // Route requests
    if (req.url === '/auth' || req.url.startsWith('/auth?')) {
        /**
         * DEPRECATED: /auth endpoint is deprecated for future removal
         * New code should use: POST /api/auth/validate
         * 
         * This endpoint validates API keys for external systems.
         * It will be moved to the API subsystem and the /auth route will be removed
         * once all external callers have been migrated to /api/auth/validate
         * 
         * Current behavior: Validates x-kore-token or x-proxy-token header + origin/domain
         */
        handleAuthRequest(req, res);
    } else if (req.url === '/validate' || req.url.startsWith('/validate?')) {
        /**
         * DEPRECATED: /validate endpoint is deprecated for future removal
         * New code should use: POST /api/auth/validate-token
         * 
         * This endpoint validates session tokens using legacy file-based storage.
         * It will be removed once all external callers have migrated to JWT-based
         * authentication via auth.js or /api/auth/validate-token
         * 
         * Current behavior: Validates x-session-token header against sessions.json
         */
        handleValidateSession(req, res);
    } else if (req.url === '/status') {
        handleStatusRequest(req, res);
    } else if (req.url === '/api/plugins/status') {
        handlePluginsStatusRequest(req, res);
    } else if (req.url.startsWith('/api/plugins/') && req.url.includes('/reload')) {
        // Parse reload endpoints: /api/plugins/:name/reload or /api/plugins/:name/reload/:id/status
        const urlParts = req.url.split('?')[0].split('/').filter(p => p);
        // urlParts: ['api', 'plugins', ':name', 'reload', ':id', 'status']
        
        if (req.method === 'POST' && req.url.startsWith('/api/plugins/reload-all')) {
            handleReloadAllPluginsRequest(req, res);
        } else if (req.method === 'POST' && urlParts.length === 4 && urlParts[3] === 'reload') {
            // POST /api/plugins/:name/reload
            const pluginName = urlParts[2];
            handleReloadPluginRequest(req, res, pluginName);
        } else if (req.method === 'GET' && urlParts.length === 6 && urlParts[3] === 'reload' && urlParts[5] === 'status') {
            // GET /api/plugins/:name/reload/:id/status
            const pluginName = urlParts[2];
            const reloadId = urlParts[4];
            handleReloadStatusRequest(req, res, pluginName, reloadId);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Endpoint not found' }));
        }
    } else if (req.url === '/kore/admin/reload-auth' || req.url.startsWith('/kore/admin/reload-subsystem')) {
        handleReloadSubsystem(req, res);
    } else if (req.url === '/kore/admin/reload-api-members') {
        handleReloadApiMembers(req, res);
    } else if (req.url === '/kore/admin/system-health/modules') {
        handleSystemHealthModules(req, res);
    } else if (req.url === '/kore/admin/system-health') {
        handleSystemHealth(req, res);
    } else if (req.url.startsWith('/kore/email/smtp')) {
        handleSendEmail(req, res);
    } else if (req.url === '/kore/plugins/list') {
        handleListPlugins(req, res);
    } else if (req.url.startsWith('/kore/plugins/add')) {
        handleAddPlugin(req, res);
    } else if (req.url.startsWith('/kore/plugins/details')) {
        handleGetPluginDetails(req, res);
    } else if (req.url.startsWith('/kore/plugins/update')) {
        handleUpdatePlugin(req, res);
    } else if (req.url.startsWith('/kore/plugins/load')) {
        handleLoadPlugin(req, res);
    } else if (req.url === '/kore/plugins/reload-all') {
        handleReloadAllPlugins(req, res);
    } else if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
    } else if (req.url.startsWith('/node_modules/')) {
        // Node modules handled by web.js
        await Web.handleRoute(req, res);
    } else if (await global.Plugins.handleRoute(req, res)) {
        // Route handled by Plugins module
    } else if (global.Plugins.getHandler(req.url.split('?')[0])) {
        // Route to loaded plugins (check before Persephone)
        handlePluginRequest(req, res);
    } else if (global.Resources.handleRoute(req, res)) {
        // Route handled by Resources module (workflows, forms, etc.)
    } else if (req.url.startsWith('/engine/')) {
        // Route to Persephone execution engine
        global.Persephone.handleRequest(req, res);
    } else if (await Web.handleRoute(req, res)) {
        // Route handled by web module (dynamic pages, static files, libraries)
    } else {
        // No route found
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
};

const server = https.createServer(serverOptions, requestHandler);
const server443 = https.createServer(serverOptions, requestHandler);

server.on('connection', (socket) => {
    global.consoleLog('Kore', '*** NEW CONNECTION ATTEMPT (1139) ***', 4);
    global.consoleLog('Kore', `Remote: ${socket.remoteAddress}:${socket.remotePort}`, 4);
});

server443.on('connection', (socket) => {
    global.consoleLog('Kore', '*** NEW CONNECTION ATTEMPT (443) ***', 4);
    global.consoleLog('Kore', `Remote: ${socket.remoteAddress}:${socket.remotePort}`, 4);
});

server443.on('tlsClientHello', (hello) => {
    const serverName = hello.servername || 'unknown';
    const cipherSuites = hello.cipherSuites ? hello.cipherSuites.length : 0;
    const tlsVersion = hello.tlsVersion ? `TLS ${hello.tlsVersion}` : 'unknown';
    global.consoleLog('Kore', `TLS ClientHello (443) - Server: ${serverName}, Ciphers: ${cipherSuites}, Version: ${tlsVersion}`, 4);
});

server.on('clientError', (err, socket) => {
    global.consoleLog('Kore', '*** CLIENT ERROR (1139) ***', 1);
    global.consoleLog('Kore', `Error Code: ${err.code}`, 1);
    global.consoleLog('Kore', `Error Message: ${err.message}`, 1);
    global.consoleLog('Kore', `Remote Address: ${socket.remoteAddress}:${socket.remotePort}`, 1);
    global.consoleLog('Kore', `Full Error: ${JSON.stringify(err)}`, 1);
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

server443.on('clientError', (err, socket) => {
    global.consoleLog('Kore', '*** CLIENT ERROR (443) ***', 1);
    global.consoleLog('Kore', `Error Code: ${err.code}`, 1);
    global.consoleLog('Kore', `Error Message: ${err.message}`, 1);
    global.consoleLog('Kore', `Remote Address: ${socket.remoteAddress}:${socket.remotePort}`, 1);
    global.consoleLog('Kore', `Full Error: ${JSON.stringify(err)}`, 1);
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

server.on('secureConnection', (tlsSocket) => {
    global.consoleLog('Kore', `TLS connection established (1139) from ${tlsSocket.remoteAddress}:${tlsSocket.remotePort}`, 3);
    
    // Set socket timeout to 90 seconds to allow slow internal HTTP requests to MeshCentral
    tlsSocket.setTimeout(90000, () => {
        global.consoleLog('Kore', `Socket timeout from ${tlsSocket.remoteAddress} - destroying`, 1);
        tlsSocket.destroy();
    });
    
    tlsSocket.on('data', (data) => {
        // Socket data received - no verbose logging for routine requests
    });
    
    tlsSocket.on('error', (err) => {
        global.consoleLog('Kore', `TLS socket error (1139): ${err.message}`, 1);
    });
    
    tlsSocket.on('close', () => {
        global.consoleLog('Kore', 'TLS socket closed (1139)', 3);
    });
});

server443.on('secureConnection', (tlsSocket) => {
    global.consoleLog('Kore', `TLS connection established (443) from ${tlsSocket.remoteAddress}:${tlsSocket.remotePort}`, 3);
    
    // Set socket timeout to 90 seconds to allow slow internal HTTP requests to MeshCentral
    tlsSocket.setTimeout(90000, () => {
        global.consoleLog('Kore', `Socket timeout from ${tlsSocket.remoteAddress} - destroying`, 1);
        tlsSocket.destroy();
    });
    
    tlsSocket.on('data', (data) => {
        // Socket data received - no verbose logging for routine requests
    });
    
    tlsSocket.on('error', (err) => {
        global.consoleLog('Kore', `TLS socket error (443): ${err.message}`, 1);
    });
    
    tlsSocket.on('close', () => {
        global.consoleLog('Kore', 'TLS socket closed (443)', 3);
    });
});

// Start servers on both ports
server.listen(PROXY_PORT, '0.0.0.0', async () => {
    global.consoleLog('Kore', `Proxy server listening on HTTPS://0.0.0.0:${PROXY_PORT} (1139)`, 3);
    
    // Initialize MySQL pool
    await initializeMySQLPool();
    
    // Helper to initialize subsystems (used for startup and reload)
    const initializeSubsystem = async (name) => {
        try {
            switch (name) {
                case 'resources':
                    delete require.cache[require.resolve('./resources/resources')];
                    global.Resources = require('./resources/resources');
                    await global.Resources.initialize();
                    break;
                    
                case 'auth':
                    delete require.cache[require.resolve('./auth/auth')];
                    const [configRows] = await korePool.query('SELECT security_config FROM system_config WHERE id = 1');
                    const securityConfig = configRows[0]?.security_config || {};
                    const Auth = require('./auth/auth');
                    global.auth = new Auth(korePool, global.cryptoUtils, securityConfig, logAudit, process.env.JWT_SIGNING_KEY);
                    await global.auth.initialize();
                    break;
                    
                case 'api':
                    delete require.cache[require.resolve('./api/api')];
                    const API = require('./api/api');
                    global.API = new API(korePool);
                    await global.API.initialize();
                    break;
                    
                case 'web':
                    const Web = require('./web/web');
                    global.Web = Web;
                    await global.Web.initialize(korePool);
                    break;
                    
                case 'persephone':
                    const Persephone = require('./persephone/persephone');
                    global.Persephone = Persephone;
                    await global.Persephone.initialize(korePool, global.Plugins);
                    global.Persephone.initialized = true;
                    break;
                    
                case 'plugins':
                    const Plugins = require('./plugins/plugins');
                    global.Plugins = Plugins;
                    await global.Plugins.initialize(korePool, getTimestamp, isIPWhitelisted, checkRateLimit);
                    await global.Plugins.loadAllPlugins();
                    break;
            }
            
            return { success: true, subsystem: name };
            
        } catch (err) {
            global.consoleLog('Kore', `ERROR initializing ${name}: ${err.message}`, 1);
            return { success: false, subsystem: name, error: err.message };
        }
    };
    
    // Initialize all subsystems in dependency order: Resources -> Auth -> API -> Web -> Persephone -> Plugins
    const initResults = [];
    initResults.push(await initializeSubsystem('resources'));
    
    // Load API members cache after resources is initialized (so korePool exists)
    await loadApiMembersCache();
    
    initResults.push(await initializeSubsystem('auth'));
    initResults.push(await initializeSubsystem('api'));
    initResults.push(await initializeSubsystem('web'));
    initResults.push(await initializeSubsystem('persephone'));
    initResults.push(await initializeSubsystem('plugins'));
    
    // Log summary
    const succeeded = initResults.filter(r => r.success).map(r => r.subsystem);
    const failed = initResults.filter(r => !r.success).map(r => r.subsystem);
    
    if (failed.length === 0) {
        global.consoleLog('Kore', `✓ All ${succeeded.length} subsystems initialized: ${succeeded.join(', ')}`, 3);
    } else {
        global.consoleLog('Kore', `✓ ${succeeded.length} subsystems initialized: ${succeeded.join(', ')}`, 3);
        global.consoleLog('Kore', `✗ ${failed.length} subsystems failed: ${failed.join(', ')}`, 1);
    }
});

server443.listen(443, '0.0.0.0', () => {
    global.consoleLog('Kore', 'Proxy server listening on HTTPS://0.0.0.0:443', 3);
});

// ===== DIAGNOSTIC SERVER ON PORT 1140 (Testing with Rewst support - can be removed) =====
const server1140 = https.createServer(serverOptions, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'open',
        port: 1140,
        timestamp: getTimestamp(),
        message: 'Port 1140 is open and responding'
    }));
});

server1140.listen(1140, '0.0.0.0', () => {
    global.consoleLog('Kore', 'Diagnostic server listening on HTTPS://0.0.0.0:1140', 3);
});

server1140.timeout = 120000;
server1140.keepAliveTimeout = 120000;

server1140.on('error', (err) => {
    global.consoleLog('Kore', `Server (1140) error: ${JSON.stringify(err)}`, 1);
});
// ===== END DIAGNOSTIC SERVER =====

// Set request timeout to prevent requests from hanging the server
server.timeout = 120000; // 120 second timeout
server.keepAliveTimeout = 120000;  // 120 seconds
server443.timeout = 120000;
server443.keepAliveTimeout = 120000;

server.on('error', (err) => {
    global.consoleLog('Kore', `Server (1139) error: ${JSON.stringify(err)}`, 1);
    process.exit(1);
});

server443.on('error', (err) => {
    global.consoleLog('Kore', `Server (443) error: ${JSON.stringify(err)}`, 1);
    process.exit(1);
});

// Global error handlers
process.on('uncaughtException', (err) => {
    global.consoleLog('Kore', `UNCAUGHT EXCEPTION: ${JSON.stringify(err)}`, 1);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    global.consoleLog('Kore', `UNHANDLED REJECTION: ${JSON.stringify(reason)}`, 1);
});
process.on('SIGTERM', () => {
    global.consoleLog('Kore', 'SIGTERM received, shutting down...', 3);
    
    // Force exit after 5 seconds if graceful shutdown takes too long
    const forceExitTimeout = setTimeout(() => {
        global.consoleLog('Kore', 'Forced exit after shutdown timeout', 1);
        process.exit(1);
    }, 5000);
    
    if (global.meshWS) {
        global.meshWS.close();
    }
    
    let closedCount = 0;
    const totalToClose = 2; // server + server443
    
    const checkAllClosed = () => {
        closedCount++;
        if (closedCount >= totalToClose) {
            clearTimeout(forceExitTimeout);
            // Close database pools
            if (mysqlPool) mysqlPool.end();
            if (cwaPool) cwaPool.end();
            if (korePool) korePool.end();
            global.consoleLog('Kore', 'Shutdown complete', 3);
            process.exit(0);
        }
    };
    
    server.close(() => {
        global.consoleLog('Kore', 'Server (1139) closed', 3);
        checkAllClosed();
    });
    
    server443.close(() => {
        console.log(`[${getTimestamp()}] Server (443) closed`);
        checkAllClosed();
    });
});

process.on('SIGINT', () => {
    console.log(`[${getTimestamp()}] SIGINT received, shutting down...`);
    
    // Force exit after 5 seconds if graceful shutdown takes too long
    const forceExitTimeout = setTimeout(() => {
        global.consoleLog('Kore', 'Forced exit after shutdown timeout', 1);
        process.exit(1);
    }, 5000);
    
    if (global.meshWS) {
        global.meshWS.close();
    }
    
    let closedCount = 0;
    const totalToClose = 2; // server + server443
    
    const checkAllClosed = () => {
        closedCount++;
        if (closedCount >= totalToClose) {
            clearTimeout(forceExitTimeout);
            // Close database pools
            if (mysqlPool) mysqlPool.end();
            if (cwaPool) cwaPool.end();
            if (korePool) korePool.end();
            global.consoleLog('Kore', 'Shutdown complete', 3);
            process.exit(0);
        }
    };
    
    server.close(() => {
        global.consoleLog('Kore', 'Server (1139) closed', 3);
        checkAllClosed();
    });
    
    server443.close(() => {
        console.log(`[${getTimestamp()}] Server (443) closed`);
        checkAllClosed();
    });
});