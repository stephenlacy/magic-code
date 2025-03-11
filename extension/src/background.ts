// Chrome Extension Background Script
const API_URL = 'http://localhost:3000';
const POLLING_INTERVAL = 5; // seconds, reduced for quicker checking of new codes
const AUTH_CHECK_INTERVAL = 5; // seconds
const BADGE_ANIMATION_INTERVAL = 0.5; // seconds

// Set up periodic polling for new codes
chrome.runtime.onInstalled.addListener(() => {
  console.log('Magic Code extension installed');
  
  // Create alarm for polling magic codes
  chrome.alarms.create('checkNewCodes', {
    periodInMinutes: POLLING_INTERVAL / 60
  });
  
  // Create alarm for periodic auth checks
  chrome.alarms.create('checkAuth', {
    periodInMinutes: AUTH_CHECK_INTERVAL / 60
  });
  
  // Also check if there's a token in localStorage on startup
  checkForLocalStorageToken();
});

// Also check for authentication on startup
chrome.runtime.onStartup.addListener(() => {
  console.log('Magic Code extension started');
  
  // Check for auth tokens
  checkForLocalStorageToken();
});

// Listen for notification clicks
chrome.notifications.onClicked.addListener((notificationId) => {
  console.log(`Notification clicked: ${notificationId}`);
  
  // When user clicks on a notification, clear the badge
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: "#4285F4" });
  
  // Mark code as viewed if it's a code notification
  if (notificationId.includes('code-') || notificationId.includes('reminder-')) {
    chrome.storage.local.set({ 
      lastCodeViewed: Date.now(),
      codeNotificationClicked: true
    });
    
    console.log('Code marked as viewed via notification click');
    
    // Cancel any pending reminder alarm since user has now interacted
    chrome.alarms.clear('codeReminder', (wasCleared) => {
      if (wasCleared) {
        console.log('Cancelled pending code reminder alarm');
      }
    });
    
    // Set up alarm to reset notification status after 1 hour
    chrome.alarms.create('resetNotificationStatus', {
      delayInMinutes: 60 // Reset after 1 hour
    });
  }
  
  // Try to focus/open the popup
  try {
    chrome.action.openPopup();
    console.log('Opened popup in response to notification click');
  } catch (e) {
    console.error('Failed to open popup on notification click:', e);
    
    // Fallback to force open method
    forceOpenExtensionPopup().then(success => {
      console.log('Force open popup result:', success ? 'successful' : 'failed');
    });
  }
});

// Listen for notification button clicks
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  console.log(`Notification button clicked: ${notificationId}, button: ${buttonIndex}`);
  
  // "View Code" or "View Now" button was clicked
  if (buttonIndex === 0) {
    // Mark code as viewed
    chrome.storage.local.set({ 
      lastCodeViewed: Date.now(),
      codeNotificationClicked: true
    });
    
    console.log('Code marked as viewed via notification button click');
    
    // Cancel any pending reminder alarm since user has now interacted
    chrome.alarms.clear('codeReminder', (wasCleared) => {
      if (wasCleared) {
        console.log('Cancelled pending code reminder alarm');
      }
    });
    
    // Set up alarm to reset notification status after 1 hour
    // This ensures future notifications will work correctly
    chrome.alarms.create('resetNotificationStatus', {
      delayInMinutes: 60 // Reset after 1 hour
    });
    
    // Clear any badge
    chrome.action.setBadgeText({ text: "" });
    
    // Try to open popup
    try {
      chrome.action.openPopup();
      console.log('Opened popup in response to notification button click');
    } catch (e) {
      console.error('Failed to open popup on notification button click:', e);
      
      // Fallback to force open method
      forceOpenExtensionPopup().then(success => {
        console.log('Force open popup result:', success ? 'successful' : 'failed');
      });
    }
  }
});

// Listen for messages from the authentication page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Received message:', message, 'from:', sender);
  if (message.type === 'AUTH_TOKEN' && message.token) {
    console.log('Received auth token from web page with openPopup =', message.openPopup);
    
    // Store the token
    chrome.storage.local.set({ authToken: message.token }, () => {
      console.log('Auth token saved to Chrome storage');
      
      // Show a notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.svg',
        title: 'Magic Code',
        message: 'You have been signed in successfully!',
        priority: 2
      });
      
      // Respond to the sender
      sendResponse({ success: true });
      
      // Open the extension popup to show the authenticated state
      // Use the more aggressive popup opening if specifically requested
      if (message.openPopup) {
        // More aggressive attempt to make the user notice the extension
        console.log('Attempting strong popup opening (as requested)');
        forceOpenExtensionPopup().then(success => {
          console.log('Force open popup result:', success ? 'successful' : 'failed');
        });
      } else {
        // Standard approach
        openExtensionPopup().then(success => {
          console.log('Open popup result:', success ? 'successful' : 'failed');
        });
      }
    });
    
    // Keep the message channel open for the async response
    return true;
  } else if (message.type === 'OPEN_EXTENSION') {
    console.log('Received request to open extension via content script');
    
    // If there's a token, store it first
    if (message.token) {
      chrome.storage.local.set({ authToken: message.token }, () => {
        console.log('Auth token saved to Chrome storage from content script');
      });
    }
    
    // Force open the extension popup
    console.log('BACKGROUND: Processing OPEN_EXTENSION request, forceOpen:', message.forceOpen);
    
    // Using immediately invoked async function for cleaner promise handling
    (async () => {
      try {
        let success;
        let method;
        
        if (message.forceOpen) {
          method = 'force';
          success = await forceOpenExtensionPopup();
        } else {
          method = 'standard';
          success = await openExtensionPopup();
        }
        
        console.log(`BACKGROUND: ${method} open popup result:`, success ? 'successful' : 'failed');
        
        // Send response back
        sendResponse({ 
          success: success, 
          method: method,
          timestamp: Date.now() 
        });
      } catch (error) {
        console.error('BACKGROUND: Error opening popup:', error);
        sendResponse({ 
          success: false, 
          // @ts-ignore
          error: error.message,
          timestamp: Date.now() 
        });
      }
    })();
    
    // Keep the message channel open for the async response
    return true;
  } else if (message.type === 'LOGOUT') {
    console.log('BACKGROUND: Received logout message with force =', message.force);
    
    // Perform comprehensive logout
    const performLogout = async () => {
      // 1. Clear auth token immediately
      await chrome.storage.local.remove(['authToken']);
      console.log('BACKGROUND: Auth token removed');
      
      // 2. Clear all storage
      await new Promise<void>((resolve) => {
        chrome.storage.local.clear(() => {
          console.log('BACKGROUND: All Chrome storage cleared');
          resolve();
        });
      });
      
      // 3. Reset badge
      chrome.action.setBadgeText({ text: "" });
      console.log('BACKGROUND: Badge text cleared');
      
      // 4. Clear all alarms and recreate essential ones
      await new Promise<void>((resolve) => {
        chrome.alarms.clearAll(() => {
          console.log('BACKGROUND: All alarms cleared');
          
          // Recreate essential alarms with a delay
          setTimeout(() => {
            chrome.alarms.create('checkAuth', {
              periodInMinutes: 5 / 60
            });
            console.log('BACKGROUND: Essential alarms recreated');
            resolve();
          }, 100);
        });
      });
      
      // 5. Scan all tabs for localStorage tokens
      const tabs = await chrome.tabs.query({});
      console.log(`BACKGROUND: Checking ${tabs.length} tabs for localStorage tokens`);
      
      for (const tab of tabs) {
        if (tab.id && tab.url && tab.url.startsWith('http')) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const keysToRemove = [
                  'authToken',
                  'magicCodeAuthToken',
                  'auth_timestamp',
                  'auth_from_extension',
                  'extension_auth_timestamp'
                ];
                
                for (const key of keysToRemove) {
                  try {
                    localStorage.removeItem(key);
                  } catch (e) {
                    // Ignore errors for individual keys
                  }
                }
                return true;
              }
            });
            console.log(`BACKGROUND: Cleared localStorage in tab ${tab.id}`);
          } catch (err) {
            console.log(`BACKGROUND: Error clearing localStorage in tab ${tab.id}:`, err);
          }
        }
      }
      
      // 6. Final check
      const finalCheck = await chrome.storage.local.get('authToken');
      if (finalCheck.authToken) {
        console.warn('BACKGROUND: authToken still present after logout! Removing again.');
        await chrome.storage.local.remove(['authToken']);
      }
      
      // 7. Show a notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.svg',
        title: 'Magic Code',
        message: 'You have been signed out successfully',
        priority: 2
      });
      
      console.log('BACKGROUND: Logout process completed');
    };
    
    // Execute the logout process
    performLogout()
      .then(() => {
        console.log('BACKGROUND: Logout completed successfully');
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('BACKGROUND: Error during logout:', error);
        
        // Emergency cleanup
        chrome.storage.local.clear();
        chrome.action.setBadgeText({ text: "" });
        
        sendResponse({ success: false, error: error.message });
      });
    
    // Keep the message channel open for the async response
    return true;
  }
});

// Set up event listener for window messages
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('Received external message:', message, 'from:', sender.url);
  
  if (message.type === 'MAGIC_CODE_AUTH' && message.token) {
    console.log('Received auth token from external page:', message.token);
    
    // Store the token
    chrome.storage.local.set({ authToken: message.token }, () => {
      console.log('Auth token saved to Chrome storage from external message');
      
      // Show a notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.svg',
        title: 'Magic Code',
        message: 'Authentication successful!',
        priority: 2
      });
      
      // Respond to the sender
      sendResponse({ success: true });
      
      // Open the extension popup
      openExtensionPopup();
    });
    
    // Keep the message channel open for the async response
    return true;
  }
});

// Listen for tab updates to capture auth events
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if this is an auth callback completion
  if (
    changeInfo.status === 'complete' && 
    tab.url && (
      tab.url.includes('/auth-callback') || 
      tab.url.includes('/auth/google/callback') || 
      tab.url.includes('token=')
    )
  ) {
    console.log('Detected potential auth callback completion:', tab.url);
    
    // Wait a moment for the page to fully load and execute its scripts
    setTimeout(() => {
      // Extract token from URL if present
      let token = null;
      try {
        const url = new URL(tab.url!);
        token = url.searchParams.get('token');
      } catch (e) {
        console.log('Error parsing URL:', e);
      }
      
      if (token) {
        console.log('Found token in callback URL, saving to storage');
        chrome.storage.local.set({ authToken: token }, () => {
          console.log('Auth token from URL saved to Chrome storage');
          openExtensionPopup();
        });
      } else {
        // If no token in URL, check localStorage in the tab
        if (tabId) {
          checkTabForAuthToken(tabId);
        }
      }
    }, 1000);
  }
});

// Listen for alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkNewCodes') {
    checkForNewCodes();
  } else if (alarm.name === 'checkAuth') {
    checkAuthenticationStatus();
  } else if (alarm.name === 'codeReminder') {
    // Remind user about new code if they haven't viewed it
    handleCodeReminder();
  } else if (alarm.name === 'resetNotificationStatus') {
    // Reset notification click status after some time
    resetNotificationClickStatus();
  }
});

// Function to reset the notification click status
async function resetNotificationClickStatus() {
  try {
    console.log('Resetting notification click status');
    await chrome.storage.local.remove('codeNotificationClicked');
  } catch (error) {
    console.error('Error resetting notification status:', error);
  }
}

// Function to handle code reminder
async function handleCodeReminder() {
  try {
    // Get last code info and check if user has already interacted with the notification
    const data = await chrome.storage.local.get([
      'lastCode', 
      'lastCodeWebsite', 
      'lastCodeTimestamp', 
      'lastCodeViewed',
      'lastEmailId',
      'codeNotificationClicked'
    ]);
    
    // If user has already clicked on a notification, don't show a reminder
    if (data.codeNotificationClicked) {
      console.log('User has already interacted with a notification, skipping reminder');
      return;
    }
    
    // If we have a code and it wasn't viewed (or viewing timestamp is before the code timestamp)
    if (data.lastCode && 
        (!data.lastCodeViewed || data.lastCodeViewed < data.lastCodeTimestamp)) {
      
      console.log('User has not viewed the latest code, sending reminder');
      
      // Update badge with a "!" to indicate unread
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#F44336" }); // Red
      
      // Show reminder notification with a unique ID that includes email ID if available
      const emailIdSegment = data.lastEmailId ? `-${data.lastEmailId}` : '';
      const reminderId = `reminder-code${emailIdSegment}-${Date.now()}`;
      
      chrome.notifications.create(reminderId, {
        type: 'basic',
        iconUrl: 'icon.svg',
        title: 'Reminder: Magic Code Available',
        message: `Don't forget your code from ${data.lastCodeWebsite}: ${data.lastCode}`,
        priority: 2,
        requireInteraction: true,
        buttons: [
          { title: 'View Now' }
        ]
      });
      
      // Try to open the popup again
      try {
        chrome.action.openPopup();
        console.log('Attempted to open popup for reminder');
      } catch (e) {
        console.log('Failed to open popup on reminder:', e);
        
        // Fallback to force open method
        try {
          await forceOpenExtensionPopup();
        } catch (err) {
          console.error('All popup opening methods failed:', err);
        }
      }
    } else {
      console.log('No unviewed codes found, or all codes have been viewed');
    }
  } catch (error) {
    console.error('Error handling code reminder:', error);
  }
}

// Function to check authentication status
async function checkAuthenticationStatus() {
  try {
    // First check if we already have a token
    const data = await chrome.storage.local.get('authToken');
    if (data.authToken) {
      // We have a token, check if it's valid
      const response = await fetch(`${API_URL}/auth/status`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${data.authToken}`
        }
      });
      
      const result = await response.json();
      
      if (result.authenticated) {
        console.log('Auth token is valid');
        return; // Token is valid, no need to do anything
      } else {
        console.log('Auth token is invalid, clearing');
        // Token is invalid, clear it
        await chrome.storage.local.remove('authToken');
      }
    }
    
    // If we don't have a token or it's invalid, check all tabs
    checkAllTabsForToken();
  } catch (error) {
    console.error('Error checking auth status:', error);
  }
}

// Badge animation for new codes
async function animateBadgeForNewCode() {
  // Define colors for animation
  const colors = [
    "#FF5252", // Red
    "#FF4081", // Pink
    "#7C4DFF", // Deep Purple
    "#536DFE", // Indigo
    "#448AFF", // Blue
    "#40C4FF", // Light Blue
    "#64FFDA", // Teal
    "#69F0AE", // Green
    "#B2FF59", // Light Green
    "#EEFF41", // Lime
    "#FFFF00", // Yellow
    "#FFD740", // Amber
    "#FFAB40", // Orange
    "#FF6E40"  // Deep Orange
  ];
  
  // Set up animation cycle
  let animationCount = 0;
  const animationId = 'badge-animation-' + Date.now();
  
  // Save current animation ID to cancel if needed
  chrome.storage.local.set({ currentBadgeAnimation: animationId });
  
  // Create the interval for animation
  const animate = () => {
    // Check if this animation should continue
    chrome.storage.local.get('currentBadgeAnimation', (data) => {
      if (data.currentBadgeAnimation !== animationId) {
        // Another animation has started, stop this one
        console.log('Stopping badge animation as a new one has started');
        return;
      }
      
      const colorIndex = animationCount % colors.length;
      const badgeText = animationCount % 2 === 0 ? "NEW" : "CODE";
      
      // Update badge
      chrome.action.setBadgeText({ text: badgeText });
      chrome.action.setBadgeBackgroundColor({ color: colors[colorIndex] });
      
      // Continue animation for a limited time (60 cycles = ~30 seconds)
      animationCount++;
      if (animationCount < 60) {
        // Set up next frame
        setTimeout(animate, BADGE_ANIMATION_INTERVAL * 1000);
      } else {
        // End animation, set final state
        chrome.action.setBadgeText({ text: "✓" });
        chrome.action.setBadgeBackgroundColor({ color: "#00C853" });
        
        // Clear animation ID after it completes
        chrome.storage.local.remove('currentBadgeAnimation');
      }
    });
  };
  
  // Start animation
  animate();
}

// Check for new magic codes
async function checkForNewCodes() {
  try {
    // Get auth token and tracked emails from storage
    const data = await chrome.storage.local.get([
      'authToken', 
      'lastCodeId',
      'processedEmailIds'  // Track emails we've already processed
    ]);
    
    const authToken = data.authToken;
    const lastCodeId = data.lastCodeId || 0;
    const processedEmailIds = data.processedEmailIds || [];
    console.log('processedEmailIds', processedEmailIds);
    
    if (!authToken) {
      console.log('No auth token found, user not logged in');
      return;
    }
    
    console.log('Checking for new magic codes...');
    
    // Make API request with a specific format parameter to request clean output
    const response = await fetch(`${API_URL}/api/magic-codes?format=code_only`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'application/json',
        'X-Response-Format': 'code_only' // Additional header to request clean format
      }
    });
    
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }
    
    const codes = await response.json();
    
    if (codes.length === 0) {
      console.log('No magic codes found');
      return;
    }

    
    // Sort by id to get newest first
    codes.sort((a:any, b:any) => b.id - a.id);
    
    // Filter out already processed emails
    const newCodes = codes.filter((code:any) => {
      return code.email_id && !processedEmailIds.includes(code.email_id);
    });
    console.log('newCodes', newCodes);
    
    if (newCodes.length === 0) {
      console.log('No new unprocessed codes found');
      return;
    }
    
    console.log(`Found ${newCodes.length} new unprocessed codes`);
    
    // Process the newest unprocessed code
    const newestCode = newCodes[0];
    
    // Add this email ID to the processed list
    const updatedProcessedEmailIds = [
      ...processedEmailIds,
      newestCode.email_id
    ];
    
    // Keep the list manageable (max 100 most recent)
    if (updatedProcessedEmailIds.length > 100) {
      updatedProcessedEmailIds.splice(0, updatedProcessedEmailIds.length - 100);
    }
    
    // Update storage with processed email IDs and code information
    await chrome.storage.local.set({ 
      lastCodeId: newestCode.id,
      lastCodeTimestamp: Date.now(),
      lastCode: newestCode.code,
      lastCodeWebsite: newestCode.website || 'Unknown site',
      lastEmailId: newestCode.email_id,
      processedEmailIds: updatedProcessedEmailIds
    });
    
    console.log(`New code detected: ${newestCode.code} from ${newestCode.website || 'Unknown site'} (Email ID: ${newestCode.email_id})`);
    
    // Create notification with a unique ID based on the code and email ID
    // const emailIdSegment = newestCode.email_id ? `-${newestCode.email_id}` : '';
    // const notificationId = `code-${newestCode.id}${emailIdSegment}-${Date.now()}`;
    // chrome.notifications.create(notificationId, {
    //   type: 'basic',
    //   iconUrl: 'icon.svg',
    //   title: 'Magic Code Detected! 🎯',
    //   message: `Code from ${newestCode.website || 'Unknown site'} copied to clipboard: ${newestCode.code}`,
    //   priority: 2,
    //   requireInteraction: true,
    //   buttons: [
    //     { title: 'View Code' }
    //   ]
    // });
    
    // Start badge animation
    animateBadgeForNewCode();
    
    // Try to open the extension popup
    try {
      // First attempt direct API call - most reliable
      chrome.action.openPopup();
      await chrome.storage.local.set({ newestCode: newestCode.code });
      console.log('Successfully opened popup to show new code');
    } catch (e) {
      // Fallback: Try force opening which has multiple methods
      console.log('Direct popup opening failed, using fallback methods:', e);
      await forceOpenExtensionPopup();
    }
    
    // Create alarm for a reminder if user doesn't interact
    chrome.alarms.create('codeReminder', {
      delayInMinutes: 1 // Remind after 1 minute if they haven't viewed
    });
    
    console.log(`New code found and processed: ${newestCode.code}`);
  } catch (error) {
    console.error('Error checking for new codes:', error);
  }
}

// // Open the extension popup (as best as we can in Manifest V3)
// async function openPopup() {
//   // Show a notification that the user can click to see the magic code
//   console.log('Attempting to open extension popup (limited by Chrome security)');
//   
//   // Create a notification that user can click
//   chrome.notifications.create({
//     type: 'basic',
//     iconUrl: 'icon.svg',
//     title: 'Magic Code',
//     message: 'A new magic code has been copied to your clipboard!',
//     priority: 2,
//     requireInteraction: true, // Keep it visible until user interacts
//   });
// }

// Function to try to open the extension popup after authentication
// NOTE: chrome.action.openPopup() is ONLY available in MV3 background contexts
// (Not in content scripts or web pages)
async function openExtensionPopup() {
  try {
    // First attempt: try to directly open the popup (most reliable if available)
    try {
      // This API is only available in the background script context
      chrome.action.openPopup();
      console.log('Opened popup directly via chrome.action.openPopup()');
      return true;
    } catch (e) {
      console.log('Direct popup opening not available, using visual cues instead:', e);
    }
    
    // Fallback: In Manifest V3, we can't always programmatically open the popup,
    // but we can try to make the extension icon more noticeable
    
    // Update icon badge to show there's something new
    chrome.action.setBadgeText({ text: "NEW" });
    chrome.action.setBadgeBackgroundColor({ color: "#4285F4" });
    
    // Create a notification to tell the user to click the extension
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.svg',
      title: 'Magic Code Authentication Complete',
      message: 'Click the extension icon to see your magic codes.',
      priority: 2,
      requireInteraction: true, // Keep it visible until user interacts
    });
    
    return false;
  } catch (err) {
    console.error('Error opening extension popup:', err);
    return false;
  }
}

// More aggressive function to try to open the extension popup
// NOTE: chrome.action.openPopup() is ONLY available in MV3 background contexts
// (Not in content scripts or web pages)
async function forceOpenExtensionPopup() {
  try {
    console.log('Using aggressive approach to open extension popup');
    
    // 0. First try the direct API call - this is the most reliable if available
    try {
      // This API is only available in the background script context
      chrome.action.openPopup();
      console.log('Successfully opened popup directly via chrome.action.openPopup()');
      return true;
    } catch (e) {
      console.log('Direct popup opening via API failed, trying alternative methods:', e);
    }
    
    // 1. Set an eye-catching badge with animation
    const animateBadge = async () => {
      const colors = ["#00C853", "#4285F4", "#DB4437", "#F4B400"]; // Green, Blue, Red, Yellow
      const texts = ["✓", "!", "•", "⚡"];
      
      // Animate the badge multiple times to draw attention
      for (let i = 0; i < 5; i++) {
        const index = i % colors.length;
        chrome.action.setBadgeText({ text: texts[index] });
        chrome.action.setBadgeBackgroundColor({ color: colors[index] });
        
        // Wait a short time between animations
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      
      // Set final state
      chrome.action.setBadgeText({ text: "⚡" });
      chrome.action.setBadgeBackgroundColor({ color: "#00C853" }); // Bright green
    };
    
    // Start badge animation
    animateBadge();
    
    // 2. Try multiple ways to directly open the popup
    const tryOpenPopup = async () => {
      // Try different methods with small delays between them
      let success = false;
      
      // First attempt
      try {
        chrome.action.openPopup();
        console.log('First attempt: Successfully called chrome.action.openPopup()');
        success = true;
      } catch (e) {
        console.log('First attempt failed:', e);
      }
      
      // If first attempt failed, wait and try again
      if (!success) {
        await new Promise(resolve => setTimeout(resolve, 300));
        
        try {
          chrome.action.openPopup();
          console.log('Second attempt: Successfully called chrome.action.openPopup()');
          success = true;
        } catch (e) {
          console.log('Second attempt failed:', e);
        }
      }
      
      return success;
    };
    
    // Try opening the popup and get the result
    const popupOpened = await tryOpenPopup();
    
    // 3. Create a more attention-grabbing notification with sound and interaction
    const notificationId = 'auth-complete-' + Date.now();
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icon.svg',
      title: 'Magic Code Ready! 🎉',
      message: 'Authentication complete! Click here to open Magic Code.',
      priority: 2,
      requireInteraction: true,
      silent: false, // Allow sound
      buttons: [
        { title: 'Open Extension' }
      ]
    });
    
    // 4. Handle notification click to try to open popup
    chrome.notifications.onClicked.addListener(function notificationClickHandler(clickedId) {
      if (clickedId === notificationId) {
        console.log('Notification clicked, trying to open popup');
        
        // Try opening popup
        try {
          chrome.action.openPopup();
        } catch (e) {
          console.log('Failed to open popup on notification click:', e);
        }
        
        // Clean up this listener
        chrome.notifications.onClicked.removeListener(notificationClickHandler);
      }
    });
    
    // Handle button click
    chrome.notifications.onButtonClicked.addListener(function buttonClickHandler(notifId, buttonIndex) {
      if (notifId === notificationId && buttonIndex === 0) {
        console.log('Open Extension button clicked');
        
        // Try opening popup
        try {
          chrome.action.openPopup();
        } catch (e) {
          console.log('Failed to open popup on button click:', e);
        }
        
        // Clean up this listener
        chrome.notifications.onButtonClicked.removeListener(buttonClickHandler);
      }
    });
    
    // 5. Set a sequence of reminder notifications if the user hasn't clicked yet
    const createReminderNotification = (index: number) => {
      if (index >= 3) return; // Only show up to 3 reminders
      
      const messages = [
        'Your Magic Code extension is ready! Click the icon in your toolbar.',
        'You\'re authenticated! Click the Magic Code icon to continue.',
        'Don\'t forget to check out your Magic Code extension!'
      ];
      
      setTimeout(() => {
        chrome.notifications.create('reminder-' + Date.now(), {
          type: 'basic',
          iconUrl: 'icon.svg',
          title: 'Magic Code Extension',
          message: messages[index],
          priority: 2,
          requireInteraction: false,
          silent: index !== 0, // Only first reminder makes sound
        });
        
        // Schedule next reminder
        createReminderNotification(index + 1);
      }, 5000 + (index * 10000)); // Increasing intervals between reminders
    };
    
    // Start reminder sequence
    createReminderNotification(0);
    
    // 6. Set up a delayed attempt to open popup again after a few seconds
    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          console.log('Delayed attempt to open popup');
          chrome.action.openPopup();
          console.log('Successfully opened popup via delayed attempt');
          resolve(true);
        } catch (e) {
          console.log('Delayed attempt failed:', e);
          resolve(false);
        }
      }, 2000);
    });
    
  } catch (err) {
    console.error('Error in aggressive popup opening:', err);
    
    // Fall back to standard method
    return openExtensionPopup();
  }
}

// Check a specific tab for auth token in localStorage
async function checkTabForAuthToken(tabId: number) {
  try {
    console.log(`Checking tab ${tabId} for auth token`);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Check for magicCodeAuthToken first, as it's our special marker
        const magicToken = localStorage.getItem('magicCodeAuthToken');
        if (magicToken) {
          // Clean up
          localStorage.removeItem('magicCodeAuthToken');
          return magicToken;
        }
        
        // Fall back to regular authToken
        return localStorage.getItem('authToken');
      }
    });
    
    if (results && results[0] && results[0].result) {
      const token = results[0].result;
      console.log(`Found auth token in tab ${tabId}`);
      
      // Save to chrome storage
      await chrome.storage.local.set({ authToken: token });
      
      // Show a notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.svg',
        title: 'Magic Code',
        message: 'You have been signed in successfully!',
        priority: 2
      });
      
      // Open the extension popup
      openExtensionPopup();
      return true;
    }
    
    return false;
  } catch (err) {
    console.log(`Error checking tab ${tabId} for token:`, err);
    return false;
  }
}

// Check all tabs for auth tokens
async function checkAllTabsForToken() {
  console.log('Checking all tabs for auth tokens');
  
  // Query for all tabs
  const tabs = await chrome.tabs.query({});
  
  // For each tab, try to execute a script to check localStorage
  for (const tab of tabs) {
    if (tab.id && tab.url && tab.url.startsWith('http')) {
      try {
        const found = await checkTabForAuthToken(tab.id);
        if (found) {
          // Found a token, no need to check other tabs
          break;
        }
      } catch (err) {
        console.log(`Error checking tab ${tab.id}:`, err);
        // Continue to next tab
      }
    }
  }
}

// Check if a token exists in localStorage (from web app)
async function checkForLocalStorageToken() {
  console.log('Checking all tabs for localStorage token');
  
  try {
    // First check if we already have a token in storage
    const data = await chrome.storage.local.get('authToken');
    if (data.authToken) {
      console.log('Already have token in storage, verifying with server...');
      
      // Verify token with server
      const response = await fetch(`${API_URL}/auth/status`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${data.authToken}`
        }
      });
      
      const result = await response.json();
      
      if (result.authenticated) {
        console.log('Existing token is valid');
        return; // Token is valid, no need to search tabs
      } else {
        console.log('Existing token is invalid, clearing and searching tabs');
        await chrome.storage.local.remove('authToken');
      }
    }
    
    // If we don't have a token or it's invalid, check all tabs
    await checkAllTabsForToken();
  } catch (error) {
    console.error('Error in checkForLocalStorageToken:', error);
    
    // If an error occurred, fall back to just checking tabs
    await checkAllTabsForToken();
  }
}
