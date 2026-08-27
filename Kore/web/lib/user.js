/**
 * user.js
 *
 * Functions for the standalone User Preferences page (self-service "change
 * my own password" only - see _userpreferences.html). Split out of
 * settings.js because none of this is used by any other page, including
 * the Users tab of the main Settings page (which is built on separate
 * generic entity infrastructure - loadEntityListGeneric('user', ...),
 * displayEntityDetailsGeneric('user', ...) - and the /users REST API,
 * not the profile/notification-preference endpoints this file calls).
 *
 * Requires base.js to be loaded first (defines getSessionToken, getUser,
 * switchTab, window.showStatusBanner, window.initializeUnsavedTracking,
 * window.checkUnsavedChanges, window.hasUnsavedChanges,
 * window.getCurrentUserData, window.getUserNotificationPreferences,
 * window.updateUserProfile, window.updateUserNotificationPreferences).
 */

let currentUser = getUser();  // Initialize once at module load
let sessionToken = null;      // Lazy-initialized on first async use

// ============================================================================
// USER PREFERENCES TAB FUNCTIONS
// ============================================================================

/**
 * Attach change/input listeners to every field in the User Preferences tab
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

// ============================================================================
// EXPORTS TO WINDOW
// ============================================================================
window.attachUserPrefsFormListeners = attachUserPrefsFormListeners;
window.changeUserPassword = changeUserPassword;
window.checkNotificationUnsavedChanges = checkNotificationUnsavedChanges;
window.checkPasswordUnsavedChanges = checkPasswordUnsavedChanges;
window.checkUserPrefUnsavedChanges = checkUserPrefUnsavedChanges;
window.loadUserPreferences = loadUserPreferences;
window.saveUserPreferencesData = saveUserPreferencesData;
window.switchToUserPreferencesTab = switchToUserPreferencesTab;
window.updateUserPrefsSaveButtonState = updateUserPrefsSaveButtonState;