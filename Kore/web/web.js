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
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

class KoreWeb {
    constructor() {
        this.pool = null;
        this.libPath = 'D:\\Kore\\web\\lib';
        this.libCache = {}; // Cache file contents in memory
    }

    /**
     * Initialize web module with database connection
     */
    async initialize(korePool) {
        this.pool = korePool;
        console.log('[KoreWeb] Initialized');
    }

    /**
     * Route web requests
     * Returns true if route was handled, false otherwise
     */
    async handleRoute(req, res) {
        const urlPath = req.url.split('?')[0];

        // Library files (no auth required)
        if (urlPath === '/lib/base.css') {
            await this.serveLibraryFile(req, res, 'base.css', 'text/css');
            return true;
        }

        if (urlPath === '/lib/base.js') {
            await this.serveLibraryFile(req, res, 'base.js', 'application/javascript');
            return true;
        }

        // Static files (HTML, images, etc) - no auth required for these
        const hasExtension = /\.\w+$/.test(urlPath);
        if (urlPath === '/' || hasExtension) {
            this.serveStaticFile(req, res, {
                basePath: 'D:\\Kore\\web',
                allowedExtensions: ['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp'],
                logPrefix: '[StaticWeb]'
            });
            return true;
        }

        // Node modules
        if (urlPath.startsWith('/node_modules/')) {
            this.serveStaticFile(req, res, {
                basePath: 'D:\\Kore\\node_modules',
                allowedExtensions: ['.js', '.d.ts', '.json', '.map'],
                logPrefix: '[NodeModules]'
            });
            return true;
        }

        // Dynamic pages from database (extensionless paths)
        await this.loadPageFromDatabase(req, res, urlPath);
        return true;
    }

    /**
     * Load page from database, check permissions, and assemble with BASE template
     */
    async loadPageFromDatabase(req, res, requestPath) {
        try {
            const connection = await this.pool.getConnection();
            try {
                // Try to find the requested page
                const pageQuery = `SELECT id, path, title, code FROM web_pages WHERE path = ? AND active = TRUE`;
                const [pageRows] = await connection.execute(pageQuery, [requestPath]);

                let pageData = null;
                if (pageRows.length > 0) {
                    pageData = pageRows[0];
                }

                // If page not found, try to load /notfound
                if (!pageData) {
                    const notFoundQuery = `SELECT id, path, title, code FROM web_pages WHERE path = '/notfound' AND active = TRUE`;
                    const [notFoundRows] = await connection.execute(notFoundQuery);
                    
                    if (notFoundRows.length > 0) {
                        pageData = notFoundRows[0];
                        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                    } else {
                        // No /notfound page in database
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Page not found' }));
                        return;
                    }
                }

                // Check permissions if user is authenticated
                if (req.userId && pageData.path !== '/notfound') {
                    const userGroups = await this.getUserGroups(req.userId);
                    const hasPermission = await this.checkPermission(
                        req.userId,
                        userGroups,
                        'page',
                        pageData.path
                    );

                    if (!hasPermission) {
                        // Permission denied, serve notfound
                        const accessDeniedQuery = `SELECT id, path, title, code FROM web_pages WHERE path = '/notfound' AND active = TRUE`;
                        const [accessDeniedRows] = await connection.execute(accessDeniedQuery);
                        
                        if (accessDeniedRows.length > 0) {
                            pageData = accessDeniedRows[0];
                        }
                        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
                    }
                }

                // Load BASE template
                const baseQuery = `SELECT code FROM web_pages WHERE path = 'BASE' AND active = TRUE`;
                const [baseRows] = await connection.execute(baseQuery);

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

                res.end(html);

            } finally {
                connection.release();
            }
        } catch (error) {
            console.error('[KoreWeb] Error loading page from database:', error);
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
        
        const isIPWhitelisted = (ip) => {
            return IP_WHITELIST.some(whitelistedIp => {
                if (whitelistedIp.endsWith('.')) {
                    return ip.startsWith(whitelistedIp);
                }
                return ip === whitelistedIp;
            });
        };
        
        const clientIP = req.socket.remoteAddress;
        if (!isIPWhitelisted(clientIP)) {
            console.log(`${logPrefix} Static file access denied for external IP ${clientIP}: ${req.url}`);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied' }));
            return;
        }
        
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
        }
        
        // Use binary or text reading based on file type
        const readEncoding = isBinary ? null : 'utf8';
        
        fs.readFile(fullPath, readEncoding, (err, data) => {
            if (err) {
                console.log(`${logPrefix} Error reading file: ${err.message}`);
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File not found' }));
                return;
            }
            
            console.log(`${logPrefix} Serving ${filePath} as ${contentType}`);
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
                console.error(`[KoreWeb] Library file not found: ${filePath}`);
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
            console.error('[KoreWeb] Error serving library file:', error);
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


    /**
     * Load page from database, check permissions, and assemble with BASE template
     */
    async loadPageFromDatabase(req, res, requestPath) {
        try {
            const connection = await this.pool.getConnection();
            try {
                // Try to find the requested page
                const pageQuery = `SELECT id, path, title, code FROM web_pages WHERE path = ? AND active = TRUE`;
                const [pageRows] = await connection.execute(pageQuery, [requestPath]);

                let pageData = null;
                if (pageRows.length > 0) {
                    pageData = pageRows[0];
                }

                // If page not found, try to load /notfound
                if (!pageData) {
                    const notFoundQuery = `SELECT id, path, title, code FROM web_pages WHERE path = '/notfound' AND active = TRUE`;
                    const [notFoundRows] = await connection.execute(notFoundQuery);
                    
                    if (notFoundRows.length > 0) {
                        pageData = notFoundRows[0];
                        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                    } else {
                        // No /notfound page in database
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Page not found' }));
                        return;
                    }
                }

                // Check permissions if user is authenticated
                if (req.userId && pageData.path !== '/notfound') {
                    const userGroups = await this.getUserGroups(req.userId);
                    const hasPermission = await this.checkPermission(
                        req.userId,
                        userGroups,
                        'page',
                        pageData.path
                    );

                    if (!hasPermission) {
                        // Permission denied, serve notfound
                        const accessDeniedQuery = `SELECT id, path, title, code FROM web_pages WHERE path = '/notfound' AND active = TRUE`;
                        const [accessDeniedRows] = await connection.execute(accessDeniedQuery);
                        
                        if (accessDeniedRows.length > 0) {
                            pageData = accessDeniedRows[0];
                        }
                        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
                    }
                }

                // Load BASE template
                const baseQuery = `SELECT code FROM web_pages WHERE path = 'BASE' AND active = TRUE`;
                const [baseRows] = await connection.execute(baseQuery);

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

                res.end(html);

            } finally {
                connection.release();
            }
        } catch (error) {
            console.error('[KoreWeb] Error loading page from database:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
}

// Export as singleton
module.exports = new KoreWeb();