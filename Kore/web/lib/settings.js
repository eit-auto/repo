import '/lib/base.js';

let currentUser = getUser();  // Initialize once at module load
let sessionToken = null;             // Lazy-initialized on first async use

let confirmCallback = null;

// Entity type configurations for reducing duplication
const ENTITY_TYPES = {
    org: { getter: 'getOrganizations', cache: 'cachedOrganizations', sidebar: 'organizationListSidebar', buttonClass: 'selectOrganizationFromList' },
    user: { getter: 'getUsers', cache: 'cachedUsers', sidebar: 'usersListSidebar', buttonClass: 'selectUserFromList' },
    group: { getter: 'getGroups', cache: 'cachedGroups', sidebar: 'groupsListSidebar', buttonClass: 'selectGroupFromList' }
};

// Generic list loader - reduces loadOrganizationsList, loadUsersList, loadGroupsList (3 functions → 1)
async function loadEntityListGeneric(type, preLoadFn) {
    try {
        if (!sessionToken) sessionToken = await getSessionToken();
        const config = ENTITY_TYPES[type];
        const entities = await window[config.getter](sessionToken, currentUser);
        if (preLoadFn) await preLoadFn(entities);
        
        const sidebar = document.getElementById(config.sidebar);
        const checkbox = document.getElementById('showInactive' + (type === 'org' ? 'Orgs' : type === 'user' ? 'Users' : 'Groups'));
        if (checkbox && !checkbox.__initialized) {
            checkbox.__initialized = true;
            checkbox.addEventListener('change', () => displayEntityListGeneric(type, window[config.cache]));
        }
        displayEntityListGeneric(type, entities);
    } catch (error) {
        console.error(`Error loading ${type}:`, error);
        const sidebar = document.getElementById(ENTITY_TYPES[type].sidebar);
        if (sidebar) sidebar.innerHTML = '<p style="color: var(--text-muted); font-size: 11px; margin: 0;">Error loading ' + type + '</p>';
    }
}

// Generic list display - reduces displayOrganizations, displayUsers, displayGroups (3 functions → 1)
function displayEntityListGeneric(type, entities) {
    if (!entities?.length) {
        const sidebar = document.getElementById(ENTITY_TYPES[type].sidebar);
        sidebar.innerHTML = '<p style="color: var(--text-muted); font-size: 11px; margin: 0;">No ' + type + ' found</p>';
        return;
    }
    
    window[ENTITY_TYPES[type].cache] = entities;
    const checkbox = document.getElementById('showInactive' + (type === 'org' ? 'Orgs' : type === 'user' ? 'Users' : 'Groups'));
    const showInactive = checkbox?.checked || false;
    
    let filtered = entities;
    if (type === 'org') {
        filtered = entities.filter(e => e.org_id !== 0 && (showInactive || !e.inactive));
    } else {
        filtered = entities.filter(e => showInactive || e.active);
    }
    
    const sidebar = document.getElementById(ENTITY_TYPES[type].sidebar);
    const html = filtered.map(e => {
        const id = type === 'org' ? e.org_id : type === 'user' ? e.userId : e.groupId;
        const name = type === 'org' ? e.org_name : type === 'user' ? (e.fullName || e.email) : e.name;
        return `<button class="btn" data-color="theme-neutral" data-size="sm" onclick="${ENTITY_TYPES[type].buttonClass}('${escapeHtml(String(id))}', this)" style="width: 100%; text-align: center;">${escapeHtml(name)}</button>`;
    }).join('');
    sidebar.innerHTML = html || '<p style="color: var(--text-muted); font-size: 11px; margin: 0;">No ' + type + ' found</p>';
}

// Detail display field specifications - defines editable and read-only fields for each entity type
const DETAIL_FIELD_SPECS = {
    org: {
        selector: '#organizationsTab .panel-level-2 > div > div:last-child',
        title: 'Organization',
        editableFields: [
            { id: 'orgNameInput', label: 'Organization Name', type: 'text', dataKey: 'org_name' },
            { id: 'orgStatusInput', label: 'Inactive', type: 'checkbox', dataKey: 'inactive' }
        ],
        readonlyFields: [
            { label: 'Organization ID', dataKey: 'org_id' },
            { label: 'Last Updated', dataKey: 'last_update', format: 'date' },
            { label: 'Last Updated By', dataKey: 'last_user' }
        ],
        unsavedCheckFn: 'checkOrgUnsavedChanges',
        currentVar: 'currentOrganization',
        cache: 'cachedOrganizations',
        idField: 'org_id',
        onDisplayComplete: 'loadOrgStack'
    },
    user: {
        selector: '#usersTab .panel-level-2 > div > div:last-child',
        title: 'User',
        editableFields: [
            { id: 'userEmailInput', label: 'Email', type: 'email', dataKey: 'email' },
            { id: 'userFullNameInput', label: 'Full Name', type: 'text', dataKey: 'fullName' },
            { id: 'userActiveInput', label: 'Active', type: 'checkbox', dataKey: 'active' }
        ],
        readonlyFields: [
            { label: 'User ID', dataKey: 'userId' },
            { label: 'Status', dataKey: 'status' },
            { label: 'MFA Enabled', dataKey: 'mfaEnabled', format: 'yesno' },
            { label: 'Created', dataKey: 'createdAt', format: 'date' },
            { label: 'Last Login', dataKey: 'lastLoginAt', format: 'date', fallback: 'Never' },
            { label: 'Locked Until', dataKey: 'lockedUntil', format: 'date', conditional: 'isLocked' }
        ],
        unsavedCheckFn: 'checkUserUnsavedChanges',
        currentVar: 'currentUserDetail',
        cache: 'cachedUsers',
        idField: 'userId',
        onDisplayComplete: null
    },
    group: {
        selector: '#groupsTab .panel-level-2 > div > div:last-child',
        title: 'Group',
        editableFields: [
            { id: 'groupNameInput', label: 'Group Name', type: 'text', dataKey: 'name' },
            { id: 'groupDescriptionInput', label: 'Description', type: 'text', dataKey: 'description' },
            { id: 'groupActiveInput', label: 'Active', type: 'checkbox', dataKey: 'active' }
        ],
        readonlyFields: [
            { label: 'Group ID', dataKey: 'groupId' },
            { label: 'Created', dataKey: 'createdAt', format: 'date' },
            { label: 'Created By', dataKey: 'createdBy' }
        ],
        unsavedCheckFn: 'checkGroupUnsavedChanges',
        currentVar: 'currentGroupDetail',
        cache: 'cachedGroups',
        idField: 'groupId',
        onDisplayComplete: null
    }
};

// Generic detail display - uses DETAIL_FIELD_SPECS to build entity detail panels
function displayEntityDetailsGeneric(entityType, entityId) {
    const spec = DETAIL_FIELD_SPECS[entityType];
    const detailArea = document.querySelector(spec.selector);
    
    if (!detailArea) {
        console.error('Detail area not found for', entityType);
        return;
    }
    
    const entityData = window[spec.cache]?.find(e => e[spec.idField] == entityId);
    if (!entityData) {
        console.warn(`${entityType} data not found for ${spec.idField}:`, entityId);
        return;
    }
    
    // Build editable fields HTML
    let editableHtml = '';
    spec.editableFields.forEach(field => {
        const value = entityData[field.dataKey];
        const isCheckbox = field.type === 'checkbox';
        
        if (isCheckbox) {
            editableHtml += `
                <div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <input type="checkbox" id="${field.id}" ${value ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;" onchange="${spec.unsavedCheckFn}()">
                        <label for="${field.id}" style="color: var(--text-muted); font-size: 11px; cursor: pointer; margin: 0; font-weight: 600;">${field.label}</label>
                    </div>
                </div>
            `;
        } else {
            editableHtml += `
                <div>
                    <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 3px; font-weight: 600;">${field.label}</label>
                    <input type="${field.type}" id="${field.id}" value="${escapeHtml(value || '')}" style="width: 100%;" oninput="${spec.unsavedCheckFn}()">
                </div>
            `;
        }
    });
    
    // Build readonly fields HTML
    let readonlyHtml = '';
    spec.readonlyFields.forEach(field => {
        // Check conditional display
        if (field.conditional) {
            const condValue = entityData[field.conditional.replace('is', '').toLowerCase()];
            const isLocked = entityData.lockedUntil && new Date(entityData.lockedUntil) > new Date();
            if (!isLocked) return;
        }
        
        let displayValue = entityData[field.dataKey];
        if (field.format === 'date' && displayValue) {
            displayValue = new Date(displayValue).toLocaleString();
        } else if (field.format === 'yesno' && displayValue !== undefined) {
            displayValue = displayValue ? 'Yes' : 'No';
        } else if (!displayValue && field.fallback) {
            displayValue = field.fallback;
        }
        
        readonlyHtml += `
            <div style="display: flex; gap: 8px; font-size: 12px;">
                <span style="color: var(--text-muted); font-weight: 600;">${field.label}:</span>
                <span style="color: var(--text-primary);">${escapeHtml(String(displayValue || ''))}</span>
            </div>
        `;
    });
    
    // Build button bar
    let buttonBar = `
        <button class="btn" data-color="green" data-size="sm" onclick="save${entityType.charAt(0).toUpperCase() + entityType.slice(1)}Details('${escapeHtml(String(entityId))}')" id="save${entityType}Btn">Save</button>
        <button class="btn" data-color="grey" data-size="sm" onclick="cancel${entityType.charAt(0).toUpperCase() + entityType.slice(1)}Edit('${escapeHtml(String(entityId))}')" id="cancel${entityType}Btn">Cancel</button>
    `;
    
    // User-specific buttons (action pod buttons removed from header)
    if (entityType === 'user') {
        const isLocked = entityData.lockedUntil && new Date(entityData.lockedUntil) > new Date();
        if (isLocked) {
            buttonBar += `<button class="btn" data-color="blue" data-size="sm" onclick="unlockUser('${escapeHtml(String(entityId))}')" id="unlockUserBtn">Unlock</button>`;
        }
    }
    
    // Build main panel
    const detailsHtml = `
        <div class="panel-level-3" style="display: flex; flex-direction: column; gap: 10px; flex: 1;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <h3 style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">${spec.title} Details</h3>
                <div style="display: flex; gap: 8px;">
                    ${buttonBar}
                </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div style="display: flex; flex-direction: column; gap: 15px;">
                    ${editableHtml}
                </div>
                ${readonlyHtml ? `<div style="display: flex; flex-direction: column; gap: 15px;">${readonlyHtml}</div>` : ''}
            </div>
        </div>
    `;
    
    detailArea.innerHTML = '';

    if (entityType === 'user') {
        const isInvited = entityData.status === 'invited';
        const actionsHtml = `
            <div class="panel-level-3" style="display: flex; flex-direction: column; gap: 8px; flex: 1;">
                <h3 style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Actions</h3>
                ${entityData.mfaEnabled ? `<button class="btn" data-color="orange" data-size="sm" onclick="resetUserMFA('${escapeHtml(String(entityId))}')" id="resetMFABtn" style="width: 100%;">Reset MFA</button>` : ''}
                ${isInvited ? `<button class="btn" data-color="gold" data-size="sm" onclick="resendUserInvite('${escapeHtml(String(entityId))}')" id="resendInviteBtn" style="width: 100%;">Resend Invite</button>` : ''}
                <button class="btn" data-color="blue" data-size="sm" onclick="viewUserPermissions('${escapeHtml(String(entityId))}')" id="viewPermissionsBtn" style="width: 100%;">View Permissions</button>
            </div>
        `;
        detailArea.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 15px; flex: 1; min-height: 0;">
                <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 15px; align-items: stretch;">
                    <div style="display: flex; flex-direction: column;">${detailsHtml}</div>
                    <div style="display: flex; flex-direction: column;">${actionsHtml}</div>
                </div>
                <div id="userGroupsCell"></div>
            </div>`;
    } else if (entityType === 'group') {
        const actionsHtml = `
            <div class="panel-level-3" style="display: flex; flex-direction: column; gap: 8px; flex: 1;">
                <h3 style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Actions</h3>
                <button class="btn" data-color="blue" data-size="sm" onclick="viewGroupPermissions('${escapeHtml(String(entityId))}')" id="viewGroupPermissionsBtn" style="width: 100%;">View Permissions</button>
            </div>
        `;
        detailArea.innerHTML = `
            <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 15px; align-items: stretch;">
                <div style="display: flex; flex-direction: column;">${detailsHtml}</div>
                <div style="display: flex; flex-direction: column;">${actionsHtml}</div>
            </div>`;
    } else if (entityType === 'org') {
        detailArea.innerHTML = detailsHtml;
    } else {
        detailArea.innerHTML = detailsHtml;
    }

    window[spec.currentVar] = entityData;
    window.clearUnsavedChanges();
    
    // Post-display setup
    if (spec.onDisplayComplete) {
        window[spec.onDisplayComplete](entityId);
    }
    if (entityType === 'user') {
        addUserGroupsSection(entityData, document.getElementById('userGroupsCell'));
    }
}

function addUserGroupsSection(userData, targetEl) {
    if (!targetEl) return;
    let userGroupIds = [];
    try {
        if (userData.groupIds) {
            if (Array.isArray(userData.groupIds)) {
                userGroupIds = userData.groupIds;
            } else if (typeof userData.groupIds === 'string') {
                try {
                    userGroupIds = JSON.parse(userData.groupIds);
                } catch {
                    userGroupIds = userData.groupIds.split(',').map(id => id.trim()).filter(id => id);
                }
            }
        }
    } catch (e) {
        console.warn('Could not parse groupIds:', e);
    }
    
    const groupsHtml = `
        <div class="panel-level-3" style="display: flex; flex-direction: column; gap: 10px;">
            <h3 style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Groups</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px;">
                ${window.cachedGroups && window.cachedGroups.length > 0 
                    ? window.cachedGroups.sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(group => `
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <input type="checkbox" id="group_${escapeHtml(String(group.groupId))}" ${userGroupIds.includes(group.groupId) ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;" onchange="checkUserUnsavedChanges()">
                            <label for="group_${escapeHtml(String(group.groupId))}" style="flex: 1; color: var(--text-primary); font-size: 12px; cursor: pointer; margin: 0;">${escapeHtml(group.name)}</label>
                        </div>
                    `).join('')
                    : '<p style="color: var(--text-muted); font-size: 11px; margin: 0;">No groups available</p>'
                }
            </div>
        </div>
    `;
    targetEl.innerHTML = groupsHtml;
}


async function loadOrganizationsList() {
    return loadEntityListGeneric('org');
}

function displayOrganizations(organizations) {
    displayEntityListGeneric('org', organizations);
}

async function showAddOrganizationModal() {
    // Create custom modal for adding organization
    const stackTypesHtml = cachedStackTypes ? `
        <div style="display: flex; flex-direction: column; gap: 15px; margin-top: 5px; padding-top: 15px; border-top: 1px solid var(--border-primary);">
            <h4 style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">System Integrations</h4>
            ${['rmm', 'psa', 'control', 'rpa', 'bdr'].map(integration => {
                const typeKey = integration + '_type_id';
                const idKey = integration + '_id';
                const label = integration.charAt(0).toUpperCase() + integration.slice(1);
                const types = cachedStackTypes[integration] || [];
                
                return `
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <div>
                            <label style="color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 3px; font-size: 11px;">${label} Type</label>
                            <select id="add_${typeKey}" style="width: 100%; font-size: 12px;">
                                <option value="">-- Not Set --</option>
                                ${types.map(t => {
                                    const typeIdField = Object.keys(t).find(k => k.endsWith('_type_id'));
                                    const nameField = Object.keys(t).find(k => k.endsWith('_name'));
                                    return `<option value="${t[typeIdField]}">${window.escapeHtml(t[nameField])}</option>`;
                                }).join('')}
                            </select>
                        </div>
                        <div>
                            <label style="color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 3px; font-size: 11px;">${label} ID</label>
                            <input type="text" id="add_${idKey}" style="width: 100%; font-size: 12px;">
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    ` : '';
    
    const modalHtml = `
        <div style="display: flex; flex-direction: column; gap: 15px; min-height: 0;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <div>
                    <label style="color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 3px; font-size: 11px;">Organization Name</label>
                    <input type="text" id="add_orgName" style="width: 100%; font-size: 12px;">
                </div>
                
                <div style="display: flex; align-items: flex-end;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <input type="checkbox" id="add_orgInactive" style="width: 16px; height: 16px; cursor: pointer;">
                        <label for="add_orgInactive" style="color: var(--text-muted); font-size: 11px; cursor: pointer; margin: 0;">Inactive</label>
                    </div>
                </div>
            </div>
            
            ${stackTypesHtml}
        </div>
    `;
    
    window.showFormModal('Add Organization', [], async () => {
        await saveNewOrganization();
    });
    
    // Replace modal body content with custom HTML
    const modalBody = document.getElementById('modal-body-content');
    if (modalBody) {
        modalBody.innerHTML = modalHtml;
    }
}

async function saveNewOrganization() {
    const orgName = document.getElementById('add_orgName')?.value || '';
    const status = document.getElementById('add_orgInactive')?.checked ? 1 : 0;
    
    if (!orgName.trim()) {
        window.showStatusBanner('Organization name cannot be empty', 'error', 'orgsStatusMessage');
        return;
    }
    
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        // Get the next org_id by finding the current max
        const getMaxIdQuery = `SELECT COALESCE(MAX(org_id), 0) as max_id FROM kore_data.orgs`;
        const maxIdResult = await executeSqlQuery(
            sessionToken,
            currentUser,
            'kore_data',
            getMaxIdQuery
        );
        
        if (!maxIdResult.success) {
            window.showStatusBanner('Error determining new organization ID', 'error', 'orgsStatusMessage');
            return;
        }
        
        const newOrgId = (maxIdResult.result?.[0]?.max_id || 0) + 1;
        
        // Insert new organization with explicit org_id
        const insertOrgQuery = `INSERT INTO kore_data.orgs (org_id, org_name, inactive) VALUES (${newOrgId}, '${orgName.replace(/'/g, "''")}', ${status})`;
        
        const orgResult = await executeSqlQuery(
            sessionToken,
            currentUser,
            'kore_data',
            insertOrgQuery
        );
        
        if (!orgResult.success) {
            window.showStatusBanner('Error creating organization: ' + (orgResult.error || 'Unknown error'), 'error', 'orgsStatusMessage');
            return;
        }
        
        // Collect org_stack values from modal form
        const modalBody = document.getElementById('modal-body-content');
        console.log('Modal body at save time:', {
            modalBodyExists: modalBody ? 'YES' : 'NO',
            modalBodyHTML: modalBody?.innerHTML?.substring(0, 200),
            modalBodyChildren: modalBody?.children.length
        });
        
        const rmmTypeIdElement = document.getElementById('add_rmm_type_id');
        const rmmIdElement = document.getElementById('add_rmm_id');
        
        console.log('Form element check:', {
            rmmTypeIdElement: rmmTypeIdElement ? 'EXISTS' : 'NOT FOUND',
            rmmTypeIdValue: rmmTypeIdElement?.value,
            rmmIdElement: rmmIdElement ? 'EXISTS' : 'NOT FOUND',
            rmmIdValue: rmmIdElement?.value,
            allFormElements: document.querySelectorAll('[id^="add_"]').length
        });
        
        const rmmTypeId = document.getElementById('add_rmm_type_id')?.value || '';
        const rmmId = document.getElementById('add_rmm_id')?.value || '';
        const psaTypeId = document.getElementById('add_psa_type_id')?.value || '';
        const psaId = document.getElementById('add_psa_id')?.value || '';
        const controlTypeId = document.getElementById('add_control_type_id')?.value || '';
        const controlId = document.getElementById('add_control_id')?.value || '';
        const rpaTypeId = document.getElementById('add_rpa_type_id')?.value || '';
        const rpaId = document.getElementById('add_rpa_id')?.value || '';
        const bdrTypeId = document.getElementById('add_bdr_type_id')?.value || '';
        const bdrId = document.getElementById('add_bdr_id')?.value || '';
        
        console.log('Form values captured:', {
            rmmTypeId, rmmId,
            psaTypeId, psaId,
            controlTypeId, controlId,
            rpaTypeId, rpaId,
            bdrTypeId, bdrId
        });
        
        // Insert org_stack entry
        const insertStackQuery = `INSERT INTO kore_data.org_stack (org_id, rmm_type_id, rmm_id, psa_type_id, psa_id, control_type_id, control_id, rpa_type_id, rpa_id, bdr_type_id, bdr_id)
            VALUES (${newOrgId}, ${rmmTypeId ? rmmTypeId : 'NULL'}, ${rmmId ? `'${rmmId.replace(/'/g, "''")}'` : 'NULL'}, ${psaTypeId ? psaTypeId : 'NULL'}, ${psaId ? `'${psaId.replace(/'/g, "''")}'` : 'NULL'}, ${controlTypeId ? controlTypeId : 'NULL'}, ${controlId ? `'${controlId.replace(/'/g, "''")}'` : 'NULL'}, ${rpaTypeId ? rpaTypeId : 'NULL'}, ${rpaId ? `'${rpaId.replace(/'/g, "''")}'` : 'NULL'}, ${bdrTypeId ? bdrTypeId : 'NULL'}, ${bdrId ? `'${bdrId.replace(/'/g, "''")}'` : 'NULL'})`;
        
        console.log('Inserting org_stack with newOrgId:', newOrgId);
        console.log('org_stack INSERT query:', insertStackQuery);
        
        const stackResult = await executeSqlQuery(
            sessionToken,
            currentUser,
            'kore_data',
            insertStackQuery
        );
        
        console.log('org_stack insert result:', stackResult);
        
        if (stackResult.success) {
            window.showStatusBanner('Organization created successfully.', 'success', 'orgsStatusMessage');
            window.closeModal();
            loadOrganizationsList();
        } else {
            window.showStatusBanner('Created organization but error saving integrations: ' + (stackResult.error || 'Unknown error'), 'error', 'orgsStatusMessage');
        }
    } catch (error) {
        console.error('Error creating organization:', error);
        window.showStatusBanner('Error creating organization: ' + error.message, 'error', 'orgsStatusMessage');
    }
}

let currentOrganization = null;

function selectOrganizationFromList(orgId, buttonElement) {
    // Check if there are unsaved changes in the current organization
    if (window.hasUnsavedChanges() && currentOrganization && currentOrganization.org_id != orgId) {
        window.showUnsaved(
            async () => {
                // Save before switching
                await saveOrganizationDetails(currentOrganization.org_id);
                doSelectOrganizationFromList(orgId, buttonElement);
            },
            () => {
                // Discard changes and switch
                doSelectOrganizationFromList(orgId, buttonElement);
            }
        );
    } else {
        doSelectOrganizationFromList(orgId, buttonElement);
    }
}

function doSelectOrganizationFromList(orgId, buttonElement) {
    // Reset all buttons to theme-neutral color
    const buttons = document.querySelectorAll('#organizationListSidebar button');
    buttons.forEach(btn => {
        btn.setAttribute('data-color', 'theme-neutral');
    });
    
    // Highlight the selected button with theme-brand
    if (buttonElement) {
        buttonElement.setAttribute('data-color', 'theme-brand');
    }
    
    // Load organization details
    loadOrganizationDetails(orgId);
    window.clearUnsavedChanges();
}

function loadOrganizationDetails(orgId) {
    displayOrganizationDetails(orgId);
}

function displayOrganizationDetails(orgId) {
    displayEntityDetailsGeneric('org', orgId);
}

async function loadOrgStack(orgId) {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        const orgStack = await getOrgStack(sessionToken, currentUser, orgId);
        
        // Use cached stack types (should be loaded when tab was opened)
        if (cachedStackTypes) {
            displayOrgStack(orgStack, orgId, cachedStackTypes);
        } else {
            // Fallback: load types if cache is empty
            const [rmmTypes, psaTypes, controlTypes, rpaTypes, bdrTypes] = await Promise.all([
                getRmmTypes(sessionToken, currentUser),
                getPsaTypes(sessionToken, currentUser),
                getControlTypes(sessionToken, currentUser),
                getRpaTypes(sessionToken, currentUser),
                getBdrTypes(sessionToken, currentUser)
            ]);
            
            displayOrgStack(orgStack, orgId, {
                rmm: rmmTypes,
                psa: psaTypes,
                control: controlTypes,
                rpa: rpaTypes,
                bdr: bdrTypes
            });
        }
    } catch (error) {
        console.error('Error loading org stack:', error);
    }
}

function displayOrgStack(orgStack, orgId, stackTypes) {
    // Find the parent container of the details panel
    const detailArea = document.querySelector('#organizationsTab .panel-level-2 > div > div:last-child');
    
    if (!detailArea) {
        console.error('Detail area not found for org_stack');
        return;
    }
    
    // Helper function to build a type dropdown
    function buildTypeDropdown(label, fieldName, types, selectedTypeId, idValue) {
        const typeIdField = fieldName + '_type_id';
        const idField = fieldName + '_id';
        
        return `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                <div>
                    <label style="color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 3px; font-size: 11px;">${label} Type</label>
                    <select id="${typeIdField}" style="width: 100%; font-size: 12px;">
                        <option value="">-- Not Set --</option>
                        ${types.map(t => {
                            const typeKey = Object.keys(t).find(k => k.endsWith('_type_id'));
                            const nameKey = Object.keys(t).find(k => k.endsWith('_name'));
                            return `<option value="${t[typeKey]}" ${selectedTypeId == t[typeKey] ? 'selected' : ''}>${escapeHtml(t[nameKey])}</option>`;
                        }).join('')}
                    </select>
                </div>
                <div>
                    <label style="color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 3px; font-size: 11px;">${label} ID</label>
                    <input type="text" id="${idField}" value="${escapeHtml(String(idValue || ''))}" style="width: 100%; font-size: 12px;">
                </div>
            </div>
        `;
    }
    
    // Create the org_stack content HTML
    const stackHtml = `
        <hr style="border: none; border-top: 1px solid var(--border-primary); margin: 10px 0;">
        <h3 style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">System Integrations</h3>
        <div style="display: flex; flex-direction: column; gap: 15px;">
            ${buildTypeDropdown('RMM', 'rmm', stackTypes.rmm, orgStack?.rmm_type_id, orgStack?.rmm_id)}
            ${buildTypeDropdown('PSA', 'psa', stackTypes.psa, orgStack?.psa_type_id, orgStack?.psa_id)}
            ${buildTypeDropdown('Control', 'control', stackTypes.control, orgStack?.control_type_id, orgStack?.control_id)}
            ${buildTypeDropdown('RPA', 'rpa', stackTypes.rpa, orgStack?.rpa_type_id, orgStack?.rpa_id)}
            ${buildTypeDropdown('BDR', 'bdr', stackTypes.bdr, orgStack?.bdr_type_id, orgStack?.bdr_id)}
        </div>
    `;

    // Append inside the existing panel-level-3 pod
    const pod = detailArea.querySelector('.panel-level-3');
    if (pod) {
        pod.insertAdjacentHTML('beforeend', stackHtml);
    } else {
        detailArea.insertAdjacentHTML('beforeend', stackHtml);
    }
    
    // Add change listeners to org_stack fields for unsaved changes tracking
    ['rmm', 'psa', 'control', 'rpa', 'bdr'].forEach(integration => {
        const typeIdField = document.getElementById(integration + '_type_id');
        const idField = document.getElementById(integration + '_id');
        
        if (typeIdField) typeIdField.addEventListener('change', () => checkOrgUnsavedChanges());
        if (idField) idField.addEventListener('input', () => checkOrgUnsavedChanges());
    });
    
    // Initialize unsaved changes tracking NOW that all fields exist
    const initialOrgData = getOrgFormData();
    window.initializeUnsavedTracking(initialOrgData);
}

function getOrgFormData() {
    return {
        orgName: document.getElementById('orgNameInput')?.value || '',
        orgStatus: document.getElementById('orgStatusInput')?.checked ? '1' : '0',
        rmmTypeId: document.getElementById('rmm_type_id')?.value || '',
        rmmId: document.getElementById('rmm_id')?.value || '',
        psaTypeId: document.getElementById('psa_type_id')?.value || '',
        psaId: document.getElementById('psa_id')?.value || '',
        controlTypeId: document.getElementById('control_type_id')?.value || '',
        controlId: document.getElementById('control_id')?.value || '',
        rpaTypeId: document.getElementById('rpa_type_id')?.value || '',
        rpaId: document.getElementById('rpa_id')?.value || '',
        bdrTypeId: document.getElementById('bdr_type_id')?.value || '',
        bdrId: document.getElementById('bdr_id')?.value || ''
    };
}

function checkOrgUnsavedChanges() {
    const currentData = getOrgFormData();
    window.checkUnsavedChanges(currentData);
    
    const saveBtn = document.getElementById('saveOrgBtn');
    if (saveBtn) {
        saveBtn.disabled = !window.hasUnsavedChanges();
    }
}

async function saveOrganizationDetails(orgId) {
    const orgName = document.getElementById('orgNameInput').value;
    const status = document.getElementById('orgStatusInput').checked ? 1 : 0;
    
    // Get org_stack values
    const rmmTypeId = document.getElementById('rmm_type_id').value || 'NULL';
    const rmmId = document.getElementById('rmm_id').value || 'NULL';
    const psaTypeId = document.getElementById('psa_type_id').value || 'NULL';
    const psaId = document.getElementById('psa_id').value || 'NULL';
    const controlTypeId = document.getElementById('control_type_id').value || 'NULL';
    const controlId = document.getElementById('control_id').value || 'NULL';
    const rpaTypeId = document.getElementById('rpa_type_id').value || 'NULL';
    const rpaId = document.getElementById('rpa_id').value || 'NULL';
    const bdrTypeId = document.getElementById('bdr_type_id').value || 'NULL';
    const bdrId = document.getElementById('bdr_id').value || 'NULL';
    
    if (!orgName.trim()) {
        window.showStatusBanner('Organization name cannot be empty', 'error', 'orgsStatusMessage');
        return;
    }
    
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        // Update orgs table
        const orgQuery = `UPDATE kore_data.orgs SET org_name = '${orgName.replace(/'/g, "''")}', inactive = ${status} WHERE org_id = ${orgId}`;
        
        const orgResult = await executeSqlQuery(
            sessionToken,
            currentUser,
            'kore_data',
            orgQuery
        );
        
        if (!orgResult.success) {
            window.showStatusBanner('Error saving organization: ' + (orgResult.error || 'Unknown error'), 'error', 'orgsStatusMessage');
            return;
        }
        
        // Update org_stack table
        const stackQuery = `UPDATE kore_data.org_stack SET 
            rmm_type_id = ${rmmTypeId}, rmm_id = ${rmmId === 'NULL' ? 'NULL' : `'${rmmId.replace(/'/g, "''")}'`},
            psa_type_id = ${psaTypeId}, psa_id = ${psaId === 'NULL' ? 'NULL' : `'${psaId.replace(/'/g, "''")}'`},
            control_type_id = ${controlTypeId}, control_id = ${controlId === 'NULL' ? 'NULL' : `'${controlId.replace(/'/g, "''")}'`},
            rpa_type_id = ${rpaTypeId}, rpa_id = ${rpaId === 'NULL' ? 'NULL' : `'${rpaId.replace(/'/g, "''")}'`},
            bdr_type_id = ${bdrTypeId}, bdr_id = ${bdrId === 'NULL' ? 'NULL' : `'${bdrId.replace(/'/g, "''")}'`}
            WHERE org_id = ${orgId}`;
        
        const stackResult = await executeSqlQuery(
            sessionToken,
            currentUser,
            'kore_data',
            stackQuery
        );
        
        if (stackResult.success) {
            window.showStatusBanner('Organization saved successfully.', 'success', 'orgsStatusMessage');
            window.clearUnsavedChanges();
            
            // Update cached data
            const org = window.cachedOrganizations.find(o => o.org_id == orgId);
            if (org) {
                org.org_name = orgName;
                org.inactive = status;
            }
            // Refresh the organizations list
            loadOrganizationsList();
        } else {
            window.showStatusBanner('Error saving integrations: ' + (stackResult.error || 'Unknown error'), 'error', 'orgsStatusMessage');
        }
    } catch (error) {
        console.error('Error saving organization:', error);
        window.showStatusBanner('Error saving organization: ' + error.message, 'error', 'orgsStatusMessage');
    }
}

function cancelOrganizationEdit(orgId) {
    // Check if there are unsaved changes
    if (window.hasUnsavedChanges()) {
        window.showUnsaved(
            () => {
                // Save
                saveOrganizationDetails(orgId);
            },
            () => {
                // Discard changes
                window.clearUnsavedChanges();
                displayOrganizationDetails(orgId);
            }
        );
    } else {
        // No changes, just reload
        displayOrganizationDetails(orgId);
    }
}


function switchTabWithUnsavedCheck(tabName, event, loadCallback) {
    if (window.hasUnsavedChanges()) {
        window.showUnsaved(
            async () => {
                // Save current tab
                const activeTab = document.querySelector('.tab-btn.active');
                if (activeTab && activeTab.textContent.includes('General')) {
                    if (currentEmailProfile) {
                        await saveEmailProfile();
                    } else if (currentSystemConfig || document.getElementById('systemTimezone')?.value) {
                        await saveSystemConfig();
                    } else if (currentLoggingConfig) {
                        await saveLoggingConfig();
                    }
                } else if (activeTab && activeTab.textContent.includes('Organization')) {
                    if (currentOrganization?.org_id) {
                        await saveOrganizationDetails(currentOrganization.org_id);
                    }
                } else if (activeTab && activeTab.textContent.includes('Security')) {
                    await saveSecuritySettings();
                } else if (activeTab && activeTab.textContent.includes('User')) {
                    // Users tab doesn't have typical unsaved changes, but check anyway
                }
                // Then switch tab
                switchTab(tabName, event);
                if (loadCallback) loadCallback();
            },
            () => {
                // Discard and switch
                switchTab(tabName, event);
                if (loadCallback) loadCallback();
            }
        );
    } else {
        switchTab(tabName, event);
        if (loadCallback) loadCallback();
    }
}

function switchToPluginsTab(event) {
    switchTabWithUnsavedCheck('pluginsTab', event, loadPluginsList);
}

function switchToUtilitiesTab(event) {
    switchTabWithUnsavedCheck('utilitiesTab', event, loadSystemHealth);
}

/**
 * Load and display system health information
 */
async function loadSystemHealth() {
    try {
        const response = await fetch('/kore/admin/system-health');
        const data = await response.json();
        
        if (data.status === 'success') {
            // Update uptime
            document.getElementById('healthUptime').textContent = data.uptime.formatted;
            
            // Store the base uptime in seconds for the ticker
            window.baseUptimeSeconds = data.uptime.seconds;
            window.lastUptimeUpdateTime = Date.now();
            
            // Start or restart the uptime ticker
            if (window.uptimeTicker) {
                clearInterval(window.uptimeTicker);
            }
            startUptimeTicker();
            
            // Update Kore version
            document.getElementById('healthKoreVersion').textContent = `v${data.koreVersion}`;
            
            // Update Node version
            document.getElementById('healthNodeVersion').textContent = data.nodeVersion;
            
            // Update memory
            const memoryText = `${data.memory.heapUsedMB} MB / ${data.memory.heapTotalMB} MB`;
            document.getElementById('healthMemory').textContent = memoryText;
            
            // Update modules
            document.getElementById('healthModules').textContent = data.modules.count.toString();
            
            // Update subsystems
            document.getElementById('healthResources').textContent = `${data.subsystems.resources.status} (v${data.subsystems.resources.version})`;
            document.getElementById('healthAuth').textContent = `${data.subsystems.auth.status} (v${data.subsystems.auth.version})`;
            document.getElementById('healthWeb').textContent = `${data.subsystems.web.status} (v${data.subsystems.web.version})`;
            document.getElementById('healthPersephone').textContent = `${data.subsystems.persephone.status} (v${data.subsystems.persephone.version})`;
            
            // Update database
            document.getElementById('healthDatabase').textContent = data.database.korePool;
        } else {
            console.error('Failed to load system health:', data.message);
        }
    } catch (error) {
        console.error('Error loading system health:', error);
    }
}

/**
 * Start the uptime ticker - increments uptime every second
 */
function startUptimeTicker() {
    window.uptimeTicker = setInterval(() => {
        if (window.baseUptimeSeconds !== undefined) {
            const elapsedMs = Date.now() - window.lastUptimeUpdateTime;
            const elapsedSeconds = Math.floor(elapsedMs / 1000);
            const currentUptimeSeconds = window.baseUptimeSeconds + elapsedSeconds;
            
            // Format uptime string
            const days = Math.floor(currentUptimeSeconds / 86400);
            const hours = Math.floor((currentUptimeSeconds % 86400) / 3600);
            const minutes = Math.floor((currentUptimeSeconds % 3600) / 60);
            const seconds = currentUptimeSeconds % 60;
            
            let uptimeString = '';
            if (days > 0) uptimeString += `${days}d `;
            if (hours > 0) uptimeString += `${hours}h `;
            if (minutes > 0) uptimeString += `${minutes}m `;
            uptimeString += `${seconds}s`;
            
            document.getElementById('healthUptime').textContent = uptimeString;
        }
    }, 1000);
}

/**
 * Show modules list in a modal
 */
async function showModulesModal() {
    try {
        const response = await fetch('/kore/admin/system-health/modules');
        const data = await response.json();
        
        if (data.status === 'success') {
            // Create HTML table for modules
            let modulesHTML = `
                <div style="font-size: 12px;">
                    <p style="margin: 0 0 10px 0; color: var(--text-muted);">
                        Base Modules: <span style="color: var(--text-primary); font-weight: 600;">${data.totalBaseModules}</span> | 
                        Total Loaded Files: <span style="color: var(--text-primary); font-weight: 600;">${data.totalLoadedFiles}</span>
                    </p>
                    <div style="max-height: 400px; overflow-y: auto; border: 1px solid var(--border-primary); border-radius: 4px;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tbody>
            `;
            
            data.modules.forEach((module, index) => {
                const bgColor = index % 2 === 0 ? 'transparent' : 'rgba(0, 0, 0, 0.1)';
                // Convert forward slashes to backslashes in the path
                const displayPath = module.path.replace(/\//g, '\\');
                modulesHTML += `
                    <tr style="background-color: ${bgColor};">
                        <td style="padding: 6px; border-bottom: 1px solid var(--border-primary); word-break: break-all; color: var(--text-primary);">
                            ${module.name} <span style="color: var(--text-muted);">- ${displayPath}</span>
                        </td>
                    </tr>
                `;
            });
            
            modulesHTML += `
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
            
            showModal({
                title: 'Loaded Modules',
                content: modulesHTML,
                buttons: [
                    {
                        label: 'Close',
                        type: 'secondary',
                        onClick: () => {}
                    }
                ]
            });
        } else {
            showModal({
                title: 'Error',
                content: `<p style="color: var(--text-primary);">Failed to load modules list: ${data.message}</p>`,
                buttons: [
                    {
                        label: 'Close',
                        type: 'secondary',
                        onClick: () => {}
                    }
                ]
            });
        }
    } catch (error) {
        console.error('Error fetching modules:', error);
        showModal({
            title: 'Error',
            content: `<p style="color: var(--text-primary);">Error: ${error.message}</p>`,
            buttons: [
                {
                    label: 'Close',
                    type: 'secondary',
                    onClick: () => {}
                }
            ]
        });
    }
}

/**
 * Refresh system health data
 */
async function refreshSystemHealth() {
    await loadSystemHealth();
}

/**
 * Show confirmation modal before restarting a subsystem
 */
function confirmRestartSubsystem(subsystem, buttonLabel) {
    const confirmMessage = 'This will restart the subsystem and may disrupt any current actions taking place. Are you sure you want to continue?';
    showConfirm(buttonLabel, confirmMessage, () => {
        restartSubsystem(subsystem);
    }, 'Restart');
}

/**
 * Restart a subsystem (resources, auth, web, persephone, or all)
 */
async function restartSubsystem(subsystem) {
    try {
        const statusMessage = document.getElementById('utilitiesStatusMessage');
        if (!statusMessage) return;
        
        // Show loading state
        statusMessage.innerHTML = `<div class="alert alert-info">Restarting ${subsystem === 'all' ? 'all subsystems' : subsystem + ' subsystem'}...</div>`;
        statusMessage.style.display = 'block';
        
        // Make the reload request
        const response = await fetch(`/kore/admin/reload-subsystem?subsystem=${subsystem}`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (response.ok) {
            statusMessage.innerHTML = `<div class="alert alert-success">${data.message}</div>`;
        } else {
            statusMessage.innerHTML = `<div class="alert alert-error">${data.message || 'Failed to restart subsystem'}</div>`;
        }
        
        // Auto-hide message after 5 seconds
        setTimeout(() => {
            statusMessage.style.display = 'none';
        }, 5000);
        
    } catch (error) {
        console.error('Error restarting subsystem:', error);
        const statusMessage = document.getElementById('utilitiesStatusMessage');
        if (statusMessage) {
            statusMessage.innerHTML = `<div class="alert alert-error">Error: ${error.message}</div>`;
            statusMessage.style.display = 'block';
        }
    }
}

function switchToOrganizationsTab(event) {
    switchTabWithUnsavedCheck('organizationsTab', event, () => {
        loadOrganizationsList();
        loadAndCacheStackTypes();
    });
}

let cachedStackTypes = null;

async function loadAndCacheStackTypes() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        // Only load if not already cached
        if (cachedStackTypes) {
            return;
        }
        
        const [rmmTypes, psaTypes, controlTypes, rpaTypes, bdrTypes] = await Promise.all([
            getRmmTypes(sessionToken, currentUser),
            getPsaTypes(sessionToken, currentUser),
            getControlTypes(sessionToken, currentUser),
            getRpaTypes(sessionToken, currentUser),
            getBdrTypes(sessionToken, currentUser)
        ]);
        
        cachedStackTypes = {
            rmm: rmmTypes,
            psa: psaTypes,
            control: controlTypes,
            rpa: rpaTypes,
            bdr: bdrTypes
        };
    } catch (error) {
        console.error('Error caching stack types:', error);
    }
}

// ============================================================================
// EMAIL CONFIGURATION FUNCTIONS
// ============================================================================

let currentEmailConfig = null;
let currentEmailProfile = null;

async function loadEmailConfig() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        const result = await executeSqlQuery(
            sessionToken, 
            currentUser, 
            'kore_sys', 
            'SELECT email_config FROM system_config'
        );
        
        console.log('Email config query result:', result);
        console.log('result.result:', result.result);
        
        if (result && result.result && result.result.length > 0) {
            const configRow = result.result[0];
            console.log('configRow:', configRow);
            
            if (configRow.email_config) {
                currentEmailConfig = typeof configRow.email_config === 'string' 
                    ? JSON.parse(configRow.email_config) 
                    : configRow.email_config;
            } else {
                console.log('email_config is null, creating empty config');
                currentEmailConfig = { smtp_profiles: [] };
            }
        } else {
            console.log('No email config found, creating empty config');
            currentEmailConfig = { smtp_profiles: [] };
        }
        
        console.log('currentEmailConfig:', currentEmailConfig);
        populateEmailProfileDropdown();
    } catch (error) {
        console.error('Error loading email config:', error);
        window.showStatusBanner('Error loading email configuration: ' + error.message, 'error', 'generalStatusMessage');
    }
}

function populateEmailProfileDropdown() {
    const select = document.getElementById('emailProfileSelect');
    select.innerHTML = '<option value="">Select a profile...</option>';
    
    console.log('Populating dropdown, currentEmailConfig:', currentEmailConfig);
    
    if (currentEmailConfig && currentEmailConfig.smtp_profiles && currentEmailConfig.smtp_profiles.length > 0) {
        currentEmailConfig.smtp_profiles.forEach(profile => {
            const option = document.createElement('option');
            option.value = profile.profile_name;
            option.textContent = profile.profile_name;
            select.appendChild(option);
        });
    } else {
        console.log('No profiles found in currentEmailConfig');
    }
}

function switchEmailProfile() {
    const profileName = document.getElementById('emailProfileSelect').value;
    
    if (!profileName) {
        // Deselect - hide form
        document.getElementById('emailProfileForm').style.display = 'none';
        currentEmailProfile = null;
        window.clearUnsavedChanges();
        return;
    }
    
    // Check for unsaved changes
    if (currentEmailProfile && window.hasUnsavedChanges()) {
        window.showUnsaved(
            async () => {
                // Save before switching
                await saveEmailProfile();
                loadEmailProfile(profileName);
            },
            () => {
                // Discard and switch
                loadEmailProfile(profileName);
            }
        );
    } else {
        loadEmailProfile(profileName);
    }
}

function loadEmailProfile(profileName) {
    const profile = currentEmailConfig.smtp_profiles.find(p => p.profile_name === profileName);
    
    if (profile) {
        currentEmailProfile = profileName;
        document.getElementById('emailSmtpHost').value = profile.smtp_host || '';
        document.getElementById('emailSmtpPort').value = profile.smtp_port || '';
        document.getElementById('emailSmtpUseTls').checked = profile.smtp_use_tls || false;
        document.getElementById('emailSmtpUsername').value = profile.smtp_username || '';
        document.getElementById('emailSmtpPassword').value = profile.smtp_password || '';
        document.getElementById('emailSmtpFrom').value = profile.smtp_from || '';
        
        document.getElementById('emailProfileForm').style.display = 'block';
        
        // Initialize unsaved changes tracking with current profile data
        const profileData = {
            smtp_host: profile.smtp_host || '',
            smtp_port: profile.smtp_port || '',
            smtp_use_tls: profile.smtp_use_tls || false,
            smtp_username: profile.smtp_username || '',
            smtp_password: profile.smtp_password || '',
            smtp_from: profile.smtp_from || ''
        };
        window.initializeUnsavedTracking(profileData);
        document.getElementById('emailSaveBtn').disabled = true;
    }
}

function getEmailFormData() {
    return {
        smtp_host: document.getElementById('emailSmtpHost').value,
        smtp_port: document.getElementById('emailSmtpPort').value,
        smtp_use_tls: document.getElementById('emailSmtpUseTls').checked,
        smtp_username: document.getElementById('emailSmtpUsername').value,
        smtp_password: document.getElementById('emailSmtpPassword').value,
        smtp_from: document.getElementById('emailSmtpFrom').value
    };
}

function checkEmailUnsavedChanges() {
    const currentData = getEmailFormData();
    window.checkUnsavedChanges(currentData);
    
    const saveBtn = document.getElementById('emailSaveBtn');
    if (saveBtn) {
        saveBtn.disabled = !window.hasUnsavedChanges();
    }
}

async function saveEmailProfile() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        if (!currentEmailProfile) {
            window.showStatusBanner('No profile selected', 'error', 'generalStatusMessage');
            return;
        }
        
        const formData = getEmailFormData();
        const profileIndex = currentEmailConfig.smtp_profiles.findIndex(p => p.profile_name === currentEmailProfile);
        
        if (profileIndex !== -1) {
            // Update existing profile
            currentEmailConfig.smtp_profiles[profileIndex] = {
                profile_name: currentEmailProfile,
                ...formData
            };
        }
        
        // Save to system_config using SQL
        const emailConfigJson = JSON.stringify(currentEmailConfig);
        const escapedJson = emailConfigJson.replace(/'/g, "''");
        const updateSql = `UPDATE system_config SET email_config = '${escapedJson}'`;
        
        await executeSqlQuery(sessionToken, currentUser, 'kore_sys', updateSql);
        
        // Reinitialize unsaved tracking with the saved data
        window.initializeUnsavedTracking(formData);
        const emailSaveBtn = document.getElementById('emailSaveBtn');
        if (emailSaveBtn) {
            emailSaveBtn.disabled = true;
        }
        window.showStatusBanner('Email profile saved successfully', 'success', 'generalStatusMessage');
    } catch (error) {
        console.error('Error saving email profile:', error);
        window.showStatusBanner('Error saving email profile: ' + error.message, 'error', 'generalStatusMessage');
    }
}

function addNewEmailProfile() {
    // Check for unsaved changes on current profile
    if (currentEmailProfile && window.hasUnsavedChanges()) {
        window.showUnsaved(
            async () => {
                await saveEmailProfile();
                showNewProfileDialog();
            },
            () => {
                showNewProfileDialog();
            }
        );
    } else {
        showNewProfileDialog();
    }
}

function showNewProfileDialog() {
    window.showFormModal('Create New Email Profile', [
        {
            type: 'text',
            name: 'profileName',
            label: 'Profile Name',
            placeholder: 'e.g., default, gmail, office365',
            value: '',
            required: true
        }
    ], async (formData) => {
        const profileName = document.getElementById('field_profileName').value.trim();
        
        if (!profileName) {
            window.showAlert('Validation Error', 'Profile name is required');
            return;
        }
        
        // Check if profile already exists
        if (currentEmailConfig.smtp_profiles.some(p => p.profile_name === profileName)) {
            window.showAlert('Validation Error', 'A profile with this name already exists');
            return;
        }
        
        // Add new profile
        currentEmailConfig.smtp_profiles.push({
            profile_name: profileName,
            smtp_host: '',
            smtp_port: 587,
            smtp_use_tls: true,
            smtp_username: '',
            smtp_password: '',
            smtp_from: ''
        });
        
        populateEmailProfileDropdown();
        document.getElementById('emailProfileSelect').value = profileName;
        loadEmailProfile(profileName);
    });
}

function deleteEmailProfile() {
    if (!currentEmailProfile) {
        window.showAlert('Error', 'No profile selected');
        return;
    }
    
    window.showDeleteConfirm(
        `Are you sure you want to delete the email profile "${currentEmailProfile}"?`,
        async () => {
            try {
                if (!sessionToken) {
                    sessionToken = await getSessionToken();
                }
                
                
                // Remove profile from config
                currentEmailConfig.smtp_profiles = currentEmailConfig.smtp_profiles.filter(p => p.profile_name !== currentEmailProfile);
                
                // Save updated config using SQL
                const emailConfigJson = JSON.stringify(currentEmailConfig);
                const escapedJson = emailConfigJson.replace(/'/g, "''");
                const updateSql = `UPDATE system_config SET email_config = '${escapedJson}'`;
                
                await executeSqlQuery(sessionToken, currentUser, 'kore_sys', updateSql);
                
                currentEmailProfile = null;
                window.clearUnsavedChanges();
                document.getElementById('emailProfileForm').style.display = 'none';
                document.getElementById('emailProfileSelect').value = '';
                populateEmailProfileDropdown();
                window.showStatusBanner('Email profile deleted successfully', 'success', 'generalStatusMessage');
            } catch (error) {
                console.error('Error deleting email profile:', error);
                window.showStatusBanner('Error deleting email profile: ' + error.message, 'error', 'generalStatusMessage');
            }
        }
    );
}

function testEmailSmtp() {
    if (!currentEmailProfile) {
        window.showAlert('Error', 'No profile selected');
        return;
    }
    
    const modalContent = `
        <div style="display: flex; flex-direction: column; gap: 10px;">
            <div>
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Send Test Email To</label>
                <input type="email" id="testEmailInput" placeholder="recipient@example.com" style="width: 100%; padding: 6px; background-color: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 4px; color: var(--text-primary);">
            </div>
            <div id="sendingIndicator" style="display: none; text-align: center; color: var(--text-muted); font-size: 12px; padding: 10px 0;">
                <div style="display: inline-flex; align-items: center; gap: 8px;">
                    <span style="display: inline-block; width: 8px; height: 8px; background-color: var(--brand-light); border-radius: 50%; animation: pulse 1.5s infinite;"></span>
                    Sending...
                </div>
            </div>
        </div>
        <style>
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
        </style>
    `;
    
    window.showModal({
        title: 'Test Email',
        content: modalContent,
        closeOnBackdrop: false,
        buttons: [
            { 
                label: 'Cancel', 
                type: 'secondary', 
                onClick: () => {} 
            },
            { 
                label: 'Send', 
                type: 'success', 
                onClick: async () => {
                    const testEmail = document.getElementById('testEmailInput').value.trim();
                    
                    if (!testEmail) {
                        window.showAlert('Validation Error', 'Email address is required');
                        return;
                    }
                    
                    try {
                        // Show sending indicator and disable input
                        document.getElementById('sendingIndicator').style.display = 'block';
                        document.getElementById('testEmailInput').disabled = true;
                        
                        // Disable Send button
                        const buttons = document.querySelectorAll('.modal-footer button');
                        const sendBtn = Array.from(buttons).find(btn => btn.textContent.trim() === 'Send');
                        if (sendBtn) sendBtn.disabled = true;
                        
                        if (!sessionToken) {
                            sessionToken = await getSessionToken();
                        }
                        
                        const profile = currentEmailConfig.smtp_profiles.find(p => p.profile_name === currentEmailProfile);
                        
                        if (!profile) {
                            window.showAlert('Error', 'Profile not found');
                            return;
                        }
                        
                        // Send test email
                        const response = await window.emailSmtp(
                            sessionToken,
                            testEmail,
                            'Test Email',
                            '<h2>Test Email</h2><p>This is a test email from Kore System Settings.</p>',
                            'Test Email from Kore System Settings.',
                            profile.smtp_from || profile.smtp_username,
                            null,
                            null,
                            currentEmailProfile
                        );
                        
                        // Close modal and show success banner
                        window.closeModal();
                        window.showStatusBanner('Test email sent successfully to ' + testEmail, 'success', 'generalStatusMessage');
                    } catch (error) {
                        console.error('Error sending test email:', error);
                        
                        // Reset UI - hide indicator, re-enable controls
                        const sendingDiv = document.getElementById('sendingIndicator');
                        if (sendingDiv) sendingDiv.style.display = 'none';
                        
                        const emailInput = document.getElementById('testEmailInput');
                        if (emailInput) emailInput.disabled = false;
                        
                        const buttons = document.querySelectorAll('.modal-footer button');
                        const sendBtn = Array.from(buttons).find(btn => btn.textContent.trim() === 'Send');
                        if (sendBtn) sendBtn.disabled = false;
                        
                        // Close modal and show error banner
                        window.closeModal();
                        window.showStatusBanner('Failed to send test email: ' + error.message, 'error', 'generalStatusMessage');
                    }
                }
            }
        ]
    });
}

// ============================================================================
// LOGGING CONFIGURATION FUNCTIONS
// ============================================================================

let currentLoggingConfig = null;

async function loadLoggingConfig() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        const result = await executeSqlQuery(
            sessionToken, 
            currentUser, 
            'kore_sys', 
            'SELECT logging_config FROM system_config'
        );
        
        if (result && result.result && result.result.length > 0) {
            const configRow = result.result[0];
            
            if (configRow.logging_config) {
                currentLoggingConfig = typeof configRow.logging_config === 'string' 
                    ? JSON.parse(configRow.logging_config) 
                    : configRow.logging_config;
            } else {
                currentLoggingConfig = { 
                    log_level: 'INFO',
                    retention_days: 30,
                    log_destinations: ['file', 'database'],
                    max_file_size_mb: 100,
                    file_path: '/var/log/kore/system.log'
                };
            }
        } else {
            currentLoggingConfig = { 
                log_level: 'INFO',
                retention_days: 30,
                log_destinations: ['file', 'database'],
                max_file_size_mb: 100,
                file_path: '/var/log/kore/system.log'
            };
        }
        
        populateLoggingFields();
        window.initializeUnsavedTracking(getLoggingFormData());
    } catch (error) {
        console.error('Error loading logging config:', error);
        window.showStatusBanner('Error loading logging configuration: ' + error.message, 'error', 'generalStatusMessage');
    }
}

function populateLoggingFields() {
    if (!currentLoggingConfig) return;
    
    document.getElementById('loggingLogLevel').value = currentLoggingConfig.log_level || 'INFO';
    document.getElementById('loggingRetentionDays').value = currentLoggingConfig.retention_days || 30;
    document.getElementById('loggingMaxFileSize').value = currentLoggingConfig.max_file_size_mb || 100;
    document.getElementById('loggingFilePath').value = currentLoggingConfig.file_path || '';
    
    // Set checkboxes based on destinations
    const destinations = currentLoggingConfig.log_destinations || [];
    document.getElementById('loggingDestFile').checked = destinations.includes('file');
    document.getElementById('loggingDestDatabase').checked = destinations.includes('database');
}

function getLoggingFormData() {
    const destinations = [];
    if (document.getElementById('loggingDestFile').checked) destinations.push('file');
    if (document.getElementById('loggingDestDatabase').checked) destinations.push('database');
    
    return {
        log_level: document.getElementById('loggingLogLevel').value,
        retention_days: parseInt(document.getElementById('loggingRetentionDays').value) || 30,
        log_destinations: destinations,
        max_file_size_mb: parseInt(document.getElementById('loggingMaxFileSize').value) || 100,
        file_path: document.getElementById('loggingFilePath').value
    };
}

function checkLoggingUnsavedChanges() {
    const currentData = getLoggingFormData();
    window.checkUnsavedChanges(currentData);
    
    const saveBtn = document.getElementById('loggingSaveBtn');
    if (saveBtn) {
        saveBtn.disabled = !window.hasUnsavedChanges();
    }
}

async function saveLoggingConfig() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        const formData = getLoggingFormData();
        currentLoggingConfig = formData;
        
        // Save to system_config using SQL
        const loggingConfigJson = JSON.stringify(currentLoggingConfig);
        const escapedJson = loggingConfigJson.replace(/'/g, "''");
        const updateSql = `UPDATE system_config SET logging_config = '${escapedJson}'`;
        
        await executeSqlQuery(sessionToken, currentUser, 'kore_sys', updateSql);
        
        // Reinitialize unsaved tracking with the saved data
        window.initializeUnsavedTracking(formData);
        checkLoggingUnsavedChanges();
        window.showStatusBanner('Logging configuration saved successfully', 'success', 'generalStatusMessage');
    } catch (error) {
        console.error('Error saving logging config:', error);
        window.showStatusBanner('Error saving logging configuration: ' + error.message, 'error', 'generalStatusMessage');
    }
}

// ============================================================================
// SYSTEM CONFIGURATION FUNCTIONS
// ============================================================================

let currentSystemConfig = null;

// List of common timezones
const TIMEZONES = [
    'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'Europe/Madrid', 'Europe/Rome', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata',
    'Asia/Bangkok', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
    'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Pacific/Auckland'
];

async function loadSystemConfig() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        const result = await executeSqlQuery(
            sessionToken, 
            currentUser, 
            'kore_sys', 
            'SELECT timezone, whitelists FROM system_config'
        );
        
        if (result && result.result && result.result.length > 0) {
            const configRow = result.result[0];
            currentSystemConfig = {
                timezone: configRow.timezone || 'UTC',
                whitelists: configRow.whitelists || '{}'
            };
        } else {
            currentSystemConfig = { timezone: 'UTC', whitelists: '{}' };
        }
        
        populateTimezoneSelect();
        await displayInternalWhitelist();
        
        // Initialize unsaved tracking after both fields are set in the DOM
        setTimeout(() => {
            window.initializeUnsavedTracking(getSystemFormData());
            document.getElementById('systemSaveBtn').disabled = true;
        }, 0);
    } catch (error) {
        console.error('Error loading system config:', error);
        window.showStatusBanner('Error loading system configuration: ' + error.message, 'error', 'generalStatusMessage');
    }
}

function populateTimezoneSelect() {
    const select = document.getElementById('systemTimezone');
    select.innerHTML = '<option value="">Select timezone...</option>';
    
    TIMEZONES.forEach(tz => {
        const option = document.createElement('option');
        option.value = tz;
        option.textContent = tz;
        select.appendChild(option);
    });
    
    if (currentSystemConfig && currentSystemConfig.timezone) {
        select.value = currentSystemConfig.timezone;
    }
}

function getSystemFormData() {
    const formData = {
        timezone: document.getElementById('systemTimezone').value || 'UTC',
        internalWhitelistIPs: []
    };
    
    // Collect internal whitelist IPs
    const ipInputs = document.querySelectorAll('#systemInternalWhitelistContainer .ip-input');
    ipInputs.forEach(input => {
        const value = input.value.trim();
        if (value) {
            formData.internalWhitelistIPs.push(value);
        }
    });
    
    return formData;
}

/**
 * Display the Internal Whitelist IPs form
 */
async function displayInternalWhitelist() {
    const container = document.getElementById('systemInternalWhitelistContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Parse whitelists from system config
    let internalIPs = [];
    try {
        const whitelists = typeof currentSystemConfig.whitelists === 'string' 
            ? JSON.parse(currentSystemConfig.whitelists) 
            : currentSystemConfig.whitelists;
        
        internalIPs = whitelists.internal || [];
    } catch (e) {
        console.warn('Could not parse whitelists:', e);
    }
    
    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
    
    // Header row with label and Add button
    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 12px;';
    
    const label = document.createElement('label');
    label.style.cssText = 'color: var(--text-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin: 0;';
    label.textContent = 'Internal Whitelist IPs';
    headerRow.appendChild(label);
    
    // Add button
    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add IP';
    addBtn.className = 'btn';
    addBtn.setAttribute('data-color', 'blue');
    addBtn.setAttribute('data-size', 'sm');
    headerRow.appendChild(addBtn);
    
    wrapper.appendChild(headerRow);
    
    // IPs container
    const ipsContainer = document.createElement('div');
    ipsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';
    
    // Add existing IPs
    internalIPs.forEach(ip => {
        addIPFieldToSystemWhitelist(ipsContainer, ip);
    });
    
    // Add button handler
    addBtn.onclick = () => {
        addIPFieldToSystemWhitelist(ipsContainer, '');
        checkSystemUnsavedChanges();
    };
    
    wrapper.appendChild(ipsContainer);
    container.appendChild(wrapper);
    
    // Set up change detection for IP fields
    const ipInputs = container.querySelectorAll('.ip-input');
    ipInputs.forEach(input => {
        input.addEventListener('input', checkSystemUnsavedChanges);
    });
    
    // Set up delete button detection
    const deleteButtons = container.querySelectorAll('.btn[data-color="red"]');
    deleteButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            setTimeout(checkSystemUnsavedChanges, 10);
        });
    });
}

/**
 * Helper to add an IP field to the system whitelist form
 */
function addIPFieldToSystemWhitelist(container, ipValue = '') {
    const fieldDiv = document.createElement('div');
    fieldDiv.style.cssText = 'display: flex; gap: 6px; align-items: center;';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ip-input';
    input.value = ipValue;
    input.placeholder = 'e.g., 192.168.1.0/24';
    input.style.cssText = `
        flex: 1;
        padding: 6px 8px;
        border: 1px solid var(--border-primary);
        border-radius: 4px;
        background-color: var(--bg-input);
        color: var(--text-primary);
        font-family: monospace;
        font-size: 12px;
        box-sizing: border-box;
    `;

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'btn';
    deleteBtn.setAttribute('data-color', 'red');
    deleteBtn.setAttribute('data-size', 'sm');
    deleteBtn.style.cssText = 'flex: 0 0 auto; width: 60px;';
    deleteBtn.onclick = () => {
        fieldDiv.remove();
        checkSystemUnsavedChanges();
    };

    fieldDiv.appendChild(input);
    fieldDiv.appendChild(deleteBtn);
    container.appendChild(fieldDiv);
}

function checkSystemUnsavedChanges() {
    const currentData = getSystemFormData();
    window.checkUnsavedChanges(currentData);
    
    const saveBtn = document.getElementById('systemSaveBtn');
    if (saveBtn) {
        saveBtn.disabled = !window.hasUnsavedChanges();
    }
}

async function saveSystemConfig() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        const formData = getSystemFormData();
        
        // Build the whitelists JSON
        let whitelists = {};
        try {
            const existing = typeof currentSystemConfig.whitelists === 'string'
                ? JSON.parse(currentSystemConfig.whitelists)
                : currentSystemConfig.whitelists;
            whitelists = existing || {};
        } catch (e) {
            whitelists = {};
        }
        
        // Update internal whitelist
        whitelists.internal = formData.internalWhitelistIPs;
        const whitelistsJson = JSON.stringify(whitelists);
        const escapedJson = whitelistsJson.replace(/'/g, "''");
        
        // Save to system_config using SQL
        const updateSql = `UPDATE system_config SET timezone = '${formData.timezone}', whitelists = '${escapedJson}'`;
        
        await executeSqlQuery(sessionToken, currentUser, 'kore_sys', updateSql);
        
        // Update current config
        currentSystemConfig.timezone = formData.timezone;
        currentSystemConfig.whitelists = whitelistsJson;
        
        // Reinitialize unsaved tracking with the saved data
        window.initializeUnsavedTracking(formData);
        checkSystemUnsavedChanges();
        
        window.showStatusBanner('System configuration saved successfully', 'success', 'generalStatusMessage');
    } catch (error) {
        console.error('Error saving system config:', error);
        window.showStatusBanner('Error saving system configuration: ' + error.message, 'error', 'generalStatusMessage');
    }
}

// Initialize on module load
(async () => {
    try {
        // Small delay to ensure DOM is ready
        await new Promise(resolve => setTimeout(resolve, 100));
        
        currentUser = getUser();
        
        // Load system, email and logging config when General tab is active (only if on /settings page)
        if (document.getElementById('systemTimezone')) {
            await window.loadSystemConfig();
        }
        
        if (document.getElementById('emailProfileSelect')) {
            await window.loadEmailConfig();
        }
        if (document.getElementById('loggingLogLevel')) {
            await window.loadLoggingConfig();
        }
    } catch (err) {
        console.error('Error initializing settings:', err);
    }
})();

document.addEventListener('DOMContentLoaded', () => {
    // Don't load organizations on page load - load them when tab is opened
    
    
    
    // Setup page-level unsaved changes protection (browser alert only for out-of-page navigation)
    window.addEventListener('beforeunload', (e) => {
        if (window.hasUnsavedChanges()) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
});
async function showAddUserModal() {
    const modalHtml = `
        <div style="display: flex; flex-direction: column; gap: 15px; min-height: 0;">
            <div>
                <label style="color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 3px; font-size: 11px;">Email Address</label>
                <input type="email" id="add_userEmail" style="width: 100%; font-size: 12px;" placeholder="user@example.com">
            </div>
            
            <div>
                <label style="color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 3px; font-size: 11px;">Full Name</label>
                <input type="text" id="add_userFullName" style="width: 100%; font-size: 12px;" placeholder="John Doe">
            </div>
        </div>
    `;
    
    window.showFormModal('Add User', [], async () => {
        await saveNewUser();
    });
    
    // Replace modal body content with custom HTML
    const modalBody = document.getElementById('modal-body-content');
    if (modalBody) {
        modalBody.innerHTML = modalHtml;
    }
}

async function saveNewUser() {
    const email = document.getElementById('add_userEmail')?.value || '';
    const fullName = document.getElementById('add_userFullName')?.value || '';
    
    if (!email.trim()) {
        window.showStatusBanner('Email cannot be empty', 'error', 'usersStatusMessage');
        return;
    }
    
    if (!fullName.trim()) {
        window.showStatusBanner('Full name cannot be empty', 'error', 'usersStatusMessage');
        return;
    }
    
    try {
        // Get current user ID for createdBy
        const userId = sessionToken ? 'system' : 'unknown';
        
        const response = await fetch('/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: email.trim(),
                fullName: fullName.trim()
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            window.showStatusBanner('Error creating user: ' + (data.error || 'Unknown error'), 'error', 'usersStatusMessage');
            return;
        }
        
        window.showStatusBanner('User created successfully. Invitation sent to ' + email, 'success', 'usersStatusMessage');
        window.closeModal();
        loadUsersList();
        
    } catch (error) {
        console.error('Error creating user:', error);
        window.showStatusBanner('Error creating user: ' + error.message, 'error', 'usersStatusMessage');
    }
}

async function loadUsersList() {
    return loadEntityListGeneric('user', async (users) => {
        const groups = await window.getGroups(sessionToken, currentUser);
        window.cachedGroups = groups;
    });
}

async function showAddGroupModal() {
    const modalHtml = `
        <div style="display: flex; flex-direction: column; gap: 15px; min-height: 0;">
            <div>
                <label style="color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 3px; font-size: 11px;">Group Name</label>
                <input type="text" id="add_groupName" style="width: 100%; font-size: 12px;" placeholder="Group name">
            </div>
            <div>
                <label style="color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 3px; font-size: 11px;">Description</label>
                <input type="text" id="add_groupDescription" style="width: 100%; font-size: 12px;" placeholder="Optional description">
            </div>
        </div>
    `;

    window.showFormModal('Add Group', [], async () => {
        await saveNewGroup();
    });

    const modalBody = document.getElementById('modal-body-content');
    if (modalBody) modalBody.innerHTML = modalHtml;
}

async function saveNewGroup() {
    const groupName = document.getElementById('add_groupName')?.value || '';
    const description = document.getElementById('add_groupDescription')?.value || '';

    if (!groupName.trim()) {
        window.showStatusBanner('Group name cannot be empty', 'error', 'groupsStatusMessage');
        return;
    }

    try {
        const response = await fetch('/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupName: groupName.trim(), description: description.trim() })
        });

        const data = await response.json();

        if (!response.ok) {
            window.showStatusBanner('Error creating group: ' + (data.error || 'Unknown error'), 'error', 'groupsStatusMessage');
            return;
        }

        window.showStatusBanner('Group created successfully', 'success', 'groupsStatusMessage');
        window.closeModal();
        loadGroupsList();

    } catch (error) {
        console.error('Error creating group:', error);
        window.showStatusBanner('Error creating group: ' + error.message, 'error', 'groupsStatusMessage');
    }
}

async function loadGroupsList() {
    return loadEntityListGeneric('group');
}

function displayGroups(groups) {
    displayEntityListGeneric('group', groups);
}

function selectGroupFromList(groupId, buttonElement) {
    // Check if there are unsaved changes
    if (window.hasUnsavedChanges()) {
        window.showUnsaved(
            async () => {
                // Save before switching - would go here if we have editable fields
                doSelectGroupFromList(groupId, buttonElement);
            },
            () => {
                // Discard changes and switch
                doSelectGroupFromList(groupId, buttonElement);
            }
        );
    } else {
        doSelectGroupFromList(groupId, buttonElement);
    }
}

function doSelectGroupFromList(groupId, buttonElement) {
    // Reset all buttons to theme-neutral color
    const buttons = document.querySelectorAll('#groupsListSidebar button');
    buttons.forEach(btn => {
        btn.setAttribute('data-color', 'theme-neutral');
    });
    
    // Highlight the selected button with theme-brand
    if (buttonElement) {
        buttonElement.setAttribute('data-color', 'theme-brand');
    }
    
    // Load group details
    displayGroupDetails(groupId);
    window.clearUnsavedChanges();
}


function displayGroupDetails(groupId) {
    displayEntityDetailsGeneric('group', groupId);
}

function checkGroupUnsavedChanges() {
    const name = document.getElementById('groupNameInput')?.value || '';
    const description = document.getElementById('groupDescriptionInput')?.value || '';
    const active = document.getElementById('groupActiveInput')?.checked || false;
    
    const nameChanged = name !== (currentGroupDetail?.name || '');
    const activeChanged = active !== (currentGroupDetail?.active || false);
    const descriptionChanged = description !== (currentGroupDetail?.description || '');
    
    if (nameChanged || activeChanged || descriptionChanged) {
        window.checkUnsavedChanges(true);
    } else {
        window.clearUnsavedChanges();
    }
}

async function saveGroupDetails(groupId) {
    const name = document.getElementById('groupNameInput')?.value || '';
    const description = document.getElementById('groupDescriptionInput')?.value || ''; 
    const active = document.getElementById('groupActiveInput')?.checked || false;
    
    try {
        const response = await fetch(`/groups/${groupId}`, {
                                       method: 'PUT',
                                       headers: { 'Content-Type': 'application/json' },
                                       body: JSON.stringify({
                                           groupName: name.trim(),
                                           description: description.trim(),
                                           active: active
                                       })
                                   });
        
        const data = await response.json();
        
        if (!response.ok) {
            window.showStatusBanner('Error updating group: ' + (data.error || 'Unknown error'), 'error', 'groupsStatusMessage');
            return;
        }
        
        window.showStatusBanner('Group updated successfully', 'success', 'groupsStatusMessage');
        window.clearUnsavedChanges();
        loadGroupsList();
    } catch (error) {
        console.error('Error updating group:', error);
        window.showStatusBanner('Error updating group: ' + error.message, 'error', 'groupsStatusMessage');
    }
}

function cancelGroupEdit(groupId) {
    window.clearUnsavedChanges();
    displayGroupDetails(groupId);
}

// ################################
function displayUsers(users) {
    displayEntityListGeneric('user', users);
}

function selectUserFromList(userId, buttonElement) {
    // Check if there are unsaved changes
    if (window.hasUnsavedChanges() && currentUser && currentUser.userId != userId) {
        window.showUnsaved(
            async () => {
                // Save before switching - would go here if we have editable fields
                doSelectUserFromList(userId, buttonElement);
            },
            () => {
                // Discard changes and switch
                doSelectUserFromList(userId, buttonElement);
            }
        );
    } else {
        doSelectUserFromList(userId, buttonElement);
    }
}

function doSelectUserFromList(userId, buttonElement) {
    // Reset all buttons to theme-neutral color
    const buttons = document.querySelectorAll('#usersListSidebar button');
    buttons.forEach(btn => {
        btn.setAttribute('data-color', 'theme-neutral');
    });
    
    // Highlight the selected button with theme-brand
    if (buttonElement) {
        buttonElement.setAttribute('data-color', 'theme-brand');
    }
    
    // Load user details
    displayUserDetails(userId);
    window.clearUnsavedChanges();
}

function displayUserDetails(userId) {
    displayEntityDetailsGeneric('user', userId);
}

function checkUserUnsavedChanges() {
    const email = document.getElementById('userEmailInput')?.value || '';
    const fullName = document.getElementById('userFullNameInput')?.value || '';
    const active = document.getElementById('userActiveInput')?.checked || false;
    
    const emailChanged = email !== (currentUserDetail?.email || '');
    const nameChanged = fullName !== (currentUserDetail?.fullName || '');
    const activeChanged = active !== (currentUserDetail?.active || false);
    
    if (emailChanged || nameChanged || activeChanged) {
        window.checkUnsavedChanges(true);
    } else {
        window.clearUnsavedChanges();
    }
}

async function viewUserPermissions(userId) {
    const userData = window.cachedUsers?.find(u => u.userId == userId);
    const userName = userData ? (userData.fullName || userData.email || userId) : userId;

    const tableContainer = document.createElement('div');
    tableContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">Loading permissions...</p>';

    window.showModal({
        title: `Permissions - ${escapeHtml(userName)}`,
        content: tableContainer,
        resizable: true,
        width: 'auto',
        height: 'auto'
    });

    try {
        if (!sessionToken) sessionToken = await getSessionToken();
        const response = await fetch(`/kore/users/${encodeURIComponent(userId)}/permissions?includeRevoked=true`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const permissions = await response.json();

        if (!permissions.length) {
            tableContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; margin: 0;">No permissions found for this user.</p>';
            return;
        }

        const active = permissions.filter(p => !p.revokedAt);
        const revoked = permissions.filter(p => p.revokedAt);

        const buildRows = (perms, includeRevokedCol) => perms.map(p => {
            const fmt = (val) => val === '*' ? 'All' : val ? (val.charAt(0).toUpperCase() + val.slice(1)) : '—';
            const scopeVal = p.scope_name || p.scope;
            const scopeDisplay = (!scopeVal || scopeVal === '*') ? 'All' : escapeHtml(scopeVal);
            const effectColor = p.effect === 'deny' ? 'color: var(--color-red, #e55);' : 'color: var(--color-green, #5a5);';
            const sourceDisplay = p.source?.type === 'group' ? escapeHtml(`Group: ${p.source.groupName || p.source.groupId}`) : 'User';
            const revokedCell = includeRevokedCol
                ? `<td>${new Date(p.revokedAt).toLocaleString()}</td>`
                : '';
            return `<tr><td>${escapeHtml(p.resource || '—')}</td><td>${scopeDisplay}</td><td>${escapeHtml(fmt(p.action))}</td><td style="${effectColor} font-weight:600;">${escapeHtml(fmt(p.effect))}</td><td>${sourceDisplay}</td>${revokedCell}</tr>`;
        }).join('');

        const thStyle = 'text-transform:uppercase;letter-spacing:0.5px;font-size:11px;color:var(--text-muted);';
        const buildTable = (rows, includeRevokedCol) => {
            const revokedHeader = includeRevokedCol ? `<th style="${thStyle}">Revoked At</th>` : '';
            return `<div class="panel-level-2" style="width:fit-content;"><table style="font-size:11px;width:auto;"><thead><tr><th style="${thStyle}">Resource</th><th style="${thStyle}">Scope</th><th style="${thStyle}">Action</th><th style="${thStyle}">Effect</th><th style="${thStyle}">Source</th>${revokedHeader}</tr></thead><tbody>${rows}</tbody></table></div>`;
        };

        let html = '';
        if (active.length) html += `<p style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin:0 0 6px 0;">Active (${active.length})</p>` + buildTable(buildRows(active, false), false);
        if (revoked.length) html += `<p style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin:${active.length?'16px':'0'} 0 6px 0;">Revoked (${revoked.length})</p>` + buildTable(buildRows(revoked, true), true);

        tableContainer.innerHTML = html;

    } catch (error) {
        console.error('[Settings] Error loading user permissions:', error);
        tableContainer.innerHTML = `<p style="color:var(--color-red,#e55);font-size:12px;margin:0;">Error loading permissions: ${escapeHtml(error.message)}</p>`;
    }
}

async function viewGroupPermissions(groupId) {
    const groupData = window.cachedGroups?.find(g => g.groupId == groupId);
    const groupName = groupData ? (groupData.name || groupId) : groupId;

    const tableContainer = document.createElement('div');
    tableContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">Loading permissions...</p>';

    window.showModal({
        title: `Permissions - ${escapeHtml(groupName)}`,
        content: tableContainer,
        resizable: true,
        width: 'auto',
        height: 'auto'
    });

    try {
        if (!sessionToken) sessionToken = await getSessionToken();
        const response = await fetch('/kore/permissions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetType: 'group', targetId: groupId })
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const permissions = await response.json();

        if (!permissions.length) {
            tableContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; margin: 0;">No permissions found for this group.</p>';
            return;
        }

        // Sort by resource, scope, action
        permissions.sort((a, b) => {
            const r = (a.resource || '').localeCompare(b.resource || '');
            if (r !== 0) return r;
            const s = (a.scope || '').localeCompare(b.scope || '');
            if (s !== 0) return s;
            return (a.action || '').localeCompare(b.action || '');
        });

        const fmt = (val) => val === '*' ? 'All' : val ? (val.charAt(0).toUpperCase() + val.slice(1)) : '—';
        const thStyle = 'text-transform:uppercase;letter-spacing:0.5px;font-size:11px;color:var(--text-muted);';

        const rows = permissions.map(p => {
            const scopeVal = p.scope_name || p.scope;
            const scopeDisplay = (!scopeVal || scopeVal === '*') ? 'All' : escapeHtml(scopeVal);
            const effectColor = p.effect === 'deny' ? 'color: var(--color-red, #e55);' : 'color: var(--color-green, #5a5);';
            return `<tr><td>${escapeHtml(p.resource || '—')}</td><td>${scopeDisplay}</td><td>${escapeHtml(fmt(p.action))}</td><td style="${effectColor} font-weight:600;">${escapeHtml(fmt(p.effect))}</td></tr>`;
        }).join('');

        const table = `<div class="panel-level-2" style="width:fit-content;"><table style="font-size:11px;width:auto;"><thead><tr><th style="${thStyle}">Resource</th><th style="${thStyle}">Scope</th><th style="${thStyle}">Action</th><th style="${thStyle}">Effect</th></tr></thead><tbody>${rows}</tbody></table></div>`;

        tableContainer.innerHTML = table;

    } catch (error) {
        console.error('[Settings] Error loading group permissions:', error);
        tableContainer.innerHTML = `<p style="color:var(--color-red,#e55);font-size:12px;margin:0;">Error loading permissions: ${escapeHtml(error.message)}</p>`;
    }
}

async function saveUserDetails(userId) {
    const email = document.getElementById('userEmailInput')?.value || '';
    const fullName = document.getElementById('userFullNameInput')?.value || '';
    const active = document.getElementById('userActiveInput')?.checked || false;
    
    if (!email.trim()) {
        window.showStatusBanner('Email cannot be empty', 'error', 'usersStatusMessage');
        return;
    }
    
    // Collect selected groups
    const selectedGroupIds = [];
    if (window.cachedGroups) {
        window.cachedGroups.forEach(group => {
            const checkbox = document.getElementById(`group_${group.groupId}`);
            if (checkbox && checkbox.checked) {
                selectedGroupIds.push(group.groupId);
            }
        });
    }
    
    try {
        const response = await fetch(`/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: email.trim(),
                fullName: fullName.trim(),
                active: active ? 1 : 0,
                groupIds: selectedGroupIds
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            window.showStatusBanner('Error updating user: ' + (data.error || 'Unknown error'), 'error', 'usersStatusMessage');
            return;
        }
        
        window.showStatusBanner('User updated successfully', 'success', 'usersStatusMessage');
        window.clearUnsavedChanges();
        loadUsersList();
    } catch (error) {
        console.error('Error updating user:', error);
        window.showStatusBanner('Error updating user: ' + error.message, 'error', 'usersStatusMessage');
    }
}

function cancelUserEdit(userId) {
    window.clearUnsavedChanges();
    displayUserDetails(userId);
}

async function unlockUser(userId) {
    if (!confirm('Are you sure you want to unlock this user?')) return;
    
    try {
        const response = await fetch(`/admin/users/${userId}/unlock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            window.showStatusBanner('Error unlocking user: ' + (data.error || 'Unknown error'), 'error', 'usersStatusMessage');
            return;
        }
        
        window.showStatusBanner('User unlocked successfully', 'success', 'usersStatusMessage');
        loadUsersList();
    } catch (error) {
        console.error('Error unlocking user:', error);
        window.showStatusBanner('Error unlocking user: ' + error.message, 'error', 'usersStatusMessage');
    }
}

async function resetUserMFA(userId) {
    if (!confirm("Are you sure you want to reset this user's MFA? They will need to re-enroll.")) return;
    
    try {
        const response = await fetch(`/admin/users/${userId}/reset-mfa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resetBy: currentUser })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            window.showStatusBanner('Error resetting MFA: ' + (data.error || 'Unknown error'), 'error', 'usersStatusMessage');
            return;
        }
        
        window.showStatusBanner('MFA reset successfully. User will be prompted to re-enroll on next login.', 'success', 'usersStatusMessage');
        loadUsersList();
    } catch (error) {
        console.error('Error resetting MFA:', error);
        window.showStatusBanner('Error resetting MFA: ' + error.message, 'error', 'usersStatusMessage');
    }
}

async function resendUserInvite(userId) {
    if (!confirm('Resend invite to this user?')) return;
    
    try {
        const response = await fetch(`/users/${userId}/send-invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            window.showStatusBanner('Error sending invite: ' + (data.error || 'Unknown error'), 'error', 'usersStatusMessage');
            return;
        }
        
        window.showStatusBanner('Invite sent successfully', 'success', 'usersStatusMessage');
    } catch (error) {
        console.error('Error sending invite:', error);
        window.showStatusBanner('Error sending invite: ' + error.message, 'error', 'usersStatusMessage');
    }
}

function switchToUsersTab(event) {
    switchTabWithUnsavedCheck('usersTab', event, loadUsersList);
}

function switchToGroupsTab(event) {
    switchTabWithUnsavedCheck('groupsTab', event, loadGroupsList);
}

function switchToPermissionsTab(event) {
    switchTabWithUnsavedCheck('permissionsTab', event, loadPermissionsPage);
}

function switchToSecurityTab(event) {
    switchTabWithUnsavedCheck('securityTab', event, loadSecuritySettings);
}

/**
 * Load security settings from system_config
 */
async function loadSecuritySettings() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        const config = await window.getSecurityConfig(sessionToken, currentUser);
        
        if (!config) {
            window.showStatusBanner('Error loading security settings', 'error', 'securityStatusMessage');
            return;
        }

        // Populate form fields
        document.getElementById('passwordMinLength').value = config.password.minLength;
        document.getElementById('passwordRequireUppercase').checked = config.password.requireUppercase;
        document.getElementById('passwordRequireNumbersOrSpecial').checked = config.password.requireNumbersOrSpecial;
        document.getElementById('passwordFailureLimit').value = config.password.failureLimit;
        document.getElementById('passwordFailureResetMinutes').value = config.password.failureResetMinutes;
        document.getElementById('passwordHistoryCount').value = config.password.historyCount || 0;
        document.getElementById('passwordOldPwdAge').value = config.password.oldPwdAge || 90;

        document.getElementById('mfaFailureLimit').value = config.mfa.failureLimit;
        document.getElementById('mfaFailureResetMinutes').value = config.mfa.failureResetMinutes;
        document.getElementById('mfaBackupCodeCount').value = config.mfa.backupCodeCount;
        document.getElementById('mfaCodeValiditySeconds').value = config.mfa.codeValiditySeconds;
        document.getElementById('mfaAllowedClockSkew').value = config.mfa.allowedClockSkew;

        document.getElementById('lockoutDurationMinutes').value = config.lockout.durationMinutes;
        document.getElementById('lockoutAutoUnlock').checked = config.lockout.autoUnlock;

        document.getElementById('inviteExpirationHours').value = config.invite.expirationHours;

        document.getElementById('sessionTokenExpiryMinutes').value = config.session.sessionTokenExpiryMinutes;
        document.getElementById('reloginTokenExpiryDays').value = config.session.reloginTokenExpiryDays;
        
        // Initialize unsaved changes tracking
        const formData = getSecurityFormData();
        window.initializeUnsavedTracking(formData);
        updateSecuritySaveButtonState();
        attachSecurityFormListeners();
    } catch (error) {
        console.error('Error loading security settings:', error);
        window.showStatusBanner('Error loading security settings: ' + error.message, 'error', 'securityStatusMessage');
    }
}

function getSecurityFormData() {
    return {
        password: {
            minLength: parseInt(document.getElementById('passwordMinLength').value),
            requireUppercase: document.getElementById('passwordRequireUppercase').checked,
            requireNumbersOrSpecial: document.getElementById('passwordRequireNumbersOrSpecial').checked,
            failureLimit: parseInt(document.getElementById('passwordFailureLimit').value),
            failureResetMinutes: parseInt(document.getElementById('passwordFailureResetMinutes').value),
            historyCount: parseInt(document.getElementById('passwordHistoryCount').value),
            oldPwdAge: parseInt(document.getElementById('passwordOldPwdAge').value)
        },
        mfa: {
            failureLimit: parseInt(document.getElementById('mfaFailureLimit').value),
            failureResetMinutes: parseInt(document.getElementById('mfaFailureResetMinutes').value),
            backupCodeCount: parseInt(document.getElementById('mfaBackupCodeCount').value),
            codeValiditySeconds: parseInt(document.getElementById('mfaCodeValiditySeconds').value),
            allowedClockSkew: parseInt(document.getElementById('mfaAllowedClockSkew').value)
        },
        lockout: {
            durationMinutes: parseInt(document.getElementById('lockoutDurationMinutes').value),
            autoUnlock: document.getElementById('lockoutAutoUnlock').checked
        },
        invite: {
            expirationHours: parseInt(document.getElementById('inviteExpirationHours').value)
        },
        session: {
            sessionTokenExpiryMinutes: parseInt(document.getElementById('sessionTokenExpiryMinutes').value),
            reloginTokenExpiryDays: parseInt(document.getElementById('reloginTokenExpiryDays').value)
        }
    };
}

let originalSecurityData = null;

function updateSecuritySaveButtonState() {
    const saveBtn = document.querySelector('#securityTab .btn[data-color="green"]');
    if (saveBtn) {
        const currentData = getSecurityFormData();
        window.checkUnsavedChanges(currentData);
        const hasChanges = window.hasUnsavedChanges();
        saveBtn.disabled = !hasChanges;
    }
}

/**
 * Save security settings to system_config
 */
async function saveSecuritySettings() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        const config = getSecurityFormData();

        // Escape single quotes in JSON for SQL
        const configJson = JSON.stringify(config).replace(/'/g, "''");
        
        const result = await executeSqlQuery(
            sessionToken,
            currentUser,
            'kore_sys',
            `UPDATE system_config SET security_config = '${configJson}' WHERE id = 1`
        );

        if (!result) {
            window.showStatusBanner('Error saving security settings', 'error', 'securityStatusMessage');
            return;
        }

        // Reload auth module to apply new security settings
        try {
            const reloadResponse = await fetch('/kore/admin/reload-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (!reloadResponse.ok) {
                console.warn('Auth reload response not ok, but settings were saved');
            }
        } catch (reloadError) {
            console.warn('Error reloading auth:', reloadError);
        }
        
        // Reset unsaved changes tracking
        window.initializeUnsavedTracking(config);
        updateSecuritySaveButtonState();

        window.showStatusBanner('Security settings saved successfully. Restart Kore for some changes to take effect.', 'success', 'securityStatusMessage');
    } catch (error) {
        console.error('Error saving security settings:', error);
        window.showStatusBanner('Error saving security settings: ' + error.message, 'error', 'securityStatusMessage');
    }
}

/**
 * Reset security form to last loaded values
 */
function resetSecurityForm() {
    loadSecuritySettings();
}

/**
 * Attach change listeners to security form fields
 */
function attachUserPrefsFormListeners() {
    const prefsInputs = document.querySelectorAll('#preferencesTab input, #preferencesTab select');
    console.log('Attaching listeners to', prefsInputs.length, 'userprefs inputs');
    prefsInputs.forEach(input => {
        input.addEventListener('change', () => {
            console.log('Userprefs field changed:', input.id);
            updateUserPrefsSaveButtonState();
        });
        input.addEventListener('input', () => {
            console.log('Userprefs field input:', input.id);
            updateUserPrefsSaveButtonState();
        });
    });
}

function attachSecurityFormListeners() {
    const securityInputs = document.querySelectorAll('#securityTab input');
    console.log('Attaching listeners to', securityInputs.length, 'security inputs');
    securityInputs.forEach(input => {
        input.addEventListener('change', () => {
            console.log('Security field changed:', input.id);
            const hasChanges = window.hasUnsavedChanges();
            console.log('hasUnsavedChanges:', hasChanges);
            updateSecuritySaveButtonState();
        });
        input.addEventListener('input', () => {
            console.log('Security field input:', input.id);
            const hasChanges = window.hasUnsavedChanges();
            console.log('hasUnsavedChanges:', hasChanges);
            updateSecuritySaveButtonState();
        });
    });
}

// ============================================================================
// USER PREFERENCES TAB FUNCTIONS
// ============================================================================

/**
 * Switch to User Preferences tab and load user data
 */
function switchToUserPreferencesTab(event) {
    switchTab('preferencesTab', event);
    loadUserPreferences();
}

/**
 * Load user preferences from current user data
 */
async function loadUserPreferences() {
    try {
        console.log('loadUserPreferences called');
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        console.log('sessionToken:', sessionToken);

        console.log('currentUser:', currentUser);


        // Load user profile data
        console.log('Calling getCurrentUserData');
        const userData = await window.getCurrentUserData(sessionToken);
        console.log('userData:', userData);
        
        if (!userData) {
            window.showStatusBanner('Error loading user data', 'error', 'userprefStatusMessage');
            return;
        }

        // Populate profile fields
        console.log('Populating user fields');
        document.getElementById('userFullName').value = userData.full_name || '';
        document.getElementById('userEmail').value = userData.email || '';

        // Load notification preferences
        console.log('Calling getUserNotificationPreferences');
        const notificationPrefs = await window.getUserNotificationPreferences(sessionToken, currentUser);
        console.log('notificationPrefs:', notificationPrefs);
        
        if (notificationPrefs) {
            console.log('Setting notification checkboxes');
            document.getElementById('notifyLogin').checked = notificationPrefs.login_alerts !== false;
            document.getElementById('notifyPasswordChange').checked = notificationPrefs.password_change_alerts !== false;
            document.getElementById('notifySecurityAlerts').checked = notificationPrefs.security_alerts !== false;
            document.getElementById('notifySystemUpdates').checked = notificationPrefs.system_updates !== false;
            document.getElementById('notificationFrequency').value = notificationPrefs.frequency || 'immediate';
        }

        // Clear password fields
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';

        // Initialize unsaved changes tracking
        window.initializeUnsavedTracking({
            userFullName: document.getElementById('userFullName').value,
            userEmail: document.getElementById('userEmail').value,
            notifyLogin: document.getElementById('notifyLogin').checked,
            notifyPasswordChange: document.getElementById('notifyPasswordChange').checked,
            notifySecurityAlerts: document.getElementById('notifySecurityAlerts').checked,
            notifySystemUpdates: document.getElementById('notifySystemUpdates').checked,
            notificationFrequency: document.getElementById('notificationFrequency').value
        });

        // Reset all save buttons and attach listeners
        updateUserPrefsSaveButtonState();
        attachUserPrefsFormListeners();
        document.getElementById('changePasswordBtn').disabled = true;
        console.log('loadUserPreferences completed successfully');

    } catch (error) {
        console.error('Error loading user preferences:', error);
        window.showStatusBanner('Error loading user preferences: ' + error.message, 'error', 'userprefStatusMessage');
    }
}

/**
 * Check for unsaved changes in user profile section
 */
/**
 * Save both user preferences (profile + notifications) together
 */
async function saveUserPreferencesData() {
    try {
        const fullName = document.getElementById('userFullName').value.trim();
        const email = document.getElementById('userEmail').value.trim();

        // Validation
        if (!fullName) {
            window.showStatusBanner('Full name is required', 'error', 'userprefStatusMessage');
            return;
        }

        if (!email) {
            window.showStatusBanner('Email is required', 'error', 'userprefStatusMessage');
            return;
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            window.showStatusBanner('Please enter a valid email address', 'error', 'userprefStatusMessage');
            return;
        }

        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        // Save profile
        const profileResult = await window.updateUserProfile(sessionToken, currentUser, {
            full_name: fullName,
            email: email
        });

        if (!profileResult) {
            window.showStatusBanner('Error updating user profile', 'error', 'userprefStatusMessage');
            return;
        }

        // Save notification preferences
        const preferences = {
            login_alerts: document.getElementById('notifyLogin').checked,
            password_change_alerts: document.getElementById('notifyPasswordChange').checked,
            security_alerts: document.getElementById('notifySecurityAlerts').checked,
            system_updates: document.getElementById('notifySystemUpdates').checked,
            frequency: document.getElementById('notificationFrequency').value
        };

        const prefsResult = await window.updateUserNotificationPreferences(sessionToken, currentUser, preferences);

        if (!prefsResult) {
            window.showStatusBanner('Error updating notification preferences', 'error', 'userprefStatusMessage');
            return;
        }

        // Reinitialize unsaved changes tracking with saved data
        const savedData = {
            userFullName: fullName,
            userEmail: email,
            notifyLogin: document.getElementById('notifyLogin').checked,
            notifyPasswordChange: document.getElementById('notifyPasswordChange').checked,
            notifySecurityAlerts: document.getElementById('notifySecurityAlerts').checked,
            notifySystemUpdates: document.getElementById('notifySystemUpdates').checked,
            notificationFrequency: document.getElementById('notificationFrequency').value
        };
        window.initializeUnsavedTracking(savedData);
        updateUserPrefsSaveButtonState();
        window.showStatusBanner('User preferences saved successfully', 'success', 'userprefStatusMessage');

    } catch (error) {
        console.error('Error saving user preferences:', error);
        window.showStatusBanner('Error saving preferences: ' + error.message, 'error', 'userprefStatusMessage');
    }
}

function updateUserPrefsSaveButtonState() {
    const saveBtn = document.getElementById('userPrefsSaveBtn');
    if (saveBtn) {
        const currentData = {
            userFullName: document.getElementById('userFullName').value,
            userEmail: document.getElementById('userEmail').value,
            notifyLogin: document.getElementById('notifyLogin').checked,
            notifyPasswordChange: document.getElementById('notifyPasswordChange').checked,
            notifySecurityAlerts: document.getElementById('notifySecurityAlerts').checked,
            notifySystemUpdates: document.getElementById('notifySystemUpdates').checked,
            notificationFrequency: document.getElementById('notificationFrequency').value
        };
        window.checkUnsavedChanges(currentData);
        const hasChanges = window.hasUnsavedChanges();
        saveBtn.disabled = !hasChanges;
    }
}

function checkUserPrefUnsavedChanges() {
    updateUserPrefsSaveButtonState();
}

/**
 * Check for unsaved changes in notification section
 */
function checkNotificationUnsavedChanges() {
    updateUserPrefsSaveButtonState();
}

/**
 * Check for unsaved changes in password section
 */
function checkPasswordUnsavedChanges() {
    const currentPwd = document.getElementById('currentPassword').value;
    const newPwd = document.getElementById('newPassword').value;
    const confirmPwd = document.getElementById('confirmPassword').value;
    
    const hasChanges = currentPwd.length > 0 || newPwd.length > 0 || confirmPwd.length > 0;
    document.getElementById('changePasswordBtn').disabled = !hasChanges;
}

/**
 * Save user profile (Full Name and Email)
 */
/**
 * Change user password
 */
async function changeUserPassword() {
    try {
        const currentPwd = document.getElementById('currentPassword').value;
        const newPwd = document.getElementById('newPassword').value;
        const confirmPwd = document.getElementById('confirmPassword').value;

        // Validation
        if (!currentPwd) {
            window.showStatusBanner('Current password is required', 'error', 'userprefStatusMessage');
            return;
        }

        if (!newPwd) {
            window.showStatusBanner('New password is required', 'error', 'userprefStatusMessage');
            return;
        }

        if (newPwd !== confirmPwd) {
            window.showStatusBanner('New passwords do not match', 'error', 'userprefStatusMessage');
            return;
        }

        if (currentPwd === newPwd) {
            window.showStatusBanner('New password must be different from current password', 'error', 'userprefStatusMessage');
            return;
        }

        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        // Call the change-password endpoint
        const response = await fetch('/auth/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({
                oldPassword: currentPwd,
                newPassword: newPwd
            })
        });

        const result = await response.json();

        if (result.success) {
            // Clear password fields
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
            document.getElementById('changePasswordBtn').disabled = true;
            window.showStatusBanner('Password changed successfully', 'success', 'userprefStatusMessage');
        } else if (result.error) {
            window.showStatusBanner(result.error, 'error', 'userprefStatusMessage');
        } else {
            window.showStatusBanner('Error changing password', 'error', 'userprefStatusMessage');
        }

    } catch (error) {
        console.error('Error changing password:', error);
        window.showStatusBanner('Error changing password: ' + error.message, 'error', 'userprefStatusMessage');
    }
}

/**
 * Save notification preferences
 */
async function saveNotificationPreferences() {
    try {
        const preferences = {
            login_alerts: document.getElementById('notifyLogin').checked,
            password_change_alerts: document.getElementById('notifyPasswordChange').checked,
            security_alerts: document.getElementById('notifySecurityAlerts').checked,
            system_updates: document.getElementById('notifySystemUpdates').checked,
            frequency: document.getElementById('notificationFrequency').value
        };

        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        const result = await window.updateUserNotificationPreferences(sessionToken, currentUser, preferences);

        if (!result) {
            window.showStatusBanner('Error updating notification preferences', 'error', 'userprefStatusMessage');
            return;
        }

        window.clearUnsavedChanges();
        document.getElementById('notificationSaveBtn').disabled = true;
        window.showStatusBanner('Notification preferences saved successfully', 'success', 'userprefStatusMessage');

    } catch (error) {
        console.error('Error saving notification preferences:', error);
        window.showStatusBanner('Error saving preferences: ' + error.message, 'error', 'userprefStatusMessage');
    }
}

/**
 * Load page permissions data from backend
 */
/**
 * Load the Permissions page - initializes all permission management
 */
async function loadPermissionsPage() {
    try {
        if (!sessionToken) sessionToken = await getSessionToken();
        await loadPagePermissions();
        
        // Set up dropdown change handler
        const pageSelect = document.getElementById('pageSelect');
        const buttonsContainer = document.getElementById('pagePermissionsButtons');
        const saveBtn = document.getElementById('savePagePermissionsBtn');
        const cancelBtn = document.getElementById('cancelPagePermissionsBtn');
        
        if (pageSelect && buttonsContainer && saveBtn && cancelBtn) {
            // Show/hide buttons and load forms based on selection
            pageSelect.addEventListener('change', (e) => {
                if (e.target.value) {
                    displayPermissions('page', e.target.value);
                    buttonsContainer.style.display = 'flex';
                } else {
                    buttonsContainer.style.display = 'none';
                    document.getElementById('permissionsList').innerHTML = '';
                    document.getElementById('allowedIPsList').innerHTML = '';
                }
            });
            
            // Save button handler
            saveBtn.onclick = async () => {
                if (pageSelect.value) {
                    await savePermissionsByType('page', pageSelect.value);
                }
            };
            
            // Cancel button handler - clears selection and resets forms
            cancelBtn.onclick = () => {
                pageSelect.value = '';
                buttonsContainer.style.display = 'none';
                document.getElementById('permissionsList').innerHTML = '';
                document.getElementById('allowedIPsList').innerHTML = '';
            };
        }
    } catch (error) {
        console.error('Error loading permissions page:', error);
        window.showStatusBanner('Error loading permissions: ' + error.message, 'error', 'permissionsStatusMessage');
    }
}

/**
 * Permission Management Configuration
 */
const PERMISSION_TYPES = {
    page: {
        resource: 'page',
        loadEndpoint: '/kore/page-permissions',
        saveEndpoint: '/kore/permissions',
        dropdownId: 'pageSelect',
        dataKey: 'pagePermissionsData',
        itemLabel: (item) => `${item.path} - ${item.title}`,
        itemId: (item) => item.path,
        statusMessageId: 'pagePermStatusMessage',
        permissionsListId: 'permissionsList',
        scopeKey: 'path'
    }
};

/**
 * Load permissions by type
 */
async function loadPermissionsByType(permType) {
    try {
        const config = PERMISSION_TYPES[permType];
        if (!config) {
            throw new Error(`Unknown permission type: ${permType}`);
        }

        // Use loadEndpoint for loading permission data
        const loadConfig = { ...config, endpoint: config.loadEndpoint };
        const permissionsData = await loadPermissionsForResource(loadConfig);
        window[config.dataKey] = permissionsData;
        populatePermissionDropdown(permType);
    } catch (error) {
        console.error(`Error loading ${permType} permissions:`, error);
        window.showStatusBanner(`Error loading ${permType} permissions: ` + error.message, 'error', PERMISSION_TYPES[permType].statusMessageId);
    }
}

/**
 * Populate the permission dropdown
 */
function populatePermissionDropdown(permType) {
    const config = PERMISSION_TYPES[permType];
    const dropdown = document.getElementById(config.dropdownId);
    if (!dropdown) return;

    const permissionsData = window[config.dataKey];
    dropdown.innerHTML = `<option value="">Select ${permType}...</option>`;
    
    Object.values(permissionsData).forEach(item => {
        const option = document.createElement('option');
        option.value = config.itemId(item);
        option.textContent = config.itemLabel(item);
        dropdown.appendChild(option);
    });
    
    // Event listener is now handled centrally in loadPermissionsPage
}

/**
 * Display permissions for selected item
 */
async function displayPermissions(permType, itemId) {
    const config = PERMISSION_TYPES[permType];
    const permissionsData = window[config.dataKey];
    const itemData = permissionsData[itemId];
    if (!itemData) return;

    // Load all users and groups for dropdowns if not already loaded
    if (!window.allUsersAndGroups) {
        await loadAllUsersAndGroups();
    }

    const permissionsList = document.getElementById(config.permissionsListId);
    
    // Clear the container
    permissionsList.innerHTML = '';
    
    // Create main wrapper
    const mainWrapper = document.createElement('div');
    mainWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
    
    // Add separator
    const separator1 = document.createElement('div');
    separator1.style.cssText = 'height: 1px; background-color: var(--border-primary);';
    mainWrapper.appendChild(separator1);
    
    // Create header row with "Permissions" label and Add button
    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 12px;';
    
    const permissionsHeader = document.createElement('label');
    permissionsHeader.style.cssText = 'color: var(--text-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin: 0;';
    permissionsHeader.textContent = 'Permissions';
    headerRow.appendChild(permissionsHeader);
    
    // Create a temporary container for the form
    const formContainer = document.createElement('div');
    
    // Use the displayPermissionsForm function from base.js
    displayPermissionsForm(formContainer, itemData.permissions || [], {
        addButtonLabel: 'Add Permission',
        saveButtonLabel: `Save ${permType.charAt(0).toUpperCase() + permType.slice(1)} Permissions`,
        showSaveButton: false,  // Use fixed button at bottom instead
        onSave: () => savePermissionsByType(permType, itemId)
    });
    
    // Extract the add button and put it in the header row
    const addBtn = formContainer.querySelector('.btn[data-color="blue"]');
    console.log('[Permissions] Found Add button:', addBtn);
    
    if (addBtn) {
        // Store the original onclick
        const originalOnclick = addBtn.onclick;
        
        // Replace the onclick to append to the correct container (rowsContainer)
        // The original closure references permissionsContainer which is not in the visible DOM
        addBtn.onclick = () => {
            console.log('[Permissions] Add button clicked');
            // Find the visible rows container
            const rowsContainer = mainWrapper.querySelector('[style*="flex-direction: column; gap: 8px;"]');
            if (rowsContainer) {
                // Call createPermissionRow to add a new row to the visible container
                window.createPermissionRow(rowsContainer, true, null, null);
                console.log('[Permissions] New row created');
                setTimeout(checkPagePermissionsUnsavedChanges, 10);
            } else {
                console.error('[Permissions] Could not find rows container');
            }
        };
        headerRow.appendChild(addBtn);
    } else {
        console.log('[Permissions] WARNING: Could not find Add Permission button!');
    }
    
    mainWrapper.appendChild(headerRow);
    
    // Add the permission rows (everything except the button wrapper)
    const permissionRows = formContainer.querySelectorAll('.permission-row');
    const rowsContainer = document.createElement('div');
    rowsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';
    permissionRows.forEach(row => rowsContainer.appendChild(row));
    mainWrapper.appendChild(rowsContainer);
    
    permissionsList.appendChild(mainWrapper);

    // For page resource type, also display allowedIPs form
    if (permType === 'page') {
        const allowedIPsList = document.getElementById('allowedIPsList');
        if (allowedIPsList) {
            // Clear it first
            allowedIPsList.innerHTML = '';
            
            // Create wrapper for IPs section
            const ipsWrapper = document.createElement('div');
            ipsWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
            
            // Call displayAllowedIPsForm on the wrapper
            await displayAllowedIPsForm(ipsWrapper, 'web_pages', 'path', itemId, {
                showSeparator: true,
                showButtons: false,
                onSave: () => savePermissionsByType(permType, itemId)
            });
            
            allowedIPsList.appendChild(ipsWrapper);
        }
    }

    // Initialize unsaved changes tracking for page permissions
    if (permType === 'page') {
        window.initializeUnsavedTracking(getPagePermissionsFormData());
        checkPagePermissionsUnsavedChanges();

        // Hook change handlers to all form elements
        // Permission row changes (delegation - handles dynamic rows)
        const permissionsList = document.getElementById('permissionsList');
        permissionsList.addEventListener('change', (e) => {
            if (e.target.closest('.permission-row')) {
                checkPagePermissionsUnsavedChanges();
            }
        });

        // Whitelist checkbox changes (delegation)
        const allowedIPsList = document.getElementById('allowedIPsList');
        if (allowedIPsList) {
            allowedIPsList.addEventListener('change', (e) => {
                if (e.target.classList.contains('whitelist-checkbox')) {
                    checkPagePermissionsUnsavedChanges();
                }
            });

            // IP field changes (delegation - handles dynamic fields)
            allowedIPsList.addEventListener('input', (e) => {
                if (e.target.classList.contains('ip-input')) {
                    checkPagePermissionsUnsavedChanges();
                }
            });

            // Delete IP button clicks - trigger check after field is removed
            // Need to use delegation since buttons are created dynamically
            allowedIPsList.addEventListener('click', (e) => {
                if (e.target.classList.contains('btn') && e.target.getAttribute('data-color') === 'red') {
                    // Delete button clicked - after the field is removed, check for changes
                    setTimeout(checkPagePermissionsUnsavedChanges, 10);
                }
            });

            // Add IP Address button click - trigger check after new field is added
            const addIPBtn = allowedIPsList.querySelector('button[data-color="blue"]');
            if (addIPBtn) {
                const originalOnclick = addIPBtn.onclick;
                if (originalOnclick) {
                    addIPBtn.onclick = () => {
                        originalOnclick();
                        setTimeout(checkPagePermissionsUnsavedChanges, 10);
                    };
                }
            }
        }
    }
}

/**
 * Save permissions by type (and allowedIPs for page resources)
 */
async function savePermissionsByType(permType, itemId) {
    try {
        const config = PERMISSION_TYPES[permType];
        
        // Use saveEndpoint for saving permission data
        const saveConfig = { ...config, endpoint: config.saveEndpoint };
        await savePermissionsForResource(saveConfig, itemId);
        
        // For page resource type, also save allowedIPs if the form exists
        if (permType === 'page') {
            const allowedIPsInput = document.getElementById('allowedIPsInput');
            if (allowedIPsInput) {
                try {
                    const inputValue = allowedIPsInput.value.trim();
                    let ipsToSave;

                    // Try to parse as JSON first
                    try {
                        ipsToSave = JSON.parse(inputValue);
                        if (!Array.isArray(ipsToSave)) {
                            throw new Error('Must be an array');
                        }
                    } catch (e) {
                        // If not JSON, treat as comma-separated
                        ipsToSave = inputValue
                            .split(',')
                            .map(ip => ip.trim())
                            .filter(ip => ip.length > 0);
                    }

                    // Save allowedIPs
                    await saveAllowedIPs('web_pages', 'path', itemId, ipsToSave);
                    console.log('[Settings] Saved allowedIPs for page:', itemId);
                } catch (ipError) {
                    console.warn('[Settings] Could not save allowedIPs:', ipError.message);
                    // Don't fail completely if allowedIPs save fails
                }
            }
        }
        
        window.showStatusBanner(`${permType} permissions saved successfully`, 'success', config.statusMessageId);
        
        // Reset unsaved changes tracking for page permissions
        if (permType === 'page') {
            window.initializeUnsavedTracking(getPagePermissionsFormData());
            checkPagePermissionsUnsavedChanges();
        }
        
        await loadPermissionsByType(permType); // Reload to sync
    } catch (error) {
        console.error(`Error saving ${permType} permissions:`, error);
        window.showStatusBanner(`Error saving ${permType} permissions: ` + error.message, 'error', PERMISSION_TYPES[permType].statusMessageId);
    }
}

async function loadPagePermissions() {
    return loadPermissionsByType('page');
}

/**
 * Get current page permissions form data (permissions + IPs)
 */
function getPagePermissionsFormData() {
    const formData = {
        permissions: [],
        whitelists: [],
        ips: []
    };

    // Collect permission rows
    const permissionRows = document.querySelectorAll('.permission-row');
    permissionRows.forEach(row => {
        const targetElement = row.querySelector('.permission-target');
        const effectElement = row.querySelector('.permission-effect');
        const actionElement = row.querySelector('.permission-action');
        
        if (targetElement) {
            formData.permissions.push({
                target: targetElement.value,
                effect: effectElement ? effectElement.value : 'allow',
                action: actionElement ? actionElement.value : 'view'
            });
        }
    });

    // Collect whitelist checkboxes
    const whitelistCheckboxes = document.querySelectorAll('.whitelist-checkbox:checked');
    whitelistCheckboxes.forEach(checkbox => {
        formData.whitelists.push(`whitelist.${checkbox.dataset.category}`);
    });

    // Collect IP fields
    const ipInputs = document.querySelectorAll('.ip-input');
    ipInputs.forEach(input => {
        const value = input.value.trim();
        if (value) {
            formData.ips.push(value);
        }
    });

    return formData;
}

/**
 * Check for unsaved changes in page permissions form
 */
function checkPagePermissionsUnsavedChanges() {
    const currentData = getPagePermissionsFormData();
    window.checkUnsavedChanges(currentData);
    
    const saveBtn = document.getElementById('savePagePermissionsBtn');
    if (saveBtn) {
        saveBtn.disabled = !window.hasUnsavedChanges();
    }
}

/**
 * Load all users and groups for the target dropdown
 */
async function loadAllUsersAndGroups() {
    try {
        if (!sessionToken) sessionToken = await getSessionToken();

        const [users, groups] = await Promise.all([
            window.getUsers(sessionToken, currentUser),
            window.getGroups(sessionToken, currentUser)
        ]);

        window.allUsersAndGroups = {
            users: users || [],
            groups: groups || []
        };
    } catch (error) {
        console.error('Error loading users and groups:', error);
        window.allUsersAndGroups = { users: [], groups: [] };
    }
}
// ============================================================================
// EXPORTS TO WINDOW
// ============================================================================
window.addIPFieldToSystemWhitelist = addIPFieldToSystemWhitelist;
window.addNewEmailProfile = addNewEmailProfile;
window.addUserGroupsSection = addUserGroupsSection;
window.attachSecurityFormListeners = attachSecurityFormListeners;
window.attachUserPrefsFormListeners = attachUserPrefsFormListeners;
window.cancelGroupEdit = cancelGroupEdit;
window.cancelOrganizationEdit = cancelOrganizationEdit;
window.cancelUserEdit = cancelUserEdit;
window.changeUserPassword = changeUserPassword;
window.checkEmailUnsavedChanges = checkEmailUnsavedChanges;
window.checkGroupUnsavedChanges = checkGroupUnsavedChanges;
window.checkLoggingUnsavedChanges = checkLoggingUnsavedChanges;
window.checkNotificationUnsavedChanges = checkNotificationUnsavedChanges;
window.checkOrgUnsavedChanges = checkOrgUnsavedChanges;
window.checkPagePermissionsUnsavedChanges = checkPagePermissionsUnsavedChanges;
window.checkPasswordUnsavedChanges = checkPasswordUnsavedChanges;
window.checkSystemUnsavedChanges = checkSystemUnsavedChanges;
window.checkUserPrefUnsavedChanges = checkUserPrefUnsavedChanges;
window.checkUserUnsavedChanges = checkUserUnsavedChanges;
window.confirmRestartSubsystem = confirmRestartSubsystem;
window.deleteEmailProfile = deleteEmailProfile;
window.displayEntityDetailsGeneric = displayEntityDetailsGeneric;
window.displayEntityListGeneric = displayEntityListGeneric;
window.displayGroupDetails = displayGroupDetails;
window.displayGroups = displayGroups;
window.displayInternalWhitelist = displayInternalWhitelist;
window.displayOrgStack = displayOrgStack;
window.displayOrganizationDetails = displayOrganizationDetails;
window.displayOrganizations = displayOrganizations;
window.displayPermissions = displayPermissions;
window.displayUserDetails = displayUserDetails;
window.displayUsers = displayUsers;
window.doSelectGroupFromList = doSelectGroupFromList;
window.doSelectOrganizationFromList = doSelectOrganizationFromList;
window.doSelectUserFromList = doSelectUserFromList;
window.getEmailFormData = getEmailFormData;
window.getLoggingFormData = getLoggingFormData;
window.getOrgFormData = getOrgFormData;
window.getPagePermissionsFormData = getPagePermissionsFormData;
window.getSecurityFormData = getSecurityFormData;
window.getSystemFormData = getSystemFormData;
window.loadAllUsersAndGroups = loadAllUsersAndGroups;
window.loadAndCacheStackTypes = loadAndCacheStackTypes;
window.loadEmailConfig = loadEmailConfig;
window.loadEmailProfile = loadEmailProfile;
window.loadEntityListGeneric = loadEntityListGeneric;
window.loadGroupsList = loadGroupsList;
window.loadLoggingConfig = loadLoggingConfig;
window.loadOrgStack = loadOrgStack;
window.loadOrganizationDetails = loadOrganizationDetails;
window.loadOrganizationsList = loadOrganizationsList;
window.loadPagePermissions = loadPagePermissions;
window.loadPermissionsByType = loadPermissionsByType;
window.loadPermissionsPage = loadPermissionsPage;
window.loadSecuritySettings = loadSecuritySettings;
window.loadSystemConfig = loadSystemConfig;
window.loadSystemHealth = loadSystemHealth;
window.loadUserPreferences = loadUserPreferences;
window.loadUsersList = loadUsersList;
window.populateEmailProfileDropdown = populateEmailProfileDropdown;
window.populateLoggingFields = populateLoggingFields;
window.populatePermissionDropdown = populatePermissionDropdown;
window.populateTimezoneSelect = populateTimezoneSelect;
window.refreshSystemHealth = refreshSystemHealth;
window.resendUserInvite = resendUserInvite;
window.resetSecurityForm = resetSecurityForm;
window.resetUserMFA = resetUserMFA;
window.restartSubsystem = restartSubsystem;
window.saveEmailProfile = saveEmailProfile;
window.saveGroupDetails = saveGroupDetails;
window.saveLoggingConfig = saveLoggingConfig;
window.saveNewGroup = saveNewGroup;
window.saveNewOrganization = saveNewOrganization;
window.saveNewUser = saveNewUser;
window.saveNotificationPreferences = saveNotificationPreferences;
window.saveOrganizationDetails = saveOrganizationDetails;
window.savePermissionsByType = savePermissionsByType;
window.saveSecuritySettings = saveSecuritySettings;
window.saveSystemConfig = saveSystemConfig;
window.saveUserDetails = saveUserDetails;
window.saveUserPreferencesData = saveUserPreferencesData;
window.selectGroupFromList = selectGroupFromList;
window.selectOrganizationFromList = selectOrganizationFromList;
window.selectUserFromList = selectUserFromList;
window.showAddGroupModal = showAddGroupModal;
window.showAddOrganizationModal = showAddOrganizationModal;
window.showAddUserModal = showAddUserModal;
window.showModulesModal = showModulesModal;
window.showNewProfileDialog = showNewProfileDialog;
window.startUptimeTicker = startUptimeTicker;
window.switchEmailProfile = switchEmailProfile;
window.switchTabWithUnsavedCheck = switchTabWithUnsavedCheck;
window.switchToGroupsTab = switchToGroupsTab;
window.switchToOrganizationsTab = switchToOrganizationsTab;
window.switchToPermissionsTab = switchToPermissionsTab;
window.switchToPluginsTab = switchToPluginsTab;
window.switchToSecurityTab = switchToSecurityTab;
window.switchToUserPreferencesTab = switchToUserPreferencesTab;
window.switchToUsersTab = switchToUsersTab;
window.switchToUtilitiesTab = switchToUtilitiesTab;
window.testEmailSmtp = testEmailSmtp;
window.unlockUser = unlockUser;
window.updateSecuritySaveButtonState = updateSecuritySaveButtonState;
window.updateUserPrefsSaveButtonState = updateUserPrefsSaveButtonState;
window.viewGroupPermissions = viewGroupPermissions;
window.viewUserPermissions = viewUserPermissions;