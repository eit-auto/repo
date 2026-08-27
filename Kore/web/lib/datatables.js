import '/lib/base.js';
import '/lib/forms.js';

// ============================================================================
// Datatables Library - Datatable resource CRUD operations and UI management
// ============================================================================
// Mirrors forms.js's list-page conventions (buildWorkflowFoldersPanel,
// displayPermissionsForm, showFormModal, renderTree) so the Datatables page
// behaves identically to the Forms page. Two deliberate deviations from a
// literal forms.js port, both because this was checked against the actual
// updateResource()/handleUpdateResource() contract in resources.js rather
// than assumed:
//   1. Toggling active sends the full updated `definition` (updateResource
//      only recognizes top-level `definition`/`folder_id`/`allowedIPs` -
//      forms.js's toggleFormActive sends a bare `{active}` payload, which
//      would hit "No fields to update" against this backend).
//   2. Permission actions are ['view','create','edit','delete'] - the PUT
//      handler checks hasPermission(..., 'edit', ...), not 'update'.

const API_BASE = 'https://app.equinoxits.com:1139';

let datatables = [];
// Whether the current user can create new datatables (blanket
// 'datatable_admin'/create) - sourced from loadDatatables()'s response,
// defaults to true until that first load completes so the button isn't
// disabled during initial page load.
let canCreateDatatables = true;
let filters = {
    name: '',
    folder: '',
    lastModified: '',
    modifiedBy: '',
    active: ''
};

/**
 * Load all datatables from backend
 */
async function loadDatatables() {
    try {
        const loadingSpinner = document.getElementById('loadingSpinner');
        if (loadingSpinner) {
            loadingSpinner.classList.add('show');
            loadingSpinner.style.display = 'block';
        }

        const response = await fetch(`${API_BASE}/kore/datatables?active=0`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        datatables = data.datatables || [];
        window.datatables = datatables;
        canCreateDatatables = data.canCreate === true;
        updateCreateDatatableButtonState();
        console.log('Datatables loaded:', datatables.map(d => ({ id: d.id, name: d.definition?.name || d.name, folder_id: d.folder_id })));

        await loadAllUsersAndGroupsForModal();

        if (loadingSpinner) {
            loadingSpinner.classList.remove('show');
            loadingSpinner.style.display = 'none';
        }

        return datatables;
    } catch (error) {
        console.error('Error loading datatables:', error);
        const loadingSpinner = document.getElementById('loadingSpinner');
        if (loadingSpinner) {
            loadingSpinner.textContent = 'Error loading datatables';
            loadingSpinner.classList.remove('show');
            loadingSpinner.style.display = 'block';
        }
        return [];
    }
}

/**
 * Update just the folder assignment for a datatable. updateResource()
 * accepts a bare `{folder_id}` payload (no definition required), so this
 * doesn't need to round-trip the full definition the way forms.js's
 * saveForm() does.
 */
async function updateDatatableFolder(datatableId, folderId) {
    const response = await fetch(`${API_BASE}/kore/datatables/${datatableId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ folder_id: folderId || null })
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
}

/**
 * Show datatable context menu
 */
async function showDatatableMenu(event, datatableId) {
    event.stopPropagation();

    const existingMenu = document.getElementById('datatableContextMenu');
    if (existingMenu) existingMenu.remove();

    const dt = datatables.find(d => d.id === datatableId);
    const activeValue = dt?.definition?.active;
    const toggleButtonText = activeValue === false ? 'Enable' : 'Disable';

    let canAccessSettings = dt?.canEdit === true;
    let canDelete = dt?.canDelete === true;

    const menu = document.createElement('div');
    menu.id = 'datatableContextMenu';
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
            <button onclick="toggleDatatableActive('${datatableId}'); document.getElementById('datatableContextMenu').remove();" style="display: block; width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: #c0c0c0; cursor: pointer; font-size: 0.9rem;">
                ${toggleButtonText}
            </button>
            <button onclick="showDatatablePropertiesModal('${datatableId}'); document.getElementById('datatableContextMenu').remove();" style="display: block; width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: ${canAccessSettings ? '#c0c0c0' : '#666'}; cursor: ${canAccessSettings ? 'pointer' : 'not-allowed'}; font-size: 0.9rem;" ${canAccessSettings ? '' : 'disabled'}>
                Settings
            </button>
            <button onclick="deleteDatatable('${datatableId}'); document.getElementById('datatableContextMenu').remove();" style="display: block; width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: ${canDelete ? '#ff6b6b' : '#666'}; cursor: ${canDelete ? 'pointer' : 'not-allowed'}; font-size: 0.9rem;" ${canDelete ? '' : 'disabled'}>
                Delete
            </button>
        </div>
    `;

    const rect = event.target.getBoundingClientRect();
    menu.style.left = (rect.left - 180 + rect.width) + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';

    document.body.appendChild(menu);

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
 * Toggle datatable active status. Sends the full updated definition -
 * see the header note on why a bare {active} payload doesn't work here.
 */
async function toggleDatatableActive(datatableId) {
    const dt = datatables.find(d => d.id === datatableId);
    if (!dt) return;

    const currentActive = dt.definition?.active !== false;
    const newActive = !currentActive;
    const updatedDefinition = { ...(dt.definition || {}), active: newActive };

    try {
        const response = await fetch(`${API_BASE}/kore/datatables/${datatableId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ definition: updatedDefinition })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        dt.definition = updatedDefinition;
        rerenderCurrentView();
        showStatusBanner(`Datatable ${newActive ? 'enabled' : 'disabled'} successfully`, 'success');
    } catch (error) {
        console.error('Error toggling datatable active state:', error);
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to update datatable: ${error.message}`
        });
    }
}

/**
 * Edit a datatable (navigate to the Datatable Builder)
 */
function editDatatable(datatableId) {
    window.location.href = `/datatable-builder?id=${datatableId}`;
}

/**
 * Delete a datatable
 */
function deleteDatatable(datatableId) {
    const dt = datatables.find(d => d.id === datatableId);
    if (!dt) {
        alert('Datatable not found');
        return;
    }

    const dtName = dt.definition?.name || dt.name || '';

    showDeleteConfirm(
        `Are you sure you want to delete <strong>${dtName}</strong>? This action cannot be undone.`,
        async () => {
            try {
                const response = await fetch(`${API_BASE}/kore/datatables/${datatableId}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include'
                });

                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
                }

                closeModal();
                await loadDatatables();
                rerenderCurrentView();
                showStatusBanner(`${dtName} has been deleted.`, 'success');
            } catch (error) {
                console.error('Error deleting datatable:', error);
                showModal({
                    type: 'error',
                    title: 'Error Deleting Datatable',
                    content: error.message,
                    buttons: [{ label: 'OK', type: 'secondary', onClick: () => {} }]
                });
            }
        }
    );
}

/**
 * Finds the "New Datatable" button and reflects canCreateDatatables onto
 * it: disabled + a hint explaining why, when the user lacks
 * 'datatable_admin'/create.
 * TODO: confirm the button's actual id/selector against the page's HTML
 * (not present in this file) - using a best-guess selector for now.
 */
function updateCreateDatatableButtonState() {
    const btn = document.getElementById('newDatatableBtn');
    if (!btn) return;
    btn.disabled = !canCreateDatatables;
    btn.title = canCreateDatatables ? '' : 'You do not have permission to add new datatables';
}

/**
 * Open modal to create a new datatable
 */
function openCreateModal() {
    if (!canCreateDatatables) {
        showStatusBanner('You do not have permission to add new datatables', 'error');
        return;
    }

    showFormModal(
        'Create New Datatable',
        [
            {
                name: 'datatableName',
                type: 'text',
                label: 'Datatable Name',
                placeholder: 'Enter datatable name',
                required: true
            },
            {
                name: 'datatableDescription',
                type: 'text',
                label: 'Description',
                placeholder: 'Optional description'
            }
        ],
        async (formData) => {
            const datatableName = formData.datatableName?.trim();

            if (!datatableName) {
                showModal({
                    title: 'Error',
                    content: 'Datatable name is required',
                    buttons: [{ label: 'OK', className: 'btn-blue', callback: ({ close }) => close() }]
                });
                return;
            }

            try {
                const payload = {
                    name: datatableName,
                    description: formData.datatableDescription?.trim() || null
                };

                const response = await fetch(`${API_BASE}/kore/datatables`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
                }

                const result = await response.json();
                const newDatatableId = result.id;

                await loadDatatables();
                rerenderCurrentView();
                setTimeout(() => {
                    window.location.href = `/datatable-builder?id=${newDatatableId}`;
                }, 1000);
            } catch (error) {
                console.error('Error creating datatable:', error);
                showModal({
                    title: 'Error Creating Datatable',
                    content: error.message,
                    buttons: [{ label: 'OK', className: 'btn-blue', callback: ({ close }) => close() }]
                });
            }
        }
    );
}

/**
 * Fetch datatable permissions from backend
 */
async function getDatatablePermissions(datatableId) {
    try {
        const config = {
            resource: 'datatable',
            endpoint: `${API_BASE}/kore/permissions`,
            method: 'POST',
            body: { resource: 'datatable', scope: datatableId }
        };
        const permissions = await loadPermissionsForResource(config);
        return permissions.filter(p => p.revokedAt === null);
    } catch (error) {
        console.error('Error fetching datatable permissions:', error);
        return [];
    }
}

/**
 * Save datatable permissions (batch update)
 */
async function saveDatatablePermissions(datatableId) {
    try {
        const config = { resource: 'datatable', endpoint: `${API_BASE}/kore/permissions` };
        await savePermissionsForResource(config, datatableId);
        return { success: true };
    } catch (error) {
        console.error('Error saving datatable permissions:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Show Datatable Properties Modal with Folder, Permissions, and About tabs
 */
async function showDatatablePropertiesModal(datatableId) {
    const dt = datatables.find(d => d.id === datatableId);
    if (!dt) {
        alert('Datatable not found');
        return;
    }

    await loadAllUsersAndGroupsForModal();
    const permissions = await getDatatablePermissions(datatableId);

    const meta = dt.definition?.meta_data || {};
    const createdAt = meta.created_at ? new Date(meta.created_at).toLocaleString() : 'N/A';
    const updatedAt = meta.modified_at ? new Date(meta.modified_at).toLocaleString() : 'N/A';
    const createdBy = resolveIdToName(meta.created_by) || 'N/A';
    const updatedBy = resolveIdToName(meta.modified_by) || 'N/A';
    const dtDisplayName = dt.definition?.name || dt.name || '';

    const modalContent = document.createElement('div');
    modalContent.innerHTML = `
        <style>
            .settings-tabs { display: flex; gap: 0; margin-bottom: 10px; border-bottom: 1px solid var(--border-primary); }
            .settings-tab-btn { padding: 0 16px 5px 16px; background: transparent; border: none; color: var(--text-secondary); font-size: 0.9rem; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s; }
            .settings-tab-btn:hover { color: var(--text-primary); }
            .settings-tab-btn.active { color: var(--text-primary); border-bottom-color: var(--primary-color, #7ec8ff); }
            .settings-tab-panel { display: none; }
            .settings-tab-panel.active { display: block; }
            .metadata-grid { display: grid; grid-template-columns: 60% 40%; gap: 20px; margin-top: 12px; }
            .metadata-item { display: flex; flex-direction: row; gap: 4px; }
            .metadata-label { font-size: 0.75rem; color: var(--text-secondary); font-weight: 500; }
            .metadata-label::after { content: ':'; }
            .metadata-value { font-size: 0.75rem; color: var(--text-primary); word-break: break-all; }
        </style>

        <div class="panel-level-2">
        <div class="settings-tabs">
            <button class="settings-tab-btn active" data-tab="tab-folder">Folder</button>
            <button class="settings-tab-btn" data-tab="tab-permissions">Permissions</button>
            <button class="settings-tab-btn" data-tab="tab-about">About</button>
        </div>

        <div class="settings-tab-panel active" id="tab-folder">
            <div id="settingsFolderTree" style="border: 1px solid var(--border-primary); border-radius: 4px; max-height: 300px; overflow-y: auto; background: var(--bg-input); padding: 8px;"></div>
        </div>

        <div class="settings-tab-panel" id="tab-permissions">
            <div id="permissionsFormContainer"></div>
        </div>

        <div class="settings-tab-panel" id="tab-about">
            <div class="metadata-grid">
                <div class="metadata-item"><div class="metadata-label">Datatable ID</div><div class="metadata-value">${dt.id}</div></div>
                <div class="metadata-item"><div class="metadata-label">Version</div><div class="metadata-value">${dt.version || 'N/A'}</div></div>
                <div class="metadata-item"><div class="metadata-label">Created By</div><div class="metadata-value">${createdBy}</div></div>
                <div class="metadata-item"><div class="metadata-label">Created At</div><div class="metadata-value">${createdAt}</div></div>
                <div class="metadata-item"><div class="metadata-label">Updated By</div><div class="metadata-value">${updatedBy}</div></div>
                <div class="metadata-item"><div class="metadata-label">Updated At</div><div class="metadata-value">${updatedAt}</div></div>
            </div>
        </div>
        </div>
    `;

    showModal({
        title: `${dtDisplayName} - Settings`,
        content: modalContent,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Save', type: 'success' },
            { label: 'Close', type: 'secondary' }
        ]
    });

    setTimeout(() => {
        let modal = document.querySelector('[role="dialog"]') || document.querySelector('.modal-container') || document.querySelector('.modal');
        if (!modal) return;

        const buttons = modal.querySelectorAll('button');
        const saveBtn = Array.from(buttons).find(b => b.textContent.trim() === 'Save');
        const closeBtn = Array.from(buttons).find(b => b.textContent.trim() === 'Close');

        if (saveBtn) {
            saveBtn.onclick = async (e) => {
                e.preventDefault();

                // Save folder change if pending
                if (window.pendingFolderChange !== undefined && window.pendingFolderChange !== dt.folder_id) {
                    try {
                        await updateDatatableFolder(datatableId, window.pendingFolderChange);
                        dt.folder_id = window.pendingFolderChange || null;
                        await loadDatatables();
                        rerenderCurrentView();
                    } catch (error) {
                        console.error('Folder save error:', error);
                        showStatusBanner(`Failed to update folder: ${error.message}`, 'error');
                    }
                }

                // Save permissions if any exist
                let permissionSaveResult = { success: true };
                const permissionRows = document.querySelectorAll('.permission-row');
                if (permissionRows.length > 0) {
                    permissionSaveResult = await saveDatatablePermissions(datatableId);
                }

                delete window.pendingFolderChange;
                closeModal();

                if (permissionSaveResult.success) {
                    showStatusBanner('Datatable settings saved successfully', 'success');
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
    }, 0);

    // Tab switching
    const tabButtons = modalContent.querySelectorAll('.settings-tab-btn');
    const tabPanels = modalContent.querySelectorAll('.settings-tab-panel');

    const adjustModalHeight = () => {
        const modal = document.querySelector('.modal-container');
        const modalBodyContent = document.querySelector('#modal-body-content');
        if (modal && modalBodyContent) {
            const tabsContainer = modalContent.querySelector('.settings-tabs');
            if (tabsContainer) {
                let maxPanelHeight = 0;
                tabPanels.forEach(panel => { if (panel.scrollHeight > maxPanelHeight) maxPanelHeight = panel.scrollHeight; });
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
        const folders = window.datatables_folders || [];
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
            if (!dt.folder_id) {
                noFolderDiv.style.background = 'rgba(126, 200, 255, 0.2)';
                window.pendingFolderChange = null;
            }
            noFolderDiv.onmouseover = () => {
                if (!noFolderDiv.style.background.includes('0.2')) noFolderDiv.style.background = 'rgba(126, 200, 255, 0.1)';
            };
            noFolderDiv.onmouseout = () => {
                if (!dt.folder_id && window.pendingFolderChange === null) {
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
                        treeContainer.querySelectorAll('[data-item-id]').forEach(el => { el.style.backgroundColor = ''; });
                        noFolderDiv.style.backgroundColor = '';
                        const selectedEl = treeContainerForRender.querySelector(`[data-item-id="${folder.id}"]`);
                        if (selectedEl) selectedEl.style.backgroundColor = 'rgba(126, 200, 255, 0.2)';
                    }
                });
                treeContainer.appendChild(treeContainerForRender);

                if (dt.folder_id) {
                    const currentEl = treeContainerForRender.querySelector(`[data-item-id="${dt.folder_id}"]`);
                    if (currentEl) {
                        currentEl.style.backgroundColor = 'rgba(126, 200, 255, 0.2)';
                        window.pendingFolderChange = dt.folder_id;
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
                    actions: ['view', 'create', 'edit', 'delete', '*']
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
 * Move datatable to folder - opens properties modal
 */
function moveDatatableToFolder(datatableId) {
    showDatatablePropertiesModal(datatableId);
}

/**
 * Filter datatables based on search inputs
 */
function filterDatatables() {
    const filterName = document.getElementById('filterName')?.value.toLowerCase() || '';
    const filterFolder = document.getElementById('filterFolder')?.value.toLowerCase() || '';
    const filterLastModified = document.getElementById('filterLastModified')?.value.toLowerCase() || '';
    const filterModifiedBy = document.getElementById('filterModifiedBy')?.value.toLowerCase() || '';
    const filterActive = document.getElementById('filterActive')?.value.toLowerCase() || '';

    const tableBody = document.getElementById('datatablesTableBody');
    if (!tableBody) return;

    const rows = tableBody.getElementsByTagName('tr');
    for (let row of rows) {
        const cells = row.getElementsByTagName('td');
        if (cells.length === 0) continue;

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
    const tableBody = document.getElementById('datatablesTableBody');
    if (!tableBody) return;

    const rows = tableBody.getElementsByTagName('tr');
    for (let row of rows) {
        const cells = row.getElementsByTagName('td');
        if (cells.length === 0) continue;

        const activeCell = cells[4]?.textContent.toLowerCase() || '';
        const isInactive = activeCell === 'false';

        if (hideInactive && isInactive) {
            row.style.display = 'none';
        } else {
            if (row.style.display === 'none' && !hideInactive) {
                row.style.display = '';
            } else if (row.style.display !== 'none') {
                row.style.display = '';
            }
        }
    }
}

const DATATABLES_TABLE_HEAD = `
    <thead style="background: transparent;">
        <tr style="pointer-events: none; background: transparent !important; background-color: transparent !important;">
            <th style="padding: 0; background: transparent;"><input type="text" id="filterName" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterDatatables()"></th>
            <th style="padding: 0; background: transparent;"><input type="text" id="filterFolder" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterDatatables()"></th>
            <th style="padding: 0; background: transparent;"><input type="text" id="filterLastModified" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterDatatables()"></th>
            <th style="padding: 0; background: transparent;"><input type="text" id="filterModifiedBy" placeholder="Filter..." style="width: 100%; height: 100%; box-sizing: border-box; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onkeyup="filterDatatables()"></th>
            <th style="width: 70px; min-width: 70px; max-width: 70px; padding: 0; background: transparent;"><select id="filterActive" style="width: 100%; height: 100%; box-sizing: border-box; cursor: pointer; pointer-events: auto; padding: 4px; border-radius: 0; font-size: 0.8rem;" onchange="filterDatatables()"><option value="">All</option><option value="True">True</option><option value="False">False</option></select></th>
            <th style="width: 80px; min-width: 80px; max-width: 80px; background: transparent;"></th>
            <th style="width: 70px; min-width: 70px; max-width: 70px; position: relative; background: transparent; padding: 0;"><div style="display: flex; justify-content: flex-end; align-items: center; height: 100%; padding: 0; width: 100%;"><button class="btn" data-color="blue" data-size="sm" onclick="loadDatatables().then(() => rerenderCurrentView())" style="pointer-events: auto; cursor: pointer;">Refresh</button></div></th>
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
`;

/**
 * Render a filtered list of datatables (called on folder selection)
 */
function renderFilteredDatatables(filteredDatatables) {
    const container = document.getElementById('datatablesList');
    if (!container) return;
    container.innerHTML = '';

    if (filteredDatatables.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No datatables in this folder</h3>
                <p>Select another folder or create a new datatable</p>
            </div>
        `;
        return;
    }

    let html = `
        <table class="workflows-table" style="table-layout: fixed; padding: 0 4px; width: 100%;">
            ${DATATABLES_TABLE_HEAD}
            <tbody id="datatablesTableBody" style="background: transparent !important;">
    `;

    filteredDatatables.forEach(dt => { html += buildDatatableRow(dt); });

    html += `
            </tbody>
        </table>
    `;
    container.innerHTML = html;
}

/**
 * Render the full datatables list (all datatables, no folder filter)
 */
function renderDatatablesList() {
    const container = document.getElementById('datatablesList');
    const loadingSpinner = document.getElementById('loadingSpinner');
    if (!container) return;
    if (loadingSpinner) loadingSpinner.classList.remove('show');
    container.innerHTML = '';

    if (datatables.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No datatables yet</h3>
                <p>Create your first datatable to get started</p>
            </div>
        `;
        return;
    }

    let html = `
        <table class="workflows-table" style="table-layout: fixed; padding: 0 4px; width: 100%;">
            ${DATATABLES_TABLE_HEAD}
            <tbody id="datatablesTableBody" style="background: transparent !important;">
    `;

    datatables.forEach(dt => { html += buildDatatableRow(dt); });

    html += `
            </tbody>
        </table>
    `;
    container.innerHTML = html;
    applyHideInactive();
}

/**
 * Build a single datatable table row
 */
function buildDatatableRow(dt) {
    const def = dt.definition || {};
    const meta = def.meta_data || {};
    const name = def.name || dt.name || '';
    const description = def.desc || def.description || '';
    const activeDisplay = def.active === undefined ? 'Undefined' : (def.active ? 'True' : 'False');
    const lastModified = meta.modified_at ? new Date(meta.modified_at).toLocaleString() : 'N/A';
    const modifiedBy = resolveIdToName(meta.modified_by) || 'N/A';
    const version = dt.version || '1.0';

    let folderName = '';
    if (dt.folder_id) {
        const folders = window.datatables_folders || [];
        const folder = folders.find(f => f.id === dt.folder_id);
        folderName = folder ? folder.name : dt.folder_id;
    }

    const escapedDescription = (description || '(no description)').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    return `
        <tr data-datatable-id="${dt.id}" style="font-size: 0.8rem; font-weight: normal;" title="${escapedDescription}">
            <td class="datatable-name"><a href="/datatable-builder?id=${dt.id}" style="color: inherit; text-decoration: none; font-weight: normal;">${name}</a></td>
            <td style="font-weight: normal;">${folderName}</td>
            <td style="white-space: nowrap; font-size: 0.8rem; font-weight: normal;">${lastModified}</td>
            <td style="font-weight: normal;">${modifiedBy}</td>
            <td style="width: 70px; min-width: 70px; max-width: 70px; text-align: center; font-weight: normal;">${activeDisplay}</td>
            <td class="version" style="width: 80px; min-width: 80px; max-width: 80px; font-weight: normal;">v${version}</td>
            <td class="actions" style="width: 70px; min-width: 70px; max-width: 70px; text-align: right; overflow: hidden; padding: 2px; box-sizing: border-box; display: flex; gap: 2px; justify-content: flex-end; align-items: center;">
                <button class="btn btn-blue btn-small" onclick="editDatatable('${dt.id}')" style="flex: 0 0 24px; padding: 1px 2px; font-size: 0.7rem; height: 20px; display: flex; align-items: center; justify-content: center;" title="Edit">✎</button>
                <button class="btn btn-small" onclick="showDatatableMenu(event, '${dt.id}').catch(e => console.error('Menu error:', e))" style="flex: 0 0 24px; padding: 1px 2px; font-size: 0.7rem; height: 20px; background: var(--secondary-slate); border: 1px solid var(--secondary-slate); cursor: pointer; display: flex; align-items: center; justify-content: center;" title="More">⋯</button>
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
        const filtered = folder.id === 'all' ? datatables :
                         folder.id === 'no_folder' ? datatables.filter(d => !d.folder_id) :
                         datatables.filter(d => d.folder_id === folder.id);
        renderFilteredDatatables(filtered);
    } else {
        renderDatatablesList();
    }
}

// Expose page-level functions used by inline HTML event handlers
window.loadDatatables = loadDatatables;
window.showDatatableMenu = showDatatableMenu;
window.toggleDatatableActive = toggleDatatableActive;
window.editDatatable = editDatatable;
window.deleteDatatable = deleteDatatable;
window.openCreateModal = openCreateModal;
window.updateCreateDatatableButtonState = updateCreateDatatableButtonState;
window.showDatatablePropertiesModal = showDatatablePropertiesModal;
window.moveDatatableToFolder = moveDatatableToFolder;
window.filterDatatables = filterDatatables;
window.applyHideInactive = applyHideInactive;
window.renderFilteredDatatables = renderFilteredDatatables;
window.renderDatatablesList = renderDatatablesList;
window.rerenderCurrentView = rerenderCurrentView;

// ============================================================================
// DATATABLE VIEWER
// ============================================================================
// Ports the old Rewst-based Datatable Viewer onto Kore. Key differences from
// a literal port:
//   - SQL Mode writes go through dtvGenerateSQL() + executeSqlQuery()
//     directly (no ProxyLib); an optional post-write workflow hook fires
//     via executeWorkflowForField() and never blocks/fails the write.
//   - Workflow-mode reads/writes go through executeWorkflowForField() (from
//     forms.js) instead of the old RewstApp/testWorkflow polling class.
//   - Row-level Add/Edit/Delete permissions reuse the same scoped
//     view/create/edit/delete permission set as the Builder's Permissions
//     modal (per explicit decision), read from GET /kore/datatables/:id's
//     canCreate/canEdit/canDelete flags - there's no separate row-level ACL.
//   - Cascading input-variable dropdowns are resolved in the Builder's
//     configured order (top-to-bottom) rather than via a dependency graph:
//     the old input_var "dep1,dep2" string format has no equivalent in the
//     new Builder, so a changed dropdown just re-resolves everything after
//     it in list order. MySQL-sourced dropdowns still detect unresolved
//     [[var]] placeholders and show a waiting state; workflow-sourced
//     dropdowns are simply called with every value resolved so far.
//
// All names here are prefixed dtv* to avoid colliding with the list-page
// functions above, since both live in this same module.

let dtvDatatableId = null;
let dtvDefinition = null;
let dtvVersion = '';
let dtvCanCreate = false;
let dtvCanEdit = false;
let dtvCanDelete = false;
let dtvColumnsAll = [];        // full col_settings
let dtvColsTable = [];         // col_name list, hide_table !== true
let dtvColsEdit = [];          // col configs, hide_edit !== true
let dtvTableData = [];
let dtvFilteredData = [];
let dtvFieldTypes = {};
let dtvCurrentSort = { column: null, direction: 'asc' };
let dtvFilterStates = {};
let dtvInputVarValues = {};
let dtvColumnMappings = {};

// Mirrors forms.js's currentUserInfo/buildFormInfo: Persephone's
// executeWorkflow() specifically looks for parameters.form_info.form_user
// to resolve _USER/USER context (see resolvedUserId in persephone.js), so
// every workflow call the Viewer makes - Get, dataset-selector dropdowns,
// and writes - needs this same form_info shape, not just the write ones.
let dtvUserInfo = { user_id: null, email: null, full_name: null };

async function dtvInitUserInfo() {
    // PHASE 2: no localStorage pre-fill of user_id - see the matching note in
    // forms.js initializeUserInfo(). The value below comes from /auth/me,
    // resolved from the session.
    try {
        const data = await getCurrentUserData('cookie');
        if (data) {
            dtvUserInfo.user_id = data.user_id || null;
            dtvUserInfo.email = data.email || null;
            dtvUserInfo.full_name = data.full_name || null;
        }
    } catch (err) {
        console.error('[DTV] Error fetching current user info:', err);
    }
}

function dtvBuildFormInfo() {
    return {
        form_id: dtvDatatableId,
        form_name: dtvDefinition?.name || '',
        form_version: dtvVersion,
        form_user: dtvUserInfo.user_id,
        form_user_email: dtvUserInfo.email
    };
}

// DOM refs
let dtvLoadingNote, dtvNameEl, dtvDescEl, dtvBody,
    dtvInputVarContainer, dtvInputVarDropdowns, dtvInputVarMessage,
    dtvSearchInput, dtvFiltersContainer, dtvAddRowBtn, dtvSaveAllBtn, dtvRefreshBtn,
    dtvWindowModeInstruction, dtvTableHead, dtvTableBody, dtvRecordsCount;

// ---- URL / config load ----

function getDatatableViewerIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('id');
}

async function dtvFetchDatatable(datatableId) {
    const response = await fetch(`${API_BASE}/kore/datatables/${datatableId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
}

// ---- Init ----

async function initializeDatatableViewer() {
    dtvLoadingNote = document.getElementById('loadingNote');
    dtvNameEl = document.getElementById('datatableViewerName');
    dtvDescEl = document.getElementById('datatableViewerDesc');
    dtvBody = document.getElementById('datatableViewerBody');
    dtvInputVarContainer = document.getElementById('inputVarContainer');
    dtvInputVarDropdowns = document.getElementById('inputVarDropdowns');
    dtvInputVarMessage = document.getElementById('inputVarMessage');
    dtvSearchInput = document.getElementById('searchInput');
    dtvFiltersContainer = document.getElementById('filtersContainer');
    dtvAddRowBtn = document.getElementById('addRowBtn');
    dtvSaveAllBtn = document.getElementById('saveAllBtn');
    dtvRefreshBtn = document.getElementById('refreshBtn');
    dtvWindowModeInstruction = document.getElementById('windowModeInstruction');
    dtvTableHead = document.getElementById('tableHead');
    dtvTableBody = document.getElementById('tableBody');
    dtvRecordsCount = document.getElementById('recordsCount');

    dtvDatatableId = getDatatableViewerIdFromUrl();
    if (!dtvDatatableId) {
        dtvShowFatalError('No id provided in the URL (?id=...)');
        return;
    }

    try {
        const data = await dtvFetchDatatable(dtvDatatableId);
        dtvDefinition = data.definition || {};
        dtvVersion = data.version || '';
        dtvCanCreate = data.canCreate === true;
        dtvCanEdit = data.canEdit === true;
        dtvCanDelete = data.canDelete === true;
    } catch (error) {
        console.error('[DTV] Failed to load datatable:', error);
        dtvShowFatalError(`Failed to load datatable: ${error.message}`);
        return;
    }

    dtvColumnsAll = dtvDefinition.col_settings || [];
    dtvColsTable = dtvColumnsAll.filter(c => c.hide_table !== true).map(c => c.col_name);
    dtvColsEdit = dtvColumnsAll.filter(c => c.hide_edit !== true);

    if (dtvNameEl && dtvDefinition.name) {
        dtvNameEl.textContent = dtvDefinition.name;
        dtvNameEl.style.display = 'block';
    }
    if (dtvDescEl && dtvDefinition.desc) {
        dtvDescEl.innerHTML = dtvDefinition.desc;
        dtvDescEl.style.display = 'block';
    }

    await dtvInitUserInfo();
    await dtvBuildColumnMappings();

    dtvBuildTableHead();
    dtvRenderFilters();
    dtvWireControls();

    dtvAddRowBtn.style.display = dtvCanCreate ? 'inline-flex' : 'none';
    if (dtvDefinition.edit_type === 'column' && dtvCanEdit) {
        dtvSaveAllBtn.style.display = 'inline-flex';
    }
    if (dtvDefinition.edit_type !== 'column') {
        dtvWindowModeInstruction.style.display = 'block';
        dtvWindowModeInstruction.textContent = dtvCanEdit ? 'CLICK A ROW BELOW TO EDIT' : 'CLICK A ROW BELOW FOR MORE DETAILS';
    }

    dtvLoadingNote.style.display = 'none';
    dtvBody.style.display = 'flex';

    await dtvRenderInputVarDropdowns();
}

function dtvShowFatalError(message) {
    if (dtvLoadingNote) {
        dtvLoadingNote.textContent = message;
        dtvLoadingNote.style.color = '#ff6b6b';
    }
}

function dtvWireControls() {
    dtvSearchInput.addEventListener('input', (e) => {
        dtvFilterData(e.target.value);
        dtvRenderTable();
    });
    dtvAddRowBtn.addEventListener('click', dtvOpenAddModal);
    dtvSaveAllBtn.addEventListener('click', dtvSaveAllChanges);
    dtvRefreshBtn.addEventListener('click', () => dtvLoadData());
}

// ---- Column value mappings (static + MySQL) ----

async function dtvBuildColumnMappings() {
    dtvColumnMappings = {};
    for (const col of dtvColumnsAll) {
        if (col.map_type === 'static' && col.map) {
            dtvColumnMappings[col.col_name] = col.map;
        } else if (col.map_type === 'mysql' && col.map_query) {
            try {
                const result = await executeSqlQuery('cookie', null, dtvDefinition.sql_database, col.map_query);
                const mapObj = {};
                (result?.result || []).forEach(row => {
                    const id = row[col.map_id_col];
                    const label = row[col.map_value_col];
                    if (id !== undefined && label !== undefined) mapObj[id] = label;
                });
                dtvColumnMappings[col.col_name] = mapObj;
            } catch (error) {
                console.error('[DTV] Failed to build mapping for', col.col_name, error);
            }
        }
    }
}

function dtvGetMappedValue(colName, value) {
    if (dtvColumnMappings[colName] && dtvColumnMappings[colName][value] !== undefined) {
        return dtvColumnMappings[colName][value];
    }
    return value;
}

// ---- Field type detection & formatting ----

function dtvDetectFieldTypes(records) {
    const detected = {};
    if (records && records.length > 0) {
        const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
        const datePattern = /^\d{4}-\d{2}-\d{2}$/;
        const dateTimeAltPattern = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}/;
        const cols = Object.keys(records[0]);
        cols.forEach(colName => {
            let dateCount = 0, dateTimeCount = 0, valueCount = 0;
            for (let i = 0; i < Math.min(records.length, 10); i++) {
                const value = records[i][colName];
                if (value && typeof value === 'string') {
                    valueCount++;
                    if (dateTimePattern.test(value) || dateTimeAltPattern.test(value)) dateTimeCount++;
                    else if (datePattern.test(value)) dateCount++;
                }
            }
            if (valueCount > 0) {
                if (dateTimeCount > valueCount * 0.7) detected[colName] = 'datetime';
                else if (dateCount > valueCount * 0.7) detected[colName] = 'date';
            }
        });
    }
    // Configured type fills any gap detection didn't classify
    dtvColumnsAll.forEach(col => {
        if (col.type && !detected[col.col_name]) detected[col.col_name] = col.type;
    });
    return detected;
}

function dtvParseBoolean(value) {
    return value === true || value === 'true' || value === '1' || value === 1;
}

function dtvFormatDateTimeDisplay(value) {
    if (!value) return '';
    const d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function dtvFormatDateDisplay(value) {
    if (!value) return '';
    const d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
}

function dtvFormatCellValue(colName, value) {
    if (value === null || value === undefined) return '';
    const type = dtvFieldTypes[colName];
    if (type === 'datetime') return dtvFormatDateTimeDisplay(value);
    if (type === 'date') return dtvFormatDateDisplay(value);
    return String(value);
}

function dtvFormatColumnName(colName) {
    return colName.charAt(0).toUpperCase() + colName.slice(1).replace(/_/g, ' ');
}

function dtvDisplayValue(colConfig, value) {
    if (colConfig.type === 'boolean') return dtvParseBoolean(value) ? 'True' : 'False';
    const mapped = dtvGetMappedValue(colConfig.col_name, value);
    return dtvFormatCellValue(colConfig.col_name, mapped);
}

const DTV_NUMERIC_TYPES = ['int', 'integer', 'bigint', 'smallint', 'decimal', 'float', 'numeric', 'double'];

// The Builder normalizes all of these down to 'text' on import, but a
// config saved before that fix (or authored by hand) could still carry
// the raw MySQL DATA_TYPE value, so all variants are handled here too.
const DTV_TEXTAREA_TYPES = ['text', 'longtext', 'mediumtext', 'tinytext'];

// ---- SQL generation for SQL Mode writes ----

function dtvFormatSqlValue(value, col) {
    const colType = col?.type;
    if (value === null || value === undefined) return 'NULL';
    if (value === '') {
        // Explicit per-column override always wins - lets a free-text
        // varchar/text FK reference (no dropdown mapping) opt in to the
        // same "blank means NULL" behavior without depending on type or
        // mapping status. Not_null and this are mutually exclusive in
        // practice: not_null blocks blank at validation before this is
        // ever reached, so the Builder disables this checkbox whenever
        // Not Null is checked - it's just never inert here either way.
        if (col?.null_for_blank) return 'NULL';
        // A mapped/select column (dropdown of options) left on the
        // placeholder represents "no selection", not "empty text" - that's
        // always NULL regardless of the underlying declared type (varchar
        // UUIDs/short IDs are commonly used for FK-style mapped columns,
        // where '' would violate the FK constraint). Only genuine free-text
        // varchar/text fields default a blank value to '' instead of NULL.
        if (col?.map || col?.map_type) return 'NULL';
        return ['varchar', 'char', 'string', ...DTV_TEXTAREA_TYPES].includes(colType) ? "''" : 'NULL';
    }
    if (DTV_NUMERIC_TYPES.includes(colType)) return String(value);
    if (colType === 'boolean') return value ? '1' : '0';
    if (['datetime', 'timestamp', 'date'].includes(colType)) {
        if (String(value).includes('T')) {
            const d = new Date(value);
            const pad = n => String(n).padStart(2, '0');
            return `'${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}'`;
        }
        return `'${String(value)}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
}

function dtvGenerateSQL(action, record, columns, tableName) {
    if (!tableName) throw new Error('No table selected for this datatable');

    const pkCol = columns.find(c => c.p_key === true);
    const pkField = pkCol?.col_name || 'id';
    const pkValue = record[pkField];
    if (!pkValue && action !== 'INSERT') {
        throw new Error(`Primary key field "${pkField}" not found in record`);
    }

    const writableColumns = columns.filter(col => {
        if (col.gen === true) return false;
        if (col.p_key === true) return false;
        if (action !== 'INSERT' && col.editable === false) return false;
        return true;
    });

    if (action === 'INSERT') {
        const withValues = writableColumns.filter(col => record[col.col_name] !== null && record[col.col_name] !== undefined && record[col.col_name] !== '');
        const fields = withValues.map(col => `\`${col.col_name}\``).join(', ');
        const values = withValues.map(col => dtvFormatSqlValue(record[col.col_name], col)).join(', ');
        return `INSERT INTO \`${tableName}\` (${fields}) VALUES (${values})`;
    }
    if (action === 'UPDATE') {
        const updates = writableColumns
            .filter(col => record[col.col_name] !== undefined)
            .map(col => `\`${col.col_name}\` = ${dtvFormatSqlValue(record[col.col_name], col)}`)
            .join(', ');
        if (!updates) throw new Error('No columns to update');
        return `UPDATE \`${tableName}\` SET ${updates} WHERE \`${pkField}\` = ${dtvFormatSqlValue(pkValue, pkCol || { type: 'int' })}`;
    }
    if (action === 'DELETE') {
        return `DELETE FROM \`${tableName}\` WHERE \`${pkField}\` = ${dtvFormatSqlValue(pkValue, pkCol || { type: 'int' })}`;
    }
    throw new Error(`Unknown action: ${action}`);
}

function dtvValidateRecord(record, columns) {
    const errors = [];
    columns.forEach(col => {
        const value = record[col.col_name];
        const isEmpty = value === null || value === undefined || value === '';
        const displayName = col.col_label || dtvFormatColumnName(col.col_name);

        if (col.not_null && isEmpty) { errors.push(`"${displayName}" is required.`); return; }
        if (isEmpty) return;

        if (DTV_NUMERIC_TYPES.includes(col.type) && isNaN(parseFloat(value))) {
            errors.push(`"${displayName}" must be a number.`);
        }
        if (['datetime', 'timestamp', 'date'].includes(col.type) && isNaN(new Date(value).getTime())) {
            errors.push(`"${displayName}" must be a valid date${col.type === 'date' ? '' : '/time'}.`);
        }
        if (col.type === 'boolean' && typeof value !== 'boolean' && !['1', '0', 'true', 'false', 1, 0].includes(value)) {
            errors.push(`"${displayName}" must be true or false.`);
        }
    });
    return errors;
}

function dtvGetPkField() {
    return dtvColumnsAll.find(c => c.p_key === true)?.col_name ||
           dtvColumnsAll.find(c => c.gen === true)?.col_name || 'id';
}

// ---- Write dispatch (SQL Mode direct write + optional hook, or workflow) ----

// SQL verbs (used by dtvGenerateSQL) map to workflow-facing action labels -
// the engine has no built-in notion of CRUD verbs, this is purely a
// convention the workflow's own Jinja logic branches on. Matches the old
// Rewst Viewer's exact hardcoded values (payload.action = 'get'/'add'/
// 'edit'/'delete', all lowercase) rather than an invented convention,
// since every migrated Rewst-origin workflow already branches on those
// specific strings - using anything else silently breaks them (the
// workflow runs "successfully" but no branch matches, so it does nothing).
const DTV_ACTION_LABELS = { INSERT: 'add', UPDATE: 'edit', DELETE: 'delete' };

function dtvBuildWorkflowPayload(action, record) {
    // Flat, top-level fields - matches how submitFormViewer/collectFormValues
    // send form field values (Persephone's applyParamOverrides merges
    // `parameters` directly onto CTX; there's no `record` wrapper anywhere
    // else in the platform, so writes shouldn't invent one either).
    const payload = { form_info: dtvBuildFormInfo() };
    Object.entries(dtvDefinition.input_vars || {}).forEach(([key, value]) => {
        payload[key] = dtvSubstituteVariables(value);
    });
    Object.assign(payload, record);
    // action set last - a config can legitimately have its own input_var
    // or column literally named "action" (e.g. used for an unrelated
    // dataset-selector sub-purpose), which would otherwise silently
    // clobber the actual CRUD action this call represents.
    payload.action = DTV_ACTION_LABELS[action] || action;
    return payload;
}

async function dtvExecuteWrite(action, record) {
    if (dtvDefinition.sql_mode) {
        const query = dtvGenerateSQL(action, record, dtvColumnsAll, dtvDefinition.table_name);
        const result = await executeSqlQuery('cookie', null, dtvDefinition.sql_database, query);
        if (dtvDefinition.update_workflow) {
            // Optional post-write hook: fire and log, never block or fail
            // the primary write on its outcome.
            executeWorkflowForField(dtvDefinition.update_workflow, dtvBuildWorkflowPayload(action, record))
                .catch(err => console.error('[DTV] Post-write hook failed:', err));
        }
        return result;
    }

    if (!dtvDefinition.update_workflow) {
        throw new Error('No write method configured (SQL Mode or Add/Update/Delete Workflow)');
    }
    const result = await executeWorkflowForField(dtvDefinition.update_workflow, dtvBuildWorkflowPayload(action, record));
    if (!result.success) throw new Error(result.error || 'Workflow execution failed');
    return result;
}

// ---- Data load (initial fetch, SQL or workflow) ----

function dtvGetInputVarValue(varName) {
    if (dtvInputVarValues[varName] !== undefined && dtvInputVarValues[varName] !== '') {
        return dtvInputVarValues[varName];
    }
    const params = new URLSearchParams(window.location.search);
    const urlValue = params.get(varName);
    if (urlValue) return urlValue;
    const staticVal = (dtvDefinition.input_vars || {})[varName];
    if (staticVal !== undefined && staticVal !== '') return staticVal;
    return null;
}

function dtvSubstituteVariables(str) {
    if (typeof str !== 'string') return str;
    let result = str;
    const varPattern = /\[\[(\w+)\]\]/g;
    let match;
    while ((match = varPattern.exec(str)) !== null) {
        const varValue = dtvGetInputVarValue(match[1]);
        if (varValue) result = result.replace(match[0], varValue);
    }
    return result;
}

async function dtvLoadData() {
    try {
        dtvInputVarMessage.style.display = 'none';
        dtvTableBody.innerHTML = `<tr><td colspan="100" class="dtv-empty-note">Loading data...</td></tr>`;

        if (dtvDefinition.sql_mode) {
            const query = dtvSubstituteVariables(dtvDefinition.sql_query || '');
            if (!query.trim()) throw new Error('No SQL Query configured');
            const result = await executeSqlQuery('cookie', null, dtvDefinition.sql_database, query);
            dtvTableData = result?.result || [];
        } else {
            if (!dtvDefinition.data_workflow) throw new Error('No Data Workflow configured');
            const payload = { form_info: dtvBuildFormInfo() };
            Object.entries(dtvDefinition.input_vars || {}).forEach(([key, value]) => {
                payload[key] = dtvSubstituteVariables(value);
            });
            payload.action = 'get'; // set last - see dtvBuildWorkflowPayload for why
            const result = await executeWorkflowForField(dtvDefinition.data_workflow, payload);
            if (!result.success) throw new Error(result.error || 'Workflow execution failed');
            const outputData = dtvDefinition.output_var ? result.output?.[dtvDefinition.output_var] : null;
            dtvTableData = Array.isArray(outputData) ? outputData : [];
        }

        dtvFieldTypes = dtvDetectFieldTypes(dtvTableData);
        dtvFilterData(dtvSearchInput.value);
        dtvRenderTable();
    } catch (error) {
        console.error('[DTV] Load error:', error);
        dtvTableBody.innerHTML = `<tr><td colspan="100" class="dtv-empty-note" style="color:#ff6b6b;">Failed to load data: ${escapeHtml(error.message)}</td></tr>`;
    }
}

// ---- Input variable dropdowns (ordered cascade) ----

function dtvGetInputVarsOrdered() {
    return dtvDefinition.input_var_config || [];
}

async function dtvRenderInputVarDropdowns(fromIndex = 0) {
    const orderedVars = dtvGetInputVarsOrdered();

    if (fromIndex === 0) {
        dtvInputVarDropdowns.innerHTML = '';
    } else {
        orderedVars.slice(fromIndex).forEach(v => {
            const el = document.getElementById(`dtv_var_group_${v.name}`);
            if (el) el.remove();
            delete dtvInputVarValues[v.name];
        });
    }

    if (orderedVars.length === 0) {
        dtvInputVarContainer.style.display = 'none';
        await dtvLoadData();
        return;
    }

    const params = new URLSearchParams(window.location.search);

    for (let i = fromIndex; i < orderedVars.length; i++) {
        const varConfig = orderedVars[i];

        const urlValue = varConfig.from_url ? params.get(varConfig.name) : null;
        if (urlValue) { dtvInputVarValues[varConfig.name] = urlValue; continue; }

        const staticVal = (dtvDefinition.input_vars || {})[varConfig.name];
        if (!varConfig.from_dataset && staticVal !== undefined && staticVal !== '') {
            dtvInputVarValues[varConfig.name] = dtvSubstituteVariables(staticVal);
            continue;
        }

        if (varConfig.from_dataset) {
            await dtvRenderOneInputVarDropdown(varConfig, i);
        }
    }

    dtvInputVarContainer.style.display = dtvInputVarDropdowns.children.length > 0 ? 'block' : 'none';

    await dtvCheckAndLoadIfReady();
}

async function dtvRenderOneInputVarDropdown(varConfig, index) {
    const group = document.createElement('div');
    group.id = `dtv_var_group_${varConfig.name}`;

    const label = document.createElement('label');
    label.textContent = varConfig.dspl_name || varConfig.name;
    label.style.cssText = 'display:block; font-size:0.75rem; text-transform:uppercase; margin-bottom:4px; color: var(--text-muted, #999);';
    group.appendChild(label);

    const select = document.createElement('select');
    select.innerHTML = '<option value="">Loading...</option>';
    select.disabled = true;
    group.appendChild(select);

    dtvInputVarDropdowns.appendChild(group);

    try {
        let options = [];

        if (varConfig.dataset_source === 'mysql') {
            const query = dtvSubstituteVariables(varConfig.proxy_query || '');
            if (/\[\[\w+\]\]/.test(query)) {
                select.innerHTML = '<option value="">Waiting on prior selection...</option>';
                return;
            }
            const result = await executeSqlQuery('cookie', null, dtvDefinition.sql_database, query);
            options = result?.result || [];
        } else {
            const result = await executeWorkflowForField(varConfig.workflow, { ...dtvInputVarValues, form_info: dtvBuildFormInfo() });
            if (!result.success) throw new Error(result.error || 'Workflow failed');
            const raw = varConfig.workflow_output_var ? result.output?.[varConfig.workflow_output_var] : null;
            options = Array.isArray(raw) ? raw : [];
        }

        select.innerHTML = '<option value="">Select...</option>' +
            options.map(opt => `<option value="${escapeHtml(String(opt[varConfig.output_id]))}">${escapeHtml(String(opt[varConfig.output_label]))}</option>`).join('');
        select.disabled = false;

        select.addEventListener('change', async () => {
            dtvInputVarValues[varConfig.name] = select.value;
            await dtvRenderInputVarDropdowns(index + 1);
        });
    } catch (error) {
        console.error('[DTV] Failed to load dropdown for', varConfig.name, error);
        select.innerHTML = '<option>Error loading options</option>';
    }
}

async function dtvCheckAndLoadIfReady() {
    const orderedVars = dtvGetInputVarsOrdered();
    const allRequiredSatisfied = orderedVars.every(v => {
        if (!v.required) return true;
        const val = dtvGetInputVarValue(v.name);
        return val !== null && val !== '';
    });
    if (!allRequiredSatisfied) {
        dtvInputVarMessage.textContent = 'Select the required options above to retrieve data';
        dtvInputVarMessage.style.display = 'block';
        return;
    }
    dtvInputVarMessage.style.display = 'none';
    await dtvLoadData();
}

// ---- Filters, search, sort ----

function dtvRenderFilters() {
    dtvFiltersContainer.innerHTML = '';
    const filterConfigs = dtvDefinition.filters || [];
    if (filterConfigs.length === 0) return;

    filterConfigs.forEach((filterConfig, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'form-group--inline';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `dtv_filter_${idx}`;
        checkbox.checked = filterConfig.default_checked === true;
        dtvFilterStates[filterConfig.col_name] = checkbox.checked;

        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = filterConfig.display_label || dtvFormatColumnName(filterConfig.col_name);

        checkbox.addEventListener('change', () => {
            dtvFilterStates[filterConfig.col_name] = checkbox.checked;
            dtvFilterData(dtvSearchInput.value);
            dtvRenderTable();
        });

        wrap.appendChild(checkbox);
        wrap.appendChild(label);
        dtvFiltersContainer.appendChild(wrap);
    });
}

function dtvStripQuotes(str) {
    const trimmed = str.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0], last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}

function dtvParseCondition(value, conditionStr) {
    if (!conditionStr) return true;
    const notInMatch = conditionStr.match(/NOT IN \((.*?)\)/i);
    if (notInMatch) {
        const values = notInMatch[1].split(',').map(v => { const t = dtvStripQuotes(v); return isNaN(t) ? t : parseInt(t); });
        return !values.includes(value);
    }
    const inMatch = conditionStr.match(/IN \((.*?)\)/i);
    if (inMatch) {
        const values = inMatch[1].split(',').map(v => { const t = dtvStripQuotes(v); return isNaN(t) ? t : parseInt(t); });
        return values.includes(value);
    }
    const notEqMatch = conditionStr.match(/^!=\s*(.+)$/);
    if (notEqMatch) { const c = dtvStripQuotes(notEqMatch[1]); return value != (isNaN(c) ? c : parseInt(c)); }
    const eqMatch = conditionStr.match(/^=\s*(.+)$/);
    if (eqMatch) { const c = dtvStripQuotes(eqMatch[1]); return value == (isNaN(c) ? c : parseInt(c)); }
    const gtMatch = conditionStr.match(/^>\s*(.+)$/);
    if (gtMatch) { const c = dtvStripQuotes(gtMatch[1]); return value > (isNaN(c) ? c : parseInt(c)); }
    const ltMatch = conditionStr.match(/^<\s*(.+)$/);
    if (ltMatch) { const c = dtvStripQuotes(ltMatch[1]); return value < (isNaN(c) ? c : parseInt(c)); }
    return true;
}

function dtvFilterData(query) {
    const searchTerm = (query || '').toLowerCase();
    dtvFilteredData = dtvTableData.filter(item => {
        if (searchTerm) {
            const matches = dtvColsTable.some(col => String(item[col] ?? '').toLowerCase().includes(searchTerm));
            if (!matches) return false;
        }
        for (const [colName, isChecked] of Object.entries(dtvFilterStates)) {
            const filterConfig = (dtvDefinition.filters || []).find(f => f.col_name === colName);
            if (!filterConfig) continue;
            const columnValue = item[colName];
            if (filterConfig.condition) {
                if (isChecked && !dtvParseCondition(columnValue, filterConfig.condition)) return false;
            } else if (!isChecked && dtvParseBoolean(columnValue)) {
                return false;
            }
        }
        return true;
    });
}

function dtvBuildTableHead() {
    const headerRow = document.createElement('tr');
    dtvColsTable.forEach(colName => {
        const th = document.createElement('th');
        const colConfig = dtvColumnsAll.find(c => c.col_name === colName) || {};
        th.textContent = colConfig.col_label || dtvFormatColumnName(colName);
        th.className = 'sortable';
        th.dataset.column = colName;
        th.addEventListener('click', () => dtvSortTable(colName));
        headerRow.appendChild(th);
    });
    if (dtvDefinition.edit_type === 'column') {
        const th = document.createElement('th');
        th.textContent = 'Actions';
        th.style.cursor = 'default';
        if (!dtvCanEdit && !dtvCanDelete) th.style.display = 'none';
        headerRow.appendChild(th);
    }
    dtvTableHead.innerHTML = '';
    dtvTableHead.appendChild(headerRow);
}

function dtvSortTable(column) {
    if (dtvCurrentSort.column === column) {
        dtvCurrentSort.direction = dtvCurrentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        dtvCurrentSort.column = column;
        dtvCurrentSort.direction = 'asc';
    }
    dtvFilteredData.sort((a, b) => {
        let av = a[column], bv = b[column];
        if (typeof av === 'number' && typeof bv === 'number') {
            return dtvCurrentSort.direction === 'asc' ? av - bv : bv - av;
        }
        av = String(av ?? '').toLowerCase();
        bv = String(bv ?? '').toLowerCase();
        if (av < bv) return dtvCurrentSort.direction === 'asc' ? -1 : 1;
        if (av > bv) return dtvCurrentSort.direction === 'asc' ? 1 : -1;
        return 0;
    });
    dtvRenderTable();
    document.querySelectorAll('#dataTable th.sortable').forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
    const activeTh = document.querySelector(`#dataTable th[data-column="${column}"]`);
    if (activeTh) activeTh.classList.add(dtvCurrentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
}

// ---- Table body rendering (window mode + inline/column mode) ----

function dtvBuildInlineInput(colConfig, value) {
    let input;
    if (colConfig.map || colConfig.map_type) {
        input = document.createElement('select');
        input.innerHTML = '<option value="">-- Select --</option>' +
            Object.entries(dtvColumnMappings[colConfig.col_name] || {}).map(([id, label]) =>
                `<option value="${escapeHtml(id)}" ${String(id) === String(value) ? 'selected' : ''}>${escapeHtml(String(label))}</option>`).join('');
    } else if (colConfig.type === 'boolean') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = dtvParseBoolean(value);
    } else if (colConfig.type === 'datetime' || colConfig.type === 'timestamp') {
        input = document.createElement('input');
        input.type = 'datetime-local';
        if (value) { const d = new Date(value); if (!isNaN(d.getTime())) input.value = d.toISOString().slice(0, 16); }
    } else if (colConfig.type === 'date') {
        input = document.createElement('input');
        input.type = 'date';
        if (value) { const d = new Date(value); if (!isNaN(d.getTime())) input.value = d.toISOString().slice(0, 10); }
    } else if (DTV_NUMERIC_TYPES.includes(colConfig.type)) {
        input = document.createElement('input');
        input.type = 'number';
        input.value = value ?? '';
    } else if (colConfig.type === 'enum' && colConfig.enum_values) {
        input = document.createElement('select');
        input.innerHTML = '<option value="">-- Select --</option>' +
            colConfig.enum_values.split(',').map(v => v.trim()).filter(Boolean)
                .map(v => `<option value="${escapeHtml(v)}" ${v === String(value) ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
    } else if (DTV_TEXTAREA_TYPES.includes(colConfig.type)) {
        input = document.createElement('textarea');
        input.rows = 4;
        input.value = value ?? '';
    } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = value ?? '';
    }
    return input;
}

function dtvReadInlineValue(input, colConfig) {
    if (input.type === 'checkbox') return input.checked;
    if (colConfig && DTV_NUMERIC_TYPES.includes(colConfig.type)) {
        return input.value === '' ? null : parseFloat(input.value);
    }
    return input.value;
}

function dtvRenderTable() {
    dtvTableBody.innerHTML = '';
    dtvRecordsCount.textContent = dtvFilteredData.length === dtvTableData.length
        ? `Found ${dtvFilteredData.length} Record${dtvFilteredData.length !== 1 ? 's' : ''}`
        : `Showing ${dtvFilteredData.length} of ${dtvTableData.length} Records`;

    if (dtvFilteredData.length === 0) {
        const tr = document.createElement('tr');
        const colCount = dtvColsTable.length + (dtvDefinition.edit_type === 'column' ? 1 : 0);
        tr.innerHTML = `<td colspan="${colCount}" class="dtv-empty-note">No records found</td>`;
        dtvTableBody.appendChild(tr);
        return;
    }

    dtvFilteredData.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.dataset.rowIndex = index;
        tr.dataset.originalData = JSON.stringify({ ...row });

        dtvColsTable.forEach(colName => {
            const td = document.createElement('td');
            const colConfig = dtvColumnsAll.find(c => c.col_name === colName) || {};
            const value = row[colName];

            if (dtvDefinition.edit_type === 'column') {
                td.classList.add('dtv-inline-edit-cell');
                const isEditable = colConfig.editable !== false && dtvCanEdit;
                if (isEditable) {
                    const input = dtvBuildInlineInput(colConfig, value);
                    input.addEventListener('change', () => {
                        row[colName] = dtvReadInlineValue(input, colConfig);
                        tr.dataset.modified = 'true';
                    });
                    td.appendChild(input);
                } else {
                    const displayVal = dtvDisplayValue(colConfig, value);
                    td.textContent = displayVal;
                    if (displayVal) td.title = displayVal;
                }
            } else {
                const displayVal = dtvDisplayValue(colConfig, value);
                td.textContent = displayVal;
                if (displayVal) td.title = displayVal;
            }
            tr.appendChild(td);
        });

        if (dtvDefinition.edit_type === 'column') {
            const actionsTd = document.createElement('td');
            if (!dtvCanEdit && !dtvCanDelete) actionsTd.style.display = 'none';
            const controls = document.createElement('div');
            controls.className = 'dtv-row-controls';
            if (dtvCanEdit) {
                const resetBtn = document.createElement('button');
                resetBtn.className = 'btn';
                resetBtn.dataset.color = 'grey';
                resetBtn.dataset.size = 'sm';
                resetBtn.textContent = 'Reset';
                resetBtn.addEventListener('click', () => dtvResetRow(index));
                controls.appendChild(resetBtn);
            }
            if (dtvCanDelete) {
                const delBtn = document.createElement('button');
                delBtn.className = 'btn';
                delBtn.dataset.color = 'red';
                delBtn.dataset.size = 'sm';
                delBtn.textContent = 'Delete';
                delBtn.addEventListener('click', () => dtvDeleteRow(index));
                controls.appendChild(delBtn);
            }
            actionsTd.appendChild(controls);
            tr.appendChild(actionsTd);
        } else {
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', () => dtvOpenEditModal(index));
        }

        dtvTableBody.appendChild(tr);
    });
}

function dtvResetRow(index) {
    const tr = dtvTableBody.querySelector(`tr[data-row-index="${index}"]`);
    if (!tr) return;
    const original = JSON.parse(tr.dataset.originalData);
    Object.assign(dtvFilteredData[index], original);
    dtvRenderTable();
}

// ---- Delete ----

async function dtvDeleteRow(index) {
    const record = dtvFilteredData[index];
    showDeleteConfirm('Are you sure you want to delete this record? This action cannot be undone.', async () => {
        try {
            await dtvExecuteWrite('DELETE', record);
            const pkField = dtvGetPkField();
            dtvTableData = dtvTableData.filter(r => r[pkField] !== record[pkField]);
            dtvFilterData(dtvSearchInput.value);
            dtvRenderTable();
            showStatusBanner('Record deleted successfully.', 'success');
        } catch (error) {
            console.error('[DTV] Delete error:', error);
            showStatusBanner(`Error deleting record: ${error.message}`, 'error');
        }
    });
}

// ---- Window-mode Edit modal ----

// Ported from the old Viewer: more fields on screen at once -> more grid
// columns, so a 20-field table doesn't render as one long single column.
function dtvGetEditGridColumns(fieldCount) {
    if (fieldCount < 4) return 1;
    if (fieldCount < 8) return 2;
    if (fieldCount < 12) return 3;
    return 4;
}

function dtvOpenEditModal(index) {
    const record = dtvFilteredData[index];

    const editableFields = dtvColsEdit.filter(c => c.editable !== false && dtvCanEdit);
    const nonEditableFields = dtvColsEdit.filter(c => c.editable === false || !dtvCanEdit);

    // Ported from the old Viewer: more fields -> more columns, and both
    // grids use the larger of the two counts so their columns line up.
    const gridColumns = Math.max(
        dtvGetEditGridColumns(nonEditableFields.length),
        dtvGetEditGridColumns(editableFields.length)
    );
    const gridColumnsCss = `repeat(${gridColumns}, 1fr)`;
    const modalWidth = gridColumns === 1 ? '500px' : gridColumns === 2 ? '850px' : '1200px';

    const content = document.createElement('div');
    content.style.cssText = 'display: flex; flex-direction: column; gap: 14px;';

    if (nonEditableFields.length > 0) {
        const grid = document.createElement('div');
        grid.style.cssText = `display: grid; grid-template-columns: ${gridColumnsCss}; gap: 10px;`;
        nonEditableFields.forEach(col => {
            const div = document.createElement('div');
            if (col.span === true) div.style.gridColumn = '1 / -1';
            div.innerHTML = `<label style="display:block; font-size:0.7rem; text-transform:uppercase; color:var(--text-muted,#999); margin-bottom:2px;">${escapeHtml(col.col_label || dtvFormatColumnName(col.col_name))}</label><div>${escapeHtml(dtvDisplayValue(col, record[col.col_name]))}</div>`;
            grid.appendChild(div);
        });
        content.appendChild(grid);
    }

    const editGrid = document.createElement('div');
    editGrid.style.cssText = `display: grid; grid-template-columns: ${gridColumnsCss}; gap: 10px;`;
    editableFields.forEach(col => {
        const wrap = document.createElement('div');
        wrap.className = 'form-group';
        if (col.span === true) wrap.style.gridColumn = '1 / -1';
        const label = document.createElement('label');
        label.textContent = col.col_label || dtvFormatColumnName(col.col_name);
        wrap.appendChild(label);
        const input = dtvBuildInlineInput(col, record[col.col_name]);
        input.dataset.column = col.col_name;
        input.classList.add('dtv-edit-field');
        wrap.appendChild(input);
        editGrid.appendChild(wrap);
    });
    content.appendChild(editGrid);

    const buttons = [];
    if (dtvCanDelete) {
        buttons.push({
            label: 'Delete', type: 'danger', onClick: () => {
                closeModal();
                dtvDeleteRow(index);
                return false;
            }
        });
    }
    buttons.push({ label: 'Cancel', type: 'secondary' });
    if (dtvCanEdit) {
        buttons.push({ label: 'Save Changes', type: 'success', onClick: () => dtvSaveEditModal(content, record) });
    }

    showModal({
        title: dtvCanEdit ? 'Edit Record' : 'Record Details',
        content,
        resizable: true,
        closeOnBackdrop: false,
        height: 'auto',
        width: modalWidth,
        buttons
    });
}

async function dtvSaveEditModal(content, record) {
    const updated = { ...record };
    content.querySelectorAll('.dtv-edit-field').forEach(input => {
        const colName = input.dataset.column;
        const colConfig = dtvColumnsAll.find(c => c.col_name === colName);
        updated[colName] = dtvReadInlineValue(input, colConfig);
    });

    const errors = dtvValidateRecord(updated, dtvColsEdit);
    if (errors.length > 0) {
        showStatusBanner(errors.join(' '), 'error');
        return false;
    }

    try {
        await dtvExecuteWrite('UPDATE', updated);
        Object.assign(record, updated);
        dtvRenderTable();
        showStatusBanner('Record updated successfully.', 'success');
    } catch (error) {
        console.error('[DTV] Update error:', error);
        showStatusBanner(`Error updating record: ${error.message}`, 'error');
        return false;
    }
}

// ---- Add modal ----

// The old Viewer used a coarser threshold for the Add form specifically
// (fewer fields shown at once, since generated/PK columns are excluded).
function dtvGetAddGridColumns(fieldCount) {
    if (fieldCount > 10) return 3;
    if (fieldCount > 5) return 2;
    return 1;
}

function dtvOpenAddModal() {
    const fields = dtvColumnsAll.filter(c => !c.p_key && !c.gen);
    const gridColumns = dtvGetAddGridColumns(fields.length);
    const modalWidth = gridColumns === 1 ? '500px' : gridColumns === 2 ? '850px' : '1200px';

    const content = document.createElement('div');
    content.style.cssText = 'display: flex; flex-direction: column; gap: 14px;';

    const grid = document.createElement('div');
    grid.style.cssText = `display: grid; grid-template-columns: repeat(${gridColumns}, 1fr); gap: 10px;`;
    fields.forEach(col => {
        const wrap = document.createElement('div');
        wrap.className = 'form-group';
        if (col.span === true) wrap.style.gridColumn = '1 / -1';
        const label = document.createElement('label');
        label.textContent = col.col_label || dtvFormatColumnName(col.col_name);
        wrap.appendChild(label);
        const input = dtvBuildInlineInput(col, '');
        input.dataset.column = col.col_name;
        input.classList.add('dtv-add-field');
        wrap.appendChild(input);
        grid.appendChild(wrap);
    });
    content.appendChild(grid);

    showModal({
        title: 'Add New Record',
        content,
        resizable: true,
        closeOnBackdrop: false,
        height: 'auto',
        width: modalWidth,
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            { label: 'Add Record', type: 'success', onClick: () => dtvSaveAddModal(content) }
        ]
    });
}

async function dtvSaveAddModal(content) {
    const newRecord = {};
    content.querySelectorAll('.dtv-add-field').forEach(input => {
        const colName = input.dataset.column;
        const colConfig = dtvColumnsAll.find(c => c.col_name === colName);
        newRecord[colName] = dtvReadInlineValue(input, colConfig);
    });

    const errors = dtvValidateRecord(newRecord, dtvColumnsAll.filter(c => !c.p_key && !c.gen));
    if (errors.length > 0) {
        showStatusBanner(errors.join(' '), 'error');
        return false;
    }

    try {
        await dtvExecuteWrite('INSERT', newRecord);
        await dtvLoadData(); // Re-fetch so generated PK/defaults come back correctly
        showStatusBanner('Record added successfully.', 'success');
    } catch (error) {
        console.error('[DTV] Insert error:', error);
        showStatusBanner(`Error adding record: ${error.message}`, 'error');
        return false;
    }
}

// ---- Save All (inline/column mode batch save) ----

async function dtvSaveAllChanges() {
    const modifiedRows = [];
    dtvTableBody.querySelectorAll('tr[data-modified="true"]').forEach(tr => {
        const idx = parseInt(tr.dataset.rowIndex);
        modifiedRows.push({ index: idx, record: dtvFilteredData[idx] });
    });

    if (modifiedRows.length === 0) {
        showStatusBanner('No changes to save.', 'info');
        return;
    }

    let allErrors = [];
    modifiedRows.forEach(({ record }) => {
        allErrors = allErrors.concat(dtvValidateRecord(record, dtvColsEdit));
    });
    if (allErrors.length > 0) {
        showStatusBanner(allErrors.join(' '), 'error');
        return;
    }

    showConfirm('Save Changes', `Save changes to ${modifiedRows.length} record(s)?`, async () => {
        dtvSaveAllBtn.disabled = true;
        dtvSaveAllBtn.textContent = 'Saving...';
        try {
            for (const { record } of modifiedRows) {
                await dtvExecuteWrite('UPDATE', record);
            }
            dtvTableBody.querySelectorAll('tr[data-modified="true"]').forEach(tr => { tr.dataset.modified = 'false'; });
            showStatusBanner(`${modifiedRows.length} record(s) saved.`, 'success');
        } catch (error) {
            console.error('[DTV] Batch save error:', error);
            showStatusBanner(`Error saving changes: ${error.message}`, 'error');
        } finally {
            dtvSaveAllBtn.disabled = false;
            dtvSaveAllBtn.textContent = 'Save Changes';
        }
    }, 'Save');
}

window.initializeDatatableViewer = initializeDatatableViewer;