import axios, { AxiosError } from "axios";
import { MagicCode, User } from "../types";

const API_URL = "http://localhost:3000";

// Create axios instance with proper configuration
const api = axios.create({
  baseURL: API_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Add request interceptor to add auth token from chrome storage
api.interceptors.request.use(
  async (config) => {
    // Get the auth token from chrome storage
    const data = await chrome.storage.local.get('authToken');
    const token = data.authToken;
    
    if (token) {
      config.headers["Authorization"] = `Bearer ${token}`;
    }
    return config;
  },
  error => Promise.reject(error)
);

// Add response interceptor for handling auth errors
api.interceptors.response.use(
  response => response,
  async (error: AxiosError) => {
    if (error.response?.status === 401) {
      // Clear the auth token if unauthorized
      await chrome.storage.local.remove('authToken');
    }
    return Promise.reject(error);
  }
);

export const googleLogin = async (): Promise<void> => {
  try {
    // First, check if the user is already logged in on the server
    console.log("Checking if user is already logged in on server...");
    
    try {
      // Check using the auth status endpoint
      const authStatusResponse = await fetch(`${API_URL}/auth/status`, {
        method: 'GET',
        credentials: 'include' // Include cookies in the request
      });
      
      const authStatus = await authStatusResponse.json();
      
      if (authStatus.authenticated) {
        console.log("User already authenticated on server, reusing token");
        
        // Save the token directly to Chrome storage
        await chrome.storage.local.set({ authToken: authStatus.userId });
        
        // Show a notification
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.svg',
          title: 'Magic Code',
          message: 'Signed in using existing session!',
          priority: 2
        });
        
        // Reload the extension popup to show authenticated state
        window.location.reload();
        return;
      }
    } catch (serverErr) {
      console.log("Error checking server auth status:", serverErr);
    }
    
    // Next, try to check localStorage on all tabs that might have the webapp open
    console.log("Checking if user is logged in on web app tabs...");
    const tabs = await chrome.tabs.query({url: [`${API_URL}/*`, "http://localhost:5173/*"]});
    
    let tokenFound = false;
    for (const tab of tabs) {
      if (tab.id) {
        try {
          // Execute script to check if user is logged in
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              // Check for token in localStorage
              const token = localStorage.getItem('authToken');
              if (token) {
                // Store in a shared location for the extension
                localStorage.setItem('magicCodeAuthToken', token);
                return token;
              }
              return null;
            }
          });
          
          if (results && results[0] && results[0].result) {
            console.log("Found existing login in web app tab");
            tokenFound = true;
            
            // Save directly to Chrome storage
            await chrome.storage.local.set({ authToken: results[0].result });
            
            // Show a notification
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icon.svg',
              title: 'Magic Code',
              message: 'Signed in using existing web app session!',
              priority: 2
            });
            
            // Reload the extension popup to show authenticated state
            window.location.reload();
            return;
          }
        } catch (err) {
          console.log(`Error checking tab ${tab.id}:`, err);
        }
      }
    }
    
    // If no existing session, proceed with normal Google login
    console.log("No existing login found, proceeding with Google auth flow");
    
    // First store a flag in localStorage to indicate this auth was initiated from the extension
    // We need to do this in all tabs that might be used for the auth flow
    chrome.tabs.query({}, async (tabs) => {
      for (const tab of tabs) {
        if (tab.id && tab.url && tab.url.startsWith('http')) {
          try {
            // Execute script to set a flag in localStorage
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                localStorage.setItem('auth_from_extension', 'true');
                localStorage.setItem('extension_auth_timestamp', Date.now().toString());
              }
            });
          } catch (err) {
            console.log(`Error setting localStorage flag in tab ${tab.id}:`, err);
          }
        }
      }
    });
    
    // Now open the auth page with extension flag
    chrome.tabs.create({ 
      url: `${API_URL}/auth/google?from_extension=true`,
      active: true
    });
  } catch (error) {
    console.error("Error in google login:", error);
    // Fallback to direct Google auth
    chrome.tabs.create({ 
      url: `${API_URL}/auth/google?from_extension=true`,
      active: true
    });
  }
};

export const checkAuth = async (): Promise<boolean> => {
  try {
    // Check if token exists in storage
    const data = await chrome.storage.local.get('authToken');
    if (!data.authToken) {
      return false;
    }
    
    // Verify token by calling API
    await getUser();
    return true;
  } catch (error) {
    console.error("Auth check failed:", error);
    return false;
  }
};

export const getUser = async (): Promise<User> => {
  const response = await api.get<User>("/api/user");
  return response.data;
};

export const getMagicCodes = async (): Promise<MagicCode[]> => {
  const response = await api.get<MagicCode[]>("/api/magic-codes");
  return response.data;
};

export const logout = async (): Promise<void> => {
  console.log('LOGOUT: Starting logout process');
  
  try {
    // STEP 1: Direct Chrome Storage Clearing - Do this first and immediately
    console.log('LOGOUT: Directly clearing Chrome storage');
    await chrome.storage.local.remove(['authToken']);
    
    // STEP 1.5: Set a logout flag to prevent auto-reauth
    await chrome.storage.local.set({ 
      logoutTimestamp: Date.now(),
      preventAutoAuth: true 
    });
    console.log('LOGOUT: Set preventAutoAuth flag');
    
    // STEP 2: Call server API for logout
    try {
      console.log('LOGOUT: Calling server logout API');
      await api.get("/api/logout");
      console.log('LOGOUT: Server logout successful');
    } catch (apiError) {
      console.error("LOGOUT: API logout failed:", apiError);
      // Continue with local logout even if API fails
    }
    
    // STEP 3: Clear most Chrome storage but keep our logout flag
    console.log('LOGOUT: Clearing most Chrome storage');
    const keysToKeep = ['logoutTimestamp', 'preventAutoAuth'];
    const data = await chrome.storage.local.get(keysToKeep);
    
    await new Promise<void>((resolve) => {
      chrome.storage.local.clear(() => {
        console.log('LOGOUT: Chrome storage cleared');
        resolve();
      });
    });
    
    // Restore our logout flags
    await chrome.storage.local.set(data);
    console.log('LOGOUT: Restored logout prevention flags');
    
    // STEP 4: Clear localStorage in all open tabs
    console.log('LOGOUT: Searching for active tabs to clear localStorage');
    // Query all tabs (more comprehensive)
    const tabs = await chrome.tabs.query({});
    
    // For each tab, try to clear localStorage
    console.log(`LOGOUT: Found ${tabs.length} tabs to check`);
    for (const tab of tabs) {
      if (tab.id && tab.url && tab.url.startsWith('http')) {
        try {
          console.log(`LOGOUT: Clearing localStorage in tab ${tab.id} (${tab.url})`);
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              // Clear all possible auth tokens
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
              
              // Add a flag in localStorage to prevent auto-reauth
              try {
                localStorage.setItem('preventAutoAuth', 'true');
                localStorage.setItem('logoutTimestamp', Date.now().toString());
              } catch (e) {
                // Ignore errors
              }
              
              // For debugging
              console.log('LOGOUT: LocalStorage cleared in tab');
              return true;
            }
          });
        } catch (err) {
          console.log(`LOGOUT: Error clearing localStorage in tab ${tab.id}:`, err);
          // Continue with other tabs
        }
      }
    }
    
    // STEP 5: Reset all alarms
    console.log('LOGOUT: Clearing all alarms');
    await new Promise<void>((resolve) => {
      chrome.alarms.clearAll(() => {
        console.log('LOGOUT: All alarms cleared');
        resolve();
      });
    });
    
    // STEP 6: Reset badge
    console.log('LOGOUT: Clearing badge');
    chrome.action.setBadgeText({ text: "" });
    
    // STEP 7: Notify background script (even if we've already cleared storage)
    console.log('LOGOUT: Notifying background script');
    try {
      await new Promise<void>((resolve) => {
        chrome.runtime.sendMessage({ type: "LOGOUT", force: true }, (response) => {
          console.log("LOGOUT: Background script response:", response);
          resolve();
        });
        
        // Add a timeout in case background script doesn't respond
        setTimeout(() => resolve(), 500);
      });
    } catch (msgError) {
      console.error("LOGOUT: Error notifying background script:", msgError);
    }
    
    // STEP 8: Recreate minimal required alarms
    console.log('LOGOUT: Recreating essential alarms');
    chrome.alarms.create('checkAuth', {
      periodInMinutes: 5 / 60
    });
    
    // STEP 9: Double-check Chrome storage is correct (no auth token but has prevention flag)
    const finalCheck = await chrome.storage.local.get(['authToken', 'preventAutoAuth']);
    if (finalCheck.authToken) {
      console.warn('LOGOUT: authToken still present after logout! Removing again.');
      await chrome.storage.local.remove(['authToken']);
    }
    if (!finalCheck.preventAutoAuth) {
      console.warn('LOGOUT: preventAutoAuth flag missing! Setting it again.');
      await chrome.storage.local.set({ 
        logoutTimestamp: Date.now(),
        preventAutoAuth: true 
      });
    }
    
    console.log('LOGOUT: Process completed successfully');
    
    // STEP 10: Force reload extension UI
    window.location.reload();
    
  } catch (error) {
    console.error("LOGOUT: Critical error in logout process:", error);
    
    // Last resort emergency logout
    console.log('LOGOUT: Performing emergency logout');
    chrome.storage.local.clear();
    chrome.action.setBadgeText({ text: "" });
    
    // Set the prevention flag even in error case
    chrome.storage.local.set({ 
      logoutTimestamp: Date.now(),
      preventAutoAuth: true 
    });
    
    // Force reload extension UI
    window.location.reload();
  }
};

export const copyToClipboard = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text);
};

export default api;