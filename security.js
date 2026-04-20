/**
 * Security Module
 * Version: 1.0.0
 * Cache buster: 1770321705
 * 
 * Initializes user context from wrapper page's CTX.user
 * Converts Python format to JavaScript and creates rewstUser global
 * Provides permission checking for hardcoded and config-based page access
 * 
 * Usage:
 *   1. Add inline in HTML: const rawUserData = `{{ CTX.user }}`;
 *   2. Optionally add: const pagePermissions = ['role-id-1', 'role-id-2'];
 *   3. Load this file: <script src="security.js"></script>
 *   4. Call permission check: checkPagePermission(pagePermissions);
 *   5. rewstUser is now available globally for use in other scripts
 *   6. Wrap all page content in <div id="page-content"> for permission-based hiding
 */

// Hide page content until permission check completes
// (CSS rule #page-content { display: none !important; } handles initial hiding)
const hidePageContent = () => {
    const pageContent = document.getElementById('page-content');
    if (pageContent) {
        pageContent.style.setProperty('display', 'none', 'important');
    }
};

const showPageContent = () => {
    const pageContent = document.getElementById('page-content');
    console.log('[Security] showPageContent() called');
    console.log('[Security] pageContent element found:', !!pageContent);
    
    if (pageContent) {
        console.log('[Security] Setting display to block with !important');
        pageContent.style.setProperty('display', 'block', 'important');
        console.log('[Security] After setProperty, display is now:', pageContent.style.display);
        console.log('[Security] Computed style display:', window.getComputedStyle(pageContent).display);
    } else {
        // Element doesn't exist yet, wait for DOM to be ready
        console.log('[Security] page-content not found in DOM yet, waiting for DOMContentLoaded');
        document.addEventListener('DOMContentLoaded', () => {
            const pc = document.getElementById('page-content');
            if (pc) {
                console.log('[Security] After DOMContentLoaded, found page-content, showing it');
                pc.style.setProperty('display', 'block', 'important');
                console.log('[Security] Computed style display:', window.getComputedStyle(pc).display);
            }
        });
    }
};

// Note: hidePageContent() is called by CSS, not JavaScript for better performance

let rewstUser = null;

// ============================================
// USER INITIALIZATION
// ============================================

try {
    // rawUserData must be set inline in the HTML from {{ CTX.user }}
    if (typeof rawUserData === 'undefined') {
        throw new Error('rawUserData not defined - inline user capture script must run first');
    }

    // Convert Python format to JavaScript format
    const jsUserData = rawUserData
        .replace(/False/g, 'false')
        .replace(/True/g, 'true')
        .replace(/None/g, 'null');
    
    // Parse and initialize user
    rewstUser = eval('(' + jsUserData + ')');
    console.log('[Security] User initialized:', rewstUser.username);
    console.log('[Security] User ID:', rewstUser.id);
    console.log('[Security] Assigned roles:', rewstUser.roleIds);
    
    // Add shortusername (username before @ symbol)
    if (rewstUser.username && rewstUser.username.includes('@')) {
        rewstUser.shortusername = rewstUser.username.split('@')[0];
    } else {
        rewstUser.shortusername = rewstUser.username;
    }
    console.log('[Security] Short username:', rewstUser.shortusername);
    
    // Also add to pageVariables if it exists
    if (typeof window.pageVariables !== 'undefined') {
        window.pageVariables.rewstUser = rewstUser;
        console.log('[Security] rewstUser added to pageVariables');
    }
    
} catch (error) {
    console.error('[Security] Failed to initialize user:', error.message);
    if (typeof rawUserData !== 'undefined') {
        console.error('[Security] Raw data:', rawUserData);
    }
    rewstUser = null;
}

// ============================================
// ROLE INITIALIZATION
// ============================================

let allUserRoles = [];

/**
 * Fetch all available Rewst user roles from GraphQL
 * Populates global allUserRoles array
 * 
 * @returns {Promise<Array>} Array of {label, value} objects for each role
 */
async function initializeUserRoles() {
    if (!window.ORG_ID) {
        console.warn('[Security] ORG_ID not set - skipping role initialization');
        return [];
    }

    const query = `
        query GetRoles($modelName: LocalReferenceModel!, $orgId: ID!) {
            roles: localReferenceOptions(
                modelName: $modelName
                orgId: $orgId
                filterArg: {}
            ) {
                label
                value
            }
        }
    `;

    console.log('[Security] Fetching available user roles for org:', window.ORG_ID);

    try {
        const response = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: query,
                variables: {
                    modelName: 'Role',
                    orgId: window.ORG_ID
                }
            })
        });

        const data = await response.json();

        if (data.errors) {
            console.error('[Security] GraphQL errors fetching roles:', data.errors);
            throw new Error(data.errors[0]?.message || 'GraphQL error occurred');
        }

        if (!data.data || !data.data.roles) {
            console.error('[Security] No roles found in response');
            throw new Error('No roles data in response');
        }

        allUserRoles = data.data.roles;
        console.log('[Security] Successfully initialized', allUserRoles.length, 'user roles');
        return allUserRoles;

    } catch (error) {
        console.error('[Security] Error initializing user roles:', error);
        allUserRoles = [];
        throw error;
    }
}

// Auto-initialize roles if page has completed user initialization
if (rewstUser && window.ORG_ID) {
    initializeUserRoles().catch(error => {
        console.warn('[Security] Failed to auto-initialize roles:', error.message);
    });
}

// For config-based pages with no hardcoded permissions, show page content
// (Permission check will be done against config's permissions later)
if (typeof pagePermissions !== 'undefined' && pagePermissions.length === 0) {
    showPageContent();
    console.log('[Security] No hardcoded permissions - showing page content (config-based page)');
}

// ============================================
// PERMISSION CHECKING
// ============================================

/**
 * Check if user has permission to view page
 * Compares user's roleIds against required roles
 * If permission denied, displays error message and stops page rendering
 * 
 * @param {Array<string>} requiredRoleIds - List of role IDs that can access the page
 * @returns {boolean} True if user has permission, false otherwise
 * 
 * @example
 *   // Hardcoded permissions
 *   const pagePermissions = ['role-admin', 'c0821333-66c1-461e-80f5-92f13d9d606d'];
 *   checkPagePermission(pagePermissions);
 * 
 *   // Config-based permissions (after loading config)
 *   checkPagePermission(pageConfig.permissions.roleIds);
 */
function checkPagePermission(requiredRoleIds) {
    console.log('[Security] checkPagePermission() called with:', requiredRoleIds);
    console.log('[Security] Checking page permissions...');
    console.log('[Security] Required roles:', requiredRoleIds);
    
    // Validate inputs
    if (!rewstUser) {
        console.error('[Security] User not initialized - cannot check permissions');
        showPermissionDenied('User information could not be loaded');
        return false;
    }

    if (!Array.isArray(requiredRoleIds) || requiredRoleIds.length === 0) {
        console.warn('[Security] No required roles specified - access granted');
        console.log('[Security] Calling showPageContent() for empty permissions');
        showPageContent();
        return true;
    }

    // Check if user has any of the required roles
    console.log('[Security] User roleIds:', rewstUser.roleIds);
    const hasPermission = requiredRoleIds.some(roleId => 
        rewstUser.roleIds.includes(roleId)
    );
    
    console.log('[Security] Has permission:', hasPermission);
    
    if (!hasPermission) {
        console.warn('[Security] User lacks required permissions');
        console.warn('[Security] User roles:', rewstUser.roleIds);
        console.warn('[Security] Required roles:', requiredRoleIds);
        showPermissionDenied('Your user account does not have permission to view this page');
        return false;
    }
    
    console.log('[Security] User has permission to view page');
    console.log('[Security] Calling showPageContent()');
    // Show page content since permission is granted
    showPageContent();
    return true;
}

/**
 * Display permission denied message and prevent page rendering
 * Replaces body content with error message and throws error to halt execution
 * 
 * @param {string} message - Custom error message to display
 */
function showPermissionDenied(message) {
    console.error('[Security] Displaying permission denied message');
    
    // Replace entire page with error message to prevent any body scripts from executing
    const errorHtml = `
        <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Access Denied</title>
            </head>
            <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                <div style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #1a1a1a; margin: 0; padding: 0;">
                    <div style="text-align: center; padding: 40px; background: #2E5F75; border-radius: 8px; max-width: 500px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);">
                        <h1 style="color: #dc3545; margin-top: 0; font-size: 28px; margin-bottom: 20px;">Access Denied</h1>
                        <p style="color: #ffffff; font-size: 16px; line-height: 1.6; margin: 20px 0;">
                            ${escapeHtml(message)}
                        </p>
                        <p style="color: #888; font-size: 14px; margin-bottom: 0;">
                            If you believe this is an error, please contact your administrator.
                        </p>
                    </div>
                </div>
            </body>
        </html>
    `;
    
    // Replace entire page content - this prevents any body scripts from executing
    document.documentElement.innerHTML = errorHtml;
    
    throw new Error('User does not have permission to view this page');
}

/**
 * Escape HTML special characters to prevent injection
 * @param {string} text - Text to escape
 * @returns {string} Escaped text safe for HTML
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Check if user has a specific role
 * 
 * @param {string} roleId - Role ID to check
 * @returns {boolean} True if user has the role
 */
function userHasRole(roleId) {
    if (!rewstUser || !rewstUser.roleIds) {
        return false;
    }
    return rewstUser.roleIds.includes(roleId);
}

/**
 * Check if user has any of the specified roles
 * 
 * @param {Array<string>} roleIds - Array of role IDs to check
 * @returns {boolean} True if user has at least one of the roles
 */
function userHasAnyRole(roleIds) {
    if (!rewstUser || !rewstUser.roleIds || !Array.isArray(roleIds)) {
        return false;
    }
    return roleIds.some(roleId => rewstUser.roleIds.includes(roleId));
}

/**
 * Check if user has all of the specified roles
 * 
 * @param {Array<string>} roleIds - Array of role IDs to check
 * @returns {boolean} True if user has all of the roles
 */
function userHasAllRoles(roleIds) {
    if (!rewstUser || !rewstUser.roleIds || !Array.isArray(roleIds)) {
        return false;
    }
    return roleIds.every(roleId => rewstUser.roleIds.includes(roleId));
}

// Export functions and data globally so they're accessible from page scripts
if (typeof window !== 'undefined') {
    window.checkPagePermission = checkPagePermission;
    window.userHasRole = userHasRole;
    window.userHasAnyRole = userHasAnyRole;
    window.userHasAllRoles = userHasAllRoles;
    window.initializeUserRoles = initializeUserRoles;
}