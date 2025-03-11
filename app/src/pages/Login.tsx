import GoogleLoginButton from "../components/GoogleLoginButton";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { checkAuth } from "../services/api";

const Login: React.FC = () => {
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<boolean>(true);
  const navigate = useNavigate();

  useEffect(() => {
    // Check for error query parameter
    const urlParams = new URLSearchParams(window.location.search);
    const errorParam = urlParams.get("error");
    if (errorParam) {
      switch (errorParam) {
        case "invalid_request":
          setError("Invalid request. Please try again.");
          break;
        case "auth_error":
          setError("Authentication error. Please try again.");
          break;
        case "missing_tokens":
          setError("Google authentication incomplete. Please ensure you allow all required permissions.");
          break;
        case "session_expired":
          setError("Your session has expired. Please sign in again.");
          break;
        case "no_token":
          setError("Authentication failed. No token was provided by the server.");
          break;
        default:
          setError("An error occurred. Please try again.");
      }
    }

    // Check if user is already logged in
    const doAuthCheck = async () => {
      setChecking(true);
      try {
        const isLoggedIn = await checkAuth();
        if (isLoggedIn) {
          console.log("User is authenticated, redirecting to dashboard");
          navigate("/dashboard"); // Redirect to dashboard if logged in
        } else {
          console.log("User is not authenticated");
        }
      } catch (err) {
        console.error("Auth check error:", err);
        // User not logged in, stay on login page
      } finally {
        setChecking(false);
      }
    };

    doAuthCheck();
  }, [navigate]);

  return (
    <div className="login-page">
      <div className="login-container">
        <h1>Magic Code</h1>
        <p className="login-description">
          Automatically detect and copy magic sign-in codes from your emails.
          No more switching between tabs or apps to copy and paste codes!
        </p>
        {error && <div className="error-message">{error}</div>}
        {checking ? (
          <div className="loading">Checking authentication...</div>
        ) : (
          <GoogleLoginButton showDebugLogin={true} />
        )}
      </div>
    </div>
  );
};

export default Login;