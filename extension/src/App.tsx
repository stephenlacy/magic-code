import { useState, useEffect } from 'react';
import GoogleLoginButton from './components/GoogleLoginButton';
import MagicCodeList from './components/MagicCodeList';
import AuthListener from './components/AuthListener';
import { checkAuth, logout, getUser } from './services/api';
import { AuthStatus, User } from './types';
import './App.css';

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>(AuthStatus.LOADING);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {


    chrome.storage.local.get('newestCode').then((code) => {
      console.log('code', code)
      if (code) {
        navigator.clipboard.writeText(code.newestCode)
      }
    })

    const verifyAuth = async () => {
      try {
        const isAuthenticated = await checkAuth();
        
        if (isAuthenticated) {
          setAuthStatus(AuthStatus.AUTHENTICATED);
          const userData = await getUser();
          setUser(userData);
        } else {
          setAuthStatus(AuthStatus.UNAUTHENTICATED);
        }
      } catch (error) {
        console.error('Auth verification error:', error);
        setAuthStatus(AuthStatus.UNAUTHENTICATED);
      }
    };

    verifyAuth();
  }, []);

  const handleLogout = async () => {
    try {
      console.log("APP: Starting logout process");
      
      // Show loading state while logout processes
      setAuthStatus(AuthStatus.LOADING);
      
      // First immediately remove user data from state to prevent UI from showing logged in state
      setUser(null);
      
      // Call logout function which has been enhanced with double-check mechanisms
      // The logout function will force a page reload when complete
      await logout();
      
      // If for some reason the logout function doesn't force a reload,
      // we'll reset the state and force a reload here as a backup
      console.log("APP: Backup logout cleanup triggered");
      setAuthStatus(AuthStatus.UNAUTHENTICATED);
      
      // Double check that Chrome storage is cleared
      chrome.storage.local.remove(['authToken'], () => {
        console.log("APP: Removed authToken as backup measure");
        
        // Force reload the extension UI to ensure a clean state
        console.log("APP: Forcing UI reload");
        window.location.reload();
      });
    } catch (error) {
      console.error("APP: Critical error during logout:", error);
      
      // Emergency cleanup
      setAuthStatus(AuthStatus.UNAUTHENTICATED);
      setUser(null);
      
      // Clear storage as a last resort
      chrome.storage.local.clear(() => {
        console.log("APP: Emergency storage clear completed");
        
        // Force UI reset
        window.location.reload();
      });
    }
  };

  return (
    <div className="app">
      <AuthListener />
      
      <header className="app-header">
        <h1>Magic Code</h1>
        {authStatus === AuthStatus.AUTHENTICATED && user && (
          <div className="user-controls">
            <span className="user-email">{user.email}</span>
            <button onClick={handleLogout} className="logout-btn">Logout</button>
          </div>
        )}
      </header>

      <main className="app-content">
        {authStatus === AuthStatus.LOADING ? (
          <div className="loading">Checking authentication...</div>
        ) : authStatus === AuthStatus.UNAUTHENTICATED ? (
          <div className="login-container">
            <p className="login-description">
              Sign in to automatically capture and copy magic codes from your emails.
            </p>
            <GoogleLoginButton />
          </div>
        ) : (
          <MagicCodeList />
        )}
      </main>

      <footer className="app-footer">
        <p>Magic Code Chrome Extension</p>
      </footer>
    </div>
  );
}

export default App;
