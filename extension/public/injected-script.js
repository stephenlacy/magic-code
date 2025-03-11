// injected-script.js
// This script is injected into the page and can communicate with the content script

(function() {
  console.log('Magic Code: Injected script loaded');
  
  // Expose a global function to open the Magic Code extension
  window.openMagicCodeExtension = function(token) {
    console.log('Magic Code: openMagicCodeExtension called with token:', token);
    
    // Send a message to the content script
    window.postMessage({
      type: 'MAGIC_CODE_OPEN_EXTENSION',
      token: token || null,
      timestamp: Date.now()
    }, '*');
    
    return true;
  };
  
  // Listen for messages from the content script
  window.addEventListener('message', function(event) {
    // Only accept messages from the same frame
    if (event.source !== window) return;
    
    if (event.data.type === 'MAGIC_CODE_EXTENSION_OPENED') {
      console.log('Magic Code: Extension was opened successfully:', event.data.success);
      
      // Dispatch a custom event that the web app can listen for
      const customEvent = new CustomEvent('magicCodeExtensionOpened', {
        detail: {
          success: event.data.success,
          timestamp: event.data.timestamp
        }
      });
      
      document.dispatchEvent(customEvent);
    }
    
    if (event.data.type === 'MAGIC_CODE_BACKGROUND_MESSAGE') {
      console.log('Magic Code: Message from background script via content script:', event.data);
    }
  });
  
  // Let the web app know that the injected script is ready
  document.dispatchEvent(new CustomEvent('magicCodeInjectedScriptReady'));
  
  console.log('Magic Code: Injected script initialization complete');
})();