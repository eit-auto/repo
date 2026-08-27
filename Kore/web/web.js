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
        // libPath/libCache removed with serveLibraryFile(). /lib files are
        // served by serveStaticFile() from the shared web root, and nothing is
        // cached in memory - each request reads from disk and revalidates via
        // ETag, so a deployed file takes effect on the next request with no
        // restart or cache clear.
    }

    /**
     * Initialize web module with database connection
     * On first call: Sets up dependencies
     * On re-initialization: Clears cache, then resets dependencies
     */
    async initialize(korePool) {
        this.pool = korePool;
        global.consoleLog('Web', 'Initialized', 4);
    }

    /**
     * Route web requests
     * Returns true if route was handled, false otherwise
     */
    async handleRoute(req, res) {
        const urlPath = req.url.split('?')[0];

        // This module only serves pages/static files/lib assets - never the
        // /kore/*, /auth/*, /api/* endpoints (those are routed in kore.js's
        // requestHandler before this module is reached, and stay reachable
        // over 443 for Rewst). Web page serving is only intended for 1139,
        // so force anything landing here on 443 over to 1139 instead. No
        // proxy/load balancer sits in front of this server (both ports are
        // passed directly by the firewall), so req.socket.localPort
        // reliably reflects which port the client actually connected to.
        if (req.socket.localPort === 443) {
            const host = (req.headers.host || '').split(':')[0];
            res.writeHead(301, { Location: `https://${host}:1139${req.url}` });
            res.end();
            return true;
        }

        // Admin endpoints
        if (urlPath === '/kore/page-permissions') {
            await this.getPagePermissions(req, res);
            return true;
        }

        // NOTE: /lib/base.css and /lib/base.js used to be special-cased here,
        // routed to a dedicated serveLibraryFile(). That handler resolved the
        // exact same files the generic static branch below already reaches
        // (basePath D:\Kore\web + /lib/... = D:\Kore\web\lib\...), with .js and
        // .css already among its allowed extensions - so the only thing the
        // special case contributed was Cache-Control: max-age=31536000, telling
        // browsers to hold base.js for a YEAR without revalidating. Deploys
        // silently failed to reach anyone holding a cached copy, which looked
        // like "the fix didn't work" rather than a caching problem. Removed;
        // these now take the same path as every other /lib module.

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
                    WHERE wp.path NOT IN ('BASE', 'ADMIN_BASE', '/notfound', '/forbidden')
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
            const connection = await this.pool.getConnection();
            try {
                // Try to find the requested page - this now has to happen
                // BEFORE the auth decision below, not after, since a
                // type = 'public' page needs its own row's `type` read
                // before we know whether auth can be skipped. Previously
                // this query ran only after the auth check passed,
                // specifically to avoid a DB hit for the hardcoded
                // publicPages paths - that's no longer possible once
                // "public" can also be a per-row, data-driven property
                // rather than only a fixed list of paths.
                const pageQuery = `SELECT id, path, title, code, type, allowedIPs FROM kore_sys.web_pages WHERE path = ? AND active = TRUE`;
                global.consoleLog('Web', `Querying for page: ${requestPath}`, 4);
                const [pageRows] = await connection.execute(pageQuery, [requestPath]);
                global.consoleLog('Web', `Query returned ${pageRows.length} rows`, 4);

                let pageData = pageRows.length > 0 ? pageRows[0] : null;

                // Public pages that don't require authentication - either
                // hardcoded by path (login/usersetup/notfound have to be
                // reachable even when the page row lookup above somehow
                // fails, or before any row exists to carry a `type` at
                // all) or, now, any page whose own row is type = 'public'.
                const publicPages = ['/login', '/usersetup', '/notfound'];
                const isPublicPage = publicPages.includes(requestPath) || (pageData && pageData.type === 'public');

                // Validate token for protected pages
                if (!isPublicPage) {
                    const tokenValidation = await this.validateAndRefreshToken(req, res);
                    if (!tokenValidation.valid) {
                        // Token invalid and couldn't be refreshed, redirect to login
                        connection.release();
                        res.writeHead(302, { 'Location': '/login' });
                        res.end();
                        return;
                    }
                }


                // If page not found, try to load /notfound
                if (!pageData) {
                    global.consoleLog('Web', 'Page not found, loading /notfound', 3);
                    const notFoundQuery = `SELECT id, path, title, code, type, allowedIPs FROM kore_sys.web_pages WHERE path = '/notfound' AND active = TRUE`;
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
                        const forbiddenQuery = `SELECT id, path, title, code, type, allowedIPs FROM kore_sys.web_pages WHERE path = '/forbidden' AND active = TRUE`;
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
                        const forbiddenQuery = `SELECT id, path, title, code, type, allowedIPs FROM kore_sys.web_pages WHERE path = '/forbidden' AND active = TRUE`;
                        const [forbiddenRows] = await connection.execute(forbiddenQuery);
                        
                        if (forbiddenRows.length > 0) {
                            pageData = forbiddenRows[0];
                        }
                        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
                    }
                }

                // Load the appropriate base template. Explicit allow-list: 'user'
                // gets the user-facing BASE wrapper, 'public' gets the minimal
                // PUBLIC_BASE wrapper (no admin nav/session-dependent chrome -
                // these pages render for anonymous visitors). Anything else
                // (including a missing/unexpected type) defaults to ADMIN_BASE
                // as a guard rail, so a sensitive page never accidentally
                // renders with less-privileged chrome.
                const basePath = pageData.type === 'user' ? 'BASE' : (pageData.type === 'public' ? 'PUBLIC_BASE' : 'ADMIN_BASE');
                global.consoleLog('Web', `Loading ${basePath} template`, 4);
                const baseQuery = `SELECT code FROM kore_sys.web_pages WHERE path = ? AND active = TRUE`;
                const [baseRows] = await connection.execute(baseQuery, [basePath]);
                global.consoleLog('Web', `${basePath} template query returned ${baseRows.length} rows`, 4);

                if (baseRows.length === 0) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `${basePath} template not found` }));
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

            // Caching. Split by what changes on a deploy:
            //
            //   code (.js/.css/.html/.json/.map/.txt) -> 'no-cache'
            //   images (.png/.jpg/.gif/.svg/.ico/.webp) -> one week
            //
            // 'no-cache' does NOT mean "never cache" - it means "cache, but
            // revalidate before every use". With the ETag below, the browser
            // sends If-None-Match on each request and gets a 304 with no body
            // when nothing changed, so repeat loads stay cheap while a deploy
            // takes effect immediately.
            //
            // This matters because these URLs are stable (/lib/base.js, not
            // /lib/base.a1b2c3.js). A long max-age is the immutable-asset
            // pattern and is only safe when the filename changes every deploy;
            // applied to a stable URL it tells browsers to hold a stale copy
            // without ever asking. That is precisely what serveLibraryFile()
            // used to do to base.js and base.css with max-age=31536000 - a
            // deploy would not reach anyone still holding the old copy, and a
            // hard refresh was not always enough to dislodge it.
            //
            // Images get a real max-age because they change rarely and are not
            // part of a code deploy; a week is short enough that a swapped logo
            // or favicon works itself out without intervention.
            const eTag = `"${this.simpleHash(isBinary ? data.toString('base64') : data)}"`;

            if (req.headers['if-none-match'] === eTag) {
                res.writeHead(304, { 'ETag': eTag });
                res.end();
                return;
            }

            const cacheControl = isBinary || filePath.endsWith('.svg')
                ? 'public, max-age=604800'   // 1 week - images
                : 'no-cache';                // revalidate every time - code

            global.consoleLog('Web', `${logPrefix} Serving ${filePath} as ${contentType}`, 4);
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': cacheControl,
                'ETag': eTag,
                'Content-Length': Buffer.byteLength(data)
            });
            res.end(data);
        });
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