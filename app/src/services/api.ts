import axios, { AxiosError } from "axios";
import { User, MagicCode } from "../types";

const API_URL = "http://localhost:3000";

// Create axios instance with proper configuration
const api = axios.create({
  baseURL: API_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Add request interceptor to add auth token from localStorage
api.interceptors.request.use(
  config => {
    const token = localStorage.getItem("authToken");
    if (token) {
      config.headers["Authorization"] = `Bearer ${token}`;
    }
    return config;
  },
  error => Promise.reject(error)
);

// Add response interceptor for better error handling
api.interceptors.response.use(
  response => response,
  (error: AxiosError) => {
    console.error("API Error:", error);
    if (error.response?.status === 401) {
      // Redirect to login on auth errors
      window.location.href = "/login?error=session_expired";
    }
    return Promise.reject(error);
  }
);

export const googleLogin = (): void => {
  window.location.href = `${API_URL}/auth/google`;
};

export const checkAuth = async (): Promise<boolean> => {
  try {
    // Check if token exists in localStorage
    const token = localStorage.getItem("authToken");
    if (!token) {
      console.log("No auth token in localStorage");
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
  try {
    // Call logout API endpoint
    await api.get("/api/logout");
  } catch (error) {
    console.error("Logout API error:", error);
  } finally {
    // Always clear localStorage and redirect
    localStorage.removeItem("authToken");
    window.location.href = "/login";
  }
};

export default api;