// ============================================================================
// Workflow Library - Workflow CRUD operations and UI management
// ============================================================================

let workflows = [];
let workflows_folders = [];
let currentCreateModal = null;
let currentSort = { column: 'updated_at', ascending: false };
let currentSelectedFolder = null;  // Track which folder is currently selected
let filters = {
    name: '',
    version: '',
    lastModified: '',
    modifiedBy: '',
    active: ''
};

/**
 * Generate a UUID v4
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Generic save workflow to backend
 * @param {string} id - Workflow ID
 * @param {object} workflowData - {name, version, definition}
 * @param {object} options - {incrementVersion, updateMetadata, onSuccess, onError}
 */
async function saveWorkflow(id, workflowData, options = {}) {
    const {
        incrementVersion = true,
        updateMetadata = true,
        onSuccess = null,
        onError = null
    } = options;

    try {
        if (!sessionToken) {
            throw new Error('Not authenticated');
        }

        const { name, version, definition, folder_id = null } = workflowData;

        if (!name || !version || !definition) {
            throw new Error('name, version, and definition are required');
        }

        // Update metadata if requested
        let definitionToSave = { ...definition };
        if (updateMetadata) {
            const now = new Date().toISOString();
            definitionToSave.metadata = {
                ...(definition.metadata || {}),
                updated_at: now,
                updated_by: getUser()
            };
        }

        // Build payload
        const payload = {
            name,
            version,
            definition: definitionToSave,
            folder_id: folder_id || null
        };

        const response = await fetch(`https://app.equinoxits.com:1139/kore/workflows/${id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        if (onSuccess) {
            onSuccess(result);
        }

        return result;
    } catch (error) {
        console.error('Error saving workflow:', error);
        if (onError) {
            onError(error);
        } else {
            alert('Error saving workflow: ' + error.message);
        }
        throw error;
    }
}

/**
 * Load all workflows from backend
 */
async function loadWorkflows() {
    if (!sessionToken) {
        console.error('No session token available');
        return;
    }

    try {
        const loadingSpinner = document.getElementById('loadingSpinner');
        if (loadingSpinner) {
            loadingSpinner.classList.add('show');
            loadingSpinner.style.display = 'block';
        }

        const response = await fetch('https://app.equinoxits.com:1139/kore/workflows', {
            method: 'GET',
            headers: { 
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        workflows = data.workflows || [];
        console.log('Workflows loaded:', workflows.map(w => ({ id: w.id, name: w.name, folder_id: w.folder_id })));
        // Reload folders - this will trigger re-rendering
        await loadWorkflowFolders();
        
        // If a folder was selected, reapply the filter
        if (currentSelectedFolder) {
            onFolderSelected(currentSelectedFolder);
        }
        
        if (loadingSpinner) {
            loadingSpinner.classList.remove('show');
            loadingSpinner.style.display = 'none';
        }

        return workflows;
    } catch (error) {
        console.error('Error loading workflows:', error);
        const loadingSpinner = document.getElementById('loadingSpinner');
        if (loadingSpinner) {
            loadingSpinner.textContent = 'Error loading workflows';
            loadingSpinner.classList.remove('show');
            loadingSpinner.style.display = 'block';
        }
        return [];
    }
}

/**
 * Ensure kore-lib.js is loaded before using tree functions
 */
function ensureKoreLibLoaded() {
    return new Promise((resolve) => {
        // Check if kore-lib functions exist
        if (typeof renderTree === 'function' && typeof createTreeNode === 'function') {
            resolve();
            return;
        }
        
        // Check if script is already loading
        const existingScript = document.querySelector('script[src*="kore-lib"]');
        if (existingScript) {
            existingScript.onload = resolve;
            return;
        }
        
        // Load kore-lib.js
        const script = document.createElement('script');
        script.src = 'lib/kore-lib.js';
        script.onload = resolve;
        script.onerror = () => {
            console.error('Failed to load kore-lib.js');
            resolve();
        };
        document.head.appendChild(script);
    });
}

/**
 * Load workflow folders
 */
async function loadWorkflowFolders() {
    if (!sessionToken) {
        console.error('No session token available');
        return [];
    }

    try {
        const response = await fetch('https://app.equinoxits.com:1139/kore/workflow-folders', {
            method: 'GET',
            headers: { 
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const folders = data.folders || [];
        workflows_folders = folders;
        await ensureKoreLibLoaded();
        renderFolderTree(folders);
        return folders;
    } catch (error) {
        console.error('Error loading workflow folders:', error);
        return [];
    }
}

/**
 * Create a new workflow folder
 */
async function createNewWorkflowFolder(folderName, parentId = null) {
    if (!sessionToken) {
        showModal({
            type: 'error',
            title: 'Error',
            content: 'No session token available'
        });
        return;
    }

    try {
        const folderId = generateUUID();
        const payload = {
            id: folderId,
            name: folderName,
            parent_id: parentId
        };

        const response = await fetch('https://app.equinoxits.com:1139/kore/workflow-folders', {
            method: 'POST',
            headers: {
                'X-Session-Token': sessionToken,
                'X-User': getUser(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        await loadWorkflowFolders();
        showModal({
            type: 'success',
            title: 'Success',
            content: 'Folder created successfully',
            autoClose: 2000
        });
    } catch (error) {
        console.error('Error creating workflow folder:', error);
        showModal({
            type: 'error',
            title: 'Error',
            content: `Error creating folder: ${error.message}`
        });
    }
}

/**
 * Render folders tree using modularized function from kore-lib
 */
function renderFolderTree(folders) {
    const foldersList = document.getElementById('foldersList');
    if (!foldersList) return;
    
    foldersList.innerHTML = '';

    // Create "All" item with italics
    const allItem = document.createElement('div');
    allItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; margin-bottom: -6px; display: flex; align-items: center; padding-left: 10px;';
    allItem.setAttribute('data-item-id', 'all');
    const allText = document.createElement('span');
    allText.textContent = 'All';
    allText.style.fontStyle = 'italic';
    allText.style.color = '#ffffff';
    allItem.appendChild(allText);
    allItem.onmouseenter = () => {
        if (!allItem.classList.contains('selected')) {
            allItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
        }
    };
    allItem.onmouseleave = () => {
        if (!allItem.classList.contains('selected')) {
            allItem.style.backgroundColor = '';
        }
    };
    allItem.onclick = () => {
        // Remove selected from all items
        foldersList.querySelectorAll('[data-item-id]').forEach(el => {
            el.classList.remove('selected');
            el.style.backgroundColor = '';
        });
        // Select this item
        allItem.classList.add('selected');
        allItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
        onFolderSelected({ id: 'all', name: 'All' });
    };
    foldersList.appendChild(allItem);

    // Add horizontal line below All
    const lineAfterAll = document.createElement('div');
    lineAfterAll.style.cssText = 'height: 1px; background: #556870; margin: 4px 0;';
    foldersList.appendChild(lineAfterAll);

    // Render the actual folder tree (only the generated folders, not All or No Folder)
    const treeContainer = document.createElement('div');
    renderTree(folders, treeContainer, {
        onItemClick: (folder) => {
            // Remove selected from All and No Folder items only
            allItem.classList.remove('selected');
            allItem.style.backgroundColor = '';
            noFolderItem.classList.remove('selected');
            noFolderItem.style.backgroundColor = '';
            // Tree items will handle their own selection via the tree renderer
            onFolderSelected(folder);
        }
    });
    foldersList.appendChild(treeContainer);

    // Add horizontal line above No Folder
    const lineBeforeNoFolder = document.createElement('div');
    lineBeforeNoFolder.style.cssText = 'height: 1px; background: #556870; margin: 4px 0;';
    foldersList.appendChild(lineBeforeNoFolder);

    // Create "No Folder" item with italics
    const noFolderItem = document.createElement('div');
    noFolderItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px;';
    noFolderItem.setAttribute('data-item-id', 'no_folder');
    const noFolderText = document.createElement('span');
    noFolderText.textContent = 'No Folder';
    noFolderText.style.fontStyle = 'italic';
    noFolderText.style.color = '#ffffff';
    noFolderItem.appendChild(noFolderText);
    noFolderItem.onmouseenter = () => {
        if (!noFolderItem.classList.contains('selected')) {
            noFolderItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
        }
    };
    noFolderItem.onmouseleave = () => {
        if (!noFolderItem.classList.contains('selected')) {
            noFolderItem.style.backgroundColor = '';
        }
    };
    noFolderItem.onclick = () => {
        // Remove selected from all items
        foldersList.querySelectorAll('[data-item-id]').forEach(el => {
            el.classList.remove('selected');
            el.style.backgroundColor = '';
        });
        // Select this item
        noFolderItem.classList.add('selected');
        noFolderItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
        onFolderSelected({ id: 'no_folder', name: 'No Folder' });
    };
    foldersList.appendChild(noFolderItem);
    
    // Auto-select "All" folder by default if no folder is currently selected
    if (!currentSelectedFolder) {
        allItem.classList.add('selected');
        allItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
        onFolderSelected({ id: 'all', name: 'All' });
    }
}

/**
 * Handle folder selection - filter workflows by folder_id
 */
function onFolderSelected(folder) {
    console.log('Folder selected:', folder);
    currentSelectedFolder = folder;  // Track the selected folder
    let filteredWorkflows = [];
    
    if (folder.id === 'all') {
        // Show all workflows regardless of folder_id
        filteredWorkflows = workflows;
    } else if (folder.id === 'no_folder') {
        // Show only workflows with null or empty folder_id
        filteredWorkflows = workflows.filter(wf => !wf.folder_id);
    } else {
        // Show workflows in selected folder
        filteredWorkflows = workflows.filter(wf => wf.folder_id === folder.id);
    }
    
    console.log('Filtered workflows:', filteredWorkflows);
    
    // Render the filtered workflows
    renderFilteredWorkflows(filteredWorkflows);
    
    // Enable/disable move and delete buttons based on folder selection
    const moveBtn = document.getElementById('moveFolderBtn');
    const deleteBtn = document.getElementById('deleteFolderBtn');
    if (folder.id === 'all' || folder.id === 'no_folder') {
        moveBtn.disabled = true;
        moveBtn.style.opacity = '0.5';
        moveBtn.style.cursor = 'not-allowed';
        deleteBtn.disabled = true;
        deleteBtn.style.opacity = '0.5';
        deleteBtn.style.cursor = 'not-allowed';
    } else {
        moveBtn.disabled = false;
        moveBtn.style.opacity = '1';
        moveBtn.style.cursor = 'pointer';
        deleteBtn.disabled = false;
        deleteBtn.style.opacity = '1';
        deleteBtn.style.cursor = 'pointer';
    }
}

/**
 * Show workflow context menu
 */
function showWorkflowMenu(event, workflowId) {
    event.stopPropagation();
    
    // Remove any existing menus
    const existingMenu = document.getElementById('workflowContextMenu');
    if (existingMenu) {
        existingMenu.remove();
    }
    
    // Create menu
    const menu = document.createElement('div');
    menu.id = 'workflowContextMenu';
    menu.style.cssText = `
        position: fixed;
        background: #234656;
        border: 1px solid #556870; border-radius: 0;
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        z-index: 1000;
        min-width: 180px;
    `;
    
    const workflow = workflows.find(w => w.id === workflowId);
    const activeValue = workflow?.definition?.active;
    const toggleButtonText = activeValue === false ? 'Enable' : 'Disable';
    
    menu.innerHTML = `
        <div style="padding: 4px;">
            <button onclick="toggleWorkflowActive('${workflowId}'); document.getElementById('workflowContextMenu').remove();" style="display: block; width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: #c0c0c0; cursor: pointer; font-size: 0.9rem;">
                ${toggleButtonText}
            </button>
            <button onclick="moveWorkflowToFolder('${workflowId}'); document.getElementById('workflowContextMenu').remove();" style="display: block; width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: #c0c0c0; cursor: pointer; font-size: 0.9rem;">
                Move to Folder
            </button>
            <button onclick="deleteWorkflow('${workflowId}'); document.getElementById('workflowContextMenu').remove();" style="display: block; width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: #ff6b6b; cursor: pointer; font-size: 0.9rem;">
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
 * Close current modal
 */

/**
 * Move workflow to folder (show modal for folder selection)
 */
function moveWorkflowToFolder(workflowId) {
    const workflow = workflows.find(w => w.id === workflowId);
    if (!workflow) return;
    
    // Store the current folder for pre-selection
    window.workflowBeingMoved = {
        id: workflowId,
        currentFolderId: workflow.folder_id
    };
    
    showModal({
        type: 'custom',
        title: 'Move Workflow to Folder',
        content: `
            <div>
                <p style="margin: 0 0 10px 0; color: #c0c0c0; font-size: 0.9rem;">Select a folder for: <strong>${workflow.name}</strong></p>
                <div id="moveToFolderTree" style="background: #1a3540; border: 1px solid #556870; border-radius: 4px; padding: 8px 8px 13px 8px; height: auto; overflow: visible; margin-bottom: 15px;"></div>
            </div>
        `,
        buttons: [
            {
                label: 'Cancel',
                className: 'btn-small',
                callback: ({ close }) => close()
            },
            {
                label: 'Move',
                className: 'btn-blue btn-small',
                callback: ({ close }) => {
                    confirmMoveWorkflow(workflowId);
                    close();
                }
            }
        ],
        customWidth: '500px',
        customMinWidth: '300px'
    });
    
    // Render the folder tree in the modal with No Folder option (no All)
    const treeContainer = document.getElementById('moveToFolderTree');
    if (treeContainer) {
        treeContainer.innerHTML = '';
        
        // Render the actual folder tree
        const treeDiv = document.createElement('div');
        renderTree(workflows_folders || [], treeDiv, {
            onItemClick: (folder) => {
                window.selectedFolderForMove = folder.id;
                // Clear No Folder selection
                noFolderItem.classList.remove('selected');
                noFolderItem.style.backgroundColor = '';
                // Clear other tree items - this is handled by kore-lib
                document.querySelectorAll(`[data-item-id]:not([data-item-id="${folder.id}"])`).forEach(el => {
                    if (el.getAttribute('data-item-id') !== 'no_folder') {
                        el.classList.remove('selected');
                    }
                });
                // Find and highlight the selected folder row in the tree
                const selectedEl = document.querySelector(`[data-item-id="${folder.id}"]`);
                if (selectedEl) {
                    selectedEl.classList.add('selected');
                    selectedEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                    selectedEl.setAttribute('data-folder-id', folder.id);
                }
            }
        });
        treeContainer.appendChild(treeDiv);
        
        // Create "No Folder" item
        const noFolderItem = document.createElement('div');
        noFolderItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px;';
        noFolderItem.setAttribute('data-folder-id', 'no_folder');
        const noFolderText = document.createElement('span');
        noFolderText.textContent = 'No Folder';
        noFolderText.style.fontStyle = 'italic';
        noFolderText.style.color = '#ffffff';
        noFolderItem.appendChild(noFolderText);
        noFolderItem.onmouseenter = () => {
            if (!noFolderItem.classList.contains('selected')) {
                noFolderItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
            }
        };
        noFolderItem.onmouseleave = () => {
            if (!noFolderItem.classList.contains('selected')) {
                noFolderItem.style.backgroundColor = '';
            }
        };
        noFolderItem.onclick = () => {
            // Clear tree item selections
            document.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
                el.style.marginTop = '';
                el.style.marginBottom = '';
            });
            // Select No Folder
            noFolderItem.classList.add('selected');
            noFolderItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.selectedFolderForMove = 'no_folder';
        };
        treeContainer.appendChild(noFolderItem);
        
        // Pre-select the current folder
        if (workflow.folder_id) {
            // Wait longer for tree to fully render
            setTimeout(() => {
                console.log('Looking for folder:', workflow.folder_id);
                // Search within the move modal tree specifically
                let currentFolderEl = treeContainer.querySelector(`[data-item-id="${workflow.folder_id}"]`);
                console.log('Found folder element:', currentFolderEl ? 'yes' : 'no');
                
                if (currentFolderEl) {
                    // If folder is not visible in the viewport or is hidden, expand ancestors
                    if (!currentFolderEl.offsetParent) {
                        console.log('Folder is hidden, need to expand ancestors');
                        let expandedAny = false;
                        
                        // Start from the folder and walk up to find hidden containers
                        let node = currentFolderEl.parentElement; // Level 0: the direct parent div
                        
                        while (node && node !== treeContainer) {
                            // Check if this is a hidden children container
                            if (node.style.display === 'none') {
                                console.log('Found hidden container, looking for toggle');
                                // The toggle should be in the previous sibling (folderRow)
                                const prevSibling = node.previousElementSibling;
                                if (prevSibling) {
                                    const toggleBtn = prevSibling.querySelector('span');
                                    if (toggleBtn && toggleBtn.textContent === '+') {
                                        console.log('Clicking toggle to expand');
                                        toggleBtn.click();
                                        expandedAny = true;
                                    }
                                }
                            }
                            node = node.parentElement;
                        }
                        
                        // Wait for expansions to complete
                        setTimeout(() => {
                            currentFolderEl.classList.add('selected');
                            currentFolderEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                            window.selectedFolderForMove = workflow.folder_id;
                            currentFolderEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            console.log('Selected folder');
                        }, 150);
                    } else {
                        // Folder is already visible, just select it
                        console.log('Folder already visible');
                        currentFolderEl.classList.add('selected');
                        currentFolderEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                        window.selectedFolderForMove = workflow.folder_id;
                        currentFolderEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                }
            }, 150);
        } else {
            // No folder assigned, select "No Folder"
            noFolderItem.classList.add('selected');
            noFolderItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.selectedFolderForMove = 'no_folder';
        }
    }
}

/**
 * Move the currently selected folder to a new parent
 */
async function moveSelectedFolder() {
    if (!currentSelectedFolder || currentSelectedFolder.id === 'all' || currentSelectedFolder.id === 'no_folder') {
        return;
    }
    
    const folderId = currentSelectedFolder.id;
    const folderName = currentSelectedFolder.name;
    
    showModal({
        type: 'custom',
        title: 'Move Folder',
        content: `
            <div>
                <p style="margin: 0 0 10px 0; color: #c0c0c0; font-size: 0.9rem;">Select a parent folder for: <strong>${folderName}</strong></p>
                <div id="moveFolderTree" style="background: #1a3540; border: 1px solid #556870; border-radius: 4px; padding: 8px 8px 13px 8px; height: auto; overflow: visible; margin-bottom: 15px;"></div>
            </div>
        `,
        buttons: [
            {
                label: 'Cancel',
                className: 'btn-small',
                callback: ({ close }) => close()
            },
            {
                label: 'Move',
                className: 'btn-blue btn-small',
                callback: ({ close }) => {
                    confirmMoveFolder(folderId);
                    close();
                }
            }
        ],
        customWidth: '500px',
        customMinWidth: '300px'
    });
    
    // Render the folder tree in the modal
    const treeContainer = document.getElementById('moveFolderTree');
    if (treeContainer) {
        treeContainer.innerHTML = '';
        
        // Create "No Parent" option (move to root)
        const noParentItem = document.createElement('div');
        noParentItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px;';
        noParentItem.setAttribute('data-folder-id', 'no_parent');
        const noParentText = document.createElement('span');
        noParentText.textContent = 'No Parent (Root Level)';
        noParentText.style.fontStyle = 'italic';
        noParentText.style.color = '#ffffff';
        noParentItem.appendChild(noParentText);
        noParentItem.onmouseenter = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
            }
        };
        noParentItem.onmouseleave = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = '';
            }
        };
        noParentItem.onclick = () => {
            // Clear tree item selections
            document.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
            });
            // Select No Parent
            noParentItem.classList.add('selected');
            noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.selectedParentForMove = 'no_parent';
        };
        treeContainer.appendChild(noParentItem);
        
        // Render the actual folder tree, excluding the folder being moved
        const treeDiv = document.createElement('div');
        treeDiv.id = 'moveModalFolderTree'; // Give it a unique ID
        const filterableFolders = (workflows_folders || []).filter(f => f.id !== folderId);
        renderTree(filterableFolders, treeDiv, {
            onItemClick: (folder) => {
                // Don't allow moving a folder to itself or its descendants
                if (folder.id === folderId) {
                    return;
                }
                window.selectedParentForMove = folder.id;
                // Clear No Parent selection
                noParentItem.classList.remove('selected');
                noParentItem.style.backgroundColor = '';
                // Clear other tree items - ONLY in this modal tree
                treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                    el.classList.remove('selected');
                    el.style.backgroundColor = '';
                });
                // Find and highlight the selected folder row - ONLY in this modal tree
                const selectedEl = treeDiv.querySelector(`[data-item-id="${folder.id}"]`);
                if (selectedEl) {
                    selectedEl.classList.add('selected');
                    selectedEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                }
            }
        });
        treeContainer.appendChild(treeDiv);
        
        // Pre-select No Parent by default
        noParentItem.classList.add('selected');
        noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
        window.selectedParentForMove = 'no_parent';
    }
}

/**
 * Confirm moving folder to selected parent
 */
async function confirmMoveFolder(folderId) {
    const selectedParentId = window.selectedParentForMove;
    if (!selectedParentId) {
        showModal({
            type: 'error',
            title: 'Error',
            content: 'Please select a parent folder'
        });
        return;
    }
    
    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/workflow-folders/${folderId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({
                parent_id: selectedParentId === 'no_parent' ? null : selectedParentId
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        showModal({
            type: 'success',
            title: 'Success',
            content: 'Folder moved successfully',
            autoClose: 2000
        });
        
        // Reload folders
        loadWorkflowFolders();
    } catch (error) {
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to move folder: ${error.message}`
        });
    }
}

/**
 * Delete the currently selected folder
 */
async function deleteSelectedFolder() {
    if (!currentSelectedFolder || currentSelectedFolder.id === 'all' || currentSelectedFolder.id === 'no_folder') {
        return;
    }
    
    const folderId = currentSelectedFolder.id;
    const folderName = currentSelectedFolder.name;
    
    // Show confirmation modal
    showModal({
        type: 'confirm',
        title: 'Delete Folder',
        content: `Are you sure you want to delete "${folderName}"?${currentSelectedFolder.children && currentSelectedFolder.children.length > 0 ? ' Its subfolders will be moved to the root level.' : ' Workflows in this folder will be moved to "No Folder".'}`,
        buttons: [
            {
                label: 'Cancel',
                className: 'btn-small',
                callback: ({ close }) => close()
            },
            {
                label: 'Delete',
                className: 'btn-small',
                callback: ({ close }) => {
                    performDeleteFolder(folderId);
                    close();
                }
            }
        ]
    });
}

/**
 * Perform the actual folder deletion
 */
async function performDeleteFolder(folderId) {
    try {
        // Delete the folder via API
        const response = await fetch(`https://app.equinoxits.com:1139/kore/workflow-folders/${folderId}`, {
            method: 'DELETE',
            headers: {
                'X-Session-Token': sessionToken
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        showModal({
            type: 'success',
            title: 'Success',
            content: 'Folder deleted successfully',
            autoClose: 2000
        });
        
        // Reload everything
        loadWorkflows();
    } catch (error) {
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to delete folder: ${error.message}`
        });
    }
}

/**
 * Confirm moving workflow to selected folder
 */
function confirmMoveWorkflow(workflowId) {
    const selectedFolderId = window.selectedFolderForMove;
    if (!selectedFolderId) {
        showModal({
            type: 'error',
            title: 'Error',
            content: 'Please select a folder'
        });
        return;
    }
    
    const workflow = workflows.find(w => w.id === workflowId);
    if (!workflow) return;
    
    // Update workflow's folder_id
    workflow.folder_id = selectedFolderId === 'no_folder' ? null : selectedFolderId;
    // Also store in definition for consistency
    if (workflow.definition) {
        workflow.definition.folder_id = workflow.folder_id;
    }
    
    // Save the workflow
    saveWorkflow(workflowId, workflow, {
        showMessage: false
    }).then(() => {
        showModal({
            type: 'success',
            title: 'Success',
            content: `Workflow moved successfully`,
            autoClose: 2000
        });
        // Refresh the workflows display
        loadWorkflows();
    }).catch(error => {
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to move workflow: ${error.message}`
        });
    });
}

/**
 * Render a filtered list of workflows
 */
function renderFilteredWorkflows(filteredWorkflows) {
    const container = document.getElementById('workflowsList');
    
    if (!container) return;
    
    // Clear previous content
    container.innerHTML = '';
    
    if (filteredWorkflows.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No workflows in this folder</h3>
                <p>Select another folder or create a new workflow</p>
            </div>
        `;
        return;
    }
    
    // Build table
    let html = `
        <table class="workflows-table" style="table-layout: fixed; padding: 0 4px;">
            <thead style="background: transparent;">
                <tr style="pointer-events: none; background: transparent !important; background-color: transparent !important;">
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterName" placeholder="Filter..." style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; color: #c0c0c0; pointer-events: auto; border: 1px solid #556870; border-radius: 0; border-radius: 0;" onkeyup="filterWorkflows()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterLastModified" placeholder="Filter..." style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; color: #c0c0c0; pointer-events: auto; border: 1px solid #556870; border-radius: 0;" onkeyup="filterWorkflows()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterModifiedBy" placeholder="Filter..." style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; color: #c0c0c0; pointer-events: auto; border: 1px solid #556870; border-radius: 0;" onkeyup="filterWorkflows()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterCreatedDate" placeholder="Filter..." style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; color: #c0c0c0; pointer-events: auto; border: 1px solid #556870; border-radius: 0;" onkeyup="filterWorkflows()"></th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; padding: 0; background: transparent;"><select id="filterActive" style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; cursor: pointer; color: #c0c0c0; border: 1px solid #556870; border-radius: 0; pointer-events: auto;" onchange="filterWorkflows()"><option style="background: #1a3540; color: #ffffff;" value="">All</option><option style="background: #1a3540; color: #ffffff;" value="True">True</option><option style="background: #1a3540; color: #ffffff;" value="False">False</option></select></th>
                    <th style="width: 80px; min-width: 80px; max-width: 80px; background: transparent;"></th>
                    <th style="position: relative; width: 100px; min-width: 100px; max-width: 100px; background: transparent;"><div style="display: flex; justify-content: flex-end; align-items: center; height: 100%; padding-right: 0; width: 100%;"><button class="btn btn-blue btn-small" onclick="loadWorkflows()" style="pointer-events: auto; cursor: pointer;">Refresh</button></div></th>
                </tr>
                <tr style="background: #32373e;">
                    <th>Name</th>
                    <th>Last Modified</th>
                    <th>Modified By</th>
                    <th>Created Date</th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px;">Active</th>
                    <th style="width: 80px; min-width: 80px; max-width: 80px; background: transparent;">Version</th>
                    <th style="text-align: right; width: 100px; min-width: 100px; max-width: 100px;">Actions</th>
                </tr>
            </thead>
            <tbody id="workflowsTableBody" style="background: transparent !important;">
    `;
    
    filteredWorkflows.forEach(workflow => {
        const activeValue = workflow.definition?.active;
        const activeDisplay = activeValue === undefined ? 'Undefined' : (activeValue ? 'True' : 'False');
        const lastModified = workflow.definition?.metadata?.updated_at ? new Date(workflow.definition.metadata.updated_at).toLocaleString() : 'N/A';
        const createdDate = workflow.definition?.metadata?.created_at ? new Date(workflow.definition.metadata.created_at).toLocaleString() : 'N/A';
        const modifiedBy = workflow.definition?.metadata?.updated_by || 'N/A';
        const toggleButtonText = activeValue === false ? 'Enable' : 'Disable';
        const toggleButtonClass = activeValue === false ? 'btn-green' : 'btn-gold';
        
        html += `
            <tr data-workflow-id="${workflow.id}">
                <td class="workflow-name"><a href="workflow-edit.html?id=${workflow.id}" style="color: inherit; text-decoration: none;">${workflow.name}</a></td>
                <td style="white-space: nowrap; font-size: 0.9rem;">${lastModified}</td>
                <td>${modifiedBy}</td>
                <td style="white-space: nowrap; font-size: 0.9rem;">${createdDate}</td>
                <td style="width: 70px; min-width: 70px; max-width: 70px; text-align: center;">${activeDisplay}</td>
                <td class="version" style="width: 80px; min-width: 80px; max-width: 80px;">v${workflow.version}</td>
                <td class="actions" style="width: 100px; min-width: 100px; max-width: 100px; text-align: right;">
                    <button class="btn btn-blue btn-small" onclick="editWorkflow('${workflow.id}')" style="width: auto; padding: 4px 6px;" title="Edit">&#9998;</button>
                    <button class="btn btn-small" onclick="showWorkflowMenu(event, '${workflow.id}')" style="width: auto; padding: 4px 6px; background: #778899; border: 1px solid #778899; cursor: pointer;" title="More options">&#8230;</button>
                </td>
            </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    `;
    
    container.innerHTML = html;
}

/**
 * Filter workflows based on search inputs
 */
function filterWorkflows() {
    const filterName = document.getElementById('filterName')?.value.toLowerCase() || '';
    const filterLastModified = document.getElementById('filterLastModified')?.value.toLowerCase() || '';
    const filterModifiedBy = document.getElementById('filterModifiedBy')?.value.toLowerCase() || '';
    const filterCreatedDate = document.getElementById('filterCreatedDate')?.value.toLowerCase() || '';
    const filterActive = document.getElementById('filterActive')?.value.toLowerCase() || '';
    
    const tableBody = document.getElementById('workflowsTableBody');
    if (!tableBody) return;
    
    const rows = tableBody.getElementsByTagName('tr');
    for (let row of rows) {
        const cells = row.getElementsByTagName('td');
        if (cells.length === 0) continue;
        
        const name = cells[0]?.textContent.toLowerCase() || '';
        const lastModified = cells[1]?.textContent.toLowerCase() || '';
        const modifiedBy = cells[2]?.textContent.toLowerCase() || '';
        const createdDate = cells[3]?.textContent.toLowerCase() || '';
        const active = cells[4]?.textContent.toLowerCase() || '';
        
        const matches = 
            name.includes(filterName) &&
            lastModified.includes(filterLastModified) &&
            modifiedBy.includes(filterModifiedBy) &&
            createdDate.includes(filterCreatedDate) &&
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
    const tableBody = document.getElementById('workflowsTableBody');
    if (!tableBody) return;
    
    const rows = tableBody.getElementsByTagName('tr');
    for (let row of rows) {
        const cells = row.getElementsByTagName('td');
        if (cells.length === 0) continue;
        
        const activeCell = cells[4]?.textContent.toLowerCase() || '';
        const isInactive = activeCell === 'false';
        
        // Hide if: hideInactive is checked AND row is inactive
        // Show otherwise
        if (hideInactive && isInactive) {
            row.style.display = 'none';
        } else {
            row.style.display = '';
        }
    }
}

/**
 * Render workflows list to the DOM
 */
function renderWorkflowsList() {
    const container = document.getElementById('workflowsList');
    const loadingSpinner = document.getElementById('loadingSpinner');
    
    if (!container) return;
    
    // Hide loading spinner
    if (loadingSpinner) {
        loadingSpinner.classList.remove('show');
    }
    
    // Clear previous content
    container.innerHTML = '';
    
    if (workflows.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No workflows yet</h3>
                <p>Create your first workflow to get started</p>
            </div>
        `;
        return;
    }
    
    // Build table
    let html = `
        <table class="workflows-table" style="table-layout: fixed; padding: 0 4px;">
            <thead style="background: transparent;">
                <tr style="pointer-events: none; background: transparent !important; background-color: transparent !important;">
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterName" placeholder="Filter..." style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; color: #c0c0c0; pointer-events: auto; border: 1px solid #556870; border-radius: 0; border-radius: 0;" onkeyup="filterWorkflows()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterLastModified" placeholder="Filter..." style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; color: #c0c0c0; pointer-events: auto; border: 1px solid #556870; border-radius: 0;" onkeyup="filterWorkflows()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterModifiedBy" placeholder="Filter..." style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; color: #c0c0c0; pointer-events: auto; border: 1px solid #556870; border-radius: 0;" onkeyup="filterWorkflows()"></th>
                    <th style="padding: 0; background: transparent;"><input type="text" id="filterCreatedDate" placeholder="Filter..." style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; color: #c0c0c0; pointer-events: auto; border: 1px solid #556870; border-radius: 0;" onkeyup="filterWorkflows()"></th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px; padding: 0; background: transparent;"><select id="filterActive" style="padding: 4px; width: 100%; height: 100%; box-sizing: border-box; background: #1a3540; cursor: pointer; color: #c0c0c0; border: 1px solid #556870; border-radius: 0; pointer-events: auto;" onchange="filterWorkflows()"><option style="background: #1a3540; color: #ffffff;" value="">All</option><option style="background: #1a3540; color: #ffffff;" value="True">True</option><option style="background: #1a3540; color: #ffffff;" value="False">False</option></select></th>
                    <th style="width: 80px; min-width: 80px; max-width: 80px; background: transparent;"></th>
                    <th style="position: relative; width: 100px; min-width: 100px; max-width: 100px; background: transparent;"><div style="display: flex; justify-content: flex-end; align-items: center; height: 100%; padding-right: 0; width: 100%;"><button class="btn btn-blue btn-small" onclick="loadWorkflows()" style="pointer-events: auto; cursor: pointer;">Refresh</button></div></th>
                </tr>
                <tr style="background: #32373e;">
                    <th>Name</th>
                    <th>Last Modified</th>
                    <th>Modified By</th>
                    <th>Created Date</th>
                    <th style="width: 70px; min-width: 70px; max-width: 70px;">Active</th>
                    <th style="width: 80px; min-width: 80px; max-width: 80px; background: transparent;">Version</th>
                    <th style="text-align: right; width: 100px; min-width: 100px; max-width: 100px;">Actions</th>
                </tr>
            </thead>
            <tbody id="workflowsTableBody" style="background: transparent !important;">
    `;
    
    workflows.forEach(workflow => {
        const activeValue = workflow.definition?.active;
        const activeDisplay = activeValue === undefined ? 'Undefined' : (activeValue ? 'True' : 'False');
        const lastModified = workflow.definition?.metadata?.updated_at ? new Date(workflow.definition.metadata.updated_at).toLocaleString() : 'N/A';
        const createdDate = workflow.definition?.metadata?.created_at ? new Date(workflow.definition.metadata.created_at).toLocaleString() : 'N/A';
        const modifiedBy = workflow.definition?.metadata?.updated_by || 'N/A';
        const toggleButtonText = activeValue === false ? 'Enable' : 'Disable';
        const toggleButtonClass = activeValue === false ? 'btn-green' : 'btn-gold';
        
        html += `
            <tr data-workflow-id="${workflow.id}">
                <td class="workflow-name"><a href="workflow-edit.html?id=${workflow.id}" style="color: inherit; text-decoration: none;">${workflow.name}</a></td>
                <td style="white-space: nowrap; font-size: 0.9rem;">${lastModified}</td>
                <td>${modifiedBy}</td>
                <td style="white-space: nowrap; font-size: 0.9rem;">${createdDate}</td>
                <td style="width: 70px; min-width: 70px; max-width: 70px; text-align: center;">${activeDisplay}</td>
                <td class="version" style="width: 80px; min-width: 80px; max-width: 80px;">v${workflow.version}</td>
                <td class="actions" style="width: 100px; min-width: 100px; max-width: 100px; text-align: right;">
                    <button class="btn btn-blue btn-small" onclick="editWorkflow('${workflow.id}')" style="width: auto; padding: 4px 6px;" title="Edit">&#9998;</button>
                    <button class="btn btn-small" onclick="showWorkflowMenu(event, '${workflow.id}')" style="width: auto; padding: 4px 6px; background: #778899; border: 1px solid #778899; cursor: pointer;" title="More options">&#8230;</button>
                </td>
            </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    `;
    
    container.innerHTML = html;
    
    // Apply Hide Inactive filter
    applyHideInactive();
}

/**
 * Show error message in modal (internal helper)
 */
function showModalError(message) {
    if (currentCreateModal) {
        const status = currentCreateModal.querySelector('#modalStatus');
        if (status) {
            status.textContent = message;
            status.style.display = 'block';
            status.className = 'status-message error';
            status.style.backgroundColor = '#5a2a2a';
            status.style.borderLeft = '4px solid #ff6b6b';
            status.style.color = '#ff6b6b';
        }
    }
}

// ============================================================================
// Workflow Editor Functions - Moved from workflow-edit.html
// ============================================================================

async function loadWorkflow() {
    const { id } = getUrlParams();

    if (!id) {
        const nameField = document.getElementById('workflowName');
        if (nameField) nameField.value = 'Invalid workflow ID';
        return;
    }

    currentWorkflowId = id;

    if (!sessionToken) return;

    try {
        // Fetch the workflow by UUID (current version only)
        const response = await fetch(`/kore/workflows/${id}`, {
            headers: { 'X-Session-Token': sessionToken }
        });

        if (!response.ok) {
            const error = await response.json();
            const nameField = document.getElementById('workflowName');
            const preview = document.getElementById('preview');
            if (nameField) nameField.value = 'Error loading workflow';
            if (preview) preview.textContent = `Error: ${error.error || 'Failed to load workflow'}`;
            return;
        }

        const workflow = await response.json();
        
        // Load everything from definition (source of truth)
        const definition = workflow.definition;
        currentWorkflowName = definition.name;
        currentVersion = definition.version;
        currentMetadata = definition.metadata;
        allVersions = [definition.version];
        
        // Set the workflow name and version from definition
        const nameField = document.getElementById('workflowName');
        const versionField = document.getElementById('versionDisplay');
        const preview = document.getElementById('preview');
        
        
        if (nameField) nameField.value = definition.name;
        if (versionField) {
            versionField.textContent = `v${definition.version}`;
        }
        
        const uuidField = document.getElementById('uuidDisplay');
        if (uuidField) {
            uuidField.textContent = currentWorkflowId;
        }

        // Load the workflow definition
        currentSteps = definition.steps || [];
        currentInputVariables = definition.inputs || [];
        currentOutputVariables = definition.outputs || [];
        
        // Restore zoom and pan from view if they were saved
        let targetZoom = 1;
        let targetPanX = 0;
        let targetPanY = 0;
        
        if (definition.view && definition.view.zoom !== undefined) {
            targetZoom = definition.view.zoom;
        }
        if (definition.view && definition.view.pan) {
            const panParts = typeof definition.view.pan === 'string' 
                ? definition.view.pan.split(',').map(Number)
                : [definition.view.pan.x || 0, definition.view.pan.y || 0];
            // Convert from grid coordinates to pixel coordinates
            targetPanX = panParts[0] * 30;
            targetPanY = panParts[1] * 30;
        }
        
        // Apply zoom and pan to canvas - translate first, then scale
        const canvasContainer = document.getElementById('canvasContainer');
        if (canvasContainer) {
            canvasContainer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
        }
        
        // Ensure all steps have variables array
        currentSteps.forEach(step => {
            if (!Array.isArray(step.variables)) {
                step.variables = [];
            }
        });
        
        // Build currentTransitions and currentTransitionFrames from step.transition objects
        transitionCounter = 0;
        currentTransitions = [];
        currentTransitionFrames = [];
        let frameCounter = 0;
        
        currentSteps.forEach(step => {
            if (step.transition && step.transition.cases && Array.isArray(step.transition.cases)) {
                // Create transition frame for this step
                const frameId = 'frame-' + (frameCounter++);
                const frame = {
                    id: frameId,
                    execution: step.transition.mode || 'First',
                    conditions: [],
                    position: step.transition.position || '0,0',
                    verticalLayout: step.transition.vertical || false,
                    attached: step.transition.attached === true,
                    attachedToStepId: step.transition.attached === true ? step.id : null,
                    parentStepId: step.id  // Store the step that owns this frame
                };
                
                // Convert cases to transitions
                step.transition.cases.forEach((caseItem, caseIndex) => {
                    const transitionId = 'transition-' + (transitionCounter++);
                    const transition = {
                        id: transitionId,
                        type: caseItem.type || 'Success',
                        conditions: caseItem.conditions || '',
                        targetSteps: caseItem.targetSteps || [],
                        order: caseItem.order || (caseIndex + 1)
                    };
                    currentTransitions.push(transition);
                    frame.conditions.push(transitionId);
                });
                
                currentTransitionFrames.push(frame);
            }
        });
        
        originalJson = JSON.stringify({ 
            id: currentWorkflowId,
            name: currentWorkflowName,
            version: currentVersion,
            view: {
                zoom: zoomLevel,
                pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
            },
            metadata: currentMetadata,
            inputs: currentInputVariables,
            outputs: currentOutputVariables,
            steps: currentSteps
        }, null, 2);
        
        // Set definition tracking variables
        originalDefinition = {
            id: currentWorkflowId,
            name: currentWorkflowName,
            version: currentVersion,
            view: {
                zoom: zoomLevel,
                pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
            },
            metadata: currentMetadata,
            inputs: currentInputVariables,
            outputs: currentOutputVariables,
            steps: currentSteps
        };
        currentDefinition = JSON.parse(JSON.stringify(originalDefinition)); // Deep copy
        unsavedChanges = false;
        updateSaveButtonState();
        
        renderStepsEditor();
        renderLoadedStepsOnCanvas();
        updatePreview();
        
        // Hide canvas while applying pan/zoom to avoid visual shifting
        const canvas = document.getElementById('workflowCanvas');
        if (canvas) {
            canvas.style.visibility = 'hidden';
        }
        
        // Apply zoom and pan after rendering by simulating user actions
        setTimeout(() => {
            // Set pan and zoom values
            panX = targetPanX;
            panY = targetPanY;
            zoomLevel = targetZoom;
            
            // Clamp pan to prevent showing empty space beyond grid boundaries
            const container = document.getElementById('canvasContainer');
            const canvas = document.getElementById('workflowCanvas');
            if (container && canvas) {
                const containerRect = container.getBoundingClientRect();
                const containerWidth = containerRect.width;
                const containerHeight = containerRect.height;
                
                // Calculate visible area in grid space
                const visibleWidth = containerWidth / zoomLevel;
                const visibleHeight = containerHeight / zoomLevel;
                
                // Grid size is 5000px = 166.67 grid units
                const GRID_SIZE_PX = 5000;
                
                // Clamp: viewport's right edge can't go left of grid's right edge
                // and viewport's bottom edge can't go above grid's bottom edge
                const maxPanX = GRID_SIZE_PX - (containerWidth / zoomLevel);
                const maxPanY = GRID_SIZE_PX - (containerHeight / zoomLevel);
                
                panX = Math.min(panX, maxPanX);
                panY = Math.min(panY, maxPanY);
                
                // Apply transform
                canvas.style.transform = `scale(${zoomLevel}) translate(${-panX}px, ${-panY}px)`;
                canvas.style.transformOrigin = '0 0';
                
                // Show canvas after transform is applied
                canvas.style.visibility = 'visible';
                
                // Update zoom display
                updateZoomDisplay();
            }
        }, 50); // Wait for DOM to settle
    } catch (err) {
        console.error('Error loading workflow:', err);
        const preview = document.getElementById('preview');
        if (preview) preview.textContent = 'Error loading workflow: ' + err.message;
    }
}


function rebuildInputVariablesFromForm() {
    currentInputVariables.forEach((inputVar, index) => {
        inputVar.name = document.querySelector(`.input-var-name-${index}`)?.value || '';
        inputVar.type = document.querySelector(`.input-var-type-${index}`)?.value || 'string';
        inputVar.label = document.querySelector(`.input-var-label-${index}`)?.value || '';
        inputVar.required = document.querySelector(`.input-var-required-${index}`)?.checked || false;
        inputVar.description = document.querySelector(`.input-var-description-${index}`)?.value || '';
        inputVar.multiline = document.querySelector(`.input-var-multiline-${index}`)?.checked || false;

        const defaultValue = document.querySelector(`.input-var-default-${index}`)?.value;
        if (defaultValue === '' || defaultValue === undefined) {
            inputVar.default = undefined;
        } else {
            // Try to parse as JSON if it looks like it
            try {
                if (defaultValue.startsWith('{') || defaultValue.startsWith('[')) {
                    inputVar.default = JSON.parse(defaultValue);
                } else if (defaultValue === 'true') {
                    inputVar.default = true;
                } else if (defaultValue === 'false') {
                    inputVar.default = false;
                } else if (!isNaN(defaultValue) && defaultValue !== '') {
                    inputVar.default = parseFloat(defaultValue);
                } else {
                    inputVar.default = defaultValue;
                }
            } catch {
                inputVar.default = defaultValue;
            }
        }
    });
}



function updateInputVariableType(index) {
    rebuildInputVariablesFromForm();
    renderInputVariables();
}



function rebuildOutputVariablesFromForm() {
    currentOutputVariables.forEach((outputVar, index) => {
        outputVar.name = document.querySelector(`.output-var-name-${index}`)?.value || '';
        outputVar.value = document.querySelector(`.output-var-value-${index}`)?.value || '';
    });
}


function setupCanvasDragDrop() {
    const stepTypeItems = document.querySelectorAll('.step-type-item');
    const canvas = document.getElementById('workflowCanvas');
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // Setup draggable step types
    stepTypeItems.forEach(item => {
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('stepType', item.getAttribute('data-type'));
            // Capture offset from item's top-left to mouse cursor
            const rect = item.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
        });
    });

    // Setup canvas to accept drops
    canvas.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    canvas.addEventListener('dragleave', (e) => {
        if (e.target === canvas) {
            // Keep canvas transparent with grid
        }
    });

    canvas.addEventListener('drop', (e) => {
        e.preventDefault();
        
        const stepType = e.dataTransfer.getData('stepType');
        const rect = canvas.getBoundingClientRect();
        // Convert screen coordinates to grid coordinates accounting for zoom and pan
        // Subtract the drag offset so top-left of item aligns with drop point
        let x = (e.clientX - rect.left - dragOffsetX) / zoomLevel + panX;
        let y = (e.clientY - rect.top - dragOffsetY) / zoomLevel + panY;
        
        // Snap to 30px grid
        x = Math.round(x / 30) * 30;
        y = Math.round(y / 30) * 30;
        
        createStepOnCanvas(stepType, x, y);
    });
    
    // Zoom and Pan functionality
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    
    function clampPan() {
        const containerRect = container.getBoundingClientRect();
        const containerWidth = containerRect.width;
        const containerHeight = containerRect.height;
        
        // Calculate visible grid area at current zoom
        const visibleWidth = containerWidth / zoomLevel;
        const visibleHeight = containerHeight / zoomLevel;
        
        // Clamp pan so viewport stays within 0,0 to GRID_SIZE,GRID_SIZE
        // panX/panY represent the top-left corner of the viewport in grid space
        panX = Math.max(0, Math.min(panX, GRID_SIZE - visibleWidth));
        panY = Math.max(0, Math.min(panY, GRID_SIZE - visibleHeight));
    }
    
    function updateTransform() {
        canvas.style.transform = `scale(${zoomLevel}) translate(${-panX}px, ${-panY}px)`;
        canvas.style.transformOrigin = '0 0';
    }
    
    // Mouse wheel zoom
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        
        const zoomIncrement = e.deltaY > 0 ? -0.05 : 0.05;
        const newZoom = Math.max(0.55, Math.min(2, zoomLevel + zoomIncrement));
        
        // Adjust pan to zoom toward mouse cursor
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        panX = mouseX / newZoom + (panX * zoomLevel / newZoom) - mouseX / newZoom;
        panY = mouseY / newZoom + (panY * zoomLevel / newZoom) - mouseY / newZoom;
        
        zoomLevel = newZoom;
        clampPan();
        updateTransform();
        updateZoomDisplay();
    }, { passive: false });
    
    // Pan with left mouse button (on empty canvas only)
    const container = document.getElementById('canvasContainer');
    container.addEventListener('mousedown', (e) => {
        if (e.button === 0 && (e.target === canvas || e.target.closest('[data-transition-connection-line]'))) {
            // Don't pan if clicking on steps, frames, or hitboxes
            if (e.target.closest('[data-step-uuid]') || 
                e.target.closest('[data-transition-frame]') ||
                e.target.closest('[data-case-arrow-hitbox]')) {
                return;
            }
            isPanning = true;
            panStartX = e.clientX + panX;
            panStartY = e.clientY + panY;
            container.style.cursor = 'grabbing';
            e.preventDefault();
        }
    });
    
    document.addEventListener('mousemove', (e) => {
        if (isPanning) {
            panX = panStartX - e.clientX;
            panY = panStartY - e.clientY;
            clampPan();
            updateTransform();
        }
    });
    
    document.addEventListener('mouseup', () => {
        if (isPanning) {
            isPanning = false;
            container.style.cursor = 'auto';
        }
    });
    
    // Drag from transition triangles to create lines to steps
    let isDrawingFromTransition = false;
    let fromTransitionId = null;
    let transitionStartX = 0;
    let transitionStartY = 0;
    
    // Drag case line end arrows to move or delete connections
    let draggedCaseConditionId = null;
    let draggedCaseTargetStepId = null;
    let caseArrowStartX = 0;
    let caseArrowStartY = 0;
    
    document.addEventListener('mousedown', (e) => {
        // Check if clicking on a case line arrow hitbox (using capture phase to intercept early)
        const hitbox = e.target.closest('[data-case-arrow-hitbox]');
        if (hitbox) {
            const canvas = document.getElementById('workflowCanvas');
            if (!canvas) return;
            
            e.stopPropagation();
            e.preventDefault();
            isDraggingCaseArrow = true;
            draggedCaseConditionId = hitbox.getAttribute('data-case-arrow-hitbox');
            
            // Find the associated case line to get the target step and line element
            const caseLine = canvas.querySelector(`[data-transition-connection-line][data-from-transition="${draggedCaseConditionId}"]`);
            draggedCaseTargetStepId = caseLine ? caseLine.getAttribute('data-to-step') : null;
            
            // Hide the current case line
            if (caseLine) {
                caseLine.style.display = 'none';
            }
            
            // Get the start point from the condition element
            const transitionFrame = canvas.querySelector('[data-transition-frame]');
            if (!transitionFrame) {
                draggedCaseConditionId = null;
                return;
            }
            
            const conditionBox = transitionFrame.querySelector(`[data-condition-id="${draggedCaseConditionId}"]`);
            if (!conditionBox) {
                draggedCaseConditionId = null;
                return;
            }
            
            // Get the transition case start point (center bottom of condition box + triangle point)
            const conditionRect = conditionBox.getBoundingClientRect();
            const containerRect = document.getElementById('canvasContainer').getBoundingClientRect();
            
            // Calculate start point in canvas screen space
            const conditionCenterScreenX = conditionRect.left - containerRect.left + conditionRect.width / 2;
            const conditionBottomScreenY = conditionRect.top - containerRect.top + conditionRect.height + 10;
            
            // Convert screen space to grid space
            caseArrowStartX = (conditionCenterScreenX / zoomLevel) + panX;
            caseArrowStartY = (conditionBottomScreenY / zoomLevel) + panY;
            
            // Create preview line SVG
            let previewLine = canvas.querySelector('[data-case-arrow-preview-line]');
            if (!previewLine) {
                previewLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                previewLine.setAttribute('data-case-arrow-preview-line', 'true');
                previewLine.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    pointer-events: none;
                    z-index: 1;
                `;
                canvas.appendChild(previewLine);
            }
            
            const handleCaseArrowMouseMove = (e) => {
                if (!isDraggingCaseArrow) return;
                
                const canvasRect = canvas.getBoundingClientRect();
                const screenCurrentX = e.clientX - canvasRect.left;
                const screenCurrentY = e.clientY - canvasRect.top;
                const currentX = (screenCurrentX / zoomLevel) + panX;
                const currentY = (screenCurrentY / zoomLevel) + panY;
                
                // Update preview line from case line start to current cursor (no arrow)
                const transition = currentTransitions.find(t => t.id === draggedCaseConditionId);
                if (transition) {
                    const transitionColors = getTransitionColors(transition.type);
                    const path = createCurvedPath(caseArrowStartX, caseArrowStartY, 'bottom', currentX, currentY, 'bottom');
                    previewLine.innerHTML = `<path d="${path}" stroke="${transitionColors.color}" stroke-width="2" fill="none" stroke-dasharray="5,5"/>`;
                }
            };
            
            const handleCaseArrowMouseUp = (e) => {
                if (!isDraggingCaseArrow) return;
                isDraggingCaseArrow = false;
                
                document.removeEventListener('mousemove', handleCaseArrowMouseMove);
                document.removeEventListener('mouseup', handleCaseArrowMouseUp);
                
                // Remove preview line
                const previewLine = canvas.querySelector('[data-case-arrow-preview-line]');
                if (previewLine) previewLine.remove();
                
                // Find what's under the cursor
                const canvasRect = canvas.getBoundingClientRect();
                const screenX = e.clientX - canvasRect.left;
                const screenY = e.clientY - canvasRect.top;
                const gridX = (screenX / zoomLevel) + panX;
                const gridY = (screenY / zoomLevel) + panY;
                
                // Check if dropped on a step
                let droppedOnStep = null;
                canvas.querySelectorAll('[data-step-uuid]').forEach(stepElement => {
                    const stepX = parseInt(stepElement.style.left);
                    const stepY = parseInt(stepElement.style.top);
                    const stepWidth = parseInt(stepElement.style.width);
                    const stepHeight = parseInt(stepElement.style.height);
                    
                    
                    if (gridX >= stepX && gridX <= stepX + stepWidth &&
                        gridY >= stepY && gridY <= stepY + stepHeight) {
                        droppedOnStep = stepElement.getAttribute('data-step-uuid');
                    }
                });
                
                
                // Update the case
                const transition = currentTransitions.find(t => t.id === draggedCaseConditionId);
                if (transition) {
                    if (droppedOnStep && droppedOnStep !== draggedCaseTargetStepId) {
                        // Update target step to new step
                        transition.targetSteps = [droppedOnStep];
                        syncTransitionCasesToStep();
                        updatePreview();
                        
                        // Remove the old case line
                        const oldCaseLine = canvas.querySelector(`[data-transition-connection-line][data-from-transition="${draggedCaseConditionId}"][data-to-step="${draggedCaseTargetStepId}"]`);
                        if (oldCaseLine) oldCaseLine.remove();
                        
                        // Recreate the case line with the new target
                        const newLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                        newLine.setAttribute('data-transition-connection-line', 'true');
                        newLine.setAttribute('data-from-transition', draggedCaseConditionId);
                        newLine.setAttribute('data-to-step', droppedOnStep);
                        newLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                        canvas.appendChild(newLine);
                        
                        // Add mousedown listener to prevent frame drag when clicking case arrow
                        newLine.addEventListener('mousedown', (e) => {
                            if (e.target.closest('[data-case-arrow-hitbox]')) {
                                e.stopPropagation();
                            }
                        });
                        
                        // Use the standard case line rendering
                        const frame = currentTransitionFrames.find(f => f.conditions.includes(draggedCaseConditionId));
                        renderCaseLineInitial(newLine, draggedCaseConditionId, droppedOnStep, canvas, frame);
                    } else if (!droppedOnStep && draggedCaseTargetStepId) {
                        // Dropped on empty space - delete the connection
                        transition.targetSteps = [];
                        syncTransitionCasesToStep();
                        updatePreview();
                        
                        // Remove the case line visually
                        const caseLinesToRemove = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${draggedCaseConditionId}"]`);
                        caseLinesToRemove.forEach(line => line.remove());
                    } else {
                        // Dropped on same step or no valid action - show the original line again
                        const oldCaseLine = canvas.querySelector(`[data-transition-connection-line][data-from-transition="${draggedCaseConditionId}"][data-to-step="${draggedCaseTargetStepId}"]`);
                        if (oldCaseLine) {
                            oldCaseLine.style.display = '';
                        }
                    }
                }
                
                draggedCaseConditionId = null;
                draggedCaseTargetStepId = null;
            };
            
            document.addEventListener('mousemove', handleCaseArrowMouseMove);
            document.addEventListener('mouseup', handleCaseArrowMouseUp);
            return;
        }
        
        // Original transition arrow handler
        // Check if clicking on a triangle
        const triangle = e.target.closest('[data-transition-arrow]');
        if (!triangle) return;
        
        const canvas = document.getElementById('workflowCanvas');
        if (!canvas) return;
        
        e.stopPropagation();
        isDrawingFromTransition = true;
        fromTransitionId = triangle.getAttribute('data-transition-arrow');
        
        const triangle_element = triangle;  // This is the hitbox
        const triangleRect = triangle_element.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        
        // Start from the triangle's point: center of the triangle hitbox horizontally, slightly above center vertically
        const screenStartX = triangleRect.left - canvasRect.left + triangleRect.width / 2;
        const screenStartY = triangleRect.top - canvasRect.top + triangleRect.height / 2 - 3;  // 3px higher
        transitionStartX = (screenStartX / zoomLevel) + panX;
        transitionStartY = (screenStartY / zoomLevel) + panY;
        
        const handleTransitionMouseMove = (e) => {
            if (!isDrawingFromTransition) return;
            
            const canvasRect = canvas.getBoundingClientRect();
            const screenCurrentX = e.clientX - canvasRect.left;
            const screenCurrentY = e.clientY - canvasRect.top;
            const currentX = (screenCurrentX / zoomLevel) + panX;
            const currentY = (screenCurrentY / zoomLevel) + panY;
            
            let line = canvas.querySelector('[data-transition-preview-line]');
            if (!line) {
                line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                line.setAttribute('data-transition-preview-line', 'true');
                line.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    pointer-events: none;
                    z-index: 1;
                `;
                canvas.appendChild(line);
            }
            
            line.innerHTML = `<line x1="${transitionStartX}" y1="${transitionStartY}" x2="${currentX}" y2="${currentY}" stroke="#00ff00" stroke-width="2"/>`;
        };
        
        const handleTransitionMouseUp = (e) => {
            if (!isDrawingFromTransition) return;
            
            const savedTransitionId = fromTransitionId; // Save before resetting
            isDrawingFromTransition = false;
            fromTransitionId = null;
            document.removeEventListener('mousemove', handleTransitionMouseMove);
            document.removeEventListener('mouseup', handleTransitionMouseUp);
            
            const previewLine = canvas.querySelector('[data-transition-preview-line]');
            if (previewLine) previewLine.remove();
            
            const canvasRect = canvas.getBoundingClientRect();
            const screenEndX = e.clientX - canvasRect.left;
            const screenEndY = e.clientY - canvasRect.top;
            const gridEndX = (screenEndX / zoomLevel) + panX;
            const gridEndY = (screenEndY / zoomLevel) + panY;
            
            // Check if we dropped on a step
            const targetStep = document.elementFromPoint(e.clientX, e.clientY);
            const stepElement = targetStep?.closest('[data-step-id]');
            
            if (stepElement && Math.hypot(gridEndX - transitionStartX, gridEndY - transitionStartY) >= MIN_DRAG_DISTANCE) {
                const targetStepId = stepElement.getAttribute('data-step-uuid');
                const transition = currentTransitions.find(t => t.id === savedTransitionId);
                
                if (transition && targetStepId) {
                    // Add target step to the transition
                    if (!transition.targetSteps.includes(targetStepId)) {
                        transition.targetSteps.push(targetStepId);
                    }
                    
                    // Create green connection line
                    const lineUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                    const connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    connectionLine.setAttribute('data-transition-connection-line', lineUUID);
                    connectionLine.setAttribute('data-from-transition', savedTransitionId);
                    connectionLine.setAttribute('data-to-step', targetStepId);
                    connectionLine.style.cssText = `
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        pointer-events: none;
                        z-index: 1;
                    `;
                    canvas.appendChild(connectionLine);
                    
                    // Use standard case line rendering
                    const frame = currentTransitionFrames.find(f => f.conditions.includes(savedTransitionId));
                    renderCaseLineInitial(connectionLine, savedTransitionId, targetStepId, canvas, frame);
                    
                    updatePreview();
                }
            }
        };
        
        document.addEventListener('mousemove', handleTransitionMouseMove);
        document.addEventListener('mouseup', handleTransitionMouseUp);
    });
    
    // Click on empty canvas to deselect steps and transitions
    canvas.addEventListener('click', (e) => {
        if (e.target === canvas) {
            document.querySelectorAll('[data-step-id]').forEach(el => {
                const stepUUID = el.getAttribute('data-step-uuid');
                const step = currentSteps.find(s => s.id === stepUUID);
                el.classList.remove('selected');
            });
            document.querySelectorAll('[data-transition-uuid]').forEach(el => {
                const transId = el.getAttribute('data-transition-uuid');
                const transObj = currentTransitions.find(t => t.id === transId);
                const transColors = getTransitionColors(transObj ? transObj.type : 'Success');
                el.style.borderColor = transColors.border;
            });
            document.querySelectorAll('[data-transition-frame]').forEach(el => {
                el.style.borderColor = '#d4af37';
            });
            document.getElementById('propertiesContent').innerHTML = '<div style="color: #b0b0b0; font-size: 0.85rem;">Select a step or transition to edit properties</div>';
        }
    });
}

function renderStep(stepData) {
    // Universal step rendering - works for both new and loaded steps
    const canvas = document.getElementById('workflowCanvas');
    const stepElement = document.createElement('div');
    const stepId = `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    stepElement.setAttribute('data-step-id', stepId);
    stepElement.setAttribute('data-step-uuid', stepData.id);
    stepElement.setAttribute('data-step-type', stepData.type);
    stepElement.classList.add('step');
    
    // Use position from stepData, or default to 0,0 (top-left)
    let posX = 0;
    let posY = 0;
    if (stepData.position) {
        const [gridX, gridY] = stepData.position.split(',').map(Number);
        posX = gridX * 30;  // Convert 30px grid units to pixels
        posY = gridY * 30;
    }
    
    // Determine size: use override if set, otherwise auto-calculate
    let width, height;
    
    if (stepData.overrideSize) {
        // Use override values (in grid units, convert to pixels)
        width = Math.max(2, stepData.width || 3) * 30;
        height = Math.max(1, stepData.height || 1) * 30;
    } else {
        // Default values
        width = 120;  // 4 grid units
        height = 30; // 1 grid unit
    }
    
    // Only set positioning and sizing in inline styles
    stepElement.style.cssText = `
        left: ${posX}px;
        top: ${posY}px;
        width: ${width}px;
        height: ${height}px;
    `;
    
    // Determine colors for name column based on step type
    // Dark color goes on name column only
    let darkColor = '#0a3d55';      // Default dark (dark blue)
    
    if (stepData.type === 'Begin') {
        darkColor = '#0a4d3a';      // Dark green
    } else if (stepData.type === 'End') {
        darkColor = '#5a1a1a';      // Dark red
    } else if (stepData.type === 'Kore') {
        darkColor = '#3a3a3a';      // Dark gray
    } else if (stepData.type === 'Workflow') {
        darkColor = '#4a1f77';      // Darker purple
    } else if (stepData.type === 'RMM') {
        darkColor = '#0a3d55';      // Dark blue (standard)
    }
    
    // Create the step content with left column (transparent) and name column (dark)
    // Left column (30px wide, transparent) with icon
    const leftColumn = document.createElement('div');
    leftColumn.style.cssText = `
        width: 30px;
        height: 100%;
        background: transparent;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
    `;
    
    // Add icon based on step type
    if (stepData.type === 'Begin') {
        // Arrow pointing diagonally toward lower right (rotated 90 degrees)
        const icon = document.createElement('div');
        icon.style.cssText = `
            font-size: 28px;
            color: #ffffff;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            transform: rotate(90deg);
            font-weight: bold;
        `;
        icon.innerHTML = '&#8599;';
        leftColumn.appendChild(icon);
    } else if (stepData.type === 'End') {
        // X icon (&#10005;)
        const icon = document.createElement('div');
        icon.style.cssText = `
            font-size: 20px;
            color: #ffffff;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
        `;
        icon.innerHTML = '&#10005;';
        leftColumn.appendChild(icon);
    } else if (stepData.type === 'Kore') {
        // Diamond icon (&#9830;)
        const icon = document.createElement('div');
        icon.style.cssText = `
            font-size: 24px;
            color: #ffffff;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
        `;
        icon.innerHTML = '&#9830;';
        leftColumn.appendChild(icon);
    } else if (stepData.type === 'Workflow') {
        // WF text with circle outline
        const icon = document.createElement('div');
        icon.style.cssText = `
            width: 24px;
            height: 24px;
            border: 2px solid #ffffff;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            color: #ffffff;
            font-weight: bold;
        `;
        icon.innerHTML = 'WF';
        leftColumn.appendChild(icon);
    } else {
        // Standard/Function - Gear icon (&#9881;)
        const icon = document.createElement('div');
        icon.style.cssText = `
            font-size: 24px;
            color: #ffffff;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
        `;
        icon.innerHTML = '&#9881;';
        leftColumn.appendChild(icon);
    }
    
    stepElement.appendChild(leftColumn);
    
    // Name/content area (dark color background and border)
    const contentArea = document.createElement('div');
    contentArea.style.cssText = `
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        background: ${darkColor};
        border: 1px solid ${darkColor};
        border-radius: 4px;
    `;
    contentArea.textContent = stepData.name || (stepData.type === 'Begin' ? 'BEGIN' : stepData.type === 'End' ? 'End' : stepData.type === 'Workflow' ? 'Workflow' : stepData.type === 'RMM' ? 'RMM Step' : stepData.type === 'Kore' ? 'Kore' : `${stepData.type} Step`);
    stepElement.appendChild(contentArea);
    
    // Add to canvas temporarily to measure
    canvas.appendChild(stepElement);
    
    // Measure the content to auto-resize if needed
    // Create a temporary element to measure text width
    const tempDiv = document.createElement('div');
    tempDiv.style.cssText = `
        position: absolute;
        visibility: hidden;
        font-size: 0.9rem;
        white-space: nowrap;
    `;
    tempDiv.textContent = stepData.name || `${stepData.type} Step`;
    document.body.appendChild(tempDiv);
    const textWidth = tempDiv.offsetWidth;
    document.body.removeChild(tempDiv);
    
    // Calculate required width: need space for icon (30px) + text + margins
    // 90px available for text in default 120px step (30 icon + 90 content)
    if (!stepData.overrideSize && textWidth > 80) {
        const gridSpaces = Math.ceil((textWidth - 80) / 30);
        width = 120 + (gridSpaces * 30);
        stepElement.style.width = width + 'px';
    }
    
    // Always store the final width/height in step data (in grid units)
    stepData.width = width / 30;
    stepData.height = height / 30;
    
    // Add click handler to show properties
    stepElement.addEventListener('click', (e) => {
        e.stopPropagation();
        showStepProperties(stepData.id);
        
        // Deselect all other steps and transitions
        document.querySelectorAll('[data-step-id]').forEach(el => {
            el.classList.remove('selected');
        });
        document.querySelectorAll('[data-transition-uuid]').forEach(el => {
            el.classList.remove('selected');
        });
        // Highlight selected step
        stepElement.classList.add('selected');
    });
    
    // Add single connection point (right side by default)
    const circle = document.createElement('div');
    circle.setAttribute('data-connection-point', 'dynamic');
    circle.classList.add('connectionPoint');
    circle.style.cssText = `
        right: -6px;
        top: 50%;
        transform: translateY(-50%);
    `;
    
    // Add drag-to-draw line functionality
    let isDrawing = false;
    let startX, startY;
    let screenStartX, screenStartY;
    let fromStepId = null;
    let fromStepUUID = null;  // Store the step UUID for updateBlueTransitionLine
    let frameUUID = ''; // Will be generated when drag completes
    let currentConnectionPoint = 'bottom'; // Track which side the connection point is on
    
    circle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        isDrawing = true;
        fromStepId = stepElement.getAttribute('data-step-id');
        const rect = stepElement.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const circleRect = circle.getBoundingClientRect();
        // Store for use in handleMouseMove
        screenStartX = circleRect.left - canvasRect.left + 6;
        screenStartY = circleRect.top - canvasRect.top + 6;
        // Convert to grid coordinates
        startX = (screenStartX / zoomLevel) + panX;
        startY = (screenStartY / zoomLevel) + panY;
        
        // Store the step UUID for later use in updateBlueTransitionLine
        fromStepUUID = stepElement.getAttribute('data-step-uuid');
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    });
    
    const handleMouseMove = (e) => {
        if (isDrawing) {
            const canvasRect = canvas.getBoundingClientRect();
            const screenCurrentX = e.clientX - canvasRect.left;
            const screenCurrentY = e.clientY - canvasRect.top;
            
            // Update or create line preview (use screen coordinates)
            let line = canvas.querySelector('[data-preview-line]');
            if (!line) {
                line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                line.setAttribute('data-preview-line', 'true');
                line.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    pointer-events: none;
                    z-index: 1;
                `;
                canvas.appendChild(line);
            }
            
            // Scale screen coordinates to canvas space
            const scaledX1 = screenStartX / zoomLevel;
            const scaledY1 = screenStartY / zoomLevel;
            const scaledX2 = screenCurrentX / zoomLevel;
            const scaledY2 = screenCurrentY / zoomLevel;
            
            line.innerHTML = `<line x1="${scaledX1}" y1="${scaledY1}" x2="${scaledX2}" y2="${scaledY2}" stroke="#3a7a99" stroke-width="2"/>`;
        }
    };
    
    const handleMouseUp = (e) => {
        if (isDrawing) {
                isDrawing = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                
                const canvasRect = canvas.getBoundingClientRect();
                const screenEndX = e.clientX - canvasRect.left;
                const screenEndY = e.clientY - canvasRect.top;
                
                // Convert to grid coordinates (no pan offset - we're measuring screen space directly)
                const gridEndX = (screenEndX / zoomLevel);
                const gridEndY = (screenEndY / zoomLevel);
                
                // Check minimum drag distance
                const dragDistance = Math.hypot(gridEndX - startX, gridEndY - startY);
                if (dragDistance < MIN_DRAG_DISTANCE) {
                    // Drag too short, don't create transition
                    return;
                }
                
                // Generate unique frame ID
                frameUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                
                // Frame is 90px wide x 60px tall, so center offset is 45px x 30px
                // Calculate center point of frame in grid units
                const frameCenterGridX = gridEndX - (45 / zoomLevel);
                const frameCenterGridY = gridEndY - (30 / zoomLevel);
                
                // Snap center to nearest half-grid (15px)
                const snappedX = Math.round(frameCenterGridX / 15) * 15;
                const snappedY = Math.round(frameCenterGridY / 15) * 15;
                
                // Convert to 30px grid coordinates for storage
                const frameGridX = snappedX / 30;
                const frameGridY = snappedY / 30;
                
                // Store frame data
                const frameData = {
                    id: frameUUID,
                    execution: 'First',
                    conditions: [],
                    position: `${frameGridX},${frameGridY}`,
                    verticalLayout: false, // Default to horizontal layout
                    parentStepId: fromStepUUID  // Store the step that owns this frame
                };
                currentTransitionFrames = currentTransitionFrames || [];
                currentTransitionFrames.push(frameData);
                
                // Create default Success condition
                transitionCounter++;
                const defaultConditionId = String(transitionCounter);
                const defaultConditionData = {
                    id: defaultConditionId,
                    name: '',
                    type: 'Success',
                    conditions: '',
                    targetSteps: [],
                    order: 1
                };
                
                // Add condition to frame data
                frameData.conditions.push(defaultConditionId);
                currentTransitions.push(defaultConditionData);
                
                // Render the frame with the default condition
                renderTransitionFrame(frameUUID, false);
                
                // Get the rendered frame element
                const frameRect = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                
                // Position the frame at the snapped coordinates (top-left corner)
                if (frameRect) {
                    frameRect.style.left = snappedX + 'px';
                    frameRect.style.top = snappedY + 'px';
                    
                    // Reposition connection point to nearest side of the frame
                    repositionConnectionPoint(frameRect);
                }
                
                // Update the preview line to be permanent, connecting to frame
                let connectionLine = canvas.querySelector('[data-preview-line]');
                if (connectionLine) {
                    connectionLine.removeAttribute('data-preview-line');
                    connectionLine.setAttribute('data-connection-line', frameUUID);
                    connectionLine.setAttribute('data-from-step', fromStepUUID);  // Use UUID, not step-id
                    connectionLine.setAttribute('data-from-point', currentConnectionPoint);
                    connectionLine.setAttribute('data-to-frame', frameUUID);
                    
                    // Get the source step data for type checking
                    const sourceStepElement = canvas.querySelector(`[data-step-id="${fromStepId}"]`);
                    const sourceStepUUID = sourceStepElement ? sourceStepElement.getAttribute('data-step-uuid') : null;
                    const sourceStepData = sourceStepUUID ? currentSteps.find(s => s.id === sourceStepUUID) : null;
                    
                    // Update step's transition with the frame and cases
                    if (sourceStepElement && sourceStepData) {
                        const frame = currentTransitionFrames.find(f => f.id === frameUUID);
                        if (frame && !sourceStepData.transition) {
                            // Create the transition object with cases
                            sourceStepData.transition = {
                                position: frame.position,
                                mode: frame.execution,
                                vertical: false,
                                cases: frame.conditions.map(conditionId => {
                                    const caseObj = currentTransitions.find(t => t.id === conditionId);
                                    return caseObj ? {
                                        type: caseObj.type,
                                        conditions: caseObj.conditions,
                                        targetSteps: caseObj.targetSteps,
                                        order: caseObj.order
                                    } : null;
                                }).filter(Boolean)
                            };
                            updatePreview();
                        }
                    }
                    
                    // Add defs with marker if not already present
                    if (!connectionLine.querySelector('defs')) {
                        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
                        marker.setAttribute('id', 'blueArrowhead');
                        marker.setAttribute('markerWidth', '10');
                        marker.setAttribute('markerHeight', '10');
                        marker.setAttribute('refX', '9');
                        marker.setAttribute('refY', '3');
                        marker.setAttribute('orient', 'auto');
                        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                        polygon.setAttribute('points', '0 0, 10 3, 0 6');
                        // Use green for BEGIN step, blue for others
                        const markerColor = sourceStepData && sourceStepData.type === 'Begin' ? '#00cc66' : '#3a7a99';
                        polygon.setAttribute('fill', markerColor);
                        marker.appendChild(polygon);
                        defs.appendChild(marker);
                        connectionLine.appendChild(defs);
                    }
                    
                    // Update line to use curved path
                    // Frame is positioned at (snappedX - 45, snappedY - 30) and is 90px wide x 60px tall
                    const frameActualX = snappedX - 45;
                    const frameActualY = snappedY - 30;
                    const frameWidth = frameRect ? frameRect.offsetWidth : 90;
                    const frameHeight = frameRect ? frameRect.offsetHeight : 60;
                    const frameSideCenters = [
                        { x: frameActualX + frameWidth / 2, y: frameActualY, name: 'top' },
                        { x: frameActualX + frameWidth / 2, y: frameActualY + frameHeight, name: 'bottom' },
                        { x: frameActualX, y: frameActualY + frameHeight / 2, name: 'left' },
                        { x: frameActualX + frameWidth, y: frameActualY + frameHeight / 2, name: 'right' }
                    ];
                    
                    let nearestSide = frameSideCenters[0];
                    let minDistance = Infinity;
                    frameSideCenters.forEach(side => {
                        const distance = Math.hypot(startX - side.x, startY - side.y);
                        if (distance < minDistance) {
                            minDistance = distance;
                            nearestSide = side;
                        }
                    });
                    
                    updateBlueTransitionLine(connectionLine, frameUUID, fromStepUUID, currentConnectionPoint, canvas);
                    
                    // Mark the connection circle as connected
                    const fromStep = canvas.querySelector(`[data-step-id="${fromStepId}"]`);
                    if (fromStep) {
                        const connectedCircle = fromStep.querySelector(`[data-connection-point="dynamic"]`);
                        if (connectedCircle) {
                            // The circle color is now handled by the .connectionPoint class based on step type
                            connectedCircle.setAttribute('data-connected', 'true');
                        }
                        // Update visibility of all connection points for this step
                        const stepUUID = fromStep.getAttribute('data-step-uuid');
                        updateConnectionPointVisibility(stepUUID);
                    }
                }
            }
        };
        
        stepElement.appendChild(circle);
    
    // Function to reposition connection point to nearest side of target frame
    function repositionConnectionPoint(targetFrameElement) {
        if (!targetFrameElement) return;
        
        const stepRect = stepElement.getBoundingClientRect();
        const frameRect = targetFrameElement.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        
        // Get step center
        const stepCenterX = stepRect.left - canvasRect.left + (stepRect.width / 2);
        const stepCenterY = stepRect.top - canvasRect.top + (stepRect.height / 2);
        
        // Get frame center
        const frameCenterX = frameRect.left - canvasRect.left + (frameRect.width / 2);
        const frameCenterY = frameRect.top - canvasRect.top + (frameRect.height / 2);
        
        // Calculate direction from step to frame
        const deltaX = frameCenterX - stepCenterX;
        const deltaY = frameCenterY - stepCenterY;
        
        // Determine which side of the step faces the frame
        let connectionSide = 'bottom';
        const absDeltaX = Math.abs(deltaX);
        const absDeltaY = Math.abs(deltaY);
        
        if (absDeltaY > absDeltaX) {
            // Frame is more above or below - use top/bottom
            connectionSide = deltaY > 0 ? 'bottom' : 'top';
        } else {
            // Frame is more left or right - use left/right
            connectionSide = deltaX > 0 ? 'right' : 'left';
        }
        
        // Reposition circle to the side facing the frame
        const positionStyles = {
            'top': 'top: -6px; left: 50%; transform: translateX(-50%);',
            'bottom': 'bottom: -6px; left: 50%; transform: translateX(-50%);',
            'left': 'top: 50%; left: -6px; transform: translateY(-50%);',
            'right': 'top: 50%; right: -6px; transform: translateY(-50%);'
        };
        
        circle.classList.add('connectionPoint');
        circle.style.cssText = positionStyles[connectionSide];
        
        currentConnectionPoint = connectionSide;
        
        // Update any blue connection line from this step to use the new connection point
        const blueLines = canvas.querySelectorAll(`[data-connection-line][data-from-step="${stepId}"]`);
        blueLines.forEach(line => {
            line.setAttribute('data-from-point', connectionSide);
            const frameId = line.getAttribute('data-to-frame');
            updateBlueTransitionLine(line, frameId, stepId, connectionSide, canvas);
        });
    }
    
    // Make step draggable to reposition
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    
    stepElement.addEventListener('mousedown', (e) => {
        isDragging = true;
        const rect = stepElement.getBoundingClientRect();
        // Convert screen offset to grid offset, accounting for zoom
        dragOffsetX = (e.clientX - rect.left) / zoomLevel;
        dragOffsetY = (e.clientY - rect.top) / zoomLevel;
        stepElement.style.opacity = '0.8';
    });
    
    document.addEventListener('mousemove', (e) => {
        if (isDragging) {
            const canvasRect = canvas.getBoundingClientRect();
            // Convert screen coordinates to grid coordinates
            // canvasRect already includes the pan transform, so no need to add panX/panY
            let newX = (e.clientX - canvasRect.left) / zoomLevel - dragOffsetX;
            let newY = (e.clientY - canvasRect.top) / zoomLevel - dragOffsetY;
            
            // Snap to 15px grid (half-grid) visually, but store as 30px grid coordinates
            newX = Math.round(newX / 15) * 15;
            newY = Math.round(newY / 15) * 15;
            
            // Keep within canvas bounds
            newX = Math.max(0, newX);
            newY = Math.max(0, newY);
            
            stepElement.style.left = newX + 'px';
            stepElement.style.top = newY + 'px';
            
            // Update step position in data using 30px grid coordinates
            const gridX = newX / 30;
            const gridY = newY / 30;
            stepData.position = `${gridX},${gridY}`;
            
            // If this step has an attached frame, move it too
            const attachedFrame = currentTransitionFrames.find(f => f.attachedToStepId === stepData.id);
            if (attachedFrame) {
                const frameElement = canvas.querySelector(`[data-transition-frame="${attachedFrame.id}"]`);
                if (frameElement) {
                    // Position frame at same Y as step (so name panel hides behind step)
                    frameElement.style.top = newY + 'px';
                    frameElement.style.left = newX + 'px';
                    attachedFrame.position = `${gridX},${gridY}`;
                    
                    // Update all case lines from conditions in this frame
                    attachedFrame.conditions.forEach(conditionId => {
                        const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${conditionId}"]`);
                        caseLines.forEach(line => {
                            const toStepId = line.getAttribute('data-to-step');
                            renderCaseLineInitial(line, conditionId, toStepId, canvas, attachedFrame);
                        });
                    });
                }
            }
            
            // Update any blue connection lines from this step
            const blueLines = canvas.querySelectorAll(`[data-connection-line][data-from-step="${stepData.id}"]`);
            blueLines.forEach(line => {
                // Get the frame this line connects to from the data-connection-line value (which is the frameUUID)
                const frameUUID = line.getAttribute('data-connection-line');
                if (frameUUID) {
                    const frameElement = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                    if (frameElement) {
                        const closestSide = getClosestSideToFrame(stepElement, frameElement, canvas);
                        updateBlueTransitionLine(line, frameUUID, stepData.id, closestSide, canvas);
                        
                        // Also update the connection point circle position
                        const connectionPoint = stepElement.querySelector('[data-connection-point]');
                        if (connectionPoint) {
                            const positionStyles = {
                                'top': 'top: -6px; left: 50%; transform: translateX(-50%);',
                                'bottom': 'bottom: -6px; left: 50%; transform: translateX(-50%);',
                                'left': 'left: -6px; top: 50%; transform: translateY(-50%);',
                                'right': 'right: -6px; top: 50%; transform: translateY(-50%);'
                            };
                            
                            connectionPoint.classList.add('connectionPoint');
                            connectionPoint.style.cssText = `
                                ${positionStyles[closestSide]}
                            `;
                        }
                    }
                }
            });
            
            // Update any case lines to this step
            const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-to-step="${stepData.id}"]`);
            caseLines.forEach(line => {
                const fromTransitionId = line.getAttribute('data-from-transition');
                const frame = currentTransitionFrames.find(f => f.conditions.includes(fromTransitionId));
                renderCaseLineInitial(line, fromTransitionId, stepData.id, canvas, frame);
            });
        }
        
        // Note: repositionConnectionPoint is called above for each transition frame
    });
    
    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            stepElement.style.opacity = '1';
        }
    });
    
    // Update connection point visibility based on whether step has transitions
    updateConnectionPointVisibility(stepData.id);
}

function updateConnectionPointVisibility(stepId) {
    // Check if this step has any connected transitions
    const step = currentSteps.find(s => s.id === stepId);
    if (!step || !step.transition || !step.transition.cases || step.transition.cases.length === 0) {
        // No transitions connected, show all circles
        const stepElement = document.querySelector(`[data-step-uuid="${stepId}"]`);
        if (stepElement) {
            stepElement.querySelectorAll('[data-connection-point]').forEach(circle => {
                circle.style.display = 'block';
            });
        }
        return;
    }
    
    // Step has transitions, hide unconnected circles
    const stepElement = document.querySelector(`[data-step-uuid="${stepId}"]`);
    if (stepElement) {
        stepElement.querySelectorAll('[data-connection-point]').forEach(circle => {
            const hasConnection = circle.getAttribute('data-connected') === 'true';
            circle.style.display = hasConnection ? 'block' : 'none';
        });
    }
}

function createStepOnCanvas(stepType, x, y) {
    // x and y are already snapped grid coordinates from the drop handler (in pixels)
    // Convert to grid units (divide by 30)
    const gridX = Math.round(x / 30);
    const gridY = Math.round(y / 30);
    
    // Create step data object
    const stepData = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: stepType === 'Begin' ? 'BEGIN' : stepType === 'End' ? 'End' : stepType === 'Workflow' ? 'Workflow' : stepType === 'RMM' ? 'RMM Step' : stepType === 'Kore' ? 'Kore' : `${stepType} Step`,
        type: stepType,
        action: '',
        width: 3,
        height: 1,
        overrideSize: false,
        variables: [],
        position: `${gridX},${gridY}`
    };
    
    // Store step data
    currentSteps.push(stepData);
    
    // Render it on canvas
    renderStep(stepData);
}

// ===== INPUT VARIABLES UI =====


function renderInputVariables() {
    const container = document.getElementById('inputVariablesList');
    if (!container) return;

    container.innerHTML = '';
    currentInputVariables.forEach((inputVar, index) => {
        const varDiv = document.createElement('div');
        varDiv.className = 'input-variable-item';
        varDiv.style.cssText = `
            border: 1px solid #404040;
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 12px;
            background: rgba(26, 53, 64, 0.5);
            position: relative;
        `;

        // Determine which default field type to show based on variable type
        const varType = inputVar.type || 'string';
        let defaultFieldHTML = '';
        
        if (varType === 'boolean') {
            defaultFieldHTML = `
                <select class="form-field-input input-var-default-${index}" style="padding: 0 8px; height: 37px; width: 100%; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color);">
                    <option value="">No default</option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                </select>
            `;
        } else if (varType === 'integer' || varType === 'number') {
            defaultFieldHTML = `
                <input type="number" class="form-field-input input-var-default-${index}" 
                       placeholder="Default value"
                       style="padding: 0 8px; height: 37px; width: 100%; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color); text-align: left;">
            `;
        } else if (varType === 'object' || varType === 'array') {
            defaultFieldHTML = `
                <input type="text" class="form-field-input input-var-default-${index}" 
                       placeholder="JSON"
                       style="padding: 0 8px; height: 37px; width: 100%; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color); text-align: left;">
            `;
        } else {
            defaultFieldHTML = `
                <input type="text" class="form-field-input input-var-default-${index}" 
                       placeholder="Default value"
                       style="padding: 0 8px; height: 37px; width: 100%; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color); text-align: left;">
            `;
        }

        varDiv.innerHTML = `
            <!-- Delete Button (floating top-right, independent of layout) -->
            <button class="btn btn-red btn-small" onclick="deleteInputVariable(${index})" 
                    title="Delete variable"
                    style="position: absolute; top: 5px; right: 1px; padding: 0 6px; height: 18px; font-size: 0.7rem; white-space: nowrap; border-radius: 2px;">
                Delete
            </button>

            <!-- Row 1: Name, Display Name, Type -->
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 8px;">
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 0.595rem; margin-bottom: 1px; text-transform: uppercase; letter-spacing: 0.5px;">Name</label>
                    <input type="text" class="form-field-input input-var-name-${index}" 
                           value="${inputVar.name || ''}" 
                           placeholder="Variable name"
                           style="padding: 0 8px; height: 37px; width: 100%; text-align: left; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color);">
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 0.595rem; margin-bottom: 1px; text-transform: uppercase; letter-spacing: 0.5px;">Display Name</label>
                    <input type="text" class="form-field-input input-var-label-${index}" 
                           value="${inputVar.label || ''}" 
                           placeholder="Display label"
                           style="padding: 0 8px; height: 37px; width: 100%; text-align: left; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color);">
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 0.595rem; margin-bottom: 1px; text-transform: uppercase; letter-spacing: 0.5px;">Type</label>
                    <select class="form-field-input input-var-type-${index}" 
                            onchange="updateInputVariableType(${index})"
                            style="padding: 0 8px; height: 37px; width: 100%; text-align: left; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color);">
                        <option value="string" ${inputVar.type === 'string' ? 'selected' : ''}>String</option>
                        <option value="integer" ${inputVar.type === 'integer' ? 'selected' : ''}>Integer</option>
                        <option value="number" ${inputVar.type === 'number' ? 'selected' : ''}>Number</option>
                        <option value="boolean" ${inputVar.type === 'boolean' ? 'selected' : ''}>Boolean</option>
                        <option value="object" ${inputVar.type === 'object' ? 'selected' : ''}>Object</option>
                        <option value="array" ${inputVar.type === 'array' ? 'selected' : ''}>Array</option>
                    </select>
                </div>
            </div>

            <!-- Row 2: Default Value, Description, Required + Multiline (bottom-aligned) -->
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; align-items: flex-end;">
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 0.595rem; margin-bottom: 1px; text-transform: uppercase; letter-spacing: 0.5px;">Default Value</label>
                    ${defaultFieldHTML}
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 0.595rem; margin-bottom: 1px; text-transform: uppercase; letter-spacing: 0.5px;">Description</label>
                    <input type="text" class="form-field-input input-var-description-${index}" 
                           value="${inputVar.description || ''}" 
                           placeholder="Help text"
                           style="padding: 0 8px; height: 37px; width: 100%; text-align: left; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color);">
                </div>
                <div style="display: flex; gap: 12px; flex-direction: row; align-items: flex-end;">
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 0.595rem; margin: 0; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;">
                        <input type="checkbox" class="input-var-required-${index}" 
                               ${inputVar.required ? 'checked' : ''}
                               style="cursor: pointer; width: 14px; height: 14px;">
                        Required
                    </label>
                    ${inputVar.type === 'string' ? `
                        <label style="display: flex; align-items: center; gap: 6px; font-size: 0.595rem; margin: 0; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;">
                            <input type="checkbox" class="input-var-multiline-${index}" 
                                   ${inputVar.multiline ? 'checked' : ''}
                                   style="cursor: pointer; width: 14px; height: 14px;">
                            Multiline
                        </label>
                    ` : ''}
                </div>
            </div>
        `;

        container.appendChild(varDiv);
    });
}



function showWorkflowSettingsModal() {
    document.getElementById('workflowSettingsModal').classList.add('show');
    renderInputVariables();
    renderOutputVariables();
}



function closeWorkflowSettingsModal() {
    document.getElementById('workflowSettingsModal').classList.remove('show');
}



function addInputVariable() {
    currentInputVariables.push({
        name: '',
        type: 'string',
        label: '',
        required: false,
        description: '',
        default: undefined,
        multiline: false
    });
    renderInputVariables();
}



function deleteInputVariable(index) {
    if (confirm('Delete this input variable?')) {
        currentInputVariables.splice(index, 1);
        renderInputVariables();
    }
}



function addOutputVariable() {
    currentOutputVariables.push({
        name: '',
        value: ''
    });
    renderOutputVariables();
}



function deleteOutputVariable(index) {
    if (confirm('Delete this output variable?')) {
        currentOutputVariables.splice(index, 1);
        renderOutputVariables();
    }
}



function renderOutputVariables() {
    const container = document.getElementById('outputVariablesList');
    if (!container) return;

    container.innerHTML = '';
    currentOutputVariables.forEach((outputVar, index) => {
        const rowDiv = document.createElement('div');
        rowDiv.style.cssText = `
            display: grid;
            grid-template-columns: 1fr 1fr auto;
            gap: 12px;
            margin-bottom: 8px;
            align-items: flex-end;
        `;

        rowDiv.innerHTML = `
            <div class="form-group" style="margin-bottom: 0;">
                <label style="font-size: 0.595rem; margin-bottom: 1px; text-transform: uppercase; letter-spacing: 0.5px;">Name</label>
                <input type="text" class="form-field-input output-var-name-${index}" 
                       value="${outputVar.name || ''}" 
                       placeholder="Variable name"
                       style="padding: 0 8px; height: 37px; width: 100%; text-align: left; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color);">
            </div>
            <div class="form-group" style="margin-bottom: 0;">
                <label style="font-size: 0.595rem; margin-bottom: 1px; text-transform: uppercase; letter-spacing: 0.5px;">Value</label>
                <input type="text" class="form-field-input output-var-value-${index}" 
                       value="${outputVar.value || ''}" 
                       placeholder="Output value"
                       style="padding: 0 8px; height: 37px; width: 100%; text-align: left; border: 2px solid var(--form-border-color); border-radius: 4px; background: var(--form-bg-color); color: var(--form-text-color);">
            </div>
            <button class="btn btn-red btn-small" onclick="deleteOutputVariable(${index})" 
                    title="Delete variable"
                    style="padding: 0 6px; height: 37px; font-size: 0.7rem; white-space: nowrap; border-radius: 2px;">
                Delete
            </button>
        `;

        container.appendChild(rowDiv);
    });
}



function saveWorkflowSettings() {
    rebuildInputVariablesFromForm();
    rebuildOutputVariablesFromForm();
    closeWorkflowSettingsModal();
    // Mark as unsaved so user will be prompted to save workflow
    unsavedChanges = true;
    updateSaveButtonState();
}

/**
 * Toggle workflow active status
 */
async function toggleWorkflowActive(workflowId) {
    const workflow = workflows.find(w => w.id === workflowId);
    if (!workflow) return;
    
    const currentActive = workflow.definition?.active === true;
    const newActive = !currentActive;
    
    try {
        // Update the definition
        workflow.definition.active = newActive;
        
        // Save to backend
        await saveWorkflow(workflowId, {
            name: workflow.name,
            version: workflow.version,
            definition: workflow.definition
        }, {
            incrementVersion: false,
            updateMetadata: false,
            onSuccess: () => {
                renderWorkflowsList();
            },
            onError: (error) => {
                alert('Failed to toggle workflow: ' + error.message);
                renderWorkflowsList();
            }
        });
    } catch (error) {
        console.error('Error toggling workflow:', error);
        alert('Error: ' + error.message);
    }
}

/**
 * Edit a workflow
 */
function editWorkflow(workflowId) {
    window.location.href = `workflow-edit.html?id=${workflowId}`;
}

/**
 * Delete a workflow
 */
function deleteWorkflow(workflowId) {
    // Get the workflow from the data array
    const workflow = workflows.find(w => w.id === workflowId);
    if (!workflow) {
        alert('Workflow not found');
        return;
    }
    
    const workflowName = workflow.name;
    const workflowVersion = workflow.version;
    
    showModal({
        title: 'Delete Workflow',
        content: `Are you sure you want to delete <strong>${workflowName}</strong>? This action cannot be undone.`,
        buttons: [
            {
                label: 'Cancel',
                className: 'btn-grey',
                callback: ({ close }) => close()
            },
            {
                label: 'Delete',
                className: 'btn-red',
                callback: async ({ close }) => {
                    close();
                    
                    try {
                        if (!sessionToken) {
                            throw new Error('Not authenticated');
                        }

                        const response = await fetch(`https://app.equinoxits.com:1139/kore/workflows/${workflowId}/${workflowVersion}`, {
                            method: 'DELETE',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Session-Token': sessionToken
                            }
                        });

                        if (!response.ok) {
                            const data = await response.json().catch(() => ({}));
                            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
                        }

                        // Show success modal
                        showModal({
                            title: 'Workflow Deleted',
                            content: `<strong>${workflowName}</strong> has been successfully deleted.`,
                            autoClose: 2000,
                            onClose: () => {
                                loadWorkflows();
                            },
                            buttons: [
                                {
                                    label: 'OK',
                                    className: 'btn-blue',
                                    callback: ({ close }) => {
                                        close();
                                    }
                                }
                            ]
                        });
                    } catch (error) {
                        console.error('Error deleting workflow:', error);
                        showModal({
                            title: 'Error Deleting Workflow',
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
            }
        ]
    });
}

/**
 * Open modal to create a new workflow
 */
function openCreateModal() {
    showModal({
        title: 'Create New Workflow',
        type: 'input',
        input: {
            label: 'Workflow Name'
        },
        buttons: [
            {
                label: 'Cancel',
                className: 'btn-grey',
                callback: ({ close }) => close()
            },
            {
                label: 'Create',
                className: 'btn-blue',
                callback: async ({ close, inputValue, setError }) => {
                    const workflowName = inputValue?.trim();
                    
                    if (!workflowName) {
                        setError('Workflow name is required');
                        return;
                    }
                    
                    close();
                    
                    const newId = generateUUID();
                    const newWorkflow = {
                        id: newId,
                        name: workflowName,
                        version: '1.0.0',
                        folder_id: null,
                        definition: {
                            id: newId,
                            name: workflowName,
                            folder_id: null,
                            view: { pan: '0,0', zoom: 1 },
                            steps: [{
                                id: generateUUID(),
                                name: 'BEGIN',
                                type: 'Begin',
                                width: 3,
                                height: 1,
                                position: '1,1',
                                variables: [],
                                overrideSize: false
                            }],
                            version: '1.0.0',
                            active: true,
                            inputs: [],
                            outputs: [],
                            metadata: {
                                created_at: new Date().toISOString(),
                                created_by: getUser(),
                                updated_at: new Date().toISOString(),
                                updated_by: getUser()
                            }
                        }
                    };
                    
                    try {
                        const payload = {
                            id: newId,
                            name: newWorkflow.name,
                            version: newWorkflow.version,
                            folder_id: newWorkflow.folder_id,
                            definition: newWorkflow.definition
                        };

                        console.log('Creating workflow with payload:', payload);

                        const response = await fetch('https://app.equinoxits.com:1139/kore/workflows', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Session-Token': sessionToken,
                                'X-User': getUser()
                            },
                            body: JSON.stringify(payload)
                        });

                        if (!response.ok) {
                            const data = await response.json().catch(() => ({}));
                            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
                        }

                        const result = await response.json();
                        
                        // Refresh the workflow list
                        await loadWorkflows();
                        
                        // Close the modal
                        close();
                        
                        // Redirect to editor
                        window.location.href = `workflow-edit.html?id=${newId}`;
                    } catch (error) {
                        console.error('Error creating workflow:', error);
                        showModal({
                            title: 'Error Creating Workflow',
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
            }
        ]
    });
}