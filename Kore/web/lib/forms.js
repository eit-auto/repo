import '/lib/base.js';

// ============================================================================
// Forms Library - Form CRUD operations and UI management
// ============================================================================

let forms = [];
let forms_folders = [];
let currentSort = { column: 'updated_at', ascending: false };
let currentSelectedFolder = null;  // Track which folder is currently selected
let filters = {
    name: '',
    description: '',
    lastModified: '',
    modifiedBy: '',
    active: ''
};

/**
 * Load all forms from backend
 */
async function loadForms() {
    try {
        const loadingSpinner = document.getElementById('loadingSpinner');
        if (loadingSpinner) {
            loadingSpinner.classList.add('show');
            loadingSpinner.style.display = 'block';
        }

        const response = await fetch('https://app.equinoxits.com:1139/kore/forms?active=0', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        forms = data.forms || [];
        window.forms = forms;
        console.log('Forms loaded:', forms.map(f => ({ id: f.id, name: f.definition?.name || f.name, folder_id: f.folder_id })));

        // Load users and groups for name resolution in tables
        await loadAllUsersAndGroupsForModal();

        if (loadingSpinner) {
            loadingSpinner.classList.remove('show');
            loadingSpinner.style.display = 'none';
        }

        return forms;
    } catch (error) {
        console.error('Error loading forms:', error);
        const loadingSpinner = document.getElementById('loadingSpinner');
        if (loadingSpinner) {
            loadingSpinner.textContent = 'Error loading forms';
            loadingSpinner.classList.remove('show');
            loadingSpinner.style.display = 'block';
        }
        return [];
    }
}

/**
 * Save form with full object (like saveWorkflow in workflows.js)
 */
async function saveForm(formId, formData, options = {}) {
    const {
        updateMetadata = true,
        onSuccess = null,
        onError = null
    } = options;

    try {
        const { name, version, definition, folder_id = null } = formData;
        
        console.log('saveForm called with:', { formId, name, version, folder_id, hasDefinition: !!definition });

        if (!name && !definition?.name) {
            throw new Error('Form name is required');
        }

        if (!version || !definition) {
            throw new Error('Version and definition are required');
        }

        // Build full payload like workflows does - send everything
        const payload = {
            name: name || definition.name,
            version,
            definition,
            folder_id: folder_id || null
        };
        
        console.log('Sending full payload to API:', JSON.stringify(payload, null, 2));

        const response = await fetch(`https://app.equinoxits.com:1139/kore/forms/${formId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        console.log('API response status:', response.status, response.statusText);
        
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            console.error('API error response:', data);
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        console.log('API success response:', result);

        if (onSuccess) {
            onSuccess(result);
        }

        return result;
    } catch (error) {
        console.error('Error saving form:', error);
        if (onError) {
            onError(error);
        }
        throw error;
    }
}

/**
 * Show form context menu
 */
async function showFormMenu(event, formId) {
    console.log('showFormMenu called with formId:', formId);
    event.stopPropagation();

    // Remove any existing menus
    const existingMenu = document.getElementById('formContextMenu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const form = forms.find(f => f.id === formId);
    const activeValue = form?.definition?.active;
    const toggleButtonText = activeValue === false ? 'Enable' : 'Disable';

    // Check permissions
    let canAccessSettings = form?.canEdit === true;
    let canDelete = form?.canDelete === true;

    const menu = document.createElement('div');
    menu.id = 'formContextMenu';
    menu.style.cssText = `
        position: fixed;
        background: #234656;
        border: 1px solid #556870;
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        z-index: 1000;
        min-width: 180px;
    `;

    menu.innerHTML = `
        <div style="padding: 4px;">
            <button onclick="toggleFormActive('${formId}'); document.getElementById('formContextMenu').remove();" style="display: block; width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: #c0c0c0; cursor: pointer; font-size: 0.9rem;">
                ${toggleButtonText}
            </button>
            <button onclick="showFormPropertiesModal('${formId}'); document.getElementById('formContextMenu').remove();" style="display: block; width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: ${canAccessSettings ? '#c0c0c0' : '#666'}; cursor: ${canAccessSettings ? 'pointer' : 'not-allowed'}; font-size: 0.9rem;" ${canAccessSettings ? '' : 'disabled'}>
                Settings
            </button>
            <button onclick="deleteForm('${formId}'); document.getElementById('formContextMenu').remove();" style="display: block; width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: ${canDelete ? '#ff6b6b' : '#666'}; cursor: ${canDelete ? 'pointer' : 'not-allowed'}; font-size: 0.9rem;" ${canDelete ? '' : 'disabled'}>
                Delete
            </button>
        </div>
    `;

    // Position menu near button
    const rect = event.target.getBoundingClientRect();
    menu.style.left = (rect.left - 180 + rect.width) + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';

    document.body.appendChild(menu);

    // Close menu when clicking elsewhere
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (e.target !== event.target && !menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 0);
}

/**
 * Toggle form active status
 */
async function toggleFormActive(formId) {
    const form = forms.find(f => f.id === formId);
    if (!form) return;

    const currentActive = form.definition?.active === true;
    const newActive = !currentActive;

    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/forms/${formId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ active: newActive })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        form.active = newActive;
        rerenderCurrentView();
        showStatusBanner(`Form ${newActive ? 'enabled' : 'disabled'} successfully`, 'success');
    } catch (error) {
        console.error('Error toggling form active state:', error);
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to update form: ${error.message}`
        });
    }
}

/**
 * Edit a form (navigate to form builder)
 */
function editForm(formId) {
    window.location.href = `/form-builder?form_id=${formId}`;
}

/**
 * Delete a form
 */
function deleteForm(formId) {
    const form = forms.find(f => f.id === formId);
    if (!form) {
        alert('Form not found');
        return;
    }

    const formName = form.definition?.name || form.name || '';

    showDeleteConfirm(
        `Are you sure you want to delete <strong>${formName}</strong>? This action cannot be undone.`,
        async () => {
            try {
                const response = await fetch(`https://app.equinoxits.com:1139/kore/forms/${formId}`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include'
                });

                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
                }

                // Close confirm modal, then refresh
                closeModal();
                await loadForms();
                rerenderCurrentView();
                showStatusBanner(`${formName} has been deleted.`, 'success');
            } catch (error) {
                console.error('Error deleting form:', error);
                showModal({
                    type: 'error',
                    title: 'Error Deleting Form',
                    content: error.message,
                    buttons: [
                        {
                            label: 'OK',
                            type: 'secondary',
                            onClick: () => {}
                        }
                    ]
                });
            }
        }
    );
}

/**
 * Open modal to create a new form
 */
function openCreateModal() {
    showFormModal(
        'Create New Form',
        [
            {
                name: 'formName',
                type: 'text',
                label: 'Form Name',
                placeholder: 'Enter form name',
                required: true
            },
            {
                name: 'formDescription',
                type: 'text',
                label: 'Description',
                placeholder: 'Optional description'
            }
        ],
        async (formData) => {
            const formName = formData.formName?.trim();

            if (!formName) {
                showModal({
                    title: 'Error',
                    content: 'Form name is required',
                    buttons: [
                        {
                            label: 'OK',
                            className: 'btn-blue',
                            callback: ({ close }) => close()
                        }
                    ]
                });
                return;
            }

            try {
                const payload = {
                    name: formName,
                    description: formData.formDescription?.trim() || null
                };

                console.log('Creating form with payload:', payload);

                const response = await fetch('https://app.equinoxits.com:1139/kore/forms', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include',
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
                }

                const result = await response.json();
                const newFormId = result.id;

                // Refresh the forms list, then redirect to form builder
                await loadForms();
                rerenderCurrentView();
                setTimeout(() => {
                    window.location.href = `/form-builder?form_id=${newFormId}`;
                }, 1000);
            } catch (error) {
                console.error('Error creating form:', error);
                showModal({
                    title: 'Error Creating Form',
                    content: error.message,
                    buttons: [
                        {
                            label: 'OK',
                            className: 'btn-blue',
                            callback: ({ close }) => close()
                        }
                    ]
                });
            }
        }
    );
}

/**
 * Open modal to import a form from a pasted definition JSON - e.g. a
 * definition built externally (Rewst-migration tooling, hand-written, etc.)
 * rather than authored from scratch via "Create New Form". Mirrors
 * workflows.js's openImportModal for the Forms page.
 *
 * Unlike workflows' import (a single POST that accepts the full definition
 * directly - createWorkflow derives name/version from it server-side), the
 * only confirmed form-creation contract is openCreateModal's plain
 * `POST /kore/forms` with just `{name, description}` - the same call
 * saveForm()/saveFormToDatabase() (form-builder.js) use for updates is a
 * PUT against an existing form's id, not a create. So this goes in two
 * steps: create a blank form record first to get an id, then PUT the
 * pasted definition onto it - same two calls a person would make by hand
 * (Create New Form, then Import Form JSON in the builder). If the create
 * succeeds but the PUT fails, the blank form still exists; rather than
 * leaving it silently orphaned, this still opens the builder for it and
 * says to retry the import there.
 */
function openImportFormModal() {
    window.pendingImportFormFolder = null;

    const modalContent = document.createElement('div');
    modalContent.innerHTML = `
        <div style="margin-bottom: 14px;">
            <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary);">Form Definition JSON</label>
            <textarea id="importFormDefinitionInput" rows="12" placeholder="Paste the form definition JSON here"
                style="width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.8rem; padding: 10px;
                       border: 1px solid var(--border-primary); border-radius: 4px; background: var(--bg-input); color: var(--text-primary); resize: vertical;"></textarea>
            <div id="importFormJsonError" style="color: #f44336; font-size: 0.8rem; margin-top: 4px; display: none;"></div>
        </div>
        <div>
            <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary);">Folder (optional)</label>
            <div id="importFormFolderTree" style="border: 1px solid var(--border-primary); border-radius: 4px; max-height: 200px; overflow-y: auto; background: var(--bg-input); padding: 8px;"></div>
        </div>
    `;

    showModal({
        title: 'Import Form',
        content: modalContent,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Import',
                type: 'success',
                onClick: async () => {
                    const errorEl = modalContent.querySelector('#importFormJsonError');
                    errorEl.style.display = 'none';

                    const rawJson = modalContent.querySelector('#importFormDefinitionInput').value.trim();
                    if (!rawJson) {
                        errorEl.textContent = 'Paste a form definition JSON before importing.';
                        errorEl.style.display = 'block';
                        return false; // keep modal open
                    }

                    let definition;
                    try {
                        definition = JSON.parse(rawJson);
                    } catch (e) {
                        errorEl.textContent = `Invalid JSON: ${e.message}`;
                        errorEl.style.display = 'block';
                        return false;
                    }

                    const fieldConfigsArray = definition.field_configs || definition.fieldConfigs;
                    if (!Array.isArray(fieldConfigsArray) || fieldConfigsArray.length === 0) {
                        errorEl.textContent = 'Definition must include a non-empty "field_configs" array.';
                        errorEl.style.display = 'block';
                        return false;
                    }
                    const formName = definition.form_name || definition.name || definition.formName;
                    if (!formName) {
                        errorEl.textContent = 'Definition must include a "form_name".';
                        errorEl.style.display = 'block';
                        return false;
                    }

                    let newFormId;
                    try {
                        // Step 1: create the blank form record (confirmed contract
                        // - see openCreateModal above).
                        const createResponse = await fetch('https://app.equinoxits.com:1139/kore/forms', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({ name: formName, description: null })
                        });

                        if (!createResponse.ok) {
                            const data = await createResponse.json().catch(() => ({}));
                            throw new Error(data.error || `HTTP ${createResponse.status}: ${createResponse.statusText}`);
                        }

                        const createResult = await createResponse.json();
                        newFormId = createResult.id;
                    } catch (error) {
                        console.error('Error creating form for import:', error);
                        errorEl.textContent = error.message;
                        errorEl.style.display = 'block';
                        return false; // nothing created yet - keep modal open so the paste isn't lost
                    }

                    try {
                        // Step 2: PUT the pasted definition onto the new form -
                        // same call saveForm()/saveFormToDatabase() use.
                        const putResponse = await fetch(`https://app.equinoxits.com:1139/kore/forms/${newFormId}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({
                                name: formName,
                                version: definition.version || '1.0',
                                definition,
                                folder_id: window.pendingImportFormFolder || null
                            })
                        });

                        if (!putResponse.ok) {
                            const data = await putResponse.json().catch(() => ({}));
                            throw new Error(data.error || `HTTP ${putResponse.status}: ${putResponse.statusText}`);
                        }

                        await loadForms();
                        rerenderCurrentView();
                        window.location.href = `/form-builder?form_id=${newFormId}`;
                    } catch (error) {
                        // The blank form (newFormId) exists even though the
                        // definition didn't land - send the user to the builder
                        // for it rather than leaving a silently orphaned empty
                        // form with no way back to finish the import.
                        console.error('Error importing form definition:', error);
                        await loadForms();
                        rerenderCurrentView();
                        showModal({
                            title: 'Form Created, Import Incomplete',
                            content: `<p style="color: var(--text-primary); margin: 0;">The form was created, but importing the pasted definition failed: ${error.message}. Opening the form now - use "Import Form JSON" in the builder's menu to retry.</p>`,
                            buttons: [{
                                label: 'OK',
                                type: 'primary',
                                onClick: () => { window.location.href = `/form-builder?form_id=${newFormId}`; }
                            }]
                        });
                    }
                }
            }
        ],
        width: '600px'
    });

    // Populate the folder tree the same way the form Properties modal does
    setTimeout(() => {
        const folders = window.forms_folders || [];
        const treeContainer = modalContent.querySelector('#importFormFolderTree');
        if (!treeContainer) return;

        const resetHighlights = () => {
            treeContainer.querySelectorAll('[data-item-id]').forEach(el => { el.style.background = 'transparent'; });
            noFolderDiv.style.background = 'transparent';
        };

        const noFolderDiv = document.createElement('div');
        noFolderDiv.style.cssText = 'padding: 8px; cursor: pointer; border-radius: 3px; margin-bottom: 4px; height: 20px; font-size: 0.8rem; background: rgba(126, 200, 255, 0.2);';
        noFolderDiv.textContent = 'No Folder';
        noFolderDiv.onclick = () => {
            window.pendingImportFormFolder = null;
            resetHighlights();
            noFolderDiv.style.background = 'rgba(126, 200, 255, 0.2)';
        };
        treeContainer.appendChild(noFolderDiv);

        if (folders.length > 0) {
            const treeDiv = document.createElement('div');
            renderTree(folders, treeDiv, {
                onItemClick: (folder) => {
                    window.pendingImportFormFolder = folder.id;
                    resetHighlights();
                    const selectedEl = treeDiv.querySelector(`[data-item-id="${folder.id}"]`);
                    if (selectedEl) selectedEl.style.background = 'rgba(126, 200, 255, 0.2)';
                }
            });
            treeContainer.appendChild(treeDiv);
        }
    }, 0);
}

/**
 * Fetch form permissions from backend
 */
async function getFormPermissions(formId) {
    try {
        const config = {
            resource: 'form',
            endpoint: 'https://app.equinoxits.com:1139/kore/permissions',
            method: 'POST',
            body: {
                resource: 'form',
                scope: formId
            }
        };
        const permissions = await loadPermissionsForResource(config);
        const activePermissions = permissions.filter(p => p.revokedAt === null);
        console.log('Retrieved form permissions:', activePermissions);
        return activePermissions;
    } catch (error) {
        console.error('Error fetching form permissions:', error);
        return [];
    }
}

/**
 * Save form permissions (batch update)
 */
async function saveFormPermissions(formId) {
    try {
        const config = {
            resource: 'form',
            endpoint: 'https://app.equinoxits.com:1139/kore/permissions'
        };
        await savePermissionsForResource(config, formId);
        return { success: true };
    } catch (error) {
        console.error('Error saving form permissions:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Load all users and groups for permission management dropdowns
 */
async function loadAllUsersAndGroupsForModal() {
    try {
        const sessionToken = await getSessionToken();

        const [users, groups] = await Promise.all([
            getUsers(sessionToken, null),
            getGroups(sessionToken, null)
        ]);

        window.allUsersAndGroups = {
            users: users || [],
            groups: groups || []
        };
        return true;
    } catch (error) {
        console.error('Error loading users and groups:', error);
        window.allUsersAndGroups = { users: [], groups: [] };
        return false;
    }
}

/**
 * Show Form Properties Modal with Folder, Permissions, and About tabs
 */
async function showFormPropertiesModal(formId) {
    const form = forms.find(f => f.id === formId);
    if (!form) {
        alert('Form not found');
        return;
    }

    // Load users and groups for name resolution
    await loadAllUsersAndGroupsForModal();

    // Fetch permissions
    const permissions = await getFormPermissions(formId);

    // Format metadata from definition.meta_data
    const meta = form.definition?.meta_data || {};
    const createdAt = meta.created_at ? new Date(meta.created_at).toLocaleString() : 'N/A';
    const updatedAt = meta.modified_at ? new Date(meta.modified_at).toLocaleString() : 'N/A';
    const createdBy = resolveIdToName(meta.created_by) || 'N/A';
    const updatedBy = resolveIdToName(meta.modified_by) || 'N/A';
    const formDisplayName = form.definition?.name || form.name || '';

    const modalContent = document.createElement('div');
    modalContent.innerHTML = `
        <style>
            .settings-tabs {
                display: flex;
                gap: 0;
                margin-bottom: 10px;
                border-bottom: 1px solid var(--border-primary);
            }
            .settings-tab-btn {
                padding: 0 16px 5px 16px;
                background: transparent;
                border: none;
                color: var(--text-secondary);
                font-size: 0.9rem;
                cursor: pointer;
                border-bottom: 2px solid transparent;
                transition: all 0.2s;
            }
            .settings-tab-btn:hover { color: var(--text-primary); }
            .settings-tab-btn.active {
                color: var(--text-primary);
                border-bottom-color: var(--primary-color, #7ec8ff);
            }
            .settings-tab-panel { display: none; }
            .settings-tab-panel.active { display: block; }
            .metadata-grid {
                display: grid;
                grid-template-columns: 60% 40%;
                gap: 20px;
                margin-top: 12px;
            }
            .metadata-item {
                display: flex;
                flex-direction: row;
                gap: 4px;
            }
            .metadata-label {
                font-size: 0.75rem;
                color: var(--text-secondary);
                font-weight: 500;
            }
            .metadata-label::after { content: ':'; }
            .metadata-value {
                font-size: 0.75rem;
                color: var(--text-primary);
                word-break: break-all;
            }
            .empty-state {
                text-align: center;
                padding: 20px;
                color: var(--text-secondary);
            }
        </style>

        <div class="panel-level-2">
        <div class="settings-tabs">
            <button class="settings-tab-btn active" data-tab="tab-folder">Folder</button>
            <button class="settings-tab-btn" data-tab="tab-permissions">Permissions</button>
            <button class="settings-tab-btn" data-tab="tab-about">About</button>
        </div>

        <!-- Folder Tab -->
        <div class="settings-tab-panel active" id="tab-folder">
            <div id="settingsFolderTree" style="border: 1px solid var(--border-primary); border-radius: 4px; max-height: 300px; overflow-y: auto; background: var(--bg-input); padding: 8px;">
            </div>
        </div>

        <!-- Permissions Tab -->
        <div class="settings-tab-panel" id="tab-permissions">
            <div id="permissionsFormContainer"></div>
        </div>

        <!-- About Tab -->
        <div class="settings-tab-panel" id="tab-about">
            <div class="metadata-grid">
                <div class="metadata-item">
                    <div class="metadata-label">Form ID</div>
                    <div class="metadata-value">${form.id}</div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Version</div>
                    <div class="metadata-value">${form.version || 'N/A'}</div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Created By</div>
                    <div class="metadata-value">${createdBy}</div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Created At</div>
                    <div class="metadata-value">${createdAt}</div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Updated By</div>
                    <div class="metadata-value">${updatedBy}</div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Updated At</div>
                    <div class="metadata-value">${updatedAt}</div>
                </div>
            </div>
        </div>
        </div>
    `;

    showModal({
        title: `${formDisplayName} - Settings`,
        content: modalContent,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Save', type: 'success' },
            { label: 'Close', type: 'secondary' }
        ]
    });

    // Add click handlers directly to the buttons
    setTimeout(() => {
        console.log('setTimeout fired, looking for modal...');
        
        // Try different selectors
        let modal = document.querySelector('[role="dialog"]');
        console.log('Modal with [role="dialog"]:', !!modal);
        
        if (!modal) {
            modal = document.querySelector('.modal-container');
            console.log('Modal with .modal-container:', !!modal);
        }
        
        if (!modal) {
            modal = document.querySelector('.modal');
            console.log('Modal with .modal:', !!modal);
        }
        
        if (!modal) {
            // Try to find any element with buttons
            const allButtons = document.querySelectorAll('button');
            console.log('Total buttons on page:', allButtons.length);
            Array.from(allButtons).slice(-5).forEach((btn, i) => {
                console.log(`Recent button ${i}: "${btn.textContent.trim()}", classes: ${btn.className}`);
            });
        }
        
        if (modal) {
            console.log('Found modal:', modal.className);
            const buttons = modal.querySelectorAll('button');
            console.log('Buttons in modal:', buttons.length);
            Array.from(buttons).forEach((btn, i) => {
                console.log(`Button ${i}: "${btn.textContent.trim()}"`);
            });
            
            const saveBtn = Array.from(buttons).find(b => b.textContent.trim() === 'Save');
            const closeBtn = Array.from(buttons).find(b => b.textContent.trim() === 'Close');

            console.log('Save button found:', !!saveBtn);
            console.log('Close button found:', !!closeBtn);

            if (saveBtn) {
                saveBtn.onclick = async (e) => {
                    e.preventDefault();
                    console.log('Save button clicked!');
                    let settingsChanged = false;

                    // Save folder change if pending
                    console.log('pendingFolderChange:', window.pendingFolderChange, 'current folder_id:', form.folder_id);
                    
                    if (window.pendingFolderChange !== undefined && window.pendingFolderChange !== form.folder_id) {
                        console.log('Folder change detected, saving...');
                        
                        try {
                            // Update both the form and definition folder_id (like workflows does)
                            form.folder_id = window.pendingFolderChange || null;
                            if (form.definition) {
                                form.definition.folder_id = window.pendingFolderChange || null;
                            }
                            console.log('Updated form.folder_id and form.definition.folder_id to:', form.folder_id);
                            console.log('Calling saveForm with:', { formId, form });
                            
                            // Send the full form object (not minimal payload)
                            await saveForm(formId, form, { updateMetadata: false });
                            settingsChanged = true;
                            
                            console.log('saveForm completed, reloading forms...');
                            // Reload and re-render
                            await loadForms();
                            if (window.currentSelectedFolder) {
                                renderFilteredForms(forms.filter(f => 
                                    window.currentSelectedFolder.id === 'all' ? true :
                                    window.currentSelectedFolder.id === 'no_folder' ? !f.folder_id :
                                    f.folder_id === window.currentSelectedFolder.id
                                ));
                            } else {
                                renderFormsList();
                            }
                            console.log('Forms re-rendered');
                        } catch (error) {
                            console.error('Folder save error:', error);
                            showStatusBanner(`Failed to update folder: ${error.message}`, 'error');
                        }
                    } else {
                        console.log('No folder change or already same folder');
                    }

                    // Save permissions if any exist
                    let permissionSaveResult = { success: true };
                    const permissionRows = document.querySelectorAll('.permission-row');
                    if (permissionRows.length > 0) {
                        permissionSaveResult = await saveFormPermissions(formId);
                        if (permissionSaveResult.success) {
                            settingsChanged = true;
                        }
                    }

                    delete window.pendingFolderChange;
                    
                    closeModal();

                    if (permissionSaveResult.success) {
                        showStatusBanner('Form settings saved successfully', 'success');
                    } else {
                        showStatusBanner(`Failed to save permissions: ${permissionSaveResult.error}`, 'error');
                    }
                };
            }

            if (closeBtn) {
                closeBtn.onclick = () => {
                    delete window.pendingFolderChange;
                    closeModal();
                };
            }
        }
    }, 0);

    // Setup tab switching
    const tabButtons = modalContent.querySelectorAll('.settings-tab-btn');
    const tabPanels = modalContent.querySelectorAll('.settings-tab-panel');

    const adjustModalHeight = () => {
        const modal = document.querySelector('.modal-container');
        const modalBodyContent = document.querySelector('#modal-body-content');
        if (modal && modalBodyContent) {
            const tabsContainer = modalContent.querySelector('.settings-tabs');
            if (tabsContainer) {
                let maxPanelHeight = 0;
                tabPanels.forEach(panel => {
                    if (panel.scrollHeight > maxPanelHeight) maxPanelHeight = panel.scrollHeight;
                });
                const totalHeight = tabsContainer.offsetHeight + maxPanelHeight + 80;
                const viewportHeight = window.innerHeight;
                const maxModalHeight = viewportHeight * 0.95;
                const newHeight = Math.min(Math.max(totalHeight, 300), maxModalHeight);
                modal.style.cssText = `height: ${newHeight}px !important; min-height: auto !important;`;
                modalBodyContent.style.cssText = `overflow-y: auto !important; max-height: ${maxModalHeight - 100}px !important;`;
            }
        }
    };

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.getAttribute('data-tab');
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabPanels.forEach(panel => panel.classList.remove('active'));
            button.classList.add('active');
            modalContent.querySelector(`#${targetTab}`).classList.add('active');
            setTimeout(adjustModalHeight, 50);
        });
    });

    const resizeObserver = new ResizeObserver(() => adjustModalHeight());
    tabPanels.forEach(panel => resizeObserver.observe(panel));

    // Populate folder tree and permissions
    setTimeout(() => {
        const folders = window.forms_folders || [];
        const treeContainer = modalContent.querySelector('#settingsFolderTree');

        if (treeContainer) {
            const noFolderDiv = document.createElement('div');
            noFolderDiv.style.cssText = 'padding: 8px; cursor: pointer; border-radius: 3px; margin-bottom: 4px; height: 20px; font-size: 0.8rem;';
            noFolderDiv.textContent = 'No Folder';
            noFolderDiv.onclick = () => {
                window.pendingFolderChange = null;
                treeContainer.querySelectorAll('div').forEach(el => el.style.background = 'transparent');
                noFolderDiv.style.background = 'rgba(126, 200, 255, 0.2)';
            };
            if (!form.folder_id) {
                noFolderDiv.style.background = 'rgba(126, 200, 255, 0.2)';
                window.pendingFolderChange = null;
            }
            noFolderDiv.onmouseover = () => {
                if (!noFolderDiv.style.background.includes('0.2')) noFolderDiv.style.background = 'rgba(126, 200, 255, 0.1)';
            };
            noFolderDiv.onmouseout = () => {
                if (!form.folder_id && window.pendingFolderChange === null) {
                    noFolderDiv.style.background = 'rgba(126, 200, 255, 0.2)';
                } else {
                    noFolderDiv.style.background = 'transparent';
                }
            };
            treeContainer.appendChild(noFolderDiv);

            if (folders.length > 0) {
                const treeContainerForRender = document.createElement('div');
                renderTree(folders, treeContainerForRender, {
                    onItemClick: (folder) => {
                        window.pendingFolderChange = folder.id;
                        // Visual feedback: highlight selected folder
                        treeContainer.querySelectorAll('[data-item-id]').forEach(el => {
                            el.style.backgroundColor = '';
                        });
                        noFolderDiv.style.backgroundColor = '';
                        const selectedEl = treeContainerForRender.querySelector(`[data-item-id="${folder.id}"]`);
                        if (selectedEl) {
                            selectedEl.style.backgroundColor = 'rgba(126, 200, 255, 0.2)';
                        }
                    }
                });
                treeContainer.appendChild(treeContainerForRender);
                
                // Pre-select current folder if form has one assigned
                if (form.folder_id) {
                    const currentEl = treeContainerForRender.querySelector(`[data-item-id="${form.folder_id}"]`);
                    if (currentEl) {
                        currentEl.style.backgroundColor = 'rgba(126, 200, 255, 0.2)';
                        window.pendingFolderChange = form.folder_id;
                    }
                }
            }
        }

        loadAllUsersAndGroupsForModal().then(() => {
            const permissionsFormContainer = modalContent.querySelector('#permissionsFormContainer');
            if (permissionsFormContainer) {
                displayPermissionsForm(permissionsFormContainer, permissions, {
                    addButtonLabel: 'Add Permission',
                    showSaveButton: false,
                    actions: ['view', 'edit', 'delete']
                });
            }

            setTimeout(() => {
                const modal = document.querySelector('.modal');
                const modalBodyContent = document.querySelector('.modal-body');
                if (modal && modalBodyContent) {
                    const totalHeight = modalContent.scrollHeight;
                    const viewportHeight = window.innerHeight;
                    const maxModalHeight = viewportHeight * 0.95;
                    const newHeight = Math.min(totalHeight + 100, maxModalHeight);
                    modal.style.cssText = `height: ${newHeight}px !important; min-height: auto !important;`;
                    modalBodyContent.style.cssText = `overflow-y: auto !important; max-height: ${maxModalHeight - 100}px !important;`;
                }
            }, 100);
        });
    }, 50);
}

/**
 * Move form to folder - opens properties modal
 */
function moveFormToFolder(formId) {
    showFormPropertiesModal(formId);
}

/**
 * Filter forms based on search inputs
 */
function filterForms() {
    const filterName = document.getElementById('filterName')?.value.toLowerCase() || '';
    const filterFolder = document.getElementById('filterFolder')?.value.toLowerCase() || '';
    const filterLastModified = document.getElementById('filterLastModified')?.value.toLowerCase() || '';
    const filterModifiedBy = document.getElementById('filterModifiedBy')?.value.toLowerCase() || '';
    const filterActive = document.getElementById('filterActive')?.value.toLowerCase() || '';

    const tableBody = document.getElementById('formsTableBody');
    if (!tableBody) return;

    const rows = tableBody.getElementsByTagName('tr');
    for (let row of rows) {
        const cells = row.getElementsByTagName('td');
        if (cells.length === 0) continue;

        // Columns: Name, Folder, Last Modified, Modified By, Active, Version, Actions
        const name = cells[0]?.textContent.toLowerCase() || '';
        const folder = cells[1]?.textContent.toLowerCase() || '';
        const lastModified = cells[2]?.textContent.toLowerCase() || '';
        const modifiedBy = cells[3]?.textContent.toLowerCase() || '';
        const active = cells[4]?.textContent.toLowerCase() || '';

        const matches =
            name.includes(filterName) &&
            folder.includes(filterFolder) &&
            lastModified.includes(filterLastModified) &&
            modifiedBy.includes(filterModifiedBy) &&
            active.includes(filterActive);

        row.style.display = matches ? '' : 'none';
    }
    applyHideInactive();
}

/**
 * Apply Hide Inactive filter
 */
function applyHideInactive() {
    const hideInactive = document.getElementById('hideInactive')?.checked || false;
    const tableBody = document.getElementById('formsTableBody');
    if (!tableBody) return;

    const rows = tableBody.getElementsByTagName('tr');
    for (let row of rows) {
        const cells = row.getElementsByTagName('td');
        if (cells.length === 0) continue;

        // Active is now column index 4 (Name, Folder, LastModified, ModifiedBy, Active)
        const activeCell = cells[4]?.textContent.toLowerCase() || '';
        const isInactive = activeCell === 'false';

        if (hideInactive && isInactive) {
            row.style.display = 'none';
        } else {
            // Only restore if not hidden by filterForms
            if (row.style.display === 'none' && !hideInactive) {
                row.style.display = '';
            } else if (row.style.display !== 'none') {
                row.style.display = '';
            }
        }
    }
}

/**
 * Render a filtered list of forms (called on folder selection)
 */
function renderFilteredForms(filteredForms) {
    const container = document.getElementById('formsList');
    if (!container) return;
    container.innerHTML = '';

    if (filteredForms.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No forms in this folder</h3>
                <p>Select another folder or create a new form</p>
            </div>
        `;
        return;
    }

    let html = `
        <table class="workflows-table" style="table-layout: fixed; padding: 0 4px; width: 100%;">
            <thead style="background: transparent;">
                <tr style="pointer-events: none; background: transparent !important; background-color: transparent !important;">
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterName" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterForms()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterFolder" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterForms()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterLastModified" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterForms()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterModifiedBy" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterForms()"></th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; padding: 0; background: transparent;"><select id="filterActive" style="width: 100%; height: 100%; box-sizing: border-box; cursor: pointer; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onchange="filterForms()"><option value="">All</option><option value="True">True</option><option value="False">False</option></select></th>
                    <th style="width: 80px; min-width: 80px; max-width: 80px; background: transparent;"></th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; position: relative; background: transparent; padding: 0;"><div style="display: flex; justify-content: flex-end; align-items: center; height: 100%; padding: 0; width: 100%;"><button class="btn" data-color="blue" data-size="sm" onclick="loadForms().then(() => rerenderCurrentView())" style="pointer-events: auto; cursor: pointer;">Refresh</button></div></th>
                </tr>
                <tr style="background: var(--bg-panel2);">
                    <th style="font-weight: bold; font-size: 0.8rem; text-align: left;">Name</th>
                    <th style="font-weight: bold; font-size: 0.8rem; text-align: left;">Folder</th>
                    <th style="font-weight: bold; font-size: 0.8rem; text-align: left;">Last Modified</th>
                    <th style="font-weight: bold; font-size: 0.8rem; text-align: left;">Modified By</th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; font-weight: bold; font-size: 0.8rem; text-align: left;">Active</th>
                    <th style="width: 80px; min-width: 80px; max-width: 80px; font-weight: bold; font-size: 0.8rem; text-align: left;">Version</th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; font-weight: bold; font-size: 0.8rem; text-align: right; padding: 6px; box-sizing: border-box;">Actions</th>
                </tr>
            </thead>
            <tbody id="formsTableBody" style="background: transparent !important;">
    `;

    filteredForms.forEach(form => {
        html += buildFormRow(form);
    });

    html += `
            </tbody>
        </table>
    `;
    container.innerHTML = html;
}

/**
 * Render the full forms list (all forms, no folder filter)
 */
function renderFormsList() {
    const container = document.getElementById('formsList');
    const loadingSpinner = document.getElementById('loadingSpinner');
    if (!container) return;
    if (loadingSpinner) {
        loadingSpinner.classList.remove('show');
    }
    container.innerHTML = '';

    if (forms.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No forms yet</h3>
                <p>Create your first form to get started</p>
            </div>
        `;
        return;
    }

    let html = `
        <table class="workflows-table" style="table-layout: fixed; padding: 0 4px; width: 100%;">
            <thead style="background: transparent;">
                <tr style="pointer-events: none; background: transparent !important; background-color: transparent !important;">
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterName" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterForms()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterFolder" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterForms()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterLastModified" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterForms()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterModifiedBy" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterForms()"></th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; padding: 0; background: transparent;"><select id="filterActive" style="width: 100%; height: 100%; box-sizing: border-box; cursor: pointer; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onchange="filterForms()"><option value="">All</option><option value="True">True</option><option value="False">False</option></select></th>
                    <th style="width: 80px; min-width: 80px; max-width: 80px; background: transparent;"></th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; position: relative; background: transparent; padding: 0;"><div style="display: flex; justify-content: flex-end; align-items: center; height: 100%; padding: 0; width: 100%;"><button class="btn" data-color="blue" data-size="sm" onclick="loadForms().then(() => rerenderCurrentView())" style="pointer-events: auto; cursor: pointer;">Refresh</button></div></th>
                </tr>
                <tr style="background: var(--bg-panel2);">
                    <th style="font-weight: bold; font-size: 0.8rem; text-align: left;">Name</th>
                    <th style="font-weight: bold; font-size: 0.8rem; text-align: left;">Folder</th>
                    <th style="font-weight: bold; font-size: 0.8rem; text-align: left;">Last Modified</th>
                    <th style="font-weight: bold; font-size: 0.8rem; text-align: left;">Modified By</th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; font-weight: bold; font-size: 0.8rem; text-align: left;">Active</th>
                    <th style="width: 80px; min-width: 80px; max-width: 80px; font-weight: bold; font-size: 0.8rem; text-align: left;">Version</th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; font-weight: bold; font-size: 0.8rem; text-align: right; padding: 6px; box-sizing: border-box;">Actions</th>
                </tr>
            </thead>
            <tbody id="formsTableBody" style="background: transparent !important;">
    `;

    forms.forEach(form => {
        html += buildFormRow(form);
    });

    html += `
            </tbody>
        </table>
    `;
    container.innerHTML = html;
    applyHideInactive();
}

/**
 * Build a single form table row
 */
function buildFormRow(form) {
    const def = form.definition || {};
    const meta = def.meta_data || {};
    const name = def.name || form.name || '';
    const description = def.description || '';
    const activeDisplay = def.active === undefined ? 'Undefined' : (def.active ? 'True' : 'False');
    const lastModified = meta.modified_at ? new Date(meta.modified_at).toLocaleString() : 'N/A';
    const modifiedBy = resolveIdToName(meta.modified_by) || 'N/A';
    const version = form.version || '1.0';

    let folderName = '';
    if (form.folder_id) {
        const folders = window.forms_folders || [];
        const folder = folders.find(f => f.id === form.folder_id);
        folderName = folder ? folder.name : form.folder_id;
    }

    const escapedDescription = (description || '(no description)').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    
    return `
        <tr data-form-id="${form.id}" style="font-size: 0.8rem; font-weight: normal;" title="${escapedDescription}">
            <td class="form-name"><a href="/form-builder?form_id=${form.id}" style="color: inherit; text-decoration: none; font-weight: normal;">${name}</a></td>
            <td style="font-weight: normal;">${folderName}</td>
            <td style="white-space: nowrap; font-size: 0.8rem; font-weight: normal;">${lastModified}</td>
            <td style="font-weight: normal;">${modifiedBy}</td>
            <td style="width: 70px; min-width: 70px; max-width: 70px; text-align: center; font-weight: normal;">${activeDisplay}</td>
            <td class="version" style="width: 80px; min-width: 80px; max-width: 80px; font-weight: normal;">v${version}</td>
            <td class="actions" style="width: 70px; min-width: 70px; max-width: 70px; text-align: right; overflow: hidden; padding: 2px; box-sizing: border-box; display: flex; gap: 2px; justify-content: flex-end; align-items: center;">
                <button class="btn btn-blue btn-small" onclick="editForm('${form.id}')" style="flex: 0 0 24px; padding: 1px 2px; font-size: 0.7rem; height: 20px; display: flex; align-items: center; justify-content: center;" title="Edit">✎</button>
                <button class="btn btn-small" onclick="showFormMenu(event, '${form.id}').catch(e => console.error('Menu error:', e))" style="flex: 0 0 24px; padding: 1px 2px; font-size: 0.7rem; height: 20px; background: var(--secondary-slate); border: 1px solid var(--secondary-slate); cursor: pointer; display: flex; align-items: center; justify-content: center;" title="More">⋯</button>
            </td>
        </tr>
    `;
}

/**
 * Re-render whichever view is currently active (folder-filtered or full list)
 */
function rerenderCurrentView() {
    if (window.currentSelectedFolder) {
        const folder = window.currentSelectedFolder;
        const filtered = folder.id === 'all' ? forms :
                         folder.id === 'no_folder' ? forms.filter(f => !f.folder_id) :
                         forms.filter(f => f.folder_id === folder.id);
        renderFilteredForms(filtered);
    } else {
        renderFormsList();
    }
}
/**
 * Get form ID from URL query parameters
 */
function getFormIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const formId = params.get('form_id');
    return formId;
}

/**
 * Fetch form configuration from database by ID
 */
async function getFormConfigFromDatabase(formId) {
    try {
        if (!formId) {
            console.error('[FETCH CONFIG] No form ID provided');
            return null;
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/forms/${formId}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const definition = data.definition;

        if (!definition) {
            console.error('[FETCH CONFIG] No definition found in response');
            return null;
        }

        console.log('[FETCH CONFIG] Successfully retrieved form definition');
        return definition;
    } catch (error) {
        console.error('[FETCH CONFIG] Error fetching form:', error);
        return null;
    }
}

// ============================================================================
// FORM VIEWER - Render a single form to the page
// ============================================================================

/**
 * Calculate max-width for form container based on column count
 * @param {number} columnCount - Number of columns (1, 2, or 3)
 * @returns {string} CSS max-width value
 */
function getFormContainerWidth(columnCount) {
    const widthMap = {
        1: '600px',
        2: '900px',
        3: '1200px'
    };
    return widthMap[columnCount] || '600px';
}

/**
 * Build form HTML structure (column layout without field HTML)
 * @param {object} formConfig - Form definition from database
 * @returns {string} HTML string for form structure
 */
function buildFormHTML(formConfig) {
    const columnCount = formConfig.column_count || 1;
    const showName = formConfig.show_name !== false;
    // form-builder.js's saveFormToDatabase() now saves the display name
    // under "form_name" consistently (matching what "View JSON" shows).
    // Older forms saved before that fix may still have it under "name" -
    // check both for backward compatibility.
    const formName = formConfig.name || formConfig.form_name || '';
    
    let html = '';
    
    // Form name is the first thing in the container, unless the config
    // says not to show it (or there simply isn't one to show)
    if (showName && formName) {
        html += `<h2 style="margin-top: 0; margin-bottom: 20px; color: #ffffff;">${escapeHtml(formName)}</h2>`;
    }
    
    // Top spanning zone (column 0) - spans across all columns, above them.
    // Hidden by default; shown via JS only if a field actually lands here.
    html += '<div id="formTopSpanningZone" style="display: none; width: 100%;"></div>';
    
    // Column containers, with a vertical separator between each pair when
    // show_vert_sep is set (matches form-builder's columnDivider1/2 - no
    // divider needed with only 1 column, or after the last column)
    const showVertSep = formConfig.show_vert_sep === true;
    html += '<div id="formColumnsContainer" style="display: flex; gap: 25px; margin-bottom: 20px;">';
    
    for (let col = 1; col <= columnCount; col++) {
        html += `<div id="formColumn${col}" class="formColumn" style="flex: 1; min-width: 0;"></div>`;
        if (showVertSep && col < columnCount) {
            html += '<div class="formColumnDivider" style="width: 1px; background: #555;"></div>';
        }
    }
    
    html += '</div>';
    
    // Bottom spanning zone (column 99) - spans across all columns, below them.
    // Hidden by default; shown via JS only if a field actually lands here.
    html += '<div id="formBottomSpanningZone" style="display: none; width: 100%;"></div>';
    
    // Buttons container (for reset/submit)
    html += '<div id="formButtonsContainer" style="display: flex; gap: 10px; justify-content: center;"></div>';
    
    return html;
}

/**
 * Initialize and render the form viewer
 * Called from form-viewer.html on page load
 */
async function initializeFormViewer() {
    try {
        // Runs in parallel with the form-config fetch below - both are
        // network calls, no reason to wait on one before starting the other.
        const userInfoPromise = initializeUserInfo();

        const formId = getFormIdFromUrl();
        
        if (!formId) {
            showFormError('No form ID provided', 'Please specify a form_id in the URL (e.g., ?form_id=123)');
            return;
        }
        
        console.log('[FormViewer] Loading form:', formId);
        
        // Load form configuration from database
        const formConfig = await getFormConfigFromDatabase(formId);
        
        if (!formConfig) {
            showFormError('Form Not Found', `Form ID ${escapeHtml(formId)} could not be loaded.`);
            return;
        }
        
        console.log('[FormViewer] Form loaded successfully:', formConfig.form_name);

        // currentUserInfo must be fully resolved before formInfo is built -
        // usually already done by now, since it ran in parallel above.
        await userInfoPromise;
        formInfo = buildFormInfo(formConfig);
        
        // Set container width based on column count
        const container = document.getElementById('formContainer');
        if (container) {
            const width = getFormContainerWidth(formConfig.column_count || 1);
            container.style.maxWidth = width;
            container.style.marginLeft = 'auto';
            container.style.marginRight = 'auto';
            // panel-level-1's base padding is 10px on all sides - the form
            // wants 5px more from the sides specifically, top/bottom unchanged
            container.style.paddingLeft = '15px';
            container.style.paddingRight = '15px';
        }
        
        // Clear loading placeholder and render form structure
        container.innerHTML = buildFormHTML(formConfig);
        
        // Store form config globally for access by field rendering functions
        window.currentFormConfig = formConfig;
        
        // Render fields into their column containers
        populateFormFields(formConfig);
        
        // Render Reset/Submit buttons and set up required-field validation
        renderFormButtons();
        
        console.log('[FormViewer] Form structure rendered, ready for field population');
        
    } catch (error) {
        console.error('[FormViewer] Error initializing form:', error);
        showFormError('Error Loading Form', error.message);
    }
}

// ============================================================================
// FORM VIEWER - Field Rendering
// ============================================================================

// Raw HTML field content (h1, p, div, etc.) carries the browser's own
// default margins. Without this, an html-type field's first element (e.g.
// an <h1>) adds unwanted space above it inside the field/panel, and its
// last element does the same below. Inject once, mirroring wf-exec.js's
// spinner-CSS injection pattern. (Radio spacing is handled directly in
// base_css.js's .radio-group definition, not here.)
(function injectHtmlFieldCSS() {
    if (!document.getElementById('forms-html-field-css')) {
        const style = document.createElement('style');
        style.id = 'forms-html-field-css';
        style.textContent = `
            .html-field > *:first-child { margin-top: 0; }
            .html-field > *:last-child { margin-bottom: 0; }
        `;
        document.head.appendChild(style);
    }
})();

/**
 * Sort field configs into column/sequence order and inject their rendered
 * HTML into the matching formColumn<N> container.
 * @param {object} formConfig - Form definition from database
 */
function populateFormFields(formConfig) {
    const fieldConfigs = formConfig.field_configs || [];
    const columnCount = formConfig.column_count || 1;

    // Sort by column, then sequence (mirrors form-builder's load order)
    const sortedConfigs = [...fieldConfigs].sort((a, b) => {
        const colA = a.column !== undefined ? a.column : 1;
        const colB = b.column !== undefined ? b.column : 1;
        if (colA !== colB) return colA - colB;
        return (a.sequence || 0) - (b.sequence || 0);
    });

    sortedConfigs.forEach(fieldConfig => {
        const rawColumn = fieldConfig.column !== undefined ? fieldConfig.column : 1;
        let columnEl;

        if (rawColumn === 0) {
            // Spans across all columns, above them
            columnEl = document.getElementById('formTopSpanningZone');
        } else if (rawColumn === 99) {
            // Spans across all columns, below them
            columnEl = document.getElementById('formBottomSpanningZone');
        } else {
            let columnNum = rawColumn;
            // Clamp any other out-of-range column value to column 1
            if (columnNum < 1 || columnNum > columnCount) {
                columnNum = 1;
            }
            columnEl = document.getElementById(`formColumn${columnNum}`);
        }

        if (!columnEl) {
            console.warn('[FormViewer] No column container found for column', rawColumn);
            return;
        }

        const fieldHTML = renderFieldHTML(fieldConfig);
        columnEl.insertAdjacentHTML('beforeend', fieldHTML);
    });

    // Spanning zones start hidden (no reserved space) and are only shown
    // once we know they actually received a field. No margin needed on the
    // zone itself - the field(s) inside already carry their own
    // .form-group margin-bottom, same spacing as any field in column 1.
    ['formTopSpanningZone', 'formBottomSpanningZone'].forEach(zoneId => {
        const zone = document.getElementById(zoneId);
        if (!zone) return;
        zone.style.display = zone.children.length > 0 ? 'block' : 'none';
    });

    // base.js colors every <select>'s dropdown arrow to match the theme
    // once, at page-init time - it has no way to know about selects
    // created afterward, so newly-rendered dropdown fields need this
    // applied explicitly or they're stuck with the CSS's static black arrow.
    document.querySelectorAll('#formContainer select').forEach(el => applySelectArrowColor(el));

    // dropdown_static fields (multi-select or searchable single-select)
    // already have all their option data in fieldConfig.options - unlike
    // workflow/SQL/plugin sources, there's no fetch to wait for, so the
    // widget can be made interactive immediately rather than waiting on
    // applyDropdownResult.
    (formConfig.field_configs || []).forEach(fieldConfig => {
        if (fieldConfig.type !== 'dropdown' || fieldConfig.dropdown_type !== 'dropdown_static') return;
        if (!fieldConfig.multi_select && fieldConfig.searchable === false) return;

        const el = document.getElementById(`field_${fieldConfig.field_name}`);
        if (!el) return;

        const options = normalizeOptionsToArray(fieldConfig.options).map(({ label, value }) => ({ value, label }));
        // dropdown_static's default_value is a single value (the builder's
        // settings panel only offers one default).

        if (fieldConfig.multi_select) {
            const container = el.closest('.multi-select-container');
            if (!container) return;
            const selectedValues = fieldConfig.default_value ? [String(fieldConfig.default_value)] : [];
            initializeMultiSelect(container, options, selectedValues, { searchable: fieldConfig.searchable !== false });
        } else {
            const container = el.closest('.single-select-container');
            if (!container) return;
            initializeSearchableSelect(container, options, fieldConfig.default_value || '');
        }
    });
}

/**
 * Render a single field to an HTML string, wrapped in a standard container
 * (data-field-name, hidden state). Dispatches to type-specific body markup.
 * @param {object} fieldConfig - Single field definition
 * @returns {string} HTML string
 */
function renderFieldHTML(fieldConfig) {
    const type = fieldConfig.type;

    // Fields with no visible UI of their own (hidden data/config fields).
    // Real behavior (execution, waiting states) comes in a later chunk -
    // for now they render as an empty, non-participating placeholder.
    if (type === 'data_retrieval' || type === 'form_extend') {
        return `<div class="form-field-hidden" data-field-name="${fieldConfig.field_name}" style="display: none;"></div>`;
    }

    const isHidden = fieldConfig.hidden === true;
    const hiddenStyle = isHidden ? ' style="display: none;"' : '';

    let html = `<div class="form-group" data-field-name="${fieldConfig.field_name}" data-field-type="${type}"${hiddenStyle}>`;
    html += renderFieldBody(fieldConfig);
    html += '</div>';

    return html;
}

/**
 * Build the label markup shared by most field types. A description, if
 * set, shows as an info icon next to the label with the text in a tooltip
 * (via base.js's infoIcon()), rather than as its own text block.
 * HTML/horizontal-line fields skip this since they have no such chrome.
 * @param {object} fieldConfig - Field definition
 * @param {string} fieldId - The DOM id assigned to the field's input
 * @returns {string} HTML string
 */
function renderFieldLabel(fieldConfig, fieldId) {
    const requiredMarker = fieldConfig.required
        ? ' <span style="color: #999; font-size: 12px;">- Required</span>'
        : '';
    const descriptionIcon = fieldConfig.description ? infoIcon(fieldConfig.description) : '';
    return `<label for="${fieldId}">${escapeHtml(fieldConfig.field_displayname || fieldConfig.field_name)}${requiredMarker}${descriptionIcon}</label>`;
}

/**
 * Dispatch to the correct body renderer for a field's type.
 * @param {object} fieldConfig - Field definition
 * @returns {string} HTML string for the field's inner content
 */
function renderFieldBody(fieldConfig) {
    const fieldId = `field_${fieldConfig.field_name}`;

    switch (fieldConfig.type) {
        case 'text':
            return renderTextField(fieldConfig, fieldId);
        case 'textarea':
            return renderTextareaField(fieldConfig, fieldId);
        case 'checkbox':
            return renderCheckboxField(fieldConfig, fieldId);
        case 'radio':
            return renderRadioField(fieldConfig, fieldId);
        case 'date_time':
            return renderDateTimeField(fieldConfig, fieldId);
        case 'html':
            return renderHtmlField(fieldConfig, fieldId);
        case 'horizontal_line':
            return renderHorizontalLineField(fieldConfig);
        case 'dropdown':
            return renderDropdownField(fieldConfig, fieldId);
        case 'array':
            return renderArrayField(fieldConfig, fieldId);
        case 'datatable':
            return renderDatatableFieldPlaceholder(fieldConfig);
        default:
            console.warn('[FormViewer] Unsupported field type:', fieldConfig.type);
            return `<div style="color: #999; font-style: italic;">Unsupported field type: ${escapeHtml(fieldConfig.type)}</div>`;
    }
}

/**
 * Text field
 */
function renderTextField(fieldConfig, fieldId) {
    let html = renderFieldLabel(fieldConfig, fieldId);
    html += `<input type="text" id="${fieldId}" name="${fieldConfig.field_name}" value="${escapeHtml(fieldConfig.default_value || '')}">`;
    return html;
}

/**
 * Textarea field
 */
function renderTextareaField(fieldConfig, fieldId) {
    let html = renderFieldLabel(fieldConfig, fieldId);
    html += `<textarea id="${fieldId}" name="${fieldConfig.field_name}">${escapeHtml(fieldConfig.default_value || '')}</textarea>`;
    return html;
}

/**
 * Checkbox field - uses the form-group--inline convention (input before
 * label) so base_css.js's scoped .form-group--inline rules apply.
 */
function renderCheckboxField(fieldConfig, fieldId) {
    const requiredMarker = fieldConfig.required
        ? ' <span style="color: #999; font-size: 12px;">- Required</span>'
        : '';
    const descriptionIcon = fieldConfig.description ? infoIcon(fieldConfig.description) : '';
    let html = `<div class="form-group--inline">`;
    html += `<input type="checkbox" id="${fieldId}" name="${fieldConfig.field_name}" ${fieldConfig.default_checked ? 'checked' : ''}>`;
    html += `<label for="${fieldId}">${escapeHtml(fieldConfig.field_displayname || fieldConfig.field_name)}${requiredMarker}${descriptionIcon}</label>`;
    html += `</div>`;
    return html;
}

/**
 * Radio field - options is a dict of { label: value }. Uses base_css.js's
 * .radio-group (+ --horizontal modifier) and .form-group--inline classes
 * for layout/styling.
 */
/**
 * Normalize a radio/dropdown_static field's options into an array of
 * {label, value} pairs - options is now authored as an array directly,
 * but this also accepts the old {label: value} object shape for backward
 * compatibility with forms saved before this change. MySQL's JSON type
 * doesn't preserve object key order (only array order), which is why the
 * array shape is now the standard going forward - see
 * https://dev.mysql.com/doc/refman/8.0/en/json.html#json-normalization.
 * @param {object|Array} options
 * @returns {Array<{label: string, value: string}>}
 */
function normalizeOptionsToArray(options) {
    if (Array.isArray(options)) {
        return options.filter(o => o && typeof o === 'object');
    }
    if (options && typeof options === 'object') {
        return Object.entries(options).map(([label, value]) => ({ label, value }));
    }
    return [];
}

function renderRadioField(fieldConfig, fieldId) {
    let html = renderFieldLabel(fieldConfig, fieldId);
    const groupClass = fieldConfig.horiz ? 'radio-group radio-group--horizontal' : 'radio-group';
    html += `<div class="${groupClass}">`;

    const optionEntries = normalizeOptionsToArray(fieldConfig.options);

    if (optionEntries.length === 0) {
        html += `<div style="color: #999; font-style: italic; font-size: 12px;">No options configured for this field</div>`;
    } else {
        optionEntries.forEach(({ label, value }) => {
            const radioId = `${fieldId}_${value}`;
            const isChecked = fieldConfig.default_select === value ? 'checked' : '';
            html += `
                <div class="form-group--inline">
                    <input type="radio" id="${radioId}" name="${fieldConfig.field_name}" value="${escapeHtml(value)}" ${isChecked}>
                    <label for="${radioId}">${escapeHtml(label)}</label>
                </div>
            `;
        });
    }

    html += '</div>';
    return html;
}

/**
 * Date/Time field - a single type toggles between date-only and datetime-local
 * based on include_time
 */
function renderDateTimeField(fieldConfig, fieldId) {
    let html = renderFieldLabel(fieldConfig, fieldId);
    const inputType = fieldConfig.include_time ? 'datetime-local' : 'date';
    html += `<input type="${inputType}" id="${fieldId}" name="${fieldConfig.field_name}" value="${escapeHtml(fieldConfig.default_value || '')}">`;
    return html;
}

/**
 * HTML content field - renders raw content directly, no label/description chrome
 */
/**
 * HTML field. Static content (no {{ }} in it) renders directly and is
 * never touched again, same as before. Content containing real Jinja
 * syntax - e.g. showing a selected script's notes via
 * {{ script_data.notes }} - can't be resolved synchronously here (that
 * needs a network render call), so it gets an empty placeholder instead,
 * populated by processHtmlFields once the template actually resolves.
 */
function renderHtmlField(fieldConfig, fieldId) {
    if (fieldConfig.content && fieldConfig.content.includes('{{')) {
        return `<div id="${fieldId}" class="html-field" data-html-content></div>`;
    }
    return `<div class="html-field" data-html-content>${fieldConfig.content || ''}</div>`;
}

/**
 * Horizontal line field - simple divider
 */
function renderHorizontalLineField(fieldConfig) {
    return `<div class="horizontal-line-content">${fieldConfig.content || '<hr>'}</div>`;
}

/**
 * Dropdown field - all dropdown_type subtypes render the same <select> shell.
 * dropdown_static populates its options immediately from config.options.
 * Dynamic subtypes (dropdown_workflow/dropdown_sql/dropdown_plugin/dropdown_prefetch)
 * render a loading placeholder; actual data population is handled separately
 * once execution wiring (Persephone/Plugins) is added.
 */
function renderDropdownField(fieldConfig, fieldId) {
    let html = renderFieldLabel(fieldConfig, fieldId);

    const dropdownType = fieldConfig.dropdown_type;

    if (fieldConfig.multi_select) {
        // The interactive widget gets built after insertion: immediately
        // for dropdown_static (populateFormFields's static-multi-select
        // pass, since its options are already known), or once data
        // arrives for dynamic sources (applyDropdownResult).
        html += renderMultiSelectContainer(fieldId, fieldConfig.field_name);
        return html;
    }

    if (fieldConfig.searchable !== false) {
        // Same deal as multi_select above, just the single-select widget -
        // built immediately for dropdown_static, or once data arrives for
        // dynamic sources.
        html += renderSearchableSelectContainer(fieldId, fieldConfig.field_name);
        return html;
    }

    html += `<select id="${fieldId}" name="${fieldConfig.field_name}" data-dropdown-type="${escapeHtml(dropdownType || '')}">`;

    if (dropdownType === 'dropdown_static') {
        html += `<option value="">-- Select --</option>`;
        normalizeOptionsToArray(fieldConfig.options).forEach(({ label, value }) => {
            const isSelected = fieldConfig.default_value === value ? 'selected' : '';
            html += `<option value="${escapeHtml(value)}" ${isSelected}>${escapeHtml(label)}</option>`;
        });
    } else {
        // Dynamic dropdown types load their options at runtime
        html += `<option value="">Loading...</option>`;
    }

    html += '</select>';
    return html;
}

/**
 * Array field placeholder - full repeating-instance UI is built in a later chunk
 */
/**
 * Render an array field. In repeating_input_mode (the only mode
 * implemented so far - static "items" mode, with its richer per-item
 * type support, is a separate later chunk), this just lays down an empty
 * container - resolveArrayField (called from processDataFields, same as
 * any other data-driven field) populates it once fieldConfig.source
 * actually resolves to something.
 */
function renderArrayField(fieldConfig, fieldId) {
    let html = renderFieldLabel(fieldConfig, fieldId);

    if (fieldConfig.repeating_input_mode) {
        html += `<div id="${fieldId}" class="array-field-container panel-level-2" data-field-name="${escapeHtml(fieldConfig.field_name)}"></div>`;
    } else {
        html += `
            <div id="${fieldId}" class="array-field-container panel-level-2" data-field-name="${escapeHtml(fieldConfig.field_name)}">
                <button type="button" class="btn array-add-btn" data-size="sm" data-color="theme-brand" data-array-name="${escapeHtml(fieldConfig.field_name)}" style="margin-bottom: 8px;">+ Add</button>
                <div class="array-instances" data-array-name="${escapeHtml(fieldConfig.field_name)}" data-next-index="0"></div>
            </div>
        `;
    }

    return html;
}

/**
 * Render one array item's field for one instance (row) - id follows the
 * old system's own convention, `${arrayFieldName}_${item.name}_${instanceIndex}`.
 * dropdown_static/dropdown_workflow/dropdown_sql all render as our
 * searchable-select widget (empty/inert until initializeArrayInstanceWidgets
 * actually wires it up and applies options) - everything else falls back
 * to a plain text input.
 * @param {string} arrayFieldName
 * @param {object} item - one entry of fieldConfig.items
 * @param {number} instanceIndex
 * @returns {string}
 */
function renderArrayItemFieldHTML(arrayFieldName, item, instanceIndex) {
    const fieldId = `${arrayFieldName}_${item.name}_${instanceIndex}`;

    if (item.type === 'dropdown_static' || item.type === 'dropdown_workflow' || item.type === 'dropdown_sql') {
        return renderSearchableSelectContainer(fieldId, fieldId);
    }

    if (item.type === 'date') {
        return `<input type="date" id="${fieldId}" value="${escapeHtml(item.value || '')}">`;
    }

    if (item.type === 'datetime') {
        return `<input type="datetime-local" id="${fieldId}" value="${escapeHtml(item.value || '')}">`;
    }

    return `<input type="text" id="${fieldId}" value="${escapeHtml(item.value || '')}">`;
}

/**
 * Render one instance (row) of a static-items array field, in a grid
 * layout sized by item count - same row/column split the old system used
 * (1 row up to 3 items, 2 rows up to 6, 3 rows beyond that).
 * @param {object} fieldConfig
 * @param {number} instanceIndex
 * @returns {string}
 */
function renderArrayInstanceHTML(fieldConfig, instanceIndex) {
    const items = Array.isArray(fieldConfig.items) ? fieldConfig.items : [];
    const itemCount = items.length;
    const numRows = itemCount > 6 ? 3 : itemCount > 3 ? 2 : 1;
    const numCols = Math.ceil(itemCount / numRows) || 1;

    const itemsHtml = items.map(item => `
        <div class="array-instance-field">
            <label>${escapeHtml(item.display_name || item.name)}</label>
            ${renderArrayItemFieldHTML(fieldConfig.field_name, item, instanceIndex)}
        </div>
    `).join('');

    return `
        <div class="array-instance" data-instance-index="${instanceIndex}" style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <div class="array-instance-fields panel-level-3" style="flex: 1; display: grid; grid-template-columns: repeat(${numCols}, 1fr); gap: 8px;">${itemsHtml}</div>
            <button type="button" class="btn array-instance-delete" data-size="sm" data-color="red" title="Delete this row">×</button>
        </div>
    `;
}

/**
 * Wire up interactivity for one array instance's dropdown-type items
 * (dropdown_static/dropdown_workflow/dropdown_sql) - called right after
 * that instance's HTML is actually in the DOM, both for the initial
 * default instance and for each newly-added one via "+ Add".
 *
 * dropdown_static applies its options immediately (static, from
 * item.options, never fetched). dropdown_workflow/dropdown_sql apply
 * whatever's currently cached in arrayItemOptionsCache (possibly empty,
 * if that item's shared fetch hasn't resolved yet) -
 * resolveArrayItemsOptions re-applies fresh options to every rendered
 * instance once that fetch actually completes.
 * @param {object} fieldConfig
 * @param {number} instanceIndex
 */
function initializeArrayInstanceWidgets(fieldConfig, instanceIndex) {
    const items = Array.isArray(fieldConfig.items) ? fieldConfig.items : [];
    items.forEach(item => {
        if (item.type !== 'dropdown_static' && item.type !== 'dropdown_workflow' && item.type !== 'dropdown_sql') return;

        const fieldId = `${fieldConfig.field_name}_${item.name}_${instanceIndex}`;
        const el = document.getElementById(fieldId);
        const container = el ? el.closest('.single-select-container') : null;
        if (!container) return;

        if (item.type === 'dropdown_static') {
            const options = item.options && typeof item.options === 'object'
                ? Object.entries(item.options).map(([label, value]) => ({ value, label }))
                : [];
            initializeSearchableSelect(container, options, '');
        } else {
            const cacheKey = `${fieldConfig.field_name}:${item.name}`;
            initializeSearchableSelect(container, arrayItemOptionsCache[cacheKey] || [], '');
        }
    });
}

/**
 * Apply freshly-fetched options to every currently-rendered instance of
 * one array item - matched by exact id pattern
 * (`${arrayFieldName}_${item.name}_<number>`), not a plain prefix match,
 * since a prefix could false-positive against another item whose name
 * happens to start the same way (e.g. "client" vs "client_notes").
 * Preserves each instance's current selection if it's still among the
 * new options.
 * @param {object} fieldConfig
 * @param {object} item
 * @param {Array<{value: *, label: string}>} options
 */
function applyArrayItemOptionsToAllInstances(fieldConfig, item, options) {
    const container = document.getElementById(`field_${fieldConfig.field_name}`);
    if (!container) return;

    const escapedPrefix = `${fieldConfig.field_name}_${item.name}_`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const idPattern = new RegExp(`^${escapedPrefix}\\d+$`);

    container.querySelectorAll('select.single-select-hidden-select').forEach(el => {
        if (!idPattern.test(el.id)) return;
        const widgetContainer = el.closest('.single-select-container');
        if (!widgetContainer) return;
        const currentValue = el.value;
        const stillValid = currentValue && options.some(o => String(o.value) === currentValue);
        initializeSearchableSelect(widgetContainer, options, stillValid ? currentValue : '');
    });
}

/**
 * For a static-items array field, fetch options once per
 * dropdown_workflow/dropdown_sql item (de-duped via dataFieldState, same
 * pattern as any other data-driven field - keyed by
 * "arrayFieldName:itemName" since each item needs its own tracking, not
 * just the field as a whole), then apply the result to every currently-
 * rendered instance of that item. Reuses fetchFieldData directly - each
 * item's own shape (workflow_id/workflow_output/database/query) matches
 * what fetchFieldData already expects from a regular fieldConfig.
 * dropdown_static items need no fetching at all and are skipped here.
 *
 * Runs (and caches results) regardless of whether any row currently
 * exists - arrays default to zero rows, so this pre-fetches while the
 * field is still empty, meaning options are already cached and apply
 * immediately (via initializeArrayInstanceWidgets) the moment the user
 * clicks "+ Add" for the first time, rather than showing an empty
 * dropdown that has to wait on a fresh fetch.
 * @param {object} fieldConfig
 */
async function resolveArrayItemsOptions(fieldConfig) {
    const items = Array.isArray(fieldConfig.items) ? fieldConfig.items : [];

    for (const item of items) {
        if (item.type !== 'dropdown_workflow' && item.type !== 'dropdown_sql') continue;

        const sourceKind = item.type === 'dropdown_workflow' ? 'workflow' : 'sql';
        const stateKey = `${fieldConfig.field_name}:${item.name}`;
        const state = dataFieldState[stateKey] || (dataFieldState[stateKey] = {});

        let resolvedInput;
        if (sourceKind === 'workflow') {
            resolvedInput = await resolveFieldInputMap(item.workflow_input);
            resolvedInput.form_info = formInfo;
        } else {
            resolvedInput = await resolveSqlQueryTemplate(item.query || '');
        }
        const paramsKey = sourceKind === 'sql' ? resolvedInput : JSON.stringify(resolvedInput);

        if (state.status === 'loaded' && state.lastParamsKey === paramsKey) continue;

        const result = await fetchFieldData(item, sourceKind, resolvedInput);
        if (!result.success) {
            state.status = 'error';
            console.error(`[FormViewer] Error fetching options for array item "${item.name}" in "${fieldConfig.field_name}":`, result.error);
            continue;
        }

        const labelField = item.label_field || 'label';
        const valueField = item.value_field || 'value';
        const validItems = sortDataRows(
            (Array.isArray(result.output) ? result.output : []).filter(row => row && typeof row === 'object'),
            item.order_by_field,
            item.order_by_direction
        );
        const options = validItems.map(row => ({
            value: row[valueField] !== undefined ? row[valueField] : '',
            label: formatItemLabel(labelField, row, valueField)
        }));

        arrayItemOptionsCache[stateKey] = options;
        state.status = 'loaded';
        state.lastParamsKey = paramsKey;

        applyArrayItemOptionsToAllInstances(fieldConfig, item, options);
    }
}

/**
 * Handle a click on a static-items array field's "+ Add" or "×" delete
 * button. Event delegation on #formContainer (see initializeFormViewer),
 * since add/delete buttons come and go dynamically as instances are
 * added/removed - individual listeners would need constant re-wiring.
 * @param {Event} e
 */
function handleArrayFieldClick(e) {
    const addBtn = e.target.closest('.array-add-btn');
    if (addBtn) {
        const fieldName = addBtn.dataset.arrayName;
        const formConfig = window.currentFormConfig;
        const fieldConfig = formConfig && (formConfig.field_configs || []).find(f => f.field_name === fieldName);
        if (!fieldConfig) return;

        const instancesContainer = document.querySelector(`.array-instances[data-array-name="${fieldName}"]`);
        if (!instancesContainer) return;

        const nextIndex = parseInt(instancesContainer.dataset.nextIndex || '1', 10);
        instancesContainer.insertAdjacentHTML('beforeend', renderArrayInstanceHTML(fieldConfig, nextIndex));
        instancesContainer.dataset.nextIndex = String(nextIndex + 1);

        initializeArrayInstanceWidgets(fieldConfig, nextIndex);
        return;
    }

    const deleteBtn = e.target.closest('.array-instance-delete');
    if (deleteBtn) {
        const instance = deleteBtn.closest('.array-instance');
        if (instance) instance.remove();
    }
}

/**
 * Datatable field placeholder - full table/list rendering is built in a later chunk
 */
function renderDatatableFieldPlaceholder(fieldConfig) {
    let html = renderFieldLabel(fieldConfig, `field_${fieldConfig.field_name}`);
    html += `<div class="datatable-field-placeholder" style="color: #999; font-style: italic; padding: 8px; border: 1px dashed #555; border-radius: 4px;">Datatable field rendering not yet implemented</div>`;
    return html;
}

// ============================================================================
// FORM VIEWER - Conditional Visibility
// ============================================================================
//
// Field `conditions` arrays hold Jinja-style boolean expressions authored
// through the builder's condition editor (see openConditionsModal in
// form-builder.js). In practice these use real Jinja/Nunjucks features
// well beyond simple equality - filters (| d, | default), list literals
// (['', none]), `not in`, etc. - so this evaluates them via Persephone's
// actual render engine (POST /engine/render-template, through
// jinja-json.js's renderTemplateWithPersephone) rather than a hand-rolled
// parser. An earlier client-side mini-parser (tokenizer + recursive-
// descent evaluator covering comparisons/and/or/not/in) kept running into
// real conditions that exceeded that grammar.
//
// To keep this fast enough for live, per-change re-evaluation, every
// condition across the whole form is batched into a single render call
// (see buildBatchedConditionTemplate), and the call itself is debounced
// rather than fired on every keystroke (see handleFormFieldChange).

/**
 * Strip a condition string's {{ ... }} wrapper, if present.
 * @param {string} conditionStr
 * @returns {string} The inner expression
 */
function stripJinjaBraces(conditionStr) {
    const trimmed = (conditionStr || '').trim();
    const match = trimmed.match(/^\{\{-?\s*([\s\S]*?)\s*-?\}\}$/);
    return match ? match[1] : trimmed;
}

/**
 * Last-computed logical visibility per field name (true/false), from the
 * most recent batched condition render. Used both to toggle each field's
 * DOM wrapper and - since data_retrieval fields have no real wrapper to
 * toggle at all - to gate whether a field's data source should even
 * execute (see processDataFields). Defaults to "visible/allowed" (fail
 * open) for any field not yet seen, e.g. before the very first condition
 * render has resolved.
 */
let fieldVisibilityState = {};

/**
 * Raw (untransformed) items last fetched for each data-driven dropdown
 * field, keyed by field_name - kept alongside the {value, label} pairs
 * applyDropdownResult actually renders, so a field's data_variable (see
 * updateDataVariables) can expose the FULL data of whatever's currently
 * selected, not just its scalar value.
 */
let rawDropdownItems = {};

/**
 * Fetched options for static-items array fields' dropdown_workflow/
 * dropdown_sql items, keyed by "arrayFieldName:itemName" - fetched ONCE
 * per item (see resolveArrayItemsOptions) and shared across every
 * instance/row of that item, existing and newly-added, rather than
 * re-fetched per row the way the old system did.
 */
let arrayItemOptionsCache = {};

/**
 * Build one combined Jinja template evaluating every condition across
 * every field that has any, in a single pass - each condition becomes one
 * key in a JSON object the template renders, so a single
 * renderTemplateWithPersephone call (one network round trip) resolves
 * visibility for the whole form at once, however many conditional fields
 * it has or however they cascade off each other. Re-running this on every
 * change (see handleFormFieldChange) is what makes cascades converge -
 * the same idea the previous client-side evaluator relied on, just now
 * backed by a real render instead of a hand-rolled one.
 * @param {object} formConfig
 * @returns {{template: string, keyMap: Array<{fieldName: string, conditionIndex: number, key: string}>}}
 */
function buildBatchedConditionTemplate(formConfig) {
    const keyMap = [];
    const lines = [];

    (formConfig.field_configs || []).forEach(fieldConfig => {
        if (!Array.isArray(fieldConfig.conditions)) return;
        fieldConfig.conditions.forEach((cond, idx) => {
            if (!cond || !cond.condition) return;
            const expr = stripJinjaBraces(cond.condition);
            if (!expr) return;
            const key = `f${keyMap.length}`;
            keyMap.push({ fieldName: fieldConfig.field_name, conditionIndex: idx, key });
            // Plain if/else rather than a filter like |tojson, since we
            // can't assume this Persephone instance has that registered -
            // this only relies on standard Jinja/Nunjucks syntax.
            lines.push(`  "${key}": "{{ 'true' if (${expr}) else 'false' }}"`);
        });
    });

    return { template: '{\n' + lines.join(',\n') + '\n}', keyMap };
}

/**
 * Build the context object for condition/input-value rendering: every
 * field's current value, keyed by field_name directly (matching how
 * conditions and workflow_input/inputs_map values are authored -
 * {{ field_name == 'x' }}, not {{ CTX.field_name == 'x' }} - this system
 * doesn't use a CTX namespace). Also includes any data_variable-sourced
 * values (see updateDataVariables) - those aren't tied to any field_name,
 * so the field-name loop alone wouldn't pick them up. Also includes
 * form_info itself (see buildFormInfo), so e.g.
 * {{ form_info.form_user_email }} is available the same way it's already
 * sent alongside every workflow execution this form triggers.
 * @param {object} formConfig
 * @returns {object}
 */
function buildConditionContext(formConfig) {
    const context = { form_info: formInfo };
    (formConfig.field_configs || []).forEach(fieldConfig => {
        context[fieldConfig.field_name] = getFieldCurrentValue(fieldConfig.field_name);
        if (fieldConfig.data_variable) {
            context[fieldConfig.data_variable] = formPageVariables[fieldConfig.data_variable];
        }
    });
    return context;
}

/**
 * Re-evaluate every field's conditional visibility against the form's
 * current values (one batched render call - see
 * buildBatchedConditionTemplate) and toggle each wrapper's display
 * accordingly. data_retrieval/form_extend fields have no real wrapper to
 * toggle (see renderFieldHTML), but their logical visibility is still
 * computed and stored in fieldVisibilityState, since it gates whether
 * their data source should execute at all (see processDataFields).
 *
 * Fails open on any error (network, template syntax) - a broken
 * condition should leave fields visible/executable rather than silently
 * hide or block something the user needs.
 */
async function applyConditionalVisibility() {
    const formConfig = window.currentFormConfig;
    if (!formConfig) return;

    const fieldConfigs = formConfig.field_configs || [];
    const { template, keyMap } = buildBatchedConditionTemplate(formConfig);

    // conditionResults[fieldName] = array of booleans, one per condition, in order.
    const conditionResults = {};

    if (keyMap.length > 0) {
        try {
            const context = buildConditionContext(formConfig);
            const renderResult = await window.renderTemplateWithPersephone(template, context);

            if (renderResult.success && renderResult.result && typeof renderResult.result === 'object') {
                keyMap.forEach(({ fieldName, conditionIndex, key }) => {
                    if (!conditionResults[fieldName]) conditionResults[fieldName] = [];
                    conditionResults[fieldName][conditionIndex] = renderResult.result[key] === 'true';
                });
            } else {
                console.error('[FormViewer] Condition batch render failed:', renderResult.error);
            }
        } catch (err) {
            console.error('[FormViewer] Error evaluating conditions:', err);
        }
    }

    fieldConfigs.forEach(fieldConfig => {
        let visible = fieldConfig.hidden !== true;

        if (Array.isArray(fieldConfig.conditions)) {
            const results = conditionResults[fieldConfig.field_name];
            fieldConfig.conditions.forEach((cond, idx) => {
                if (!cond || !cond.condition) return;
                // Fail open per-condition too: if we don't have a result
                // (render failed, or this one was skipped), treat as true
                // rather than silently hiding/blocking.
                const conditionMet = results && results[idx] !== undefined ? results[idx] : true;
                visible = cond.action === 'hide' ? !conditionMet : conditionMet;
            });
        }

        fieldVisibilityState[fieldConfig.field_name] = visible;

        // data_retrieval/form_extend render as invisible stubs with no
        // real wrapper to toggle - visibility above still matters for
        // gating execution, just not for a DOM display style.
        if (fieldConfig.type === 'data_retrieval' || fieldConfig.type === 'form_extend') return;

        const wrapper = document.querySelector(`[data-field-name="${fieldConfig.field_name}"]`);
        if (!wrapper) return;
        // Clear the inline style to fall back to .form-group's own display
        // when visible, rather than hardcoding a value that could drift
        // out of sync with that class.
        wrapper.style.display = visible ? '' : 'none';
    });
}

// Debounce window for condition re-evaluation - now a real network render
// rather than a synchronous local computation, so this avoids firing one
// on every keystroke while still converging quickly after the user pauses.
let conditionDebounceTimer = null;
const CONDITION_DEBOUNCE_MS = 300;

// Bumped on every form change, and stamped onto fieldVisibilityState once
// a condition check completes for that generation. Lets processDataFields
// tell "visibility is confirmed current" apart from "visibility is stale
// relative to a more recent change" - see processDataFields for why that
// distinction matters (a field with conditions shouldn't fetch using
// possibly-incomplete intermediate values from a cascade still settling).
let formChangeGeneration = 0;
let lastEvaluatedGeneration = -1;

/**
 * Combined handler for any field change. Submit-button state and data-
 * field processing run immediately, using whatever visibility is
 * currently known (settles within one debounce cycle below if a field's
 * own condition just changed) - fields with no conditions at all are
 * unaffected by any of this, since their visibility never depends on
 * anything to resolve. Condition re-evaluation means a real network
 * render, so rather than firing on every keystroke it's debounced - once
 * it resolves, everything re-runs once more against the freshly-updated
 * visibility.
 */
/**
 * Update formPageVariables for every field with a data_variable set -
 * stores the FULL raw data of whatever's currently selected (not just its
 * scalar value), keyed by that field's data_variable name, so other
 * fields' Jinja templates (conditions, workflow_input, inputs_map) can
 * pull additional properties out of it - e.g. a selected org's full
 * stack/integration data, not just its org_id, referenced flatly as
 * {{ client_data.stack... }} (not {{ CTX.client_data... }} - this system
 * doesn't use a CTX namespace).
 *
 * Single-select stores the one matching raw item (or null if nothing's
 * selected/matched); multi-select stores an array of matching raw items.
 * Not tied to any particular dropdown_type - works for any dropdown field
 * that has data_variable set, since the mechanism itself doesn't care
 * where the options came from.
 * @param {object} formConfig
 */
function updateDataVariables(formConfig) {
    if (!formConfig) return;
    (formConfig.field_configs || []).forEach(fieldConfig => {
        if (!fieldConfig.data_variable) return;

        const rawItems = rawDropdownItems[fieldConfig.field_name] || [];
        const valueField = fieldConfig.value_field || 'value';
        const currentValue = getFieldCurrentValue(fieldConfig.field_name);

        if (fieldConfig.multi_select) {
            const currentValues = Array.isArray(currentValue) ? currentValue.map(String) : [];
            formPageVariables[fieldConfig.data_variable] = rawItems.filter(item => currentValues.includes(String(item[valueField])));
        } else {
            const match = rawItems.find(item => String(item[valueField]) === String(currentValue));
            formPageVariables[fieldConfig.data_variable] = match || null;
        }
    });
}

function handleFormFieldChange() {
    formChangeGeneration++;
    updateDataVariables(window.currentFormConfig);
    processDataFields();
    updateSubmitButtonState();

    if (conditionDebounceTimer) clearTimeout(conditionDebounceTimer);
    conditionDebounceTimer = setTimeout(async () => {
        const generationAtStart = formChangeGeneration;
        await applyConditionalVisibility();
        // Math.max guards against an older, overlapping check completing
        // after a newer one already ran (rare, but possible - clearTimeout
        // only cancels a still-pending timer, not one whose callback has
        // already started).
        lastEvaluatedGeneration = Math.max(lastEvaluatedGeneration, generationAtStart);
        updateDataVariables(window.currentFormConfig);
        processDataFields();
        processHtmlFields();
        updateSubmitButtonState();
    }, CONDITION_DEBOUNCE_MS);
}

// ============================================================================
// FORM VIEWER - Data-Driven Fields (Workflow & SQL-based)
// ============================================================================
//
// Covers `data_retrieval` fields (hidden - store a workflow/SQL query's
// output in a page variable other fields/conditions can reference) and
// dropdown_workflow/dropdown_sql fields (populate <option>s from the
// result). All four share the same dependency-checking, state-tracking,
// and result-application mechanics; only how the raw data gets fetched
// differs by source. Plugin-backed data sources are a separate future chunk.

// Values produced by data_retrieval fields, keyed by field_name. These
// aren't real DOM inputs, so they live here rather than in the DOM -
// getFieldCurrentValue() checks this store for that field type.
let formPageVariables = {};

// Current user's info, resolved from the session via /auth/me during form
// init (see initializeUserInfo). Feeds buildFormInfo() below, which is what
// actually reaches templates/workflows - not exposed as standalone flat
// context values.
let currentUserInfo = { user_id: null, email: null, full_name: null };

/**
 * Populate currentUserInfo from the authenticated session. Awaited by
 * initializeFormViewer before buildFormInfo() runs, so form_info is always
 * fully populated by the time anything (Submit, or any dropdown_workflow/
 * data_retrieval workflow execution) could actually use it.
 *
 * PHASE 2: there was previously a synchronous `getUser()` pre-fill of user_id
 * here, from localStorage, immediately before the same field was overwritten
 * by the lookup below. It only mattered if the lookup failed - in which case
 * it supplied an identity the server had not vouched for, which is worse than
 * supplying none.
 */
async function initializeUserInfo() {
    try {
        const data = await getCurrentUserData('cookie');
        if (data) {
            currentUserInfo.user_id = data.user_id || null;
            currentUserInfo.email = data.email || null;
            currentUserInfo.full_name = data.full_name || null;
        }
    } catch (err) {
        console.error('[FormViewer] Error fetching current user info:', err);
    }
}

// Built once at form init (see buildFormInfo/initializeFormViewer) and
// sent as a form_info parameter both on Submit and on any
// dropdown_workflow/data_retrieval workflow execution - not part of the
// condition/input-value template context (buildConditionContext).
let formInfo = null;

/**
 * Build the form_info object sent alongside every workflow execution this
 * form triggers (Submit, and any dropdown_workflow/data_retrieval field
 * backed by a workflow) - identifies which form, which version, and which
 * user is running it. Built once at form init (currentUserInfo must
 * already be resolved by then) rather than freshly per execution, since
 * none of these values change during the form's lifetime.
 * @param {object} formConfig
 * @returns {object}
 */
function buildFormInfo(formConfig) {
    return {
        form_id: getFormIdFromUrl(),
        // Same dual-key handling as buildFormHTML - saveFormToDatabase()
        // saves the name under "form_name" now, but older forms may still
        // have it under "name".
        form_name: formConfig.name || formConfig.form_name || '',
        form_version: formConfig.version || '',
        form_user: currentUserInfo.user_id,
        form_user_email: currentUserInfo.email
    };
}

// Per-field execution bookkeeping, keyed by field_name:
//   status: 'waiting' | 'loading' | 'loaded' | 'error'
//   lastParamsKey: JSON string of the params used for the last successful
//     run, so a field only re-executes when its actual resolved inputs
//     have changed - not on every unrelated keystroke elsewhere on the form.
let dataFieldState = {};

/**
 * Substitute [[ field_name ]] references in a string with that field's
 * current value (regular DOM fields or data_retrieval page variables,
 * both via getFieldCurrentValue). If the ENTIRE string is a single
 * [[ ]] reference, the raw value is returned as-is (preserving arrays/
 * booleans/etc. rather than stringifying them); otherwise each [[ ]]
 * reference found is stringified in place within the surrounding text.
 *
 * A string containing real Jinja syntax ({{ ... }}) is rendered through
 * Persephone's actual engine instead - same reasoning as condition
 * evaluation: filters, ternaries (x if y else z), etc. that [[ ]]
 * substitution alone can't express. Field values are available directly
 * by name in that render's context (client_id, not [[client_id]]) - no
 * need to combine both syntaxes in one value.
 * @param {string} str
 * @returns {Promise<*>}
 */
async function replaceFieldReferences(str) {
    if (typeof str !== 'string') return str;

    if (str.includes('{{')) {
        try {
            const context = buildConditionContext(window.currentFormConfig);
            const result = await window.renderTemplateWithPersephone(str, context);
            if (result.success) {
                // renderTemplateWithPersephone's server side auto-JSON-parses
                // its rendered output when possible - a numeric-looking
                // result (e.g. client_id's "133") silently becomes an
                // actual number rather than staying a string. Always
                // coerce back to a string here, matching what [[ ]]
                // substitution already reliably produces, so a value like
                // "133" doesn't turn into 133 and mismatch whatever type
                // the plugin/API on the other end expects.
                return String(result.result);
            }
            console.error('[FormViewer] Error rendering input template:', str, result.error);
            return '';
        } catch (err) {
            console.error('[FormViewer] Error rendering input template:', str, err);
            return '';
        }
    }

    const soleMatch = str.trim().match(/^\[\[\s*([\w.]+)\s*\]\]$/);
    if (soleMatch) {
        return getFieldCurrentValue(soleMatch[1]);
    }

    return str.replace(/\[\[\s*([\w.]+)\s*\]\]/g, (full, name) => {
        const value = getFieldCurrentValue(name);
        return value === undefined || value === null ? '' : String(value);
    });
}

/**
 * Resolve a {name: template} input map (a field's workflow_input, or a
 * plugin field's inputs_map - same shape, same [[ field_name ]] / real
 * Jinja {{ }} support per replaceFieldReferences) against current
 * field/page-variable values.
 * @param {object} inputMapConfig
 * @returns {Promise<object>} Plain object ready to send as execution parameters
 */
async function resolveFieldInputMap(inputMapConfig) {
    const params = {};
    if (!inputMapConfig || typeof inputMapConfig !== 'object') return params;
    for (const [key, template] of Object.entries(inputMapConfig)) {
        params[key] = await replaceFieldReferences(template);
    }
    return params;
}

/**
 * Check a field's `dependant_fields` (set via the builder's dependent-
 * fields modal) against the form's current state.
 * @param {object} fieldConfig
 * @returns {{blocked: boolean, waitingOn: string[]}}
 */
function getFieldDependencyStatus(fieldConfig) {
    const dependants = fieldConfig.dependant_fields;
    if (!dependants || typeof dependants !== 'object') {
        return { blocked: false, waitingOn: [] };
    }

    const formConfig = window.currentFormConfig;
    const waitingOn = [];

    Object.entries(dependants).forEach(([depFieldName, opts]) => {
        const blocking = !opts || opts.blocking !== false;
        if (!blocking) return;

        const depFieldConfig = (formConfig?.field_configs || []).find(f => f.field_name === depFieldName);
        if (!depFieldConfig) return;

        const blockHidden = !opts || opts.block_hidden !== false;
        const isHidden = !isFieldWrapperVisible(depFieldConfig);
        if (isHidden && !blockHidden) return; // exempted from gating while hidden

        if (!isRequiredFieldSatisfied(depFieldConfig)) {
            waitingOn.push(depFieldConfig.field_displayname || depFieldName);
        }
    });

    return { blocked: waitingOn.length > 0, waitingOn };
}

/**
 * Execute a workflow via Persephone and poll until it reaches a terminal
 * state. On success, returns the workflow's final CTX (the plain output
 * variables) - matching how Persephone itself extracts sub-workflow
 * outputs (finalCTX[name], not the raw per-step results/STEPS).
 * @param {string} workflowId
 * @param {object} parameters
 * @param {string|null} [triggerId] - Optional; only the submit workflow
 *   has a trigger concept (formConfig.submit_trigger_id) - dropdown_workflow/
 *   data_retrieval fields just omit this, same as leaving it unset.
 * @param {function(string): void} [onStarted] - Optional callback fired as
 *   soon as the executionId is known, before polling begins - lets a
 *   caller hook in a live detail view (e.g. wf-exec.js's
 *   generateExecDetailHTML) while this function's own poll loop
 *   continues independently toward a final success/fail result.
 * @returns {Promise<{success: boolean, output: object|null, error: string|null, executionId: string|null}>}
 */
async function executeWorkflowForField(workflowId, parameters, triggerId = null, onStarted = null) {
    try {
        const startResponse = await fetch('https://app.equinoxits.com:1139/engine/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ workflowId, parameters, triggerId })
        });
        if (!startResponse.ok) {
            const errData = await startResponse.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${startResponse.status}`);
        }
        const { executionId } = await startResponse.json();
        if (!executionId) throw new Error('No executionId returned from workflow execution');
        if (typeof onStarted === 'function') {
            onStarted(executionId);
        }
        const pollIntervalMs = 1500;
        const maxAttempts = 120; // ~3 minutes
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            const statusResponse = await fetch(`https://app.equinoxits.com:1139/engine/executions/${executionId}`, {
                credentials: 'include'
            });
            if (!statusResponse.ok) {
                throw new Error(`HTTP ${statusResponse.status} polling execution status`);
            }
            const execution = await statusResponse.json();
            if (execution.status === 'running') continue;
            if (execution.status === 'failure' || execution.status === 'cancelled') {
                const errMsg = Array.isArray(execution.errors) && execution.errors.length > 0
                    ? execution.errors.map(e => e.error || e.message || JSON.stringify(e)).join('; ')
                    : `Workflow ${execution.status}`;
                // Output Variables are still worth returning on failure - many workflows
                // define e.g. success/error_message with `| d(...)` defaults specifically
                // so they resolve usefully even when the workflow errored.
                return { success: false, output: execution.context?.OUTPUT || null, error: errMsg, executionId };
            }
            // 'success' or 'warning' both carry usable output.
            // OUTPUT is the workflow's own rendered Output Variables (clean,
            // defined contract) - CTX is the full internal variable soup
            // (trigger vars, intermediate step-set variables, etc.) and was
            // never meant to be handed to a caller wholesale.
            return { success: true, output: execution.context?.OUTPUT || {}, error: null, executionId };
        }
        return { success: false, output: null, error: 'Workflow execution timed out', executionId };
    } catch (err) {
        return { success: false, output: null, error: err.message, executionId: null };
    }
}

/**
 * Show a waiting/loading/error message in place of a data-driven field's
 * normal input. Passing null clears it, restoring the field's normal UI.
 * data_retrieval fields have no visible wrapper to begin with, so this is
 * a no-op for them - only dropdown fields need visual feedback.
 * @param {object} fieldConfig
 * @param {string|null} message
 */
function setFieldStatusMessage(fieldConfig, message) {
    if (fieldConfig.type === 'data_retrieval') return;

    const wrapper = document.querySelector(`[data-field-name="${fieldConfig.field_name}"]`);
    if (!wrapper) return;

    const input = wrapper.querySelector('select, input, textarea');
    let statusEl = wrapper.querySelector('.field-status-message');

    if (!message) {
        if (statusEl) statusEl.remove();
        if (input) input.style.display = '';
        return;
    }

    if (input) input.style.display = 'none';
    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.className = 'field-status-message';
        statusEl.style.cssText = 'color: #999; font-style: italic; font-size: 12px; padding: 6px 0;';
        wrapper.appendChild(statusEl);
    }
    statusEl.textContent = message;
}

/**
 * Populate a data-driven dropdown's <select> from its query/workflow
 * output - source-agnostic, since a workflow's output array and a SQL
 * result set are both just "an array of row/item objects" by the time
 * they get here. Uses label_field/value_field per item and
 * default_selector to pre-select. Preserves the user's existing selection
 * across a re-fetch when it's still a valid option; otherwise falls back
 * to the declared default.
 * @param {object} fieldConfig
 * @param {Array<object>} items
 */
/**
 * Sort an array of data rows by a named property, before they're turned
 * into dropdown options. Shared across all data-driven dropdown types
 * (workflow/SQL/plugin/prefetch all funnel through applyDropdownResult) -
 * dropdown_static doesn't apply here, since its options are flat
 * label/value pairs with no "column" to sort by.
 *
 * Values that both parse as numbers sort numerically; everything else
 * sorts as case-insensitive strings. Null/undefined values sort last
 * regardless of direction.
 * @param {Array<object>} items
 * @param {string} orderByField - Property name to sort by; no-op if empty
 * @param {string} direction - 'desc' for descending, anything else (incl.
 *   unset) is ascending
 * @returns {Array<object>} A new, sorted array (items itself is untouched)
 */
function sortDataRows(items, orderByField, direction) {
    if (!orderByField) return items;
    const dir = direction === 'desc' ? -1 : 1;

    return [...items].sort((a, b) => {
        const av = a ? a[orderByField] : undefined;
        const bv = b ? b[orderByField] : undefined;

        const aEmpty = av === undefined || av === null;
        const bEmpty = bv === undefined || bv === null;
        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return 1;
        if (bEmpty) return -1;

        const an = Number(av), bn = Number(bv);
        if (av !== '' && bv !== '' && !isNaN(an) && !isNaN(bn)) {
            return (an - bn) * dir;
        }
        return String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' }) * dir;
    });
}

/**
 * Compute a dropdown option's displayed label from label_field, which can
 * be either a plain field name (existing behavior - just that column's
 * value) or a template containing @field@ references (e.g.
 * "@Name@ (Last User: @UserName@)"), composing multiple columns into one
 * label - same @field@ template syntax the old Rewst system supported.
 * A missing referenced property keeps the literal @field@ text in place
 * (rather than silently going blank), same as the old system - useful
 * for spotting a typo'd/wrong column name at a glance.
 * @param {string} labelField
 * @param {object} item
 * @param {string} valueField - Fallback source if labelField's own plain-
 *   field lookup comes up empty (not used for the @field@ template case)
 * @returns {string}
 */
function formatItemLabel(labelField, item, valueField) {
    if (labelField && labelField.includes('@')) {
        return labelField.replace(/@(\w+)@/g, (match, fieldName) => {
            return item[fieldName] !== undefined ? String(item[fieldName]) : match;
        });
    }
    return item[labelField] !== undefined ? String(item[labelField]) : String(item[valueField] ?? '');
}

function applyDropdownResult(fieldConfig, items) {
    const el = document.getElementById(`field_${fieldConfig.field_name}`);
    if (!el) return;

    const labelField = fieldConfig.label_field || 'label';
    const valueField = fieldConfig.value_field || 'value';
    const defaultSelectorField = fieldConfig.default_selector;

    const filteredItems = (Array.isArray(items) ? items : []).filter(item => item && typeof item === 'object');
    const validItems = sortDataRows(filteredItems, fieldConfig.order_by_field, fieldConfig.order_by_direction);
    rawDropdownItems[fieldConfig.field_name] = validItems;
    const options = validItems.map(item => ({
        value: item[valueField] !== undefined ? item[valueField] : '',
        label: formatItemLabel(labelField, item, valueField)
    }));

    const defaultValues = [];
    validItems.forEach((item, i) => {
        if (defaultSelectorField && item[defaultSelectorField] === true) {
            defaultValues.push(String(options[i].value));
        }
    });

    if (fieldConfig.multi_select) {
        // el is the widget's hidden <select> - the actual interactive UI
        // lives in its parent .multi-select-container.
        const container = el.closest('.multi-select-container');
        if (!container) return;

        // Preserve the user's current selections across a re-fetch when
        // still valid, same intent as the single-select "stillValid"
        // check below; otherwise fall back to the workflow's declared
        // default(s).
        const previousSelected = Array.from(el.selectedOptions || []).map(o => o.value);
        const stillValidValues = previousSelected.filter(v => options.some(o => String(o.value) === v));
        const selectedValues = stillValidValues.length > 0 ? stillValidValues : defaultValues;

        initializeMultiSelect(container, options, selectedValues, { searchable: fieldConfig.searchable !== false });
        return;
    }

    if (fieldConfig.searchable !== false) {
        // el is the widget's hidden <select> here too - the actual
        // interactive UI lives in its parent .single-select-container.
        const container = el.closest('.single-select-container');
        if (!container) return;

        const previousValue = el.value;
        const stillValid = previousValue && options.some(o => String(o.value) === previousValue);
        const selectedValue = stillValid ? previousValue : (defaultValues[0] || '');

        initializeSearchableSelect(container, options, selectedValue);
        return;
    }

    const previousValue = el.value;
    el.innerHTML = '';

    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = '-- Select --';
    el.appendChild(placeholderOption);

    options.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        el.appendChild(option);
    });

    const stillValid = previousValue && Array.from(el.options).some(o => o.value === previousValue);
    if (stillValid) {
        el.value = previousValue;
    } else if (defaultValues.length > 0) {
        el.value = defaultValues[0];
    }

    applySelectArrowColor(el);
}

/**
 * Substitute [[ field_name ]] references AND real Jinja {{ }} expressions
 * inside a raw SQL query string. Unlike replaceFieldReferences (used for
 * workflow/plugin parameters, which returns the raw resolved value),
 * every substitution here gets SQL-escaped, since it's headed straight
 * into a query string.
 *
 * [[ field_name ]] adds its own surrounding quotes (meant to be used
 * bare, e.g. `WHERE x = [[y]]`). {{ jinja_expression }} does NOT - authors
 * are expected to quote it themselves like any other SQL string literal
 * (e.g. `'{{ form_info.form_user_email }}'`), so only the value itself is
 * escaped and substituted in place, not wrapped in another layer of
 * quotes.
 *
 * Each {{ }} expression is rendered and escaped individually (via a
 * resolved-value map, then one final substitution pass) rather than
 * handing the whole query to the render engine as one template - the
 * latter would mean whatever a field/form_info value happens to contain
 * (e.g. a literal quote character) gets interpolated directly into SQL
 * text unescaped.
 * @param {string} queryTemplate
 * @returns {Promise<string>}
 */
async function resolveSqlQueryTemplate(queryTemplate) {
    if (typeof queryTemplate !== 'string') return '';

    let resolved = queryTemplate.replace(/\[\[\s*([\w.]+)\s*\]\]/g, (full, name) => {
        const value = getFieldCurrentValue(name);
        if (value === undefined || value === null) return "''";
        return `'${escapeSql(value)}'`;
    });

    const jinjaExpressions = [...new Set(resolved.match(/\{\{[\s\S]*?\}\}/g) || [])];
    if (jinjaExpressions.length > 0) {
        const context = buildConditionContext(window.currentFormConfig);
        const resolvedMap = {};
        for (const expr of jinjaExpressions) {
            try {
                const renderResult = await window.renderTemplateWithPersephone(expr, context);
                if (renderResult.success) {
                    resolvedMap[expr] = escapeSql(renderResult.result);
                } else {
                    console.error('[FormViewer] Error rendering SQL query template segment:', expr, renderResult.error);
                    resolvedMap[expr] = '';
                }
            } catch (err) {
                console.error('[FormViewer] Error rendering SQL query template segment:', expr, err);
                resolvedMap[expr] = '';
            }
        }
        resolved = resolved.replace(/\{\{[\s\S]*?\}\}/g, full => resolvedMap[full] !== undefined ? resolvedMap[full] : full);
    }

    return resolved;
}

/**
 * Execute a SQL query for a data-driven field via base.js's
 * executeSqlQuery (POST /sqlquery, handled by the "sqlquery" plugin).
 *
 * Uses the literal 'cookie' sessionToken value, matching form-builder.js's
 * loadSqlDatasources/loadAvailableWorkflows - this looks like a placeholder,
 * but is the only value actually confirmed to work against the live
 * backend. getSessionTokenFromCookie() reads document.cookie directly,
 * which returns nothing here (the session cookie is very likely HttpOnly,
 * so JS can never read its real value) - it threw "sessionToken, user,
 * datasource, and query are required" every time, before the request even
 * went out. getSessionToken() (a fresh /auth call hardcoded to an admin
 * account) is a different, wrong fix for a different reason. If the auth
 * story for /sqlquery changes, update this and the form-builder.js
 * call sites together.
 * @param {string} database - Datasource name (fieldConfig.database)
 * @param {string} query - Fully-resolved SQL query text
 * @returns {Promise<{success: boolean, output: Array|null, error: string|null}>}
 */
async function executeSqlForField(database, query) {
    try {
        const result = await executeSqlQuery('cookie', null, database, query);
        return { success: true, output: result?.result || [], error: null };
    } catch (err) {
        return { success: false, output: null, error: err.message };
    }
}

/**
 * Execute a plugin task for a data-driven field via POST /executeTask
 * (handled by plugins.js's _handleExecuteTask, which normalizes every
 * plugin handler's response into { success, result, message }).
 *
 * Doesn't reuse plugins-front.js's own executeTask() - that module pulls
 * in a lot of unrelated admin-page state, and its version authenticates
 * via getSessionToken() (a fresh /auth call hardcoded to an admin account,
 * which the current owner has said is being phased out). Uses the same
 * literal 'cookie' sessionToken value as executeSqlForField instead, for
 * the same reason: /executeTask goes through the identical presence-only
 * X-Session-Token gate in plugins.js's handleRoute (confirmed by reading
 * that code directly), so there's nothing to actually authenticate with,
 * and 'cookie' is what the rest of this codebase already relies on.
 * @param {number|string} taskId - fieldConfig.task_id
 * @param {object} inputs - Resolved input parameters
 * @returns {Promise<{success: boolean, output: *, error: string|null}>}
 */
async function executeTaskForField(taskId, inputs) {
    try {
        const response = await fetch('https://app.equinoxits.com:1139/executeTask', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': 'cookie'
            },
            body: JSON.stringify({ task_id: taskId, inputs })
        });

        const data = await response.json();

        if (!response.ok && !data.success) {
            throw new Error(data.message || data.error || `HTTP ${response.status}`);
        }

        return { success: true, output: data.result, error: null };
    } catch (err) {
        return { success: false, output: null, error: err.message };
    }
}

/**
 * Execute a Kore utility action for a data-driven field, via Persephone's
 * standalone POST /engine/execute-kore-action (same underlying execution
 * as a 'Kore' step inside a real workflow run, just without a workflow
 * around it). Uses credentials: 'include' like the other /engine/*
 * endpoints (execute, render-template) - this is Persephone's own real
 * session-cookie auth, not the presence-only X-Session-Token gate
 * plugins.js's /executeTask/​/sqlquery use.
 * @param {string} actionName - fieldConfig.action_name
 * @param {object} inputs - Resolved input parameters
 * @returns {Promise<{success: boolean, output: *, error: string|null}>}
 */
async function executeKoreActionForField(actionName, inputs) {
    try {
        const response = await fetch('https://app.equinoxits.com:1139/engine/execute-kore-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ action_name: actionName, inputs })
        });

        const data = await response.json();

        if (!response.ok && !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return { success: true, output: data.result, error: null };
    } catch (err) {
        return { success: false, output: null, error: err.message };
    }
}

/**
 * Determine which data source powers a field - covers both data_retrieval
 * (which stores its own data_source_type) and dropdown fields (where the
 * dropdown_type itself names the source).
 * @param {object} fieldConfig
 * @returns {'workflow'|'sql'|'plugin'|null}
 */
function getFieldDataSourceKind(fieldConfig) {
    if (fieldConfig.type === 'data_retrieval') {
        const t = fieldConfig.data_source_type;
        if (!t || t === 'Workflow') return 'workflow';
        if (t === 'SQL') return 'sql';
        if (t === 'Plugin') return 'plugin';
        return null;
    }
    if (fieldConfig.type === 'dropdown') {
        if (fieldConfig.dropdown_type === 'dropdown_workflow') return 'workflow';
        if (fieldConfig.dropdown_type === 'dropdown_sql') return 'sql';
        if (fieldConfig.dropdown_type === 'dropdown_plugin') return 'plugin';
        if (fieldConfig.dropdown_type === 'dropdown_kore_util') return 'kore_util';
        return null;
    }
    return null;
}

/**
 * Execute a field's configured data source and return its raw output -
 * for 'workflow', the extracted workflow_output key; for 'sql' and
 * 'plugin', the result rows/value directly (there's no extraction key for
 * either - the whole result is "the output").
 * @param {object} fieldConfig
 * @param {'workflow'|'sql'|'plugin'} sourceKind
 * @param {object|string} resolvedInput - Resolved params object (workflow/
 *   plugin) or resolved query text (sql)
 * @returns {Promise<{success: boolean, output: *, error: string|null}>}
 */
async function fetchFieldData(fieldConfig, sourceKind, resolvedInput) {
    if (sourceKind === 'workflow') {
        const result = await executeWorkflowForField(fieldConfig.workflow_id, resolvedInput, fieldConfig.trigger_id || null);
        if (!result.success) return result;
        const value = result.output ? result.output[fieldConfig.workflow_output] : undefined;
        return { success: true, output: value, error: null };
    }

    if (sourceKind === 'sql') {
        return executeSqlForField(fieldConfig.database, resolvedInput);
    }

    if (sourceKind === 'plugin') {
        return executeTaskForField(fieldConfig.task_id, resolvedInput);
    }

    if (sourceKind === 'kore_util') {
        return executeKoreActionForField(fieldConfig.action_name, resolvedInput);
    }

    return { success: false, output: null, error: `Unsupported data source: ${sourceKind}` };
}

/**
 * Resolve a single data-driven field: checks dependencies, and if
 * unblocked, executes its configured data source (skipping re-execution
 * if nothing relevant has changed since the last successful run) and
 * applies the result. Safe to call repeatedly/concurrently across fields.
 * @param {object} fieldConfig
 */
async function resolveDataField(fieldConfig) {
    const fieldName = fieldConfig.field_name;
    const state = dataFieldState[fieldName] || (dataFieldState[fieldName] = { status: null, lastParamsKey: null });

    // Don't stack concurrent executions for the same field
    if (state.status === 'loading') return;

    const sourceKind = getFieldDataSourceKind(fieldConfig);
    if (!sourceKind) return;

    const { blocked, waitingOn } = getFieldDependencyStatus(fieldConfig);
    if (blocked) {
        state.status = 'waiting';
        state.lastParamsKey = null; // force a fresh run once unblocked
        setFieldStatusMessage(fieldConfig, `Waiting on ${waitingOn.join(', ')}...`);
        return;
    }

    let resolvedInput;
    if (sourceKind === 'workflow') {
        resolvedInput = await resolveFieldInputMap(fieldConfig.workflow_input);
        // Every workflow this form triggers (Submit, or any
        // dropdown_workflow/data_retrieval field) gets form_info alongside
        // its own declared inputs - see buildFormInfo.
        resolvedInput.form_info = formInfo;
    } else if (sourceKind === 'plugin' || sourceKind === 'kore_util') {
        resolvedInput = await resolveFieldInputMap(fieldConfig.inputs_map);
    } else {
        resolvedInput = await resolveSqlQueryTemplate(fieldConfig.query || '');
    }
    const paramsKey = sourceKind === 'sql' ? resolvedInput : JSON.stringify(resolvedInput);

    // Already loaded with these exact inputs - nothing to do
    if (state.status === 'loaded' && state.lastParamsKey === paramsKey) return;

    state.status = 'loading';
    setFieldStatusMessage(fieldConfig, 'Loading...');

    const result = await fetchFieldData(fieldConfig, sourceKind, resolvedInput);

    if (!result.success) {
        state.status = 'error';
        setFieldStatusMessage(fieldConfig, `Error: ${result.error}`);
        return;
    }

    // Plugin/kore_util tasks don't all return their array directly the
    // way sqlquery/list_orgs do - some nest it (e.g. ScreenConnect's
    // "List Sessions" returning {sessions: [...]}). result_path (same
    // dot-notation convention as dropdown_prefetch's) unwraps that before
    // the value gets used. Workflow sources already have workflow_output
    // for this exact purpose, so they're left alone here.
    const value = (sourceKind === 'plugin' || sourceKind === 'kore_util')
        ? applyResultPath(result.output, fieldConfig.result_path)
        : result.output;

    if (fieldConfig.type === 'data_retrieval') {
        formPageVariables[fieldName] = value;
        setFieldStatusMessage(fieldConfig, null);
    } else if (fieldConfig.type === 'dropdown') {
        applyDropdownResult(fieldConfig, Array.isArray(value) ? value : []);
        setFieldStatusMessage(fieldConfig, null);
    }

    state.status = 'loaded';
    state.lastParamsKey = paramsKey;

    // This field's new value may unblock or change inputs for other
    // data-driven fields, and could affect conditional visibility too.
    handleFormFieldChange();
}

/**
 * Narrow a value via a dot-notation path (e.g. "sessions" or
 * "data.users"), the same convention dropdown_prefetch's result_path
 * already established. Used wherever a data source's raw response needs
 * unwrapping before it's usable as a dropdown's options - e.g. a plugin
 * task that returns { sessions: [...] } instead of the array directly.
 * @param {*} value
 * @param {string} path
 * @returns {*}
 */
function applyResultPath(value, path) {
    if (!path) return value;
    let extracted = value;
    path.split('.').forEach(part => {
        extracted = extracted && typeof extracted === 'object' ? extracted[part] : undefined;
    });
    return extracted;
}

/**
 * Resolve a dropdown_prefetch field. Unlike workflow/SQL/plugin sources,
 * this doesn't execute anything - it reads data a data_retrieval field has
 * already resolved into formPageVariables (fieldConfig.source_element_name
 * names that field), optionally narrowed via fieldConfig.result_path
 * (dot-notation into the retrieved value, e.g. "data.users").
 *
 * The dependency on source_element_name is implicit - this field waits on
 * it automatically, regardless of whether it's also listed in
 * dependant_fields.
 * @param {object} fieldConfig
 */
function resolvePrefetchDataField(fieldConfig) {
    const fieldName = fieldConfig.field_name;
    const state = dataFieldState[fieldName] || (dataFieldState[fieldName] = { status: null, lastSourceValue: undefined });

    const sourceName = fieldConfig.source_element_name;
    if (!sourceName) return;

    if (!Object.prototype.hasOwnProperty.call(formPageVariables, sourceName)) {
        const formConfig = window.currentFormConfig;
        const sourceFieldConfig = (formConfig?.field_configs || []).find(f => f.field_name === sourceName);
        const sourceDisplayName = sourceFieldConfig?.field_displayname || sourceName;

        state.status = 'waiting';
        state.lastSourceValue = undefined;
        setFieldStatusMessage(fieldConfig, `Waiting on ${sourceDisplayName}...`);
        return;
    }

    const sourceValue = formPageVariables[sourceName];

    // Already applied this exact source data - nothing to do. Reference
    // equality is enough here: formPageVariables[name] only ever gets
    // reassigned (never mutated in place) when its data_retrieval field
    // re-resolves, so an unchanged reference means unchanged data.
    if (state.status === 'loaded' && state.lastSourceValue === sourceValue) return;

    // Narrow via result_path (dot notation), if set
    const extracted = applyResultPath(sourceValue, fieldConfig.result_path);

    applyDropdownResult(fieldConfig, Array.isArray(extracted) ? extracted : []);
    setFieldStatusMessage(fieldConfig, null);

    state.status = 'loaded';
    state.lastSourceValue = sourceValue;

    // This field's new options may set a data_variable other fields
    // depend on (or otherwise unblock/change conditions and inputs) -
    // same reasoning as resolveDataField's own call here.
    handleFormFieldChange();
}

/**
 * Resolve an array field's dot-path `source` (e.g. "script_data.parameters")
 * against the form's current data - the first segment is looked up in
 * formPageVariables first (where data_retrieval results and data_variable
 * values both live), falling back to a regular field's own current value
 * if it's not found there, then each remaining segment is walked the same
 * way dropdown_prefetch's result_path already does.
 * @param {string} source
 * @returns {*}
 */
function resolveArraySourceValue(source) {
    if (!source || typeof source !== 'string') return undefined;
    const parts = source.split('.');
    const firstKey = parts[0];

    let current = Object.prototype.hasOwnProperty.call(formPageVariables, firstKey)
        ? formPageVariables[firstKey]
        : getFieldCurrentValue(firstKey);

    for (let i = 1; i < parts.length; i++) {
        current = current && typeof current === 'object' ? current[parts[i]] : undefined;
    }
    return current;
}

/**
 * Resolve an array field's source into a normalized list of
 * {name, defaultValue} entries, one per rendered input - name becomes
 * both the input's label and the key used when collecting values on
 * submit; defaultValue pre-fills the input (only key_value_pairs
 * actually supplies one - every other type defaults to '').
 *
 * fieldConfig.array_type controls how the resolved source value gets
 * parsed - this system defines these conventions itself (per the current
 * owner, the builder just offers array_type as a plain selection with no
 * behavior of its own baked in):
 * - comma_separated / newline_separated: split on that delimiter, each
 *   entry becomes a name with no default value
 * - json_array: parsed as JSON if the resolved value is a string, used
 *   directly if it's already a real array - same "just names" shape
 * - key_value_pairs: "name:value" pairs, one per line (falling back to
 *   comma-separated if the source has no newlines) - splits on the FIRST
 *   colon only, so a value itself containing a colon (e.g. a URL) isn't
 *   mangled
 * - unset/unrecognized: falls back to comma_separated's behavior
 * @param {object} fieldConfig
 * @returns {Array<{name: string, defaultValue: string}>}
 */
function resolveArraySourceItems(fieldConfig) {
    const resolved = resolveArraySourceValue(fieldConfig.source);
    const arrayType = fieldConfig.array_type || 'comma_separated';

    if (arrayType === 'json_array') {
        let parsed = resolved;
        if (typeof resolved === 'string') {
            try {
                parsed = JSON.parse(resolved);
            } catch (err) {
                console.error('[FormViewer] Error parsing json_array source:', fieldConfig.source, err);
                return [];
            }
        }
        if (!Array.isArray(parsed)) return [];
        return parsed.map(v => String(v).trim()).filter(v => v !== '').map(name => ({ name, defaultValue: '' }));
    }

    if (arrayType === 'key_value_pairs') {
        if (Array.isArray(resolved)) {
            // Already-structured data - support {name, value}-shaped
            // objects directly, in case the source is a real array rather
            // than delimited text.
            return resolved
                .filter(item => item && typeof item === 'object')
                .map(item => ({
                    name: String(item.name ?? item.key ?? '').trim(),
                    defaultValue: String(item.value ?? item.defaultValue ?? '')
                }))
                .filter(item => item.name !== '');
        }
        if (typeof resolved !== 'string') return [];

        const pairDelimiter = resolved.includes('\n') ? /\r?\n/ : ',';
        return resolved.split(pairDelimiter)
            .map(pair => pair.trim())
            .filter(pair => pair !== '')
            .map(pair => {
                const colonIndex = pair.indexOf(':');
                if (colonIndex === -1) return { name: pair, defaultValue: '' };
                return {
                    name: pair.substring(0, colonIndex).trim(),
                    defaultValue: pair.substring(colonIndex + 1).trim()
                };
            })
            .filter(item => item.name !== '');
    }

    // comma_separated / newline_separated (and fallback for any
    // unrecognized/unset array_type)
    let names;
    if (Array.isArray(resolved)) {
        names = resolved.map(v => String(v).trim());
    } else if (typeof resolved === 'string') {
        const delimiter = arrayType === 'newline_separated' ? /\r?\n/ : ',';
        names = resolved.split(delimiter).map(v => v.trim());
    } else {
        names = [];
    }
    return names.filter(v => v !== '').map(name => ({ name, defaultValue: '' }));
}

/**
 * Resolve and (re-)render a repeating_input_mode array field: one plain
 * text input per name in the resolved source array (see
 * resolveArraySourceItems) - matching the old system's own behavior for
 * this field type exactly (flat name -> text value pairs, no per-
 * parameter type/schema support).
 *
 * Safe to call repeatedly - skips re-rendering if the resolved item list
 * hasn't actually changed since last time (same de-dup pattern as
 * resolveDataField/resolvePrefetchDataField), and preserves whatever the
 * user's already typed for any parameter name that's still present after
 * a re-render.
 * @param {object} fieldConfig
 */
function resolveArrayField(fieldConfig) {
    const container = document.getElementById(`field_${fieldConfig.field_name}`);
    if (!container) return;

    const items = resolveArraySourceItems(fieldConfig);
    const itemsKey = JSON.stringify(items);

    const state = dataFieldState[fieldConfig.field_name] || (dataFieldState[fieldConfig.field_name] = {});
    if (state.status === 'loaded' && state.lastParamsKey === itemsKey) return;

    // Preserve any values already typed for parameter names that still
    // exist in the freshly-resolved list - takes priority over that
    // item's own resolved defaultValue, so re-resolving (e.g. after a
    // dependency changes) doesn't clobber something the user already
    // edited.
    const previousValues = {};
    container.querySelectorAll('.array-param-input').forEach(el => {
        previousValues[el.dataset.paramName] = el.value;
    });

    container.innerHTML = items.length === 0
        ? `<div style="color: #999; font-style: italic;">No parameters</div>`
        : items.map((item, idx) => {
            const currentValue = previousValues[item.name] !== undefined ? previousValues[item.name] : item.defaultValue;
            return `
                <div class="form-group--inline" style="align-items: center; margin-bottom: 6px;">
                    <label style="flex: 1; margin: 0;">${escapeHtml(item.name)}</label>
                    <input type="text" id="${escapeHtml(fieldConfig.field_name)}_param_${idx}" class="array-param-input" data-param-name="${escapeHtml(item.name)}" value="${escapeHtml(currentValue)}" style="flex: 1;">
                </div>
            `;
        }).join('');

    state.status = 'loaded';
    state.lastParamsKey = itemsKey;
}

/**
 * Re-render any html field whose content contains real Jinja syntax
 * ({{ }}) against the form's current data - e.g. a field showing a
 * selected script's notes via {{ script_data.notes }}. Fields with no
 * {{ in their content are untouched here - they were already rendered
 * once, directly, and never need this.
 *
 * Called from handleFormFieldChange's debounced pass (alongside
 * applyConditionalVisibility), not its immediate one - unlike a
 * dropdown's options or Submit's enabled state, displayed HTML content
 * isn't time-critical enough to justify a render call on every single
 * keystroke. All fields needing this render in parallel.
 */
async function processHtmlFields() {
    const formConfig = window.currentFormConfig;
    if (!formConfig) return;

    const htmlFields = (formConfig.field_configs || []).filter(fieldConfig => {
        if (fieldConfig.type !== 'html' || !fieldConfig.content || !fieldConfig.content.includes('{{')) return false;

        // Same reasoning as processDataFields: a field with conditions
        // shouldn't render using whatever data currently exists before
        // the condition system has confirmed current visibility against
        // the form's latest state - its content may reference something
        // (e.g. script_data.notes) that simply doesn't exist yet if the
        // field that sets it hasn't resolved. Fields with no conditions
        // aren't affected.
        const hasConditions = Array.isArray(fieldConfig.conditions) && fieldConfig.conditions.length > 0;
        if (hasConditions && lastEvaluatedGeneration < formChangeGeneration) return false;

        // A field that's confirmed not currently visible has no reason to
        // render at all. Defaults to allowed (fail open) for any field
        // not yet seen, same as processDataFields.
        if (fieldVisibilityState[fieldConfig.field_name] === false) return false;

        return true;
    });
    if (htmlFields.length === 0) return;

    const context = buildConditionContext(formConfig);

    await Promise.all(htmlFields.map(async fieldConfig => {
        const container = document.getElementById(`field_${fieldConfig.field_name}`);
        if (!container) return;

        try {
            const renderResult = await window.renderTemplateWithPersephone(fieldConfig.content, context);
            if (renderResult.success) {
                container.innerHTML = renderResult.result;
            } else {
                console.error('[FormViewer] Error rendering html field content:', fieldConfig.field_name, renderResult.error);
            }
        } catch (err) {
            console.error('[FormViewer] Error rendering html field content:', fieldConfig.field_name, err);
        }
    }));
}

/**
 * Find every data_retrieval/dropdown field backed by a supported data
 * source (workflow, SQL, or plugin - dropdown_prefetch is a separate
 * future chunk) and (re-)resolve each one. Safe to call repeatedly (e.g.
 * on every field change) - resolveDataField skips fields that are already
 * loaded/loading with unchanged inputs.
 */
/**
 * Find every data_retrieval/dropdown field backed by a supported data
 * source (workflow, SQL, or plugin - each executes something) or by
 * dropdown_prefetch (which reads another field's already-retrieved data
 * instead) and (re-)resolve each one. Safe to call repeatedly (e.g. on
 * every field change) - both resolveDataField and resolvePrefetchDataField
 * skip fields that are already loaded/loading with unchanged inputs.
 */
function processDataFields() {
    const formConfig = window.currentFormConfig;
    if (!formConfig) return;

    (formConfig.field_configs || []).forEach(fieldConfig => {
        if (fieldConfig.type !== 'data_retrieval' && fieldConfig.type !== 'dropdown' && fieldConfig.type !== 'array') return;

        // A field with conditions shouldn't fetch using whatever
        // intermediate/incomplete values exist before the condition
        // system has actually confirmed current visibility against the
        // form's latest state - otherwise a cascade (e.g. field C's
        // input depends on field B, which only gets a real value once
        // field A is set) can produce a premature fetch using a stale/
        // empty value, which then has to be silently corrected once
        // real visibility catches up. That correction does happen (see
        // resolveDataField's own handleFormFieldChange call), but if the
        // premature fetch is slow (e.g. an unfiltered request pulling
        // far more rows than the eventual filtered one), the correction
        // can lag long enough to look like the field just isn't working.
        // Fields with no conditions at all aren't affected - their
        // visibility never depends on anything resolving first.
        const hasConditions = Array.isArray(fieldConfig.conditions) && fieldConfig.conditions.length > 0;
        if (hasConditions && lastEvaluatedGeneration < formChangeGeneration) return;

        // A field whose conditions aren't currently met shouldn't execute
        // its data source at all - not just stay visually hidden. This
        // uses fieldVisibilityState (the logical determination from the
        // last condition render) rather than isFieldWrapperVisible, since
        // data_retrieval fields have no real DOM wrapper to check at all.
        // Defaults to true (fail open) for any field not yet seen.
        if (fieldVisibilityState[fieldConfig.field_name] === false) return;

        if (fieldConfig.type === 'array') {
            if (fieldConfig.repeating_input_mode && fieldConfig.source) {
                resolveArrayField(fieldConfig);
            } else if (!fieldConfig.repeating_input_mode) {
                resolveArrayItemsOptions(fieldConfig);
            }
            return;
        }

        if (fieldConfig.type === 'dropdown' && fieldConfig.dropdown_type === 'dropdown_prefetch') {
            resolvePrefetchDataField(fieldConfig);
            return;
        }

        const sourceKind = getFieldDataSourceKind(fieldConfig);
        if (sourceKind !== 'workflow' && sourceKind !== 'sql' && sourceKind !== 'plugin' && sourceKind !== 'kore_util') return;

        if (sourceKind === 'workflow' && !fieldConfig.workflow_id) return;
        if (sourceKind === 'sql' && (!fieldConfig.database || !fieldConfig.query)) return;
        if (sourceKind === 'plugin' && !fieldConfig.task_id) return;
        if (sourceKind === 'kore_util' && !fieldConfig.action_name) return;

        resolveDataField(fieldConfig);
    });
}

// ============================================================================
// FORM VIEWER - Buttons & Required-Field Validation
// ============================================================================

/**
 * Render the Reset/Submit buttons into #formButtonsContainer and wire up
 * the listeners that keep Submit's disabled state in sync with the form.
 */
function renderFormButtons() {
    const container = document.getElementById('formButtonsContainer');
    if (!container) return;

    container.innerHTML = `
        <button type="button" id="resetFormViewerBtn" class="btn" data-color="gold" data-size="sm">Reset</button>
        <button type="button" id="submitFormViewerBtn" class="btn" data-color="green" data-size="sm">Submit</button>
    `;

    const resetBtn = document.getElementById('resetFormViewerBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', resetFormViewerFields);
    }

    const submitBtn = document.getElementById('submitFormViewerBtn');
    if (submitBtn) {
        submitBtn.addEventListener('click', submitFormViewer);
    }

    // Delegate from the outer container so every field's input/change
    // (including ones added later, e.g. array rows once implemented)
    // re-applies conditional visibility and re-checks Submit's disabled
    // state, without needing per-field wiring.
    const formContainer = document.getElementById('formContainer');
    if (formContainer) {
        formContainer.addEventListener('input', handleFormFieldChange);
        formContainer.addEventListener('change', handleFormFieldChange);
        formContainer.addEventListener('click', handleArrayFieldClick);
    }

    // Initial pass - conditions may hide/show fields based on default
    // values, and a required field can already be satisfied by its default.
    handleFormFieldChange();
}

/**
 * Read a field's current live value from the DOM, based on its type.
 * This is the canonical "what is this field set to right now" lookup -
 * used by required-field validation and by conditional-visibility
 * expressions (which reference other fields by name).
 * @param {string} fieldName - The field's field_name
 * @returns {*} The field's current value; type/shape depends on field type
 */
function getFieldCurrentValue(fieldName) {
    const formConfig = window.currentFormConfig;
    if (!formConfig) return undefined;

    const fieldConfig = (formConfig.field_configs || []).find(f => f.field_name === fieldName);
    if (!fieldConfig) return undefined;

    switch (fieldConfig.type) {
        case 'text':
        case 'textarea':
        case 'date_time': {
            const el = document.getElementById(`field_${fieldName}`);
            return el ? el.value : '';
        }
        case 'checkbox': {
            const el = document.getElementById(`field_${fieldName}`);
            return el ? el.checked : false;
        }
        case 'radio': {
            const checked = document.querySelector(`input[name="${fieldName}"]:checked`);
            return checked ? checked.value : null;
        }
        case 'dropdown': {
            const el = document.getElementById(`field_${fieldName}`);
            if (!el) return fieldConfig.multi_select ? [] : null;
            if (fieldConfig.multi_select) {
                return Array.from(el.selectedOptions || []).map(o => o.value);
            }
            return el.value;
        }
        // data_retrieval fields have no DOM input of their own - their
        // "value" is whatever their workflow/SQL/plugin call resolved,
        // stashed in formPageVariables under the field's own name.
        case 'data_retrieval':
            return formPageVariables[fieldName];
        // Array/datatable rendering is still a placeholder - no real value
        // to read yet.
        default:
            return undefined;
    }
}

/**
 * Whether a field's wrapper is currently visible. Required fields that are
 * hidden (statically, or conditionally via applyConditionalVisibility)
 * can't be filled in by the user, so they shouldn't block Submit.
 * @param {object} fieldConfig - Field definition
 * @returns {boolean}
 */
function isFieldWrapperVisible(fieldConfig) {
    const wrapper = document.querySelector(`[data-field-name="${fieldConfig.field_name}"]`);
    if (!wrapper) return false;
    return window.getComputedStyle(wrapper).display !== 'none';
}

/**
 * Whether a required field's current value satisfies "required", based on
 * its type. Reads the live value via getFieldCurrentValue rather than
 * fieldConfig, since fieldConfig holds only the field's original defaults,
 * not user input.
 * @param {object} fieldConfig - Field definition
 * @returns {boolean}
 */
function isRequiredFieldSatisfied(fieldConfig) {
    switch (fieldConfig.type) {
        case 'text':
        case 'textarea':
        case 'date_time': {
            const value = getFieldCurrentValue(fieldConfig.field_name);
            return !!(value && String(value).trim() !== '');
        }
        case 'checkbox':
            return getFieldCurrentValue(fieldConfig.field_name) === true;
        case 'radio':
            return getFieldCurrentValue(fieldConfig.field_name) !== null;
        case 'dropdown': {
            const value = getFieldCurrentValue(fieldConfig.field_name);
            if (fieldConfig.multi_select) {
                return Array.isArray(value) && value.length > 0;
            }
            return !!(value && value !== '');
        }
        // Not user-fillable, but this function doubles as the dependency-
        // satisfaction check for workflow-based data fields (see
        // getFieldDependencyStatus) - a data_retrieval field only counts
        // as "satisfied" once it's actually resolved a value.
        case 'data_retrieval':
            return Object.prototype.hasOwnProperty.call(formPageVariables, fieldConfig.field_name);
        // Field-level required doesn't meaningfully apply to
        // repeating_input_mode's individual parameters - they can
        // legitimately be left blank (e.g. a script parameter that
        // defaults server-side when omitted), so there's no single "is
        // this whole field satisfied" answer to give here. If array_type
        // ever grows a per-item required flag (e.g. on json_array/
        // key_value_pairs entries), that's where a real, meaningful check
        // would belong - checking each specific parameter, not the field
        // as a whole. Static "items" mode and datatable are still
        // unimplemented placeholders with no real value to check either.
        case 'array':
        case 'datatable':
            return true;
        default:
            // html, horizontal_line, form_extend - not user-fillable
            // inputs, so "required" doesn't apply.
            return true;
    }
}

/**
 * Check every required, currently-visible field against its live value.
 * @param {object} formConfig - Form definition
 * @returns {boolean} True if every required field is satisfied
 */
function validateRequiredFields(formConfig) {
    const fieldConfigs = formConfig.field_configs || [];
    return fieldConfigs.every(fieldConfig => {
        if (!fieldConfig.required) return true;
        if (!isFieldWrapperVisible(fieldConfig)) return true;
        return isRequiredFieldSatisfied(fieldConfig);
    });
}

/**
 * Re-check required fields and toggle Submit's disabled state accordingly.
 */
function updateSubmitButtonState() {
    const submitBtn = document.getElementById('submitFormViewerBtn');
    if (!submitBtn || !window.currentFormConfig) return;
    submitBtn.disabled = !validateRequiredFields(window.currentFormConfig);
}

/**
 * Reset button handler - clears each column and re-renders fields fresh
 * from the original form config. Reusing the normal render path (rather
 * than resetting each input type by hand) guarantees every field type
 * returns to exactly the same state it opened in.
 */
function resetFormViewerFields() {
    const formConfig = window.currentFormConfig;
    if (!formConfig) return;

    const columnCount = formConfig.column_count || 1;
    for (let col = 1; col <= columnCount; col++) {
        const columnEl = document.getElementById(`formColumn${col}`);
        if (columnEl) columnEl.innerHTML = '';
    }
    ['formTopSpanningZone', 'formBottomSpanningZone'].forEach(zoneId => {
        const zone = document.getElementById(zoneId);
        if (zone) zone.innerHTML = '';
    });

    // Fields are about to be rebuilt fresh from their static defaults -
    // clear data-driven field tracking too, or resolveDataField would see
    // "already loaded, same params" for a brand-new <select> that's
    // actually still stuck on its initial "Loading..." placeholder.
    formPageVariables = {};
    dataFieldState = {};
    fieldVisibilityState = {};
    rawDropdownItems = {};
    formChangeGeneration = 0;
    lastEvaluatedGeneration = -1;

    populateFormFields(formConfig);
    handleFormFieldChange();
}

/**
 * Collect the form's current values into a single object keyed by
 * field_name, ready to send as a workflow's execution parameters.
 * - data_retrieval fields are excluded: they exist purely to pull in a
 *   chunk of data that other fields reference (via [[ field_name ]] or
 *   conditions), not to be submitted themselves.
 * - Every other field type is only included while its wrapper is
 *   currently visible - a conditionally-hidden field isn't part of what
 *   the user is submitting right now.
 * - html/horizontal_line/form_extend have no submittable value; array/
 *   datatable aren't implemented yet. All are skipped.
 * @param {object} formConfig
 * @returns {object}
 */
function collectFormValues(formConfig) {
    const values = {};

    (formConfig.field_configs || []).forEach(fieldConfig => {
        const type = fieldConfig.type;
        if (type === 'html' || type === 'horizontal_line' || type === 'form_extend' ||
            type === 'datatable' || type === 'data_retrieval') {
            return;
        }

        if (type === 'array') {
            if (!isFieldWrapperVisible(fieldConfig)) return;

            if (fieldConfig.repeating_input_mode) {
                const container = document.getElementById(`field_${fieldConfig.field_name}`);
                values[fieldConfig.field_name] = container
                    ? Array.from(container.querySelectorAll('.array-param-input')).map(el => ({
                        param_name: el.dataset.paramName,
                        param_value: el.value
                    }))
                    : [];
                return;
            }

            // Static items mode: one object per rendered instance/row,
            // keyed by each item's own name - e.g.
            // [{client: "5", account: "...", ...}, {client: "8", ...}].
            const container = document.getElementById(`field_${fieldConfig.field_name}`);
            const items = Array.isArray(fieldConfig.items) ? fieldConfig.items : [];
            const instances = container ? Array.from(container.querySelectorAll('.array-instance')) : [];

            values[fieldConfig.field_name] = instances.map(instance => {
                const instanceIndex = instance.dataset.instanceIndex;
                const row = {};
                items.forEach(item => {
                    const el = document.getElementById(`${fieldConfig.field_name}_${item.name}_${instanceIndex}`);
                    row[item.name] = el ? el.value : '';
                });
                return row;
            });
            return;
        }

        if (!isFieldWrapperVisible(fieldConfig)) return;

        values[fieldConfig.field_name] = getFieldCurrentValue(fieldConfig.field_name);
    });

    return values;
}

/**
 * Submit button handler: collects the form's current values and executes
 * formConfig.submit_workflow_id via Persephone (same execute/poll path as
 * dropdown_workflow fields). Resets the form on success, leaves it as-is
 * on failure so the user doesn't lose their input.
 *
 * Adds formInfo (built once at form init - see buildFormInfo) to the
 * payload alongside the form's own field values - submission_id was
 * considered and skipped, since the workflow execution already has its
 * own execution ID for that purpose.
 *
 * As soon as the executionId is known (via executeWorkflowForField's
 * onStarted callback), #executionPanel is shown to the right of the form
 * and wf-exec.js's generateExecDetailHTML renders the full live detail
 * view into it (same cleanupPreviousExecution + generateExecDetailHTML
 * pattern the Workflow Editor's own Test Execution uses) - that view
 * manages its own polling independently of this function's separate
 * poll-to-completion, which only exists to decide success/fail handling
 * (reset vs. preserve the form). #executionContainer is only used for the
 * no-submit-workflow-configured case below; the panel already shows
 * status/errors/execution ID live, so a duplicate brief message for the
 * normal success/fail outcome would be redundant.
 */
async function submitFormViewer() {
    const formConfig = window.currentFormConfig;
    if (!formConfig) return;

    const submitBtn = document.getElementById('submitFormViewerBtn');
    const resetBtn = document.getElementById('resetFormViewerBtn');
    const executionContainer = document.getElementById('executionContainer');

    if (!formConfig.submit_workflow_id) {
        if (executionContainer) {
            executionContainer.innerHTML = `<div style="color: #ff6b6b; padding: 10px 0;">This form has no submit workflow configured.</div>`;
        }
        return;
    }

    if (submitBtn) submitBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;

    const values = collectFormValues(formConfig);
    values.form_info = formInfo;

    const executionPanel = document.getElementById('executionPanel');
    const result = await executeWorkflowForField(
        formConfig.submit_workflow_id,
        values,
        formConfig.submit_trigger_id || null,
        (executionId) => {
            // Same pattern the Workflow Editor's Test Execution uses:
            // clear any previous execution's render state, then hand the
            // fresh executionId straight to generateExecDetailHTML, which
            // renders the full detail view and manages its own polling
            // independently of this function's own poll-to-completion.
            //
            // cleanupPreviousExecution() resets wf-exec.js's own module-
            // level state (timers, polling intervals, expandedSections,
            // etc.), but it clears a hardcoded #execution-detail-container
            // that isn't our #executionPanel (that hardcoded ID doesn't
            // even match the Workflow Editor's own modal container, which
            // uses #execDetailContainer instead - a pre-existing mismatch
            // in wf-exec.js itself). Without flushing our own container,
            // renderExecutionDetail would see data-initialized="true" still
            // set from the prior run and try to update the existing
            // elements in place instead of rebuilding - including step
            // elements keyed by executionSequence, which would leave stale
            // steps from the previous submission mixed in with the new ones.
            if (window.cleanupPreviousExecution) window.cleanupPreviousExecution();
            if (executionPanel) {
                executionPanel.innerHTML = '';
                executionPanel.removeAttribute('data-initialized');
                executionPanel.style.display = 'block';
                window.generateExecDetailHTML(executionId, executionPanel);
            }
        }
    );

    if (resetBtn) resetBtn.disabled = false;

    // The execution detail panel already shows status/errors/execution ID
    // live - no need for a separate brief message duplicating it here.
    if (result.success) {
        resetFormViewerFields();
        // resetFormViewerFields re-checks Submit's own disabled state via
        // handleFormFieldChange, so it doesn't need re-enabling here too.
    } else {
        if (submitBtn) submitBtn.disabled = false;
    }
}

/**
 * Display error message to user
 * @param {string} title - Error title
 * @param {string} message - Error message
 */
function showFormError(title, message) {
    const container = document.getElementById('formContainer');
    if (container) {
        container.innerHTML = `
            <div style="background: #8B0000; border: 1px solid #dc3545; border-radius: 4px; padding: 20px; color: #ffffff;">
                <h2 style="margin-top: 0; color: #ffcccc;">${escapeHtml(title)}</h2>
                <p style="margin: 10px 0 0 0;">${escapeHtml(message)}</p>
            </div>
        `;
    }
}

// ============================================================================
// EXPORTS TO WINDOW
// ============================================================================
window.applyHideInactive = applyHideInactive;
window.buildFormRow = buildFormRow;
window.deleteForm = deleteForm;
window.editForm = editForm;
window.filterForms = filterForms;
window.getFormConfigFromDatabase = getFormConfigFromDatabase;
window.getFormIdFromUrl = getFormIdFromUrl;
window.getFormPermissions = getFormPermissions;
window.loadAllUsersAndGroupsForModal = loadAllUsersAndGroupsForModal;
window.loadForms = loadForms;
window.moveFormToFolder = moveFormToFolder;
window.openCreateModal = openCreateModal;
window.openImportFormModal = openImportFormModal;
window.renderFilteredForms = renderFilteredForms;
window.renderFormsList = renderFormsList;
window.rerenderCurrentView = rerenderCurrentView;
window.saveForm = saveForm;
window.saveFormPermissions = saveFormPermissions;
window.showFormMenu = showFormMenu;
window.showFormPropertiesModal = showFormPropertiesModal;
window.toggleFormActive = toggleFormActive;
// Form Viewer functions
window.initializeFormViewer = initializeFormViewer;
window.initializeUserInfo = initializeUserInfo;
window.buildFormInfo = buildFormInfo;
window.buildFormHTML = buildFormHTML;
window.getFormContainerWidth = getFormContainerWidth;
window.showFormError = showFormError;
window.populateFormFields = populateFormFields;
window.renderFieldHTML = renderFieldHTML;
window.renderFieldLabel = renderFieldLabel;
window.renderFieldBody = renderFieldBody;
window.renderTextField = renderTextField;
window.renderTextareaField = renderTextareaField;
window.renderCheckboxField = renderCheckboxField;
window.renderRadioField = renderRadioField;
window.renderDateTimeField = renderDateTimeField;
window.renderHtmlField = renderHtmlField;
window.renderHorizontalLineField = renderHorizontalLineField;
window.renderDropdownField = renderDropdownField;
window.renderDatatableFieldPlaceholder = renderDatatableFieldPlaceholder;
window.renderFormButtons = renderFormButtons;
window.getFieldCurrentValue = getFieldCurrentValue;
window.isFieldWrapperVisible = isFieldWrapperVisible;
window.isRequiredFieldSatisfied = isRequiredFieldSatisfied;
window.validateRequiredFields = validateRequiredFields;
window.updateSubmitButtonState = updateSubmitButtonState;
window.stripJinjaBraces = stripJinjaBraces;
window.buildBatchedConditionTemplate = buildBatchedConditionTemplate;
window.buildConditionContext = buildConditionContext;
window.applyConditionalVisibility = applyConditionalVisibility;
window.handleFormFieldChange = handleFormFieldChange;
window.replaceFieldReferences = replaceFieldReferences;
window.resolveFieldInputMap = resolveFieldInputMap;
window.getFieldDependencyStatus = getFieldDependencyStatus;
window.executeWorkflowForField = executeWorkflowForField;
window.setFieldStatusMessage = setFieldStatusMessage;
window.sortDataRows = sortDataRows;
window.formatItemLabel = formatItemLabel;
window.normalizeOptionsToArray = normalizeOptionsToArray;
window.applyDropdownResult = applyDropdownResult;

// Debug helpers - module-scoped `let` variables aren't reachable from the
// console at all (unlike functions, which work because they're explicitly
// exported below). These are getter functions rather than raw exports so
// reassignment (e.g. resetFormViewerFields's dataFieldState = {}) is
// always reflected when called, not a stale snapshot from whenever this
// file first loaded.
window.getDataFieldState = () => dataFieldState;
window.getFieldVisibilityState = () => fieldVisibilityState;
window.getFormChangeGeneration = () => formChangeGeneration;
window.getLastEvaluatedGeneration = () => lastEvaluatedGeneration;
window.getFormInfo = () => formInfo;
window.resolveSqlQueryTemplate = resolveSqlQueryTemplate;
window.executeSqlForField = executeSqlForField;
window.executeTaskForField = executeTaskForField;
window.executeKoreActionForField = executeKoreActionForField;
window.updateDataVariables = updateDataVariables;
window.getFieldDataSourceKind = getFieldDataSourceKind;
window.fetchFieldData = fetchFieldData;
window.resolveDataField = resolveDataField;
window.applyResultPath = applyResultPath;
window.resolvePrefetchDataField = resolvePrefetchDataField;
window.resolveArraySourceValue = resolveArraySourceValue;
window.resolveArraySourceItems = resolveArraySourceItems;
window.resolveArrayField = resolveArrayField;
window.processHtmlFields = processHtmlFields;
window.renderArrayField = renderArrayField;
window.renderArrayItemFieldHTML = renderArrayItemFieldHTML;
window.renderArrayInstanceHTML = renderArrayInstanceHTML;
window.initializeArrayInstanceWidgets = initializeArrayInstanceWidgets;
window.applyArrayItemOptionsToAllInstances = applyArrayItemOptionsToAllInstances;
window.resolveArrayItemsOptions = resolveArrayItemsOptions;
window.handleArrayFieldClick = handleArrayFieldClick;
window.processDataFields = processDataFields;
window.resetFormViewerFields = resetFormViewerFields;
window.collectFormValues = collectFormValues;
window.submitFormViewer = submitFormViewer;