/**
 * Kore Web Page Generator
 * 
 * Dynamically generates web pages with permission-based content
 * Handles authentication and authorization for all web routes
 * Serves library assets (CSS, JS) with caching
 * 
 * Endpoints:
 *   GET  /lib/base.css          - Base CSS stylesheet
 *   GET  /lib/base.js           - Base JavaScript library
 *   GET  /kore/web/settings     - User settings page
 * 
 * @version 0.500 - [KORE_VERSION_INCREMENT_ON_UPDATE]
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Import token validation functions from auth module
const { validateUserSessionToken, getSessionTokenFromCookies, getRefreshTokenFromCookies } = require('../auth/auth');

class KoreWeb {
    constructor() {
        this.pool = null;
        this.libPath = 'D:\\Kore\\web\\lib';
        this.libCache = {}; // Cache file contents in memory
    }

    /**
     * Initialize web module with database connection
     * On first call: Sets up dependencies
     * On re-initialization: Clears cache, then resets dependencies
     */
    async initialize(korePool) {
        // If reinitializing (pool already set), clear cache for fresh loads
        if (this.pool) {
            global.consoleLog('Web', 'Reinitializing - clearing library cache', 3);
            this.libCache = {}; // Clear cache for fresh loads on next requests
        }
        
        this.pool = korePool;
        global.consoleLog('Web', 'Initialized', 4);
    }

    /**
     * Route web requests
     * Returns true if route was handled, false otherwise
     */
    async handleRoute(req, res) {
        const urlPath = req.url.split('?')[0];

        // Admin endpoints
        if (urlPath === '/kore/page-permissions') {
            await this.getPagePermissions(req, res);
            return true;
        }

        // Library files (no auth required)
        if (urlPath === '/lib/base.css') {
            await this.serveLibraryFile(req, res, 'base.css', 'text/css');
            return true;
        }

        if (urlPath === '/lib/base.js') {
            await this.serveLibraryFile(req, res, 'base.js', 'application/javascript');
            return true;
        }

        // Node modules - CHECK BEFORE static files since modules have extensions
        if (urlPath.startsWith('/node_modules/')) {
            this.serveStaticFile(req, res, {
                basePath: 'D:\\Kore\\node_modules',
                allowedExtensions: ['.js', '.mjs', '.d.ts', '.json', '.map', '.ts'],
                logPrefix: '[NodeModules]'
            });
            return true;
        }

        // Well-known paths (SSL validation, etc)
        if (urlPath.startsWith('/.well-known/')) {
            this.serveStaticFile(req, res, {
                basePath: 'D:\\Kore\\web',
                allowedExtensions: ['.txt', '.json', '.html'],
                logPrefix: '[WellKnown]'
            });
            return true;
        }

        // Static files (HTML, images, etc) - no auth required for these
        const hasExtension = /\.\w+$/.test(urlPath);
        if (hasExtension) {
            this.serveStaticFile(req, res, {
                basePath: 'D:\\Kore\\web',
                allowedExtensions: ['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.txt'],
                logPrefix: '[StaticWeb]'
            });
            return true;
        }

        // Dynamic pages from database (including "/")
        await this.loadPageFromDatabase(req, res, urlPath);
        return true;
    }

    /**
     * Validate session token and refresh if needed
     * Returns { valid: true } or { valid: false, refreshed: boolean }
     */
    async validateAndRefreshToken(req, res) {
        try {
            const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
            const refreshToken = getRefreshTokenFromCookies(req.headers.cookie);

            // Validate session token
            const sessionValidation = validateUserSessionToken(sessionToken);
            if (sessionValidation.valid) {
                // Session token is still valid
                req.userId = sessionValidation.userId;
                return { valid: true };
            }

            // Session token expired, try to refresh with refresh token
            if (refreshToken && global.auth) {
                try {
                    const refreshResult = await global.auth.refreshSessionTokenWithRefreshToken(refreshToken);
                    // Set new session token as cookie
                    res.setHeader('Set-Cookie', [
                        `sessionToken=${refreshResult.sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict`
                    ]);
                    
                    // Validate the new token to get userId
                    const newValidation = validateUserSessionToken(refreshResult.sessionToken);
                    if (newValidation.valid) {
                        req.userId = newValidation.userId;
                        return { valid: true, refreshed: true };
                    }
                } catch (err) {
                    global.consoleLog('Web', `Token refresh failed: ${err.message}`, 1);
                    return { valid: false, refreshed: false };
                }
            }

            // Both tokens invalid or missing
            return { valid: false, refreshed: false };
        } catch (error) {
            global.consoleLog('Web', `Token validation error: ${error.message}`, 1);
            return { valid: false, refreshed: false };
        }
    }

    /**
     * Get all page permissions for settings UI
     * Returns structured data with pages and their permission rules
     */
    async getPagePermissions(req, res) {
        try {
            // Require authentication
            if (!req.userId) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }

            // Check admin permission
            const isAdmin = await global.auth.hasPermission(req.userId, 'permissions', 'view', 'all');
            if (!isAdmin) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Forbidden' }));
                return;
            }

            const connection = await this.pool.getConnection();
            try {
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

                    // Add permission if it exists (null permissionId means no permissions for this page)
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
            global.consoleLog('Web', `Error getting page permissions: ${error.message}`, 1);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    async loadPageFromDatabase(req, res, requestPath) {
        try {
            // Define public pages that don't require authentication
            const publicPages = ['/login', '/usersetup', '/notfound'];
            const isPublicPage = publicPages.includes(requestPath);

            // Validate token for protected pages
            if (!isPublicPage) {
                const tokenValidation = await this.validateAndRefreshToken(req, res);
                if (!tokenValidation.valid) {
                    // Token invalid and couldn't be refreshed, redirect to login
                    res.writeHead(302, { 'Location': '/login' });
                    res.end();
                    return;
                }
            }

            const connection = await this.pool.getConnection();
            try {
                // Try to find the requested page
                const pageQuery = `SELECT id, path, title, code, allowedIPs FROM kore_sys.web_pages WHERE path = ? AND active = TRUE`;
                global.consoleLog('Web', `Querying for page: ${requestPath}`, 4);
                const [pageRows] = await connection.execute(pageQuery, [requestPath]);
                global.consoleLog('Web', `Query returned ${pageRows.length} rows`, 4);

                let pageData = null;
                if (pageRows.length > 0) {
                    pageData = pageRows[0];
                }

                // If page not found, try to load /notfound
                if (!pageData) {
                    global.consoleLog('Web', 'Page not found, loading /notfound', 3);
                    const notFoundQuery = `SELECT id, path, title, code, allowedIPs FROM kore_sys.web_pages WHERE path = '/notfound' AND active = TRUE`;
                    const [notFoundRows] = await connection.execute(notFoundQuery);
                    
                    if (notFoundRows.length > 0) {
                        pageData = notFoundRows[0];
                        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                    } else if (requestPath === '/') {
                        // Special case: "/" not found and no /notfound page
                        // Fallback to static index.html
                        global.consoleLog('Web', '"/" not in database, falling back to static index.html', 3);
                        connection.release();
                        this.serveStaticFile(req, res, {
                            basePath: 'D:\\Kore\\web',
                            allowedExtensions: ['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp'],
                            logPrefix: '[StaticWeb]'
                        });
                        return;
                    } else {
                        // No /notfound page in database for other pages
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Page not found' }));
                        return;
                    }
                }

                // Check IP whitelist (hard gate - before permission checks)
                if (pageData.allowedIPs) {
                    const clientIP = req.socket.remoteAddress || req.connection.remoteAddress || 'unknown';
                    global.consoleLog('Web', `Checking IP whitelist for ${clientIP} on page ${pageData.path}`, 4);
                    
                    const ipAllowed = await global.auth.isIPAllowed(clientIP, pageData.allowedIPs);
                    global.consoleLog('Web', `IP check result: ${ipAllowed}`, 4);
                    
                    if (!ipAllowed) {
                        global.consoleLog('Web', `IP denied (${clientIP}), serving /forbidden content`, 2);
                        const forbiddenQuery = `SELECT id, path, title, code, allowedIPs FROM kore_sys.web_pages WHERE path = '/forbidden' AND active = TRUE`;
                        const [forbiddenRows] = await connection.execute(forbiddenQuery);
                        
                        if (forbiddenRows.length > 0) {
                            pageData = forbiddenRows[0];
                        }
                        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
                    }
                }

                // Check permissions if user is authenticated
                if (req.userId && pageData.path !== '/notfound' && pageData.path !== '/forbidden') {
                    global.consoleLog('Web', `Checking permissions for user ${req.userId} on page ${pageData.path}`, 4);
                    const hasPermission = await global.auth.hasPermission(
                        req.userId,
                        'page',
                        'view',
                        pageData.path
                    );
                    global.consoleLog('Web', `Permission check result: ${hasPermission}`, 4);

                    if (!hasPermission) {
                        // Permission denied, load /forbidden page content but keep original URL
                        global.consoleLog('Web', 'Permission denied, serving /forbidden content', 2);
                        const forbiddenQuery = `SELECT id, path, title, code, allowedIPs FROM kore_sys.web_pages WHERE path = '/forbidden' AND active = TRUE`;
                        const [forbiddenRows] = await connection.execute(forbiddenQuery);
                        
                        if (forbiddenRows.length > 0) {
                            pageData = forbiddenRows[0];
                        }
                        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
                    }
                }

                // Load BASE template
                global.consoleLog('Web', 'Loading BASE template', 4);
                const baseQuery = `SELECT code FROM kore_sys.web_pages WHERE path = 'BASE' AND active = TRUE`;
                const [baseRows] = await connection.execute(baseQuery);
                global.consoleLog('Web', `BASE template query returned ${baseRows.length} rows`, 4);

                if (baseRows.length === 0) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'BASE template not found' }));
                    return;
                }

                const baseTemplate = baseRows[0].code;

                // Assemble page: replace placeholders in BASE with page data
                const pageTitle = pageData.title || 'Kore';
                let html = baseTemplate
                    .replace(/\{\{TITLE\}\}/g, pageTitle)
                    .replace(/\{\{CONTENT\}\}/g, pageData.code);

                // Set proper status code if not already set
                if (!res.headersSent && res.statusCode === 200) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                }

                global.consoleLog('Web', `Sending HTML response (${html.length} bytes)`, 4);
                res.end(html);

            } finally {
                connection.release();
            }
        } catch (error) {
            global.consoleLog('Web', `Error loading page from database: ${error.message}`, 1);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    /**
     * Serve static files from disk with security checks
     */
    serveStaticFile(req, res, config) {
        // config = { basePath, allowedExtensions, logPrefix }
        const basePath = config.basePath;
        const allowedExtensions = config.allowedExtensions || ['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp'];
        const logPrefix = config.logPrefix || '[StaticFile]';
        
        // Security: Restrict static web files to internal IPs only
        const IP_WHITELIST = [
            '3.139.170.31',      // Rewst US
            '13.58.15.14',       // Rewst US
            '18.218.107.198',    // Rewst US
            '192.168.141.'       // Internal subnet (any 192.168.141.x)
        ];
        
        // Parse URL to get just the pathname, stripping query parameters
        const parsedUrl = require('url').parse(req.url, true);
        let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
        
        // For /node_modules/ requests, strip the prefix to avoid doubling the directory
        if (basePath.includes('node_modules') && filePath.startsWith('/node_modules/')) {
            filePath = filePath.substring('/node_modules'.length);
        }
        
        global.consoleLog('Web', `${logPrefix} Requested: ${parsedUrl.pathname}`, 4);
        
        // Security: only allow safe file types
        const isSafeFile = allowedExtensions.some(ext => filePath.endsWith(ext));
        
        if (!isSafeFile) {
            global.consoleLog('Web', `${logPrefix} Access denied - unsafe file type: ${filePath}`, 2);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }
        
        // Normalize path separators (convert forward slashes to backslashes on Windows)
        let normalizedPath = filePath.replace(/\//g, '\\');
        const fullPath = require('path').join(basePath, normalizedPath);
        
        global.consoleLog('Web', `${logPrefix} Full path: ${fullPath}`, 4);
        
        // Security: prevent directory traversal
        if (!fullPath.startsWith(basePath)) {
            global.consoleLog('Web', `${logPrefix} Access denied - path traversal attempt`, 2);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }
        
        // Determine content type based on file extension
        let contentType = 'text/plain';
        let isBinary = false;
        
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
        } else if (filePath.endsWith('.png')) {
            contentType = 'image/png';
            isBinary = true;
        } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
            contentType = 'image/jpeg';
            isBinary = true;
        } else if (filePath.endsWith('.gif')) {
            contentType = 'image/gif';
            isBinary = true;
        } else if (filePath.endsWith('.svg')) {
            contentType = 'image/svg+xml';
        } else if (filePath.endsWith('.ico')) {
            contentType = 'image/x-icon';
            isBinary = true;
        } else if (filePath.endsWith('.webp')) {
            contentType = 'image/webp';
            isBinary = true;
        } else if (filePath.endsWith('.txt')) {
            contentType = 'text/plain';
        }
        
        // Use binary or text reading based on file type
        const readEncoding = isBinary ? null : 'utf8';
        
        fs.readFile(fullPath, readEncoding, (err, data) => {
            if (err) {
                global.consoleLog('Web', `${logPrefix} Error reading file: ${err.message}`, 1);
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File not found' }));
                return;
            }
            
            global.consoleLog('Web', `${logPrefix} Serving ${filePath} as ${contentType}`, 4);
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
    }

    /**
     * Serve library files with caching headers
     */
    async serveLibraryFile(req, res, filename, contentType) {
        try {
            const filePath = path.join(this.libPath, filename);

            // Read file from disk
            let content;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch (err) {
                global.consoleLog('Web', `Library file not found: ${filePath}`, 1);
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Library file not found' }));
                return;
            }

            // Generate ETag from content (simple hash)
            const eTag = `"${this.simpleHash(content)}"`;

            // Check If-None-Match header (browser cache validation)
            const ifNoneMatch = req.headers['if-none-match'];
            if (ifNoneMatch === eTag) {
                res.writeHead(304, { 'ETag': eTag });
                res.end();
                return;
            }

            // Set caching headers
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=31536000', // 1 year
                'ETag': eTag,
                'Last-Modified': new Date().toUTCString()
            });

            res.end(content);

        } catch (error) {
            global.consoleLog('Web', `Error serving library file: ${error.message}`, 1);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    /**
     * Simple hash function for ETag generation
     */
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(16);
    }

}

// Export as singleton
module.exports = new KoreWeb();