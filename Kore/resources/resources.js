/**
 * Resources - Kore Managed Resource Module
 *
 * Mostly a stateless function module - no active operations or state to
 * drain on reload/restart. One exception: an in-memory per-user cache for
 * built user-menu trees (see userMenusCache below). That cache is purely
 * disposable — losing it on restart or require.cache clearing just means
 * the next request rebuilds it, nothing needs draining.
 * Simply export and re-export on subsystem reload via require.cache clearing.
 * All functions read from/write to database via global.auth.korePool.
 *
 * Handles CRUD operations and permission enforcement for managed resources:
 *   - Workflows (moved from Persephone; execution remains in Persephone)
 *   - Forms
 *   - Datatables (future)
 *
 * API Endpoints:
 *   GET    /kore/workflows               - List all workflows
 *   POST   /kore/workflows               - Create new workflow
 *   GET    /kore/workflows/:id           - Get latest workflow version
 *   GET    /kore/workflows/:id/:version  - Get specific workflow version
 *   PUT    /kore/workflows/:id           - Update workflow
 *   DELETE /kore/workflows/:id/:version  - Archive workflow version
 *
 *   GET    /kore/workflow-folders        - List all folders
 *   POST   /kore/workflow-folders        - Create folder
 *   PUT    /kore/workflow-folders/:id    - Update folder
 *   DELETE /kore/workflow-folders/:id    - Delete folder
 *
 *   GET    /kore/forms                   - List forms
 *   POST   /kore/forms                   - Create new form
 *   GET    /kore/forms/:id               - Get a specific form
 *   PUT    /kore/forms/:id               - Update a form
 *   DELETE /kore/forms/:id               - Delete a form
 *
 *   GET    /kore/form-folders            - List all form folders
 *   POST   /kore/form-folders            - Create form folder
 *   PUT    /kore/form-folders/:id        - Update form folder
 *   DELETE /kore/form-folders/:id        - Delete form folder
 *
 *   GET    /kore/workflow-utils              - List all workflow actions (?include_disabled=true for all)
 *   POST   /kore/workflow-utils              - Create workflow action
 *   GET    /kore/workflow-utils/:action_name - Get specific action (includes code)
 *   PUT    /kore/workflow-utils/:action_name - Update action
 *   DELETE /kore/workflow-utils/:action_name - Delete action
 *
 *   GET    /kore/user-menus              - Get the current user's permission-filtered
 *                                          User Portal menu tree (see user_menus table)
 *
 *   GET    /kore/docs                    - List docs (?type=, ?tag=, ?folder=, ?search= filters)
 *   POST   /kore/docs                    - Create new doc (version 1.0)
 *   GET    /kore/docs/:id                - Get latest doc version
 *   GET    /kore/docs/:id/:version       - Get a specific historical doc version
 *   GET    /kore/docs/:id/history        - List version history (version/deleted/created_at only)
 *   PUT    /kore/docs/:id                - Update a doc (auto-increments minor version)
 *   DELETE /kore/docs/:id                - Soft-delete a doc (sets active = FALSE, snapshots final state)
 *   POST   /kore/docs/refresh-titles     - Admin: re-resolve every dynamic_title doc's cached title
 *                                          against its live linked resource. Title-only write, no
 *                                          version bump / docs_hist entry - see refreshDynamicTitles().
 *
 *   GET    /kore/doc-folders             - List all doc folders
 *   POST   /kore/doc-folders             - Create doc folder
 *   PUT    /kore/doc-folders/:id         - Update doc folder
 *   DELETE /kore/doc-folders/:id         - Delete doc folder
 *
 * @version 0.104
 */

'use strict';

const { validateUserSessionToken, getSessionTokenFromCookies } = require('../auth/auth');

function generateId(prefix = '') {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = prefix ? prefix + '-' : '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

// ============================================================
// HELPERS
// ============================================================

function getPool() {
    return global.auth.korePool;
}

/**
 * Parse request body as JSON
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Authenticate request; returns { valid, userId } or sends 401 and returns null.
 */
function authenticate(req, res) {
    const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
    const validation = validateUserSessionToken(sessionToken);
    if (!validation.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return null;
    }
    return validation;
}

/**
 * Authorize an already-authenticated request for the User Menus admin
 * editor (Settings > User Portal). Reuses the existing 'menu' permission
 * resource - the same resource type that already gates individual menu
 * pill/category visibility in the User Portal (see filterUserMenuTreeForUser
 * below) - with a dedicated 'admin' action so it can be granted
 * independently of any single menu's own view permission.
 *
 * Sends 403 and returns false if the caller lacks 'menu'/'admin'/null;
 * caller should return immediately when this returns false.
 */
async function authorizeMenuAdmin(req, res, auth) {
    const allowed = await global.auth.hasPermission(auth.userId, 'menu', 'admin', null);
    if (!allowed) {
        send(res, 403, { error: 'Forbidden' });
        return false;
    }
    return true;
}

/**
 * Send a JSON response
 */
function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * Parse query string parameters
 */
function parseQueryParams(url) {
    const parsed = new URL(url, 'http://localhost');
    const params = {};
    parsed.searchParams.forEach((value, key) => {
        params[key] = value;
    });
    return params;
}


// ============================================================
// GENERIC FOLDER FUNCTIONS
// ============================================================

/**
 * Get all folders for a resource type
 * @param {string} tableName - Table name (workflow_folders, form_folders, etc.)
 */
async function getFolders(tableName) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT id, name, parent_id FROM kore_sys.${tableName} ORDER BY name ASC`
        );
        return rows || [];
    } finally {
        conn.release();
    }
}

/**
 * Create a folder
 * @param {string} tableName - Table name
 * @param {object} folderData - Folder data (should include name, may include id and parent_id)
 * @param {boolean} autoGenerateId - If true, generate ID; if false, expect id in folderData
 */
async function createFolder(tableName, folderData, autoGenerateId = false) {
    const { name, parent_id } = folderData;
    if (!name) throw new Error('name is required');

    const conn = await getPool().getConnection();
    try {
        let folderId;

        if (autoGenerateId) {
            let inserted = false;
            for (let attempt = 0; attempt < 5; attempt++) {
                folderId = generateId();
                try {
                    await conn.execute(
                        `INSERT INTO kore_sys.${tableName} (id, name, parent_id) VALUES (?, ?, ?)`,
                        [folderId, name, parent_id || null]
                    );
                    inserted = true;
                    break;
                } catch (err) {
                    if (err.code === 'ER_DUP_ENTRY') continue;
                    throw err;
                }
            }
            if (!inserted) throw new Error('Failed to generate unique folder ID after 5 attempts');
        } else {
            folderId = folderData.id;
            if (!folderId) throw new Error('id is required');
            await conn.execute(
                `INSERT INTO kore_sys.${tableName} (id, name, parent_id) VALUES (?, ?, ?)`,
                [folderId, name, parent_id || null]
            );
        }
        return { id: folderId, name, parent_id: parent_id || null };
    } finally {
        conn.release();
    }
}

/**
 * Update a folder
 * @param {string} tableName - Table name
 * @param {string} folderId - Folder ID
 * @param {object} updates - Fields to update (name, parent_id)
 */
async function updateFolder(tableName, folderId, updates) {
    const conn = await getPool().getConnection();
    try {
        const updateFields = [];
        const values = [];

        if (updates.hasOwnProperty('name')) {
            updateFields.push('name = ?');
            values.push(updates.name);
        }
        if (updates.hasOwnProperty('parent_id')) {
            updateFields.push('parent_id = ?');
            values.push(updates.parent_id || null);
        }

        if (updateFields.length === 0) throw new Error('No fields to update');

        values.push(folderId);

        const [result] = await conn.execute(
            `UPDATE kore_sys.${tableName} SET ${updateFields.join(', ')} WHERE id = ?`,
            values
        );

        if (result.affectedRows === 0) throw new Error('Folder not found');

        return { success: true };
    } finally {
        conn.release();
    }
}

/**
 * Delete a folder: re-parents child folders to root, detaches items, then removes the folder.
 * @param {string} folderTableName - Folder table name (workflow_folders, form_folders)
 * @param {string} folderId - Folder ID to delete
 * @param {string} itemTableName - Name of resource table to orphan (workflows, forms)
 */
async function deleteFolder(folderTableName, folderId, itemTableName) {
    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();

        // Verify folder exists
        const [folders] = await conn.execute(
            `SELECT id FROM kore_sys.${folderTableName} WHERE id = ?`, [folderId]
        );
        if (folders.length === 0) throw new Error('Folder not found');

        // Re-parent child folders to root AND detach items - both, unconditionally.
        // This was previously an if/else (children only when children existed,
        // items only when they didn't), so a folder holding both subfolders and
        // items left the items pointing at a deleted folder id. The ON DELETE SET
        // NULL constraints since added to <itemTable>.folder_id and
        // <folderTable>.parent_id would now catch that at the DB level, but doing
        // it explicitly keeps the intent visible in the code rather than leaving it
        // as an invisible constraint side effect.
        await conn.execute(
            `UPDATE kore_sys.${folderTableName} SET parent_id = NULL WHERE parent_id = ?`,
            [folderId]
        );
        await conn.execute(
            `UPDATE kore_sys.${itemTableName} SET folder_id = NULL WHERE folder_id = ?`,
            [folderId]
        );

        // Delete the folder
        await conn.execute(
            `DELETE FROM kore_sys.${folderTableName} WHERE id = ?`,
            [folderId]
        );

        await conn.commit();
        return { success: true };
    } catch (error) {
        try {
            await conn.rollback();
        } catch (rollbackError) {
            global.consoleLog('Resources', `Rollback failed during folder delete ${folderId}: ${rollbackError.message}`, 1);
        }
        throw error;
    } finally {
        conn.release();
    }
}

// ============================================================
// WORKFLOW FOLDER FUNCTIONS
// ============================================================

/**
 * Validate workflow JSON structure and Nunjucks templates
 * Note: Nunjucks template validation is intentionally kept here so the resource
 * layer can reject structurally invalid workflows before they reach the engine.
 */
async function validateWorkflow(definition) {
    const errors = [];

    if (!definition.name)    errors.push('Workflow must have a name');

    if (!definition.steps || !Array.isArray(definition.steps)) {
        errors.push('Workflow must have a steps array');
    }

    // Basic template syntax check on step fields (no nunjucks dependency here —
    // the engine will catch runtime errors; we just flag obvious syntax issues)
    if (Array.isArray(definition.steps)) {
        for (let i = 0; i < definition.steps.length; i++) {
            const step = definition.steps[i];
            if (!step.id)   errors.push(`Step ${i} missing id`);
            if (!step.type) errors.push(`Step ${i} missing type`);
        }
    }

    return { isValid: errors.length === 0, errors };
}

/**
 * Generic resource create
 * @param {string} resourceType      - e.g. 'form', 'workflow'
 * @param {string} table             - e.g. 'kore_sys.forms'
 * @param {string} histTable         - e.g. 'kore_sys.forms_hist'
 * @param {string} histFkCol         - e.g. 'form_id'
 * @param {object} definition        - fully-built default definition
 * @param {string} name              - resource name
 * @param {string} userId
 * @param {string|null} folder_id
 * @param {string|null} allowedIPs
 */
async function createResource(resourceType, table, histTable, histFkCol, definition, name, userId, folder_id, allowedIPs) {
    const version = '1.0';
    const now = new Date().toISOString();

    const definitionToStore = {
        ...definition,
        meta_data: {
            created_by: userId,
            created_at: now,
            modified_by: userId,
            modified_at: now
        }
    };

    const conn = await getPool().getConnection();
    try {
        let id, inserted = false;
        let lastErr = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            id = generateId();
            try {
                await conn.execute(
                    `INSERT INTO ${table} (id, name, version, definition, allowedIPs, folder_id) VALUES (?, ?, ?, ?, ?, ?)`,
                    [id, name, version, JSON.stringify(definitionToStore), allowedIPs || null, folder_id || null]
                );
                inserted = true;
                break;
            } catch (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    lastErr = err;
                    continue;
                }
                throw err;
            }
        }
        if (!inserted) {
            // A duplicate on this freshly-generated random id is essentially
            // impossible on its own (huge id space) - a real collision here
            // almost always means something in the posted definition itself
            // (most commonly its own `id` field, left over from a previous
            // export/import rather than regenerated) collides with an
            // existing row on some other unique constraint. Regenerating the
            // row's own random id can never fix that, so retrying 5 times
            // doesn't help - surface the underlying detail rather than the
            // generic, misleading "failed to generate unique ID".
            const detail = lastErr && (lastErr.sqlMessage || lastErr.message);
            throw new Error(
                `A ${resourceType} with this ID already exists` + (detail ? ` (${detail})` : '') +
                ` - if this was imported/copied from elsewhere, make sure its "id" field was regenerated rather than reused.`
            );
        }
        await conn.execute(
            `INSERT INTO ${histTable} (${histFkCol}, version, definition) VALUES (?, ?, ?)`,
            [id, version, JSON.stringify(definitionToStore)]
        );
        global.consoleLog('Resources', `${resourceType} created: ${id} (${name})`, 3);
        return { id, name, version };
    } finally {
        conn.release();
    }
}

/**
 * Generic resource update
 * @param {string} resourceType      - e.g. 'form', 'workflow'
 * @param {string} table             - e.g. 'kore_sys.forms'
 * @param {string} histTable         - e.g. 'kore_sys.forms_hist'
 * @param {string} histFkCol         - e.g. 'form_id'
 * @param {string} id                - resource UUID
 * @param {object} data              - can include definition, folder_id, allowedIPs
 * @param {string} userId
 * @param {function|null} validator  - optional async fn(definition) returning {isValid, errors}
 */
async function updateResource(resourceType, table, histTable, histFkCol, id, data, userId, validator = null) {
    const { definition, folder_id, allowedIPs } = data;

    if (definition && validator) {
        const validation = await validator(definition);
        if (!validation.isValid) throw new Error(`${resourceType} validation failed: ${validation.errors.join(', ')}`);
    }

    const conn = await getPool().getConnection();
    try {
        const [currentRows] = await conn.execute(
            `SELECT version, definition FROM ${table} WHERE id = ?`, [id]
        );
        if (currentRows.length === 0) throw new Error(`${resourceType} not found`);

        const currentDef = typeof currentRows[0].definition === 'string'
            ? JSON.parse(currentRows[0].definition)
            : currentRows[0].definition;

        // Auto-increment minor version server-side (e.g. 1.0 -> 1.1 -> 1.2)
        const [major, minor] = (currentRows[0].version || '1.0').split('.').map(Number);
        const newVersion = `${major}.${(minor || 0) + 1}`;

        const updatedDef = definition ? {
            ...definition,
            meta_data: {
                created_at: currentDef.meta_data?.created_at || new Date().toISOString(),
                created_by: currentDef.meta_data?.created_by || userId,
                modified_at: new Date().toISOString(),
                modified_by: userId
            }
        } : currentDef;

        const updateFields = [];
        const values = [];

        if (definition) {
            updateFields.push('definition = ?');
            values.push(JSON.stringify(updatedDef));
            updateFields.push('version = ?');
            values.push(newVersion);
            if (updatedDef.name) {
                updateFields.push('name = ?');
                values.push(updatedDef.name);
            }
        }
        if (data.hasOwnProperty('folder_id')) {
            updateFields.push('folder_id = ?');
            values.push(folder_id || null);
        }
        if (data.hasOwnProperty('allowedIPs')) {
            updateFields.push('allowedIPs = ?');
            values.push(allowedIPs || null);
        }

        if (updateFields.length === 0) throw new Error('No fields to update');

        values.push(id);
        await conn.execute(
            `UPDATE ${table} SET ${updateFields.join(', ')} WHERE id = ?`,
            values
        );

        // Check if this version already exists in history (immutable history)
        const [existingHist] = await conn.execute(
            `SELECT 1 FROM ${histTable} WHERE ${histFkCol} = ? AND version = ?`,
            [id, newVersion]
        );

        // Only insert if this is a new version
        if (existingHist.length === 0) {
            await conn.execute(
                `INSERT INTO ${histTable} (${histFkCol}, version, definition) VALUES (?, ?, ?)`,
                [id, newVersion, JSON.stringify(updatedDef)]
            );
        }

        global.consoleLog('Resources', `${resourceType} updated: ${id} (v${newVersion})`, 3);
        return { id, version: newVersion };
    } finally {
        conn.release();
    }
}

/**
 * Create a new workflow
 */
async function createWorkflow(workflowData, userId) {
    const { name, folder_id, allowedIPs, definition: providedDefinition } = workflowData;
    if (!name) throw new Error('name is required');

    // If a full definition was posted (e.g. the workflows-list page's Import
    // flow), use it as-is instead of silently discarding it - this function
    // previously always ignored workflowData.definition entirely and built a
    // hardcoded blank Begin-only definition regardless of what was actually
    // sent, which meant an imported workflow's steps/triggers/variables/etc.
    // all got dropped, keeping only its name. Keep `name` in sync with the
    // top-level name actually used to create the row, in case it differs
    // from definition.name for some reason.
    let definition;
    if (providedDefinition && typeof providedDefinition === 'object' && !Array.isArray(providedDefinition)) {
        const validation = await validateWorkflow(providedDefinition);
        if (!validation.isValid) {
            throw new Error(`workflow validation failed: ${validation.errors.join(', ')}`);
        }
        definition = { ...providedDefinition, name };
    } else {
        definition = {
            name,
            view: { pan: '0,0', zoom: 1 },
            steps: [{
                id: generateId(),
                name: 'BEGIN',
                type: 'Begin',
                width: 3,
                height: 1,
                position: '1,1',
                variables: [],
                overrideSize: false,
                transition: {
                    position: '1,1',
                    mode: 'First',
                    vertical: false,
                    attached: true,
                    cases: [{ type: 'Success', conditions: '', targetSteps: [], targetNodes: [], order: 1 }]
                }
            }],
            active: true,
            inputs: [],
            outputs: []
        };
    }

    return createResource('workflow', 'kore_sys.workflows', 'kore_sys.workflows_hist', 'workflow_id', definition, name, userId, folder_id, allowedIPs);
}

/**
 * Update an existing workflow
 */
async function updateWorkflow(workflowId, workflowData, userId) {
    return updateResource('workflow', 'kore_sys.workflows', 'kore_sys.workflows_hist', 'workflow_id', workflowId, workflowData, userId, validateWorkflow);
}

/**
 * Create a new form
 */
async function createForm(formData, userId) {
    const { name, description, folder_id, allowedIPs } = formData;
    if (!name) throw new Error('name is required');

    const definition = {
        name,
        description: description || '',
        active: true,
        show_name: true,
        column_count: 1,
        show_vert_sep: false,
        submit_type: 'workflow',
        field_configs: []
    };

    return createResource('form', 'kore_sys.forms', 'kore_sys.forms_hist', 'form_id', definition, name, userId, folder_id, allowedIPs);
}

/**
 * Update an existing form
 */
async function updateForm(formId, formData, userId) {
    return updateResource('form', 'kore_sys.forms', 'kore_sys.forms_hist', 'form_id', formId, formData, userId);
}

/**
 * List all workflows (current version only), with permission IDs attached
 */
/**
 * List all workflows
 * @param {string} clientIP - Client IP for IP whitelist check
 */
async function listWorkflows(clientIP) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT w.id, w.name, w.version, w.folder_id, w.definition, w.allowedIPs,
                    f.name as folder_name, f.parent_id as folder_parent_id,
                    GROUP_CONCAT(p.permissionId) as permissionIds
             FROM kore_sys.workflows w
             LEFT JOIN kore_sys.workflow_folders f ON w.folder_id = f.id
             LEFT JOIN kore_sys.permissions p ON p.resource = 'workflow' AND p.scope = w.id
             GROUP BY w.id, w.name, w.version, w.folder_id, w.definition, w.allowedIPs, f.name, f.parent_id
             ORDER BY w.name ASC`
        );
        const results = [];
        for (const row of rows) {
            // Check IP allowance first (hard gate)
            if (row.allowedIPs) {
                const ipAllowed = await global.auth.isIPAllowed(clientIP, row.allowedIPs);
                if (!ipAllowed) continue;
            }

            const definition = typeof row.definition === 'string'
                ? JSON.parse(row.definition) : row.definition;
            results.push({
                id: row.id,
                name: row.name,
                version: row.version,
                folder_id: row.folder_id || null,
                folder_name: (row.folder_id && row.folder_name) ? row.folder_name : null,
                definition,
                allowedIPs: row.allowedIPs,
                permissionIds: row.permissionIds ? row.permissionIds.split(',') : []
            });
        }
        return results;
    } finally {
        conn.release();
    }
}

/**
 * Get a single workflow by ID, optionally a specific version from history
 * @param {string} workflowId - Workflow ID
 * @param {string} version - Optional specific version
 * @param {string} clientIP - Client IP for IP whitelist check
 */
async function getWorkflow(workflowId, version = null, clientIP = null) {
    const conn = await getPool().getConnection();
    try {
        let query, params;
        if (version) {
            // From history — need to check allowedIPs from current workflow
            query = `SELECT wh.*, w.allowedIPs FROM kore_sys.workflows_hist wh
                     JOIN kore_sys.workflows w ON wh.workflow_id = w.id
                     WHERE wh.workflow_id = ? AND wh.version = ?`;
            params = [workflowId, version];
        } else {
            query = `SELECT * FROM kore_sys.workflows WHERE id = ?`;
            params = [workflowId];
        }
        const [rows] = await conn.execute(query, params);
        if (rows.length === 0) return null;

        const row = rows[0];

        // Check IP allowance if clientIP provided
        if (clientIP && row.allowedIPs) {
            const ipAllowed = await global.auth.isIPAllowed(clientIP, row.allowedIPs);
            if (!ipAllowed) return null; // Return null to signal access denied
        }

        const definition = typeof row.definition === 'string'
            ? JSON.parse(row.definition) : row.definition;

        return {
            id: row.id || row.workflow_id,
            name: row.name,
            version: row.version,
            folder_id: row.folder_id || null,
            definition,
            allowedIPs: row.allowedIPs
        };
    } finally {
        conn.release();
    }
}


// ============================================================
// WORKFLOW FOLDERS - DATA FUNCTIONS
// ============================================================

/**
 * Get all workflow folders
 */
async function getWorkflowFolders() {
    return getFolders('workflow_folders');
}

/**
 * Create a new workflow folder
 */
async function createWorkflowFolder(folderData) {
    return createFolder('workflow_folders', folderData, false);
}

/**
 * Update a workflow folder
 */
async function updateWorkflowFolder(folderId, updates) {
    return updateFolder('workflow_folders', folderId, updates);
}

/**
 * Delete a workflow folder (orphans child folders or workflows)
 */
async function deleteWorkflowFolder(folderId) {
    return deleteFolder('workflow_folders', folderId, 'workflows');
}


// ============================================================
// WORKFLOWS - HTTP HANDLERS
// ============================================================

async function handleWorkflowRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split('/').filter(p => p);
    // parts: ['kore', 'workflows', <id>, <version>]

    const auth = authenticate(req, res);
    if (!auth) return;

    const clientIP = getClientIP(req);

    if (req.method === 'GET') {
        if (parts.length === 2) {
            return handleListWorkflows(req, res, auth, clientIP);
        } else if (parts.length === 3) {
            return handleGetWorkflow(req, res, auth, clientIP, parts[2], null);
        } else if (parts.length === 4) {
            return handleGetWorkflow(req, res, auth, clientIP, parts[2], parts[3]);
        }
    } else if (req.method === 'POST') {
        return handleCreateWorkflow(req, res, auth);
    } else if (req.method === 'PUT' && parts.length === 3) {
        return handleUpdateWorkflow(req, res, auth, clientIP, parts[2]);
    } else if (req.method === 'DELETE' && parts.length >= 4) {
        return handleArchiveWorkflow(req, res, auth, clientIP, parts[2], parts[3]);
    }

    send(res, 405, { error: 'Method not allowed' });
}

async function handleListWorkflows(req, res, auth, clientIP) {
    return handleListResource(req, res, 'workflow', listWorkflows, auth, clientIP);
}

async function handleGetWorkflow(req, res, auth, clientIP, workflowId, version) {
    return handleGetResource(req, res, 'workflow', getWorkflow, auth, clientIP, workflowId, [version]);
}

async function handleCreateWorkflow(req, res, auth) {
    const workflowValidator = (body) => {
        if (!body.definition) {
            return { valid: false, errors: ['definition is required'] };
        }
        return { valid: true, errors: [] };
    };

    return handleCreateResource(req, res, 'workflow', createWorkflow, auth, workflowValidator);
}

async function handleUpdateWorkflow(req, res, auth, clientIP, workflowId) {
    return handleUpdateResource(req, res, 'workflow', getWorkflow, updateWorkflow, auth, clientIP, workflowId);
}

async function handleArchiveWorkflow(req, res, auth, clientIP, workflowId, version) {
    try {
        // Get current workflow to check IP allowance
        const currentWorkflow = await getWorkflow(workflowId, null, null);
        if (!currentWorkflow) return send(res, 404, { error: 'Workflow not found' });

        // Check IP allowance first (hard gate)
        if (currentWorkflow.allowedIPs) {
            const ipAllowed = await global.auth.isIPAllowed(clientIP, currentWorkflow.allowedIPs);
            if (!ipAllowed) return send(res, 403, { error: 'Forbidden' });
        }

        const canDelete = await global.auth.hasPermission(auth.userId, 'workflow', 'delete', workflowId);
        if (!canDelete) return send(res, 403, { error: 'Forbidden' });

        if (!workflowId || !version) {
            return send(res, 400, { error: 'workflowId and version are required' });
        }

        await deleteWorkflow(workflowId);

        send(res, 200, {
            workflowId, version, status: 'deleted',
            message: 'Workflow version and history deleted successfully'
        });
    } catch (error) {
        global.consoleLog('Resources', `Archive workflow error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}


// ============================================================
// WORKFLOW FOLDERS - HTTP HANDLERS
// ============================================================

async function handleWorkflowFoldersRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;

    try {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const parts = parsedUrl.pathname.split('/').filter(p => p);
        const folderId = parts[2] || null;

        if (req.method === 'GET') {
            const folders = await getWorkflowFolders();
            return send(res, 200, { folders });

        } else if (req.method === 'POST') {
            const body = await parseBody(req);
            if (!body.id || !body.name) {
                return send(res, 400, { error: 'id and name are required' });
            }
            const result = await createWorkflowFolder({
                id: body.id,
                name: body.name,
                parent_id: body.parent_id || null
            });
            return send(res, 201, result);

        } else if (req.method === 'PUT') {
            if (!folderId) return send(res, 400, { error: 'Folder ID is required' });
            const body = await parseBody(req);
            const result = await updateWorkflowFolder(folderId, body);
            return send(res, 200, result);

        } else if (req.method === 'DELETE') {
            if (!folderId) return send(res, 400, { error: 'Folder ID is required' });
            const result = await deleteWorkflowFolder(folderId);
            return send(res, 200, result);
        }

        send(res, 405, { error: 'Method not allowed' });
    } catch (error) {
        global.consoleLog('Resources', `Workflow folders error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}


// ============================================================
// FORMS - DATA FUNCTIONS
// ============================================================

/**
 * Get clientIP from request (from socket or X-Forwarded-For header)
 */
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
           req.socket.remoteAddress ||
           req.connection.remoteAddress ||
           'unknown';
}

/**
 * List forms, filtered by IP allowance and permissions
 * @param {string} userId - User ID
 * @param {string} clientIP - Client IP address for IP whitelist check
 * @param {boolean} activeOnly - Filter to active forms only
 */
async function listForms(userId, clientIP, activeOnly = true) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT f.id, f.name, f.version, f.definition, f.folder_id, f.allowedIPs,
                    ff.name as folder_name
             FROM kore_sys.forms f
             LEFT JOIN kore_sys.form_folders ff ON f.folder_id = ff.id
             ORDER BY f.name ASC`
        );

        // Filter to forms the user can access (IP check, then permission check)
        const results = [];
        for (const row of rows) {
            // Check IP allowance first (hard gate)
            if (row.allowedIPs) {
                const ipAllowed = await global.auth.isIPAllowed(clientIP, row.allowedIPs);
                if (!ipAllowed) continue;
            }

            // Check view permission
            const canView = await global.auth.hasPermission(userId, 'form', 'view', String(row.id));
            if (!canView) continue;

            const canEdit   = await global.auth.hasPermission(userId, 'form', 'edit',   String(row.id));
            const canDelete = await global.auth.hasPermission(userId, 'form', 'delete', String(row.id));

            const definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;

            results.push({
                id:          row.id,
                name:        row.name,
                version:     row.version,
                definition,
                folder_id:   row.folder_id || null,
                folder_name: (row.folder_id && row.folder_name) ? row.folder_name : null,
                allowedIPs:  row.allowedIPs,
                canEdit,
                canDelete
            });
        }
        return results;
    } finally {
        conn.release();
    }
}

/**
 * Get a single form by ID
 * @param {string} formId - Form ID
 * @param {string} clientIP - Client IP for IP whitelist check
 */
async function getForm(formId, clientIP = null) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT f.id, f.name, f.version, f.definition, f.folder_id, f.allowedIPs,
                    ff.name as folder_name
             FROM kore_sys.forms f
             LEFT JOIN kore_sys.form_folders ff ON f.folder_id = ff.id
             WHERE f.id = ?`,
            [formId]
        );
        if (rows.length === 0) return null;

        const row = rows[0];

        // Check IP allowance if clientIP provided
        if (clientIP && row.allowedIPs) {
            const ipAllowed = await global.auth.isIPAllowed(clientIP, row.allowedIPs);
            if (!ipAllowed) return null; // Return null to signal access denied
        }

        const definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;

        return {
            id:          row.id,
            name:        row.name,
            version:     row.version,
            definition,
            folder_id:   row.folder_id || null,
            folder_name: (row.folder_id && row.folder_name) ? row.folder_name : null,
            allowedIPs:  row.allowedIPs
        };
    } finally {
        conn.release();
    }
}

/**
 * List forms unfiltered by permission - name/id only, for admin pickers
 * (e.g. selecting a form to attach to a user_menus item). Still IP-gated
 * since that's a hard access gate, not a permission check.
 */
async function listFormsAdmin(clientIP) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT id, name, allowedIPs FROM kore_sys.forms ORDER BY name ASC`
        );
        const results = [];
        for (const row of rows) {
            if (row.allowedIPs) {
                const ipAllowed = await global.auth.isIPAllowed(clientIP, row.allowedIPs);
                if (!ipAllowed) continue;
            }
            results.push({ id: row.id, name: row.name });
        }
        return results;
    } finally {
        conn.release();
    }
}

/**
 * List datatables unfiltered by permission - name/id only, for admin
 * pickers. Mirrors listFormsAdmin; datatables share the same table shape
 * (id, name, allowedIPs) as forms/workflows.
 */
async function listDatatablesAdmin(clientIP) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT id, name, allowedIPs FROM kore_sys.datatables ORDER BY name ASC`
        );
        const results = [];
        for (const row of rows) {
            if (row.allowedIPs) {
                const ipAllowed = await global.auth.isIPAllowed(clientIP, row.allowedIPs);
                if (!ipAllowed) continue;
            }
            results.push({ id: row.id, name: row.name });
        }
        return results;
    } finally {
        conn.release();
    }
}

/**
 * GET /kore/forms/admin - unfiltered {id, name} list for admin pickers
 */
async function handleFormsAdminRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!(await authorizeMenuAdmin(req, res, auth))) return;

    try {
        const clientIP = getClientIP(req);
        const forms = await listFormsAdmin(clientIP);
        send(res, 200, { forms });
    } catch (error) {
        global.consoleLog('Resources', `List admin forms error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

/**
 * GET /kore/datatables/admin - unfiltered {id, name} list for admin pickers
 */
async function handleDatatablesAdminRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!(await authorizeMenuAdmin(req, res, auth))) return;

    try {
        const clientIP = getClientIP(req);
        const datatables = await listDatatablesAdmin(clientIP);
        send(res, 200, { datatables });
    } catch (error) {
        global.consoleLog('Resources', `List admin datatables error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

// ============================================================
// ============================================================
// FORMS - HTTP HANDLERS
// ============================================================


// ============================================================
// ============================================================
// FORM FOLDERS - DATA FUNCTIONS
// ============================================================

/**
 * Get all form folders
 */
async function getFormFolders() {
    return getFolders('form_folders');
}

/**
 * Create a new form folder
 */
async function createFormFolder(folderData) {
    return createFolder('form_folders', folderData, true);
}

/**
 * Update a form folder
 */
async function updateFormFolder(folderId, folderData) {
    return updateFolder('form_folders', folderId, folderData);
}

/**
 * Delete a form folder (orphans child folders or forms)
 */
async function deleteFormFolder(folderId) {
    return deleteFolder('form_folders', folderId, 'forms');
}

/**
 * Delete a form (and its history)
 * @param {string} formId - Form ID
 */
/**
 * Generic resource delete: cleans up permissions, history, and the main record.
 * @param {string} resourceType  - e.g. 'form', 'workflow', 'datatable'
 * @param {string} table         - main table name, e.g. 'kore_sys.forms'
 * @param {string} histTable     - history table name, e.g. 'kore_sys.forms_hist'
 * @param {string} histFkCol     - FK column in the history table, e.g. 'form_id'
 * @param {string} id            - resource UUID
 */
async function deleteResource(resourceType, table, histTable, histFkCol, id) {
    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();

        // Delete associated permissions
        await conn.execute(
            'DELETE FROM kore_sys.permissions WHERE resource = ? AND scope = ?',
            [resourceType, id]
        );

        // Grab the live version/definition before deletion
        const [[liveRow]] = await conn.execute(
            `SELECT version, definition FROM ${table} WHERE id = ?`,
            [id]
        );
        if (!liveRow) throw new Error(`${resourceType} not found`);

        // Clear all history, then re-insert live version as a detached snapshot
        await conn.execute(
            `DELETE FROM ${histTable} WHERE ${histFkCol} = ?`,
            [id]
        );
        await conn.execute(
            `INSERT INTO ${histTable} (${histFkCol}, version, definition, deleted) VALUES (?, ?, ?, 1)`,
            [id, liveRow.version, JSON.stringify(liveRow.definition)]
        );

        // Delete the main record
        await conn.execute(
            `DELETE FROM ${table} WHERE id = ?`,
            [id]
        );

        await conn.commit();

        global.consoleLog('Resources', `${resourceType} deleted: ${id} (snapshot v${liveRow.version} retained in history)`, 3);
        return { success: true };
    } catch (error) {
        try {
            await conn.rollback();
        } catch (rollbackError) {
            global.consoleLog('Resources', `Rollback failed during ${resourceType} delete ${id}: ${rollbackError.message}`, 1);
        }
        throw error;
    } finally {
        conn.release();
    }
}

async function deleteForm(formId) {
    return deleteResource('form', 'kore_sys.forms', 'kore_sys.forms_hist', 'form_id', formId);
}

async function deleteWorkflow(workflowId) {
    return deleteResource('workflow', 'kore_sys.workflows', 'kore_sys.workflows_hist', 'workflow_id', workflowId);
}

// ============================================================
// FORMS - HTTP HANDLERS
// ============================================================

async function handleFormsRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;

    const clientIP = getClientIP(req);
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split('/').filter(p => p);
    // parts: ['kore', 'forms', <form_id>]
    const formId = parts[2] || null;

    if (req.method === 'GET' && !formId) {
        return handleListForms(req, res, auth, clientIP, parsedUrl);
    } else if (req.method === 'POST' && !formId) {
        return handleCreateForm(req, res, auth);
    } else if (req.method === 'GET' && formId) {
        return handleGetForm(req, res, auth, clientIP, formId);
    } else if (req.method === 'PUT' && formId) {
        return handleUpdateForm(req, res, auth, clientIP, formId);
    } else if (req.method === 'DELETE' && formId) {
        return handleDeleteForm(req, res, auth, formId);
    }

    send(res, 405, { error: 'Method not allowed' });
}

async function handleListForms(req, res, auth, clientIP, parsedUrl) {
    // Wrapper to add userId to listForms
    const listFormsWithUser = async (clientIP) => {
        return listForms(auth.userId, clientIP, true);
    };

    return handleListResource(req, res, 'form', listFormsWithUser, auth, clientIP);
}

async function handleGetForm(req, res, auth, clientIP, formId) {
    return handleGetResource(req, res, 'form', getForm, auth, clientIP, formId);
}

async function handleCreateForm(req, res, auth) {
    const formValidator = (body) => {
        if (!body.name) {
            return { valid: false, errors: ['name is required'] };
        }
        return { valid: true, errors: [] };
    };

    return handleCreateResource(req, res, 'form', createForm, auth, formValidator);
}

async function handleUpdateForm(req, res, auth, clientIP, formId) {
    return handleUpdateResource(req, res, 'form', getForm, updateForm, auth, clientIP, formId);
}

async function handleDeleteForm(req, res, auth, formId) {
    try {
        const canDelete = await global.auth.hasPermission(auth.userId, 'form', 'delete', String(formId));
        if (!canDelete) return send(res, 403, { error: 'Forbidden' });

        const result = await deleteForm(formId);
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Delete form error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

// ============================================================
// FORM FOLDERS - HTTP HANDLERS
// ============================================================

async function handleFormFoldersRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split('/').filter(p => p);
    // parts: ['kore', 'form-folders', <folder_id>]
    const folderId = parts[2] || null;

    if (req.method === 'GET' && !folderId) {
        return handleListFormFolders(req, res, auth);
    } else if (req.method === 'POST' && !folderId) {
        return handleCreateFormFolder(req, res, auth);
    } else if (req.method === 'PUT' && folderId) {
        return handleUpdateFormFolder(req, res, auth, folderId);
    } else if (req.method === 'DELETE' && folderId) {
        return handleDeleteFormFolder(req, res, auth, folderId);
    }

    send(res, 405, { error: 'Method not allowed' });
}

async function handleListFormFolders(req, res, auth) {
    try {
        const folders = await getFormFolders();
        send(res, 200, { folders });
    } catch (error) {
        global.consoleLog('Resources', `List form folders error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

async function handleCreateFormFolder(req, res, auth) {
    try {
        const body = await parseBody(req);
        if (!body.name) {
            return send(res, 400, { error: 'name is required' });
        }

        const result = await createFormFolder(body);
        send(res, 201, result);
    } catch (error) {
        global.consoleLog('Resources', `Create form folder error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

async function handleUpdateFormFolder(req, res, auth, folderId) {
    try {
        const body = await parseBody(req);
        const result = await updateFormFolder(folderId, body);
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Update form folder error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

async function handleDeleteFormFolder(req, res, auth, folderId) {
    try {
        const result = await deleteFormFolder(folderId);
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Delete form folder error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

// ============================================================
// GENERIC RESOURCE HANDLERS
// ============================================================

/**
 * Generic handler for listing resources
 * @param {string} resourceType - Resource type for permission checks ('workflow', 'form', etc.)
 * @param {function} listGetter - Async function(clientIP) returning array of resources
 * @param {object} auth - Auth object from authenticate()
 * @param {string} clientIP - Client IP address
 */
async function handleListResource(req, res, resourceType, listGetter, auth, clientIP) {
    try {
        const canView = await global.auth.hasPermission(auth.userId, resourceType, 'view');
        if (!canView) return send(res, 403, { error: 'Forbidden' });

        const resources = await listGetter(clientIP);
        send(res, 200, { [resourceType + 's']: resources });
    } catch (error) {
        global.consoleLog('Resources', `List ${resourceType}s error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

/**
 * Generic handler for getting a single resource
 * @param {string} resourceType - Resource type for permission checks
 * @param {function} getter - Async function(...args) returning single resource or null
 * @param {object} auth - Auth object
 * @param {string} clientIP - Client IP
 * @param {string} resourceId - Resource ID
 * @param {array} getterArgs - Additional args to pass to getter (e.g., version)
 */
async function handleGetResource(req, res, resourceType, getter, auth, clientIP, resourceId, getterArgs = []) {
    try {
        const canView = await global.auth.hasPermission(auth.userId, resourceType, 'view', String(resourceId));
        if (!canView) return send(res, 403, { error: 'Forbidden' });

        const resource = await getter(resourceId, ...getterArgs, clientIP);
        if (!resource) return send(res, 404, { error: `${resourceType} not found` });

        const canCreate = await global.auth.hasPermission(auth.userId, resourceType, 'create', String(resourceId));
        const canEdit   = await global.auth.hasPermission(auth.userId, resourceType, 'edit',   String(resourceId));
        const canDelete = await global.auth.hasPermission(auth.userId, resourceType, 'delete', String(resourceId));

        send(res, 200, { ...resource, canCreate, canEdit, canDelete });
    } catch (error) {
        global.consoleLog('Resources', `Get ${resourceType} error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

/**
 * Generic handler for creating a resource
 * @param {string} resourceType - Resource type for permission checks
 * @param {function} createFn - Async function(data, userId) creating resource
 * @param {function} validator - Optional validation function(body) returning {valid, errors}
 * @param {object} auth - Auth object
 */
async function handleCreateResource(req, res, resourceType, createFn, auth, validator = null) {
    try {
        const canCreate = await global.auth.hasPermission(auth.userId, resourceType, 'create');
        if (!canCreate) return send(res, 403, { error: 'Forbidden' });

        const body = await parseBody(req);

        // Run validator if provided
        if (validator) {
            const validation = validator(body);
            if (!validation.valid) {
                return send(res, 400, { error: validation.errors.join(', ') });
            }
        }

        const result = await createFn(body, auth.userId);
        send(res, 201, result);
    } catch (error) {
        global.consoleLog('Resources', `Create ${resourceType} error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

/**
 * Generic handler for updating a resource (with IP check)
 * @param {string} resourceType - Resource type for permission checks
 * @param {function} getter - Async function(id, ...args, clientIP) getting current resource
 * @param {function} updateFn - Async function(id, data, userId) updating resource
 * @param {object} auth - Auth object
 * @param {string} clientIP - Client IP
 * @param {string} resourceId - Resource ID
 * @param {array} getterArgs - Additional args to pass to getter (e.g., version)
 */
async function handleUpdateResource(req, res, resourceType, getter, updateFn, auth, clientIP, resourceId, getterArgs = []) {
    try {
        // Get current resource to check IP allowance
        const currentResource = await getter(resourceId, ...getterArgs, null);
        if (!currentResource) return send(res, 404, { error: `${resourceType} not found` });

        // Check IP allowance first (hard gate)
        if (currentResource.allowedIPs) {
            const ipAllowed = await global.auth.isIPAllowed(clientIP, currentResource.allowedIPs);
            if (!ipAllowed) return send(res, 403, { error: 'Forbidden' });
        }

        const canEdit = await global.auth.hasPermission(auth.userId, resourceType, 'edit', String(resourceId));
        if (!canEdit) return send(res, 403, { error: 'Forbidden' });

        const body = await parseBody(req);
        const result = await updateFn(resourceId, body, auth.userId);
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Update ${resourceType} error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

// ============================================================
// ============================================================
// DATATABLES - DATA FUNCTIONS
// ============================================================

async function listDatatables(userId, clientIP) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT d.id, d.name, d.version, d.definition, d.folder_id, d.allowedIPs,
                    df.name as folder_name
             FROM kore_sys.datatables d
             LEFT JOIN kore_sys.datatable_folders df ON d.folder_id = df.id
             ORDER BY d.name ASC`
        );

        // Filter to datatables the user can access (IP check, then permission check).
        // This is the purely admin-side list page - visibility and the
        // Edit/Delete context menu options are gated entirely on
        // 'datatable_admin' (schema admin), never on the per-instance
        // 'datatable' resource (row-DATA view/add/edit/delete), which is
        // reserved for the Datatable Viewer - see the design note in
        // datatables.js's Datatable Viewer section. datatable_admin is now
        // instance-scoped (a '*'-scope grant matches every row per
        // hasPermission()'s NULL-scope-matches-any-scope rule), so these
        // are per-row checks again rather than computed once.
        const results = [];
        for (const row of rows) {
            // Check IP allowance first (hard gate)
            if (row.allowedIPs) {
                const ipAllowed = await global.auth.isIPAllowed(clientIP, row.allowedIPs);
                if (!ipAllowed) continue;
            }

            const canView = await global.auth.hasPermission(userId, 'datatable_admin', 'view', String(row.id));
            if (!canView) continue;

            const canEdit   = await global.auth.hasPermission(userId, 'datatable_admin', 'edit',   String(row.id));
            const canDelete = await global.auth.hasPermission(userId, 'datatable_admin', 'delete', String(row.id));

            const definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;

            results.push({
                id:          row.id,
                name:        row.name,
                version:     row.version,
                definition,
                folder_id:   row.folder_id || null,
                folder_name: (row.folder_id && row.folder_name) ? row.folder_name : null,
                allowedIPs:  row.allowedIPs,
                canEdit,
                canDelete
            });
        }
        return results;
    } finally {
        conn.release();
    }
}

/**
 * Get a single datatable by ID
 * @param {string} datatableId - Datatable ID
 * @param {string} clientIP - Client IP for IP whitelist check
 */
async function getDataTable(datatableId, clientIP = null) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT d.id, d.name, d.version, d.definition, d.folder_id, d.allowedIPs,
                    df.name as folder_name
             FROM kore_sys.datatables d
             LEFT JOIN kore_sys.datatable_folders df ON d.folder_id = df.id
             WHERE d.id = ?`,
            [datatableId]
        );
        if (rows.length === 0) return null;

        const row = rows[0];

        // Check IP allowance if clientIP provided
        if (clientIP && row.allowedIPs) {
            const ipAllowed = await global.auth.isIPAllowed(clientIP, row.allowedIPs);
            if (!ipAllowed) return null; // Return null to signal access denied
        }

        const definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;

        return {
            id:          row.id,
            name:        row.name,
            version:     row.version,
            definition,
            folder_id:   row.folder_id || null,
            folder_name: (row.folder_id && row.folder_name) ? row.folder_name : null,
            allowedIPs:  row.allowedIPs
        };
    } finally {
        conn.release();
    }
}

async function createDataTable(datatableData, userId) {
    const { name, description, folder_id, allowedIPs } = datatableData;
    if (!name) throw new Error('name is required');

    const definition = {
        name,
        description: description || '',
        active: true,
        columns: [],
        rows: []
        // TODO: add additional default fields as needed
    };

    return createResource('datatable', 'kore_sys.datatables', 'kore_sys.datatables_hist', 'datatable_id', definition, name, userId, folder_id, allowedIPs);
}

async function updateDataTable(datatableId, datatableData, userId) {
    return updateResource('datatable', 'kore_sys.datatables', 'kore_sys.datatables_hist', 'datatable_id', datatableId, datatableData, userId);
}

async function deleteDataTable(datatableId) {
    return deleteResource('datatable', 'kore_sys.datatables', 'kore_sys.datatables_hist', 'datatable_id', datatableId);
}

async function getDatatableFolders() {
    return getFolders('datatable_folders');
}

async function createDatatableFolder(folderData) {
    return createFolder('datatable_folders', folderData, true);
}

async function updateDatatableFolder(folderId, folderData) {
    return updateFolder('datatable_folders', folderId, folderData);
}

async function deleteDatatableFolder(folderId) {
    return deleteFolder('datatable_folders', folderId, 'datatables');
}

// ============================================================
// DATATABLES - HTTP HANDLERS
// ============================================================

async function handleDatatableRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split('/').filter(p => p);
    // parts: ['kore', 'datatables', <id>]

    const auth = authenticate(req, res);
    if (!auth) return;

    const clientIP = getClientIP(req);

    if (req.method === 'GET') {
        if (parts.length === 2) {
            return handleListDatatables(req, res, auth, clientIP);
        } else if (parts.length === 3) {
            return handleGetDataTable(req, res, auth, clientIP, parts[2]);
        }
    } else if (req.method === 'POST') {
        return handleCreateResource(req, res, 'datatable_admin', createDataTable, auth, (body) => {
            if (!body.name) return { valid: false, errors: ['name is required'] };
            return { valid: true, errors: [] };
        });
    } else if (req.method === 'PUT' && parts.length === 3) {
        return handleUpdateResource(req, res, 'datatable_admin', getDataTable, updateDataTable, auth, clientIP, parts[2]);
    } else if (req.method === 'DELETE' && parts.length === 3) {
        return handleDeleteDataTable(req, res, auth, parts[2]);
    }

    send(res, 405, { error: 'Method not allowed' });
}

/**
 * GET /kore/datatables (list) - custom rather than the generic
 * handleListResource() so the response can also carry a top-level
 * canCreate flag (blanket 'datatable_admin'/create - same check the POST
 * endpoint already enforces), letting the list page disable its "New
 * Datatable" button rather than only finding out via a failed POST.
 */
async function handleListDatatables(req, res, auth, clientIP) {
    try {
        const datatables = await listDatatables(auth.userId, clientIP);
        const canCreate = await global.auth.hasPermission(auth.userId, 'datatable_admin', 'create');
        send(res, 200, { datatables, canCreate });
    } catch (error) {
        global.consoleLog('Resources', `List datatables error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

/**
 * GET a single datatable - shared by two very different consumers, which
 * is why this isn't the generic handleGetResource():
 *   - The Datatable Viewer reads canCreate/canEdit/canDelete to gate
 *     row-DATA add/edit/delete (per-instance 'datatable' resource,
 *     unchanged - see the design note in datatables.js's Datatable
 *     Viewer section).
 *   - The Datatable Builder reads canAdminEdit to gate whether Save is
 *     enabled for the DEFINITION/schema itself ('datatable_admin').
 * Entry (the view gate) is granted if EITHER permission set allows
 * viewing - a user with only row-data view can still open this in the
 * Viewer, and a user with only schema-admin view can open it read-only
 * in the Builder (Save disabled via canAdminEdit). Which UI is actually
 * asking isn't distinguished here; the response just carries both flag
 * sets so each page uses the ones relevant to it.
 */
async function handleGetDataTable(req, res, auth, clientIP, datatableId) {
    try {
        const canRowView = await global.auth.hasPermission(auth.userId, 'datatable', 'view', String(datatableId));
        const canAdminView = await global.auth.hasPermission(auth.userId, 'datatable_admin', 'view', String(datatableId));
        if (!canRowView && !canAdminView) return send(res, 403, { error: 'Forbidden' });

        const resource = await getDataTable(datatableId, clientIP);
        if (!resource) return send(res, 404, { error: 'datatable not found' });

        // Row-DATA permissions (Viewer) - unchanged meaning/resource
        const canCreate = await global.auth.hasPermission(auth.userId, 'datatable', 'create', String(datatableId));
        const canEdit   = await global.auth.hasPermission(auth.userId, 'datatable', 'edit',   String(datatableId));
        const canDelete = await global.auth.hasPermission(auth.userId, 'datatable', 'delete', String(datatableId));

        // Schema/DEFINITION permission (Builder) - new
        const canAdminEdit = await global.auth.hasPermission(auth.userId, 'datatable_admin', 'edit', String(datatableId));

        send(res, 200, { ...resource, canCreate, canEdit, canDelete, canAdminView, canAdminEdit });
    } catch (error) {
        global.consoleLog('Resources', `Get datatable error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

async function handleDeleteDataTable(req, res, auth, datatableId) {
    try {
        const canDelete = await global.auth.hasPermission(auth.userId, 'datatable_admin', 'delete', datatableId);
        if (!canDelete) return send(res, 403, { error: 'Forbidden' });
        const result = await deleteDataTable(datatableId);
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Delete datatable error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

async function handleDatatableFoldersRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split('/').filter(p => p);

    const auth = authenticate(req, res);
    if (!auth) return;

    if (req.method === 'GET') {
        try {
            const folders = await getDatatableFolders();
            send(res, 200, { folders });
        } catch (error) {
            send(res, 500, { error: error.message });
        }
    } else if (req.method === 'POST') {
        return handleCreateDatatableFolder(req, res, auth);
    } else if (req.method === 'PUT' && parts.length === 3) {
        return handleUpdateDatatableFolder(req, res, auth, parts[2]);
    } else if (req.method === 'DELETE' && parts.length === 3) {
        return handleDeleteDatatableFolder(req, res, auth, parts[2]);
    }

    send(res, 405, { error: 'Method not allowed' });
}

async function handleCreateDatatableFolder(req, res, auth) {
    // TODO: implement
    send(res, 501, { error: 'Not yet implemented' });
}

async function handleUpdateDatatableFolder(req, res, auth, folderId) {
    // TODO: implement
    send(res, 501, { error: 'Not yet implemented' });
}

async function handleDeleteDatatableFolder(req, res, auth, folderId) {
    // TODO: implement
    send(res, 501, { error: 'Not yet implemented' });
}


// ============================================================
// DOCS - DATA FUNCTIONS
//
// Docs ARE now versioned (docs_hist mirrors workflows_hist/forms_hist),
// but the shape still differs from createResource/updateResource: those
// store one native `definition` JSON blob per resource. Docs stores flat
// columns, so each version snapshot is an object assembled from those
// columns (title, linkedResourceType, linkedResourceId, content, tags,
// related, folderId) rather than a column that's natively JSON end to end.
// That's why this section still doesn't reuse createResource/updateResource/
// deleteResource - the assembly step doesn't fit their signatures.
// ============================================================

/**
 * Assemble the versioned snapshot object for a doc's current field values.
 */
/**
 * Normalizes `related` to a plain array of doc id strings. Accepts either
 * shape: plain ids (what create/update actually store), or {id, title}
 * objects (the shape getDoc() returns them in for display). The latter
 * matters for Import specifically - asking Claude to "generate a
 * definition" from an existing doc naturally echoes back what getDoc()
 * showed it, i.e. {id, title} pairs, and storing those objects directly
 * would silently break getDoc()'s later related-doc lookup instead of
 * erroring loudly.
 */
function _normalizeRelatedIds(related) {
    if (!Array.isArray(related)) return [];
    return related
        .map(r => (typeof r === 'string' ? r : (r && r.id) ? r.id : null))
        .filter(Boolean);
}

/**
 * Two different splits, not one - this took a couple of wrong turns to
 * land on, so spelling out the actual policy explicitly:
 *   - VIEW is type-dependent: general/form/datatable stay on 'doc' (no
 *     rows exist for it, so it's wide open by default - see
 *     hasPermission()'s default-allow-if-nothing-matches behavior).
 *     workflow/plugin/plugin_task route to 'doc_admin' instead, so an
 *     ordinary user (not Admin/Developer/Operator) can't see them at all,
 *     while those three groups can (Admins/Developers via their '*' grant,
 *     Operators via their explicit 'view' grant - see the permission rows
 *     this depends on).
 *   - EDIT/CREATE/DELETE is uniform, not type-dependent: every doc type
 *     routes to 'doc_admin' regardless - only Admins/Developers (the '*'
 *     grant) can mutate any doc, including a plain general one. Operators
 *     only have 'view' on 'doc_admin', so they're read-only everywhere
 *     despite being able to see everything.
 */
const _RESTRICTED_VIEW_TYPES = new Set(['workflow', 'plugin', 'plugin_task']);
function _docViewResource(linkedResourceType) {
    return _RESTRICTED_VIEW_TYPES.has(linkedResourceType) ? 'doc_admin' : 'doc';
}
const DOC_MUTATE_RESOURCE = 'doc_admin';

/**
 * Cheap linkedResourceType-only lookup for handleGetDocHistory, which
 * only has a docId (not the full doc) and needs to know which VIEW
 * resource bucket applies - see _docViewResource() - before doing
 * anything else. Avoids a full getDoc() (content, tags, related, etc.)
 * just to read one column. Not needed for edit/create/delete checks,
 * which don't depend on type at all - see DOC_MUTATE_RESOURCE above.
 */
async function _getDocLinkedType(docId) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT linkedResourceType FROM kore_sys.docs WHERE id = ? AND active = TRUE`,
            [docId]
        );
        return rows[0]?.linkedResourceType || null;
    } finally {
        conn.release();
    }
}

function _buildDocSnapshot(fields) {
    return {
        title: fields.title,
        dynamicTitle: !!fields.dynamicTitle,
        linkedResourceType: fields.linkedResourceType,
        linkedResourceId: fields.linkedResourceId || null,
        content: fields.content || null,
        tags: fields.tags || [],
        related: _normalizeRelatedIds(fields.related),
        folderId: fields.folderId || null
    };
}

/**
 * List docs, permission-filtered per doc, with optional type/tag/folder/search filters.
 * @param {string} userId
 * @param {object} filters - { type, tag, folder, search }
 */
async function listDocs(userId, filters = {}) {
    const { type, tag, folder, search } = filters;
    const conn = await getPool().getConnection();
    try {
        const conditions = ['d.active = TRUE'];
        const values = [];

        if (type) {
            conditions.push('d.linkedResourceType = ?');
            values.push(type);
        }
        if (folder) {
            conditions.push('d.folderId = ?');
            values.push(folder);
        }
        if (search) {
            conditions.push('(d.title LIKE ? OR d.content LIKE ?)');
            values.push(`%${search}%`, `%${search}%`);
        }

        const [rows] = await conn.execute(
            `SELECT d.id, d.title, d.dynamic_title, d.version, d.linkedResourceType, d.linkedResourceId,
                    d.tags, d.folderId, d.createdBy, d.updatedAt,
                    df.name as folder_name
             FROM kore_sys.docs d
             LEFT JOIN kore_sys.doc_folders df ON d.folderId = df.id
             WHERE ${conditions.join(' AND ')}
             ORDER BY d.title ASC`,
            values
        );

        // Tag filtering happens here (not in SQL) since `tags` is a JSON array column.
        const results = [];
        for (const row of rows) {
            const canView = await global.auth.hasPermission(userId, _docViewResource(row.linkedResourceType), 'view', row.id);
            if (!canView) continue;

            let tags = [];
            try { tags = row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : []; } catch { tags = []; }

            if (tag && !tags.includes(tag)) continue;

            results.push({
                id: row.id,
                title: row.title,
                dynamicTitle: !!row.dynamic_title,
                version: row.version,
                linkedResourceType: row.linkedResourceType,
                linkedResourceId: row.linkedResourceId,
                tags,
                folderId: row.folderId || null,
                folder_name: row.folder_name || null,
                createdBy: row.createdBy,
                updatedAt: row.updatedAt
            });
        }
        return results;
    } finally {
        conn.release();
    }
}

/**
 * Get a single doc by ID. Pass `version` to fetch a specific historical
 * snapshot from docs_hist instead of the live row (same pattern as
 * getWorkflow's version param).
 * Resolves the `related` id array into [{id, title}, ...], preserving the
 * curated order and silently dropping any id that's missing or inactive.
 */
async function getDoc(docId, version = null) {
    const conn = await getPool().getConnection();
    try {
        let row;

        if (version) {
            const [histRows] = await conn.execute(
                `SELECT dh.doc_id as id, dh.version, dh.definition, dh.created_at,
                        d.createdBy, d.folderId as liveFolderId
                 FROM kore_sys.docs_hist dh
                 JOIN kore_sys.docs d ON dh.doc_id = d.id
                 WHERE dh.doc_id = ? AND dh.version = ?`,
                [docId, version]
            );
            if (histRows.length === 0) return null;
            const h = histRows[0];
            const def = typeof h.definition === 'string' ? JSON.parse(h.definition) : h.definition;
            row = {
                id: h.id,
                version: h.version,
                title: def.title,
                dynamic_title: !!def.dynamicTitle,
                linkedResourceType: def.linkedResourceType,
                linkedResourceId: def.linkedResourceId,
                content: def.content,
                tags: JSON.stringify(def.tags || []),
                related: JSON.stringify(def.related || []),
                folderId: def.folderId,
                folder_name: null, // historical folder name not tracked; only current
                createdBy: h.createdBy,
                updatedAt: h.created_at
            };
        } else {
            const [rows] = await conn.execute(
                `SELECT d.id, d.title, d.dynamic_title, d.version, d.linkedResourceType, d.linkedResourceId,
                        d.content, d.tags, d.related, d.folderId, d.createdBy, d.updatedAt,
                        df.name as folder_name
                 FROM kore_sys.docs d
                 LEFT JOIN kore_sys.doc_folders df ON d.folderId = df.id
                 WHERE d.id = ? AND d.active = TRUE`,
                [docId]
            );
            if (rows.length === 0) return null;
            row = rows[0];
        }

        let tags = [];
        try { tags = row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : []; } catch { tags = []; }

        let relatedIds = [];
        try { relatedIds = row.related ? (typeof row.related === 'string' ? JSON.parse(row.related) : row.related) : []; } catch { relatedIds = []; }

        let related = [];
        if (relatedIds.length > 0) {
            const placeholders = relatedIds.map(() => '?').join(',');
            const [relatedRows] = await conn.execute(
                `SELECT id, title, linkedResourceType, linkedResourceId FROM kore_sys.docs WHERE id IN (${placeholders}) AND active = TRUE`,
                relatedIds
            );
            const byId = new Map(relatedRows.map(r => [r.id, r]));
            related = relatedIds.filter(id => byId.has(id)).map(id => {
                const r = byId.get(id);
                return { id: r.id, title: r.title, linkedResourceType: r.linkedResourceType, linkedResourceId: r.linkedResourceId };
            });
        }

        return {
            id: row.id,
            title: row.title,
            dynamicTitle: !!row.dynamic_title,
            version: row.version,
            linkedResourceType: row.linkedResourceType,
            linkedResourceId: row.linkedResourceId,
            content: row.content,
            tags,
            related,
            folderId: row.folderId || null,
            folder_name: row.folder_name || null,
            createdBy: row.createdBy,
            updatedAt: row.updatedAt
        };
    } finally {
        conn.release();
    }
}

/**
 * Get version history (id/version/created_at list, no full content) for a doc.
 */
async function getDocHistory(docId) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT version, deleted, created_at FROM kore_sys.docs_hist
             WHERE doc_id = ? ORDER BY created_at DESC`,
            [docId]
        );
        return rows;
    } finally {
        conn.release();
    }
}

/**
 * Create a new doc. Inserts the live row (version 1.0) and its first
 * docs_hist snapshot together.
 */
/**
 * Throws if another active doc already has the same linkedResourceType +
 * linkedResourceId (a "doc exists for this resource" constraint - not
 * enforced at the DB level since it only applies when
 * linkedResourceType != 'general' and linkedResourceId is set, which
 * isn't expressible as a plain unique index across a nullable pair).
 * excludeDocId lets updateDoc check without tripping on its own row.
 */
async function _assertNoDuplicateLinkedResource(conn, linkedResourceType, linkedResourceId, excludeDocId) {
    if (!linkedResourceId || linkedResourceType === 'general') return;

    const params = [linkedResourceType, linkedResourceId];
    let query = `SELECT id, title FROM kore_sys.docs WHERE linkedResourceType = ? AND linkedResourceId = ? AND active = TRUE`;
    if (excludeDocId) {
        query += ` AND id != ?`;
        params.push(excludeDocId);
    }
    query += ` LIMIT 1`;

    const [existing] = await conn.execute(query, params);
    if (existing.length > 0) {
        throw new Error(`A doc already exists for this ${linkedResourceType}: "${existing[0].title}" (${existing[0].id})`);
    }
}

/**
 * Looks up a linked resource's current display name directly against its
 * own table - server-side equivalent of what fetchResourceOptions()/
 * fetchPluginTaskOptions() do client-side in docs.js, needed here because
 * this runs outside a browser (the refresh-titles maintenance task has no
 * session to make those authenticated fetch() calls with). Returns null
 * if the resource no longer exists or the type has nothing to resolve.
 */
async function _resolveResourceTitleServerSide(conn, linkedResourceType, linkedResourceId) {
    if (!linkedResourceId) return null;
    try {
        switch (linkedResourceType) {
            case 'workflow': {
                const [rows] = await conn.execute(`SELECT name FROM kore_sys.workflows WHERE id = ?`, [linkedResourceId]);
                return rows[0]?.name || null;
            }
            case 'form': {
                const [rows] = await conn.execute(`SELECT name FROM kore_sys.forms WHERE id = ?`, [linkedResourceId]);
                return rows[0]?.name || null;
            }
            case 'datatable': {
                const [rows] = await conn.execute(`SELECT name FROM kore_sys.datatables WHERE id = ?`, [linkedResourceId]);
                return rows[0]?.name || null;
            }
            case 'plugin': {
                const [rows] = await conn.execute(`SELECT display_name FROM plugins WHERE name = ?`, [linkedResourceId]);
                return rows[0]?.display_name || null;
            }
            case 'plugin_task': {
                const sepIdx = linkedResourceId.indexOf(':');
                if (sepIdx === -1) return null;
                const pluginName = linkedResourceId.slice(0, sepIdx);
                const taskId = linkedResourceId.slice(sepIdx + 1);
                const [rows] = await conn.execute(
                    `SELECT display_name, plugin_name FROM plugin_tasks WHERE plugin_name = ? AND task_id = ? AND active = TRUE`,
                    [pluginName, taskId]
                );
                if (!rows[0] || !rows[0].display_name) return null;
                const capitalizedPluginName = rows[0].plugin_name.toUpperCase();
                return `${capitalizedPluginName} - ${rows[0].display_name}`;
            }
            default:
                return null; // 'general' or unrecognized - nothing to resolve
        }
    } catch (err) {
        global.consoleLog('Resources', `_resolveResourceTitleServerSide failed for ${linkedResourceType}/${linkedResourceId}: ${err.message}`, 2);
        return null;
    }
}

/**
 * Maintenance task: re-resolves every active dynamic_title doc's title
 * against its live linked resource and updates it if changed. Deliberately
 * writes only the `title` column directly - no version bump, no docs_hist
 * entry - since a cached-name refresh isn't a content edit and running
 * this regularly (on demand or on a schedule) shouldn't bloat every
 * dynamic doc's version history. A resource that can't be resolved
 * (deleted, renamed away, lookup error) is left with its last-known title
 * rather than being blanked or errored on - see _resolveResourceTitleServerSide.
 * Returns a summary rather than throwing on individual failures, so one
 * bad row doesn't abort the whole sweep.
 */
async function refreshDynamicTitles() {
    const conn = await getPool().getConnection();
    try {
        const [docs] = await conn.execute(
            `SELECT id, title, linkedResourceType, linkedResourceId FROM kore_sys.docs WHERE dynamic_title = TRUE AND active = TRUE`
        );

        let updated = 0, unchanged = 0, unresolved = 0;
        for (const doc of docs) {
            const resolvedTitle = await _resolveResourceTitleServerSide(conn, doc.linkedResourceType, doc.linkedResourceId);
            if (!resolvedTitle) {
                unresolved++;
                continue;
            }
            if (resolvedTitle === doc.title) {
                unchanged++;
                continue;
            }
            await conn.execute(`UPDATE kore_sys.docs SET title = ? WHERE id = ?`, [resolvedTitle, doc.id]);
            updated++;
        }

        global.consoleLog('Resources', `Doc title refresh: ${updated} updated, ${unchanged} unchanged, ${unresolved} unresolved (of ${docs.length} dynamic-title docs)`, 3);
        return { total: docs.length, updated, unchanged, unresolved };
    } finally {
        conn.release();
    }
}

async function createDoc(docData, userId) {
    const { id: requestedId, title, dynamicTitle, linkedResourceType, linkedResourceId, content, tags, related, folderId } = docData;
    if (!title) throw new Error('title is required');

    const version = '1.0';
    const snapshot = _buildDocSnapshot({ title, dynamicTitle, linkedResourceType: linkedResourceType || 'general', linkedResourceId, content, tags, related, folderId });

    const conn = await getPool().getConnection();
    try {
        await _assertNoDuplicateLinkedResource(conn, snapshot.linkedResourceType, snapshot.linkedResourceId, null);

        const insertSql = `INSERT INTO kore_sys.docs
                (id, title, dynamic_title, version, linkedResourceType, linkedResourceId, content, tags, related, folderId, createdBy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const insertParams = (id) => ([
            id, title, snapshot.dynamicTitle, version,
            snapshot.linkedResourceType,
            snapshot.linkedResourceId,
            snapshot.content,
            JSON.stringify(snapshot.tags),
            JSON.stringify(snapshot.related),
            snapshot.folderId,
            userId
        ]);

        let id;
        if (requestedId) {
            // Caller-specified id, respected as-is rather than always
            // auto-generated - lets a batch of related docs reference each
            // other's real ids up front, instead of guessing at what
            // generateId() will produce and finding out only after the
            // fact that the guess was wrong (a real, concrete instance of
            // exactly this bit us this session). Basic safety validation
            // only - not enforcing generateId()'s own 6-char shape, since
            // longer ids have been used successfully elsewhere already.
            if (!/^[a-z0-9]{4,20}$/.test(requestedId)) {
                throw new Error(`Invalid doc id "${requestedId}" - must be 4-20 lowercase letters/numbers`);
            }
            const [existing] = await conn.execute(`SELECT id FROM kore_sys.docs WHERE id = ?`, [requestedId]);
            if (existing.length > 0) {
                throw new Error(`Doc id "${requestedId}" is already in use`);
            }
            // Not retried on collision, unlike the generateId() loop below -
            // if the requested id is taken, that's a real error to surface,
            // not something to silently paper over with a different id the
            // caller never asked for.
            id = requestedId;
            await conn.execute(insertSql, insertParams(id));
        } else {
            let inserted = false;
            for (let attempt = 0; attempt < 5; attempt++) {
                id = generateId();
                try {
                    await conn.execute(insertSql, insertParams(id));
                    inserted = true;
                    break;
                } catch (err) {
                    if (err.code === 'ER_DUP_ENTRY') continue;
                    throw err;
                }
            }
            if (!inserted) throw new Error('Failed to generate unique doc ID after 5 attempts');
        }

        await conn.execute(
            `INSERT INTO kore_sys.docs_hist (doc_id, version, definition) VALUES (?, ?, ?)`,
            [id, version, JSON.stringify(snapshot)]
        );

        global.consoleLog('Resources', `Doc created: ${id} (${title})`, 3);
        return { id, title, version };
    } finally {
        conn.release();
    }
}

/**
 * Update an existing doc. Only fields present on docData are touched.
 * Auto-increments the minor version (1.0 -> 1.1 -> 1.2, same scheme as
 * updateResource) and writes a new docs_hist snapshot reflecting the
 * full post-update state. `updatedAt` is bumped automatically by the
 * column's ON UPDATE CURRENT_TIMESTAMP.
 */
async function updateDoc(docId, docData, userId) {
    const conn = await getPool().getConnection();
    try {
        const [currentRows] = await conn.execute(
            `SELECT title, dynamic_title, version, linkedResourceType, linkedResourceId, content, tags, related, folderId
             FROM kore_sys.docs WHERE id = ? AND active = TRUE`,
            [docId]
        );
        if (currentRows.length === 0) throw new Error('Doc not found');
        const current = currentRows[0];

        const merged = {
            title: docData.hasOwnProperty('title') ? docData.title : current.title,
            dynamicTitle: docData.hasOwnProperty('dynamicTitle') ? !!docData.dynamicTitle : !!current.dynamic_title,
            linkedResourceType: docData.hasOwnProperty('linkedResourceType') ? docData.linkedResourceType : current.linkedResourceType,
            linkedResourceId: docData.hasOwnProperty('linkedResourceId') ? (docData.linkedResourceId || null) : current.linkedResourceId,
            content: docData.hasOwnProperty('content') ? docData.content : current.content,
            tags: docData.hasOwnProperty('tags') ? (docData.tags || []) : (typeof current.tags === 'string' ? JSON.parse(current.tags) : (current.tags || [])),
            related: docData.hasOwnProperty('related') ? (docData.related || []) : (typeof current.related === 'string' ? JSON.parse(current.related) : (current.related || [])),
            folderId: docData.hasOwnProperty('folderId') ? (docData.folderId || null) : current.folderId
        };

        if (!merged.title) throw new Error('title cannot be empty');

        await _assertNoDuplicateLinkedResource(conn, merged.linkedResourceType, merged.linkedResourceId, docId);

        const [major, minor] = (current.version || '1.0').split('.').map(Number);
        const newVersion = `${major}.${(minor || 0) + 1}`;
        const snapshot = _buildDocSnapshot(merged);

        await conn.execute(
            `UPDATE kore_sys.docs
             SET title = ?, dynamic_title = ?, version = ?, linkedResourceType = ?, linkedResourceId = ?,
                 content = ?, tags = ?, related = ?, folderId = ?
             WHERE id = ? AND active = TRUE`,
            [
                snapshot.title, snapshot.dynamicTitle, newVersion, snapshot.linkedResourceType, snapshot.linkedResourceId,
                snapshot.content, JSON.stringify(snapshot.tags), JSON.stringify(snapshot.related), snapshot.folderId,
                docId
            ]
        );

        // Only insert if this version doesn't already exist (immutable history, same guard as updateResource)
        const [existingHist] = await conn.execute(
            `SELECT 1 FROM kore_sys.docs_hist WHERE doc_id = ? AND version = ?`,
            [docId, newVersion]
        );
        if (existingHist.length === 0) {
            await conn.execute(
                `INSERT INTO kore_sys.docs_hist (doc_id, version, definition) VALUES (?, ?, ?)`,
                [docId, newVersion, JSON.stringify(snapshot)]
            );
        }

        global.consoleLog('Resources', `Doc updated: ${docId} (v${newVersion})`, 3);
        return { id: docId, version: newVersion };
    } finally {
        conn.release();
    }
}

/**
 * Soft-delete a doc (sets active = FALSE), clears its permission rows, and
 * writes a final docs_hist row (same version, deleted = true) so the
 * history shows exactly what the doc looked like at deletion time.
 */
async function deleteDoc(docId) {
    const conn = await getPool().getConnection();
    try {
        const [currentRows] = await conn.execute(
            `SELECT title, dynamic_title, version, linkedResourceType, linkedResourceId, content, tags, related, folderId
             FROM kore_sys.docs WHERE id = ?`,
            [docId]
        );
        if (currentRows.length === 0) throw new Error('Doc not found');
        const current = currentRows[0];

        await conn.execute(
            'DELETE FROM kore_sys.permissions WHERE resource = ? AND scope = ?',
            ['doc', docId]
        );

        await conn.execute(
            `UPDATE kore_sys.docs SET active = FALSE WHERE id = ?`,
            [docId]
        );

        const snapshot = _buildDocSnapshot({
            title: current.title,
            dynamicTitle: !!current.dynamic_title,
            linkedResourceType: current.linkedResourceType,
            linkedResourceId: current.linkedResourceId,
            content: current.content,
            tags: typeof current.tags === 'string' ? JSON.parse(current.tags) : current.tags,
            related: typeof current.related === 'string' ? JSON.parse(current.related) : current.related,
            folderId: current.folderId
        });

        await conn.execute(
            `INSERT INTO kore_sys.docs_hist (doc_id, version, definition, deleted) VALUES (?, ?, ?, 1)`,
            [docId, current.version, JSON.stringify(snapshot)]
        );

        global.consoleLog('Resources', `Doc deleted (soft): ${docId}`, 3);
        return { success: true };
    } finally {
        conn.release();
    }
}

// ============================================================
// DOC FOLDERS - DATA FUNCTIONS
// ============================================================

/**
 * These three are deliberately NOT thin delegations to the shared
 * getFolders()/createFolder()/updateFolder() above, unlike every other
 * folder-table wrapper in this file - doc_folders has an 'admin' column
 * none of the other three folder tables (workflow_folders/form_folders/
 * datatable_folders) have, and the shared functions' queries are built
 * from a bare tableName with a fixed column set. Extending those to
 * conditionally include 'admin' only for this one table would make them
 * messier for every other caller; a small dedicated query here is safer.
 *
 * 'admin' gates folder VISIBILITY (not create/edit/delete, which already
 * require doc_folder/create|edit regardless of this flag) by reusing the
 * existing doc_admin/view permission - the same one that already governs
 * whether workflow/plugin/plugin_task-linked DOCS are visible. A folder
 * flagged admin=1 is hidden from anyone without that same grant. This is
 * deliberately not a new permission concept - see handleDocFoldersRequest's
 * GET branch for the actual filtering.
 *
 * No parent-to-child inheritance: flagging a parent folder admin=1 does
 * NOT automatically hide its children - each folder row's own flag is
 * independent. Flagging "Plugins" without also flagging "Plugin Tasks"
 * (its child) leaves Plugin Tasks visible on its own.
 */
async function getDocFolders() {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT id, name, parent_id, admin FROM kore_sys.doc_folders ORDER BY name ASC`
        );
        return rows || [];
    } finally {
        conn.release();
    }
}

async function createDocFolder(folderData) {
    const { name, parent_id, admin } = folderData;
    if (!name) throw new Error('name is required');

    const conn = await getPool().getConnection();
    try {
        let folderId;
        let inserted = false;
        for (let attempt = 0; attempt < 5; attempt++) {
            folderId = generateId();
            try {
                await conn.execute(
                    `INSERT INTO kore_sys.doc_folders (id, name, parent_id, admin) VALUES (?, ?, ?, ?)`,
                    [folderId, name, parent_id || null, admin ? 1 : 0]
                );
                inserted = true;
                break;
            } catch (err) {
                if (err.code === 'ER_DUP_ENTRY') continue;
                throw err;
            }
        }
        if (!inserted) throw new Error('Failed to generate unique folder ID after 5 attempts');
        return { id: folderId, name, parent_id: parent_id || null, admin: !!admin };
    } finally {
        conn.release();
    }
}

async function updateDocFolder(folderId, folderData) {
    const conn = await getPool().getConnection();
    try {
        const updateFields = [];
        const values = [];

        if (folderData.hasOwnProperty('name')) {
            updateFields.push('name = ?');
            values.push(folderData.name);
        }
        if (folderData.hasOwnProperty('parent_id')) {
            updateFields.push('parent_id = ?');
            values.push(folderData.parent_id || null);
        }
        if (folderData.hasOwnProperty('admin')) {
            updateFields.push('admin = ?');
            values.push(folderData.admin ? 1 : 0);
        }

        if (updateFields.length === 0) throw new Error('No fields to update');

        values.push(folderId);

        const [result] = await conn.execute(
            `UPDATE kore_sys.doc_folders SET ${updateFields.join(', ')} WHERE id = ?`,
            values
        );

        if (result.affectedRows === 0) throw new Error('Folder not found');

        return { success: true };
    } finally {
        conn.release();
    }
}

/**
 * Bespoke (not the generic deleteFolder()) because docs.folderId is
 * camelCase, unlike workflows.folder_id / forms.folder_id / datatables.folder_id.
 * Same logic as deleteFolder(), just the correct column name.
 */
async function deleteDocFolder(folderId) {
    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();

        const [folders] = await conn.execute(
            `SELECT id FROM kore_sys.doc_folders WHERE id = ?`, [folderId]
        );
        if (folders.length === 0) throw new Error('Folder not found');

        // Both, unconditionally - see deleteFolder() for why this isn't an if/else.
        await conn.execute(
            `UPDATE kore_sys.doc_folders SET parent_id = NULL WHERE parent_id = ?`,
            [folderId]
        );
        await conn.execute(
            `UPDATE kore_sys.docs SET folderId = NULL WHERE folderId = ?`,
            [folderId]
        );

        await conn.execute(`DELETE FROM kore_sys.doc_folders WHERE id = ?`, [folderId]);

        await conn.commit();
        return { success: true };
    } catch (error) {
        try {
            await conn.rollback();
        } catch (rollbackError) {
            global.consoleLog('Resources', `Rollback failed during doc folder delete ${folderId}: ${rollbackError.message}`, 1);
        }
        throw error;
    } finally {
        conn.release();
    }
}

// ============================================================
// DOCS - HTTP HANDLERS
// ============================================================

async function handleDocsRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split('/').filter(p => p);
    // parts: ['kore', 'docs', <doc_id>, <version|'history'>]
    const docId = parts[2] || null;

    if (req.method === 'GET' && !docId) {
        return handleListDocs(req, res, auth, parsedUrl);
    } else if (req.method === 'POST' && !docId) {
        return handleCreateDoc(req, res, auth);
    } else if (req.method === 'POST' && docId === 'refresh-titles' && parts.length === 3) {
        return handleRefreshDynamicTitles(req, res, auth);
    } else if (req.method === 'GET' && docId && parts.length === 4 && parts[3] === 'history') {
        return handleGetDocHistory(req, res, auth, docId);
    } else if (req.method === 'GET' && docId && parts.length === 4) {
        return handleGetDoc(req, res, auth, docId, parts[3]);
    } else if (req.method === 'GET' && docId) {
        return handleGetDoc(req, res, auth, docId, null);
    } else if (req.method === 'PUT' && docId) {
        return handleUpdateDoc(req, res, auth, docId);
    } else if (req.method === 'DELETE' && docId) {
        return handleDeleteDoc(req, res, auth, docId);
    }

    send(res, 405, { error: 'Method not allowed' });
}

async function handleListDocs(req, res, auth, parsedUrl) {
    try {
        const canView = await global.auth.hasPermission(auth.userId, 'doc', 'view');
        if (!canView) return send(res, 403, { error: 'Forbidden' });

        const filters = {
            type: parsedUrl.searchParams.get('type') || null,
            tag: parsedUrl.searchParams.get('tag') || null,
            folder: parsedUrl.searchParams.get('folder') || null,
            search: parsedUrl.searchParams.get('search') || null
        };

        const docs = await listDocs(auth.userId, filters);

        // Page-level permission flags, fetched alongside the list rather
        // than as separate round trips - docs.js uses these to hide
        // Import/New Doc and the folder panel's create/edit affordances
        // for anyone without DOC_MUTATE_RESOURCE/'doc_folder' rights,
        // rather than showing controls that would just 403 on click.
        // Folder create and edit are granted together (same '*' rows), so
        // one check ('edit') stands in for both here.
        const canCreateDocs = await global.auth.hasPermission(auth.userId, DOC_MUTATE_RESOURCE, 'create');
        const canManageFolders = await global.auth.hasPermission(auth.userId, 'doc_folder', 'edit');
        // Separate from canCreateDocs - a user could theoretically have
        // view-only rights on doc_admin (Operators, per the current
        // grants) without create rights, and the type filter should still
        // offer Workflow/Plugin/Plugin Task to them even though the
        // Create/Import buttons stay hidden.
        const canViewRestrictedTypes = await global.auth.hasPermission(auth.userId, 'doc_admin', 'view');
        // Same check handleRefreshDynamicTitles itself gates on - kept in
        // sync here so the button matches what clicking it would actually
        // be allowed to do, rather than showing it and letting a 403
        // surface the restriction after the fact.
        const canRefreshTitles = await global.auth.hasPermission(auth.userId, 'doc', 'admin', null);

        send(res, 200, { docs, canCreateDocs, canManageFolders, canViewRestrictedTypes, canRefreshTitles });
    } catch (error) {
        global.consoleLog('Resources', `List docs error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

/**
 * Admin-triggered (or externally scheduled) sweep of every dynamic_title
 * doc's cached title. Gated on a dedicated 'doc'/'admin' permission,
 * separate from ordinary 'doc'/'edit' - this touches every dynamic doc in
 * the system at once, not just ones the caller has edit rights on, so it
 * warrants a higher bar than the per-doc edit permission checked
 * elsewhere in this file. Whoever wires this to a daily schedule (cron,
 * an internal job runner, or a Kore workflow calling it as a native
 * action) still needs to hit this same authenticated endpoint - there's
 * no unauthenticated/internal-only path here the way plugins.js's
 * isInternalCall bypass works.
 */
async function handleRefreshDynamicTitles(req, res, auth) {
    try {
        const isAdmin = await global.auth.hasPermission(auth.userId, 'doc', 'admin', null);
        if (!isAdmin) return send(res, 403, { error: 'Forbidden' });

        const result = await refreshDynamicTitles();
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Refresh dynamic titles error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

async function handleGetDoc(req, res, auth, docId, version) {
    try {
        // Permission can't be checked until the doc's linkedResourceType is
        // known (view access depends on it - see _docViewResource), so
        // this fetches first and checks after, unlike most other handlers
        // in this file which check-then-fetch. Minor side effect: a
        // restricted doc's existence is revealed via 404-vs-403 timing to
        // someone without view access, rather than a blanket 403
        // regardless of existence - acceptable here since this is an
        // internal tool, not treated as a concern worth the extra
        // complexity of a type-only pre-check just to preserve it.
        const doc = await getDoc(docId, version);
        if (!doc) return send(res, 404, { error: 'Doc not found' });

        const canView = await global.auth.hasPermission(auth.userId, _docViewResource(doc.linkedResourceType), 'view', docId);
        if (!canView) return send(res, 403, { error: 'Forbidden' });

        const canEdit = await global.auth.hasPermission(auth.userId, DOC_MUTATE_RESOURCE, 'edit', docId);
        const canDelete = await global.auth.hasPermission(auth.userId, DOC_MUTATE_RESOURCE, 'delete', docId);

        send(res, 200, { ...doc, canEdit, canDelete });
    } catch (error) {
        global.consoleLog('Resources', `Get doc error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

async function handleGetDocHistory(req, res, auth, docId) {
    try {
        const linkedResourceType = await _getDocLinkedType(docId);
        if (!linkedResourceType) return send(res, 404, { error: 'Doc not found' });

        const canView = await global.auth.hasPermission(auth.userId, _docViewResource(linkedResourceType), 'view', docId);
        if (!canView) return send(res, 403, { error: 'Forbidden' });

        const history = await getDocHistory(docId);
        send(res, 200, { history });
    } catch (error) {
        global.consoleLog('Resources', `Get doc history error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

async function handleCreateDoc(req, res, auth) {
    try {
        // Create is uniform across every doc type (see DOC_MUTATE_RESOURCE),
        // so - unlike the type-dependent view checks elsewhere in this file -
        // this doesn't need the body parsed first just to know the type.
        const canCreate = await global.auth.hasPermission(auth.userId, DOC_MUTATE_RESOURCE, 'create');
        if (!canCreate) return send(res, 403, { error: 'Forbidden' });

        const body = await parseBody(req);
        if (!body.title) return send(res, 400, { error: 'title is required' });

        const result = await createDoc(body, auth.userId);
        send(res, 201, result);
    } catch (error) {
        global.consoleLog('Resources', `Create doc error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

async function handleUpdateDoc(req, res, auth, docId) {
    try {
        // Edit access is uniform regardless of type (see DOC_MUTATE_RESOURCE),
        // so - unlike view checks elsewhere in this file - this doesn't
        // need to know the doc's linkedResourceType at all. That also
        // fully closes a gap an earlier version of this handler had: back
        // when mutate access WAS type-dependent, someone with edit rights
        // on an unrestricted doc could re-type it into a restricted type
        // via this same update payload, since permission was only checked
        // against the doc's type before the change, not after. That
        // concern doesn't apply anymore - whatever type a doc has before
        // or after this update, the same uniform edit permission governs it.
        const canEdit = await global.auth.hasPermission(auth.userId, DOC_MUTATE_RESOURCE, 'edit', docId);
        if (!canEdit) return send(res, 403, { error: 'Forbidden' });

        const body = await parseBody(req);
        const result = await updateDoc(docId, body, auth.userId);
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Update doc error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

async function handleDeleteDoc(req, res, auth, docId) {
    try {
        const canDelete = await global.auth.hasPermission(auth.userId, DOC_MUTATE_RESOURCE, 'delete', docId);
        if (!canDelete) return send(res, 403, { error: 'Forbidden' });

        const result = await deleteDoc(docId);
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Delete doc error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

// ============================================================
// DOC FOLDERS - HTTP HANDLERS
// ============================================================

async function handleDocFoldersRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split('/').filter(p => p);
    // parts: ['kore', 'doc-folders', <folder_id>]
    const folderId = parts[2] || null;

    if (req.method === 'GET' && !folderId) {
        try {
            const folders = await getDocFolders();
            // admin-flagged folders are hidden from anyone without the same
            // doc_admin/view grant that already governs whether restricted-
            // type docs (workflow/plugin/plugin_task) are visible - see the
            // comment above getDocFolders().
            const canViewAdminFolders = await global.auth.hasPermission(auth.userId, 'doc_admin', 'view');
            const visibleFolders = canViewAdminFolders ? folders : folders.filter(f => !f.admin);
            send(res, 200, { folders: visibleFolders });
        } catch (error) {
            global.consoleLog('Resources', `List doc folders error: ${error.message}`, 1);
            send(res, 500, { error: error.message });
        }
    } else if (req.method === 'POST' && !folderId) {
        try {
            const canCreate = await global.auth.hasPermission(auth.userId, 'doc_folder', 'create');
            if (!canCreate) return send(res, 403, { error: 'Forbidden' });

            const body = await parseBody(req);
            if (!body.name) return send(res, 400, { error: 'name is required' });
            const result = await createDocFolder(body);
            send(res, 201, result);
        } catch (error) {
            global.consoleLog('Resources', `Create doc folder error: ${error.message}`, 1);
            send(res, 400, { error: error.message });
        }
    } else if (req.method === 'PUT' && folderId) {
        try {
            const canEdit = await global.auth.hasPermission(auth.userId, 'doc_folder', 'edit');
            if (!canEdit) return send(res, 403, { error: 'Forbidden' });

            const body = await parseBody(req);
            const result = await updateDocFolder(folderId, body);
            send(res, 200, result);
        } catch (error) {
            global.consoleLog('Resources', `Update doc folder error: ${error.message}`, 1);
            send(res, 400, { error: error.message });
        }
    } else if (req.method === 'DELETE' && folderId) {
        try {
            const canDelete = await global.auth.hasPermission(auth.userId, 'doc_folder', 'delete');
            if (!canDelete) return send(res, 403, { error: 'Forbidden' });

            const result = await deleteDocFolder(folderId);
            send(res, 200, result);
        } catch (error) {
            global.consoleLog('Resources', `Delete doc folder error: ${error.message}`, 1);
            send(res, 400, { error: error.message });
        }
    } else {
        send(res, 405, { error: 'Method not allowed' });
    }
}


// ============================================================
// DOC STALENESS DASHBOARD - powers the admin "Docs Missing/
// Potentially Outdated" panel.
//
// Missing = anti-join against kore_sys.docs, works identically for all
// 5 resource types since it needs no timestamp at all.
//
// Outdated = compares each resource's real "last modified" signal
// against the most recent kore_sys.docs_hist row for its doc (NOT
// docs.updatedAt - that column auto-bumps on ANY update touching the
// row, including a title-only refreshDynamicTitles() pass, so it can't
// distinguish "content was reviewed" from "title got auto-refreshed" -
// confirmed this session, see Doc Generate Guide.md §1). Only works
// for types with a confirmed reliable timestamp:
//   - workflow/form/datatable: definition->meta_data.modified_at (JSON
//     string, always literal UTC - confirmed via live data this session)
//   - plugin: a real updated_at column - though only set when the caller's
//     update payload happens to include it (handleUpdatePlugin doesn't
//     compute it server-side). Confirmed the one real caller
//     (plugins-front.js) always includes it, so this is reliable in
//     practice today, but it's a fragile guarantee, not a structural
//     one - see Bugs.md.
//   - plugin_task: a real updated_at column too (added this session),
//     server-guaranteed via NOW() directly in plugins.js's _saveTasks -
//     not client-payload-dependent like plugins.updated_at above. All
//     5 resource types now get a real outdated check.
//
// SET time_zone = '+00:00' is required on this connection before any of
// the outdated comparisons - meta_data.modified_at is a plain JSON
// string compared at face value, but docs_hist.created_at is a real
// TIMESTAMP column subject to session-timezone conversion on read.
// Comparing them without forcing a shared timezone silently breaks the
// comparison - confirmed this session, not a theoretical concern.
//
// plugins.name uses utf8mb4_0900_ai_ci while every other resource
// table's id/name column (and docs.linkedResourceId itself) uses
// utf8mb4_unicode_ci - confirmed via information_schema this session,
// the only collation mismatch among all 5 resource tables. Explicit
// COLLATE needed on the plugin joins below or MySQL throws "Illegal mix
// of collations". Worth checking information_schema.COLUMNS again if
// this pattern ever extends to a 6th resource type, rather than
// assuming every table shares one collation.
// ============================================================

async function getDocStalenessSummary() {
    const conn = await getPool().getConnection();
    try {
        await conn.query("SET time_zone = '+00:00'");

        const missing = [];
        const outdated = [];

        const latestHistJoin = `
            JOIN (
                SELECT doc_id, MAX(created_at) AS last_content_edit
                FROM kore_sys.docs_hist
                GROUP BY doc_id
            ) latest_hist ON latest_hist.doc_id = d.id
        `;

        // ---- Workflows ----
        const [missingWorkflows] = await conn.query(`
            SELECT w.id, w.name,
                JSON_UNQUOTE(JSON_EXTRACT(w.definition, '$.meta_data.modified_at')) AS resourceModifiedAt
            FROM kore_sys.workflows w
            WHERE LOWER(w.name) NOT LIKE 'test%'
              AND NOT EXISTS (
                SELECT 1 FROM kore_sys.docs d
                WHERE d.linkedResourceType = 'workflow' AND d.linkedResourceId = w.id AND d.active = TRUE
              )
        `);
        missing.push(...missingWorkflows.map(r => ({ resourceType: 'workflow', resourceId: r.id, resourceName: r.name, resourceModifiedAt: r.resourceModifiedAt })));

        const [outdatedWorkflows] = await conn.query(`
            SELECT w.id AS resourceId, w.name AS resourceName,
                JSON_UNQUOTE(JSON_EXTRACT(w.definition, '$.meta_data.modified_at')) AS resourceModifiedAt,
                d.id AS docId, d.title AS docTitle, latest_hist.last_content_edit AS docLastContentEdit
            FROM kore_sys.workflows w
            JOIN kore_sys.docs d ON d.linkedResourceType = 'workflow' AND d.linkedResourceId = w.id AND d.active = TRUE
            ${latestHistJoin}
            WHERE LOWER(w.name) NOT LIKE 'test%'
              AND STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(w.definition, '$.meta_data.modified_at')), '%Y-%m-%dT%H:%i:%s.%fZ') > latest_hist.last_content_edit
        `);
        outdated.push(...outdatedWorkflows.map(r => ({ resourceType: 'workflow', ...r })));

        // ---- Forms ----
        const [missingForms] = await conn.query(`
            SELECT f.id, f.name,
                JSON_UNQUOTE(JSON_EXTRACT(f.definition, '$.meta_data.modified_at')) AS resourceModifiedAt
            FROM kore_sys.forms f
            WHERE LOWER(f.name) NOT LIKE 'test%'
              AND NOT EXISTS (
                SELECT 1 FROM kore_sys.docs d
                WHERE d.linkedResourceType = 'form' AND d.linkedResourceId = f.id AND d.active = TRUE
              )
        `);
        missing.push(...missingForms.map(r => ({ resourceType: 'form', resourceId: r.id, resourceName: r.name, resourceModifiedAt: r.resourceModifiedAt })));

        const [outdatedForms] = await conn.query(`
            SELECT f.id AS resourceId, f.name AS resourceName,
                JSON_UNQUOTE(JSON_EXTRACT(f.definition, '$.meta_data.modified_at')) AS resourceModifiedAt,
                d.id AS docId, d.title AS docTitle, latest_hist.last_content_edit AS docLastContentEdit
            FROM kore_sys.forms f
            JOIN kore_sys.docs d ON d.linkedResourceType = 'form' AND d.linkedResourceId = f.id AND d.active = TRUE
            ${latestHistJoin}
            WHERE LOWER(f.name) NOT LIKE 'test%'
              AND STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(f.definition, '$.meta_data.modified_at')), '%Y-%m-%dT%H:%i:%s.%fZ') > latest_hist.last_content_edit
        `);
        outdated.push(...outdatedForms.map(r => ({ resourceType: 'form', ...r })));

        // ---- Datatables ----
        const [missingDatatables] = await conn.query(`
            SELECT dt.id, dt.name,
                JSON_UNQUOTE(JSON_EXTRACT(dt.definition, '$.meta_data.modified_at')) AS resourceModifiedAt
            FROM kore_sys.datatables dt
            WHERE LOWER(dt.name) NOT LIKE 'test%'
              AND NOT EXISTS (
                SELECT 1 FROM kore_sys.docs d
                WHERE d.linkedResourceType = 'datatable' AND d.linkedResourceId = dt.id AND d.active = TRUE
              )
        `);
        missing.push(...missingDatatables.map(r => ({ resourceType: 'datatable', resourceId: r.id, resourceName: r.name, resourceModifiedAt: r.resourceModifiedAt })));

        const [outdatedDatatables] = await conn.query(`
            SELECT dt.id AS resourceId, dt.name AS resourceName,
                JSON_UNQUOTE(JSON_EXTRACT(dt.definition, '$.meta_data.modified_at')) AS resourceModifiedAt,
                d.id AS docId, d.title AS docTitle, latest_hist.last_content_edit AS docLastContentEdit
            FROM kore_sys.datatables dt
            JOIN kore_sys.docs d ON d.linkedResourceType = 'datatable' AND d.linkedResourceId = dt.id AND d.active = TRUE
            ${latestHistJoin}
            WHERE LOWER(dt.name) NOT LIKE 'test%'
              AND STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(dt.definition, '$.meta_data.modified_at')), '%Y-%m-%dT%H:%i:%s.%fZ') > latest_hist.last_content_edit
        `);
        outdated.push(...outdatedDatatables.map(r => ({ resourceType: 'datatable', ...r })));

        // ---- Plugins (real updated_at column, not nested JSON) ----
        // plugins.name uses utf8mb4_0900_ai_ci while docs.linkedResourceId
        // (and every other resource table's id/name column) uses
        // utf8mb4_unicode_ci - confirmed this session via information_schema,
        // the only genuine collation mismatch among all 5 resource tables.
        // Explicit COLLATE needed on both comparisons below or MySQL throws
        // "Illegal mix of collations" - not needed anywhere else.
        const [missingPlugins] = await conn.query(`
            SELECT p.name, p.display_name, p.updated_at AS resourceModifiedAt
            FROM kore_sys.plugins p
            WHERE LOWER(p.display_name) NOT LIKE 'test%'
              AND NOT EXISTS (
                SELECT 1 FROM kore_sys.docs d
                WHERE d.linkedResourceType = 'plugin' AND d.linkedResourceId = p.name COLLATE utf8mb4_unicode_ci AND d.active = TRUE
              )
        `);
        missing.push(...missingPlugins.map(r => ({ resourceType: 'plugin', resourceId: r.name, resourceName: r.display_name, resourceModifiedAt: r.resourceModifiedAt })));

        const [outdatedPlugins] = await conn.query(`
            SELECT p.name AS resourceId, p.display_name AS resourceName,
                p.updated_at AS resourceModifiedAt,
                d.id AS docId, d.title AS docTitle, latest_hist.last_content_edit AS docLastContentEdit
            FROM kore_sys.plugins p
            JOIN kore_sys.docs d ON d.linkedResourceType = 'plugin' AND d.linkedResourceId = p.name COLLATE utf8mb4_unicode_ci AND d.active = TRUE
            ${latestHistJoin}
            WHERE LOWER(p.display_name) NOT LIKE 'test%'
              AND p.updated_at > latest_hist.last_content_edit
        `);
        outdated.push(...outdatedPlugins.map(r => ({ resourceType: 'plugin', ...r })));

        // ---- Plugin Tasks ----
        // Now has a real updated_at column (added this session, set via
        // NOW() directly in _saveTasks - server-guaranteed on every save,
        // not client-payload-dependent). No longer missing-only.
        const [missingPluginTasks] = await conn.query(`
            SELECT pt.plugin_name, pt.task_id, pt.display_name, pt.updated_at AS resourceModifiedAt
            FROM kore_sys.plugin_tasks pt
            WHERE LOWER(pt.display_name) NOT LIKE 'test%'
              AND NOT EXISTS (
                SELECT 1 FROM kore_sys.docs d
                WHERE d.linkedResourceType = 'plugin_task'
                AND d.linkedResourceId = CONCAT(pt.plugin_name, ':', pt.task_id)
                AND d.active = TRUE
              )
        `);
        missing.push(...missingPluginTasks.map(r => ({
            resourceType: 'plugin_task',
            resourceId: `${r.plugin_name}:${r.task_id}`,
            resourceName: r.display_name,
            resourceModifiedAt: r.resourceModifiedAt
        })));

        const [outdatedPluginTasks] = await conn.query(`
            SELECT CONCAT(pt.plugin_name, ':', pt.task_id) AS resourceId, pt.display_name AS resourceName,
                pt.updated_at AS resourceModifiedAt,
                d.id AS docId, d.title AS docTitle, latest_hist.last_content_edit AS docLastContentEdit
            FROM kore_sys.plugin_tasks pt
            JOIN kore_sys.docs d ON d.linkedResourceType = 'plugin_task' AND d.linkedResourceId = CONCAT(pt.plugin_name, ':', pt.task_id) AND d.active = TRUE
            ${latestHistJoin}
            WHERE LOWER(pt.display_name) NOT LIKE 'test%'
              AND pt.updated_at > latest_hist.last_content_edit
        `);
        outdated.push(...outdatedPluginTasks.map(r => ({ resourceType: 'plugin_task', ...r })));

        return { missing, outdated };
    } finally {
        conn.release();
    }
}

/**
 * Diff payload for one flagged resource - what the admin panel's modal
 * fetches on click. Returns the resource's real current definition
 * alongside its doc's current content, for the person to paste to Claude.
 * Deliberately not pre-fetched for every row in the summary above - some
 * definitions (workflows especially) are large, and most rows will never
 * actually get clicked.
 */
async function getDocStalenessComparison(resourceType, resourceId) {
    const conn = await getPool().getConnection();
    try {
        let resourceRow = null;

        if (resourceType === 'workflow') {
            const [rows] = await conn.query('SELECT id, name, version, definition FROM kore_sys.workflows WHERE id = ?', [resourceId]);
            resourceRow = rows[0] || null;
        } else if (resourceType === 'form') {
            const [rows] = await conn.query('SELECT id, name, version, definition FROM kore_sys.forms WHERE id = ?', [resourceId]);
            resourceRow = rows[0] || null;
        } else if (resourceType === 'datatable') {
            const [rows] = await conn.query('SELECT id, name, version, definition FROM kore_sys.datatables WHERE id = ?', [resourceId]);
            resourceRow = rows[0] || null;
        } else if (resourceType === 'plugin') {
            const [rows] = await conn.query('SELECT name, display_name, description, version, code, config, updated_at FROM kore_sys.plugins WHERE name = ?', [resourceId]);
            resourceRow = rows[0] || null;
        } else if (resourceType === 'plugin_task') {
            const sepIdx = resourceId.indexOf(':');
            if (sepIdx === -1) throw new Error('Invalid plugin_task resourceId - expected pluginName:taskId');
            const pluginName = resourceId.slice(0, sepIdx);
            const taskId = resourceId.slice(sepIdx + 1);
            const [rows] = await conn.query(
                'SELECT task_id, plugin_name, display_name, description, method, endpoint, route, static_params, inputs, outputs FROM kore_sys.plugin_tasks WHERE plugin_name = ? AND task_id = ?',
                [pluginName, taskId]
            );
            resourceRow = rows[0] || null;
        } else {
            throw new Error(`Unknown resourceType: ${resourceType}`);
        }

        if (!resourceRow) {
            throw new Error(`${resourceType} not found: ${resourceId}`);
        }

        const [docRows] = await conn.query(
            'SELECT id, title, version, content FROM kore_sys.docs WHERE linkedResourceType = ? AND linkedResourceId = ? AND active = TRUE',
            [resourceType, resourceId]
        );

        return {
            resourceType,
            resourceId,
            resource: resourceRow,
            doc: docRows[0] || null
        };
    } finally {
        conn.release();
    }
}

async function handleDocStalenessRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const canView = await global.auth.hasPermission(auth.userId, 'doc_admin', 'view');
    if (!canView) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Insufficient permissions' }));
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split('/').filter(p => p);
    // parts: ['kore', 'doc-staleness', 'compare'?]
    const isCompare = parts[2] === 'compare';

    if (req.method !== 'GET') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
    }

    try {
        if (isCompare) {
            const resourceType = parsedUrl.searchParams.get('resourceType');
            const resourceId = parsedUrl.searchParams.get('resourceId');
            if (!resourceType || !resourceId) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'resourceType and resourceId are required' }));
                return;
            }
            const comparison = await getDocStalenessComparison(resourceType, resourceId);
            res.writeHead(200);
            res.end(JSON.stringify(comparison));
        } else {
            const summary = await getDocStalenessSummary();
            res.writeHead(200);
            res.end(JSON.stringify(summary));
        }
    } catch (error) {
        global.consoleLog('Resources', `Doc staleness request error: ${error.message}`, 1);
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
    }
}


// ============================================================
// WORKFLOW UTILS - DATA FUNCTIONS
// ============================================================

/**
 * List all workflow utils (excludes code for list view)
 * @param {boolean} includeDisabled - Whether to include disabled actions
 */
async function listWorkflowUtils(includeDisabled = false) {
    const conn = await getPool().getConnection();
    try {
        let query = `SELECT action_name, display_name, description, category, action_config, enabled 
                     FROM kore_sys.workflow_utils`;
        
        if (!includeDisabled) {
            query += ` WHERE enabled = true`;
        }
        
        query += ` ORDER BY category, display_name ASC`;
        
        const [rows] = await conn.execute(query);
        return rows || [];
    } finally {
        conn.release();
    }
}

/**
 * Get a specific workflow util (includes code)
 * @param {string} actionName - The action slug
 */
async function getWorkflowUtil(actionName) {
    const conn = await getPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT action_name, display_name, description, category, action_config, code, enabled 
             FROM kore_sys.workflow_utils 
             WHERE action_name = ?`,
            [actionName]
        );
        if (rows.length === 0) throw new Error('Workflow util not found');
        return rows[0];
    } finally {
        conn.release();
    }
}

/**
 * Create a new workflow util
 */
async function createWorkflowUtil(utilData, userId) {
    const { action_name, display_name, description, category, action_config, code, enabled } = utilData;
    
    if (!action_name) throw new Error('action_name is required');
    if (!display_name) throw new Error('display_name is required');
    if (!action_config) throw new Error('action_config is required');
    
    const conn = await getPool().getConnection();
    try {
        await conn.execute(
            `INSERT INTO kore_sys.workflow_utils 
             (action_name, display_name, description, category, action_config, code, enabled) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [action_name, display_name, description || null, category || null, 
             JSON.stringify(action_config), code || null, enabled !== false]
        );
        return { action_name, display_name };
    } finally {
        conn.release();
    }
}

/**
 * Update an existing workflow util
 */
async function updateWorkflowUtil(actionName, utilData, userId) {
    const { display_name, description, category, action_config, code, enabled } = utilData;
    
    const conn = await getPool().getConnection();
    try {
        const updateFields = [];
        const values = [];
        
        if (display_name !== undefined) {
            updateFields.push('display_name = ?');
            values.push(display_name);
        }
        if (description !== undefined) {
            updateFields.push('description = ?');
            values.push(description || null);
        }
        if (category !== undefined) {
            updateFields.push('category = ?');
            values.push(category || null);
        }
        if (action_config !== undefined) {
            updateFields.push('action_config = ?');
            values.push(JSON.stringify(action_config));
        }
        if (code !== undefined) {
            updateFields.push('code = ?');
            values.push(code || null);
        }
        if (enabled !== undefined) {
            updateFields.push('enabled = ?');
            values.push(enabled ? 1 : 0);
        }
        
        if (updateFields.length === 0) throw new Error('No fields to update');
        
        values.push(actionName);
        const [result] = await conn.execute(
            `UPDATE kore_sys.workflow_utils SET ${updateFields.join(', ')} WHERE action_name = ?`,
            values
        );
        
        if (result.affectedRows === 0) throw new Error('Workflow util not found');
        
        return { success: true };
    } finally {
        conn.release();
    }
}

/**
 * Delete a workflow util
 */
async function deleteWorkflowUtil(actionName) {
    const conn = await getPool().getConnection();
    try {
        const [result] = await conn.execute(
            `DELETE FROM kore_sys.workflow_utils WHERE action_name = ?`,
            [actionName]
        );
        
        if (result.affectedRows === 0) throw new Error('Workflow util not found');
        
        return { success: true };
    } finally {
        conn.release();
    }
}


// ============================================================
// WORKFLOW UTILS - HTTP HANDLERS
// ============================================================

async function handleWorkflowUtilsRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split('/').filter(p => p);
    // parts: ['kore', 'workflow-utils', <action_name>]
    
    const auth = authenticate(req, res);
    if (!auth) return;
    
    if (req.method === 'GET') {
        if (parts.length === 2) {
            // List all
            return handleListWorkflowUtils(req, res, auth, parsedUrl);
        } else if (parts.length === 3) {
            // Get specific
            return handleGetWorkflowUtil(req, res, auth, parts[2]);
        }
    } else if (req.method === 'POST') {
        return handleCreateWorkflowUtil(req, res, auth);
    } else if (req.method === 'PUT' && parts.length === 3) {
        return handleUpdateWorkflowUtil(req, res, auth, parts[2]);
    } else if (req.method === 'DELETE' && parts.length === 3) {
        return handleDeleteWorkflowUtil(req, res, auth, parts[2]);
    }
    
    send(res, 405, { error: 'Method not allowed' });
}

async function handleListWorkflowUtils(req, res, auth, parsedUrl) {
    try {
        const params = parseQueryParams(req.url);
        const includeDisabled = params.include_disabled === 'true';
        const utils = await listWorkflowUtils(includeDisabled);
        send(res, 200, { utils });
    } catch (error) {
        global.consoleLog('Resources', `List workflow utils error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

async function handleGetWorkflowUtil(req, res, auth, actionName) {
    try {
        const canRead = await global.auth.hasPermission(auth.userId, 'workflow_util', 'read', actionName);
        if (!canRead) return send(res, 403, { error: 'Forbidden' });
        
        const util = await getWorkflowUtil(actionName);
        send(res, 200, util);
    } catch (error) {
        global.consoleLog('Resources', `Get workflow util error: ${error.message}`, 1);
        send(res, error.message.includes('not found') ? 404 : 400, { error: error.message });
    }
}

async function handleCreateWorkflowUtil(req, res, auth) {
    try {
        const canCreate = await global.auth.hasPermission(auth.userId, 'workflow_util', 'create');
        if (!canCreate) return send(res, 403, { error: 'Forbidden' });
        
        const body = await parseBody(req);
        const result = await createWorkflowUtil(body, auth.userId);
        send(res, 201, result);
    } catch (error) {
        global.consoleLog('Resources', `Create workflow util error: ${error.message}`, 1);
        send(res, 400, { error: error.message });
    }
}

async function handleUpdateWorkflowUtil(req, res, auth, actionName) {
    try {
        const canUpdate = await global.auth.hasPermission(auth.userId, 'workflow_util', 'update', actionName);
        if (!canUpdate) return send(res, 403, { error: 'Forbidden' });
        
        const body = await parseBody(req);
        const result = await updateWorkflowUtil(actionName, body, auth.userId);
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Update workflow util error: ${error.message}`, 1);
        send(res, error.message.includes('not found') ? 404 : 400, { error: error.message });
    }
}

async function handleDeleteWorkflowUtil(req, res, auth, actionName) {
    try {
        const canDelete = await global.auth.hasPermission(auth.userId, 'workflow_util', 'delete', actionName);
        if (!canDelete) return send(res, 403, { error: 'Forbidden' });
        
        const result = await deleteWorkflowUtil(actionName);
        send(res, 200, result);
    } catch (error) {
        global.consoleLog('Resources', `Delete workflow util error: ${error.message}`, 1);
        send(res, error.message.includes('not found') ? 404 : 400, { error: error.message });
    }
}


// ============================================================
// USER MENUS (User Portal navigation tree)
// ============================================================

/**
 * In-memory cache of built/filtered menu trees, keyed by userId.
 * Transient by design — safe to lose on restart or require.cache clearing;
 * the next request for that user just rebuilds it. Not persisted anywhere.
 *
 * TEMPORARILY set to ~1 second (effectively disabled) while menus/groups/
 * permissions are being actively built out and tested — a 5-minute lag on
 * every change was more annoying than the cache was worth at this stage.
 * The client-side sessionStorage cache in base.js (5 min) is doing the real
 * work of avoiding a request on every page navigation; this layer mainly
 * matters at higher traffic/multi-tab scale. Bump this back up (e.g. 5 min)
 * once the data is stable.
 */
const USER_MENUS_CACHE_TTL_MS = 1000; // 1 second — see note above
const userMenusCache = new Map(); // userId -> { data, expiresAt }

/**
 * Fetch all active user_menus rows (flat, not yet a tree).
 */
async function fetchUserMenuRows() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT id, parentId, label, items FROM kore_sys.user_menus WHERE active = TRUE`
    );
    return rows;
}

/**
 * Build the full (unfiltered) menu tree from flat user_menus rows.
 * Each node: { id, label, items: [{label, type, resourceId}], children: [] }
 */
function buildUserMenuTree(rows) {
    const byId = new Map();

    rows.forEach(row => {
        let items = row.items;
        if (typeof items === 'string') {
            try {
                items = JSON.parse(items);
            } catch (parseErr) {
                global.consoleLog('Resources', `Failed to parse items JSON for user_menus row ${row.id}: ${parseErr.message}`, 2);
                items = [];
            }
        }
        byId.set(row.id, { id: row.id, label: row.label, items: items || [], children: [] });
    });

    const roots = [];
    rows.forEach(row => {
        const node = byId.get(row.id);
        if (row.parentId && byId.has(row.parentId)) {
            byId.get(row.parentId).children.push(node);
        } else {
            roots.push(node);
        }
    });

    return roots;
}

/**
 * Batched replica of auth.js's hasPermission() precedence — evaluated for
 * MANY scope values of one resource type at once, instead of one call per
 * scope. Same precedence, same edge-case behavior (scope IS NULL rows apply
 * universally; a user with no groups just yields no group-row matches;
 * stale rows targeting a deleted userId still apply); this only changes how
 * many round-trips it takes to get the same answers.
 *
 * At most 2 queries total regardless of how many scopes are passed in:
 *   1. Every user-targeted or group-targeted deny/allow row relevant to
 *      ANY of these scopes (or a scope-IS-NULL row, which applies to all
 *      of them) — group membership checked inline via JSON_CONTAINS
 *      against users.groupIds, same as the optimized hasPermission().
 *   2. Only needed for scopes where #1 found no matching row at all: which
 *      of those scopes has ANY allow rule anywhere (any target) — the
 *      default-allow fallback, computed per-scope in one query.
 *
 * @returns {Promise<Map<string, boolean>>} scope -> allowed
 */
async function batchCheckPermission(userId, resource, action, scopes) {
    const result = new Map();
    const uniqueScopes = Array.from(new Set(scopes));
    if (uniqueScopes.length === 0) return result;

    const pool = getPool();
    const actionCondition = action === '*' ? `action = ?` : `(action = ? OR action = '*')`;
    const placeholders = uniqueScopes.map(() => '?').join(',');

    const targetRowsQuery = `
        SELECT targetType, targetId, effect, scope
        FROM kore_sys.permissions
        WHERE resource = ?
        AND ${actionCondition}
        AND revokedAt IS NULL
        AND (scope IS NULL OR scope IN (${placeholders}))
        AND (
            (targetType = 'user' AND targetId = ?)
            OR (targetType = 'group' AND JSON_CONTAINS(
                    (SELECT groupIds FROM kore_sys.users WHERE userId = ?),
                    JSON_QUOTE(targetId)
                ))
        )
    `;
    const [targetRows] = await pool.execute(targetRowsQuery, [resource, action, ...uniqueScopes, userId, userId]);

    const nullScopeRows = targetRows.filter(r => r.scope === null);
    const rowsByScope = new Map(uniqueScopes.map(s => [s, []]));
    for (const row of targetRows) {
        if (row.scope !== null && rowsByScope.has(row.scope)) rowsByScope.get(row.scope).push(row);
    }

    // Only the default-allow fallback needs a second query, and only for
    // scopes that didn't already resolve via an explicit user/group row.
    const undecidedScopes = uniqueScopes.filter(s => {
        const rows = [...nullScopeRows, ...rowsByScope.get(s)];
        return !rows.some(r => r.effect === 'deny' || r.effect === 'allow');
    });

    let anyAllowNullScope = false;
    const anyAllowScopes = new Set();
    if (undecidedScopes.length > 0) {
        const anyAllowQuery = `
            SELECT scope
            FROM kore_sys.permissions
            WHERE resource = ?
            AND ${actionCondition}
            AND effect = 'allow'
            AND revokedAt IS NULL
            AND (scope IS NULL OR scope IN (${undecidedScopes.map(() => '?').join(',')}))
        `;
        const [anyAllowRows] = await pool.execute(anyAllowQuery, [resource, action, ...undecidedScopes]);
        anyAllowNullScope = anyAllowRows.some(r => r.scope === null);
        anyAllowRows.forEach(r => { if (r.scope !== null) anyAllowScopes.add(r.scope); });
    }

    for (const scope of uniqueScopes) {
        const rows = [...nullScopeRows, ...rowsByScope.get(scope)];

        if (rows.some(r => r.targetType === 'user' && r.effect === 'deny')) { result.set(scope, false); continue; }
        if (rows.some(r => r.targetType === 'user' && r.effect === 'allow')) { result.set(scope, true); continue; }
        if (rows.some(r => r.targetType === 'group' && r.effect === 'deny')) { result.set(scope, false); continue; }
        if (rows.some(r => r.targetType === 'group' && r.effect === 'allow')) { result.set(scope, true); continue; }

        const anyAllowExists = anyAllowNullScope || anyAllowScopes.has(scope);
        result.set(scope, !anyAllowExists); // default allow only if no allow rule exists anywhere
    }

    return result;
}

/**
 * Walks the (unfiltered) tree once to collect every scope value that will
 * need a permission check: every container's own id (resource='menu'), and
 * every leaf item's resourceId, grouped by type (resource='form'/'datatable').
 */
function _collectMenuScopes(nodes, menuScopes, formScopes, datatableScopes) {
    for (const node of nodes) {
        menuScopes.push(node.id);
        for (const item of node.items) {
            if (item.type === 'form') formScopes.push(String(item.resourceId));
            else if (item.type === 'datatable') datatableScopes.push(String(item.resourceId));
        }
        _collectMenuScopes(node.children, menuScopes, formScopes, datatableScopes);
    }
}

/**
 * Top-level pill ordering: Employee Tools always first, Techs always
 * second (both only if actually visible to this user — a missing pinned
 * pill just doesn't create a gap), everything else alphabetical by label.
 *
 * Pinned by id, not label - a label match broke silently the first time
 * "Tech Tools" got renamed to "Techs" (the pin just stopped applying,
 * fell back to alphabetical, with no error anywhere to notice by). id is
 * stable across a rename, so this can't happen again the same way. If
 * either of these rows is ever deleted and recreated rather than renamed
 * in place, it'll get a new id and this will need updating again - a
 * rename is safe now, a delete+recreate still isn't.
 */
const PINNED_TOP_LEVEL_MENU_IDS = { '3a3zmf': 0, '8mdd4v': 1 };
function _sortTopLevelMenus(nodes) {
    return [...nodes].sort((a, b) => {
        const pa = Object.prototype.hasOwnProperty.call(PINNED_TOP_LEVEL_MENU_IDS, a.id) ? PINNED_TOP_LEVEL_MENU_IDS[a.id] : 2;
        const pb = Object.prototype.hasOwnProperty.call(PINNED_TOP_LEVEL_MENU_IDS, b.id) ? PINNED_TOP_LEVEL_MENU_IDS[b.id] : 2;
        if (pa !== pb) return pa - pb;
        return a.label.localeCompare(b.label);
    });
}

/**
 * Filters a menu tree for a given user using batched permission checks
 * instead of one hasPermission() call per node/item. At most 3 batched
 * checks total for the WHOLE tree (menu/form/datatable, each at most 2
 * queries), regardless of tree size — replacing what was previously one
 * hasPermission() call (itself up to 6 queries) per node and per item.
 *
 * Pruning rules (unchanged from before):
 * - A node (pill or category) whose own 'menu' check fails is dropped along
 *   with everything under it.
 * - A leaf item whose type/resourceId check fails is dropped from its
 *   node's items.
 * - A node left with zero visible children AND zero visible items after
 *   filtering is dropped entirely (no empty headers).
 *
 * Ordering: sub-categories and items are sorted alphabetically by label at
 * every level (children listed before items, matching the client's render
 * order). The top-level pill array gets the special Employee/Tech-first
 * ordering — see _sortTopLevelMenus().
 */
async function filterUserMenuTreeForUser(nodes, userId) {
    const menuScopes = [];
    const formScopes = [];
    const datatableScopes = [];
    _collectMenuScopes(nodes, menuScopes, formScopes, datatableScopes);

    const [menuPerms, formPerms, datatablePerms] = await Promise.all([
        batchCheckPermission(userId, 'menu', 'view', menuScopes),
        batchCheckPermission(userId, 'form', 'view', formScopes),
        batchCheckPermission(userId, 'datatable', 'view', datatableScopes)
    ]);
    const permsByType = { form: formPerms, datatable: datatablePerms };

    function prune(list) {
        const result = [];
        for (const node of list) {
            if (!menuPerms.get(node.id)) continue; // denied (or missing) -> drop whole subtree

            const visibleChildren = prune(node.children).sort((a, b) => a.label.localeCompare(b.label));
            const visibleItems = node.items
                .filter(item => {
                    const map = permsByType[item.type];
                    return map ? !!map.get(String(item.resourceId)) : false;
                })
                .sort((a, b) => a.label.localeCompare(b.label));

            if (visibleChildren.length === 0 && visibleItems.length === 0) continue;

            result.push({ id: node.id, label: node.label, children: visibleChildren, items: visibleItems });
        }
        return result;
    }

    return _sortTopLevelMenus(prune(nodes));
}

/**
 * Build (or return cached) the permission-filtered menu tree for a user.
 */
async function getUserMenusForUser(userId) {
    const cached = userMenusCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }

    const rows = await fetchUserMenuRows();
    const tree = buildUserMenuTree(rows);
    const filtered = await filterUserMenuTreeForUser(tree, userId);

    userMenusCache.set(userId, { data: filtered, expiresAt: Date.now() + USER_MENUS_CACHE_TTL_MS });
    return filtered;
}

/**
 * GET /kore/user-menus
 * Returns the current user's permission-filtered User Portal menu tree as
 * a single JSON payload: { menus: [ {id, label, children, items}, ... ] }
 *
 * Cache-Control: private, max-age=30 — lets the browser's own HTTP cache
 * dedupe repeat requests (including across tabs/windows sharing the same
 * profile) without any client-side JS cache. "private" is required, not
 * "public": this response is personalized per session cookie, so it must
 * never be cacheable by a shared proxy/CDN. A normal reload can be served
 * from this cache; Ctrl+Shift+R forces revalidation, which is why that's
 * still the right move while actively testing menu/permission changes.
 *
 * Known limitation (accepted for now, internal-only portal): the HTTP
 * cache key is the URL, not the session cookie, so if two different users
 * log into the same shared browser profile back-to-back, a still-fresh
 * cached response from the first user's session could theoretically be
 * served to the second before their own request completes. Revisit with a
 * Vary: Cookie header (or a different strategy) when the client-facing
 * portal is built, where shared-workstation logins are a real scenario.
 */
async function handleUserMenusRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;

    try {
        const menus = await getUserMenusForUser(auth.userId);
        res.setHeader('Cache-Control', 'private, max-age=30');
        send(res, 200, { menus });
    } catch (error) {
        global.consoleLog('Resources', `Get user menus error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}


/**
 * Fetch ALL user menu rows (unfiltered, for admin editing)
 */
async function fetchAllUserMenuRows() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT id, parentId, label, items, active, createdAt, updatedAt FROM kore_sys.user_menus ORDER BY label ASC`
    );
    return rows || [];
}

/**
 * GET /kore/user-menus/admin
 * Returns all user menu nodes (flat array with parentId) for admin editing
 */
async function handleAdminUserMenusGetRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!(await authorizeMenuAdmin(req, res, auth))) return;

    try {
        const rows = await fetchAllUserMenuRows();
        send(res, 200, { menus: rows });
    } catch (error) {
        global.consoleLog('Resources', `Get admin user menus error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

/**
 * POST /kore/user-menus/admin
 * Create a new user menu node
 * Body: { label, parentId (optional), items (optional), active (optional) }
 */
async function handleAdminUserMenusPostRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!(await authorizeMenuAdmin(req, res, auth))) return;

    try {
        const body = await parseBody(req);
        const { label, parentId, items, active } = body;

        if (!label || typeof label !== 'string') {
            return send(res, 400, { error: 'label is required and must be a string' });
        }

        const id = generateId('menu');
        const itemsJson = items ? JSON.stringify(items) : null;
        const isActive = active !== false ? 1 : 0;
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

        const pool = getPool();
        const conn = await pool.getConnection();
        try {
            await conn.execute(
                `INSERT INTO kore_sys.user_menus (id, parentId, label, items, active, createdAt, updatedAt) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [id, parentId || null, label, itemsJson, isActive, now, now]
            );

            const created = { id, parentId: parentId || null, label, items: items || null, active: isActive, createdAt: now, updatedAt: now };
            send(res, 201, { success: true, created });
        } finally {
            conn.release();
        }
    } catch (error) {
        global.consoleLog('Resources', `Create admin user menu error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

/**
 * PUT /kore/user-menus/admin/:id
 * Update a user menu node
 * Body: { label?, parentId?, items?, active? }
 */
async function handleAdminUserMenusPutRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!(await authorizeMenuAdmin(req, res, auth))) return;

    try {
        const url = new URL(req.url, 'http://localhost');
        const id = url.pathname.split('/').pop();

        if (!id) {
            return send(res, 400, { error: 'Menu ID is required' });
        }

        const body = await parseBody(req);
        const updates = {};
        const updateFields = [];
        const values = [];

        if (body.hasOwnProperty('label') && body.label !== null) {
            if (typeof body.label !== 'string') {
                return send(res, 400, { error: 'label must be a string' });
            }
            updates.label = body.label;
            updateFields.push('label = ?');
            values.push(body.label);
        }

        if (body.hasOwnProperty('parentId')) {
            updates.parentId = body.parentId || null;
            updateFields.push('parentId = ?');
            values.push(body.parentId || null);
        }

        if (body.hasOwnProperty('items')) {
            const itemsJson = body.items ? JSON.stringify(body.items) : null;
            updates.items = body.items;
            updateFields.push('items = ?');
            values.push(itemsJson);
        }

        if (body.hasOwnProperty('active')) {
            const isActive = body.active !== false ? 1 : 0;
            updates.active = isActive;
            updateFields.push('active = ?');
            values.push(isActive);
        }

        if (updateFields.length === 0) {
            return send(res, 400, { error: 'No fields to update' });
        }

        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        updateFields.push('updatedAt = ?');
        values.push(now);
        values.push(id);

        const pool = getPool();
        const conn = await pool.getConnection();
        try {
            const [result] = await conn.execute(
                `UPDATE kore_sys.user_menus SET ${updateFields.join(', ')} WHERE id = ?`,
                values
            );

            if (result.affectedRows === 0) {
                return send(res, 404, { error: 'Menu node not found' });
            }

            send(res, 200, { success: true, updated: { id, ...updates, updatedAt: now } });
        } finally {
            conn.release();
        }
    } catch (error) {
        global.consoleLog('Resources', `Update admin user menu error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

/**
 * DELETE /kore/user-menus/admin/:id
 * Delete a user menu node
 */
async function handleAdminUserMenusDeleteRequest(req, res) {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!(await authorizeMenuAdmin(req, res, auth))) return;

    try {
        const url = new URL(req.url, 'http://localhost');
        const id = url.pathname.split('/').pop();

        if (!id) {
            return send(res, 400, { error: 'Menu ID is required' });
        }

        const pool = getPool();
        const conn = await pool.getConnection();
        try {
            const [result] = await conn.execute(
                `DELETE FROM kore_sys.user_menus WHERE id = ?`,
                [id]
            );

            if (result.affectedRows === 0) {
                return send(res, 404, { error: 'Menu node not found' });
            }

            send(res, 200, { success: true, deleted: { id } });
        } finally {
            conn.release();
        }
    } catch (error) {
        global.consoleLog('Resources', `Delete admin user menu error: ${error.message}`, 1);
        send(res, 500, { error: error.message });
    }
}

/**
 * Route admin user-menus requests (GET, POST, PUT, DELETE)
 */
function handleAdminUserMenusRequest(req, res) {
    const url = req.url;
    const method = req.method;

    // GET /kore/user-menus/admin or POST /kore/user-menus/admin
    if (/^\/kore\/user-menus\/admin(\?.*)?$/.test(url)) {
        if (method === 'GET') {
            handleAdminUserMenusGetRequest(req, res);
            return true;
        }
        if (method === 'POST') {
            handleAdminUserMenusPostRequest(req, res);
            return true;
        }
    }

    // PUT /kore/user-menus/admin/:id or DELETE /kore/user-menus/admin/:id
    if (/^\/kore\/user-menus\/admin\/[a-z0-9\-]+(\?.*)?$/.test(url)) {
        if (method === 'PUT') {
            handleAdminUserMenusPutRequest(req, res);
            return true;
        }
        if (method === 'DELETE') {
            handleAdminUserMenusDeleteRequest(req, res);
            return true;
        }
    }

    return false;
}

/**
 * Route incoming requests to the appropriate resource handler.
 * Returns true if the request was handled, false otherwise.
 */
function handleRoute(req, res) {
    const url = req.url;
    // user-menus admin must come BEFORE user-menus (more specific path)
    if (/^\/kore\/user-menus\/admin(\/.*)?(\?.*)?$/.test(url)) {
        handleAdminUserMenusRequest(req, res);
        return true;
    }
    if (/^\/kore\/user-menus(\?.*)?$/.test(url)) {
        handleUserMenusRequest(req, res);
        return true;
    }
    // workflow-folders must come BEFORE workflows (more specific path)
    if (/^\/kore\/workflow-folders(\/.*)?(\?.*)?$/.test(url)) {
        handleWorkflowFoldersRequest(req, res);
        return true;
    }
    if (/^\/kore\/workflows(\/.*)?(\?.*)?$/.test(url)) {
        handleWorkflowRequest(req, res);
        return true;
    }
    // form-folders must come BEFORE forms (more specific path)
    if (/^\/kore\/form-folders(\/.*)?(\?.*)?$/.test(url)) {
        handleFormFoldersRequest(req, res);
        return true;
    }
    // forms/admin must come BEFORE forms/:id (more specific path)
    if (/^\/kore\/forms\/admin(\?.*)?$/.test(url)) {
        handleFormsAdminRequest(req, res);
        return true;
    }
    if (/^\/kore\/forms(\/.*)?(\?.*)?$/.test(url)) {
        handleFormsRequest(req, res);
        return true;
    }
    // datatable-folders must come BEFORE datatables (more specific path)
    if (/^\/kore\/datatable-folders(\/.*)?(\?.*)?$/.test(url)) {
        handleDatatableFoldersRequest(req, res);
        return true;
    }
    // datatables/admin must come BEFORE datatables/:id (more specific path)
    if (/^\/kore\/datatables\/admin(\?.*)?$/.test(url)) {
        handleDatatablesAdminRequest(req, res);
        return true;
    }
    if (/^\/kore\/datatables(\/.*)?(\?.*)?$/.test(url)) {
        handleDatatableRequest(req, res);
        return true;
    }
    if (/^\/kore\/workflow-utils(\/.*)?(\?.*)?$/.test(url)) {
        handleWorkflowUtilsRequest(req, res);
        return true;
    }
    if (/^\/kore\/doc-staleness(\/.*)?(\?.*)?$/.test(url)) {
        handleDocStalenessRequest(req, res);
        return true;
    }
    // doc-folders must come BEFORE docs (more specific path)
    if (/^\/kore\/doc-folders(\/.*)?(\?.*)?$/.test(url)) {
        handleDocFoldersRequest(req, res);
        return true;
    }
    if (/^\/kore\/docs(\/.*)?(\?.*)?$/.test(url)) {
        handleDocsRequest(req, res);
        return true;
    }
    if (/^\/kore\/user-menus(\?.*)?$/.test(url)) {
        handleUserMenusRequest(req, res);
        return true;
    }
    return false;
}


// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Initialize Resources module
 * Stateless module - no operation draining needed
 * This function exists for consistency with other subsystems
 */
async function initialize() {
    // No-op - stateless module
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    initialize,
    handleRoute,
    // Generic (for datatables and future resource types)
    createResource,
    updateResource,
    deleteResource,
    validateWorkflow,
    createWorkflow,
    updateWorkflow,
    listWorkflows,
    getWorkflow,
    // Workflow Folders
    getWorkflowFolders,
    createWorkflowFolder,
    updateWorkflowFolder,
    deleteWorkflow,
    deleteWorkflowFolder,
    // Forms
    createForm,
    updateForm,
    listForms,
    getForm,
    deleteForm,
    // Form Folders
    getFormFolders,
    createFormFolder,
    updateFormFolder,
    deleteFormFolder,
    // Datatables
    createDataTable,
    updateDataTable,
    deleteDataTable,
    listDatatables,
    getDataTable,
    // Datatable Folders
    getDatatableFolders,
    createDatatableFolder,
    updateDatatableFolder,
    deleteDatatableFolder,
    // Workflow Utils
    listWorkflowUtils,
    getWorkflowUtil,
    createWorkflowUtil,
    updateWorkflowUtil,
    deleteWorkflowUtil,
    // User Menus
    getUserMenusForUser,
    fetchAllUserMenuRows,
    handleAdminUserMenusRequest,
    // Admin pickers (unfiltered name/id lists)
    listFormsAdmin,
    listDatatablesAdmin,
    handleFormsAdminRequest,
    handleDatatablesAdminRequest,
    // Docs
    createDoc,
    updateDoc,
    deleteDoc,
    listDocs,
    getDoc,
    getDocHistory,
    // Doc Folders
    getDocFolders,
    createDocFolder,
    updateDocFolder,
    deleteDocFolder,
    // Authorization helper
    authorizeMenuAdmin
};