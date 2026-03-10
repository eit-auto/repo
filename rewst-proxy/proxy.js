/**
 * MeshCentral WebSocket Proxy for Remote Command Execution via Rewst Integration
 * Converts HTTP requests to WebSocket messages for MeshCentral runcommands action
 * 
 * Configuration:
 * - MESHCENTRAL_PORT: MeshCentral server port (1138)
 * - PROXY_PORT: This proxy listening port (3000)
 * - MeshCentral config.json: Includes proxy URL in CSP
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Configuration
const MESHCENTRAL_HOST = '192.168.141.40';
const MESHCENTRAL_PORT = 1138;
const PROXY_PORT = 1139;
const MESHCENTRAL_USER = '~t:HnFCPNFuaFf3Wr55';
const MESHCENTRAL_PASS = 'l1teqFCwQu5oIigiVAAV';

// Store active WebSocket connections by user/sessionid
const wsConnections = {};
const pendingResponses = {};

console.log(`[${new Date().toISOString()}] Starting MeshCentral WebSocket Proxy`);
console.log(`[${new Date().toISOString()}] MeshCentral: ${MESHCENTRAL_HOST}:${MESHCENTRAL_PORT}`);
console.log(`[${new Date().toISOString()}] Proxy listening: 0.0.0.0:${PROXY_PORT}`);



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

        ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] WebSocket connected to MeshCentral`);
            resolve(ws);
        });

        ws.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] WebSocket connection error:`, err.message);
            reject(err);
        });

        ws.on('close', () => {
            console.log(`[${new Date().toISOString()}] WebSocket disconnected from MeshCentral`);
        });
    });
}

/**
 * Strip Windows banner and command echo from runcommands output
 */
function cleanCommandOutput(rawOutput) {
    if (!rawOutput) return '';
    
    // Split into lines
    let lines = rawOutput.split('\r\n');
    
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
        }, 30000); // 30 second timeout

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
            reject(err);
        }
    });
}

/**
 * Handle MeshCentral messages and route responses
 */
function setupMessageHandler(ws) {
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            // Log all messages
            console.log(`[${new Date().toISOString()}] Received:`, JSON.stringify(msg).substring(0, 300));

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

            // Route response to pending request
            if (msg.responseid && pendingResponses[msg.responseid]) {
                console.log(`[${new Date().toISOString()}] Routing response to request: ${msg.responseid}`);
                
                // Handle nodes action responses - they contain the nodes data directly
                if (msg.action === 'nodes' && msg.responseid.startsWith('nodes_')) {
                    pendingResponses[msg.responseid].resolve(msg);
                }
                // Handle runcommands type with result field
                else if (msg.type === 'runcommands' && msg.result) {
                    const cleanedOutput = cleanCommandOutput(msg.result);
                    pendingResponses[msg.responseid].resolve({
                        success: true,
                        result: cleanedOutput,
                        message: cleanedOutput
                    });
                } else if (msg.result === 'OK' || msg.result === true) {
                    pendingResponses[msg.responseid].resolve({
                        success: true,
                        result: msg.result,
                        message: msg.value || 'Command executed'
                    });
                } else if (msg.result) {
                    pendingResponses[msg.responseid].reject(
                        new Error(`Command error: ${msg.result}`)
                    );
                } else if (msg.output) {
                    // Some responses include output field
                    pendingResponses[msg.responseid].resolve({
                        success: true,
                        result: msg.output,
                        message: msg.output
                    });
                } else if (Object.keys(msg).length > 1) {
                    // If it's a complex object with nodes data, resolve it
                    pendingResponses[msg.responseid].resolve(msg);
                }
            }
        } catch (err) {
            console.log(`[${new Date().toISOString()}] Received (unparseable): ${data.substring(0, 100)}`);
        }
    });

    ws.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] WebSocket error:`, err.message);
    });

    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] WebSocket closed`);
        
        // Reject all pending responses
        for (const responseId in pendingResponses) {
            pendingResponses[responseId].reject(
                new Error('WebSocket connection closed')
            );
        }
    });
}

/**
 * HTTP endpoint for command execution
 * POST /command
 * Body: { nodeId, command, commandType, runAsUser, reply }
 */
async function handleCommandRequest(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MeshCentral-User, X-MeshCentral-Pass');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
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

            console.log(`[${new Date().toISOString()}] Command request from: ${req.socket.remoteAddress}`);
            console.log(`[${new Date().toISOString()}] Node: ${commandParams.nodeId}, Cmd: ${commandParams.command.substring(0, 50)}`);

            // Extract credentials from request headers
            const meshUser = req.headers['x-meshcentral-user'];
            const meshPass = req.headers['x-meshcentral-pass'];

            // Get or create WebSocket connection
            if (!global.meshWS || global.meshWS.readyState !== WebSocket.OPEN) {
                console.log(`[${new Date().toISOString()}] Creating new WebSocket connection...`);
                const cookie = await getSessionCookie(meshUser, meshPass);
                global.meshWS = await connectToMeshCentral(cookie);
                setupMessageHandler(global.meshWS);
            }

            // Execute command
            const result = await sendRunCommands(global.meshWS, commandParams);

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
 * HTTP endpoint for retrieving all nodes
 * GET /nodes
 */
async function handleNodesRequest(req, res) {
    console.log(`[${new Date().toISOString()}] === ENTERING handleNodesRequest ===`);
    console.log(`[${new Date().toISOString()}] Method: ${req.method}, URL: ${req.url}`);
    
    // CORS headers
    console.log(`[${new Date().toISOString()}] Setting CORS headers`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MeshCentral-User, X-MeshCentral-Pass');

    if (req.method === 'OPTIONS') {
        console.log(`[${new Date().toISOString()}] Handling OPTIONS request`);
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method !== 'GET') {
        console.log(`[${new Date().toISOString()}] Error: Non-GET method: ${req.method}`);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    try {
        console.log(`[${new Date().toISOString()}] Nodes request from: ${req.socket.remoteAddress}`);

        // Extract credentials from request headers
        const meshUser = req.headers['x-meshcentral-user'];
        const meshPass = req.headers['x-meshcentral-pass'];
        console.log(`[${new Date().toISOString()}] Credentials extracted: user=${meshUser ? 'yes' : 'no'}, pass=${meshPass ? 'yes' : 'no'}`);

        // Get or create WebSocket connection
        if (!global.meshWS || global.meshWS.readyState !== WebSocket.OPEN) {
            console.log(`[${new Date().toISOString()}] Creating new WebSocket connection for nodes request...`);
            const cookie = await getSessionCookie(meshUser, meshPass);
            console.log(`[${new Date().toISOString()}] Got session cookie, connecting WebSocket...`);
            global.meshWS = await connectToMeshCentral(cookie);
            console.log(`[${new Date().toISOString()}] WebSocket connected, setting up message handler...`);
            setupMessageHandler(global.meshWS);
        } else {
            console.log(`[${new Date().toISOString()}] Reusing existing WebSocket connection`);
        }

        // Request nodes list
        console.log(`[${new Date().toISOString()}] Sending nodes request to MeshCentral...`);
        const result = await sendNodesRequest(global.meshWS);
        console.log(`[${new Date().toISOString()}] Got nodes response, preparing to send to client`);
        
        // Extract the nodes from the response
        const nodesData = result.nodes || result;
        
        console.log(`[${new Date().toISOString()}] Writing response header (200)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        console.log(`[${new Date().toISOString()}] Sending response body`);
        res.end(JSON.stringify({
            success: true,
            result: nodesData,
            timestamp: new Date().toISOString()
        }));
        console.log(`[${new Date().toISOString()}] Response sent successfully`);
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
}

/**
 * Send nodes action to MeshCentral
 * @param {WebSocket} ws - WebSocket connection to MeshCentral
 * @returns {Promise<Object>} Nodes data organized by mesh
 */
function sendNodesRequest(ws) {
    return new Promise((resolve, reject) => {
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
        }, 30000); // 30 second timeout

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
const pfxPath = 'C:\\rewst-proxy\\llink_cert.pfx';
const certPath = 'C:\\rewst-proxy\\cert.pem';
const intermediatePath = 'C:\\rewst-proxy\\intermediate.pem';
const pfxPassword = 'Distant-Mind9';

let serverOptions = null;
try {
    const cert = fs.readFileSync(certPath, 'utf8');
    const intermediate = fs.readFileSync(intermediatePath, 'utf8');
    
    // Combine certificates in proper order: end-entity first, then intermediate
    const fullChain = cert + '\n' + intermediate;
    
    const pfxData = fs.readFileSync(pfxPath);
    serverOptions = {
        pfx: pfxData,
        passphrase: pfxPassword,
        cert: fullChain  // Also provide the PEM chain for full cert inclusion
    };
    console.log(`[${new Date().toISOString()}] SSL certificate loaded from PFX with full chain (llink.equinoxits.com)`);
} catch (err) {
    console.error(`[${new Date().toISOString()}] ERROR: Could not load PFX certificate: ${err.message}`);
    console.error(`[${new Date().toISOString()}] PFX path: ${pfxPath}`);
    process.exit(1);
}

const requestHandler = (req, res) => {
    process.stdout.write(`[${new Date().toISOString()}] *** REQUEST HANDLER CALLED: ${req.method} ${req.url} ***\n`);
    
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MeshCentral-User, X-MeshCentral-Pass');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Route requests
    if (req.url === '/command' || req.url.startsWith('/command?')) {
        handleCommandRequest(req, res);
    } else if (req.url === '/status') {
        handleStatusRequest(req, res);
    } else if (req.url === '/nodes' || req.url.startsWith('/nodes?')) {
        handleNodesRequest(req, res);
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
};

const server = https.createServer(serverOptions, requestHandler);

server.on('clientError', (err, socket) => {
    console.error(`[${new Date().toISOString()}] Client error:`, err.message);
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

server.on('secureConnection', (tlsSocket) => {
    console.log(`[${new Date().toISOString()}] TLS connection established from ${tlsSocket.remoteAddress}:${tlsSocket.remotePort}`);
    
    // Set socket timeout to 30 seconds to allow internal requests time to complete
    tlsSocket.setTimeout(30000, () => {
        console.error(`[${new Date().toISOString()}] Socket timeout from ${tlsSocket.remoteAddress} - destroying`);
        tlsSocket.destroy();
    });
    
    tlsSocket.on('data', (data) => {
        console.log(`[${new Date().toISOString()}] Data received: ${data.length} bytes`);
        console.log(`[${new Date().toISOString()}] Data: ${data.toString('utf8').substring(0, 100)}`);
    });
    
    tlsSocket.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] TLS socket error:`, err.message);
    });
    
    tlsSocket.on('close', () => {
        console.log(`[${new Date().toISOString()}] TLS socket closed`);
    });
});

// Start server
server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] Proxy server listening on HTTPS://0.0.0.0:${PROXY_PORT}`);
});

// Set request timeout to prevent requests from hanging the server
server.timeout = 10000; // 10 second timeout
server.keepAliveTimeout = 5000;

server.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Server error:`, err);
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
    if (global.meshWS) {
        global.meshWS.close();
    }
    server.close(() => {
        console.log(`[${new Date().toISOString()}] Server closed`);
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log(`[${new Date().toISOString()}] SIGINT received, shutting down...`);
    if (global.meshWS) {
        global.meshWS.close();
    }
    server.close(() => {
        console.log(`[${new Date().toISOString()}] Server closed`);
        process.exit(0);
    });
});