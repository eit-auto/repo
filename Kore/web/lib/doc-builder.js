/**
 * doc-builder.js — Codex doc editor (title, type, linked resource,
 * markdown content, folder, tags, related docs, version history).
 *
 * Imports docs.js (which imports base.js) rather than base.js directly,
 * purely to get window.renderMarkdown for the live preview pane without
 * duplicating the markdown parser - same ES-module-guarantees-load-order
 * trick user-portal.js uses for base.js.
 */
import '/lib/docs.js';

// ============================================================
// STATE
// ============================================================

let _docId = null;
let _currentDoc = null;   // last-loaded/last-saved doc from the server
let _currentTags = [];    // working copy, edited via the pill input
let _docFolders = [];
let _selectedFolderId = null; // null = "No Folder"
let _allOtherDocs = [];   // for the related-docs multi-select options

function getDocIdFromQuery() {
    return new URLSearchParams(window.location.search).get('id');
}

// ============================================================
// LOAD
// ============================================================

async function fetchDoc(id) {
    const response = await fetch(`/kore/docs/${encodeURIComponent(id)}`, { method: 'GET', credentials: 'include' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
}

async function fetchDocFolders() {
    const response = await fetch('/kore/doc-folders', { method: 'GET', credentials: 'include' });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    return data.folders || [];
}

async function fetchAllDocs() {
    const response = await fetch('/kore/docs', { method: 'GET', credentials: 'include' });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    return data.docs || [];
}

async function fetchDocHistory(id) {
    const response = await fetch(`/kore/docs/${encodeURIComponent(id)}/history`, { method: 'GET', credentials: 'include' });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    return data.history || [];
}

// ============================================================
// RENDER — FIELDS
// ============================================================

// ============================================================
// LINKED RESOURCE — the actual fetch/render/cache logic lives in
// docs.js (window.renderLinkedResourcePicker / renderLinkedTaskPicker /
// getLinkedResourcePickerValue), shared with docs.html's New Doc modal.
// docs.js is already imported above for renderMarkdown, so nothing
// extra to load - this section just wires those shared functions to
// this page's own element ids and adds the page-specific bookkeeping
// (onDocFieldChange) they don't know about.
// ============================================================

const DB_LINKED_PICKER_IDS = {
    selectId: 'dbLinkedIdInput',
    taskRowId: 'dbLinkedTaskRow',
    pluginSelectId: 'dbLinkedPluginSelect',
    taskSelectId: 'dbLinkedTaskSelect'
};

/**
 * Plugin sub-select's onchange - loads that plugin's tasks fresh (no
 * saved task to preserve, since changing the plugin invalidates whatever
 * task was previously chosen).
 */
async function onLinkedPluginChange() {
    const pluginName = document.getElementById('dbLinkedPluginSelect').value;
    await window.renderLinkedTaskPicker(DB_LINKED_PICKER_IDS, pluginName, null);
    onDocFieldChange();
}
window.onLinkedPluginChange = onLinkedPluginChange;

/**
 * Type select's onchange. Switching type always resets Linked Resource
 * to blank (a resource id valid for one type isn't meaningful for
 * another), unlike populateFields()'s initial load which preserves the
 * doc's saved selection.
 */
async function onDocTypeChange() {
    const type = document.getElementById('dbTypeSelect').value;
    await window.renderLinkedResourcePicker(DB_LINKED_PICKER_IDS, type, null);

    // Dynamic title doesn't apply to 'general' (nothing to resolve
    // against) - force it off and re-enable the Title input, same as a
    // doc that was never dynamic. Switching to any other type just
    // re-enables the checkbox; it doesn't auto-check it, since Linked
    // Resource just got reset to blank and there's nothing to preview yet.
    const dynamicTitleCheckbox = document.getElementById('dbDynamicTitleCheckbox');
    if (type === 'general') {
        dynamicTitleCheckbox.checked = false;
        dynamicTitleCheckbox.disabled = true;
        document.getElementById('dbTitleInput').disabled = false;
    } else {
        dynamicTitleCheckbox.disabled = false;
    }

    onDocFieldChange();
}
window.onDocTypeChange = onDocTypeChange;

/**
 * Dynamic title checkbox's onchange. Toggles the Title input's disabled
 * state, and - only on the transition to checked - tries an immediate
 * live preview via resolveLiveResourceTitle() so the person sees what
 * it'll actually save as right away, rather than only finding out at
 * Save time. If no resource is selected yet, or the lookup fails, the
 * input just stays showing whatever it already had (the last-known
 * cached title, most likely) - Save always does the authoritative
 * resolve regardless of whether this preview succeeded.
 */
async function onDynamicTitleChange() {
    const checkbox = document.getElementById('dbDynamicTitleCheckbox');
    const titleInput = document.getElementById('dbTitleInput');
    titleInput.disabled = checkbox.checked;

    if (checkbox.checked) {
        const type = document.getElementById('dbTypeSelect').value;
        const resourceId = getCurrentLinkedResourceId();
        try {
            const liveTitle = await window.resolveLiveResourceTitle(type, resourceId);
            if (liveTitle) titleInput.value = liveTitle;
        } catch (err) {
            console.error('[Codex] Failed to preview live title:', err.message);
        }
    }

    onDocFieldChange();
}
window.onDynamicTitleChange = onDynamicTitleChange;

async function populateFields(doc) {
    document.getElementById('dbHeading').textContent = doc.title;
    document.title = `Editing: ${doc.title} — Codex`;
    document.getElementById('dbVersionBadge').textContent = `v${doc.version}`;
    document.getElementById('dbIdValue').textContent = doc.id;
    // dbViewLink is now a <button> (not an <a>) so it visually matches
    // Delete/Save exactly - <button class="btn"> doesn't get
    // font-family: inherit from base_css.js the way text inputs do, so
    // an <a class="btn"> (which inherits the page font naturally) looked
    // visibly different from the other two. viewCurrentDoc() below
    // handles the actual navigation.

    document.getElementById('dbTitleInput').value = doc.title || '';
    document.getElementById('dbTypeSelect').value = doc.linkedResourceType || 'general';
    document.getElementById('dbContentTextarea').value = doc.content || '';

    // Dynamic title - checkbox reflects the doc's saved state; the Title
    // input is disabled while it's on, since `title` is the maintained
    // cache in that case (kept current at Save time, and in bulk by the
    // server's refresh-titles maintenance task) rather than something to
    // hand-type. Doesn't apply to 'general' docs (nothing to resolve
    // against), so the checkbox itself is disabled there.
    const dynamicTitleCheckbox = document.getElementById('dbDynamicTitleCheckbox');
    const isGeneral = (doc.linkedResourceType || 'general') === 'general';
    dynamicTitleCheckbox.checked = !isGeneral && !!doc.dynamicTitle;
    dynamicTitleCheckbox.disabled = isGeneral;
    document.getElementById('dbTitleInput').disabled = dynamicTitleCheckbox.checked;

    // Awaited (not fired-and-forgotten) because currentFormSnapshot() reads
    // dbLinkedIdInput's value immediately after init() calls this, to set
    // the unsaved-changes baseline - that has to reflect the doc's actual
    // saved linkedResourceId, not a still-loading/blank select.
    await window.renderLinkedResourcePicker(DB_LINKED_PICKER_IDS, doc.linkedResourceType || 'general', doc.linkedResourceId || null);

    _currentTags = Array.isArray(doc.tags) ? [...doc.tags] : [];
    renderTagPills();

    _selectedFolderId = doc.folderId || null;

    renderContentPreview();

    // Permission gating - if the caller can't edit, hide the destructive
    // controls and make the form read-only rather than letting them type
    // into fields a save would just get rejected on.
    const canEdit = doc.canEdit !== false;
    const canDelete = doc.canDelete !== false;
    document.getElementById('dbSaveBtn').style.display = canEdit ? '' : 'none';
    document.getElementById('dbDeleteBtn').style.display = canDelete ? '' : 'none';
    const importBtn = document.getElementById('dbImportBtn');
    if (importBtn) importBtn.style.display = canEdit ? '' : 'none';
    if (!canEdit) {
        ['dbTitleInput', 'dbTypeSelect', 'dbLinkedIdInput', 'dbLinkedPluginSelect', 'dbLinkedTaskSelect', 'dbContentTextarea', 'dbTagsInput', 'dbDynamicTitleCheckbox'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = true;
        });
    }
}

function renderContentPreview() {
    const textarea = document.getElementById('dbContentTextarea');
    const preview = document.getElementById('dbContentPreview');
    if (!textarea || !preview) return;

    const value = textarea.value;
    preview.innerHTML = value.trim()
        ? window.renderMarkdown(value)
        : `<span class="db-preview-empty">Nothing to preview yet.</span>`;
}

function onContentInput() {
    renderContentPreview();
    onDocFieldChange();
}
window.onContentInput = onContentInput;

// ============================================================
// TAGS — freeform pill input
//
// Deliberately NOT base.js's initializeMultiSelect widget (that's built
// for a fixed option list with a checklist dropdown - see the Type
// filter on docs.html). Tags are arbitrary user-typed strings with no
// fixed set, so this is a small standalone add/remove-pill widget instead.
// ============================================================

function renderTagPills() {
    const row = document.getElementById('dbTagsInputRow');
    const input = document.getElementById('dbTagsInput');
    if (!row || !input) return;

    row.querySelectorAll('.db-tag-pill').forEach(el => el.remove());

    _currentTags.forEach(tag => {
        const pill = document.createElement('span');
        pill.className = 'db-tag-pill';
        pill.innerHTML = `${window.escapeHtml(tag)} <button type="button" class="db-tag-pill-remove" aria-label="Remove ${window.escapeHtml(tag)}">&times;</button>`;
        pill.querySelector('.db-tag-pill-remove').addEventListener('click', () => {
            _currentTags = _currentTags.filter(t => t !== tag);
            renderTagPills();
            onDocFieldChange();
        });
        row.insertBefore(pill, input);
    });
}

function addTagFromInput() {
    const input = document.getElementById('dbTagsInput');
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return;

    // Support comma-separated paste as well as one-at-a-time typing
    raw.split(',').map(t => t.trim()).filter(Boolean).forEach(tag => {
        if (!_currentTags.includes(tag)) _currentTags.push(tag);
    });

    input.value = '';
    renderTagPills();
    onDocFieldChange();
}

function wireTagsInput() {
    const input = document.getElementById('dbTagsInput');
    if (!input) return;
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTagFromInput();
        } else if (e.key === 'Backspace' && input.value === '' && _currentTags.length > 0) {
            // Backspace on an empty input removes the last pill, same
            // convention as most tag-input widgets.
            _currentTags.pop();
            renderTagPills();
            onDocFieldChange();
        }
    });
    input.addEventListener('blur', addTagFromInput);
}

// ============================================================
// FOLDER PICKER
//
// Compact single-select tree, same visual pattern as the Import modal's
// folder tree in docs.js (not the full buildFoldersPanel sidebar with
// create/edit/delete controls - folder management itself stays on the
// /docs browse page, this is just "which folder is this doc in").
// ============================================================

function renderFolderPicker() {
    const container = document.getElementById('dbFolderTree');
    if (!container) return;
    container.innerHTML = '';

    const resetHighlights = () => {
        container.querySelectorAll('[data-item-id]').forEach(el => { el.style.background = 'transparent'; });
        noFolderDiv.style.background = 'transparent';
    };

    const noFolderDiv = document.createElement('div');
    noFolderDiv.style.cssText = 'padding: 6px 8px; cursor: pointer; border-radius: 3px; margin-bottom: 4px; font-size: 12px; font-style: italic;';
    noFolderDiv.textContent = 'No Folder';
    noFolderDiv.onclick = () => {
        _selectedFolderId = null;
        resetHighlights();
        noFolderDiv.style.background = 'rgba(126, 200, 255, 0.2)';
        onDocFieldChange();
    };
    container.appendChild(noFolderDiv);

    if (_docFolders.length > 0) {
        const treeDiv = document.createElement('div');
        window.renderTree(_docFolders, treeDiv, {
            onItemClick: (folder) => {
                _selectedFolderId = folder.id;
                resetHighlights();
                const selectedEl = treeDiv.querySelector(`[data-item-id="${folder.id}"]`);
                if (selectedEl) selectedEl.style.background = 'rgba(126, 200, 255, 0.2)';
                onDocFieldChange();
            }
        });
        container.appendChild(treeDiv);
    }

    // Reflect whatever's currently selected (from the loaded doc, or a
    // prior click this session) after every rebuild.
    if (_selectedFolderId) {
        const selectedEl = container.querySelector(`[data-item-id="${_selectedFolderId}"]`);
        if (selectedEl) selectedEl.style.background = 'rgba(126, 200, 255, 0.2)';
    } else {
        noFolderDiv.style.background = 'rgba(126, 200, 255, 0.2)';
    }
}

// ============================================================
// RELATED DOCS — reuses base.js's multi-select widget (same one the
// Type filter on docs.html uses), since this IS a bounded, searchable
// option list — every other active doc, {value: id, label: title}.
// ============================================================

function renderRelatedPicker(selectedIds) {
    const container = document.getElementById('dbRelatedContainer');
    if (!container) return;

    // initializeMultiSelect's (base.js) "attach listeners only once" guard
    // is a data-* attribute stored on the container element - but
    // container.innerHTML below only replaces its CHILDREN, not the
    // container's own attributes. On a second call to this function (e.g.
    // Import calling it after the page's own initial render already did),
    // the guard sees itself already set and skips re-attaching every click
    // listener to the brand-new child elements just created, leaving the
    // widget visually present but completely non-interactive. Clearing it
    // here forces initializeMultiSelect to treat this as a fresh container
    // and actually bind listeners to what's really in the DOM now.
    container.removeAttribute('data-ms-listeners-attached');

    container.innerHTML = window.renderMultiSelectContainer('dbRelated', 'dbRelated');

    const options = _allOtherDocs
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map(doc => ({ value: doc.id, label: doc.title }));

    window.initializeMultiSelect(container, options, selectedIds, {
        searchable: true,
        onChange: () => onDocFieldChange()
    });
}

function getSelectedRelatedIds() {
    const hiddenSelect = document.querySelector('#dbRelatedContainer .multi-select-hidden-select');
    if (!hiddenSelect) return [];
    return Array.from(hiddenSelect.selectedOptions).map(opt => opt.value);
}

// ============================================================
// VERSION HISTORY (read-only preview - no restore yet)
// ============================================================

function formatHistoryDate(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function loadDocHistory() {
    const container = document.getElementById('dbHistoryList');
    if (!container) return;

    try {
        const history = await fetchDocHistory(_docId);
        if (history.length === 0) {
            container.innerHTML = `<div style="font-size:12px;color:var(--text-muted)">No history yet.</div>`;
            return;
        }

        container.innerHTML = history.map(h => `
            <div class="db-history-row" data-version="${window.escapeHtml(h.version)}">
                <span class="db-history-version">v${window.escapeHtml(h.version)}</span>
                <span class="db-history-date">${formatHistoryDate(h.created_at)}</span>
                ${h.deleted ? '<span class="db-history-deleted">Deleted</span>' : ''}
            </div>
        `).join('');

        container.querySelectorAll('.db-history-row').forEach(row => {
            row.addEventListener('click', () => previewHistoryVersion(row.dataset.version));
        });
    } catch (err) {
        console.error('[Codex] Failed to load doc history:', err.message);
        container.innerHTML = `<div style="font-size:12px;color:var(--text-muted)">Couldn't load history.</div>`;
    }
}

/**
 * Read-only preview of a past version in a modal. Deliberately doesn't
 * offer "restore" yet - that needs a real decision about whether restoring
 * creates a new version (safe, keeps history linear) or overwrites, and
 * this wasn't asked for, so leaving it view-only for now.
 */
async function previewHistoryVersion(version) {
    try {
        const response = await fetch(`/kore/docs/${encodeURIComponent(_docId)}/${encodeURIComponent(version)}`, { method: 'GET', credentials: 'include' });
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        const doc = await response.json();

        const content = document.createElement('div');
        content.innerHTML = `
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
                ${window.escapeHtml(doc.title)} — v${window.escapeHtml(String(doc.version))}
            </div>
            <div class="db-preview" style="height:300px">
                ${doc.content ? window.renderMarkdown(doc.content) : '<span class="db-preview-empty">No content in this version.</span>'}
            </div>
        `;

        window.showModal({
            title: `Version ${version}`,
            content,
            resizable: true,
            width: '600px',
            buttons: [{ label: 'Close', type: 'secondary' }]
        });
    } catch (err) {
        console.error('[Codex] Failed to load history version:', err.message);
        window.showModal({
            title: 'Error',
            content: `Couldn't load that version: ${err.message}`,
            buttons: [{ label: 'OK', type: 'primary' }]
        });
    }
}

// ============================================================
// UNSAVED-CHANGES TRACKING
// ============================================================

function getCurrentLinkedResourceId() {
    const type = document.getElementById('dbTypeSelect').value;
    return window.getLinkedResourcePickerValue(DB_LINKED_PICKER_IDS, type);
}

function currentFormSnapshot() {
    return {
        title: document.getElementById('dbTitleInput').value.trim(),
        dynamicTitle: document.getElementById('dbDynamicTitleCheckbox').checked,
        linkedResourceType: document.getElementById('dbTypeSelect').value,
        linkedResourceId: getCurrentLinkedResourceId(),
        content: document.getElementById('dbContentTextarea').value,
        tags: [..._currentTags].sort(),
        related: getSelectedRelatedIds().sort(),
        folderId: _selectedFolderId
    };
}

/**
 * Live duplicate check: does another active doc already have this same
 * linkedResourceType + linkedResourceId? Reuses _allOtherDocs (already
 * fetched in init() for the Related picker's options - no separate
 * endpoint needed) rather than hitting the server on every change. This
 * is a UX convenience layer, not the authoritative check - createDoc/
 * updateDoc in resources.js enforce the same constraint server-side
 * (_assertNoDuplicateLinkedResource), which is what actually prevents a
 * race (two people linking the same resource at once) or a bypass via
 * Import/direct API calls. If this client-side check and the server
 * ever disagree, the server wins and Save will fail with its own error.
 */
function checkDuplicateLinkedResource() {
    const errorEl = document.getElementById('dbLinkedIdError');
    if (!errorEl) return false;

    const type = document.getElementById('dbTypeSelect').value;
    const resourceId = getCurrentLinkedResourceId();

    if (!resourceId || type === 'general') {
        errorEl.style.display = 'none';
        errorEl.innerHTML = '';
        return false;
    }

    const duplicate = _allOtherDocs.find(d => d.linkedResourceType === type && d.linkedResourceId === resourceId);

    if (duplicate) {
        const typeLabel = window.docTypeLabel ? window.docTypeLabel(type) : type;
        errorEl.innerHTML = `A doc already exists for this ${window.escapeHtml(typeLabel)}: <a href="/doc?id=${encodeURIComponent(duplicate.id)}" target="_blank">${window.escapeHtml(duplicate.title)}</a>. Pick a different resource, or edit that doc instead.`;
        errorEl.style.display = 'block';
        return true;
    }

    errorEl.style.display = 'none';
    errorEl.innerHTML = '';
    return false;
}

function onDocFieldChange() {
    window.checkUnsavedChanges(currentFormSnapshot());
    const hasDuplicate = checkDuplicateLinkedResource();
    const saveBtn = document.getElementById('dbSaveBtn');
    if (saveBtn) saveBtn.disabled = hasDuplicate || !window.hasUnsavedChanges();
}
window.onDocFieldChange = onDocFieldChange;

// ============================================================
// SAVE / DELETE / COPY ID
// ============================================================

async function saveCurrentDoc() {
    const dynamicTitleChecked = document.getElementById('dbDynamicTitleCheckbox').checked;
    let title = document.getElementById('dbTitleInput').value.trim();

    // Dynamic title: resolve the live name now, at Save, rather than
    // trusting whatever's sitting in the (disabled) Title input - that
    // could be stale from before this session started. This is the one
    // point where a dynamic doc's cached title actually gets refreshed
    // client-side; the server's refresh-titles maintenance task is the
    // other (see resources.js's refreshDynamicTitles()).
    if (dynamicTitleChecked) {
        const type = document.getElementById('dbTypeSelect').value;
        const resourceId = getCurrentLinkedResourceId();
        const liveTitle = await window.resolveLiveResourceTitle(type, resourceId);
        if (liveTitle) {
            title = liveTitle;
            document.getElementById('dbTitleInput').value = title; // reflect what's actually about to save
        } else if (!title) {
            // No live resolve AND no cached fallback (e.g. a brand-new doc
            // with no resource selected yet) - nothing to save as a title.
            window.showStatusBanner('Could not resolve a title for the linked resource - select one, or uncheck Dynamic title and enter a title manually', 'error');
            return;
        }
        // else: live resolve failed but a last-known cached title exists -
        // proceed with that rather than blocking the whole save on it.
    }

    if (!title) {
        window.showStatusBanner('Title is required', 'error');
        return;
    }

    // Belt-and-suspenders: Save is already disabled while a duplicate
    // exists (onDocFieldChange), this just guards against a stray click
    // slipping through on a stale disabled state. The server's own check
    // in createDoc/updateDoc is still the real enforcement either way.
    if (checkDuplicateLinkedResource()) {
        window.showStatusBanner('Resolve the duplicate linked resource before saving', 'error');
        return;
    }

    const payload = currentFormSnapshot();
    payload.title = title;

    try {
        const response = await fetch(`/kore/docs/${encodeURIComponent(_docId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}`);
        }
        const result = await response.json();

        document.getElementById('dbVersionBadge').textContent = `v${result.version}`;
        window.initializeUnsavedTracking(currentFormSnapshot());
        document.getElementById('dbSaveBtn').disabled = true;
        window.showStatusBanner(`Saved (v${result.version})`, 'success');

        loadDocHistory();
    } catch (error) {
        console.error('[Codex] Error saving doc:', error.message);
        window.showStatusBanner(`Error saving: ${error.message}`, 'error');
    }
}
window.saveCurrentDoc = saveCurrentDoc;

function deleteCurrentDoc() {
    window.showDeleteConfirm(
        'Delete this doc? This can\'t be undone from the UI, though its version history is retained.',
        async () => {
            try {
                const response = await fetch(`/kore/docs/${encodeURIComponent(_docId)}`, {
                    method: 'DELETE',
                    credentials: 'include'
                });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${response.status}`);
                }
                window.location.href = '/docs';
            } catch (error) {
                console.error('[Codex] Error deleting doc:', error.message);
                window.showStatusBanner(`Error deleting: ${error.message}`, 'error');
            }
        }
    );
}
window.deleteCurrentDoc = deleteCurrentDoc;

function viewCurrentDoc() {
    if (!_docId) return;
    window.location.href = `/doc?id=${encodeURIComponent(_docId)}`;
}
window.viewCurrentDoc = viewCurrentDoc;

function copyDocId() {
    if (!_docId) return;
    navigator.clipboard.writeText(_docId).then(() => {
        window.showStatusBanner('Doc ID copied', 'success', 'statusMessage', 2000);
    }).catch(() => {
        window.showStatusBanner('Could not copy ID', 'error');
    });
}
window.copyDocId = copyDocId;

// ============================================================
// IMPORT INTO OPEN DOC
//
// Different in kind from docs.js's openImportDocModal() (the list page's
// Import, which creates a brand-new doc via POST /kore/docs and redirects
// here). This one populates the ALREADY-OPEN doc's editable fields from
// pasted JSON, without saving anything itself - the person reviews what
// landed in the form (title/content/tags/related/etc. all become visible
// via the normal unsaved-changes diff) and clicks the existing Save
// button themselves when ready. Better fit for importing an *update* to
// an existing doc than the list page's create-only flow.
//
// Same JSON shape as the list page's Import: { title, dynamicTitle?,
// linkedResourceType?, linkedResourceId?, content?, tags?, related? }.
// Deliberately does NOT touch id, version, or folderId - id/version
// reflect the real, currently-open doc's identity and aren't something a
// pasted definition should override; folder is a workspace/organizational
// choice, not doc content, same reasoning as the list page's Import
// leaving it to the tree picker rather than the JSON.
// ============================================================

function openImportIntoBuilderModal() {
    const modalContent = document.createElement('div');
    modalContent.style.cssText = 'display: flex; flex-direction: column; height: 100%;';
    modalContent.innerHTML = `
        <div style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
            <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary); flex-shrink: 0;">Doc Definition JSON</label>
            <textarea id="dbImportDefinitionInput" placeholder="Paste the doc definition JSON here"
                style="width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.8rem; padding: 10px;
                       border: 1px solid var(--border-primary); border-radius: 4px; background: var(--bg-input); color: var(--text-primary); resize: vertical; flex: 1; min-height: 0;"></textarea>
            <div style="margin-top: 8px; font-size: 0.75rem; color: var(--text-muted); flex-shrink: 0;">
                Populates this doc's fields for review - nothing is saved until you click Save yourself. Folder is left as-is.
            </div>
        </div>
    `;

    window.showModal({
        title: 'Import Definition',
        content: modalContent,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Import',
                type: 'success',
                // Same sync-onClick + inner-async-IIFE shape as docs.js's
                // Import modal, for the same reason - see that file's
                // comment on why this can't just be `async () => {...}`.
                onClick: () => {
                    (async () => {
                        const rawJson = modalContent.querySelector('#dbImportDefinitionInput').value.trim();
                        if (!rawJson) {
                            window.showStatusBanner('Paste a doc definition JSON before importing.', 'error');
                            return;
                        }

                        let definition;
                        try {
                            definition = JSON.parse(rawJson);
                        } catch (e) {
                            window.showStatusBanner(`Invalid JSON: ${e.message}`, 'error');
                            return;
                        }

                        if (!definition.title) {
                            window.showStatusBanner('Definition must include a "title".', 'error');
                            return;
                        }

                        // Everything below this point previously had no
                        // outer error handling - any exception here (e.g.
                        // from renderLinkedResourcePicker, fetchAllDocs, or
                        // anything else awaited) would silently abort the
                        // rest of the import with nothing visible to the
                        // person, and no way to tell it happened short of
                        // an open browser console. Wrapping the whole body
                        // so a real failure actually surfaces.
                        try {
                            const type = definition.linkedResourceType || 'general';

                            document.getElementById('dbTypeSelect').value = type;

                            const dynamicTitleCheckbox = document.getElementById('dbDynamicTitleCheckbox');
                            const isGeneral = type === 'general';
                            dynamicTitleCheckbox.checked = !isGeneral && !!definition.dynamicTitle;
                            dynamicTitleCheckbox.disabled = isGeneral;

                            const titleInput = document.getElementById('dbTitleInput');
                            titleInput.value = definition.title;
                            titleInput.disabled = dynamicTitleCheckbox.checked;

                            // Awaited for the same reason populateFields() awaits it -
                            // onDocFieldChange() below reads the linked-resource
                            // picker's value immediately after, which needs the
                            // picker actually rendered first, not still in flight.
                            await window.renderLinkedResourcePicker(DB_LINKED_PICKER_IDS, type, definition.linkedResourceId || null);

                            document.getElementById('dbContentTextarea').value = definition.content || '';
                            renderContentPreview();

                            _currentTags = Array.isArray(definition.tags) ? [...definition.tags] : [];
                            renderTagPills();

                            // Refresh the related-picker's option source before
                            // applying imported related ids - _allOtherDocs is
                            // otherwise only fetched once, at page load.
                            // initializeMultiSelect (base.js) builds the hidden
                            // <select>'s <option>s entirely from the offered
                            // options list, checking each against selectedValues -
                            // an id in selectedValues that isn't among options at
                            // all silently never becomes selected, no error. If
                            // this doc-builder page was already open before some
                            // referenced doc got created (exactly the shape of a
                            // multi-doc Import session), the stale snapshot would
                            // silently drop it. Best-effort - if the refetch
                            // fails, fall back to whatever's already loaded
                            // rather than blocking the rest of the import.
                            try {
                                const refreshedDocs = await fetchAllDocs();
                                _allOtherDocs = refreshedDocs.filter(d => d.id !== _docId);
                            } catch (err) {
                                console.error('[Codex] Failed to refresh docs list before import:', err.message);
                            }

                            const importedRelated = Array.isArray(definition.related) ? definition.related : [];
                            const availableIds = new Set(_allOtherDocs.map(d => d.id));
                            const missingRelated = importedRelated.filter(id => !availableIds.has(id));
                            if (missingRelated.length > 0) {
                                // These ids exist in the pasted definition but not in
                                // what fetchAllDocs() just returned for this user - the
                                // picker's options are built entirely from
                                // _allOtherDocs, so an id that isn't in it can never be
                                // marked selected (initializeMultiSelect only creates
                                // <option> elements from the offered options list).
                                // Surfacing exactly which ids, rather than a vague
                                // "some related items didn't import", since this is
                                // the single most useful fact for figuring out whether
                                // it's a permissions gap, a genuinely wrong/stale id,
                                // or something else entirely.
                                console.warn('[Codex] These related ids were not found in the available docs list and could not be selected:', missingRelated);
                                window.showStatusBanner(
                                    `${missingRelated.length} related doc id(s) not found in your available docs list, so they couldn't be selected: ${missingRelated.join(', ')}`,
                                    'error',
                                    'statusMessage',
                                    10000
                                );
                            }

                            renderRelatedPicker(importedRelated);

                            // Folder deliberately untouched - see header comment above.

                            onDocFieldChange();
                            window.closeModal();
                            window.showStatusBanner('Definition imported - review the fields, then Save when ready.', 'success', 'statusMessage', 4000);
                        } catch (err) {
                            console.error('[Codex] Import failed partway through:', err);
                            window.showStatusBanner(`Import failed: ${err.message} (see console for details) - some fields may be partially updated`, 'error');
                        }
                    })();
                    return false;
                }
            }
        ],
        width: '600px',
        height: '90vh'
    });
}
window.openImportIntoBuilderModal = openImportIntoBuilderModal;

// ============================================================
// MARKDOWN REFERENCE MODAL
//
// Documents exactly what window.renderMarkdown (docs.js) actually
// implements - deliberately not a general Markdown cheat sheet, since
// this renderer is a small dependency-free subset (no tables, images,
// blockquotes, strikethrough, or nested lists). Showing syntax the
// renderer doesn't support would just produce confusing doc output.
// ============================================================

function openMarkdownHelpModal() {
    const rows = [
        { syntax: '# Heading 1\n## Heading 2\n### Heading 3\n#### H4  ##### H5  ###### H6', desc: 'Headings, 6 levels.' },
        { syntax: '**bold text**', desc: 'Bold.' },
        { syntax: '*italic text*', desc: 'Italic. Note: use * / ** only — _underscore_ and __double underscore__ aren\'t supported, to avoid mangling snake_case words.' },
        { syntax: '~~strikethrough~~', desc: 'Strikethrough.' },
        { syntax: '`inline code`', desc: 'Inline code.' },
        { syntax: '```\ncode block\n```', desc: 'Fenced code block. A language tag (```js) is accepted but not used for syntax highlighting.' },
        { syntax: '[link text](https://example.com)', desc: 'Link. Always opens in a new tab.' },
        { syntax: '![alt text](https://example.com/img.png "title")', desc: 'Image. Title in quotes is optional.' },
        { syntax: '> Quoted text\n>> Nested quote', desc: 'Blockquote. Can be nested by stacking >.' },
        { syntax: '---', desc: 'Horizontal rule. *** and ___ also work.' },
        { syntax: '- item\n  - nested item\n* item', desc: 'Bullet list. - or * both work, and can be nested by indenting.' },
        { syntax: '1. item\n2. item\n   - nested bullet', desc: 'Numbered list. Can mix nested bullet/numbered lists by indenting.' },
        { syntax: '| A | B |\n|---|---|\n| 1 | 2 |', desc: 'Table. Use :--- / :---: / ---: in the separator row for left/center/right alignment.' },
        { syntax: ':::details Section title\nhidden content\n:::', desc: 'Collapsible section — collapsed by default, click to expand. Can contain any other markdown, including a nested :::details block.' },
        { syntax: '(blank line)', desc: 'Starts a new paragraph.' }
    ];

    const content = document.createElement('div');
    content.innerHTML = `
        <table class="db-md-ref-table">
            <thead>
                <tr><th style="width:45%">Syntax</th><th>Result</th></tr>
            </thead>
            <tbody>
                ${rows.map(r => `
                    <tr>
                        <td><code>${window.escapeHtml(r.syntax)}</code></td>
                        <td>${window.escapeHtml(r.desc)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
        <div class="db-md-ref-note">A list item's text must be on one line — no multi-line/multi-paragraph content inside a single list item.</div>
    `;

    window.showModal({
        title: 'Markdown Reference',
        content,
        resizable: true,
        width: '600px',
        buttons: [{ label: 'Close', type: 'secondary' }]
    });
}
window.openMarkdownHelpModal = openMarkdownHelpModal;

// ============================================================
// INIT
// ============================================================

async function init() {
    _docId = getDocIdFromQuery();
    if (!_docId) {
        window.showStatusBanner('No doc ID provided', 'error');
        return;
    }

    wireTagsInput();

    let doc;
    try {
        doc = await fetchDoc(_docId);
    } catch (err) {
        console.error('[Codex] Failed to load doc:', err.message);
        window.showStatusBanner('Failed to load doc', 'error');
        return;
    }

    if (!doc) {
        window.showStatusBanner('Doc not found, or you don\'t have permission to view it', 'error');
        document.getElementById('dbSaveBtn').style.display = 'none';
        document.getElementById('dbDeleteBtn').style.display = 'none';
        return;
    }

    _currentDoc = doc;
    await populateFields(doc);

    // Folders, all-docs (for related), and history all load in parallel -
    // none of them block each other or the fields already on screen.
    const [folders, allDocs] = await Promise.all([
        fetchDocFolders().catch(err => { console.error('[Codex] Failed to load doc folders:', err.message); return []; }),
        fetchAllDocs().catch(err => { console.error('[Codex] Failed to load docs list:', err.message); return []; })
    ]);

    _docFolders = folders;
    _allOtherDocs = allDocs.filter(d => d.id !== _docId);

    renderFolderPicker();
    renderRelatedPicker((doc.related || []).map(r => r.id));

    // Surfaces a pre-existing conflict (e.g. one created via Import,
    // which doesn't go through this client-side check) even before the
    // user touches anything. Doesn't affect Save's disabled state here -
    // that's forced true below regardless, as the baseline.
    checkDuplicateLinkedResource();

    // Baseline for unsaved-changes tracking is taken AFTER the related
    // picker's initial render, since getSelectedRelatedIds() reads off
    // its hidden <select> - reading it before initializeMultiSelect()
    // populates that select would snapshot an empty related list.
    window.initializeUnsavedTracking(currentFormSnapshot());
    window.setupPageUnsavedChangesProtection();
    document.getElementById('dbSaveBtn').disabled = true;

    loadDocHistory();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}