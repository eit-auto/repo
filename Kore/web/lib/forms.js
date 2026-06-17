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
        const currentUser = getUser();

        const [users, groups] = await Promise.all([
            getUsers(sessionToken, currentUser),
            getGroups(sessionToken, currentUser)
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
// ============================================================================
// EXPORTS TO WINDOW
// ============================================================================
window.applyHideInactive = applyHideInactive;
window.buildFormRow = buildFormRow;
window.deleteForm = deleteForm;
window.editForm = editForm;
window.filterForms = filterForms;
window.getFormPermissions = getFormPermissions;
window.loadAllUsersAndGroupsForModal = loadAllUsersAndGroupsForModal;
window.loadForms = loadForms;
window.moveFormToFolder = moveFormToFolder;
window.openCreateModal = openCreateModal;
window.renderFilteredForms = renderFilteredForms;
window.renderFormsList = renderFormsList;
window.rerenderCurrentView = rerenderCurrentView;
window.saveForm = saveForm;
window.saveFormPermissions = saveFormPermissions;
window.showFormMenu = showFormMenu;
window.showFormPropertiesModal = showFormPropertiesModal;
window.toggleFormActive = toggleFormActive;