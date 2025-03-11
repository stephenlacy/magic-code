import { useEffect } from 'react';

/**
 * This component:
 * 1. Listens for messages from the auth tab
 * 2. Checks localStorage for a token (fallback method)
 * 3. Stores the auth token in Chrome storage
 * 4. Listens for window messages (for cross-origin communication)
 * 5. Periodically checks for tokens in localStorage across tabs
 */
const AuthListener: React.FC = () => {
  useEffect(() => {
    // Handler for direct messages from the auth page
    function handleMessage(request: any, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) {
      if (request.type === 'AUTH_TOKEN') {
        // Store the token in Chrome storage
        chrome.storage.local.set({ authToken: request.token }, () => {
          console.log('Auth token saved to Chrome storage from message');
          sendResponse({ success: true });
          
          // Reload the extension to reflect authenticated state
          window.location.reload();
        });
        return true; // Keep the message channel open for the async response
      }
    }
    
    // Handler for window messages (cross-origin communication)
    function handleWindowMessage(event: MessageEvent) {
      console.log('Received window message:', event.data, 'from:', event.origin);
      
      // Check if it's our auth message
      if (event.data && event.data.type === 'MAGIC_CODE_AUTH' && event.data.token) {
        console.log('Auth token received via window message');
        
        // Store in Chrome storage
        chrome.storage.local.set({ authToken: event.data.token }, () => {
          console.log('Auth token saved to Chrome storage from window message');
          
          // Reload the extension to reflect authenticated state
          window.location.reload();
        });
      }
    }
    
    // Check for a token in localStorage as a fallback
    const checkLocalStorage = () => {
      // Only run on the popup page, not in background
      if (typeof localStorage !== 'undefined') {
        // Check if there's a special request to open the extension popup
        const shouldOpenPopup = localStorage.getItem('openExtensionPopup') === 'true';
        if (shouldOpenPopup) {
          console.log('Found openExtensionPopup flag in localStorage');
          localStorage.removeItem('openExtensionPopup'); // Clean up
        }
        
        const token = localStorage.getItem('magicCodeAuthToken');
        if (token) {
          console.log('Found token in localStorage, saving to Chrome storage');
          localStorage.removeItem('magicCodeAuthToken'); // Clean up
          
          chrome.storage.local.set({ authToken: token }, () => {
            console.log('Auth token saved to Chrome storage from localStorage');
            
            // If we should show the popup, notify the background script
            if (shouldOpenPopup) {
              chrome.runtime.sendMessage({ 
                type: 'AUTH_TOKEN', 
                token: token,
                openPopup: true
              }, (response) => {
                console.log('Background script response:', response);
              });
            }
            
            window.location.reload();
          });
        }
        
        // Also check for the regular authToken
        const regularToken = localStorage.getItem('authToken');
        if (regularToken && !token) { // Don't double process
          console.log('Found regular token in localStorage');
          
          chrome.storage.local.set({ authToken: regularToken }, () => {
            console.log('Regular auth token saved to Chrome storage');
            
            // If we should show the popup, notify the background script
            if (shouldOpenPopup) {
              chrome.runtime.sendMessage({ 
                type: 'AUTH_TOKEN', 
                token: regularToken,
                openPopup: true
              }, (response) => {
                console.log('Background script response:', response);
              });
            }
            
            window.location.reload();
          });
        }
      }
    };
    
    // Function to check localStorage across all tabs
    const checkAllTabsForToken = async (): Promise<boolean | undefined> => {
      console.log('Checking all tabs for authentication token');
      try {
        // First check if we already have a token in Chrome storage
        const data = await chrome.storage.local.get(['authToken', 'preventAutoAuth', 'logoutTimestamp']);
        
        // Check if user manually logged out recently (within last 5 minutes)
        const recentLogout = data.logoutTimestamp && 
          (Date.now() - data.logoutTimestamp < 5 * 60 * 1000);
        
        // If we have a token or if auto-auth is prevented, don't check tabs
        if (data.authToken) {
          console.log('Already have token in Chrome storage, no need to check tabs');
          return true;
        }
        
        // Check if auto-auth is prevented by manual logout
        if (data.preventAutoAuth && recentLogout) {
          console.log('Auto authentication prevented by recent manual logout');
          return;
        }
        
        // Clear old prevention flags if they're expired (more than 5 minutes old)
        if (data.preventAutoAuth && !recentLogout) {
          console.log('Clearing expired auto-auth prevention flags');
          await chrome.storage.local.remove(['preventAutoAuth', 'logoutTimestamp']);
        }
        
        // Query for all tabs
        const tabs = await chrome.tabs.query({});
        
        // Track if we found a token
        let tokenFound = false;
        
        // For each tab, try to execute a script to check localStorage
        for (const tab of tabs) {
          if (tab.id && tab.url && tab.url.startsWith('http')) {
            try {
              // Execute script in the tab to check localStorage
              const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                  // Check for authToken in localStorage
                  const token = localStorage.getItem('authToken');
                  // Also check magicCodeAuthToken
                  const magicToken = localStorage.getItem('magicCodeAuthToken');
                  // Check for prevention flags
                  const preventAutoAuth = localStorage.getItem('preventAutoAuth');
                  const logoutTimestamp = localStorage.getItem('logoutTimestamp');
                  // Check for openExtensionPopup flag
                  const openExtensionPopup = localStorage.getItem('openExtensionPopup');
                  // Check for auth_timestamp
                  const authTimestamp = localStorage.getItem('auth_timestamp');
                  
                  return { 
                    authToken: token, 
                    magicCodeAuthToken: magicToken,
                    preventAutoAuth,
                    logoutTimestamp,
                    openExtensionPopup,
                    authTimestamp
                  };
                }
              });
              
              // Check if we found a token and should use it
              if (results && results[0] && results[0].result) {
                const { 
                  authToken, 
                  magicCodeAuthToken, 
                  preventAutoAuth, 
                  logoutTimestamp,
                  openExtensionPopup,
                  authTimestamp
                } = results[0].result;
                
                // Check if auto-auth is prevented in this tab
                const tabRecentLogout = logoutTimestamp && 
                  (Date.now() - parseInt(logoutTimestamp) < 5 * 60 * 1000);
                
                if (preventAutoAuth === 'true' && tabRecentLogout) {
                  console.log(`Tab ${tab.id} has auto-auth prevention flag`);
                  continue; // Skip this tab
                }
                
                // If we have a token, use it
                if (authToken || magicCodeAuthToken) {
                  const token = magicCodeAuthToken || authToken;
                  console.log('Found auth token in tab localStorage');
                  
                  // Check if we should open the extension popup
                  const shouldOpenPopup = openExtensionPopup === 'true';
                  
                  // Also check if this is a recent auth (within last 30 seconds)
                  const isRecentAuth = authTimestamp && 
                    (Date.now() - parseInt(authTimestamp) < 30 * 1000);
                  
                  // If openExtensionPopup flag is set or this is a very recent auth, we should
                  // force open the extension popup
                  if (shouldOpenPopup || isRecentAuth) {
                    console.log(`Tab ${tab.id} has openExtensionPopup flag or recent auth, will force open popup`);
                    
                    // Clear the flag in the tab's localStorage
                    await chrome.scripting.executeScript({
                      target: { tabId: tab.id },
                      func: () => {
                        localStorage.removeItem('openExtensionPopup');
                      }
                    });
                    
                    // Save token to Chrome storage
                    await chrome.storage.local.set({ authToken: token });
                    console.log('Token saved to Chrome storage with force open flag');
                    
                    // Tell the background script to force open the popup
                    chrome.runtime.sendMessage({ 
                      type: 'AUTH_TOKEN', 
                      token: token,
                      openPopup: true,
                      forceOpen: true 
                    }, (response) => {
                      console.log('Background script response for force open:', response);
                    });
                    
                    tokenFound = true;
                    window.location.reload(); // Refresh the extension UI
                    break; // Found a token, stop searching
                  } else {
                    // Normal token handling without forced popup
                    console.log('Found auth token, no popup forcing needed');
                    
                    // Save to chrome storage
                    await chrome.storage.local.set({ authToken: token });
                    console.log('Token from tab saved to Chrome storage');
                    
                    tokenFound = true;
                    window.location.reload(); // Refresh the extension UI
                    break; // Found a token, stop searching
                  }
                }
              }
            } catch (err) {
              console.log(`Error checking localStorage in tab ${tab.id}:`, err);
              // Continue to next tab
            }
          }
        }
        
        if (!tokenFound) {
          console.log('No token found in any tabs');
        }
      } catch (err) {
        console.error('Error checking tabs for token:', err);
      }
    };
    
    // Add listeners
    chrome.runtime.onMessage.addListener(handleMessage);
    window.addEventListener('message', handleWindowMessage);
    
    // Check URL parameters for direct token passing
    const checkUrlParams = () => {
      const urlParams = new URLSearchParams(window.location.search);
      const urlToken = urlParams.get('token');
      if (urlToken) {
        console.log('Found token in URL parameters');
        chrome.storage.local.set({ authToken: urlToken }, () => {
          console.log('URL token saved to Chrome storage');
          window.location.href = window.location.origin + window.location.pathname; // Remove query params
        });
      }
    };
    
    // Run checks
    checkLocalStorage();
    checkUrlParams();
    
    // Check all tabs for token
    checkAllTabsForToken();
    
    // Set up periodic checking for tokens (every 3 seconds for 30 seconds after opening)
    // This helps detect when the user completes authentication in a tab
    let checkCount = 0;
    const maxChecks = 10; // 10 checks * 3 seconds = 30 seconds of checking
    
    const intervalId = setInterval(() => {
      checkCount++;
      if (checkCount <= maxChecks) {
        console.log(`Running token check ${checkCount}/${maxChecks}`);
        checkAllTabsForToken().then((res) =>  {
          if (res === true) {
            clearInterval(intervalId);
          }
        });
      } else {
        clearInterval(intervalId);
      }
    }, 3000);
    
    // Clean up
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      window.removeEventListener('message', handleWindowMessage);
      clearInterval(intervalId);
    };
  }, []);

  return null; // This component doesn't render anything
};

export default AuthListener;
