let currentUser = null;
        let sessionToken = null;
        
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
                if (!sessionToken) sessionToken = await window.getSessionToken();
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
                readonlyFields: [],
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
            
            // User-specific buttons
            if (entityType === 'user') {
                const isLocked = entityData.lockedUntil && new Date(entityData.lockedUntil) > new Date();
                if (isLocked) {
                    buttonBar += `<button class="btn" data-color="blue" data-size="sm" onclick="unlockUser('${escapeHtml(String(entityId))}')" id="unlockUserBtn">Unlock</button>`;
                }
                if (entityData.mfaEnabled) {
                    buttonBar += `<button class="btn" data-color="orange" data-size="sm" onclick="resetUserMFA('${escapeHtml(String(entityId))}')" id="resetMFABtn">Reset MFA</button>`;
                }
                buttonBar += `<button class="btn" data-color="grey" data-size="sm" onclick="resendUserInvite('${escapeHtml(String(entityId))}')" id="resendInviteBtn">Resend Invite</button>`;
            }
            
            // Build main panel
            const detailsHtml = `
                <div class="panel-level-3" style="display: flex; flex-direction: column; gap: 10px;">
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
            
            detailArea.innerHTML = detailsHtml;
            window[spec.currentVar] = entityData;
            window.clearUnsavedChanges();
            
            // Post-display setup
            if (spec.onDisplayComplete) {
                window[spec.onDisplayComplete](entityId);
            }
            if (entityType === 'user') {
                addUserGroupsSection(entityData, detailArea);
            }
        }
        
        function addUserGroupsSection(userData, detailArea) {
            if (!window.cachedGroups) return;
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
                    <div style="display: flex; flex-direction: column; gap: 8px;">
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
            detailArea.insertAdjacentHTML('beforeend', groupsHtml);
        }

        function updateSaveButtonState() {
            const saveBtn = document.getElementById('savePluginBtn');
            if (saveBtn) {
                let hasChanges = window.hasUnsavedChanges();
                
                // Also check if headers have changed
                if (!hasChanges && originalPluginConfig) {
                    const originalHeaders = originalPluginConfig.config?.headers || [];
                    const originalJson = JSON.stringify(originalHeaders);
                    const currentJson = JSON.stringify(currentEditingHeaders);
                    hasChanges = originalJson !== currentJson;
                    if (hasChanges) {
                        console.log('Save button activated due to header changes');
                    }
                }
                
                saveBtn.disabled = !hasChanges;
            }
        }

        let pendingPluginCode = '';

        function openCodeModal(code, onSave) {
            showFormModal('View Code', [{name: 'code', type: 'textarea', label: 'Code', placeholder: '', value: code || '', rows: 15}], (formData) => {
                if (onSave) {
                    onSave(formData.code);
                } else {
                    // Default behavior if no callback (for existing plugins)
                    console.log('Code updated');
                }
            });
        }

        async function openAddPluginModal() {
            try {
                const sessionToken = await window.getSessionToken();
                const result = await window.executeSqlQuery(
                    sessionToken,
                    currentUser,
                    'kore_sys',
                    'SELECT plugin_config FROM system_config LIMIT 1'
                );

                if (!result.result || result.result.length === 0) {
                    showStatusBanner('Unable to load plugin configuration', 'error');
                    return;
                }

                let config;
                try {
                    config = typeof result.result[0].plugin_config === 'string' 
                        ? JSON.parse(result.result[0].plugin_config) 
                        : result.result[0].plugin_config;
                } catch (e) {
                    showStatusBanner('Error parsing plugin configuration', 'error');
                    return;
                }

                if (!config || !config.types) {
                    showStatusBanner('Unable to load plugin configuration', 'error');
                    return;
                }

                const fields = [];

                // Type field FIRST - always visible
                fields.push({
                    name: 'pluginType',
                    type: 'select',
                    label: 'Type',
                    options: ['', ...Object.keys(config.types)],
                    required: true,
                    value: ''
                });

                // Basic Information Section - hide until type selected
                fields.push({ type: 'section', label: 'Basic Information', pluginTypes: ['api', 'service'] });

                // These fields show when a type is selected
                fields.push({
                    name: 'pluginName',
                    type: 'text',
                    label: 'Name',
                    placeholder: 'plugin-name (no spaces)',
                    required: true,
                    value: '',
                    pluginTypes: ['api', 'service']
                });
                fields.push({
                    name: 'pluginDisplayName',
                    type: 'text',
                    label: 'Display Name',
                    required: true,
                    value: '',
                    pluginTypes: ['api', 'service']
                });
                fields.push({
                    name: 'pluginDescription',
                    type: 'textarea',
                    label: 'Description',
                    rows: 2,
                    value: '',
                    pluginTypes: ['api', 'service']
                });
                fields.push({
                    name: 'configRateLimit',
                    type: 'number',
                    label: 'Rate Limit (req/min)',
                    required: true,
                    value: '100',
                    pluginTypes: ['api', 'service']
                });
                fields.push({
                    name: 'configRoutes',
                    type: 'textarea',
                    label: 'Routes',
                    placeholder: '/route1\n/route2',
                    required: true,
                    rows: 2,
                    value: '',
                    pluginTypes: ['api', 'service']
                });
                fields.push({
                    name: 'pluginEnabled',
                    type: 'checkbox',
                    label: 'Enabled',
                    checked: true,
                    pluginTypes: ['api', 'service']
                });

                // API-only fields
                fields.push({
                    name: 'viewCode',
                    type: 'button',
                    label: 'View Code',
                    buttonText: 'View Code',
                    onClick: () => {
                        openCodeModal(pendingPluginCode, (code) => {
                            pendingPluginCode = code;
                        });
                    },
                    pluginTypes: ['api']
                });
                fields.push({
                    name: 'baseUrl',
                    type: 'text',
                    label: 'Base URL',
                    required: true,
                    value: '',
                    pluginTypes: ['api']
                });
                fields.push({
                    name: 'apiPath',
                    type: 'text',
                    label: 'API Path',
                    required: true,
                    value: '',
                    pluginTypes: ['api']
                });
                fields.push({
                    name: 'authType',
                    type: 'select',
                    label: 'Auth Type',
                    options: ['', 'bearer', 'oauth'],
                    required: true,
                    value: '',
                    pluginTypes: ['api']
                });

                // Auth-specific fields
                fields.push({
                    name: 'apiKey',
                    type: 'password',
                    label: 'API Key',
                    required: true,
                    value: '',
                    authTypes: ['bearer'],
                    pluginTypes: ['api']
                });
                fields.push({
                    name: 'publicKey',
                    type: 'textarea',
                    label: 'Public Key',
                    required: true,
                    rows: 2,
                    value: '',
                    authTypes: ['oauth'],
                    pluginTypes: ['api']
                });
                fields.push({
                    name: 'privateKey',
                    type: 'textarea',
                    label: 'Private Key',
                    required: true,
                    rows: 2,
                    value: '',
                    authTypes: ['oauth'],
                    pluginTypes: ['api']
                });

                // Custom headers field
                fields.push({
                    name: 'headers',
                    type: 'custom:headers',
                    label: 'Additional Headers',
                    required: false,
                    pluginTypes: ['api']
                });

                // Show the form modal
                showFormModal('Add Plugin', fields, async (formData) => {
                    // Extract headers from DOM since custom:headers field doesn't populate formData
                    const headerDivs = document.querySelectorAll('[id^="header_"]');
                    const headers = [];
                    headerDivs.forEach(div => {
                        const inputs = div.querySelectorAll('input[type="text"]');
                        if (inputs.length === 2) {
                            const key = inputs[0].value.trim();
                            const value = inputs[1].value.trim();
                            if (key && value) {
                                headers.push({ key, value });
                            }
                        }
                    });
                    
                    if (headers.length > 0) {
                        formData.headers = headers;
                    }
                    
                    if (!formData.pluginType) {
                        window.showStatusBanner('Please select a plugin type', 'error', 'pluginsStatusMessage');
                        return;
                    }

                    // Transform flat form data into plugin structure
                    const code = pendingPluginCode;
                    pendingPluginCode = ''; // Reset for next time
                    
                    const pluginType = formData.pluginType;
                    
                    const pluginData = {
                        name: formData.pluginName,
                        display_name: formData.pluginDisplayName,
                        description: formData.pluginDescription,
                        enabled: formData.pluginEnabled ? 1 : 0,
                        version: 1,
                        code: code,
                        config: {
                            type: pluginType,
                            rateLimit: parseInt(formData.configRateLimit) || 100,
                            routes: formData.configRoutes.split('\n').filter(r => r.trim())
                        }
                    };
                    
                    // Add API-specific config
                    if (pluginType === 'api') {
                        pluginData.config.baseUrl = formData.baseUrl;
                        pluginData.config.apiPath = formData.apiPath;
                        pluginData.config.authType = formData.authType;
                        
                        // Add auth-specific fields
                        if (formData.authType === 'bearer' && formData.apiKey) {
                            pluginData.config.apiKey = formData.apiKey;
                        } else if (formData.authType === 'oauth') {
                            pluginData.config.publicKey = formData.publicKey;
                            pluginData.config.privateKey = formData.privateKey;
                        }
                        
                        // Add headers if any
                        if (formData.headers && Array.isArray(formData.headers) && formData.headers.length > 0) {
                            pluginData.config.headers = formData.headers;
                        }
                    }
                    
                    pluginData.username = currentUser;
                    
                    try {
                        const response = await addPlugin(pluginData);
                        
                        if (response.status === 201) {
                            window.showStatusBanner('Plugin created successfully!', 'success', 'pluginsStatusMessage');
                            await loadPluginsList();
                        } else {
                            const error = await response.json();
                            window.showStatusBanner('Error: ' + (error.error || 'Unknown error'), 'error', 'pluginsStatusMessage');
                        }
                    } catch (error) {
                        window.showStatusBanner('Error saving plugin: ' + error.message, 'error', 'pluginsStatusMessage');
                    }
                });
            } catch (error) {
                showStatusBanner('Error loading plugin configuration', 'error');
            }
        }

        async function addPlugin(pluginPayload) {
            const response = await fetch('https://app.equinoxits.com:1139/kore/plugins/add', {
                method: 'POST',
                headers: {
                    'X-Session-Token': sessionToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(pluginPayload)
            });
            return response;
        }

        function getCurrentPluginFormData() {
            const data = {
                name: currentPluginName,
                display_name: document.getElementById('pluginDisplayName').value,
                description: document.getElementById('pluginDescription').value,
                enabled: document.getElementById('pluginEnabled').checked,
                type: document.getElementById('configTypeValue').textContent,
                rateLimit: parseInt(document.getElementById('configRateLimit').value) || 0,
                routes: document.getElementById('configRoutes').value,
                baseUrl: document.getElementById('configBaseUrl').value,
                apiPath: document.getElementById('configApiPath').value,
                apiKey: document.getElementById('configApiKey').value,
                clientBaseUrl: document.getElementById('configClientBaseUrl').value,
                clientApiPath: document.getElementById('configClientApiPath').value,
                clientId: document.getElementById('configClientId').value,
                publicKey: document.getElementById('configPublicKey').value,
                privateKey: document.getElementById('configPrivateKey').value,
                databases: currentDatabases,
                headers: currentEditingHeaders  // Include headers in form data
            };
            return data;
        }

        function showConfirmModal(title, message, callback) {
            confirmCallback = callback;
            document.getElementById('confirmTitle').textContent = title;
            document.getElementById('confirmMessage').textContent = message;
            document.getElementById('confirmModal').style.display = 'block';
        }

        function closeConfirmModal() {
            document.getElementById('confirmModal').style.display = 'none';
            confirmCallback = null;
        }

        function proceedWithConfirm() {
            const callback = confirmCallback;
            closeConfirmModal();
            if (callback) {
                callback();
            }
        }

        async function reloadAllPlugins() {
            try {
                if (!sessionToken) {
                    sessionToken = await getSessionToken();
                }

                const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/reload-all`, {
                    method: 'POST',
                    headers: {
                        'X-Session-Token': sessionToken,
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                if (response.ok) {
                    showStatusBanner('All plugins reloaded successfully.', 'success');
                } else {
                    showStatusBanner('Error reloading plugins: ' + (data.message || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('Error reloading all plugins:', error);
                showStatusBanner('Error reloading plugins', 'error');
            }
        }

        async function loadPluginsList() {
            console.log('loadPluginsList called');
            try {
                if (!sessionToken) {
                    sessionToken = await getSessionToken();
                }

                console.log('Fetching plugins list...');
                const response = await fetch('https://app.equinoxits.com:1139/kore/plugins/list', {
                    method: 'GET',
                    headers: {
                        'X-Session-Token': sessionToken
                    }
                });

                const data = await response.json();
                console.log('Plugins list response:', response.ok, data);

                if (response.ok && data.plugins) {
                    console.log('Displaying plugins:', data.plugins.map(p => p.name));
                    displayPlugins(data.plugins);
                } else {
                    document.getElementById('pluginListSidebar').innerHTML = '<p style="color: var(--text-muted);">No plugins loaded</p>';
                }
            } catch (error) {
                console.error('Error loading plugins:', error);
                document.getElementById('pluginListSidebar').innerHTML = '<p style="color: var(--text-muted);">Error loading plugins: ' + error.message + '</p>';
            }
        }

        function displayPlugins(plugins) {
            console.log('displayPlugins called with:', plugins);
            const sidebar = document.getElementById('pluginListSidebar');
            console.log('Plugin sidebar element:', sidebar);
            
            if (!plugins || plugins.length === 0) {
                sidebar.innerHTML = '<p style="color: var(--text-muted); font-size: 11px; margin: 0;">No plugins found</p>';
                return;
            }

            let html = '';
            plugins.forEach(plugin => {
                const displayName = plugin.display_name || plugin.name;
                html += `
                    <button class="btn" data-color="theme-neutral" data-size="sm" onclick="selectPluginFromList('${escapeHtml(plugin.name)}', this)" 
                            style="width: 100%; text-align: center;">
                        ${escapeHtml(displayName)}
                    </button>
                `;
            });

            console.log('Setting sidebar HTML with', plugins.length, 'plugins');
            sidebar.innerHTML = html;
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
                    sessionToken = await window.getSessionToken();
                }
                
                // Get the next org_id by finding the current max
                const getMaxIdQuery = `SELECT COALESCE(MAX(org_id), 0) as max_id FROM kore_data.orgs`;
                const maxIdResult = await window.executeSqlQuery(
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
                
                const orgResult = await window.executeSqlQuery(
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
                
                const stackResult = await window.executeSqlQuery(
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
                    sessionToken = await window.getSessionToken();
                }
                
                const orgStack = await window.getOrgStack(sessionToken, currentUser, orgId);
                
                // Use cached stack types (should be loaded when tab was opened)
                if (cachedStackTypes) {
                    displayOrgStack(orgStack, orgId, cachedStackTypes);
                } else {
                    // Fallback: load types if cache is empty
                    const [rmmTypes, psaTypes, controlTypes, rpaTypes, bdrTypes] = await Promise.all([
                        window.getRmmTypes(sessionToken, currentUser),
                        window.getPsaTypes(sessionToken, currentUser),
                        window.getControlTypes(sessionToken, currentUser),
                        window.getRpaTypes(sessionToken, currentUser),
                        window.getBdrTypes(sessionToken, currentUser)
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
            
            // Create the org_stack panel HTML
            const stackHtml = `
                <div class="panel-level-3" style="display: flex; flex-direction: column; gap: 10px; margin-top: 15px;">
                    <h3 style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">System Integrations</h3>
                    <div style="display: flex; flex-direction: column; gap: 15px;">
                        ${buildTypeDropdown('RMM', 'rmm', stackTypes.rmm, orgStack?.rmm_type_id, orgStack?.rmm_id)}
                        ${buildTypeDropdown('PSA', 'psa', stackTypes.psa, orgStack?.psa_type_id, orgStack?.psa_id)}
                        ${buildTypeDropdown('Control', 'control', stackTypes.control, orgStack?.control_type_id, orgStack?.control_id)}
                        ${buildTypeDropdown('RPA', 'rpa', stackTypes.rpa, orgStack?.rpa_type_id, orgStack?.rpa_id)}
                        ${buildTypeDropdown('BDR', 'bdr', stackTypes.bdr, orgStack?.bdr_type_id, orgStack?.bdr_id)}
                    </div>
                </div>
            `;
            
            // Append the org_stack panel to the detail area
            detailArea.insertAdjacentHTML('beforeend', stackHtml);
            
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
                    sessionToken = await window.getSessionToken();
                }
                
                // Update orgs table
                const orgQuery = `UPDATE kore_data.orgs SET org_name = '${orgName.replace(/'/g, "''")}', inactive = ${status} WHERE org_id = ${orgId}`;
                
                const orgResult = await window.executeSqlQuery(
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
                
                const stackResult = await window.executeSqlQuery(
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

        function selectPluginFromList(pluginName, buttonElement) {
            console.log('selectPluginFromList - checking for unsaved changes');
            const formData = getCurrentPluginFormData();
            const hasUnsaved = window.checkUnsavedChanges(formData);
            console.log('selectPluginFromList - formData:', formData);
            console.log('selectPluginFromList - hasUnsaved:', hasUnsaved, 'currentPluginName:', currentPluginName);
            
            if (hasUnsaved && currentPluginName && currentPluginName !== pluginName) {
                window.showUnsaved(
                    async () => {
                        // Save the current SQL database form if one is being edited
                        if (selectedSqlDatabaseName) {
                            saveSqlDatabaseForm(selectedSqlDatabaseName);
                        }
                        // Now save the plugin settings
                        await savePluginSettings();
                        doSelectPluginFromList(pluginName, buttonElement);
                    },
                    () => {
                        doSelectPluginFromList(pluginName, buttonElement);
                    }
                );
            } else {
                doSelectPluginFromList(pluginName, buttonElement);
            }
        }

        function doSelectPluginFromList(pluginName, buttonElement) {
            loadPluginDetails(pluginName);
            
            // Reset all buttons to theme-neutral color
            const buttons = document.querySelectorAll('#pluginListSidebar button');
            buttons.forEach(btn => {
                btn.setAttribute('data-color', 'theme-neutral');
            });
            
            // Highlight the selected button with theme-brand
            if (buttonElement) {
                buttonElement.setAttribute('data-color', 'theme-brand');
            }
            
            window.clearUnsavedChanges();
        }

        function cancelPluginSelection() {
            // Reset all sidebar buttons to unselected state
            const buttons = document.querySelectorAll('#pluginListSidebar button');
            buttons.forEach(btn => {
                btn.setAttribute('data-color', 'theme-neutral');
            });
            
            // Hide settings container, show placeholder
            document.getElementById('pluginSettingsContainer').style.display = 'none';
            document.getElementById('pluginPlaceholder').style.display = 'block';
            
            // Hide reload button
            document.getElementById('reloadPluginBtn').style.display = 'none';
            currentPluginName = '';
            window.clearUnsavedChanges();
            updateSaveButtonState();
        }

        async function loadPluginDetails(pluginName) {
            if (!pluginName) {
                return;
            }

            try {
                if (!sessionToken) {
                    sessionToken = await getSessionToken();
                }

                console.log('Fetching plugin details for:', pluginName);
                const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/details?name=${encodeURIComponent(pluginName)}`, {
                    method: 'GET',
                    headers: {
                        'X-Session-Token': sessionToken
                    }
                });

                const data = await response.json();
                console.log('Plugin fetch response:', response.ok, data);

                if (response.ok && data.plugin) {
                    console.log('Calling populatePluginForm with:', data.plugin);
                    populatePluginForm(data.plugin);
                } else {
                    showStatusBanner('Plugin not found: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('Plugin fetch error:', error);
                showStatusBanner('Error loading plugin details: ' + error.message, 'error');
            }
        }

        let currentPluginName = '';
        let currentPluginVersion = 0;
        let originalPluginConfig = null;

        function populatePluginForm(plugin) {
            // Store plugin info in memory
            currentPluginName = plugin.name;
            currentPluginVersion = plugin.version || 0;
            originalPluginConfig = JSON.parse(JSON.stringify(plugin));  // Deep copy of original plugin

            // Show settings container, hide placeholder
            document.getElementById('pluginSettingsContainer').style.display = 'flex';
            document.getElementById('pluginPlaceholder').style.display = 'none';
            
            // Show reload button
            document.getElementById('reloadPluginBtn').style.display = 'inline-block';

            // Update header
            document.getElementById('headerPluginName').textContent = plugin.name;
            document.getElementById('headerPluginVersion').textContent = plugin.version || '0';

            // Basic info
            document.getElementById('pluginDisplayName').value = plugin.display_name || '';
            document.getElementById('pluginDescription').value = plugin.description || '';
            document.getElementById('pluginEnabled').checked = plugin.enabled === 1 || plugin.enabled === true;

            // Metadata
            document.getElementById('pluginCreatedAt').value = plugin.created_at || '';
            document.getElementById('pluginCreatedBy').value = plugin.created_by || '';
            document.getElementById('pluginUpdatedAt').value = plugin.updated_at || '';
            document.getElementById('pluginUpdatedBy').value = plugin.updated_by || '';

            // Config
            const config = plugin.config || {};
            document.getElementById('configTypeValue').textContent = config.type || '';
            document.getElementById('configRateLimit').value = config.rateLimit || 100;
            document.getElementById('configRoutes').value = Array.isArray(config.routes) ? config.routes.join('\n') : '';

            // Show/hide API fields based on plugin type
            const apiFieldsContainer = document.getElementById('apiFieldsContainer');
            const bearerAuthFields = document.getElementById('bearerAuthFields');
            const clientAuthFields = document.getElementById('clientAuthFields');
            const sqlFieldsContainer = document.getElementById('sqlFieldsContainer');

            // Hide all configuration panels by default
            if (apiFieldsContainer) apiFieldsContainer.style.display = 'none';
            if (sqlFieldsContainer) sqlFieldsContainer.style.display = 'none';

            if (config.type === 'api') {
                if (apiFieldsContainer) apiFieldsContainer.style.display = 'block';
                
                // Determine auth type based on fields present
                // Check for publicKey/privateKey (client auth pattern) or apiKey (bearer auth pattern)
                if (config.publicKey || config.privateKey) {
                    // Client/OAuth auth (includes MeshCentral, CWM, etc.)
                    if (bearerAuthFields) bearerAuthFields.style.display = 'none';
                    if (clientAuthFields) clientAuthFields.style.display = 'block';
                    document.getElementById('configClientBaseUrl').value = config.baseUrl || '';
                    document.getElementById('configClientApiPath').value = config.apiPath || '';
                    document.getElementById('configClientId').value = config.clientId || '';
                    document.getElementById('configPublicKey').value = config.publicKey || '';
                    document.getElementById('configPrivateKey').value = config.privateKey || '';
                } else if (config.apiKey) {
                    // Bearer token auth (Snipe-IT, etc.)
                    if (bearerAuthFields) bearerAuthFields.style.display = 'block';
                    if (clientAuthFields) clientAuthFields.style.display = 'none';
                    document.getElementById('configBaseUrl').value = config.baseUrl || '';
                    document.getElementById('configApiPath').value = config.apiPath || '';
                    document.getElementById('configApiKey').value = config.apiKey || '';
                }
            } else if (config.type === 'sql') {
                // SQL type - show SQL Configurations panel
                if (sqlFieldsContainer) sqlFieldsContainer.style.display = 'block';
                
                // Initialize currentDatabases from config
                currentDatabases = JSON.parse(JSON.stringify(config.databases || {}));
                
                // Populate SQL database dropdown
                const dbSelect = document.getElementById('sqlDatabaseSelect');
                dbSelect.innerHTML = '<option value="">-- Select Database --</option>';
                for (const dbName in currentDatabases) {
                    const option = document.createElement('option');
                    option.value = dbName;
                    option.textContent = dbName;
                    dbSelect.appendChild(option);
                }
                
                // Hide the form and disable buttons since nothing is selected
                const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
                if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'none';
                const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
                const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
                const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
                if (testBtn) testBtn.disabled = true;
                if (cancelBtn) cancelBtn.disabled = true;
                if (deleteBtn) deleteBtn.disabled = true;
            }
            
            // Store headers for editing BEFORE initializing unsaved changes tracking
            if (config.type === 'api') {
                currentEditingHeaders = JSON.parse(JSON.stringify(config.headers || []));
            }
            
            // Initialize unsaved changes tracking after all fields are populated
            const formData = getCurrentPluginFormData();
            console.log('populatePluginForm - Initial form data:', formData);
            console.log('populatePluginForm - Original config:', plugin.config);
            window.initializeUnsavedTracking(formData);
            console.log('populatePluginForm - Unsaved changes after init:', window.hasUnsavedChanges());
            updateSaveButtonState();
        }

        let currentEditingHeaders = [];

        /**
         * Open modal to edit headers for API plugin
         */
        function openEditHeadersModal() {
            console.log('openEditHeadersModal - currentEditingHeaders:', currentEditingHeaders);
            
            const fields = [
                {
                    name: 'headers',
                    type: 'custom:headers',
                    label: 'Additional Headers',
                    required: false
                }
            ];

            showFormModal('Edit Headers', fields, async (formData) => {
                // Extract headers from DOM since custom:headers field doesn't populate formData
                const headerDivs = document.querySelectorAll('[id^="header_"]');
                const headers = [];
                headerDivs.forEach(div => {
                    const inputs = div.querySelectorAll('input[type="text"]');
                    if (inputs.length === 2) {
                        const key = inputs[0].value.trim();
                        const value = inputs[1].value.trim();
                        if (key && value) {
                            headers.push({ key, value });
                        }
                    }
                });
                
                console.log('Headers extracted from modal:', headers);
                console.log('Previous headers:', currentEditingHeaders);
                
                // Check if headers actually changed
                const oldHeadersJson = JSON.stringify(currentEditingHeaders);
                const newHeadersJson = JSON.stringify(headers);
                
                console.log('Headers changed?', oldHeadersJson !== newHeadersJson);
                
                if (oldHeadersJson !== newHeadersJson) {
                    // Headers changed, update
                    currentEditingHeaders = headers;
                    console.log('Updated currentEditingHeaders to:', currentEditingHeaders);
                }
                
                updateSaveButtonState();
            });
            
            // Wait for modal to render, then populate existing headers
            setTimeout(() => {
                console.log('Looking for Add Header button...');
                
                // Find the "Add Header" button
                const addHeaderBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.trim() === 'Add Header');
                console.log('Add Header button:', addHeaderBtn);
                
                if (addHeaderBtn && addHeaderBtn.parentElement) {
                    const container = addHeaderBtn.parentElement;
                    
                    currentEditingHeaders.forEach((header, index) => {
                        const rowId = 'header_' + (Date.now() + index);
                        const headerDiv = document.createElement('div');
                        headerDiv.id = rowId;
                        headerDiv.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-bottom: 8px;';
                        headerDiv.innerHTML = `
                            <input type="text" placeholder="Header name" value="${header.key || ''}" style="flex: 1; padding: 6px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px;">
                            <input type="text" placeholder="Header value" value="${header.value || ''}" style="flex: 2; padding: 6px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px;">
                            <button type="button" class="btn" data-color="red" data-size="sm" onclick="document.getElementById('${rowId}').remove()">Remove</button>
                        `;
                        
                        console.log('Inserting header before Add Header button:', header);
                        container.insertBefore(headerDiv, addHeaderBtn);
                    });
                } else {
                    console.log('Could not find Add Header button or its parent');
                }
            }, 100);
        }

        let currentDatabases = {};
        let selectedSqlDatabaseName = null;  // Track the original name of the selected database

        function selectSqlDatabase() {
            const dbSelect = document.getElementById('sqlDatabaseSelect');
            const dbName = dbSelect.value;
            
            if (!dbName) {
                const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
                if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'none';
                const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
                const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
                const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
                if (testBtn) testBtn.disabled = true;
                if (cancelBtn) cancelBtn.disabled = true;
                if (deleteBtn) deleteBtn.disabled = true;
                return;
            }
            
            selectedSqlDatabaseName = dbName;  // Store original name
            const db = currentDatabases[dbName];
            
            if (db) {
                document.getElementById('sqlDbType').value = db.type || '';
                document.getElementById('sqlDbHost').value = db.host || '';
                document.getElementById('sqlDbPort').value = db.port || '';
                document.getElementById('sqlDbUser').value = db.user || '';
                document.getElementById('sqlDbPassword').value = '';  // Don't show stored password
                document.getElementById('sqlDbDatabase').value = db.database || '';
                document.getElementById('sqlDbEncrypt').checked = db.encrypt || false;
                document.getElementById('sqlDbTrustServerCert').checked = db.trustServerCert || false;
            }
            
            updateSqlDbTypeFields();
            const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
            if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'block';
            const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
            const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
            const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
            if (testBtn) testBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
            if (deleteBtn) deleteBtn.disabled = false;
        }

        function saveSqlDatabaseForm(dbNameOrOriginal) {
            const name = dbNameOrOriginal || document.getElementById('sqlDbName').value;
            
            if (!name) {
                showStatusBanner('Database name is required', 'error');
                return;
            }
            
            // If renaming, delete the old entry
            if (selectedSqlDatabaseName && selectedSqlDatabaseName !== name) {
                delete currentDatabases[selectedSqlDatabaseName];
            }
            
            currentDatabases[name] = {
                name: name,
                type: document.getElementById('sqlDbType').value,
                host: document.getElementById('sqlDbHost').value,
                port: parseInt(document.getElementById('sqlDbPort').value) || 1433,
                user: document.getElementById('sqlDbUser').value,
                password: document.getElementById('sqlDbPassword').value,
                database: document.getElementById('sqlDbDatabase').value,
                encrypt: document.getElementById('sqlDbEncrypt').checked,
                trustServerCert: document.getElementById('sqlDbTrustServerCert').checked
            };
            
            // Update dropdown
            const dbSelect = document.getElementById('sqlDatabaseSelect');
            let option = Array.from(dbSelect.options).find(opt => opt.value === selectedSqlDatabaseName);
            
            if (option) {
                option.value = name;
                option.textContent = name;
            } else {
                option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                dbSelect.appendChild(option);
            }
            
            dbSelect.value = name;
            selectedSqlDatabaseName = name;  // Update tracked name
        }

        async function testSqlConnection() {
            const dbName = selectedSqlDatabaseName;
            
            if (!dbName) {
                showStatusBanner('Please select a database', 'error');
                return;
            }
            
            // Save form first
            saveSqlDatabaseForm(dbName);
            
            const db = currentDatabases[dbName];
            const testQuery = db.type === 'mysql' ? 'SELECT 1' : 'SELECT 1';
            
            try {
                if (!sessionToken) {
                    sessionToken = await getSessionToken();
                }

                // Use the executeSqlQuery function with the configuration name
                const result = await executeSqlQuery(sessionToken, 'admin', dbName, testQuery);
                
                const resultDiv = document.getElementById('sqlTestResult');
                if (result.success) {
                    resultDiv.innerHTML = `<p style="color: #4caf50; margin: 0;">✓ Connection successful</p>`;
                    resultDiv.style.display = 'block';
                } else {
                    resultDiv.innerHTML = `<p style="color: #b8242f; margin: 0;">✗ Connection failed: ${result.error}</p>`;
                    resultDiv.style.display = 'block';
                }
            } catch (error) {
                const resultDiv = document.getElementById('sqlTestResult');
                resultDiv.innerHTML = `<p style="color: #b8242f; margin: 0;">✗ Error: ${error.message}</p>`;
                resultDiv.style.display = 'block';
            }
        }

        function updateSqlDbTypeFields() {
            const dbType = document.getElementById('sqlDbType').value;
            const mssqlFields = document.querySelectorAll('[id^="sqlDbEncrypt"], [id^="sqlDbTrustServerCert"]').forEach(el => {
                el.parentElement.style.display = dbType === 'mssql' ? 'flex' : 'none';
            });
        }

        // Code modal - called directly via showFormModal in HTML

        // Password modal - called directly via showFormModal in HTML

        // Reload Plugin modal state
        async function openReloadPluginModal() {
            const pluginName = currentPluginName;
            if (!pluginName) {
                showStatusBanner('No plugin selected', 'error');
                return;
            }

            try {
                if (!sessionToken) {
                    sessionToken = await getSessionToken();
                }

                const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/load?name=${encodeURIComponent(pluginName)}`, {
                    method: 'POST',
                    headers: {
                        'X-Session-Token': sessionToken,
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                if (response.ok) {
                    showStatusBanner(`Plugin "${pluginName}" reloaded successfully.`, 'success');
                } else {
                    showStatusBanner('Error reloading plugin: ' + (data.message || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('Error reloading plugin:', error);
                showStatusBanner('Error reloading plugin', 'error');
            }
        }

        function addSqlDatabase() {
            const dbSelect = document.getElementById('sqlDatabaseSelect');
            const form = document.getElementById('sqlDatabaseForm');
            
            // Clear dropdown selection
            dbSelect.value = '';
            selectedSqlDatabaseName = null;  // No original name for new database
            
            // Hide test result banner
            const resultDiv = document.getElementById('sqlTestResult');
            resultDiv.style.display = 'none';
            
            // Clear all form fields
            document.getElementById('sqlDbType').value = '';
            document.getElementById('sqlDbHost').value = '';
            document.getElementById('sqlDbPort').value = '';
            document.getElementById('sqlDbUser').value = '';
            document.getElementById('sqlDbPassword').value = '';
            document.getElementById('sqlDbDatabase').value = '';
            document.getElementById('sqlDbEncrypt').checked = false;
            document.getElementById('sqlDbTrustServerCert').checked = false;
            
            updateSqlDbTypeFields();
            if (form) form.style.display = 'block';
        }

        function doCancelSqlDatabase() {
            document.getElementById('sqlDatabaseSelect').value = '';
            const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
            if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'none';
            const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
            const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
            const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
            if (testBtn) testBtn.disabled = true;
            if (cancelBtn) cancelBtn.disabled = true;
            if (deleteBtn) deleteBtn.disabled = true;
            selectedSqlDatabaseName = null;
            window.clearUnsavedChanges();
        }

        function cancelSqlDatabase() {
            if (window.checkUnsavedChanges(getCurrentPluginFormData())) {
                window.showUnsaved(
                    () => {
                        // Save the current SQL database form
                        if (selectedSqlDatabaseName) {
                            saveSqlDatabaseForm(selectedSqlDatabaseName);
                        }
                        window.clearUnsavedChanges();
                    },
                    doCancelSqlDatabase
                );
            } else {
                doCancelSqlDatabase();
            }
        }

        function deleteSqlDatabase() {
            const dbSelect = document.getElementById('sqlDatabaseSelect');
            const dbName = dbSelect.value;
            
            if (!dbName) {
                showStatusBanner('No database selected', 'error');
                return;
            }
            
            showConfirmModal('Delete SQL Configuration', `Delete SQL configuration "${dbName}"? This cannot be undone.`, () => {
                // Remove from currentDatabases
                delete currentDatabases[dbName];
                
                // Remove from dropdown
                const option = Array.from(dbSelect.options).find(opt => opt.value === dbName);
                if (option) {
                    option.remove();
                }
                
                // Reset form and buttons
                const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
                if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'none';
                dbSelect.value = '';
                const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
                const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
                const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
                if (testBtn) testBtn.disabled = true;
                if (cancelBtn) cancelBtn.disabled = true;
                if (deleteBtn) deleteBtn.disabled = true;
                
                showStatusBanner(`SQL configuration "${dbName}" deleted.`, 'success');
            });
        }

        async function savePluginSettings() {
            const pluginName = currentPluginName;
            const btn = document.getElementById('savePluginBtn');
            const originalText = btn.textContent;

            btn.disabled = true;
            btn.textContent = 'Saving...';

            try {
                if (!sessionToken) {
                    sessionToken = await getSessionToken();
                }

                // Build the update object from form values
                // Increment version: "1.0" -> "1.1", "1.9" -> "1.10", etc.
                let newVersion = '1.0';
                if (currentPluginVersion) {
                    const parts = currentPluginVersion.toString().split('.');
                    if (parts.length === 2) {
                        const major = parseInt(parts[0]) || 1;
                        const minor = (parseInt(parts[1]) || 0) + 1;
                        newVersion = `${major}.${minor}`;
                    }
                }

                const updates = {
                    display_name: document.getElementById('pluginDisplayName').value,
                    version: newVersion,
                    description: document.getElementById('pluginDescription').value,
                    enabled: document.getElementById('pluginEnabled').checked ? 1 : 0,
                    updated_by: currentUser,
                    updated_at: new Date().toISOString().replace('T', ' ').split('.')[0],
                    config: {
                        type: document.getElementById('configTypeValue').textContent,
                        rateLimit: parseInt(document.getElementById('configRateLimit').value) || 100,
                        routes: document.getElementById('configRoutes').value.split('\n').filter(r => r.trim())
                    },
                    originalConfig: originalPluginConfig  // Send original config for history
                };

                // Include code if it was modified
                if (originalPluginConfig && originalPluginConfig.code) {
                    updates.code = originalPluginConfig.code;
                }

                // Add API fields based on type
                const configType = document.getElementById('configTypeValue').textContent;
                if (configType === 'api') {
                    const bearerFields = document.getElementById('bearerAuthFields');
                    const clientFields = document.getElementById('clientAuthFields');

                    if (bearerFields.style.display !== 'none') {
                        // Bearer token auth
                        updates.config.baseUrl = document.getElementById('configBaseUrl').value;
                        updates.config.apiPath = document.getElementById('configApiPath').value;
                        updates.config.apiKey = document.getElementById('configApiKey').value;
                    } else if (clientFields.style.display !== 'none') {
                        // Client/OAuth auth
                        updates.config.baseUrl = document.getElementById('configClientBaseUrl').value;
                        updates.config.apiPath = document.getElementById('configClientApiPath').value;
                        updates.config.clientId = document.getElementById('configClientId').value;
                        updates.config.publicKey = document.getElementById('configPublicKey').value;
                        updates.config.privateKey = document.getElementById('configPrivateKey').value;
                    }
                    
                    // Add headers from current editing state if any
                    if (currentEditingHeaders && currentEditingHeaders.length > 0) {
                        updates.config.headers = currentEditingHeaders;
                    }
                } else if (configType === 'sql') {
                    // Save current SQL database form before submitting
                    const currentDb = document.getElementById('sqlDatabaseSelect').value;
                    if (currentDb) {
                        saveSqlDatabaseForm(currentDb);
                    }
                    // Include all databases in config
                    updates.config.databases = currentDatabases;
                }

                // Send update to server (will create this endpoint next)
                const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/update?name=${encodeURIComponent(pluginName)}`, {
                    method: 'POST',
                    headers: {
                        'X-Session-Token': sessionToken,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(updates)
                });

                const data = await response.json();

                if (response.ok) {
                    window.showStatusBanner('Plugin settings saved successfully.', 'success', 'pluginsStatusMessage');
                    // Auto-reload the plugin to pick up new config
                    try {
                        const reloadResponse = await fetch(`https://app.equinoxits.com:1139/kore/plugins/load?name=${encodeURIComponent(pluginName)}`, {
                            method: 'POST',
                            headers: {
                                'X-Session-Token': sessionToken,
                                'Content-Type': 'application/json'
                            }
                        });
                        if (reloadResponse.ok) {
                            window.showStatusBanner('Plugin saved successfully.', 'success', 'pluginsStatusMessage');
                        }
                    } catch (reloadError) {
                        console.error('Error reloading plugin after save:', reloadError);
                    }
                    cancelPluginSelection();
                } else {
                    window.showStatusBanner('Error: ' + (data.error || 'Unknown error'), 'error', 'pluginsStatusMessage');
                }
            } catch (error) {
                window.showStatusBanner('Error saving settings: ' + error.message, 'error', 'pluginsStatusMessage');
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }

        async function reloadSelectedPlugin() {
            const pluginName = document.getElementById('pluginName').value;
            
            if (!pluginName) {
                showStatusBanner('Please select a plugin first', 'error');
                return;
            }

            const btn = document.getElementById('reloadPluginBtn');
            const originalText = btn.textContent;

            btn.disabled = true;
            btn.textContent = 'Reloading...';

            try {
                if (!sessionToken) {
                    sessionToken = await getSessionToken();
                }

                const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/load?name=${encodeURIComponent(pluginName)}`, {
                    method: 'POST',
                    headers: {
                        'X-Session-Token': sessionToken,
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                if (response.ok) {
                    showStatusBanner('Plugin "' + pluginName + '" reloaded successfully.', 'success');
                    loadPluginDetails();
                } else {
                    showStatusBanner('Error: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                showStatusBanner('Error: ' + error.message, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
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
                        } else if (activeTab && activeTab.textContent.includes('Plugin')) {
                            if (currentPluginName) {
                                await savePluginSettings();
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
                    sessionToken = await window.getSessionToken();
                }
                
                // Only load if not already cached
                if (cachedStackTypes) {
                    return;
                }
                
                const [rmmTypes, psaTypes, controlTypes, rpaTypes, bdrTypes] = await Promise.all([
                    window.getRmmTypes(sessionToken, currentUser),
                    window.getPsaTypes(sessionToken, currentUser),
                    window.getControlTypes(sessionToken, currentUser),
                    window.getRpaTypes(sessionToken, currentUser),
                    window.getBdrTypes(sessionToken, currentUser)
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
                    'SELECT timezone FROM system_config'
                );
                
                console.log('System config query result:', result);
                
                if (result && result.result && result.result.length > 0) {
                    const configRow = result.result[0];
                    currentSystemConfig = {
                        timezone: configRow.timezone || 'UTC'
                    };
                } else {
                    currentSystemConfig = { timezone: 'UTC' };
                }
                
                populateTimezoneSelect();
                // Initialize unsaved tracking after timezone is set in the DOM
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
            return {
                timezone: document.getElementById('systemTimezone').value || 'UTC'
            };
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
                currentSystemConfig = formData;
                
                // Save to system_config using SQL
                const updateSql = `UPDATE system_config SET timezone = '${formData.timezone}'`;
                
                await executeSqlQuery(sessionToken, currentUser, 'kore_sys', updateSql);
                
                // Reinitialize unsaved tracking with the saved data
                window.initializeUnsavedTracking(formData);
                checkSystemUnsavedChanges();
                
                window.showStatusBanner('System configuration saved successfully', 'success', 'generalStatusMessage');
            } catch (error) {
                console.error('Error saving system config:', error);
                window.showStatusBanner('Error saving system configuration: ' + error.message, 'error', 'generalStatusMessage');
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            buildKoreHeader('Settings');
            currentUser = getUser();
            // Load system, email and logging config when General tab is active (only if on /settings page)
            if (document.getElementById('systemTimezone')) {
                loadSystemConfig();
            }
            if (document.getElementById('emailProfileSelect')) {
                loadEmailConfig();
            }
            if (document.getElementById('loggingLogLevel')) {
                loadLoggingConfig();
            }
            // Don't load organizations on page load - load them when tab is opened
            
            
            // Add change listeners to all plugin configuration form fields
            const allFormFields = [
                // Basic plugin info
                'pluginDisplayName', 'pluginDescription', 'pluginEnabled',
                // Config fields
                'configRateLimit', 'configRoutes',
                // API Bearer auth fields
                'configBaseUrl', 'configApiPath', 'configApiKey',
                // API Client auth fields
                'configClientBaseUrl', 'configClientApiPath', 'configClientId',
                'configPublicKey', 'configPrivateKey',
                // SQL database form fields
                'sqlDbType', 'sqlDbHost', 'sqlDbPort',
                'sqlDbUser', 'sqlDbPassword', 'sqlDbDatabase',
                'sqlDbEncrypt', 'sqlDbTrustServerCert'
            ];
            
            allFormFields.forEach(fieldId => {
                const field = document.getElementById(fieldId);
                if (field) {
                    field.addEventListener('change', () => {
                        window.checkUnsavedChanges(getCurrentPluginFormData());
                        updateSaveButtonState();
                    });
                    field.addEventListener('input', () => {
                        window.checkUnsavedChanges(getCurrentPluginFormData());
                        updateSaveButtonState();
                    });
                }
            });
            
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
                const response = await fetch(`/users/${userId}/resend-invite`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    window.showStatusBanner('Error resending invite: ' + (data.error || 'Unknown error'), 'error', 'usersStatusMessage');
                    return;
                }
                
                window.showStatusBanner('Invite resent successfully', 'success', 'usersStatusMessage');
            } catch (error) {
                console.error('Error resending invite:', error);
                window.showStatusBanner('Error resending invite: ' + error.message, 'error', 'usersStatusMessage');
            }
        }

        function switchToUsersTab(event) {
            switchTabWithUnsavedCheck('usersTab', event, loadUsersList);
        }

        function switchToGroupsTab(event) {
            switchTabWithUnsavedCheck('groupsTab', event, loadGroupsList);
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
                    sessionToken = await window.getSessionToken();
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
                    sessionToken = await window.getSessionToken();
                }

                const config = getSecurityFormData();

                // Escape single quotes in JSON for SQL
                const configJson = JSON.stringify(config).replace(/'/g, "''");
                
                const result = await window.executeSqlQuery(
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
                    sessionToken = await window.getSessionToken();
                }
                console.log('sessionToken:', sessionToken);

                if (!currentUser) {
                    console.log('currentUser is null, getting from localStorage');
                    currentUser = window.getUser();
                    console.log('currentUser after getUser():', currentUser);
                }
                console.log('currentUser:', currentUser);

                if (!currentUser) {
                    window.showStatusBanner('No user data available', 'error', 'userprefStatusMessage');
                    return;
                }

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
                    sessionToken = await window.getSessionToken();
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
                    sessionToken = await window.getSessionToken();
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
                    sessionToken = await window.getSessionToken();
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