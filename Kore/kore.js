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
 * Persephone Automation Engine:
 *   POST   /kore/workflows               - Create new workflow
 *   GET    /kore/workflows/:id           - Get latest workflow version
 *   GET    /kore/workflows/:id/:version  - Get specific workflow version
 *   DELETE /kore/workflows/:id/:version  - Archive workflow version
 *   POST   /kore/execute                 - Execute workflow
 *   GET    /kore/executions/:executionId - Get execution status
 *   POST   /kore/executions/:executionId/cancel - Cancel execution
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const Persephone = require('./persephone/persephone');
const { handleWorkflowRequest, handleExecuteRequest, handleExecutionRequest } = require('./persephone/persephone');
const snipe = require('./modules/snipe');

// ========== SECURITY CONFIGURATION ==========
// IP Whitelist (no rate limits applied)
const IP_WHITELIST = [
    '3.139.170.31',      // Rewst US
    '13.58.15.14',       // Rewst US
    '18.218.107.198',    // Rewst US
    '192.168.141.'       // Internal subnet (any 192.168.141.x)
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
                process.stderr.write(`[${new Date().toISOString()}] Log stream error: ${err.message}\n`);
                logStream = null;
            });
            
            currentLogDate = today;
        } catch (err) {
            process.stderr.write(`[${new Date().toISOString()}] ERROR opening log stream: ${err.message}\n`);
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
            const timestamp = `[${new Date().toISOString()}]`;
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
            const timestamp = `[${new Date().toISOString()}]`;
            const output = `${timestamp} ERROR: ${message}\n`;
            
            const stream = ensureLogStream();
            if (stream && !stream.closed) {
                stream.write(output);
            }
        } catch (err) {
            // Silently ignore file write errors to avoid breaking console
        }
    };
    
    console.log(`[${new Date().toISOString()}] Kore logging initialized - ${getLogFilePath()}`);
}

// Initialize logging before anything else
initializeLogging();

// Configuration
const MESHCENTRAL_HOST = 'app.equinoxits.com';
const MESHCENTRAL_PORT = 1138;
const PROXY_PORT = 1139;
const CREDENTIALS_FILE = 'D:\\Kore\\credentials.json';
const SESSIONS_FILE = 'D:\\Kore\\sessions.json';
const LOG_FILE = 'D:\\Kore\\proxy-errors.log';

// Error logging helper
function logError(message, errorObj = null) {
    const timestamp = new Date().toISOString();
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
        console.error(`[${new Date().toISOString()}] Error writing sessions:`, error.message);
        resolve(false);
    }
    
    isWriting = false;
    if (sessionWriteQueue.length > 0) {
        setImmediate(processSessionWriteQueue);
    }
}
const MYSQL_CONFIG_FILE = 'D:\\Kore\\mysql-config.json';
const API_CONFIG_FILE = 'D:\\Kore\\api-config.json';
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
let korePool = null;     // Kore database pool (Persephone)

console.log(`[${new Date().toISOString()}] Starting MeshCentral WebSocket Proxy`);
console.log(`[${new Date().toISOString()}] MeshCentral: ${MESHCENTRAL_HOST}:${MESHCENTRAL_PORT}`);
console.log(`[${new Date().toISOString()}] Proxy listening: 0.0.0.0:${PROXY_PORT}`);

// Watchdog timer - logs health every 30 seconds to detect hangs
setInterval(() => {
    const poolCount = Object.keys(wsConnectionPool).length;
    const pendingCount = Object.keys(pendingResponses).length;
    const logMsg = `[${new Date().toISOString()}] [WATCHDOG] Proxy responsive. Pool users: ${poolCount}, Pending responses: ${pendingCount}`;
    console.log(logMsg);
}, 30000);

// Global error handlers for service stability
process.on('uncaughtException', (err) => {
    const logMsg = `[${new Date().toISOString()}] FATAL UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}\n`;
    console.error(logMsg);
    try {
        fs.appendFileSync('D:\\Kore\\error.log', logMsg);
    } catch (e) {
        console.error('Failed to write error.log:', e.message);
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

        console.log(`[${new Date().toISOString()}] Authenticating via HTTP to get session cookie...`);

        const req = https.request(options, (res) => {
            let data = '';
            
            console.log(`[${new Date().toISOString()}] HTTP Login Response Status: ${res.statusCode}`);
            console.log(`[${new Date().toISOString()}] Set-Cookie headers:`, res.headers['set-cookie']);

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
                console.log(`[${new Date().toISOString()}] Login response: ${data.substring(0, 100)}`);
                // Extract just the cookie name=value parts (before the semicolon) for all cookies
                const cookieValues = cookies.map(c => c.split(';')[0]).join('; ');
                console.log(`[${new Date().toISOString()}] Cookie values: ${cookieValues}`);
                resolve(cookieValues); // Return all cookies as Cookie header format
            });
        });

        req.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] HTTP login error:`, err.message);
            reject(err);
        });

        // Set timeout for HTTP request (60 seconds for slow internal requests)
        req.setTimeout(60000, () => {
            console.error(`[${new Date().toISOString()}] HTTP login request timeout after 60 seconds`);
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
    return new Promise((resolve, reject) => {
        const meshUrl = `wss://${MESHCENTRAL_HOST}:${MESHCENTRAL_PORT}/control.ashx`;
        const agent = new https.Agent({ rejectUnauthorized: false });

        console.log(`[${new Date().toISOString()}] Connecting to MeshCentral WebSocket with session cookie...`);

        const ws = new WebSocket(meshUrl, {
            agent,
            headers: {
                'Cookie': cookie
            }
        });

        let loginReceived = false;

        ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] WebSocket connected, sending login with token credentials...`);
            
            // Send login message with token credentials
            const loginMsg = {
                action: 'login',
                username: MESHCENTRAL_USER,
                password: MESHCENTRAL_PASS
            };
            
            ws.send(JSON.stringify(loginMsg));
            console.log(`[${new Date().toISOString()}] Login message sent with credentials`);
        });

        ws.on('message', (data) => {
            if (!loginReceived) {
                try {
                    const msg = JSON.parse(data);
                    console.log(`[${new Date().toISOString()}] Initial message from MeshCentral:`, JSON.stringify(msg).substring(0, 100));
                    
                    // Check if this is a successful login - MeshCentral sends userinfo after successful login
                    if (msg.action === 'userinfo' || msg.action === 'login') {
                        console.log(`[${new Date().toISOString()}] Login successful`);
                        loginReceived = true;
                        resolve(ws);
                    } else if (msg.action === 'close' || msg.cause) {
                        console.error(`[${new Date().toISOString()}] Login failed:`, msg.cause || msg.msg);
                        reject(new Error(`Login failed: ${msg.cause || msg.msg}`));
                    }
                } catch (e) {
                    console.log(`[${new Date().toISOString()}] Non-JSON message received`);
                }
            }
        });

        ws.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] WebSocket connection error:`, err.message);
            reject(err);
        });

        ws.on('close', () => {
            console.log(`[${new Date().toISOString()}] WebSocket disconnected from MeshCentral`);
            if (!loginReceived) {
                reject(new Error('WebSocket closed before login'));
            }
        });
    });
}

/**
 * Initialize MySQL connection pool from config file
 */
async function initializeMySQLPool() {
    try {
        // Load MySQL config
        const configJson = fs.readFileSync(MYSQL_CONFIG_FILE, 'utf8');
        const mysqlConfig = JSON.parse(configJson);
        
        console.log(`[${new Date().toISOString()}] Loading MySQL config from: ${MYSQL_CONFIG_FILE}`);
        
        // Create Rewst connection pool
        mysqlPool = mysql.createPool({
            host: mysqlConfig.rewst.host,
            port: mysqlConfig.rewst.port,
            database: mysqlConfig.rewst.database,
            user: mysqlConfig.rewst.user,
            password: mysqlConfig.rewst.password,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            enableKeepAlive: true
        });
        
        console.log(`[${new Date().toISOString()}] Rewst MySQL connection pool created (${mysqlConfig.rewst.host}:${mysqlConfig.rewst.port}/${mysqlConfig.rewst.database})`);
        
        // Create CWA connection pool
        cwaPool = mysql.createPool({
            host: mysqlConfig.cwa.host,
            port: mysqlConfig.cwa.port,
            database: mysqlConfig.cwa.database,
            user: mysqlConfig.cwa.user,
            password: mysqlConfig.cwa.password,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            enableKeepAlive: true,
            multipleStatements: true
        });
        
        console.log(`[${new Date().toISOString()}] CWA MySQL connection pool created (${mysqlConfig.cwa.host}:${mysqlConfig.cwa.port}/${mysqlConfig.cwa.database})`);
        
        // Create Kore connection pool
        korePool = mysql.createPool({
            host: mysqlConfig.kore.host,
            port: mysqlConfig.kore.port,
            database: mysqlConfig.kore.database,
            user: mysqlConfig.kore.user,
            password: mysqlConfig.kore.password,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            enableKeepAlive: true,
            multipleStatements: true
        });
        
        console.log(`[${new Date().toISOString()}] Kore MySQL connection pool created (${mysqlConfig.kore.host}:${mysqlConfig.kore.port}/${mysqlConfig.kore.database})`);
        
        // Load API config
        const apiConfigJson = fs.readFileSync(API_CONFIG_FILE, 'utf8');
        const apiConfig = JSON.parse(apiConfigJson);
        global.apiConfig = apiConfig;
        console.log(`[${new Date().toISOString()}] API config loaded from: ${API_CONFIG_FILE}`);
        console.log(`[${new Date().toISOString()}] CWM API (${apiConfig.cwm.name}) configured: ${apiConfig.cwm.baseUrl}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR initializing MySQL pools:`, error.message);
        console.error(`[${new Date().toISOString()}] MySQL config file: ${MYSQL_CONFIG_FILE}`);
        // Don't exit - MySQL is optional for now, let proxy start anyway
    }
}

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

        console.log(`[${new Date().toISOString()}] Sending runcommands:`, {
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
            console.log(`[${new Date().toISOString()}] WebSocket state before send: ${ws.readyState} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`);
            console.log(`[${new Date().toISOString()}] Attempting to send command to MeshCentral...`);
            ws.send(JSON.stringify(command));
            console.log(`[${new Date().toISOString()}] Command sent successfully to WebSocket`);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] *** WEBSOCKET SEND ERROR: ${err.message}`);
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
        console.log(`[${new Date().toISOString()}] *** RAW DATA RECEIVED: ${data.length} bytes`);
        console.log(`[${new Date().toISOString()}] First 200 chars: ${data.toString().substring(0, 200)}`);
        
        try {
            const msg = JSON.parse(data);

            // Log all messages with more detail
            console.log(`[${new Date().toISOString()}] *** RECEIVED MESSAGE ***`);
            console.log(`[${new Date().toISOString()}] Message action: ${msg.action}`);
            console.log(`[${new Date().toISOString()}] Message type: ${msg.type}`);
            console.log(`[${new Date().toISOString()}] Message responseid: ${msg.responseid}`);
            console.log(`[${new Date().toISOString()}] Full message:`, JSON.stringify(msg).substring(0, 500));

            // Check for auth errors
            if (msg.action === 'close' && msg.cause === 'noauth') {
                console.error(`[${new Date().toISOString()}] Authentication failed: noauth`);
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
                console.log(`[${new Date().toISOString()}] Received meshes response (no responseid), resolving ${pendingMeshesResolvers.length} pending promises`);
                while (pendingMeshesResolvers.length > 0) {
                    const resolver = pendingMeshesResolvers.shift();
                    resolver(msg);
                }
            }
            
            // Route response to pending request
            if (msg.responseid && pendingResponses[msg.responseid]) {
                console.log(`[${new Date().toISOString()}] Routing response to request: ${msg.responseid}`);
                
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
                console.log(`[${new Date().toISOString()}] *** UNMATCHED RESPONSEID: ${msg.responseid}, Pending responses: ${Object.keys(pendingResponses).join(', ')}`);
            } else {
                console.log(`[${new Date().toISOString()}] *** NO RESPONSEID IN MESSAGE, action: ${msg.action}, type: ${msg.type}`);
            }
        } catch (err) {
            console.error(`[${new Date().toISOString()}] *** PARSE ERROR: ${err.message}`);
            console.error(`[${new Date().toISOString()}] Failed to parse data:`, data.toString().substring(0, 200));
        }
    });

    ws.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] WebSocket error:`, err.message);
    });

    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] *** WEBSOCKET CLOSED ***`);
        console.log(`[${new Date().toISOString()}] Pending responses at close: ${Object.keys(pendingResponses).length}`);
        console.log(`[${new Date().toISOString()}] Pending response IDs: ${Object.keys(pendingResponses).join(', ')}`);
        
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
            console.error(`[${new Date().toISOString()}] Error loading sessions file:`, error.message);
            return { valid: false, error: 'Server configuration error' };
        }
        
        // Find matching session
        const session = sessionsData.sessions.find(s => s.token === sessionToken);
        
        if (!session) {
            console.log(`[${new Date().toISOString()}] Session validation failed: token not found`);
            return { valid: false, error: 'Invalid session token' };
        }
        
        // Check if session has expired
        const now = Date.now();
        if (now > session.expiresAt) {
            console.log(`[${new Date().toISOString()}] Session validation failed: token expired`);
            return { valid: false, error: 'Session token has expired' };
        }
        
        // Verify user matches
        if (session.user !== user) {
            console.log(`[${new Date().toISOString()}] Session validation failed: user mismatch`);
            return { valid: false, error: 'User mismatch' };
        }
        
        // Session is valid - return hardcoded MeshCentral credentials
        console.log(`[${new Date().toISOString()}] Session validated for user: ${session.user}`);
        return {
            valid: true,
            meshUser: MESHCENTRAL_USER,
            meshPass: MESHCENTRAL_PASS,
            user: session.user
        };
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Session validation error:`, error.message);
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
    console.log(`[${new Date().toISOString()}] [POOL] Getting connection for user: ${user}, current pool size: ${userPool.length}`);

    // Check for existing available connection
    for (const pooledConn of userPool) {
        if (pooledConn.ws && pooledConn.ws.readyState === WebSocket.OPEN && !pooledConn.isBusy) {
            console.log(`[${new Date().toISOString()}] [POOL] Reusing pooled connection for user: ${user}`);
            pooledConn.lastActivity = Date.now();
            return pooledConn;
        }
    }

    // Create new connection if under limit
    if (userPool.length < POOL_MAX_CONNECTIONS_PER_USER) {
        console.log(`[${new Date().toISOString()}] [POOL] Creating new pooled connection for user: ${user} (${userPool.length + 1}/${POOL_MAX_CONNECTIONS_PER_USER})`);
        
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
        console.log(`[${new Date().toISOString()}] [POOL] New connection created: ${pooledConn.id}`);
        
        // Set up idle timeout cleanup
        pooledConn.idleTimeout = setTimeout(() => {
            closePooledConnection(pooledConn.id);
        }, POOL_IDLE_TIMEOUT_MS);

        return pooledConn;
    }

    // If at limit, return first connection (will queue)
    console.log(`[${new Date().toISOString()}] [POOL] Connection pool at limit for user: ${user}, queuing on existing connection`);
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
            console.log(`[${new Date().toISOString()}] Closing pooled connection: ${connectionId}`);
            
            if (pooledConn.idleTimeout) {
                clearTimeout(pooledConn.idleTimeout);
            }
            
            if (pooledConn.ws && pooledConn.ws.readyState === WebSocket.OPEN) {
                try {
                    pooledConn.ws.close();
                } catch (err) {
                    console.error(`[${new Date().toISOString()}] Error closing pooled connection:`, err.message);
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
        console.log(`[${new Date().toISOString()}] [QUEUE] Command queued for user ${pooledConn.user}. Queue length: ${pooledConn.commandQueue.length}, isBusy: ${pooledConn.isBusy}`);

        // If not busy, execute immediately
        if (!pooledConn.isBusy) {
            console.log(`[${new Date().toISOString()}] [QUEUE] Connection idle, executing queued command immediately`);
            executeNextCommandInQueue(pooledConn);
        } else {
            console.log(`[${new Date().toISOString()}] [QUEUE] Connection busy, command will wait. Queue length: ${pooledConn.commandQueue.length}`);
        }
    });
}

/**
 * Execute the next command in the queue for a pooled connection
 */
async function executeNextCommandInQueue(pooledConn) {
    if (pooledConn.commandQueue.length === 0) {
        console.log(`[${new Date().toISOString()}] [EXEC] Queue empty, marking connection idle for user: ${pooledConn.user}`);
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
        console.log(`[${new Date().toISOString()}] [EXEC] Executing command from queue. Remaining: ${pooledConn.commandQueue.length}, User: ${pooledConn.user}`);
        
        const result = await sendRunCommands(pooledConn.ws, queuedCmd.commandParams);
        console.log(`[${new Date().toISOString()}] [EXEC] Command completed successfully for user: ${pooledConn.user}`);
        queuedCmd.resolve(result);
        
        // Execute next command in queue
        executeNextCommandInQueue(pooledConn);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [EXEC] Command execution error: ${error.message}`);
        queuedCmd.reject(error);
        
        // Try next command despite error
        executeNextCommandInQueue(pooledConn);
    }
}

async function handleCommandRequest(req, res) {
    const clientIP = req.socket.remoteAddress;
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Rate limit check for /command
    if (!isIPWhitelisted(clientIP)) {
        const rateLimitCheck = checkRateLimit(clientIP, '/command');
        if (!rateLimitCheck.allowed) {
            console.log(`[${new Date().toISOString()}] Rate limit exceeded for IP ${clientIP} on /command (limit: 100/min, reset in: ${rateLimitCheck.resetIn}s)`);
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

    if (req.method !== 'POST') {
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
            const commandParams = JSON.parse(body);

            // Handle optional timeout parameter (in milliseconds)
            const requestTimeout = commandParams.timeout || 30000; // Default 30 seconds
            if (typeof requestTimeout === 'number' && requestTimeout > 0) {
                req.socket.setTimeout(requestTimeout);
                console.log(`[${new Date().toISOString()}] Command request timeout set to ${requestTimeout}ms`);
            }

            // Validate required parameters
            if (!commandParams.nodeId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing nodeId parameter' }));
                return;
            }

            if (!commandParams.command) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing command parameter' }));
                return;
            }

            if (!commandParams.user) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing user parameter' }));
                return;
            }

            // Validate and normalize commandType
            if (commandParams.commandType !== undefined && commandParams.commandType !== null) {
                const cmdType = parseInt(commandParams.commandType, 10);
                if (isNaN(cmdType) || cmdType < 1 || cmdType > 4) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        error: 'Invalid commandType. Must be a number between 1-4 (1=CMD, 2=PowerShell, 3=Linux, 4=Console)',
                        received: commandParams.commandType,
                        type: typeof commandParams.commandType
                    }));
                    return;
                }
                commandParams.commandType = cmdType;
            } else {
                // Default to CMD if not specified
                commandParams.commandType = 1;
            }

            // Validate session token
            const sessionToken = req.headers['x-session-token'];
            const validation = await validateSessionAndGetCredentials(sessionToken, commandParams.user);
            
            if (!validation.valid) {
                console.log(`[${new Date().toISOString()}] Command request rejected: ${validation.error}`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: validation.error }));
                return;
            }

            console.log(`[${new Date().toISOString()}] Command request from user: ${validation.user}`);
            console.log(`[${new Date().toISOString()}] Node: ${commandParams.nodeId}, Cmd: ${commandParams.command.substring(0, 50)}`);
            console.log(`[${new Date().toISOString()}] Command type: ${commandParams.commandType} (1=CMD, 2=PowerShell, 3=Linux, 4=Console)`);

            // Get or create pooled WebSocket connection
            const pooledConn = await getOrCreatePooledConnection(validation.user, validation.meshUser, validation.meshPass);

            // Queue command on pooled connection
            const result = await queueCommandOnConnection(pooledConn, commandParams);

            console.log(`[${new Date().toISOString()}] Command response result type: ${typeof result}`);
            if (result && typeof result === 'object' && result.result) {
                console.log(`[${new Date().toISOString()}] Command response result length: ${JSON.stringify(result).length}`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                result: result,
                timestamp: new Date().toISOString()
            }));

        } catch (error) {
            console.error(`[${new Date().toISOString()}] Request error:`, error);
            console.error(`[${new Date().toISOString()}] Error message:`, error.message);
            console.error(`[${new Date().toISOString()}] Error stack:`, error.stack);
            
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: error.message,
                details: error.stack,
                timestamp: new Date().toISOString()
            }));
        }
    });
}

/**
 * Authenticate client and validate credentials
 * POST /auth
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
            console.log(`[${new Date().toISOString()}] Rate limit exceeded for IP ${clientIP} on /auth (limit: 10/min, reset in: ${rateLimitCheck.resetIn}s)`);
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
        console.log(`[${new Date().toISOString()}] WARNING: x-proxy-token header is deprecated, please use x-kore-token instead`);
    }
    
    console.log(`[${new Date().toISOString()}] === AUTH REQUEST ===`);
    console.log(`[${new Date().toISOString()}] API Key header present: ${!!apiKeyFromHeader}`);
    
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
            
            console.log(`[${new Date().toISOString()}] Origin from body: ${originFromBody}`);
            console.log(`[${new Date().toISOString()}] User from body: ${userFromBody}`);
            
            // Extract domain from user (e.g., bradf@equinoxits.com -> equinoxits.com)
            let userDomain = null;
            if (userFromBody && userFromBody.includes('@')) {
                userDomain = userFromBody.split('@')[1];
                console.log(`[${new Date().toISOString()}] Extracted user domain: ${userDomain}`);
            }
            
            // Load credentials from file
            let credentialsData;
            try {
                const credentialsJson = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
                credentialsData = JSON.parse(credentialsJson);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error loading credentials file:`, error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server configuration error' }));
                return;
            }
            
            // Find matching credential
            const validCred = credentialsData.credentials.find(c => 
                c.enabled && 
                c.key === apiKeyFromHeader && 
                c.origin === originFromBody &&
                c.domain === userDomain
            );
            
            if (!validCred) {
                console.log(`[${new Date().toISOString()}] Auth failed: invalid key/origin/domain combination`);
                console.log(`[${new Date().toISOString()}] Provided key: ${apiKeyFromHeader}, origin: ${originFromBody}, domain: ${userDomain}`);
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
                console.log(`[${new Date().toISOString()}] Note: Creating new sessions file`);
            }
            
            // Add new session
            sessionsData.sessions.push(sessionData);
            
            // Save sessions to file
            try {
                await queueSessionWrite(sessionsData);
                console.log(`[${new Date().toISOString()}] Session saved for user: ${userFromBody}`);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error saving session:`, error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to create session' }));
                return;
            }
            
            // Auth successful
            console.log(`[${new Date().toISOString()}] Auth successful for: ${validCred.name} (user: ${userFromBody})`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: 'Authorized', 
                credentialName: validCred.name,
                sessionToken: sessionToken,
                expiresIn: expiresIn
            }));
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Auth error:`, error.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
}

/**
 * Validate session token
 * POST /validate
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
    
    console.log(`[${new Date().toISOString()}] === VALIDATE SESSION REQUEST ===`);
    console.log(`[${new Date().toISOString()}] Session Token header present: ${!!sessionTokenFromHeader}`);
    
    // Read request body
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            const userFromBody = data.user;
            
            console.log(`[${new Date().toISOString()}] User from body: ${userFromBody}`);
            
            if (!sessionTokenFromHeader) {
                console.log(`[${new Date().toISOString()}] Validation failed: no session token provided`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No session token provided' }));
                console.log(`[${new Date().toISOString()}] Error response sent (no token)`);
                return;
            }
            
            // Load sessions from file
            let sessionsData;
            try {
                const sessionsJson = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
                sessionsData = JSON.parse(sessionsJson);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error loading sessions file:`, error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server configuration error' }));
                console.log(`[${new Date().toISOString()}] Error response sent (file error)`);
                return;
            }
            
            // Find matching session
            const session = sessionsData.sessions.find(s => s.token === sessionTokenFromHeader);
            
            if (!session) {
                console.log(`[${new Date().toISOString()}] Validation failed: session token not found`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid session token' }));
                console.log(`[${new Date().toISOString()}] Error response sent (token not found)`);
                return;
            }
            
            // Check if session has expired
            const now = Date.now();
            if (now > session.expiresAt) {
                console.log(`[${new Date().toISOString()}] Validation failed: session token expired`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Session token has expired' }));
                console.log(`[${new Date().toISOString()}] Error response sent (expired)`);
                return;
            }
            
            // Verify user matches
            if (session.user !== userFromBody) {
                console.log(`[${new Date().toISOString()}] Validation failed: user mismatch`);
                console.log(`[${new Date().toISOString()}] Expected: ${session.user}, Got: ${userFromBody}`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'User mismatch' }));
                console.log(`[${new Date().toISOString()}] Error response sent (user mismatch)`);
                return;
            }
            
            // Session is valid
            const remainingTime = Math.floor((session.expiresAt - now) / 1000);
            console.log(`[${new Date().toISOString()}] Session validation successful for user: ${session.user} (${remainingTime}s remaining)`);
            
            const responseData = { 
                status: 'Valid',
                credentialName: session.credentialName,
                user: session.user,
                expiresIn: remainingTime
            };
            
            console.log(`[${new Date().toISOString()}] Sending response:`, JSON.stringify(responseData));
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responseData));
            
            console.log(`[${new Date().toISOString()}] Response sent to client`);
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Validation error:`, error.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
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
        timestamp: new Date().toISOString()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
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
                console.log(`[${new Date().toISOString()}] Added mesh to lookup:`, mesh._id.substring(0, 40), `name=${mesh.name}`);
            }
        }
    }

    console.log(`[${new Date().toISOString()}] Built mesh lookup with ${Object.keys(meshLookup).length} meshes`);
    
    // Log all fields from first mesh for debugging
    if (Object.keys(meshLookup).length > 0) {
        const firstMeshId = Object.keys(meshLookup)[0];
        const firstMesh = meshLookup[firstMeshId];
        console.log(`[${new Date().toISOString()}] Sample mesh fields:`, Object.keys(firstMesh));
        console.log(`[${new Date().toISOString()}] Sample mesh data:`, JSON.stringify(firstMesh).substring(0, 800));
    }

    // Attach mesh data to each node
    const enriched = {};
    for (const [meshName, nodes] of Object.entries(nodesData)) {
        console.log(`[${new Date().toISOString()}] Processing mesh: ${meshName.substring(0, 50)}`);
        
        enriched[meshName] = nodes.map(node => {
            // meshName IS the mesh ID - it's the key from the nodes response
            if (meshLookup[meshName]) {
                console.log(`[${new Date().toISOString()}]   Node ${node.name}: found mesh in lookup (${meshLookup[meshName].name})`);
                node.mesh = meshLookup[meshName];
            } else {
                console.log(`[${new Date().toISOString()}]   Node ${node.name}: mesh not in lookup, using meshName fallback`);
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
                console.log(`[${new Date().toISOString()}] Sample node fields:`, Object.keys(firstNode));
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
        console.error(`[${new Date().toISOString()}] Query parsing error:`, error.message);
        throw new Error(`Invalid query: ${error.message}`);
    }
}

/**
 * HTTP endpoint for retrieving nodes with optional filtering
 * POST /nodes
 */
async function handleNodesRequest(req, res) {
    console.log(`[${new Date().toISOString()}] === ENTERING handleNodesRequest ===`);
    console.log(`[${new Date().toISOString()}] Method: ${req.method}, URL: ${req.url}`);
    
    // CORS headers
    console.log(`[${new Date().toISOString()}] Setting CORS headers`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');

    if (req.method === 'OPTIONS') {
        console.log(`[${new Date().toISOString()}] Handling OPTIONS request`);
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        console.log(`[${new Date().toISOString()}] Error: Non-POST method: ${req.method}`);
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
                console.log(`[${new Date().toISOString()}] Nodes request rejected: ${validation.error}`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: validation.error }));
                return;
            }

            console.log(`[${new Date().toISOString()}] Nodes request from user: ${validation.user}`);

            // Get or create WebSocket connection
            if (!global.meshWS || global.meshWS.readyState !== WebSocket.OPEN) {
                console.log(`[${new Date().toISOString()}] Creating new WebSocket connection for nodes request...`);
                const cookie = await getSessionCookie(validation.meshUser, validation.meshPass);
                console.log(`[${new Date().toISOString()}] Got session cookie, connecting WebSocket...`);
                global.meshWS = await connectToMeshCentral(cookie);
                console.log(`[${new Date().toISOString()}] WebSocket connected, setting up message handler...`);
                try {
                    setupMessageHandler(global.meshWS);
                    console.log(`[${new Date().toISOString()}] [IMMEDIATE] setupMessageHandler returned, now proceeding`);
                } catch (e) {
                    console.error(`[${new Date().toISOString()}] [ERROR] Exception in setupMessageHandler:`, e.message, e.stack);
                    throw e;
                }
            } else {
                console.log(`[${new Date().toISOString()}] Reusing existing WebSocket connection`);
            }

            console.log(`[${new Date().toISOString()}] [CHECKPOINT 1] Past setupMessageHandler, about to send nodes request`);
            
            // Request nodes list (required)
            try {
                console.log(`[${new Date().toISOString()}] [CHECKPOINT 2] Calling sendNodesRequest`);
                const nodesResult = await sendNodesRequest(global.meshWS);
                console.log(`[${new Date().toISOString()}] [CHECKPOINT 3] Got nodes response`);
                
                // Extract the nodes from the response
                let nodesData = nodesResult.nodes || nodesResult;
                
                // Try to get mesh metadata (non-blocking, optional)
                let meshesResult = null;
                try {
                    console.log(`[${new Date().toISOString()}] Requesting mesh metadata...`);
                    meshesResult = await Promise.race([
                        sendMeshesRequest(global.meshWS),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Meshes timeout')), 5000))
                    ]);
                    console.log(`[${new Date().toISOString()}] Got meshes response`);
                } catch (meshError) {
                    console.warn(`[${new Date().toISOString()}] Mesh enrichment failed (non-fatal):`, meshError.message);
                    meshesResult = null;
                }
                
                // Enrich nodes with mesh metadata if available
                if (meshesResult) {
                    console.log(`[${new Date().toISOString()}] Enriching nodes with mesh metadata`);
                    nodesData = enrichNodesWithMeshData(nodesData, meshesResult);
                    console.log(`[${new Date().toISOString()}] Nodes enriched successfully`);
                } else {
                    console.log(`[${new Date().toISOString()}] Skipping mesh enrichment (no mesh data available)`);
                }
                
                // Apply query filter if provided
                if (params.query) {
                    console.log(`[${new Date().toISOString()}] Applying query filter: ${params.query.substring(0, 100)}...`);
                    nodesData = filterNodesByQuery(nodesData, params.query);
                    console.log(`[${new Date().toISOString()}] Query filter applied successfully`);
                }
                
                console.log(`[${new Date().toISOString()}] Writing response header (200)`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                console.log(`[${new Date().toISOString()}] Sending response body`);
                res.end(JSON.stringify({
                    success: true,
                    result: nodesData,
                    timestamp: new Date().toISOString()
                }));
                console.log(`[${new Date().toISOString()}] Response sent successfully`);
            } catch (nodeError) {
                console.error(`[${new Date().toISOString()}] [ERROR] Exception during nodes request:`, nodeError.message, nodeError.stack);
                throw nodeError;
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Nodes request error:`, error.message);
            console.error(`[${new Date().toISOString()}] Error stack:`, error.stack);
            
            console.log(`[${new Date().toISOString()}] Writing error response (500)`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: error.message,
                timestamp: new Date().toISOString()
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
    console.log(`[${new Date().toISOString()}] [DEBUG] sendMeshesRequest called`);
    return new Promise((resolve, reject) => {
        const responseId = `meshes_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const command = {
            action: 'meshes',
            responseid: responseId  // We send it but MC won't echo it back
        };

        console.log(`[${new Date().toISOString()}] Sending meshes request:`, { responseid: responseId });

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
    console.log(`[${new Date().toISOString()}] [DEBUG] sendNodesRequest called`);
    return new Promise((resolve, reject) => {
        console.log(`[${new Date().toISOString()}] [DEBUG] Creating promise for nodes request`);
        const responseId = `nodes_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Build nodes message
        const command = {
            action: 'nodes',
            responseid: responseId
        };

        console.log(`[${new Date().toISOString()}] Sending nodes request:`, { responseid: responseId });

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

/**
 * HTTP endpoint for MySQL queries
 * POST /query
 * Body: { query: "SELECT * FROM table" }
 * Headers: X-Session-Token
 */
function handleQueryRequest(req, res) {
    const clientIP = req.socket.remoteAddress;
    
    console.log(`[${new Date().toISOString()}] === QUERY REQUEST ===`);
    
    // Rate limit check for /query
    if (!isIPWhitelisted(clientIP)) {
        const rateLimitCheck = checkRateLimit(clientIP, '/query');
        if (!rateLimitCheck.allowed) {
            console.log(`[${new Date().toISOString()}] Rate limit exceeded for IP ${clientIP} on /query (limit: 100/min, reset in: ${rateLimitCheck.resetIn}s)`);
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
    
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    const sessionTokenFromHeader = req.headers['x-session-token'];
    console.log(`[${new Date().toISOString()}] Session Token header present: ${!!sessionTokenFromHeader}`);
    
    // Read request body
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            const query = data.query;
            const userFromBody = data.user;
            
            // Handle optional timeout parameter (in milliseconds)
            const requestTimeout = data.timeout || 30000; // Default 30 seconds
            if (typeof requestTimeout === 'number' && requestTimeout > 0) {
                req.socket.setTimeout(requestTimeout);
                console.log(`[${new Date().toISOString()}] Query request timeout set to ${requestTimeout}ms`);
            }
            
            console.log(`[${new Date().toISOString()}] Query request for user: ${userFromBody}`);
            console.log(`[${new Date().toISOString()}] Query: ${query.substring(0, 100)}...`);
            
            // Validate session token
            if (!sessionTokenFromHeader) {
                console.log(`[${new Date().toISOString()}] Query failed: no session token provided`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'No session token provided', result: null }));
                return;
            }
            
            // Load sessions from file
            let sessionsData;
            try {
                const sessionsJson = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
                sessionsData = JSON.parse(sessionsJson);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error loading sessions file:`, error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'Server configuration error', result: null }));
                return;
            }
            
            // Find matching session
            const session = sessionsData.sessions.find(s => s.token === sessionTokenFromHeader);
            
            if (!session) {
                console.log(`[${new Date().toISOString()}] Query failed: session token not found`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'Invalid session token', result: null }));
                return;
            }
            
            // Check if session has expired
            const now = Date.now();
            if (now > session.expiresAt) {
                console.log(`[${new Date().toISOString()}] Query failed: session token expired`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'Session token has expired', result: null }));
                return;
            }
            
            // Verify user matches
            if (session.user !== userFromBody) {
                console.log(`[${new Date().toISOString()}] Query failed: user mismatch`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'User mismatch', result: null }));
                return;
            }
            
            // Check if MySQL pool is initialized
            if (!mysqlPool) {
                console.error(`[${new Date().toISOString()}] MySQL pool not initialized`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'MySQL connection pool not available', result: null }));
                return;
            }
            
            // Execute query with timeout
            console.log(`[${new Date().toISOString()}] Executing query for user: ${session.user}`);
            
            const connection = await mysqlPool.getConnection();
            let rows;
            try {
                // Set a 30-second query timeout
                await connection.query('SET SESSION max_execution_time=30000');
                console.log(`[${new Date().toISOString()}] Query timeout set to 30 seconds`);
                
                console.log(`[${new Date().toISOString()}] About to execute: ${query.substring(0, 150)}...`);
                [rows] = await connection.query(query);
                console.log(`[${new Date().toISOString()}] Query executed successfully, rows affected: ${rows?.affectedRows || rows?.length || 0}`);
            } catch (queryError) {
                console.error(`[${new Date().toISOString()}] QUERY EXECUTION FAILED`);
                console.error(`[${new Date().toISOString()}] Error Type: ${queryError?.constructor?.name}`);
                console.error(`[${new Date().toISOString()}] Error Message: ${queryError?.message || 'NO MESSAGE'}`);
                console.error(`[${new Date().toISOString()}] Error Code: ${queryError?.code || 'NO CODE'}`);
                console.error(`[${new Date().toISOString()}] Error SQL State: ${queryError?.sqlState || 'NO SQLSTATE'}`);
                console.error(`[${new Date().toISOString()}] Full Error:`, queryError);
                throw queryError;
            } finally {
                connection.release();
            }
            
            // Return results
            // When multipleStatements are used, rows is an array of results for each statement
            // Extract the last result which is the actual SELECT query result
            let finalResult = rows;
            if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[rows.length - 1])) {
                finalResult = rows[rows.length - 1];
                console.log(`[${new Date().toISOString()}] Extracted final result from ${rows.length} statements`);
            }
            
            // Strip MySQL user variable columns (those starting with @)
            finalResult = stripVariableColumns(finalResult);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                result: finalResult,
                rowCount: Array.isArray(finalResult) ? finalResult.length : 0,
                timestamp: new Date().toISOString()
            }));
            
            console.log(`[${new Date().toISOString()}] Response sent successfully`);
            
        } catch (error) {
            const errorDetails = {
                message: error.message,
                code: error.code,
                errno: error.errno,
                sqlState: error.sqlState,
                query: query,
                user: session.user,
                stack: error.stack
            };
            
            logError('*** QUERY EXECUTION ERROR ***', errorDetails);
            
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: false, 
                errors: error.message,
                code: error.code,
                detail: process.env.NODE_ENV === 'development' ? error.toString() : undefined,
                result: null 
            }));
        }
    });
}

function handleCwaQueryRequest(req, res) {
    const clientIP = req.socket.remoteAddress;
    
    console.log(`[${new Date().toISOString()}] === CWA QUERY REQUEST ===`);
    
    // Rate limit check for /cwaquery
    if (!isIPWhitelisted(clientIP)) {
        const rateLimitCheck = checkRateLimit(clientIP, '/cwaquery');
        if (!rateLimitCheck.allowed) {
            console.log(`[${new Date().toISOString()}] Rate limit exceeded for IP ${clientIP} on /cwaquery (limit: 100/min, reset in: ${rateLimitCheck.resetIn}s)`);
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
    
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    const sessionTokenFromHeader = req.headers['x-session-token'];
    console.log(`[${new Date().toISOString()}] Session Token header present: ${!!sessionTokenFromHeader}`);
    
    // Read request body
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', async () => {
        let query = null;  // Declare here so it's available in catch block
        let session = null;  // Declare here so it's available in catch block
        try {
            const data = JSON.parse(body);
            query = data.query;
            const userFromBody = data.user;
            
            // Handle optional timeout parameter (in milliseconds)
            const requestTimeout = data.timeout || 30000; // Default 30 seconds
            if (typeof requestTimeout === 'number' && requestTimeout > 0) {
                req.socket.setTimeout(requestTimeout);
                console.log(`[${new Date().toISOString()}] CWA Query request timeout set to ${requestTimeout}ms`);
            }
            
            console.log(`[${new Date().toISOString()}] CWA Query request for user: ${userFromBody}`);
            console.log(`[${new Date().toISOString()}] Query: ${query.substring(0, 100)}...`);
            
            // Validate session token
            if (!sessionTokenFromHeader) {
                console.log(`[${new Date().toISOString()}] CWA Query failed: no session token provided`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'No session token provided', result: null }));
                return;
            }
            
            // Load sessions from file
            let sessionsData;
            try {
                const sessionsJson = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
                sessionsData = JSON.parse(sessionsJson);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error loading sessions file:`, error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'Server configuration error', result: null }));
                return;
            }
            
            // Find matching session
            session = sessionsData.sessions.find(s => s.token === sessionTokenFromHeader);
            
            if (!session) {
                console.log(`[${new Date().toISOString()}] CWA Query failed: session token not found`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'Invalid session token', result: null }));
                return;
            }
            
            // Check if session has expired
            const now = Date.now();
            if (now > session.expiresAt) {
                console.log(`[${new Date().toISOString()}] CWA Query failed: session token expired`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'Session token has expired', result: null }));
                return;
            }
            
            // Verify user matches
            if (session.user !== userFromBody) {
                console.log(`[${new Date().toISOString()}] CWA Query failed: user mismatch`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'User mismatch', result: null }));
                return;
            }
            
            // Check if CWA MySQL pool is initialized
            if (!cwaPool) {
                console.error(`[${new Date().toISOString()}] CWA MySQL pool not initialized`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, errors: 'CWA MySQL connection pool not available', result: null }));
                return;
            }
            
            // Execute query with timeout
            console.log(`[${new Date().toISOString()}] Executing CWA query for user: ${session.user}`);
            
            const connection = await cwaPool.getConnection();
            let rows;
            try {
                // Set a 30-second query timeout
                await connection.query('SET SESSION max_execution_time=30000');
                console.log(`[${new Date().toISOString()}] CWA Query timeout set to 30 seconds`);
                
                console.log(`[${new Date().toISOString()}] About to execute: ${query.substring(0, 150)}...`);
                [rows] = await connection.query(query);
                console.log(`[${new Date().toISOString()}] CWA Query executed successfully, rows affected: ${rows?.affectedRows || rows?.length || 0}`);
            } catch (queryError) {
                console.error(`[${new Date().toISOString()}] CWA QUERY EXECUTION FAILED`);
                console.error(`[${new Date().toISOString()}] Error Type: ${queryError?.constructor?.name}`);
                console.error(`[${new Date().toISOString()}] Error Message: ${queryError?.message || 'NO MESSAGE'}`);
                console.error(`[${new Date().toISOString()}] Error Code: ${queryError?.code || 'NO CODE'}`);
                console.error(`[${new Date().toISOString()}] Error SQL State: ${queryError?.sqlState || 'NO SQLSTATE'}`);
                console.error(`[${new Date().toISOString()}] Full Error:`, queryError);
                throw queryError;
            } finally {
                connection.release();
            }
            
            // Return results
            // When multipleStatements are used, rows is an array of results for each statement
            // Extract the last result which is the actual SELECT query result
            let finalResult = rows;
            if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[rows.length - 1])) {
                finalResult = rows[rows.length - 1];
                console.log(`[${new Date().toISOString()}] Extracted final result from ${rows.length} statements`);
            }
            
            // Strip MySQL user variable columns (those starting with @)
            finalResult = stripVariableColumns(finalResult);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                result: finalResult,
                rowCount: Array.isArray(finalResult) ? finalResult.length : 0,
                timestamp: new Date().toISOString()
            }));
            
            console.log(`[${new Date().toISOString()}] CWA Response sent successfully`);
            
        } catch (error) {
            const errorDetails = {
                message: error.message,
                code: error.code,
                errno: error.errno,
                sqlState: error.sqlState,
                query: query,
                user: session?.user || 'unknown',
                stack: error.stack
            };
            
            logError('*** CWA QUERY EXECUTION ERROR ***', errorDetails);
            
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: false, 
                errors: error.message,
                code: error.code,
                detail: process.env.NODE_ENV === 'development' ? error.toString() : undefined,
                result: null 
            }));
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
function handleCwmApiRequest(req, res) {
    const clientIP = req.socket.remoteAddress;
    
    console.log(`[${new Date().toISOString()}] === CWM API REQUEST ===`);
    
    // Rate limit check for /api-cwm
    if (!isIPWhitelisted(clientIP)) {
        const rateLimitCheck = checkRateLimit(clientIP, '/api-cwm');
        if (!rateLimitCheck.allowed) {
            console.log(`[${new Date().toISOString()}] Rate limit exceeded for IP ${clientIP} on /api-cwm (limit: 100/min, reset in: ${rateLimitCheck.resetIn}s)`);
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
    
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    const sessionTokenFromHeader = req.headers['x-session-token'];
    console.log(`[${new Date().toISOString()}] Session Token header present: ${!!sessionTokenFromHeader}`);
    
    // Read request body
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            const endpoint = data.endpoint;  // e.g., "/service/tickets"
            const method = (data.method || 'GET').toUpperCase();  // GET, POST, PUT, DELETE
            const query = data.query || {};  // Query parameters
            const requestBody = data.body || {};  // Request body for POST/PUT
            const userFromBody = data.user;
            
            // Handle optional timeout parameter (in milliseconds)
            const requestTimeout = data.timeout || 30000; // Default 30 seconds
            if (typeof requestTimeout === 'number' && requestTimeout > 0) {
                req.socket.setTimeout(requestTimeout);
                console.log(`[${new Date().toISOString()}] CWM API request timeout set to ${requestTimeout}ms`);
            }
            
            const shouldFlatten = data.flatten === true; // Flatten nested objects
            console.log(`[${new Date().toISOString()}] Method: ${method}, Endpoint: ${endpoint}`);
            
            // Validate session token
            if (!sessionTokenFromHeader) {
                console.log(`[${new Date().toISOString()}] CWM API failed: no session token provided`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'No session token provided' }));
                return;
            }
            
            // Load sessions from file
            let sessionsData;
            try {
                const sessionsJson = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
                sessionsData = JSON.parse(sessionsJson);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error loading sessions file:`, error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Server configuration error' }));
                return;
            }
            
            // Find matching session
            const session = sessionsData.sessions.find(s => s.token === sessionTokenFromHeader);
            
            if (!session) {
                console.log(`[${new Date().toISOString()}] CWM API failed: session token not found`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid session token' }));
                return;
            }
            
            // Check if session has expired
            const now = Date.now();
            if (now > session.expiresAt) {
                console.log(`[${new Date().toISOString()}] CWM API failed: session token expired`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Session token has expired' }));
                return;
            }
            
            // Verify user matches
            if (session.user !== userFromBody) {
                console.log(`[${new Date().toISOString()}] CWM API failed: user mismatch`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'User mismatch' }));
                return;
            }
            
            // Check if API config is available
            if (!global.apiConfig || !global.apiConfig.cwm) {
                console.error(`[${new Date().toISOString()}] CWM API config not initialized`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'CWM API configuration not available' }));
                return;
            }
            
            // Build ConnectWise Manage API request
            const cwmConfig = global.apiConfig.cwm;
            const auth = Buffer.from(`Equinox+${cwmConfig.publicKey}:${cwmConfig.privateKey}`).toString('base64');
            
            // Extract pagination parameters
            const pageAll = query.pageAll === 'true' || query.pageAll === true;
            delete query.pageAll; // Remove from query params
            
            // Set default pageSize to 1000 if not provided
            if (!query.pageSize) {
                query.pageSize = 1000;
            }
            
            // Function to make a single API request
            async function makeApiRequest(pageNum = 1) {
                return new Promise((resolve, reject) => {
                    const apiPath = cwmConfig.apiPath || '/v4_6_release/apis/3.0';
                    const queryParams = { ...query, page: pageNum };
                    const queryString = new URLSearchParams(queryParams).toString();
                    let url = `${cwmConfig.baseUrl}${apiPath}${endpoint}`;
                    if (queryString) {
                        url += `?${queryString}`;
                    }
                    
                    console.log(`[${new Date().toISOString()}] Calling ConnectWise API (page ${pageNum}): ${method} ${url}`);
                    
                    const options = {
                        method: method,
                        headers: {
                            'Authorization': `Basic ${auth}`,
                            'ClientID': cwmConfig.clientId,
                            'Content-Type': 'application/json'
                        }
                    };
                    
                    const apiRequest = https.request(url, options, (apiRes) => {
                        let apiBody = '';
                        
                        apiRes.on('data', chunk => {
                            apiBody += chunk;
                        });
                        
                        apiRes.on('end', () => {
                            try {
                                const apiResponse = apiBody ? JSON.parse(apiBody) : null;
                                resolve({
                                    statusCode: apiRes.statusCode,
                                    data: apiResponse,
                                    isArray: Array.isArray(apiResponse)
                                });
                            } catch (parseError) {
                                reject(new Error(`Failed to parse response: ${parseError.message}`));
                            }
                        });
                    });
                    
                    apiRequest.on('error', reject);
                    
                    if (method === 'POST' || method === 'PUT') {
                        apiRequest.write(JSON.stringify(body || {}));
                    }
                    apiRequest.end();
                });
            }
            
            // Handle pagination if pageAll is true
            if (pageAll) {
                (async () => {
                    try {
                        let allResults = [];
                        let page = 1;
                        let hasMore = true;
                        
                        while (hasMore) {
                            const response = await makeApiRequest(page);
                            
                            if (response.statusCode < 200 || response.statusCode >= 300) {
                                res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    success: false,
                                    statusCode: response.statusCode,
                                    error: 'ConnectWise API error'
                                }));
                                return;
                            }
                            
                            // Handle both array and object responses
                            if (response.isArray) {
                                allResults = allResults.concat(response.data);
                                hasMore = response.data.length === parseInt(query.pageSize);
                            } else {
                                allResults.push(response.data);
                                hasMore = false;
                            }
                            
                            page++;
                        }
                        
                        // Apply flatten if requested
                        let resultsToReturn = allResults;
                        if (shouldFlatten && allResults.length > 0) {
                            resultsToReturn = allResults.map(item => flattenObject(item));
                        }
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            statusCode: 200,
                            result: resultsToReturn,
                            pagesFetched: page - 1,
                            totalRecords: resultsToReturn.length,
                            timestamp: new Date().toISOString()
                        }));
                        
                        console.log(`[${new Date().toISOString()}] CWM API pagination complete: ${page - 1} pages, ${resultsToReturn.length} total records`);
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] CWM API pagination error:`, error.message);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            statusCode: 500,
                            error: error.message
                        }));
                    }
                })();
            } else {
                // Single page request
                makeApiRequest(1).then(response => {
                    // Apply flatten if requested
                    let resultsToReturn = response.data;
                    if (shouldFlatten && Array.isArray(resultsToReturn) && resultsToReturn.length > 0) {
                        resultsToReturn = resultsToReturn.map(item => flattenObject(item));
                    } else if (shouldFlatten && resultsToReturn !== null && typeof resultsToReturn === 'object' && !Array.isArray(resultsToReturn)) {
                        resultsToReturn = flattenObject(resultsToReturn);
                    }
                    
                    res.writeHead(response.statusCode || 200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: response.statusCode >= 200 && response.statusCode < 300,
                        statusCode: response.statusCode,
                        result: resultsToReturn,
                        timestamp: new Date().toISOString()
                    }));
                    
                    console.log(`[${new Date().toISOString()}] CWM API response sent successfully`);
                }).catch(error => {
                    console.error(`[${new Date().toISOString()}] CWM API request error:`, error.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        statusCode: 500,
                        error: error.message
                    }));
                });
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] CWM API handler error:`, error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message,
                timestamp: new Date().toISOString()
            }));
        }
    });
}

// ===== END CWM API Handler =====

/**
 * Generalized static file server with configurable base paths and allowed extensions
 * Handles security, content-type detection, and error handling for multiple file repositories
 */
function serveStaticFile(req, res, config) {
    // config = { basePath, allowedExtensions, logPrefix }
    const basePath = config.basePath;
    const allowedExtensions = config.allowedExtensions || ['.html', '.css', '.js', '.json'];
    const logPrefix = config.logPrefix || '[StaticFile]';
    
    // Parse URL to get just the pathname, stripping query parameters
    const parsedUrl = require('url').parse(req.url, true);
    let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
    
    // For /node_modules/ requests, strip the prefix to avoid doubling the directory
    if (basePath.includes('node_modules') && filePath.startsWith('/node_modules/')) {
        filePath = filePath.substring('/node_modules'.length);
    }
    
    console.log(`${logPrefix} Requested: ${parsedUrl.pathname}`);
    
    // Security: only allow safe file types
    const isSafeFile = allowedExtensions.some(ext => filePath.endsWith(ext));
    
    if (!isSafeFile) {
        console.log(`${logPrefix} Access denied - unsafe file type: ${filePath}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
    }
    
    // Normalize path separators (convert forward slashes to backslashes on Windows)
    let normalizedPath = filePath.replace(/\//g, '\\');
    const fullPath = require('path').join(basePath, normalizedPath);
    
    console.log(`${logPrefix} Full path: ${fullPath}`);
    
    // Security: prevent directory traversal
    if (!fullPath.startsWith(basePath)) {
        console.log(`${logPrefix} Access denied - path traversal attempt`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
    }
    
    require('fs').readFile(fullPath, 'utf8', (err, data) => {
        if (err) {
            console.log(`${logPrefix} Error reading file: ${err.message}`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
            return;
        }
        
        // Determine content type based on file extension
        let contentType = 'text/plain';
        if (filePath.endsWith('.html')) {
            contentType = 'text/html';
        } else if (filePath.endsWith('.css')) {
            contentType = 'text/css';
        } else if (filePath.endsWith('.js')) {
            contentType = 'application/javascript';
        } else if (filePath.endsWith('.json')) {
            contentType = 'application/json';
        } else if (filePath.endsWith('.d.ts')) {
            contentType = 'application/typescript';
        } else if (filePath.endsWith('.map')) {
            contentType = 'application/json';
        }
        
        console.log(`${logPrefix} Serving ${filePath} as ${contentType}`);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

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
        console.log(`[${new Date().toISOString()}] CA bundle loaded from ${caPath}`);
    } catch (caErr) {
        console.warn(`[${new Date().toISOString()}] WARNING: CA bundle not found at ${caPath} - cert chain may be incomplete`);
    }
    
    serverOptions = {
        cert: cert,
        key: key
    };
    
    // Add CA chain if available
    if (ca) {
        serverOptions.ca = ca;
    }
    
    console.log(`[${new Date().toISOString()}] SSL certificate loaded from ZeroSSL (app.equinoxits.com)`);
} catch (err) {
    console.error(`[${new Date().toISOString()}] ERROR: Could not load certificate: ${err.message}`);
    console.error(`[${new Date().toISOString()}] Cert path: ${certPath}`);
    console.error(`[${new Date().toISOString()}] Key path: ${keyPath}`);
    process.exit(1);
}

const requestHandler = (req, res) => {
    const timestamp = `[${new Date().toISOString()}]`;
    
    // Log raw request before anything else
    process.stdout.write(`${timestamp} *** RAW REQUEST RECEIVED ***\n`);
    process.stdout.write(`${timestamp} Method: ${req.method}\n`);
    process.stdout.write(`${timestamp} URL: ${req.url}\n`);
    process.stdout.write(`${timestamp} Headers: ${JSON.stringify(req.headers, null, 2)}\n`);
    process.stdout.write(`${timestamp} *** REQUEST HANDLER CALLED: ${req.method} ${req.url} ***\n`);
    
    console.log(`${timestamp} ${req.method} ${req.url}`);

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

    // Route requests
    if (req.url === '/auth' || req.url.startsWith('/auth?')) {
        handleAuthRequest(req, res);
    } else if (req.url === '/validate' || req.url.startsWith('/validate?')) {
        handleValidateSession(req, res);
    } else if (req.url === '/command' || req.url.startsWith('/command?')) {
        handleCommandRequest(req, res);
    } else if (req.url === '/query' || req.url.startsWith('/query?')) {
        handleQueryRequest(req, res);
    } else if (req.url === '/cwaquery' || req.url.startsWith('/cwaquery?')) {
        handleCwaQueryRequest(req, res);
    } else if (req.url === '/status') {
        handleStatusRequest(req, res);
    } else if (req.url === '/nodes' || req.url.startsWith('/nodes?')) {
        handleNodesRequest(req, res);
    } else if (req.url === '/api-cwm' || req.url.startsWith('/api-cwm?')) {
        handleCwmApiRequest(req, res);
    } else if (req.url === '/snipe/hardware' || req.url.startsWith('/snipe/hardware?')) {
        snipe.handleHardware(req, res, isIPWhitelisted, checkRateLimit);
    } else if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
    } else if (req.url.startsWith('/node_modules/')) {
        serveStaticFile(req, res, {
            basePath: 'D:\\Kore\\node_modules',
            allowedExtensions: ['.js', '.d.ts', '.json', '.map'],
            logPrefix: '[NodeModules]'
        });
    } else if (Persephone.handleRegisteredRoute(req, res)) {
        // Route was handled by registry
    } else {
        // Parse URL to get pathname without query string
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        
        if (pathname.endsWith('.html') || pathname.endsWith('.css') || pathname.endsWith('.js') || pathname.endsWith('.json') || pathname === '/') {
            serveStaticFile(req, res, {
                basePath: 'D:\\Kore\\web',
                allowedExtensions: ['.html', '.css', '.js', '.json'],
                logPrefix: '[StaticWeb]'
            });
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    }
};

const server = https.createServer(serverOptions, requestHandler);
const server443 = https.createServer(serverOptions, requestHandler);

server.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] *** NEW CONNECTION ATTEMPT (1139) ***`);
    console.log(`[${new Date().toISOString()}] Remote: ${socket.remoteAddress}:${socket.remotePort}`);
});

server443.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] *** NEW CONNECTION ATTEMPT (443) ***`);
    console.log(`[${new Date().toISOString()}] Remote: ${socket.remoteAddress}:${socket.remotePort}`);
});

server.on('clientError', (err, socket) => {
    console.error(`[${new Date().toISOString()}] *** CLIENT ERROR (1139) ***`);
    console.error(`[${new Date().toISOString()}] Error Code: ${err.code}`);
    console.error(`[${new Date().toISOString()}] Error Message: ${err.message}`);
    console.error(`[${new Date().toISOString()}] Remote Address: ${socket.remoteAddress}:${socket.remotePort}`);
    console.error(`[${new Date().toISOString()}] Full Error:`, err);
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

server443.on('clientError', (err, socket) => {
    console.error(`[${new Date().toISOString()}] *** CLIENT ERROR (443) ***`);
    console.error(`[${new Date().toISOString()}] Error Code: ${err.code}`);
    console.error(`[${new Date().toISOString()}] Error Message: ${err.message}`);
    console.error(`[${new Date().toISOString()}] Remote Address: ${socket.remoteAddress}:${socket.remotePort}`);
    console.error(`[${new Date().toISOString()}] Full Error:`, err);
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

server.on('secureConnection', (tlsSocket) => {
    console.log(`[${new Date().toISOString()}] TLS connection established (1139) from ${tlsSocket.remoteAddress}:${tlsSocket.remotePort}`);
    
    // Set socket timeout to 90 seconds to allow slow internal HTTP requests to MeshCentral
    tlsSocket.setTimeout(90000, () => {
        console.error(`[${new Date().toISOString()}] Socket timeout from ${tlsSocket.remoteAddress} - destroying`);
        tlsSocket.destroy();
    });
    
    tlsSocket.on('data', (data) => {
        console.log(`[${new Date().toISOString()}] Data received (1139): ${data.length} bytes`);
        console.log(`[${new Date().toISOString()}] Data: ${data.toString('utf8').substring(0, 100)}`);
    });
    
    tlsSocket.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] TLS socket error (1139):`, err.message);
    });
    
    tlsSocket.on('close', () => {
        console.log(`[${new Date().toISOString()}] TLS socket closed (1139)`);
    });
});

server443.on('secureConnection', (tlsSocket) => {
    console.log(`[${new Date().toISOString()}] TLS connection established (443) from ${tlsSocket.remoteAddress}:${tlsSocket.remotePort}`);
    
    // Set socket timeout to 90 seconds to allow slow internal HTTP requests to MeshCentral
    tlsSocket.setTimeout(90000, () => {
        console.error(`[${new Date().toISOString()}] Socket timeout from ${tlsSocket.remoteAddress} - destroying`);
        tlsSocket.destroy();
    });
    
    tlsSocket.on('data', (data) => {
        console.log(`[${new Date().toISOString()}] Data received (443): ${data.length} bytes`);
        console.log(`[${new Date().toISOString()}] Data: ${data.toString('utf8').substring(0, 100)}`);
    });
    
    tlsSocket.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] TLS socket error (443):`, err.message);
    });
    
    tlsSocket.on('close', () => {
        console.log(`[${new Date().toISOString()}] TLS socket closed (443)`);
    });
});

// Start servers on both ports
server.listen(PROXY_PORT, '0.0.0.0', async () => {
    console.log(`[${new Date().toISOString()}] Proxy server listening on HTTPS://0.0.0.0:${PROXY_PORT} (1139)`);
    
    // Initialize MySQL pool
    await initializeMySQLPool();
    
    // Initialize Persephone automation engine
    try {
        await Persephone.initialize(korePool, mysqlPool, cwaPool);
        console.log(`[${new Date().toISOString()}] Persephone automation engine initialized`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERROR initializing Persephone:`, err.message);
    }
});

server443.listen(443, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] Proxy server listening on HTTPS://0.0.0.0:443`);
});

// ===== DIAGNOSTIC SERVER ON PORT 1140 (Testing with Rewst support - can be removed) =====
const server1140 = https.createServer(serverOptions, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'open',
        port: 1140,
        timestamp: new Date().toISOString(),
        message: 'Port 1140 is open and responding'
    }));
});

server1140.listen(1140, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] Diagnostic server listening on HTTPS://0.0.0.0:1140`);
});

server1140.timeout = 120000;
server1140.keepAliveTimeout = 120000;

server1140.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Server (1140) error:`, err);
});
// ===== END DIAGNOSTIC SERVER =====

// Set request timeout to prevent requests from hanging the server
server.timeout = 120000; // 120 second timeout
server.keepAliveTimeout = 120000;  // 120 seconds
server443.timeout = 120000;
server443.keepAliveTimeout = 120000;

server.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Server (1139) error:`, err);
    process.exit(1);
});

server443.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Server (443) error:`, err);
    process.exit(1);
});

// Global error handlers
process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] UNCAUGHT EXCEPTION:`, err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${new Date().toISOString()}] UNHANDLED REJECTION:`, reason);
});
process.on('SIGTERM', () => {
    console.log(`[${new Date().toISOString()}] SIGTERM received, shutting down...`);
    
    // Force exit after 5 seconds if graceful shutdown takes too long
    const forceExitTimeout = setTimeout(() => {
        console.error(`[${new Date().toISOString()}] Forced exit after shutdown timeout`);
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
            console.log(`[${new Date().toISOString()}] Shutdown complete`);
            process.exit(0);
        }
    };
    
    server.close(() => {
        console.log(`[${new Date().toISOString()}] Server (1139) closed`);
        checkAllClosed();
    });
    
    server443.close(() => {
        console.log(`[${new Date().toISOString()}] Server (443) closed`);
        checkAllClosed();
    });
});

process.on('SIGINT', () => {
    console.log(`[${new Date().toISOString()}] SIGINT received, shutting down...`);
    
    // Force exit after 5 seconds if graceful shutdown takes too long
    const forceExitTimeout = setTimeout(() => {
        console.error(`[${new Date().toISOString()}] Forced exit after shutdown timeout`);
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
            console.log(`[${new Date().toISOString()}] Shutdown complete`);
            process.exit(0);
        }
    };
    
    server.close(() => {
        console.log(`[${new Date().toISOString()}] Server (1139) closed`);
        checkAllClosed();
    });
    
    server443.close(() => {
        console.log(`[${new Date().toISOString()}] Server (443) closed`);
        checkAllClosed();
    });
});