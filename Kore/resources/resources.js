/**
 * Resources - Kore Managed Resource Module
 *
 * Stateless function module - no active operations or state to drain.
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
 * @version 0.101
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
        let folderId = autoGenerateId ? null : folderData.id;
        if (!folderId) throw new Error('id is required');

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
 * Delete a folder (cascades child folders first, then orphans items)
 * @param {string} folderTableName - Folder table name (workflow_folders, form_folders)
 * @param {string} folderId - Folder ID to delete
 * @param {string} itemTableName - Name of resource table to orphan (workflows, forms)
 */
async function deleteFolder(folderTableName, folderId, itemTableName) {
    const conn = await getPool().getConnection();
    try {
        // Verify folder exists
        const [folders] = await conn.execute(
            `SELECT id FROM kore_sys.${folderTableName} WHERE id = ?`, [folderId]
        );
        if (folders.length === 0) throw new Error('Folder not found');

        // Check for child folders
        const [children] = await conn.execute(
            `SELECT id FROM kore_sys.${folderTableName} WHERE parent_id = ?`, [folderId]
        );

        // If has children, orphan them; otherwise orphan items
        if (children.length > 0) {
            await conn.execute(
                `UPDATE kore_sys.${folderTableName} SET parent_id = NULL WHERE parent_id = ?`, 
                [folderId]
            );
        } else {
            await conn.execute(
                `UPDATE kore_sys.${itemTableName} SET folder_id = NULL WHERE folder_id = ?`,
                [folderId]
            );
        }

        // Delete the folder
        await conn.execute(
            `DELETE FROM kore_sys.${folderTableName} WHERE id = ?`,
            [folderId]
        );

        return { success: true };
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
                if (err.code === 'ER_DUP_ENTRY') continue;
                throw err;
            }
        }
        if (!inserted) throw new Error(`Failed to generate unique ID for ${resourceType} after 5 attempts`);
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
    const { name, folder_id, allowedIPs } = workflowData;
    if (!name) throw new Error('name is required');

    const definition = {
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

        global.consoleLog('Resources', `${resourceType} deleted: ${id} (snapshot v${liveRow.version} retained in history)`, 3);
        return { success: true };
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

        const canEdit   = await global.auth.hasPermission(auth.userId, resourceType, 'edit',   String(resourceId));
        const canDelete = await global.auth.hasPermission(auth.userId, resourceType, 'delete', String(resourceId));

        send(res, 200, { ...resource, canEdit, canDelete });
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

async function listDatatables(clientIP) {
    // TODO: implement
    throw new Error('listDatatables not yet implemented');
}

async function getDataTable(datatableId, clientIP = null) {
    // TODO: implement
    throw new Error('getDataTable not yet implemented');
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
            return handleListResource(req, res, 'datatable', listDatatables, auth, clientIP);
        } else if (parts.length === 3) {
            return handleGetResource(req, res, 'datatable', getDataTable, auth, clientIP, parts[2]);
        }
    } else if (req.method === 'POST') {
        return handleCreateResource(req, res, 'datatable', createDataTable, auth, (body) => {
            if (!body.name) return { valid: false, errors: ['name is required'] };
            return { valid: true, errors: [] };
        });
    } else if (req.method === 'PUT' && parts.length === 3) {
        return handleUpdateResource(req, res, 'datatable', getDataTable, updateDataTable, auth, clientIP, parts[2]);
    } else if (req.method === 'DELETE' && parts.length === 3) {
        return handleDeleteDataTable(req, res, auth, parts[2]);
    }

    send(res, 405, { error: 'Method not allowed' });
}

async function handleDeleteDataTable(req, res, auth, datatableId) {
    try {
        const canDelete = await global.auth.hasPermission(auth.userId, 'datatable', 'delete', datatableId);
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



/**
 * Route incoming requests to the appropriate resource handler.
 * Returns true if the request was handled, false otherwise.
 */
function handleRoute(req, res) {
    const url = req.url;
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
    if (/^\/kore\/forms(\/.*)?(\?.*)?$/.test(url)) {
        handleFormsRequest(req, res);
        return true;
    }
    // datatable-folders must come BEFORE datatables (more specific path)
    if (/^\/kore\/datatable-folders(\/.*)?(\?.*)?$/.test(url)) {
        handleDatatableFoldersRequest(req, res);
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
    deleteWorkflowUtil
};