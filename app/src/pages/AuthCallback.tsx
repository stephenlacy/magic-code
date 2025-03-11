import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

const AuthCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Function to attempt opening the Chrome extension
  const tryOpenExtension = (token: string) => {
    console.log("Attempting to open Chrome extension");

    // Method 1: Try using chrome.runtime.sendMessage to communicate with the extension
    if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage(
          { type: "AUTH_TOKEN", token: token, openPopup: true },
          (response) => {
            console.log("Chrome extension response:", response);
          }
        );
        console.log("Sent auth token via chrome.runtime.sendMessage");
        return true;
      } catch (e) {
        console.error("Error sending message to extension:", e);
      }
    }

    // Method 2: Try to directly open the extension using the chrome-extension:// protocol
    // This needs the extension ID, which we don't have, so we'll try some generic approaches
    try {
      // Try to use the chrome.extension API to get the URL
      if (window.chrome && chrome.extension && chrome.extension.getURL) {
        try {
          const popupUrl = chrome.extension.getURL("index.html");
          window.open(popupUrl + `?token=${token}`, "_blank");
          console.log("Opened extension using chrome.extension.getURL");
          return true;
        } catch (e) {
          console.error("Error opening extension via chrome.extension.getURL:", e);
        }
      }
    } catch (e) {
      console.error("Error accessing chrome.extension API:", e);
    }

    // Method 3: Try broadcasting via window.postMessage (other methods will still be attempted)
    try {
      window.postMessage(
        { type: "MAGIC_CODE_AUTH", token: token, openPopup: true },
        "*"
      );
      console.log("Sent auth token via postMessage");
    } catch (e) {
      console.error("Error sending postMessage:", e);
    }

    // Method 4: Set special flags in localStorage for the extension to detect
    try {
      localStorage.setItem("magicCodeAuthToken", token);
      localStorage.setItem("auth_timestamp", Date.now().toString());
      localStorage.setItem("openExtensionPopup", "true");
      console.log("Set auth data in localStorage with popup flag");
    } catch (e) {
      console.error("Error setting localStorage:", e);
    }

    return false;
  };

  useEffect(() => {
    // Get token from URL
    const token = searchParams.get("token");
    const fromExtension = searchParams.get("from_extension");
    
    if (token) {
      // Store in localStorage for future requests
      localStorage.setItem("authToken", token);
      console.log("Auth token stored in localStorage");
      
      // For extension auto-discovery
      localStorage.setItem("magicCodeAuthToken", token);
      
      // Try to communicate with extension if this auth came from it or always try
      if (fromExtension || true) {  // Always try to open the extension
        console.log("Auth completed, attempting to open/communicate with extension");
        
        // Try to open the extension
        const openAttempted = tryOpenExtension(token);
        
        // If this is a "complete" callback from extension flow, just close window
        if (fromExtension === "complete") {
          window.close();
          return;
        }
        
        // If we definitely opened the extension and this was from extension flow, no need to redirect
        if (openAttempted && fromExtension) {
          // Wait a moment, then close this window
          setTimeout(() => {
            window.close();
          }, 2000);
          return;
        }
      }
      
      // Redirect to dashboard (for web app flow or if extension opening failed)
      navigate("/dashboard");
    } else {
      console.error("No token provided in callback");
      navigate("/login?error=no_token");
    }
  }, [searchParams, navigate]);

  return (
    <div className="loading">
      <div className="spinner"></div>
      <p>Processing authentication...</p>
    </div>
  );
};

export default AuthCallback;