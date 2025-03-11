import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getUser, checkAuth, logout } from "../services/api";
import { User } from "../types";
import MagicCodeList from "../components/MagicCodeList";

const Dashboard: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Function to attempt opening the Chrome extension using the injected script
  const tryOpenExtension = (token: string) => {
    console.log("Attempting to open Chrome extension via injected script");

    // Store the token and flags in localStorage for any method to use
    try {
      localStorage.setItem("magicCodeAuthToken", token);
      localStorage.setItem("authToken", token);
      localStorage.setItem("auth_timestamp", Date.now().toString());
      localStorage.setItem("openExtensionPopup", "true");
      console.log("Set auth data in localStorage with popup flag");
    } catch (e) {
      console.error("Error setting localStorage:", e);
    }

    // Method 1: Use the injected script function to open the extension
    if ((window as any).openMagicCodeExtension) {
      try {
        console.log("Found injected openMagicCodeExtension function, calling it");
        (window as any).openMagicCodeExtension(token);
        
        // Setup a listener for the extension opened event
        document.addEventListener('magicCodeExtensionOpened', (event: any) => {
          console.log("Received extension opened confirmation:", event.detail);
          if (event.detail?.success) {
            console.log("Extension opened successfully");
          } else {
            console.log("Extension might not have opened successfully, showing notification");
            showExtensionNotification();
          }
        }, { once: true });

        return true;
      } catch (e) {
        console.error("Error calling injected openMagicCodeExtension function:", e);
      }
    } else {
      console.log("Injected openMagicCodeExtension function not found, trying fallback methods");
    }

    // Fallback Method 2: Try broadcasting via window.postMessage
    try {
      window.postMessage(
        { 
          type: "MAGIC_CODE_OPEN_EXTENSION", 
          token: token, 
          openPopup: true,
          forceOpen: true,
          timestamp: Date.now()
        },
        "*"
      );
      console.log("Sent open request via postMessage as fallback");
    } catch (e) {
      console.error("Error sending postMessage:", e);
    }

    // Create a visible notification for the user as a backup
    showExtensionNotification();

    return true;
  };
  
  // Set up listener for injected script ready event
  useEffect(() => {
    // Function to handle the injected script ready event
    const handleInjectedScriptReady = () => {
      console.log("Magic Code injected script detected as ready");
      
      // Store this information to prevent showing unnecessary notifications
      localStorage.setItem("magicCodeInjectedScriptDetected", "true");
      
      // Check if we have a token to use immediately
      const storedToken = localStorage.getItem("authToken");
      if (storedToken && (window as any).openMagicCodeExtension) {
        console.log("Detected stored token and injected script, attempting to open extension");
        (window as any).openMagicCodeExtension(storedToken);
      }
    };
    
    // Add the event listener
    document.addEventListener('magicCodeInjectedScriptReady', handleInjectedScriptReady);
    
    // Clean up
    return () => {
      document.removeEventListener('magicCodeInjectedScriptReady', handleInjectedScriptReady);
    };
  }, []);

  // Function to show a visible notification to the user about the extension
  const showExtensionNotification = () => {
    // Create a styled notification element
    const notification = document.createElement('div');
    notification.style.position = 'fixed';
    notification.style.top = '20px';
    notification.style.right = '20px';
    notification.style.backgroundColor = '#4285F4';
    notification.style.color = 'white';
    notification.style.padding = '15px 20px';
    notification.style.borderRadius = '8px';
    notification.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    notification.style.zIndex = '9999';
    notification.style.maxWidth = '300px';
    notification.style.fontFamily = 'sans-serif';
    
    // Add notification content
    notification.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 8px;">Magic Code Extension Ready! 🎉</div>
      <div style="margin-bottom: 8px;">Click the Magic Code icon in your browser toolbar to use the extension.</div>
      <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
        <button id="close-notification" style="background: transparent; border: 1px solid white; color: white; padding: 5px 10px; border-radius: 4px; cursor: pointer;">Dismiss</button>
      </div>
    `;
    
    // Add to document
    document.body.appendChild(notification);
    
    // Add close button handler
    document.getElementById('close-notification')?.addEventListener('click', () => {
      notification.style.display = 'none';
      setTimeout(() => {
        try {
          document.body.removeChild(notification);
        } catch (e) {
          // Ignore if already removed
        }
      }, 300);
    });
    
    // Auto-remove after 15 seconds
    setTimeout(() => {
      try {
        notification.style.opacity = '0';
        notification.style.transition = 'opacity 0.5s ease-out';
        setTimeout(() => {
          try {
            document.body.removeChild(notification);
          } catch (e) {
            // Ignore if already removed
          }
        }, 500);
      } catch (e) {
        // Ignore if already removed
      }
    }, 15000);
  };

  // Process URL parameters for direct authentication
  useEffect(() => {
    // Check if we have auth parameters in the URL
    const token = searchParams.get("token");
    const fromExtension = true;
    const authSuccess = searchParams.get("auth_success") === "true";
    
    console.log("URL parameters:", { token, fromExtension, authSuccess });
    // If we have auth parameters, process them
    if (token && authSuccess) {
      console.log("Found auth parameters in URL, processing...");
      
      // Store the token in localStorage
      localStorage.setItem("authToken", token);
      localStorage.setItem("magicCodeAuthToken", token);
      
      // If this auth came from the extension, try to open it
      if (fromExtension) {
        console.log("Auth came from extension, attempting to open it");
        tryOpenExtension(token);
      }
      
      // Clear the URL parameters to avoid reprocessing on refresh
      navigate("/dashboard", { replace: true });
    }
  }, [searchParams, navigate]);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        setLoading(true);
        
        // First check if auth is valid
        const isLoggedIn = await checkAuth();
        if (!isLoggedIn) {
          console.error("Auth check failed");
          navigate("/login?error=session_expired");
          return;
        }
        
        // If auth is valid, get user data
        const userData = await getUser();
        console.log("User data retrieved:", userData);
        setUser(userData);
      } catch (err) {
        console.error("Dashboard error:", err);
        setError("Failed to load user data. Please try logging in again.");
        // Don't navigate here - the API interceptor will handle 401s
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [navigate]);

  if (loading) {
    return <div className="loading">Loading dashboard...</div>;
  }

  if (error) {
    return (
      <div className="error-container">
        <div className="error">{error}</div>
        <button onClick={() => navigate("/login")}>Back to Login</button>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Magic Code Dashboard</h1>
        <div className="user-info">
          <span className="user-email">{user?.email}</span>
          <button 
            className="logout-btn" 
            onClick={() => logout()}
          >
            Logout
          </button>
        </div>
      </header>

      <main className="dashboard-content">
        <section className="info-section">
          <div className="info-card">
            <h3>How it works</h3>
            <p>
              Magic Code automatically detects and copies sign-in codes from your emails.
              When you receive an email with a verification code, it will be:
            </p>
            <ul>
              <li>Automatically detected and parsed</li>
              <li>Copied to your clipboard</li>
              <li>Displayed below for your reference</li>
            </ul>
          </div>
        </section>

        <MagicCodeList />
      </main>
    </div>
  );
};

export default Dashboard;
