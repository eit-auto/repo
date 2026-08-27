import '/lib/base.js';
import '/lib/plugins-front.js';

let currentUser = null;  // Vestigial: helpers that take it no longer transmit it; identity comes from the session
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
        onDisplayComplete: 'loadUserStack'
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
                ${!isInvited ? `<button class="btn" data-color="red" data-size="sm" onclick="toggleSetPasswordForm('${escapeHtml(String(entityId))}')" id="setPasswordBtn" style="width: 100%;">Set Password</button>` : ''}
                <button class="btn" data-color="blue" data-size="sm" onclick="viewUserPermissions('${escapeHtml(String(entityId))}')" id="viewPermissionsBtn" style="width: 100%;">View Permissions</button>
                <div id="setPasswordForm" style="display: none; flex-direction: column; gap: 8px; margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--border-primary);">
                    <label style="font-size: 11px; color: var(--secondary-slate);">New Password</label>
                    <input type="password" id="adminNewPassword" autocomplete="new-password">
                    <label style="font-size: 11px; color: var(--secondary-slate);">Confirm Password</label>
                    <input type="password" id="adminConfirmPassword" autocomplete="new-password">
                    <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; cursor: pointer;">
                        <input type="checkbox" id="adminForceChange" style="width: 16px; height: 16px; cursor: pointer;">
                        Require change at next login
                    </label>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn" data-color="green" data-size="sm" onclick="submitSetPassword('${escapeHtml(String(entityId))}')" id="submitSetPasswordBtn" style="flex: 1;">Set</button>
                        <button class="btn" data-color="grey" data-size="sm" onclick="toggleSetPasswordForm('${escapeHtml(String(entityId))}')" style="flex: 1;">Cancel</button>
                    </div>
                    <div style="font-size: 10px; color: var(--secondary-slate); line-height: 1.4;">
                        Signs the user out of all devices.
                    </div>
                </div>
            </div>
        `;
        detailArea.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 15px; flex: 1; min-height: 0;">
                <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 15px; align-items: stretch;">
                    <div style="display: flex; flex-direction: column;">${detailsHtml}</div>
                    <div style="display: flex; flex-direction: column;">${actionsHtml}</div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; align-items: stretch;">
                    <div id="userGroupsCell"></div>
                    <div id="userStackCell"></div>
                </div>
            </div>`;
    } else if (entityType === 'group') {
        const actionsHtml = `
            <div class="panel-level-3" style="display: flex; flex-direction: column; gap: 8px; flex: 1;">
                <h3 style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Actions</h3>
                <button class="btn" data-color="blue" data-size="sm" onclick="viewGroupPermissions('${escapeHtml(String(entityId))}')" id="viewGroupPermissionsBtn" style="width: 100%;">View Permissions</button>
            </div>
        `;
        detailArea.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 15px; flex: 1; min-height: 0;">
                <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 15px; align-items: stretch;">
                    <div style="display: flex; flex-direction: column;">${detailsHtml}</div>
                    <div style="display: flex; flex-direction: column;">${actionsHtml}</div>
                </div>
                <div id="groupParentsCell"></div>
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
    if (entityType === 'group') {
        addGroupParentsSection(entityData, document.getElementById('groupParentsCell'));
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


/**
 * Lets a group be nested under one or more other groups - members of any
 * checked group also inherit whatever this group's own memberships grant,
 * transitively (see hasPermission()'s nearest-group-wins resolution in
 * auth.js). Mirrors addUserGroupsSection's structure and defensive
 * groupIds parsing exactly, with two differences: the group being edited
 * is excluded from its own checkbox list (a group can't be its own
 * parent - the backend's cycle-safe BFS would tolerate it without
 * infinite-looping, but there's no reason to offer a meaningless choice),
 * and the checkbox id prefix is "parentgroup_" rather than "group_" so
 * these never collide with the user-editing panel's own group checkboxes
 * if both ever end up in the DOM at once.
 */
function addGroupParentsSection(groupData, targetEl) {
    if (!targetEl) return;
    let groupParentIds = [];
    try {
        if (groupData.groupIds) {
            if (Array.isArray(groupData.groupIds)) {
                groupParentIds = groupData.groupIds;
            } else if (typeof groupData.groupIds === 'string') {
                try {
                    groupParentIds = JSON.parse(groupData.groupIds);
                } catch {
                    groupParentIds = groupData.groupIds.split(',').map(id => id.trim()).filter(id => id);
                }
            }
        }
    } catch (e) {
        console.warn('Could not parse groupIds:', e);
    }

    const otherGroups = (window.cachedGroups || []).filter(g => g.groupId !== groupData.groupId);

    const parentsHtml = `
        <div class="panel-level-3" style="display: flex; flex-direction: column; gap: 10px;">
            <h3 style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Inherits From</h3>
            <p style="margin: 0; color: var(--text-muted); font-size: 11px;">Members of this group also get anything checked below - nesting applies transitively (A inherits from B inherits from C means A gets C's grants too).</p>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px;">
                ${otherGroups.length > 0
                    ? otherGroups.sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(group => `
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <input type="checkbox" id="parentgroup_${escapeHtml(String(group.groupId))}" ${groupParentIds.includes(group.groupId) ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;" onchange="checkGroupUnsavedChanges()">
                            <label for="parentgroup_${escapeHtml(String(group.groupId))}" style="flex: 1; color: var(--text-primary); font-size: 12px; cursor: pointer; margin: 0;">${escapeHtml(group.name)}</label>
                        </div>
                    `).join('')
                    : '<p style="color: var(--text-muted); font-size: 11px; margin: 0;">No other groups available</p>'
                }
            </div>
        </div>
    `;
    targetEl.innerHTML = parentsHtml;
}

async function loadOrganizationsList() {
    return loadEntityListGeneric('org');
}

function displayOrganizations(organizations) {
    displayEntityListGeneric('org', organizations);
}

async function showAddOrganizationModal() {
    // Reset in-memory stack for new org
    currentOrgStack = { rmm: [], psa: [], control: [], rpa: [], bdr: [], sec: [] };

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
            <hr style="border:none;border-top:1px solid var(--border-primary);margin:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <h4 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">System Integrations</h4>
                <button class="btn" data-color="green" data-size="sm" id="addModalStackEntryBtn">+ Add</button>
            </div>
            <div id="addModalStackEntriesList" style="display:flex;flex-direction:column;gap:6px;">
                <div style="color:var(--text-muted);font-size:12px;">No integrations configured.</div>
            </div>
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

    // Wire up Add Stack Entry button in modal
    setTimeout(() => {
        const categories = cachedStackTypes ? [
            { key: 'rmm', label: 'RMM', types: cachedStackTypes.rmm || [] },
            { key: 'psa', label: 'PSA', types: cachedStackTypes.psa || [] },
            { key: 'control', label: 'Control', types: cachedStackTypes.control || [] },
            { key: 'rpa', label: 'RPA', types: cachedStackTypes.rpa || [] },
            { key: 'bdr', label: 'BDR', types: cachedStackTypes.bdr || [] },
            { key: 'sec', label: 'SEC', types: cachedStackTypes.sec || [] }
        ] : [];

        function renderAddModalStackEntries() {
            const list = document.getElementById('addModalStackEntriesList');
            if (!list) return;
            list.innerHTML = '';
            let hasAny = false;
            categories.forEach(({ key, label, types }) => {
                (currentOrgStack[key] || []).forEach((entry, idx) => {
                    hasAny = true;
                    const row = document.createElement('div');
                    row.style.cssText = 'display:grid;grid-template-columns:100px 1fr 1fr 28px;gap:6px;align-items:center;';
                    row.innerHTML = `
                        <div style="font-size:11px;color:var(--text-muted);font-weight:600;">${label}</div>
                        <select style="font-size:12px;width:100%;">
                            <option value="">-- Not Set --</option>
                            ${types.map(t => `<option value="${t.type_id}" ${entry.type_id == t.type_id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
                        </select>
                        <input type="text" value="${escapeHtml(String(entry.id || ''))}" placeholder="ID" style="font-size:12px;width:100%;">
                        <button class="btn" data-color="red" data-size="sm" style="padding:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;">✕</button>
                    `;
                    const [, typeSelect, idInput, deleteBtn] = row.children;
                    typeSelect.addEventListener('change', () => {
                        const t = types.find(t => String(t.type_id) === typeSelect.value);
                        currentOrgStack[key][idx].type_id = typeSelect.value ? parseInt(typeSelect.value) : null;
                        currentOrgStack[key][idx].name = t ? t.name : null;
                    });
                    idInput.addEventListener('input', () => { currentOrgStack[key][idx].id = idInput.value; });
                    deleteBtn.addEventListener('click', () => { currentOrgStack[key].splice(idx, 1); renderAddModalStackEntries(); });
                    list.appendChild(row);
                });
            });
            if (!hasAny) {
                list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No integrations configured.</div>';
            }
        }

        document.getElementById('addModalStackEntryBtn')?.addEventListener('click', () => {
            const catOptions = categories.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
            window.showModal({
                title: 'Add Stack Entry',
                content: `
                    <div style="display:flex;flex-direction:column;gap:12px;">
                        <div>
                            <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px;">Category</label>
                            <select id="newStackCat2" style="width:100%;font-size:12px;">${catOptions}</select>
                        </div>
                        <div>
                            <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px;">Type</label>
                            <select id="newStackType2" style="width:100%;font-size:12px;"></select>
                        </div>
                        <div>
                            <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px;">ID</label>
                            <input type="text" id="newStackId2" style="width:100%;font-size:12px;" placeholder="Enter integration ID">
                        </div>
                    </div>`,
                closeOnBackdrop: false,
                buttons: [
                    { label: 'Cancel', type: 'secondary', onClick: () => {} },
                    { label: 'Add', type: 'success', onClick: () => {
                        const cat = document.getElementById('newStackCat2').value;
                        const typeSelect = document.getElementById('newStackType2');
                        const id = document.getElementById('newStackId2').value.trim();
                        const catDef = categories.find(c => c.key === cat);
                        const selectedType = catDef.types.find(t => String(t.type_id) === typeSelect.value);
                        if (!currentOrgStack[cat]) currentOrgStack[cat] = [];
                        currentOrgStack[cat].push({
                            type_id: selectedType ? parseInt(typeSelect.value) : null,
                            name: selectedType ? selectedType.name : null,
                            id: id || null
                        });
                        renderAddModalStackEntries();
                    }}
                ]
            });
            function updateTypeOptions2() {
                const cat = document.getElementById('newStackCat2')?.value;
                const typeSelect = document.getElementById('newStackType2');
                if (!typeSelect) return;
                const catDef = categories.find(c => c.key === cat);
                const types = catDef?.types || [];
                typeSelect.innerHTML = `<option value="">-- Not Set --</option>` +
                    types.map(t => `<option value="${t.type_id}">${escapeHtml(t.name)}</option>`).join('');
            }
            setTimeout(() => {
                updateTypeOptions2();
                document.getElementById('newStackCat2')?.addEventListener('change', updateTypeOptions2);
            }, 50);
        });
    }, 100);
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
        
        // NOTE: org_stack table is deprecated post-Rewst — writing stack JSON to orgs.stack instead.
        const stackJson = JSON.stringify(currentOrgStack).replace(/'/g, "''");
        const stackResult = await executeSqlQuery(
            sessionToken,
            currentUser,
            'kore_data',
            `UPDATE kore_data.orgs SET stack = '${stackJson}' WHERE org_id = ${newOrgId}`
        );
        
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
let currentOrgStack = {};  // In-memory stack JSON for the org being edited

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
        
        // Use cached stack types (should be loaded when tab was opened);
        // fall back to loading them now if the cache is empty for some reason.
        if (!cachedStackTypes) {
            await loadAndCacheStackTypes();
        }
        displayOrgStack(orgStack, orgId, cachedStackTypes || {});
    } catch (error) {
        console.error('Error loading org stack:', error);
    }
}

function displayOrgStack(orgStack, orgId, stackTypes) {
    const detailArea = document.querySelector('#organizationsTab .panel-level-2 > div > div:last-child');
    if (!detailArea) {
        console.error('Detail area not found for org stack');
        return;
    }

    // Initialize in-memory stack from loaded data
    currentOrgStack = orgStack && typeof orgStack === 'object' ? JSON.parse(JSON.stringify(orgStack)) : {};

    // Ensure all categories exist as arrays
    ['rmm', 'psa', 'control', 'rpa', 'bdr', 'sec'].forEach(cat => {
        if (!Array.isArray(currentOrgStack[cat])) currentOrgStack[cat] = [];
    });

    const categories = [
        { key: 'rmm', label: 'RMM', types: stackTypes.rmm || [] },
        { key: 'psa', label: 'PSA', types: stackTypes.psa || [] },
        { key: 'control', label: 'Control', types: stackTypes.control || [] },
        { key: 'rpa', label: 'RPA', types: stackTypes.rpa || [] },
        { key: 'bdr', label: 'BDR', types: stackTypes.bdr || [] },
        { key: 'sec', label: 'SEC', types: stackTypes.sec || [] }
    ];

    // Build the stack section container
    const section = document.createElement('div');
    section.id = 'orgStackSection';
    section.innerHTML = `<hr style="border:none;border-top:1px solid var(--border-primary);margin:10px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <h3 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">System Integrations</h3>
            <button class="btn" data-color="green" data-size="sm" id="addStackEntryBtn">+ Add</button>
        </div>
        <div id="stackEntriesList" style="display:flex;flex-direction:column;gap:6px;"></div>`;

    const pod = detailArea.querySelector('.panel-level-3');
    (pod || detailArea).appendChild(section);

    function renderStackEntries() {
        const list = document.getElementById('stackEntriesList');
        if (!list) return;
        list.innerHTML = '';
        let hasAny = false;
        categories.forEach(({ key, label, types }) => {
            (currentOrgStack[key] || []).forEach((entry, idx) => {
                hasAny = true;
                const row = document.createElement('div');
                row.style.cssText = 'display:grid;grid-template-columns:100px 1fr 1fr 28px;gap:6px;align-items:center;';
                row.innerHTML = `
                    <div style="font-size:11px;color:var(--text-muted);font-weight:600;">${label}</div>
                    <select style="font-size:12px;width:100%;">
                        <option value="">-- Not Set --</option>
                        ${types.map(t => `<option value="${t.type_id}" ${entry.type_id == t.type_id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
                    </select>
                    <input type="text" value="${escapeHtml(String(entry.id || ''))}" placeholder="ID" style="font-size:12px;width:100%;">
                    <button class="btn" data-color="red" data-size="sm" style="padding:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;">✕</button>
                `;
                const [, typeSelect, idInput, deleteBtn] = row.children;
                typeSelect.addEventListener('change', () => {
                    const t = types.find(t => String(t.type_id) === typeSelect.value);
                    currentOrgStack[key][idx].type_id = typeSelect.value ? parseInt(typeSelect.value) : null;
                    currentOrgStack[key][idx].name = t ? t.name : null;
                    checkOrgUnsavedChanges();
                });
                idInput.addEventListener('input', () => {
                    currentOrgStack[key][idx].id = idInput.value;
                    checkOrgUnsavedChanges();
                });
                deleteBtn.addEventListener('click', () => {
                    currentOrgStack[key].splice(idx, 1);
                    renderStackEntries();
                    checkOrgUnsavedChanges();
                });
                list.appendChild(row);
            });
        });
        if (!hasAny) {
            list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No integrations configured.</div>';
        }
    }

    document.getElementById('addStackEntryBtn').addEventListener('click', () => {
        // Build category + type selector modal
        const catOptions = categories.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
        window.showModal({
            title: 'Add Stack Entry',
            content: `
                <div style="display:flex;flex-direction:column;gap:12px;">
                    <div>
                        <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px;">Category</label>
                        <select id="newStackCat" style="width:100%;font-size:12px;">${catOptions}</select>
                    </div>
                    <div>
                        <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px;">Type</label>
                        <select id="newStackType" style="width:100%;font-size:12px;"></select>
                    </div>
                    <div>
                        <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px;">ID</label>
                        <input type="text" id="newStackId" style="width:100%;font-size:12px;" placeholder="Enter integration ID">
                    </div>
                </div>`,
            closeOnBackdrop: false,
            buttons: [
                { label: 'Cancel', type: 'secondary', onClick: () => {} },
                { label: 'Add', type: 'success', onClick: () => {
                    const cat = document.getElementById('newStackCat').value;
                    const typeSelect = document.getElementById('newStackType');
                    const id = document.getElementById('newStackId').value.trim();
                    const catDef = categories.find(c => c.key === cat);
                    const selectedType = catDef.types.find(t => String(t.type_id) === typeSelect.value);
                    if (!currentOrgStack[cat]) currentOrgStack[cat] = [];
                    currentOrgStack[cat].push({
                        type_id: selectedType ? parseInt(typeSelect.value) : null,
                        name: selectedType ? selectedType.name : null,
                        id: id || null
                    });
                    renderStackEntries();
                    checkOrgUnsavedChanges();
                }}
            ]
        });

        // Populate type dropdown based on selected category
        function updateTypeOptions() {
            const cat = document.getElementById('newStackCat')?.value;
            const typeSelect = document.getElementById('newStackType');
            if (!typeSelect) return;
            const catDef = categories.find(c => c.key === cat);
            const types = catDef?.types || [];
            typeSelect.innerHTML = `<option value="">-- Not Set --</option>` +
                types.map(t => `<option value="${t.type_id}">${escapeHtml(t.name)}</option>`).join('');
        }
        setTimeout(() => {
            updateTypeOptions();
            document.getElementById('newStackCat')?.addEventListener('change', updateTypeOptions);
        }, 50);
    });

    renderStackEntries();

    // Initialize unsaved changes tracking
    const initialOrgData = getOrgFormData();
    window.initializeUnsavedTracking(initialOrgData);
}

function getOrgFormData() {
    return {
        orgName: document.getElementById('orgNameInput')?.value || '',
        orgStatus: document.getElementById('orgStatusInput')?.checked ? '1' : '0',
        stack: JSON.stringify(currentOrgStack)
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

// ============================================================================
// USERS TAB - TECH STACK (mirrors the Organizations stack UI above, same
// stack_types lookup and JSON shape, stored in kore_sys.users.stack instead
// of kore_data.orgs.stack)
// ============================================================================

let currentUserStack = {};
let _initialUserStackJson = '{}';

async function loadUserStack(userId) {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        const userStack = await window.getUserStack(sessionToken, currentUser, userId);

        // Use cached stack types (should be loaded when the Users tab was
        // opened, same cache Organizations already populates); fall back to
        // loading them now if the cache is empty for some reason.
        if (!cachedStackTypes) {
            await loadAndCacheStackTypes();
        }
        displayUserStack(userStack, userId, cachedStackTypes || {});
    } catch (error) {
        console.error('Error loading user stack:', error);
    }
}

function displayUserStack(userStack, userId, stackTypes) {
    const stackCell = document.getElementById('userStackCell');
    if (!stackCell) {
        console.error('userStackCell not found for user stack');
        return;
    }

    // Initialize in-memory stack from loaded data
    currentUserStack = userStack && typeof userStack === 'object' ? JSON.parse(JSON.stringify(userStack)) : {};

    // Ensure all categories exist as arrays
    ['rmm', 'psa', 'control', 'rpa', 'bdr', 'sec'].forEach(cat => {
        if (!Array.isArray(currentUserStack[cat])) currentUserStack[cat] = [];
    });

    _initialUserStackJson = JSON.stringify(currentUserStack);

    const categories = [
        { key: 'rmm', label: 'RMM', types: stackTypes.rmm || [] },
        { key: 'psa', label: 'PSA', types: stackTypes.psa || [] },
        { key: 'control', label: 'Control', types: stackTypes.control || [] },
        { key: 'rpa', label: 'RPA', types: stackTypes.rpa || [] },
        { key: 'bdr', label: 'BDR', types: stackTypes.bdr || [] },
        { key: 'sec', label: 'SEC', types: stackTypes.sec || [] }
    ];

    // Build the stack pod, matching the Groups pod's own panel-level-3 styling
    stackCell.innerHTML = `
        <div class="panel-level-3" style="display: flex; flex-direction: column; gap: 10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <h3 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Tech Stack</h3>
                <button class="btn" data-color="green" data-size="sm" id="addUserStackEntryBtn">+ Add</button>
            </div>
            <div id="userStackEntriesList" style="display:flex;flex-direction:column;gap:6px;"></div>
        </div>`;

    function renderStackEntries() {
        const list = document.getElementById('userStackEntriesList');
        if (!list) return;
        list.innerHTML = '';
        let hasAny = false;
        categories.forEach(({ key, label, types }) => {
            (currentUserStack[key] || []).forEach((entry, idx) => {
                hasAny = true;
                const row = document.createElement('div');
                row.style.cssText = 'display:grid;grid-template-columns:100px 1fr 1fr 28px;gap:6px;align-items:center;';
                row.innerHTML = `
                    <div style="font-size:11px;color:var(--text-muted);font-weight:600;">${label}</div>
                    <select style="font-size:12px;width:100%;">
                        <option value="">-- Not Set --</option>
                        ${types.map(t => `<option value="${t.type_id}" ${entry.type_id == t.type_id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
                    </select>
                    <input type="text" value="${escapeHtml(String(entry.id || ''))}" placeholder="Username" style="font-size:12px;width:100%;">
                    <button class="btn" data-color="red" data-size="sm" style="padding:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;">✕</button>
                `;
                const [, typeSelect, idInput, deleteBtn] = row.children;
                typeSelect.addEventListener('change', () => {
                    const t = types.find(t => String(t.type_id) === typeSelect.value);
                    currentUserStack[key][idx].type_id = typeSelect.value ? parseInt(typeSelect.value) : null;
                    currentUserStack[key][idx].name = t ? t.name : null;
                    checkUserUnsavedChanges();
                });
                idInput.addEventListener('input', () => {
                    currentUserStack[key][idx].id = idInput.value;
                    checkUserUnsavedChanges();
                });
                deleteBtn.addEventListener('click', () => {
                    currentUserStack[key].splice(idx, 1);
                    renderStackEntries();
                    checkUserUnsavedChanges();
                });
                list.appendChild(row);
            });
        });
        if (!hasAny) {
            list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No stack entries configured.</div>';
        }
    }

    document.getElementById('addUserStackEntryBtn').addEventListener('click', () => {
        // Build category + type selector modal
        const catOptions = categories.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
        window.showModal({
            title: 'Add Stack Entry',
            content: `
                <div style="display:flex;flex-direction:column;gap:12px;">
                    <div>
                        <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px;">Category</label>
                        <select id="newUserStackCat" style="width:100%;font-size:12px;">${catOptions}</select>
                    </div>
                    <div>
                        <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px;">Type</label>
                        <select id="newUserStackType" style="width:100%;font-size:12px;"></select>
                    </div>
                    <div>
                        <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px;">Username</label>
                        <input type="text" id="newUserStackId" style="width:100%;font-size:12px;" placeholder="Username in this tool">
                    </div>
                </div>`,
            closeOnBackdrop: false,
            buttons: [
                { label: 'Cancel', type: 'secondary', onClick: () => {} },
                { label: 'Add', type: 'success', onClick: () => {
                    const cat = document.getElementById('newUserStackCat').value;
                    const typeSelect = document.getElementById('newUserStackType');
                    const id = document.getElementById('newUserStackId').value.trim();
                    const catDef = categories.find(c => c.key === cat);
                    const selectedType = catDef.types.find(t => String(t.type_id) === typeSelect.value);
                    if (!currentUserStack[cat]) currentUserStack[cat] = [];
                    currentUserStack[cat].push({
                        type_id: selectedType ? parseInt(typeSelect.value) : null,
                        name: selectedType ? selectedType.name : null,
                        id: id || null
                    });
                    renderStackEntries();
                    checkUserUnsavedChanges();
                }}
            ]
        });

        // Populate type dropdown based on selected category
        function updateTypeOptions() {
            const cat = document.getElementById('newUserStackCat')?.value;
            const typeSelect = document.getElementById('newUserStackType');
            if (!typeSelect) return;
            const catDef = categories.find(c => c.key === cat);
            const types = catDef?.types || [];
            typeSelect.innerHTML = `<option value="">-- Not Set --</option>` +
                types.map(t => `<option value="${t.type_id}">${escapeHtml(t.name)}</option>`).join('');
        }
        setTimeout(() => {
            updateTypeOptions();
            document.getElementById('newUserStackCat')?.addEventListener('change', updateTypeOptions);
        }, 50);
    });

    renderStackEntries();
}

async function saveOrganizationDetails(orgId) {
    const orgName = document.getElementById('orgNameInput').value;
    const status = document.getElementById('orgStatusInput').checked ? 1 : 0;
    
    if (!orgName.trim()) {
        window.showStatusBanner('Organization name cannot be empty', 'error', 'orgsStatusMessage');
        return;
    }
    
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }
        
        
        // Update orgs table (name, status, and stack JSON)
        const stackJson = JSON.stringify(currentOrgStack).replace(/'/g, "''");
        const orgQuery = `UPDATE kore_data.orgs SET org_name = '${orgName.replace(/'/g, "''")}', inactive = ${status}, stack = '${stackJson}' WHERE org_id = ${orgId}`;
        
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

        // NOTE: org_stack table is deprecated post-Rewst — no longer written here.

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


/**
 * The Settings page's tab list, read from the DOM's own tab-navigation
 * buttons (via each button's data-tab attribute) rather than a separate
 * hand-kept array or a server endpoint - the buttons are already the single
 * source of truth for "which tabs exist", so this is what both the batched
 * permission-gating check below AND the Permissions tab's item picker for
 * the 'settings' resource (see populatePermItemSelect) read from.
 * @returns {Array<{tab: string, label: string}>}
 */
function getSettingsTabs() {
    return Array.from(document.querySelectorAll('.tab-navigation .tab-btn[data-tab]')).map(btn => ({
        tab: btn.dataset.tab,
        label: btn.textContent.trim()
    }));
}

/**
 * Gates the Settings page's tabs for the current user in one batched
 * has-permission check (resource: 'settings', action: 'view', one scope per
 * tab) instead of a separate round trip per tab. Hides any tab button the
 * user isn't allowed to see, and sets window.__tabGate so switchTab()
 * (base.js) also refuses to switch to a hidden tab even via a direct call
 * (e.g. the General tab's own onclick, which bypasses switchTabWithUnsavedCheck).
 *
 * Fails closed: if the batch request itself fails outright (network error,
 * non-2xx), checkUserPermissions() returns an empty map, and every tab here
 * is treated as denied rather than allowed - consistent with
 * checkUserPermission()'s own error handling (also fails closed).
 *
 * The nav starts hidden (settings.html sets display:none on
 * #settingsTabNav) and is only revealed in the `finally` below, once every
 * button has already been shown/hidden per the check's result - the user's
 * full set of allowed tabs appears at once, with no reserved empty space
 * and no flash of buttons that then disappear.
 */
async function applySettingsTabGating() {
    const tabNav = document.getElementById('settingsTabNav');
    try {
        const tabs = getSettingsTabs();
        if (tabs.length === 0 || !currentUser) return;

        const checks = tabs.map(t => ({ resource: 'settings', action: 'view', scope: t.tab }));
        const allowed = await window.checkUserPermissions(currentUser, checks);

        window.__tabGate = {};
        let activeTabDenied = false;

        tabs.forEach(t => {
            const panelId = t.tab + 'Tab';
            const isAllowed = allowed[t.tab] === true;
            window.__tabGate[panelId] = isAllowed;

            const btn = document.querySelector(`.tab-navigation .tab-btn[data-tab="${t.tab}"]`);
            if (!btn) return;
            btn.style.display = isAllowed ? '' : 'none';
            if (!isAllowed && btn.classList.contains('active')) activeTabDenied = true;
        });

        // If the tab active on load (General, by default) turned out to be
        // denied, switch to the first tab the user IS allowed to see instead
        // of leaving a hidden tab's panel showing.
        if (activeTabDenied) {
            const firstAllowed = tabs.find(t => window.__tabGate[t.tab + 'Tab']);
            const btn = firstAllowed && document.querySelector(`.tab-navigation .tab-btn[data-tab="${firstAllowed.tab}"]`);
            btn?.click();
        }
    } finally {
        // Reveal regardless of outcome (including an early return above or
        // an unexpected error) - otherwise a failure here would leave the
        // nav permanently hidden instead of just failing closed on tabs.
        if (tabNav) tabNav.style.display = '';
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
    switchTabWithUnsavedCheck('utilitiesTab', event, async () => {
        await loadSystemHealth();
        await loadMaintenanceConfig();
    });
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

// ============================================================================
// NIGHTLY MAINTENANCE FUNCTIONS
// ============================================================================

let currentMaintConfig = null;   // { nightly: {time}, weekly: {time, dayOfWeek}, monthly: {time, dayOfMonth} }
let currentMaintTasks = [];      // rows from maint_tasks

/**
 * Load both the schedule config (system_config.maint_config) and the task
 * list (maint_tasks), and render them into the Nightly Maintenance pod.
 */
async function loadMaintenanceConfig() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        const configResult = await executeSqlQuery(
            sessionToken,
            currentUser,
            'kore_sys',
            'SELECT maint_config FROM system_config'
        );

        let maintConfig = { nightly: { time: '02:00' }, weekly: { time: '03:00', dayOfWeek: 0 }, monthly: { time: '04:00', dayOfMonth: 1 } };
        if (configResult && configResult.result && configResult.result.length > 0) {
            const raw = configResult.result[0].maint_config;
            try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (parsed) maintConfig = parsed;
            } catch (e) {
                console.warn('Could not parse maint_config, using defaults:', e);
            }
        }
        currentMaintConfig = maintConfig;

        populateMaintenanceMonthlyDaySelect();
        populateMaintenanceSchedule();

        const tasksResult = await executeSqlQuery(
            sessionToken,
            currentUser,
            'kore_sys',
            'SELECT task_id, display_name, description, cadence, enabled FROM maint_tasks ORDER BY display_name'
        );

        currentMaintTasks = (tasksResult && tasksResult.result) ? tasksResult.result : [];
        renderMaintenanceTasksList();

        // Initialize unsaved tracking for the schedule form only - the task
        // list auto-saves per row and isn't part of this dirty-tracking.
        setTimeout(() => {
            window.initializeUnsavedTracking(getMaintenanceScheduleFormData());
            const saveBtn = document.getElementById('maintScheduleSaveBtn');
            if (saveBtn) saveBtn.disabled = true;
        }, 0);
    } catch (error) {
        console.error('Error loading maintenance config:', error);
        window.showStatusBanner('Error loading maintenance configuration: ' + error.message, 'error', 'utilitiesStatusMessage');
    }
}

/**
 * Populate the Monthly day-of-month <select> with options 1-28. Capped at
 * 28 (rather than 31) so every month actually has that day - a value like
 * 30 or 31 would silently not exist in February, April, etc.
 */
function populateMaintenanceMonthlyDaySelect() {
    const select = document.getElementById('maintMonthlyDay');
    if (!select) return;

    select.innerHTML = '';
    for (let day = 1; day <= 28; day++) {
        const option = document.createElement('option');
        option.value = day.toString();
        option.textContent = day.toString();
        select.appendChild(option);
    }
}

/**
 * Populate the schedule time/day fields from currentMaintConfig.
 */
function populateMaintenanceSchedule() {
    if (!currentMaintConfig) return;

    const nightly = currentMaintConfig.nightly || {};
    const weekly = currentMaintConfig.weekly || {};
    const monthly = currentMaintConfig.monthly || {};

    document.getElementById('maintNightlyTime').value = nightly.time || '02:00';
    document.getElementById('maintWeeklyTime').value = weekly.time || '03:00';
    document.getElementById('maintWeeklyDay').value = (weekly.dayOfWeek !== undefined && weekly.dayOfWeek !== null) ? weekly.dayOfWeek.toString() : '0';
    document.getElementById('maintMonthlyTime').value = monthly.time || '04:00';
    document.getElementById('maintMonthlyDay').value = (monthly.dayOfMonth !== undefined && monthly.dayOfMonth !== null) ? monthly.dayOfMonth.toString() : '1';

    // Set up change detection now that fields have values
    document.querySelectorAll('.maint-schedule-input').forEach(input => {
        input.addEventListener('input', checkMaintenanceScheduleUnsavedChanges);
        input.addEventListener('change', checkMaintenanceScheduleUnsavedChanges);
    });
}

/**
 * Read the current schedule form fields into the maint_config JSON shape.
 */
function getMaintenanceScheduleFormData() {
    return {
        nightly: {
            time: document.getElementById('maintNightlyTime').value || '02:00'
        },
        weekly: {
            time: document.getElementById('maintWeeklyTime').value || '03:00',
            dayOfWeek: parseInt(document.getElementById('maintWeeklyDay').value, 10)
        },
        monthly: {
            time: document.getElementById('maintMonthlyTime').value || '04:00',
            dayOfMonth: parseInt(document.getElementById('maintMonthlyDay').value, 10)
        }
    };
}

function checkMaintenanceScheduleUnsavedChanges() {
    const currentData = getMaintenanceScheduleFormData();
    window.checkUnsavedChanges(currentData);

    const saveBtn = document.getElementById('maintScheduleSaveBtn');
    if (saveBtn) {
        saveBtn.disabled = !window.hasUnsavedChanges();
    }
}

/**
 * Save the schedule times/days back to system_config.maint_config.
 */
async function saveMaintenanceSchedule() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        const formData = getMaintenanceScheduleFormData();
        const configJson = JSON.stringify(formData);
        const escapedJson = window.escapeSql(configJson);

        const updateSql = `UPDATE system_config SET maint_config = '${escapedJson}'`;
        await executeSqlQuery(sessionToken, currentUser, 'kore_sys', updateSql);

        currentMaintConfig = formData;

        window.initializeUnsavedTracking(formData);
        checkMaintenanceScheduleUnsavedChanges();

        window.showStatusBanner('Maintenance schedule saved successfully', 'success', 'utilitiesStatusMessage');
    } catch (error) {
        console.error('Error saving maintenance schedule:', error);
        window.showStatusBanner('Error saving maintenance schedule: ' + error.message, 'error', 'utilitiesStatusMessage');
    }
}

/**
 * Render the maintenance task rows into the table body. Each row has a
 * cadence radio group (Nightly/Weekly/Monthly) and an Enabled checkbox,
 * both unlabeled (the table headers serve as the labels). Changes to
 * either auto-save that individual row.
 */
function renderMaintenanceTasksList() {
    const tbody = document.getElementById('maintTasksTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (currentMaintTasks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="color: var(--text-muted); font-size: 12px;">No maintenance tasks configured.</td></tr>';
        return;
    }

    currentMaintTasks.forEach(task => {
        const row = document.createElement('tr');
        row.className = 'maint-task-row';
        row.setAttribute('data-task-id', task.task_id);

        const cadences = ['nightly', 'weekly', 'monthly'];
        const radioCells = cadences.map(cadence => `
            <td style="text-align: center;">
                <input type="radio" name="maint-cadence-${task.task_id}" class="maint-task-cadence" value="${cadence}" ${task.cadence === cadence ? 'checked' : ''}>
            </td>
        `).join('');

        const tooltipText = window.escapeHtml(task.description || '');
        const escapedTaskId = window.escapeHtml(task.task_id);
        const escapedDisplayName = window.escapeHtml(task.display_name);

        row.innerHTML = `
            <td>
                <span style="color: var(--text-primary);">${escapedDisplayName}</span>
                ${task.description ? `
                    <span class="info-icon" data-tooltip="${tooltipText}" style="display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; background-color: var(--border-primary); color: var(--text-primary); font-size: 10px; font-style: italic; font-weight: 700; cursor: help; margin-left: 6px; vertical-align: middle;">i</span>
                ` : ''}
                <span class="maint-task-save-indicator" style="margin-left: 8px; font-size: 11px; font-weight: 600;"></span>
            </td>
            ${radioCells}
            <td style="text-align: center;">
                <input type="checkbox" class="maint-task-enabled" ${task.enabled ? 'checked' : ''}>
            </td>
            <td style="text-align: center;">
                <button type="button" class="btn" data-color="blue" data-size="sm" onclick="confirmRunMaintenanceTask('${escapedTaskId}', '${escapedDisplayName}')">Run</button>
            </td>
        `;

        tbody.appendChild(row);

        // Auto-save this row's cadence/enabled state on change
        row.querySelectorAll('.maint-task-cadence, .maint-task-enabled').forEach(input => {
            input.addEventListener('change', () => saveMaintenanceTaskRow(task.task_id, row));
        });
    });

    attachInfoTooltipHandlers(tbody);
}

/**
 * Show a confirmation modal before manually running a maintenance task.
 */
function confirmRunMaintenanceTask(taskId, displayName) {
    const message = `This will run "${displayName}" immediately, regardless of its schedule or whether it already ran today. Continue?`;
    showConfirm('Run Maintenance Task', message, () => {
        runMaintenanceTaskNow(taskId, displayName);
    }, 'Run');
}

/**
 * POST to the server to trigger a single maintenance task immediately,
 * then show the result in the Utilities status banner.
 */
async function runMaintenanceTaskNow(taskId, displayName) {
    try {
        window.showStatusBanner(`Running "${displayName}"...`, 'info', 'utilitiesStatusMessage');

        const response = await fetch(`/kore/admin/run-maintenance-task?taskId=${encodeURIComponent(taskId)}`, {
            method: 'POST'
        });
        const data = await response.json();

        window.showStatusBanner(data.message || (response.ok ? 'Task completed' : 'Task failed'), response.ok ? 'success' : 'error', 'utilitiesStatusMessage');
    } catch (error) {
        console.error('Error running maintenance task:', error);
        window.showStatusBanner('Error running task: ' + error.message, 'error', 'utilitiesStatusMessage');
    }
}

let activeInfoTooltipEl = null;

/**
 * Wire up hover tooltips for any .info-icon elements within a container,
 * using the .info-tooltip / .info-icon classes already defined in
 * base_css.js's componentStyles.
 */
function attachInfoTooltipHandlers(container) {
    container.querySelectorAll('.info-icon').forEach(icon => {
        icon.addEventListener('mouseenter', (e) => showInfoTooltip(e.currentTarget));
        icon.addEventListener('mouseleave', hideInfoTooltip);
    });
}

function showInfoTooltip(iconEl) {
    hideInfoTooltip();

    const text = iconEl.getAttribute('data-tooltip');
    if (!text) return;

    const tooltip = document.createElement('div');
    tooltip.className = 'info-tooltip';
    tooltip.textContent = text;
    document.body.appendChild(tooltip);

    const rect = iconEl.getBoundingClientRect();
    tooltip.style.left = `${rect.left}px`;
    tooltip.style.top = `${rect.bottom + 6}px`;

    activeInfoTooltipEl = tooltip;
}

function hideInfoTooltip() {
    if (activeInfoTooltipEl) {
        activeInfoTooltipEl.remove();
        activeInfoTooltipEl = null;
    }
}

/**
 * Auto-save a single task row's cadence/enabled state. Feedback is a brief
 * inline indicator next to the task name, rather than the shared status
 * banner - each row is an independent toggle, not a batch form, so this
 * intentionally doesn't follow the Save-button + banner pattern used by the
 * Schedule Times section above.
 */
async function saveMaintenanceTaskRow(taskId, row) {
    const indicator = row.querySelector('.maint-task-save-indicator');

    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        const cadenceInput = row.querySelector('.maint-task-cadence:checked');
        const enabledInput = row.querySelector('.maint-task-enabled');

        const cadence = cadenceInput ? cadenceInput.value : 'nightly';
        const enabled = enabledInput ? enabledInput.checked : true;

        const updateSql = `UPDATE maint_tasks SET cadence = '${window.escapeSql(cadence)}', enabled = ${enabled ? 'TRUE' : 'FALSE'} WHERE task_id = '${window.escapeSql(taskId)}'`;
        await executeSqlQuery(sessionToken, currentUser, 'kore_sys', updateSql);

        // Keep local cache in sync
        const task = currentMaintTasks.find(t => t.task_id === taskId);
        if (task) {
            task.cadence = cadence;
            task.enabled = enabled;
        }

        showMaintenanceTaskSaveIndicator(indicator, '✓ Saved', 'var(--status-green)');
    } catch (error) {
        console.error('Error saving maintenance task:', error);
        showMaintenanceTaskSaveIndicator(indicator, '✕ Error saving', 'var(--status-red-input)', 4000);
    }
}

/**
 * Show a brief inline save-status message next to a task row, then clear it.
 */
function showMaintenanceTaskSaveIndicator(indicator, text, color, durationMs = 1500) {
    if (!indicator) return;

    indicator.textContent = text;
    indicator.style.color = color;

    if (indicator._clearTimeout) {
        clearTimeout(indicator._clearTimeout);
    }
    indicator._clearTimeout = setTimeout(() => {
        indicator.textContent = '';
    }, durationMs);
}

function switchToOrganizationsTab(event) {
    switchTabWithUnsavedCheck('organizationsTab', event, () => {
        loadOrganizationsList();
        loadAndCacheStackTypes();
    });
}

/**
 * Category list for the Org Stack UI. Each maps to a row's `category`
 * value in the unified kore_data.stack_types table, and to a key in the
 * orgs.stack JSON column (currentOrgStack.rmm, .psa, etc. - each an array
 * of {type_id, name, id} entries). To add a new stack category in the
 * future, add it here plus the matching entries in the two `categories`
 * arrays (displayOrgStack and showAddOrganizationModal) and the two
 * currentOrgStack reset objects - no new table or getter function needed.
 */
const ORG_STACK_CATEGORIES = ['RMM', 'PSA', 'Control', 'RPA', 'BDR', 'SEC'];

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
        
        const results = await Promise.all(
            ORG_STACK_CATEGORIES.map(category => getStackTypes(sessionToken, currentUser, category))
        );
        
        cachedStackTypes = {};
        ORG_STACK_CATEGORIES.forEach((category, i) => {
            cachedStackTypes[category.toLowerCase()] = results[i];
        });
    } catch (error) {
        console.error('Error caching stack types:', error);
    }
}

// ============================================================================
// EMAIL CONFIGURATION FUNCTIONS
// Profile list is read from the 'smtp' PLUGIN (plugins table,
// config.smtp_profiles as an object keyed by profile name) - see the
// Plugins tab for host/port/credential configuration, not managed here.
//
// This pod assigns which profile handles which PURPOSE (starting with just
// "System Alerts", more purposes can be added later). That assignment is
// saved to system_config.email_config as { "system_alerts": "<profileName>" }
// - a deliberate repurposing of that column: it used to hold full SMTP
// profile objects (host/port/credentials) for kore.js's own separate
// built-in /kore/email/smtp system; now that credentials live in the smtp
// plugin's secure_config, this column instead just maps purpose -> profile
// name. Saving here OVERWRITES whatever was in email_config before,
// including any old profile data left over from before this rework.
// ============================================================================

let currentEmailConfig = null;          // The 'smtp' plugin's full config object
let currentEmailProfile = null;         // Currently-selected profile name (dropdown)
let originalSystemAlertsProfile = null; // The profile name loaded from system_config.email_config

async function loadEmailConfig() {
    try {
        const plugin = await window.getPluginDetails('smtp');
        currentEmailConfig = plugin.config || {};
        if (!currentEmailConfig.smtp_profiles) {
            currentEmailConfig.smtp_profiles = {};
        }

        populateEmailProfileDropdown();
        await loadSystemAlertsProfileSelection();
    } catch (error) {
        console.error('Error loading email config:', error);
        window.showStatusBanner('Error loading email configuration: ' + error.message, 'error', 'generalStatusMessage');
    }
}

/**
 * Read the current System Alerts profile assignment from
 * system_config.email_config and pre-select it in the dropdown. Tolerates
 * the column being empty, null, or (from before this rework) holding the
 * old smtp_profiles-array shape - either way, if there's no recognizable
 * "system_alerts" key, the dropdown just starts unselected.
 */
async function loadSystemAlertsProfileSelection() {
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

        let emailConfig = null;
        if (result && result.result && result.result.length > 0 && result.result[0].email_config) {
            try {
                emailConfig = typeof result.result[0].email_config === 'string'
                    ? JSON.parse(result.result[0].email_config)
                    : result.result[0].email_config;
            } catch (parseErr) {
                console.error('email_config did not parse as JSON:', parseErr);
            }
        }

        originalSystemAlertsProfile = (emailConfig && typeof emailConfig.system_alerts === 'string')
            ? emailConfig.system_alerts
            : null;

        const select = document.getElementById('emailProfileSelect');
        if (select && originalSystemAlertsProfile) {
            select.value = originalSystemAlertsProfile;
        }
        switchEmailProfile();
    } catch (error) {
        console.error('Error loading system alerts profile selection:', error);
        originalSystemAlertsProfile = null;
    }
}

function populateEmailProfileDropdown() {
    const select = document.getElementById('emailProfileSelect');
    select.innerHTML = '<option value="">Select a profile...</option>';

    const profiles = (currentEmailConfig && currentEmailConfig.smtp_profiles) || {};
    Object.keys(profiles).forEach((profileName) => {
        const option = document.createElement('option');
        option.value = profileName;
        option.textContent = profileName;
        select.appendChild(option);
    });
}

function switchEmailProfile() {
    const profileName = document.getElementById('emailProfileSelect').value;
    currentEmailProfile = profileName || null;

    const testBtn = document.getElementById('emailTestBtn');
    if (testBtn) {
        testBtn.disabled = !currentEmailProfile;
    }

    const saveBtn = document.getElementById('emailSaveBtn');
    if (saveBtn) {
        saveBtn.disabled = (currentEmailProfile || null) === (originalSystemAlertsProfile || null);
    }
}

/**
 * Save the System Alerts profile assignment to system_config.email_config,
 * overwriting the column entirely with { "system_alerts": "<profileName>" }.
 */
async function saveEmailPurposeConfig() {
    try {
        if (!sessionToken) {
            sessionToken = await getSessionToken();
        }

        const emailConfig = { system_alerts: currentEmailProfile || null };
        const emailConfigJson = JSON.stringify(emailConfig);
        const escapedJson = emailConfigJson.replace(/'/g, "''");
        const updateSql = `UPDATE system_config SET email_config = '${escapedJson}'`;

        await executeSqlQuery(sessionToken, currentUser, 'kore_sys', updateSql);

        originalSystemAlertsProfile = currentEmailProfile || null;
        const saveBtn = document.getElementById('emailSaveBtn');
        if (saveBtn) saveBtn.disabled = true;

        window.showStatusBanner('System Alerts profile saved', 'success', 'generalStatusMessage');
    } catch (error) {
        console.error('Error saving system alerts profile:', error);
        window.showStatusBanner('Error saving system alerts profile: ' + error.message, 'error', 'generalStatusMessage');
    }
}

/**
 * Send a test email through the 'smtp' PLUGIN's own route directly
 * (POST /email/smtp), NOT through base.js's shared emailSmtp() helper -
 * that targets kore.js's own separate built-in SMTP system
 * (/kore/email/smtp, backed by system_config.email_config), a different,
 * unrelated mechanism intentionally left alone by this rework.
 */
async function sendTestEmailViaPlugin(profileName, to, subject, html, plainText) {
    if (!sessionToken) {
        sessionToken = await getSessionToken();
    }

    const response = await fetch('https://app.equinoxits.com:1139/email/smtp', {
        method: 'POST',
        headers: {
            'X-Session-Token': sessionToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            profile_name: profileName,
            to,
            subject,
            html,
            plainText
        })
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
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
                <input type="email" id="testEmailInput" placeholder="recipient@example.com" style="width: 100%; padding: 6px; background-color: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 4px; color: var(--text-input);">
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
                        
                        // Send test email through the plugin's own route
                        await sendTestEmailViaPlugin(
                            currentEmailProfile,
                            testEmail,
                            'Test Email',
                            '<h2>Test Email</h2><p>This is a test email from Kore System Settings.</p>',
                            'Test Email from Kore System Settings.'
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
        color: var(--text-input);
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

        // Gate tabs before anything else runs, so a denied tab is hidden
        // (and, if it was the one active by default, swapped out for an
        // allowed one) before the rest of init potentially loads data for it.
        if (document.querySelector('.tab-navigation')) {
            await applySettingsTabGating();
        }

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

    // Collect checked parent groups (which groups this group inherits from)
    const selectedParentIds = [];
    if (window.cachedGroups) {
        window.cachedGroups.forEach(group => {
            if (group.groupId === groupId) return; // can't be its own parent
            const checkbox = document.getElementById(`parentgroup_${group.groupId}`);
            if (checkbox && checkbox.checked) {
                selectedParentIds.push(group.groupId);
            }
        });
    }
    
    try {
        const response = await fetch(`/groups/${groupId}`, {
                                       method: 'PUT',
                                       headers: { 'Content-Type': 'application/json' },
                                       body: JSON.stringify({
                                           groupName: name.trim(),
                                           description: description.trim(),
                                           active: active,
                                           groupIds: selectedParentIds
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
    if (window.hasUnsavedChanges() && currentUserDetail && currentUserDetail.userId != userId) {
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
    const stackChanged = JSON.stringify(currentUserStack) !== _initialUserStackJson;
    
    if (emailChanged || nameChanged || activeChanged || stackChanged) {
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
        const response = await fetch(`/kore/users/${encodeURIComponent(userId)}/permissions`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const permissions = await response.json();

        if (!permissions.length) {
            tableContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; margin: 0;">No permissions found for this user.</p>';
            return;
        }

        const buildRows = (perms) => perms.map(p => {
            const fmt = (val) => val === '*' ? 'All' : val ? (val.charAt(0).toUpperCase() + val.slice(1)) : '—';
            const scopeVal = p.scope_name || p.scope;
            const scopeDisplay = (!scopeVal || scopeVal === '*') ? 'All' : escapeHtml(scopeVal);
            const effectColor = p.effect === 'deny' ? 'color: var(--color-red, #e55);' : 'color: var(--color-green, #5a5);';
            const sourceDisplay = p.source?.type === 'group' ? escapeHtml(`Group: ${p.source.groupName || p.source.groupId}`) : 'User';
            return `<tr><td>${escapeHtml(p.resource || '—')}</td><td>${scopeDisplay}</td><td>${escapeHtml(fmt(p.action))}</td><td style="${effectColor} font-weight:600;">${escapeHtml(fmt(p.effect))}</td><td>${sourceDisplay}</td></tr>`;
        }).join('');

        const thStyle = 'text-transform:uppercase;letter-spacing:0.5px;font-size:11px;color:var(--text-muted);';
        const buildTable = (rows) => {
            return `<div class="panel-level-2" style="width:fit-content;"><table style="font-size:11px;width:auto;"><thead><tr><th style="${thStyle}">Resource</th><th style="${thStyle}">Scope</th><th style="${thStyle}">Action</th><th style="${thStyle}">Effect</th><th style="${thStyle}">Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
        };

        tableContainer.innerHTML = buildTable(buildRows(permissions));

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

        // Persist the tech stack. This goes through a direct SQL UPDATE
        // (like Organizations' stack) rather than the /users PUT above,
        // since that REST endpoint predates the stack column and only
        // handles email/fullName/active/groupIds.
        try {
            if (!sessionToken) {
                sessionToken = await getSessionToken();
            }
            const stackJson = JSON.stringify(currentUserStack).replace(/'/g, "''");
            const escapedUserId = String(userId).replace(/'/g, "''");
            const stackResult = await executeSqlQuery(
                sessionToken,
                currentUser,
                'kore_sys',
                `UPDATE kore_sys.users SET stack = '${stackJson}' WHERE userId = '${escapedUserId}'`
            );
            if (!stackResult.success) {
                window.showStatusBanner('User updated, but failed to save tech stack: ' + (stackResult.error || 'Unknown error'), 'error', 'usersStatusMessage');
                return;
            }
            _initialUserStackJson = JSON.stringify(currentUserStack);
        } catch (stackError) {
            console.error('Error saving user stack:', stackError);
            window.showStatusBanner('User updated, but failed to save tech stack: ' + stackError.message, 'error', 'usersStatusMessage');
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

/**
 * Show/hide the inline Set Password form. Always clears the fields on toggle
 * so a typed-but-abandoned password never sits in the DOM after Cancel, and
 * so reopening the form doesn't present stale values as if they were saved.
 */
function toggleSetPasswordForm(userId) {
    const form = document.getElementById('setPasswordForm');
    if (!form) return;

    const showing = form.style.display !== 'none';

    document.getElementById('adminNewPassword').value = '';
    document.getElementById('adminConfirmPassword').value = '';
    document.getElementById('adminForceChange').checked = false;

    form.style.display = showing ? 'none' : 'flex';

    if (!showing) {
        document.getElementById('adminNewPassword').focus();
    }
}

/**
 * Admin sets a new password for another user.
 * Only the match check happens here - format rules and the no-reuse history
 * check are enforced server-side in adminSetPassword(), and their messages
 * are surfaced verbatim so the admin sees the actual reason.
 */
async function submitSetPassword(userId) {
    const newPassword = document.getElementById('adminNewPassword').value;
    const confirmPassword = document.getElementById('adminConfirmPassword').value;
    const forceChange = document.getElementById('adminForceChange').checked;

    if (!newPassword) {
        window.showStatusBanner('New password is required', 'error', 'usersStatusMessage');
        return;
    }

    if (newPassword !== confirmPassword) {
        window.showStatusBanner('Passwords do not match', 'error', 'usersStatusMessage');
        return;
    }

    if (!confirm("Set a new password for this user? They will be signed out of all devices.")) return;

    try {
        const response = await fetch(`/admin/users/${userId}/set-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword, forceChange })
        });

        const data = await response.json();

        if (!response.ok) {
            window.showStatusBanner('Error setting password: ' + (data.error || 'Unknown error'), 'error', 'usersStatusMessage');
            return;
        }

        // Report what actually happened rather than a bare success - the
        // endpoint also unlocks and revokes sessions, and the admin should
        // know that without having to go looking.
        let message = 'Password set successfully';
        if (data.sessionsRevoked) {
            message += `. ${data.sessionsRevoked} session(s) revoked`;
        }
        if (data.unlocked) {
            message += '. Account unlocked';
        }
        if (data.forceChange) {
            message += '. User must change password at next login';
        }

        toggleSetPasswordForm(userId);
        window.showStatusBanner(message, 'success', 'usersStatusMessage');
        loadUsersList();
    } catch (error) {
        console.error('Error setting password:', error);
        window.showStatusBanner('Error setting password: ' + error.message, 'error', 'usersStatusMessage');
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
// Moved to user.js - see that file for switchToUserPreferencesTab,
// loadUserPreferences, saveUserPreferencesData, updateUserPrefsSaveButtonState,
// checkUserPrefUnsavedChanges, checkNotificationUnsavedChanges,
// checkPasswordUnsavedChanges, and changeUserPassword.

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
/**
 * Fetches and caches the permission_resources catalog (Stage A's endpoint -
 * see Permissions System Guide.md §9). Cached in window.cachedPermissionResources
 * for the rest of the tab's session - the catalog changes rarely (only when
 * a developer adds a new resource type), so re-fetching on every
 * displayPermissions() call would be wasteful. Keyed by resource name for
 * O(1) lookup in getValidActionsFor() below.
 */
async function loadPermissionResourcesCatalog() {
    try {
        const response = await fetch('/kore/permission-resources', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const resources = await response.json();
        window.cachedPermissionResources = {};
        resources.forEach(r => { window.cachedPermissionResources[r.resource] = r; });
    } catch (error) {
        console.error('[Settings] Error loading permission resources catalog:', error);
        window.cachedPermissionResources = {};
    }
}

/**
 * validActions for a given resource, straight from the catalog. Unlike
 * before, '*' is NOT filtered out here - createPermissionRow() now decides
 * whether to render its "Full" option based on whether '*' is present in
 * this array, so the catalog's own validActions is what should drive that,
 * not an unconditional add on the rendering side. Resources that don't
 * declare '*' (e.g. 'settings', 'page' - both ["view"] only) now correctly
 * get no Full option. Falls back to null (no action dropdown at all,
 * matching today's pre-Stage-B behavior) if the catalog hasn't loaded or
 * doesn't have an entry for this resource yet.
 */
function getValidActionsFor(permType) {
    const entry = window.cachedPermissionResources?.[permType];
    if (!entry || !Array.isArray(entry.validActions)) return null;
    return entry.validActions.length > 0 ? entry.validActions : null;
}

/**
 * Unified Permissions pod - single catalog-driven resource selector
 * (Stage C, revised - see Permissions System Guide.md §9). Originally
 * built as two separate pods (a dedicated Page Permissions pod plus a
 * second "Feature Permissions" selector for everything else) - the
 * design was never fully settled, this consolidates into one selector
 * that includes 'page' as just another catalog entry.
 *
 * 'page' now goes through the exact same generic flow as every other
 * resource - its item list comes from /kore/page-permissions (via the
 * catalog's own scopeSourceEndpoint, same mechanism as any other
 * instance-scoped resource), and its existing grants come from the same
 * POST /kore/permissions {resource, scope} query everything else uses,
 * not the old combined-response shortcut. The one thing still page-
 * specific: IP allowlisting (kore_sys.web_pages.allowedIPs) is a wholly
 * separate concept from kore_sys.permissions grants, so it's shown/saved
 * conditionally alongside the permissions list only when resource==='page',
 * rather than generalized - nothing else in the catalog has an equivalent
 * concept to generalize it against.
 *
 * Composes base.js's generic functions directly:
 *   - loadPermissionsForResource({endpoint, method, body})
 *   - displayPermissionsForm(container, existingPermissions, {actions, onSave})
 *   - savePermissionsForResource({resource, endpoint}, scope, container)
 *   - displayAllowedIPsForm/saveAllowedIPs (page-only, unchanged from before)
 *
 * Unsaved-change tracking is intentionally simpler than the old page-only
 * version (which distinguished permission-row changes, whitelist-checkbox
 * changes, IP-input changes, and add/delete-IP-button clicks with
 * separate delegated listeners, backed by window.initializeUnsavedTracking/
 * checkUnsavedChanges): any change anywhere in the permissions list or the
 * IP list just enables Save directly. Less granular, but uniform across
 * every resource type rather than page having bespoke tracking nothing
 * else gets.
 */
let _permCurrentResource = null;
let _permCurrentScope = null; // item id, or null for blanket resources

function initPermissionsPod() {
    const resourceSelect = document.getElementById('permResourceSelect');
    const itemSelect = document.getElementById('permItemSelect');
    const buttonsContainer = document.getElementById('permPermissionsButtons');
    const saveBtn = document.getElementById('savePermPermissionsBtn');
    const cancelBtn = document.getElementById('cancelPermPermissionsBtn');
    if (!resourceSelect || !itemSelect || !buttonsContainer || !saveBtn || !cancelBtn) return;

    // Repopulating the resource dropdown is safe (and necessary) on every
    // visit to the Permissions tab, since the catalog can change - it's
    // just innerHTML, not a listener.
    resourceSelect.innerHTML = '<option value="">Select a resource type...</option>';
    Object.values(window.cachedPermissionResources || {})
        .sort((a, b) => (a.label || '').localeCompare(b.label || ''))
        .forEach(r => {
            const option = document.createElement('option');
            option.value = r.resource;
            option.textContent = r.label;
            resourceSelect.appendChild(option);
        });

    // But wiring up event listeners is NOT safe to repeat: this whole
    // function re-runs every time the Permissions tab is opened
    // (loadPermissionsPage is the tab's loadCallback), while these elements
    // persist across tab switches rather than being recreated - so without
    // this guard, each visit stacks another 'change' listener on top of
    // the ones from every previous visit. That means a single item
    // selection then fires loadItemPermissions() once per past visit, and
    // since each call clears #allowedIPsList before awaiting its async IP
    // form (not immediately before appending), concurrent duplicate calls
    // each append their own copy instead of the last one winning - visible
    // as the IP whitelist form appearing N times for a page resource.
    if (resourceSelect.__permPodInitialized) return;
    resourceSelect.__permPodInitialized = true;

    resourceSelect.addEventListener('change', async (e) => {
        const resource = e.target.value;
        _permCurrentResource = resource || null;
        _permCurrentScope = null;
        resetPermissionsForm();

        if (!resource) return;

        const entry = window.cachedPermissionResources?.[resource];
        if (!entry) return;

        if (entry.scopeType === 'instance') {
            await populatePermItemSelect(entry);
            document.getElementById('permItemSelectGroup').style.display = '';
        } else {
            // Blanket resource - no item to pick, go straight to the grant list.
            // Scope is '*', NOT null: '*' is the system's global-scope convention,
            // and hasPermission() treats the two identically (scope = '*' OR scope
            // IS NULL OR scope = ?). But getPermissions() does not - a null filter
            // becomes `p.scope IS NULL` (auth.js), so a null here reads back only
            // null-scoped rows and silently hides every '*'-scoped grant on the
            // same resource. _permCurrentScope has to move with it, since the
            // fixed Save button below passes that variable, not this one.
            _permCurrentScope = '*';
            document.getElementById('permItemSelectGroup').style.display = 'none';
            await loadItemPermissions(resource, '*');
            buttonsContainer.style.display = 'flex';
        }
    });

    itemSelect.addEventListener('change', async (e) => {
        const itemId = e.target.value;
        _permCurrentScope = itemId || null;
        if (!itemId) {
            document.getElementById('permissionsList').innerHTML = '';
            document.getElementById('allowedIPsList').innerHTML = '';
            buttonsContainer.style.display = 'none';
            return;
        }
        await loadItemPermissions(_permCurrentResource, itemId);
        buttonsContainer.style.display = 'flex';
    });

    saveBtn.onclick = async () => {
        if (!_permCurrentResource) return;
        await savePermPermissions(_permCurrentResource, _permCurrentScope);
    };

    cancelBtn.onclick = () => {
        resourceSelect.value = '';
        _permCurrentResource = null;
        _permCurrentScope = null;
        resetPermissionsForm();
        document.getElementById('permItemSelectGroup').style.display = 'none';
    };

    // Delegated, attached once - both lists' innerHTML gets replaced
    // repeatedly as resources/items are switched, but the elements
    // themselves persist, so this correctly catches changes on whatever
    // dynamic content exists at any given moment without re-attachment.
    // Two listeners on permissionsList, not one: 'change' catches
    // target/action/effect dropdown edits, 'click' catches the
    // Delete button (marks an existing row via row.dataset.revoke, which
    // fires no 'change' event at all - clicking Delete alone would leave
    // Save disabled without this, even though the row was correctly marked).
    const permissionsListEl = document.getElementById('permissionsList');
    permissionsListEl.addEventListener('change', (e) => {
        if (e.target.closest('.permission-row')) saveBtn.disabled = false;
    });
    permissionsListEl.addEventListener('click', (e) => {
        if (e.target.closest('.permission-row')) saveBtn.disabled = false;
    });
    const allowedIPsList = document.getElementById('allowedIPsList');
    allowedIPsList.addEventListener('change', () => { saveBtn.disabled = false; });
    allowedIPsList.addEventListener('input', () => { saveBtn.disabled = false; });
    allowedIPsList.addEventListener('click', (e) => {
        if (e.target.classList.contains('btn')) setTimeout(() => { saveBtn.disabled = false; }, 10);
    });
}

function resetPermissionsForm() {
    document.getElementById('permissionsList').innerHTML = '';
    document.getElementById('allowedIPsList').innerHTML = '';
    document.getElementById('permPermissionsButtons').style.display = 'none';
    const itemSelect = document.getElementById('permItemSelect');
    if (itemSelect) itemSelect.innerHTML = '<option value="">Select...</option>';
}

/**
 * Populates the item picker for an instance-scoped resource, using the
 * catalog's own scopeSourceEndpoint/ValueField/LabelField - the same
 * {url, valueField, labelField} shape docs.js's RESOURCE_LIST_ENDPOINTS
 * already uses, deliberately reused rather than inventing a different
 * convention for this table.
 */
// Instance-scoped resources that support a blanket '*' scope grant (in
// addition to per-item grants) - see Permissions System Guide.md §9.
// A '*'-scope row is already handled end-to-end by the backend: auth.js
// normalizes scope '*' to NULL on both save and check, and a NULL-scope
// row matches every scope for that resource+action (hasPermissions(),
// auth.js ~line 1974). So adding the option here is purely a UI addition;
// no backend change is required. Deliberately NOT extended to page/doc/
// menu/settings - those don't have the same "blanket admin vs. granular
// per-item" need that prompted this for form/workflow/datatable_admin/
// plugin/plugin_task.
//
// NOT 'datatable': that resource is exclusively per-instance data-viewer
// permissions (view/add/edit/delete row DATA within one datatable), so a
// blanket '*' scope here has no sensible "any datatable" meaning to grant
// in bulk. Blanket OR granular create/edit/delete/view of datatable
// DEFINITIONS themselves lives on the separate 'datatable_admin' resource
// (now instance-scoped, same as form/workflow, so a group can be granted
// admin rights on one specific datatable, or on all of them via the All
// option here).
//
// 'plugin'/'plugin_task' are both completely admin-side (no end-user
// consumption concept, unlike form/workflow's view). 'plugin_task' scope
// is the composite "pluginName:taskId" string; its 'execute' action is
// kept deliberately separate from 'view' - view governs admin visibility
// of a task's definition, execute governs whether it appears in and can
// be run from the Task Test page (see plugins.js's _getTasks/
// _handleExecuteTask).
const RESOURCES_WITH_ALL_OPTION = ['form', 'workflow', 'datatable_admin', 'plugin', 'plugin_task'];

async function populatePermItemSelect(entry) {
    const itemSelect = document.getElementById('permItemSelect');
    const itemLabel = document.getElementById('permItemSelectLabel');
    itemLabel.textContent = entry.scopeLabel || 'Select Item';
    itemSelect.innerHTML = '<option value="">Loading...</option>';

    // The 'settings' resource's scopes (one per Settings-page tab) are
    // static and already present in the DOM's own tab navigation - see
    // getSettingsTabs(). No scopeSourceEndpoint round trip needed or
    // configured for this resource; every other resource keeps using one.
    if (entry.resource === 'settings') {
        const items = getSettingsTabs();
        itemSelect.innerHTML = '<option value="">Select...</option>';
        items
            .slice()
            .sort((a, b) => a.label.localeCompare(b.label))
            .forEach(({ tab, label }) => {
                const option = document.createElement('option');
                option.value = tab;
                option.textContent = label;
                itemSelect.appendChild(option);
            });
        return;
    }

    try {
        const response = await fetch(entry.scopeSourceEndpoint, { method: 'GET', credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        // Three response shapes handled, in order:
        //   1. Already an array.
        //   2. { <key>: [...] } - one property is the items array (most
        //      endpoints - /kore/workflows, /kore/forms, /kore/datatables -
        //      same listKey-per-type convention docs.js's
        //      fetchResourceOptions() already navigates).
        //   3. { <scopeValue>: {...}, ... } - an object keyed by scope
        //      value, each value itself an item object, not an array
        //      (/kore/page-permissions' shape specifically - {path: {id,
        //      title, path, permissions}}). Object.values() directly IS
        //      the items list in this case.
        const items = Array.isArray(data)
            ? data
            : (Object.values(data).find(v => Array.isArray(v)) || Object.values(data));

        itemSelect.innerHTML = '<option value="">Select...</option>';

        // Blanket '*' scope option - grants/revokes apply across every
        // instance of this resource type at once (e.g. "can add/edit/
        // delete any form"), independent of and layered under any
        // per-item grants below. Placed first, above the alphabetized
        // per-item list, since it's a distinct kind of choice rather
        // than just another item.
        if (RESOURCES_WITH_ALL_OPTION.includes(entry.resource)) {
            const allOption = document.createElement('option');
            allOption.value = '*';
            allOption.textContent = `All ${entry.label || entry.scopeLabel}`;
            itemSelect.appendChild(allOption);
        }

        items
            .map(item => ({ value: item[entry.scopeSourceValueField], label: item[entry.scopeSourceLabelField] || item[entry.scopeSourceValueField] }))
            .sort((a, b) => String(a.label).localeCompare(String(b.label)))
            .forEach(({ value, label }) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                itemSelect.appendChild(option);
            });
    } catch (error) {
        console.error(`[Settings] Error loading items for ${entry.resource}:`, error);
        itemSelect.innerHTML = '<option value="">Error loading items</option>';
    }
}

async function loadItemPermissions(resource, scope) {
    const listEl = document.getElementById('permissionsList');
    listEl.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">Loading...</p>';

    try {
        if (!window.allUsersAndGroups) await loadAllUsersAndGroups();

        const existingPermissions = await loadPermissionsForResource({
            resource,
            endpoint: '/kore/permissions',
            method: 'POST',
            body: { resource, scope }
        });

        listEl.innerHTML = '';
        displayPermissionsForm(listEl, existingPermissions || [], {
            addButtonLabel: 'Add Permission',
            showSaveButton: false, // fixed button at bottom
            actions: getValidActionsFor(resource)
        });

        // Page resource also gets an IP allowlist form - see the module
        // comment above for why this stays conditional rather than
        // generalized.
        const allowedIPsList = document.getElementById('allowedIPsList');
        allowedIPsList.innerHTML = '';
        if (resource === 'page') {
            const ipsWrapper = document.createElement('div');
            ipsWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
            await displayAllowedIPsForm(ipsWrapper, 'web_pages', 'path', scope, {
                showSeparator: true,
                showButtons: false,
                onSave: () => savePermPermissions(resource, scope)
            });
            allowedIPsList.appendChild(ipsWrapper);
        }
    } catch (error) {
        console.error(`[Settings] Error loading permissions for ${resource}:`, error);
        listEl.innerHTML = `<p style="color:var(--color-red,#e55);font-size:12px;margin:0;">Error loading permissions: ${escapeHtml(error.message)}</p>`;
    }
}

async function savePermPermissions(resource, scope) {
    try {
        const listEl = document.getElementById('permissionsList');
        await savePermissionsForResource({ resource, endpoint: '/kore/permissions' }, scope, listEl);

        if (resource === 'page') {
            try {
                // displayAllowedIPsForm (base.js) renders whitelist choices as
                // .whitelist-checkbox checkboxes and direct IPs as .ip-input
                // text fields inside #allowedIPsList - there's no single
                // #allowedIPsInput element to read (that was a leftover
                // reference to an older textarea-based version of the form).
                // Collect the same way that form's own (hidden, via
                // showButtons: false above) Save button would.
                const selectedWhitelists = Array.from(
                    document.querySelectorAll('#allowedIPsList .whitelist-checkbox:checked')
                ).map(cb => `whitelist.${cb.dataset.category}`);

                const ips = Array.from(
                    document.querySelectorAll('#allowedIPsList .ip-input')
                ).map(input => input.value.trim()).filter(ip => ip.length > 0);

                await saveAllowedIPs('web_pages', 'path', scope, [...selectedWhitelists, ...ips]);
            } catch (ipError) {
                console.warn('[Settings] Could not save allowedIPs:', ipError.message);
            }
        }

        window.showStatusBanner(`${resource} permissions saved successfully`, 'success', 'pagePermStatusMessage');
        await loadItemPermissions(resource, scope); // reload to sync
    } catch (error) {
        console.error(`[Settings] Error saving permissions for ${resource}:`, error);
        window.showStatusBanner(`Error saving permissions: ${error.message}`, 'error', 'pagePermStatusMessage');
    }
}

async function loadPermissionsPage() {
    try {
        if (!sessionToken) sessionToken = await getSessionToken();
        await loadPermissionResourcesCatalog();
        initPermissionsPod();
    } catch (error) {
        console.error('Error loading permissions page:', error);
        window.showStatusBanner('Error loading permissions: ' + error.message, 'error', 'permissionsStatusMessage');
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
// USER PORTAL - MENU MANAGEMENT
// ============================================================================

let userPortalMenuData = [];
let currentSelectedMenuId = null;
let userPortalFormsList = [];
let userPortalDatatablesList = [];
let userPortalResourceListsLoaded = false;

/**
 * Load unfiltered form/datatable name lists for the menu item resource
 * pickers (GET /kore/forms/admin, GET /kore/datatables/admin). Loaded once
 * per page session; failures degrade to empty lists rather than blocking
 * the rest of the menu editor.
 */
async function loadUserPortalResourceLists() {
    try {
        const [formsRes, datatablesRes] = await Promise.all([
            fetch('/kore/forms/admin', { method: 'GET', credentials: 'include', headers: { 'Content-Type': 'application/json' } }),
            fetch('/kore/datatables/admin', { method: 'GET', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
        ]);

        userPortalFormsList = formsRes.ok ? ((await formsRes.json()).forms || []) : [];
        if (!formsRes.ok) console.warn('Failed to load forms list:', formsRes.status);

        userPortalDatatablesList = datatablesRes.ok ? ((await datatablesRes.json()).datatables || []) : [];
        if (!datatablesRes.ok) console.warn('Failed to load datatables list:', datatablesRes.status);
    } catch (error) {
        console.error('Error loading resource lists for menu items:', error);
        userPortalFormsList = [];
        userPortalDatatablesList = [];
    } finally {
        userPortalResourceListsLoaded = true;
    }
}

/**
 * Get the cached {id, name} list for a given menu item type
 */
function getResourceListForType(type) {
    return type === 'datatable' ? userPortalDatatablesList : userPortalFormsList;
}

/**
 * Build <option> HTML for a resource picker select, pre-selecting
 * selectedId if present. If selectedId doesn't match anything in the
 * cached list (stale data, or a placeholder value like "TEMP"), it's
 * still shown as a selected option so it isn't silently dropped.
 */
function buildResourceSelectOptions(type, selectedId = '') {
    const list = getResourceListForType(type);
    const typeLabel = type === 'datatable' ? 'Data Table' : 'Form';
    let html = `<option value="">-- Select ${typeLabel} --</option>`;

    list.forEach(r => {
        const isSelected = String(r.id) === String(selectedId);
        html += `<option value="${escapeHtml(String(r.id))}" ${isSelected ? 'selected' : ''}>${escapeHtml(r.name)}</option>`;
    });

    if (selectedId && !list.some(r => String(r.id) === String(selectedId))) {
        html += `<option value="${escapeHtml(String(selectedId))}" selected>${escapeHtml(String(selectedId))} (unrecognized)</option>`;
    }

    return html;
}

/**
 * Load all user menus from admin endpoint
 */
async function loadUserPortalMenus() {
    try {
        if (!sessionToken) sessionToken = await getSessionToken();
        const response = await fetch('/kore/user-menus/admin', {
            method: 'GET',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to load menus: ${response.status}`);
        }
        
        const data = await response.json();
        userPortalMenuData = data.menus || [];
        displayUserPortalMenusTree();
    } catch (error) {
        console.error('Error loading user portal menus:', error);
        showStatusBanner(`Failed to load menus: ${error.message}`, 'error', 'userPortalStatusMessage');
        const container = document.getElementById('userMenusTreeContainer');
        if (container) {
            container.innerHTML = '<div style="color: var(--text-error); font-size: 12px;">Error loading menus. See console for details.</div>';
        }
    }
}

/**
 * Display menus in tree format
 */
function displayUserPortalMenusTree() {
    const container = document.getElementById('userMenusTreeContainer');
    if (!container) return;
    
    if (userPortalMenuData.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 10px;">No menus yet. Create one to get started.</div>';
        return;
    }

    // Convert flat array to tree structure for renderTree
    const items = userPortalMenuData.map(menu => ({
        id: menu.id,
        name: menu.label,
        parent_id: menu.parentId
    }));

    // Clear and render
    container.innerHTML = '';
    renderTree(items, container, {
        onItemClick: (item) => selectUserMenu(item.id)
    });
}

/**
 * Collect a menu id and all of its descendant ids (recursive), used to
 * prevent selecting a node as its own parent (directly or via a
 * descendant, which would create a cycle).
 */
function getMenuDescendantIds(menuId) {
    const ids = new Set([menuId]);
    let added = true;
    while (added) {
        added = false;
        userPortalMenuData.forEach(m => {
            if (m.parentId && ids.has(m.parentId) && !ids.has(m.id)) {
                ids.add(m.id);
                added = true;
            }
        });
    }
    return ids;
}

/**
 * Populate the Parent Menu select in the details panel with all menus,
 * optionally excluding a menu (and its descendants) so a node can't be
 * set as its own parent or create a circular reference.
 */
function populateUserMenuParentSelect(excludeMenuId = null) {
    const select = document.getElementById('userMenuParentSelect');
    if (!select) return;

    const excludeIds = excludeMenuId ? getMenuDescendantIds(excludeMenuId) : new Set();

    select.innerHTML = '<option value="">-- No Parent (Root Level) --</option>';
    userPortalMenuData
        .filter(m => !excludeIds.has(m.id))
        .sort((a, b) => a.label.localeCompare(b.label))
        .forEach(m => {
            const option = document.createElement('option');
            option.value = m.id;
            option.textContent = m.label;
            select.appendChild(option);
        });
}

/**
 * Select a menu for editing
 */
function selectUserMenu(menuId) {
    const menu = userPortalMenuData.find(m => m.id === menuId);
    if (!menu) return;

    currentSelectedMenuId = menuId;
    
    // Populate parent dropdown (excluding this menu and its descendants)
    populateUserMenuParentSelect(menuId);

    // Populate form fields
    document.getElementById('userMenuLabelInput').value = menu.label || '';
    document.getElementById('userMenuParentSelect').value = menu.parentId || '';
    document.getElementById('userMenuActiveCheckbox').checked = menu.active === 1 || menu.active === '1';
    
    // Populate items
    populateMenuItems(menu.items);
    
    // Show details panel, hide placeholder
    document.getElementById('userMenuPlaceholder').style.display = 'none';
    document.getElementById('userMenuDetailsPanel').style.display = 'flex';
    document.getElementById('userMenuDetailsPanel').style.flexDirection = 'column';
}

/**
 * Build one Menu Item card: a panel-level-4 "card" (one level nested under
 * the Items section's panel-level-3) with left-aligned labels instead of
 * the usual top-aligned form-group labels, since these are compact,
 * repeated rows rather than a single settings form.
 */
function buildMenuItemCard(index, item = {}) {
    const card = document.createElement('div');
    card.className = 'panel-level-5 menu-item-card';
    card.style.cssText = 'display: flex; flex-direction: column;';
    card.innerHTML = `
        <div style="display: grid; grid-template-columns: 65px 1fr auto; gap: 8px; align-items: center;">
            <label style="grid-row: 1; grid-column: 1; color: var(--text-muted); font-size: 11px; font-weight: 600;">Label</label>
            <input type="text" class="item-label-${index}" placeholder="Item label" value="${escapeHtml(item.label || '')}" style="grid-row: 1; grid-column: 2; width: 100%; padding: 4px 6px; font-size: 11px;">
            <button type="button" class="btn" data-color="red" data-size="sm" onclick="removeMenuItemRow(${index})" style="grid-row: 1; grid-column: 3;">Delete</button>

            <label style="grid-row: 2; grid-column: 1; color: var(--text-muted); font-size: 11px; font-weight: 600;">Type</label>
            <select class="item-type-${index}" style="grid-row: 2; grid-column: 2; width: 100%; padding: 4px 6px; font-size: 11px;" onchange="onMenuItemTypeChange(${index})">
                <option value="form" ${item.type !== 'datatable' ? 'selected' : ''}>Form</option>
                <option value="datatable" ${item.type === 'datatable' ? 'selected' : ''}>Data Table</option>
            </select>

            <label style="grid-row: 3; grid-column: 1; color: var(--text-muted); font-size: 11px; font-weight: 600;">Resource</label>
            <select class="item-resource-${index}" style="grid-row: 3; grid-column: 2; width: 100%; padding: 4px 6px; font-size: 11px;">
                ${buildResourceSelectOptions(item.type || 'form', item.resourceId || '')}
            </select>
        </div>
    `;
    return card;
}

/**
 * Populate menu items display
 */
function populateMenuItems(itemsJson) {
    const container = document.getElementById('userMenuItemsContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    let items = [];
    if (itemsJson) {
        try {
            items = typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson;
        } catch (e) {
            console.error('Failed to parse items:', e);
        }
    }
    
    if (items.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 11px; padding: 6px;">No items</div>';
        return;
    }
    
    items.forEach((item, index) => {
        container.appendChild(buildMenuItemCard(index, item));
    });
}

/**
 * Rebuild an item row's resource select when its type dropdown changes
 * (form <-> datatable use different id/name lists, so the previous
 * selection doesn't carry over).
 */
function onMenuItemTypeChange(index) {
    const container = document.getElementById('userMenuItemsContainer');
    if (!container) return;

    const typeSelect = container.querySelector(`.item-type-${index}`);
    const resourceSelect = container.querySelector(`.item-resource-${index}`);
    if (!typeSelect || !resourceSelect) return;

    resourceSelect.innerHTML = buildResourceSelectOptions(typeSelect.value, '');
    applySelectArrowColor(resourceSelect);
}

/**
 * Add a new menu item row
 */
function addMenuItemRow() {
    const container = document.getElementById('userMenuItemsContainer');
    if (!container) return;
    
    // Check if we had the "No items" message
    if (container.innerHTML.includes('No items')) {
        container.innerHTML = '';
    }
    
    const index = container.children.length;
    container.appendChild(buildMenuItemCard(index, {}));
}

/**
 * Remove a menu item row
 */
function removeMenuItemRow(index) {
    const container = document.getElementById('userMenuItemsContainer');
    if (!container || !container.children[index]) return;
    
    container.children[index].remove();
    
    // If no items left, show message
    if (container.children.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 11px; padding: 6px;">No items</div>';
    }
}

/**
 * Get current menu items from form
 */
function getUserMenuItems() {
    const container = document.getElementById('userMenuItemsContainer');
    if (!container) return null;
    
    const items = [];
    container.querySelectorAll('.menu-item-card').forEach((card, index) => {
        const label = card.querySelector(`.item-label-${index}`)?.value?.trim();
        const type = card.querySelector(`.item-type-${index}`)?.value;
        const resourceId = card.querySelector(`.item-resource-${index}`)?.value?.trim();
        
        if (label && type && resourceId) {
            items.push({ label, type, resourceId });
        }
    });
    
    return items.length > 0 ? items : null;
}

/**
 * Show a modal for managing permissions on the currently selected menu
 * node (resource: 'menu', scope: menuId). Reuses the same generic
 * permission-row UI and load/save plumbing as the Permissions tab's Page
 * Permissions (displayPermissionsForm/createPermissionRow/
 * loadPermissionsForResource/savePermissionsForResource), scoped to a
 * single already-selected item rather than duplicating that tab's
 * dropdown-driven bulk-load flow.
 *
 * Authorization is enforced server-side by canManagePermissionsFor() in
 * auth.js: either the blanket 'permissions'/'view'/'all' grant, or the
 * narrower 'menu'/'admin' grant (the same one that already lets this user
 * edit menu content) - see PUT/POST /kore/permissions.
 */
async function showMenuPermissionsModal() {
    if (!currentSelectedMenuId) return;

    const menu = userPortalMenuData.find(m => m.id === currentSelectedMenuId);
    if (!menu) return;

    try {
        // Load all users/groups for the target dropdowns if not already cached
        if (!window.allUsersAndGroups) {
            await loadAllUsersAndGroups();
        }

        // Load this menu's own permission rows (scoped query - not the
        // bulk all-pages style load the Page Permissions tab uses)
        const existingPermissions = await loadPermissionsForResource({
            resource: 'menu',
            endpoint: '/kore/permissions',
            method: 'POST',
            body: { resource: 'menu', scope: currentSelectedMenuId }
        });

        // Build the modal's own content container. displayPermissionsForm
        // renders its own "Add Permission" button + rows into this
        // container; savePermissionsForResource is later scoped to this
        // same container so it can never pick up stale rows from a
        // different (hidden) permissions form elsewhere in the DOM.
        const container = document.createElement('div');
        displayPermissionsForm(container, existingPermissions || [], {
            addButtonLabel: 'Add Permission',
            showSaveButton: false
        });

        showModal({
            title: `Permissions: ${escapeHtml(menu.label)}`,
            content: container,
            width: '600px',
            height: 'auto',
            resizable: true,
            buttons: [
                {
                    label: 'Save',
                    type: 'success',
                    onClick: async () => {
                        try {
                            await savePermissionsForResource(
                                { resource: 'menu', endpoint: '/kore/permissions' },
                                currentSelectedMenuId,
                                container
                            );
                            showStatusBanner('Menu permissions saved', 'success', 'userPortalStatusMessage');
                        } catch (error) {
                            console.error('Error saving menu permissions:', error);
                            showAlert('Error', `Failed to save permissions: ${error.message}`);
                            throw error; // prevents the modal from auto-closing on failure
                        }
                    }
                },
                { label: 'Cancel', type: 'secondary' }
            ]
        });
    } catch (error) {
        console.error('Error loading menu permissions:', error);
        showStatusBanner(`Failed to load permissions: ${error.message}`, 'error', 'userPortalStatusMessage');
    }
}

/**
 * Show the placeholder and hide the details panel (nothing selected)
 */
function showUserMenuPlaceholder() {
    document.getElementById('userMenuPlaceholder').style.display = 'flex';
    document.getElementById('userMenuDetailsPanel').style.display = 'none';
}

/**
 * Save user menu node
 */
async function saveUserMenuNode() {
    if (!currentSelectedMenuId) return;
    
    try {
        const label = document.getElementById('userMenuLabelInput').value.trim();
        const parentId = document.getElementById('userMenuParentSelect').value || null;
        const active = document.getElementById('userMenuActiveCheckbox').checked ? 1 : 0;
        const items = getUserMenuItems();
        
        if (!label) {
            showStatusBanner('Menu label is required', 'error', 'userPortalStatusMessage');
            return;
        }
        
        const response = await fetch(`/kore/user-menus/admin/${currentSelectedMenuId}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label, parentId, items, active })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `Save failed: ${response.status}`);
        }
        
        showStatusBanner('Menu saved successfully', 'success', 'userPortalStatusMessage');
        await loadUserPortalMenus();
        currentSelectedMenuId = null;
        showUserMenuPlaceholder();
    } catch (error) {
        console.error('Error saving menu:', error);
        showStatusBanner(`Failed to save: ${error.message}`, 'error', 'userPortalStatusMessage');
    }
}

/**
 * Delete user menu node
 */
async function deleteUserMenuNode() {
    if (!currentSelectedMenuId) return;
    
    if (!confirm('Are you sure you want to delete this menu? This cannot be undone.')) {
        return;
    }
    
    try {
        const response = await fetch(`/kore/user-menus/admin/${currentSelectedMenuId}`, {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `Delete failed: ${response.status}`);
        }
        
        showStatusBanner('Menu deleted successfully', 'success', 'userPortalStatusMessage');
        await loadUserPortalMenus();
        currentSelectedMenuId = null;
        showUserMenuPlaceholder();
    } catch (error) {
        console.error('Error deleting menu:', error);
        showStatusBanner(`Failed to delete: ${error.message}`, 'error', 'userPortalStatusMessage');
    }
}

/**
 * Clear menu selection and hide details panel
 */
function clearUserMenuSelection() {
    currentSelectedMenuId = null;
    showUserMenuPlaceholder();
}

/**
 * Show modal to create a new menu node
 */
function showCreateMenuNodeModal() {
    const fields = [
        { name: 'label', type: 'text', label: 'Menu Label', placeholder: 'e.g., NOC/SOC Tools', required: true },
        { 
            name: 'parentId', 
            type: 'select', 
            label: 'Parent Menu (optional)', 
            options: [{ value: '', label: '-- No Parent (Root Level) --' }, ...userPortalMenuData.map(m => ({ value: m.id, label: m.label }))]
        }
    ];
    
    showFormModal('Create New Menu', fields, (formData) => {
        createNewMenuNode(formData.label, formData.parentId || null);
    }, false, false, false, 'Create');
}

/**
 * Create a new menu node
 */
async function createNewMenuNode(label, parentId) {
    if (!label) {
        showStatusBanner('Menu label is required', 'error', 'userPortalStatusMessage');
        return;
    }
    
    try {
        const response = await fetch('/kore/user-menus/admin', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label, parentId, active: 1 })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `Create failed: ${response.status}`);
        }
        
        showStatusBanner('Menu created successfully', 'success', 'userPortalStatusMessage');
        await loadUserPortalMenus();
    } catch (error) {
        console.error('Error creating menu:', error);
        showStatusBanner(`Failed to create: ${error.message}`, 'error', 'userPortalStatusMessage');
    }
}

/**
 * Switch to User Portal tab
 */
async function switchToUserPortalTab(event) {
    if (event) event.preventDefault();
    switchTab('userPortalTab', event);
    
    // Load menus when tab is opened
    if (userPortalMenuData.length === 0) {
        await loadUserPortalMenus();
    } else {
        displayUserPortalMenusTree();
    }

    // Load form/datatable name lists for menu item resource pickers
    if (!userPortalResourceListsLoaded) {
        await loadUserPortalResourceLists();
    }
}

// ============================================================================
// EXPORTS TO WINDOW
// ============================================================================
window.addIPFieldToSystemWhitelist = addIPFieldToSystemWhitelist;
window.addUserGroupsSection = addUserGroupsSection;
window.attachSecurityFormListeners = attachSecurityFormListeners;
window.cancelGroupEdit = cancelGroupEdit;
window.cancelOrganizationEdit = cancelOrganizationEdit;
window.cancelUserEdit = cancelUserEdit;
window.checkGroupUnsavedChanges = checkGroupUnsavedChanges;
window.checkLoggingUnsavedChanges = checkLoggingUnsavedChanges;
window.checkOrgUnsavedChanges = checkOrgUnsavedChanges;
window.checkSystemUnsavedChanges = checkSystemUnsavedChanges;
window.checkUserUnsavedChanges = checkUserUnsavedChanges;
window.confirmRestartSubsystem = confirmRestartSubsystem;
window.confirmRunMaintenanceTask = confirmRunMaintenanceTask;
window.displayEntityDetailsGeneric = displayEntityDetailsGeneric;
window.displayEntityListGeneric = displayEntityListGeneric;
window.displayGroupDetails = displayGroupDetails;
window.displayGroups = displayGroups;
window.displayInternalWhitelist = displayInternalWhitelist;
window.displayOrgStack = displayOrgStack;
window.displayOrganizationDetails = displayOrganizationDetails;
window.displayOrganizations = displayOrganizations;
window.displayUserDetails = displayUserDetails;
window.displayUsers = displayUsers;
window.doSelectGroupFromList = doSelectGroupFromList;
window.doSelectOrganizationFromList = doSelectOrganizationFromList;
window.doSelectUserFromList = doSelectUserFromList;
window.getLoggingFormData = getLoggingFormData;
window.getOrgFormData = getOrgFormData;
window.getSecurityFormData = getSecurityFormData;
window.getSystemFormData = getSystemFormData;
window.loadAllUsersAndGroups = loadAllUsersAndGroups;
window.loadAndCacheStackTypes = loadAndCacheStackTypes;
window.loadEmailConfig = loadEmailConfig;
window.loadEntityListGeneric = loadEntityListGeneric;
window.loadGroupsList = loadGroupsList;
window.loadLoggingConfig = loadLoggingConfig;
window.loadOrgStack = loadOrgStack;
window.loadUserStack = loadUserStack;
window.displayUserStack = displayUserStack;
window.loadOrganizationDetails = loadOrganizationDetails;
window.loadOrganizationsList = loadOrganizationsList;
window.loadPermissionsPage = loadPermissionsPage;
window.loadSecuritySettings = loadSecuritySettings;
window.loadSystemConfig = loadSystemConfig;
window.loadSystemHealth = loadSystemHealth;
window.loadUsersList = loadUsersList;
window.populateEmailProfileDropdown = populateEmailProfileDropdown;
window.populateLoggingFields = populateLoggingFields;
window.populateTimezoneSelect = populateTimezoneSelect;
window.refreshSystemHealth = refreshSystemHealth;
window.resendUserInvite = resendUserInvite;
window.resetSecurityForm = resetSecurityForm;
window.resetUserMFA = resetUserMFA;
window.toggleSetPasswordForm = toggleSetPasswordForm;
window.submitSetPassword = submitSetPassword;
window.restartSubsystem = restartSubsystem;
window.saveGroupDetails = saveGroupDetails;
window.saveLoggingConfig = saveLoggingConfig;
window.saveNewGroup = saveNewGroup;
window.saveNewOrganization = saveNewOrganization;
window.saveNewUser = saveNewUser;
window.saveNotificationPreferences = saveNotificationPreferences;
window.saveMaintenanceSchedule = saveMaintenanceSchedule;
window.saveOrganizationDetails = saveOrganizationDetails;
window.saveOrgDetails = saveOrganizationDetails;
window.saveSecuritySettings = saveSecuritySettings;
window.saveSystemConfig = saveSystemConfig;
window.saveUserDetails = saveUserDetails;
window.selectGroupFromList = selectGroupFromList;
window.selectOrganizationFromList = selectOrganizationFromList;
window.selectUserFromList = selectUserFromList;
window.showAddGroupModal = showAddGroupModal;
window.showAddOrganizationModal = showAddOrganizationModal;
window.showAddUserModal = showAddUserModal;
window.showModulesModal = showModulesModal;
window.startUptimeTicker = startUptimeTicker;
window.switchEmailProfile = switchEmailProfile;
window.switchTabWithUnsavedCheck = switchTabWithUnsavedCheck;
window.switchToGroupsTab = switchToGroupsTab;
window.switchToOrganizationsTab = switchToOrganizationsTab;
window.switchToPermissionsTab = switchToPermissionsTab;
window.switchToPluginsTab = switchToPluginsTab;
window.switchToSecurityTab = switchToSecurityTab;
window.switchToUsersTab = switchToUsersTab;
window.switchToUtilitiesTab = switchToUtilitiesTab;
window.switchToUserPortalTab = switchToUserPortalTab;
window.saveEmailPurposeConfig = saveEmailPurposeConfig;
window.testEmailSmtp = testEmailSmtp;
window.unlockUser = unlockUser;
window.updateSecuritySaveButtonState = updateSecuritySaveButtonState;
window.viewGroupPermissions = viewGroupPermissions;
window.viewUserPermissions = viewUserPermissions;
window.loadUserPortalMenus = loadUserPortalMenus;
window.displayUserPortalMenusTree = displayUserPortalMenusTree;
window.selectUserMenu = selectUserMenu;
window.populateUserMenuParentSelect = populateUserMenuParentSelect;
window.getMenuDescendantIds = getMenuDescendantIds;
window.populateMenuItems = populateMenuItems;
window.loadUserPortalResourceLists = loadUserPortalResourceLists;
window.getResourceListForType = getResourceListForType;
window.buildResourceSelectOptions = buildResourceSelectOptions;
window.onMenuItemTypeChange = onMenuItemTypeChange;
window.addMenuItemRow = addMenuItemRow;
window.removeMenuItemRow = removeMenuItemRow;
window.saveUserMenuNode = saveUserMenuNode;
window.deleteUserMenuNode = deleteUserMenuNode;
window.clearUserMenuSelection = clearUserMenuSelection;
window.showUserMenuPlaceholder = showUserMenuPlaceholder;
window.showMenuPermissionsModal = showMenuPermissionsModal;
window.showCreateMenuNodeModal = showCreateMenuNodeModal;
window.createNewMenuNode = createNewMenuNode;