// content-script.js
// This script will be injected into the dashboard page

// Function to inject our script into the page
function injectScript() {
  try {
    // Create script element
    const script = document.createElement('script');
    
    // Get the injected script URL from the extension
    script.src = chrome.runtime.getURL('injected-script.js');
    
    // Add the script to the page
    (document.head || document.documentElement).appendChild(script);
    
    // Remove the script after it's loaded (optional)
    script.onload = function() {
      script.remove();
    };
    
    console.log('Magic Code: Injected script successfully');
  } catch (e) {
    console.error('Magic Code: Error injecting script', e);
  }
}

// Listen for messages from the injected script
window.addEventListener('message', function(event) {
  // Only accept messages from the same frame
  if (event.source !== window) return;
  
  // Check if the message is from our injected script
  if (event.data.type && event.data.type === 'MAGIC_CODE_OPEN_EXTENSION') {
    console.log('Magic Code: Received request to open extension', event.data);
    
    // Store token if provided
    if (event.data.token) {
      chrome.storage.local.set({ authToken: event.data.token }, function() {
        console.log('Magic Code: Token stored in extension storage');
      });
    }
    
    // Content scripts can't directly use chrome.action API, so we'll always use the background script
    console.log('Magic Code: Forwarding open request to background script');
    
    // Forward to background script which can use the chrome.action API
    console.log('Magic Code: Sending OPEN_EXTENSION message to background script with token:', event.data.token);
    
    try {
      chrome.runtime.sendMessage({
        type: 'OPEN_EXTENSION',
        token: event.data.token || null,
        forceOpen: true,
        source: 'content-script',
        timestamp: Date.now()
      }, function(response) {
        console.log('Magic Code: Background script response', response);
        
        // Check if we got a response
        if (chrome.runtime.lastError) {
          console.error('Magic Code: Error sending message to background script:', chrome.runtime.lastError);
          
          // Send error back to the webpage
          window.postMessage({
            type: 'MAGIC_CODE_EXTENSION_OPENED',
            success: false,
            error: chrome.runtime.lastError.message,
            method: 'background-error',
            timestamp: Date.now()
          }, '*');
          return;
        }
        
        // Send confirmation back to the webpage
        window.postMessage({
          type: 'MAGIC_CODE_EXTENSION_OPENED',
          success: Boolean(response && response.success),
          method: response?.method || 'background',
          timestamp: Date.now()
        }, '*');
      });
      
      console.log('Magic Code: Message sent to background script');
    } catch (error) {
      console.error('Magic Code: Exception sending message to background script:', error);
      
      // Send error back to the webpage
      window.postMessage({
        type: 'MAGIC_CODE_EXTENSION_OPENED',
        success: false,
        error: error.message,
        method: 'background-exception',
        timestamp: Date.now()
      }, '*');
    }
  }
});

// Execute injection when the document is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectScript);
} else {
  injectScript();
}

// Also listen for direct messages from the background script
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.type === 'BACKGROUND_MESSAGE') {
    console.log('Magic Code: Message from background script', message);
    sendResponse({ received: true });
    
    // Forward to page if needed
    window.postMessage({
      type: 'MAGIC_CODE_BACKGROUND_MESSAGE',
      data: message.data
    }, '*');
  }
  return true;
});