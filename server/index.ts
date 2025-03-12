import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "@libsql/client";
import { google } from "googleapis";
import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { getCookie } from "hono/cookie";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import * as cheerio from "cheerio"; // For HTML parsing

// Declare global variables for Gmail watch
declare global {
  var emailCheckIntervals: Record<string, NodeJS.Timeout>;
  var userAuthClients: Record<string, any>; // Store OAuth clients by user ID
}

// Load environment variables
config({ path: path.resolve(process.cwd(), "../.env") });

const app = new Hono();

// Add CORS middleware with proper configuration for cookies
app.use("/*", cors({
  origin: process.env.CLIENT_URL || "http://localhost:5173",
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE"],
  allowHeaders: ["Content-Type", "Authorization", "Cookie"],
  exposeHeaders: ["Set-Cookie"],
  maxAge: 86400,
}));
const PORT = process.env.PORT || 3000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

// Set up Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Turso DB client
const db = createClient({
  url: process.env.DATABASE_URL as string,
  authToken: process.env.DATABASE_AUTH_TOKEN as string,
});

// Set up Google OAuth client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// User auth status endpoint that can also check for token errors
app.get("/api/auth/check", async (c) => {
  const user = c.get("user");
  
  try {
    // If we have a stored auth client for this user, test it
    if (global.userAuthClients && global.userAuthClients[user.id]) {
      const auth = global.userAuthClients[user.id];
      
      try {
        // Test the token by making a simple API call
        const gmail = google.gmail({ version: "v1", auth });
        await gmail.users.getProfile({ userId: "me" });
        
        // If we get here, the token is valid
        return c.json({ 
          status: "authenticated",
          valid: true,
          email: user.email
        });
      } catch (error) {
        // Check if this is an auth error
        if (error.message && 
            (error.message.includes('invalid_grant') || 
             error.message.includes('invalid_rapt'))) {
          
          // Clear token in database
          await db.execute({
            sql: "UPDATE users SET access_token = NULL, refresh_token = NULL WHERE id = ?",
            args: [user.id]
          });
          
          // Clear cached client
          delete global.userAuthClients[user.id];
          
          return c.json({ 
            status: "token_expired",
            valid: false,
            message: "Your Google authentication has expired. Please sign in again.",
            email: user.email
          });
        }
        
        // Some other error
        return c.json({ 
          status: "error",
          valid: false,
          message: "Error verifying authentication status",
          email: user.email
        });
      }
    }
    
    // No stored auth client
    return c.json({ 
      status: "authenticated",
      valid: true,
      email: user.email
    });
  } catch (error) {
    console.error("Error checking auth status:", error);
    return c.json({ 
      status: "error",
      valid: false,
      message: "Error checking authentication status"
    });
  }
});

// Define database schema initialization
async function initializeDatabase() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS magic_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT REFERENCES users(id),
        code TEXT NOT NULL,
        website TEXT,
        email_id TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Create a table to track all checked emails, even if no codes were found
    await db.execute(`
      CREATE TABLE IF NOT EXISTS checked_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT REFERENCES users(id),
        email_id TEXT UNIQUE NOT NULL,
        has_code BOOLEAN DEFAULT 0,
        checked_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Create indexes for faster lookups
    try {
      // Index for faster lookups by email_id
      await db.execute("CREATE INDEX IF NOT EXISTS idx_checked_emails_email_id ON checked_emails(email_id)");
      
      // Composite index for looking up by user_id + email_id
      await db.execute("CREATE INDEX IF NOT EXISTS idx_checked_emails_user_email ON checked_emails(user_id, email_id)");
      
      console.log("Created indexes on checked_emails table");
    } catch (indexError) {
      console.warn("Error creating indexes on checked_emails table:", indexError);
    }
    
    // Add email_id column if it doesn't exist yet (for backward compatibility)
    try {
      // Check if the column exists
      const columnCheck = await db.execute({
        sql: "PRAGMA table_info(magic_codes)",
        args: []
      });
      
      // If email_id column doesn't exist, add it
      const hasEmailIdColumn = columnCheck.rows.some((row: any) => row.name === 'email_id');
      if (!hasEmailIdColumn) {
        console.log("Adding email_id column to magic_codes table");
        await db.execute({
          sql: "ALTER TABLE magic_codes ADD COLUMN email_id TEXT",
          args: []
        });
      }
    } catch (alterError) {
      console.warn("Error checking/adding email_id column:", alterError);
      // Continue even if this fails, as it's not critical
    }

    console.log("Database schema initialized");
  } catch (error) {
    console.error("Error initializing database:", error);
  }
}

// Utility function to set cookies since c.cookie() isn't available
const setCookieHeader = (name: string, value: string, options: any = {}) => {
  const { httpOnly = true, path = "/", maxAge, sameSite = "Lax", secure = false } = options;
  
  let cookie = `${name}=${value}`;
  if (path) cookie += `; Path=${path}`;
  if (httpOnly) cookie += "; HttpOnly";
  if (maxAge) cookie += `; Max-Age=${maxAge}`;
  if (sameSite) cookie += `; SameSite=${sameSite}`;
  if (secure) cookie += "; Secure";
  
  return cookie;
};

// Add a non-protected endpoint for debugging
app.get("/debug/cookies", (c) => {
  const cookies = c.req.raw.headers.get("cookie");
  const authCookie = getCookie(c, "auth");
  return c.json({
    allCookies: cookies,
    authCookie: authCookie,
    hasAuth: !!authCookie
  });
});

// Endpoint to check if a user is authenticated without requiring auth
app.get("/auth/status", async (c) => {
  const authHeader = c.req.header("Authorization");
  const authCookie = getCookie(c, "auth");
  
  // Get token from either header or cookie
  const token = authCookie || (authHeader ? authHeader.replace("Bearer ", "") : null);
  
  if (!token) {
    return c.json({ authenticated: false });
  }
  
  try {
    // Look up the user
    const user = await db.execute({
      sql: "SELECT id, email FROM users WHERE id = ?",
      args: [token],
    });
    
    if (user.rows.length === 0) {
      return c.json({ authenticated: false });
    }
    
    // User exists and is authenticated
    return c.json({ 
      authenticated: true, 
      userId: user.rows[0].id,
      email: user.rows[0].email
    });
  } catch (error) {
    console.error("Error checking auth status:", error);
    return c.json({ authenticated: false });
  }
});

// Middleware for authentication
app.use("/api/*", async (c, next) => {
  // Try to get auth token from cookie first
  const authCookie = getCookie(c, "auth");
  
  // Then try getting token from Authorization header (for localStorage approach)
  const authHeader = c.req.header("Authorization");
  const token = authCookie || (authHeader ? authHeader.replace("Bearer ", "") : null);
  
  console.log("Auth token in middleware:", token);
  
  if (!token) {
    console.log("No auth token found in request");
    return c.json({ error: "Unauthorized", message: "No auth token found" }, 401);
  }
  
  try {
    const user = await db.execute({
      sql: "SELECT * FROM users WHERE id = ?",
      args: [token],
    });
    
    if (user.rows.length === 0) {
      console.log("User not found for ID:", token);
      return c.json({ error: "Unauthorized", message: "User not found" }, 401);
    }
    
    console.log("User authenticated successfully:", user.rows[0].email);
    c.set("user", user.rows[0]);
    return next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// Define Google auth routes
app.get("/auth/google", (c) => {
  console.log("Redirecting to Google OAuth with URI:", process.env.GOOGLE_REDIRECT_URI);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/pubsub",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify", // Added for marking emails as read
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    prompt: "consent",
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
  });
  
  return c.redirect(authUrl);
});

app.get("/auth/google/callback", async (c) => {
  const code = c.req.query("code");
  
  if (!code) {
    return c.redirect(`${CLIENT_URL}/login?error=invalid_request`);
  }
  
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Get user info
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: "v2",
    });
    
    const userInfo = await oauth2.userinfo.get();
    const userId = userInfo.data.id;
    const email = userInfo.data.email;
    
    if (!userId || !email || !tokens.access_token || !tokens.refresh_token) {
      return c.redirect(`${CLIENT_URL}/login?error=missing_tokens`);
    }
    
    // Store user in database
    await db.execute({
      sql: `
        INSERT INTO users (id, email, access_token, refresh_token)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          updated_at = strftime('%s', 'now')
      `,
      args: [userId, email, tokens.access_token, tokens.refresh_token],
    });
    
    // Set up Gmail pubsub watch
    await setupGmailWatch(userId, tokens.access_token, tokens.refresh_token);
    
    // Redirect to the client app with auth info in query params
    console.log("Successfully authenticated Google user:", email);
    
    // Check if this auth came from the extension
    const fromExtension = c.req.query("from_extension") === "true";
    
    // Build the redirect URL with appropriate query parameters
    const redirectUrl = `${CLIENT_URL}/dashboard?` + new URLSearchParams({
      token: userId,
      email: email,
      from_extension: fromExtension ? "true" : "false", 
      auth_success: "true",
      auth_timestamp: Date.now().toString()
    }).toString();
    
    console.log(`Redirecting to ${redirectUrl}`);
    
    // Redirect to the dashboard page with auth parameters
    return c.redirect(redirectUrl);
    
    // Old approach - commented out, replaced with redirect
    /*
    return c.html(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Successful</title>
        <style>
          body { font-family: sans-serif; text-align: center; padding: 40px; }
          h1 { color: #4285F4; }
          .success { color: #34A853; margin: 30px 0; }
          .loader { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 30px; height: 30px; animation: spin 2s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <h1>Magic Code</h1>
        <div class="success">✓ Authentication successful!</div>
        <div class="loader"></div>
        <p id="status-message">Completing authentication...</p>
        
        <script>
          // Store the token in localStorage for both web app and extension
          localStorage.setItem("authToken", "${userId}");
          localStorage.setItem("magicCodeAuthToken", "${userId}");
          document.getElementById("status-message").textContent = "Authentication complete!";

          // Function to check if this auth came from the extension
          function checkExtensionAuth() {
            // First check the URL parameter
            const urlParams = new URLSearchParams(window.location.search);
            const fromExtensionParam = urlParams.get('from_extension') === 'true';
            
            // Then check localStorage flag
            const fromExtensionStorage = localStorage.getItem('auth_from_extension') === 'true';
            const extensionAuthTimestamp = localStorage.getItem('extension_auth_timestamp');
            
            // Consider the auth from extension if either condition is true
            const fromExtension = fromExtensionParam || fromExtensionStorage;
            
            // If it's recent (within last 5 minutes), it's valid
            const isRecent = extensionAuthTimestamp && 
              (Date.now() - parseInt(extensionAuthTimestamp)) < 5 * 60 * 1000;
            
            return fromExtension && (!extensionAuthTimestamp || isRecent);
          }

          // Function to try launching or connecting to the extension
          function processAuth() {
            try {
              // Check if this auth came from the extension
              const fromExtension = checkExtensionAuth();
              console.log("Auth from extension:", fromExtension);
              
              if (fromExtension) {
                document.getElementById("status-message").textContent = "Opening extension...";
                
                // Clear the extension auth flags
                localStorage.removeItem('auth_from_extension');
                localStorage.removeItem('extension_auth_timestamp');
                
                // Try multiple methods to communicate with the extension
                
                // Method 1: Try direct chrome extension messaging
                if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                  try {
                    // Try with explicit extension ID first
                    const knownExtensionIds = [
                      // You can hardcode some known extension IDs here
                      "EXTENSION_ID1",
                      "EXTENSION_ID2"
                    ];
                    
                    for (const id of knownExtensionIds) {
                      try {
                        chrome.runtime.sendMessage(
                          id,
                          { type: "AUTH_TOKEN", token: "${userId}" },
                          function(response) {
                            console.log("Extension response:", response);
                          }
                        );
                      } catch (e) {
                        console.log("Could not message specific extension:", e);
                      }
                    }
                    
                    // Then try with no specific ID (works if this code runs in extension context)
                    chrome.runtime.sendMessage(
                      { type: "AUTH_TOKEN", token: "${userId}" },
                      function(response) {
                        console.log("Extension response:", response);
                      }
                    );
                  } catch (e) {
                    console.log("Could not message extension:", e);
                  }
                }
                
                // Method 2: Try to send a window message
                try {
                  window.opener.postMessage({ 
                    type: "MAGIC_CODE_AUTH", 
                    token: "${userId}" 
                  }, "*");
                } catch (e) {
                  console.log("Could not message opener:", e);
                }
                
                // Method 3: Try to create a special URL that Chrome extension might intercept
                try {
                  const magicUrl = "magiccode://auth?token=${userId}";
                  const iframe = document.createElement('iframe');
                  iframe.style.display = 'none';
                  iframe.src = magicUrl;
                  document.body.appendChild(iframe);
                  setTimeout(() => document.body.removeChild(iframe), 100);
                } catch (e) {
                  console.log("Could not create protocol handler iframe:", e);
                }
                
                // Try to open the Chrome extension directly
                const openExtension = () => {
                  try {
                    document.getElementById("status-message").textContent = "Opening Magic Code extension...";
                    
                    // Attempt to open the extension directly using chrome-extension:// protocol
                    // This needs the extension ID, so we'll try a fallback approach
                    try {
                      // Try to get the extension ID from Chrome if possible
                      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
                        // If we're already in extension context, we can get the ID
                        const extensionId = chrome.runtime.id;
                        window.location.href = "chrome-extension://"+extensionId+"/index.html?token=${userId}";
                        return;
                      }
                    } catch (e) {
                      console.log('Not in extension context:', e);
                    }
                    
                    // Try the generic chrome extension URL (this works in some Chrome versions)
                    window.location.href = "chrome-extension://extension/index.html?token=${userId}";
                    
                    // Set a fallback to redirect after a delay (if direct open fails)
                    setTimeout(() => {
                      document.getElementById("status-message").textContent = "Redirecting to Magic Code web app...";
                      window.location.href = "${CLIENT_URL}/auth-callback?token=${userId}&from_extension=complete";
                    }, 1500);
                  } catch (e) {
                    console.error('Error opening extension:', e);
                    // Fallback to normal redirect
                    window.location.href = "${CLIENT_URL}/auth-callback?token=${userId}&from_extension=complete";
                  }
                };
                
                // After a short delay, try to open the extension
                setTimeout(openExtension, 1000);
              } else {
                // Normal web app auth
                document.getElementById("status-message").textContent = "Redirecting to app...";
                setTimeout(() => {
                  window.location.href = "${CLIENT_URL}/auth-callback?token=${userId}";
                }, 1000);
              }
            } catch (err) {
              console.error("Auth processing error:", err);
              // Fall back to web app redirect
              document.getElementById("status-message").textContent = "Redirecting to app...";
              setTimeout(() => {
                window.location.href = "${CLIENT_URL}/auth-callback?token=${userId}";
              }, 1000);
            }
          }
          
          // Process the auth after a short delay
          setTimeout(processAuth, 500);
        </script>
      </body>
      </html>
    */
    //`);
  } catch (error) {
    console.error("Error in Google callback:", error);
    return c.redirect(`${CLIENT_URL}/login?error=auth_error`);
  }
});

// API routes
app.get("/api/user", async (c) => {
  const user = c.get("user");
  return c.json({ email: user.email });
});

app.get("/api/logout", (c) => {
  // Clear the auth cookie by setting an empty value and immediate expiration
  const cookieHeader = setCookieHeader("auth", "", { 
    path: "/",
    httpOnly: true,
    maxAge: 0,
  });
  
  return c.json({ success: true, message: "Logged out successfully" }, 200, {
    "Set-Cookie": cookieHeader
  });
});

app.get("/api/magic-codes", async (c) => {
  try {
    const user = c.get("user");
    const result = await db.execute({
      sql: `
        SELECT * FROM magic_codes
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 50
      `,
      args: [user.id],
    });
    
    return c.json(result.rows);
  } catch (error) {
    console.error("Error fetching magic codes:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// Gmail polling setup (checking every 20 seconds)
async function setupGmailWatch(userId: string, accessToken: string, refreshToken: string) {
  try {
    console.log(`Setting up Gmail polling for user ${userId}`);
    
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    
    auth.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    
    // Store auth client for reuse
    if (!global.userAuthClients) {
      global.userAuthClients = {};
    }
    global.userAuthClients[userId] = auth;
    
    // Set up efficient polling (every 20 seconds)
    const existingIntervals = global.emailCheckIntervals || {};
    
    // Clear existing interval if there is one
    if (existingIntervals[userId]) {
      console.log(`Clearing existing email check interval for user ${userId}`);
      clearInterval(existingIntervals[userId]);
    }
    
    // Set up a new interval (every 20 seconds)
    console.log(`Setting up 20-second polling interval for user ${userId}`);
    const intervalId = setInterval(() => checkNewEmails(userId, auth), 5000);
    
    // Store the interval ID
    existingIntervals[userId] = intervalId;
    global.emailCheckIntervals = existingIntervals;
    
    // Do an immediate check for emails
    checkNewEmails(userId, auth);
  } catch (error) {
    console.error("Error setting up Gmail watch:", error);
  }
}

// Function to check for new emails
async function checkNewEmails(userId: string, auth: any) {
  try {
    const gmail = google.gmail({ version: "v1", auth });
    
    console.log(`Checking new emails for user: ${userId}`);
    
    // First verify we have proper scopes
    try {
      const tokenInfo = await auth.getTokenInfo(auth.credentials.access_token);
      console.log("Available scopes:", tokenInfo.scopes);
      
      const requiredScopes = [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify" // Needed to mark as read
      ];
      
      // Check if all required scopes are available
      const hasAllScopes = requiredScopes.every(scope => 
        tokenInfo.scopes.includes(scope)
      );
      
      if (!hasAllScopes) {
        console.warn("Missing required Gmail scopes. Some functionality may be limited.");
      }
    } catch (error) {
      console.warn("Could not verify token scopes:", error);
    }
    
    // List new unread messages, using newer_than to only get recent emails
    // This gets emails from the last 10 minutes to ensure we don't miss any
    const response = await gmail.users.messages.list({
      userId: "me",
      maxResults: 10, // Increase limit to 10 to process more emails
      q: "is:unread newer_than:1d", // Get emails from the last 1day
    });
    
    const messages = response.data.messages || [];
    console.log(`Found ${messages.length} new unread messages from the last 10 minutes`);
    
    for (const message of messages) {
      // skip emails that are older than 10 minutes
      if (message.internalDate && new Date(parseInt(message.internalDate)) < new Date(Date.now() - 10 * 60 * 1000)) {
        continue
      }
      try {
        const messageId = message.id as string;
        
        // Check if this email has already been checked
        const alreadyChecked = await hasEmailBeenChecked(userId, messageId);
        if (alreadyChecked) {
          console.log(`Email ${messageId} has already been checked, skipping`);
          continue;
        }
        
        const email = await gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });
        
        const subject = email.data.payload?.headers?.find(
          (header: any) => header.name.toLowerCase() === "subject"
        )?.value || "";
        
        const from = email.data.payload?.headers?.find(
          (header: any) => header.name.toLowerCase() === "from"
        )?.value || "";
        
        const internalDate = email.data.internalDate ? 
            new Date(parseInt(email.data.internalDate)).toLocaleString() : 'unknown time';
        
        console.log(`Processing new email from ${internalDate}: "${subject}" from ${from}`);
        
        let plainTextBody = "";
        let htmlBody = "";
        
        // Extract both plain text and HTML versions of the email
        if (email.data.payload?.parts) {
          for (const part of email.data.payload.parts) {
            if (part.mimeType === "text/plain" && part.body?.data) {
              plainTextBody += Buffer.from(part.body.data, "base64").toString("utf-8");
            }
            if (part.mimeType === "text/html" && part.body?.data) {
              htmlBody += Buffer.from(part.body.data, "base64").toString("utf-8");
            }
            
            // Handle nested multipart content
            if (part.parts) {
              for (const nestedPart of part.parts) {
                if (nestedPart.mimeType === "text/plain" && nestedPart.body?.data) {
                  plainTextBody += Buffer.from(nestedPart.body.data, "base64").toString("utf-8");
                }
                if (nestedPart.mimeType === "text/html" && nestedPart.body?.data) {
                  htmlBody += Buffer.from(nestedPart.body.data, "base64").toString("utf-8");
                }
              }
            }
          }
        } else if (email.data.payload?.body?.data) {
          // If there's just a single body part
          const rawContent = Buffer.from(email.data.payload.body.data, "base64").toString("utf-8");
          if (email.data.payload.mimeType === "text/html") {
            htmlBody = rawContent;
          } else {
            plainTextBody = rawContent;
          }
        }
        
        // Use plain text body if available, otherwise extract text from HTML
        let body = plainTextBody;
        
        // If we only have HTML, parse it to extract text
        if (htmlBody && !plainTextBody) {
          try {
            console.log("Email only has HTML content, parsing HTML to extract text");
            const $ = cheerio.load(htmlBody);
            
            // Remove scripts, styles, and other non-content elements
            $("script, style, meta, link, noscript").remove();
            
            // Extract text content
            body = $("body").text().replace(/\s+/g, " ").trim();
            console.log("Successfully extracted text from HTML email");
          } catch (htmlError) {
            console.warn("Error parsing HTML content:", htmlError.message);
            // Fallback to raw HTML if parsing fails
            body = htmlBody;
          }
        }
        
        console.log(`Email body length: ${body.length} characters`);
        if (body.length > 500) {
          console.log(`Email preview: ${body.substring(0, 500)}...`);
        } else {
          console.log(`Full email body: ${body}`);
        }
        
        // Process the email for magic codes - returns true if a code was found
        const codeFound = await processMagicCode(userId, subject, from, body, messageId);
        
        // Always mark this email as checked in our database
        await markEmailAsChecked(userId, messageId, codeFound);
        
        // Only mark as read in Gmail if a magic code was found
        if (codeFound) {
          try {
            await gmail.users.messages.modify({
              userId: "me",
              id: messageId,
              requestBody: {
                removeLabelIds: ["UNREAD"],
              },
            });
            console.log(`Marked message ${messageId} as read because it contained a magic code`);
          } catch (modifyError) {
            console.warn(`Could not mark message as read due to permissions:`, modifyError.message);
          }
        } else {
          console.log(`Keeping message ${messageId} as unread (no magic code found)`);
        }
      } catch (messageError) {
        console.error(`Error processing message ${message.id}:`, messageError);
        // Continue with other messages even if one fails
      }
    }
  } catch (error) {
    console.error("Error checking new emails:", error);
    
    // Handle the invalid_grant/invalid_rapt error specifically
    if (error.message && 
        (error.message.includes('invalid_grant') || 
         error.message.includes('invalid_rapt'))) {
      console.log(`OAuth token expired for user ${userId}. User needs to re-authenticate.`);
      
      try {
        // Clear the stored OAuth credentials for this user
        if (global.userAuthClients && global.userAuthClients[userId]) {
          delete global.userAuthClients[userId];
          console.log(`Cleared stored OAuth client for user ${userId}`);
        }
        
        // Clear any intervals
        if (global.emailCheckIntervals && global.emailCheckIntervals[userId]) {
          clearInterval(global.emailCheckIntervals[userId]);
          delete global.emailCheckIntervals[userId];
          console.log(`Cleared email check interval for user ${userId}`);
        }
        
        // You could also mark the user as needing re-authentication in your database
        // This would allow the frontend to show a proper message
        try {
          await db.execute({
            sql: "UPDATE users SET access_token = NULL, refresh_token = NULL WHERE id = ?",
            args: [userId]
          });
          console.log(`Cleared tokens in database for user ${userId}`);
        } catch (dbError) {
          console.error(`Error updating user database record:`, dbError);
        }
      } catch (cleanupError) {
        console.error(`Error during OAuth error cleanup:`, cleanupError);
      }
    }
  }
}

// Check if email has already been checked
async function hasEmailBeenChecked(userId: string, emailId: string): Promise<boolean> {
  try {
    const result = await db.execute({
      sql: "SELECT id FROM checked_emails WHERE user_id = ? AND email_id = ? LIMIT 1",
      args: [userId, emailId]
    });
    
    // If any rows are returned, the email has already been checked
    return result.rows && result.rows.length > 0;
  } catch (error) {
    console.error("Error checking if email has been checked:", error);
    // If there's an error, assume it hasn't been checked to be safe
    return false;
  }
}

// Mark an email as checked in the database
async function markEmailAsChecked(userId: string, emailId: string, hasCode: boolean): Promise<void> {
  try {
    await db.execute({
      sql: "INSERT OR IGNORE INTO checked_emails (user_id, email_id, has_code) VALUES (?, ?, ?)",
      args: [userId, emailId, hasCode ? 1 : 0]
    });
    console.log(`Marked email ${emailId} as checked (hasCode: ${hasCode}) for user ${userId}`);
  } catch (error) {
    console.error(`Error marking email ${emailId} as checked:`, error);
    // Don't throw the error up to maintain processing flow
  }
}

// Check if a magic code has already been extracted from an email
async function hasEmailBeenProcessed(emailId: string): Promise<boolean> {
  try {
    const result = await db.execute({
      sql: "SELECT id FROM magic_codes WHERE email_id = ? LIMIT 1",
      args: [emailId]
    });
    
    // If any rows are returned, the email has been processed
    return result.rows && result.rows.length > 0;
  } catch (error) {
    console.error("Error checking if email has been processed:", error);
    // If there's an error, assume it hasn't been processed to be safe
    return false;
  }
}

// Process email content for magic codes
async function processMagicCode(userId: string, subject: string, from: string, body: string, messageId: string): Promise<boolean> {
  try {
    console.log(`Processing email ${messageId} for magic codes: "${subject.substring(0, 30)}..." from ${from}`);
    
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("Missing ANTHROPIC_API_KEY in environment variables");
      return false;
    }
    
    // Limit the body logging to prevent massive console output
    if (body.length > 500) {
      console.log(`Email body preview: ${body.substring(0, 500)}...`);
    } else {
      console.log(`Full email body: ${body}`);
    }
    
    console.log("Calling Claude API to analyze email content");
    
    // Use Claude to check if the email contains a magic code
    // Log what we're sending to Claude for analysis
    console.log("Sending the following to Claude for magic code detection:");
    console.log(`Subject: ${subject}`);
    console.log(`From: ${from}`);
    console.log(`Body length: ${body.length} characters`);
    
    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1000,
      temperature: 0,
      system: "You are an AI that analyzes emails to extract magic codes, OTP codes, 2FA codes, verification codes, or login links.\n\nRULES (VERY IMPORTANT):\n1. Return ONLY the exact code or full login link - NO explanation, NO commentary, NO formatting.\n2. If multiple codes exist, return ONLY the most likely authentication code.\n3. If you find no valid code, return EXACTLY the single word \"NONE\" (uppercase).\n\nCODE TYPES TO LOOK FOR:\n1. MAGIC CODES: 6-8 characters (letters/numbers) for 2FA or login\n2. VERIFICATION CODES: 4-8 digits (sometimes 3-10 digits)\n3. MAGIC LINKS: Complete URLs containing 'verify', 'confirm', 'login', 'sign-in', or 'authenticate'\n4. OTP CODES: One-time passwords, usually 4-8 digits\n5. SECURITY CODES: Labeled as security code, security number, or verification code\n\nPay special attention to text following phrases like:\n- 'Your code is'\n- 'Your verification code is'\n- 'Your security code is'\n- 'Your OTP is'\n- 'Your one-time passcode is'\n- 'Enter this code'\n- 'Use code'\n- 'Verification code'\n\nExample outputs:\n- \"123456\" (just the digits, no quotes)\n- \"ABCD1234\" (just the code, no quotes)\n- \"https://example.com/verify?token=abc123\" (just the URL, no quotes)\n- \"NONE\" (if no code found)",
      messages: [
        {
          role: "user",
          content: `Subject: ${subject}\nFrom: ${from}\nBody: ${body.substring(0, 4000)}`,
        },
      ],
    });
    
    const result = message.content[0].text;
    console.log(`Claude API result for message ${messageId}:`, result);
    
    // More rigorous validation of the Claude response
    if (result && result !== "NONE" && result.trim() !== "") {
      let code = result.trim();
      
      // Additional validation to ensure it's actually a code or meaningful text
      // Skip very long responses or ones that look like explanations
      if (code.length > 100 || code.toLowerCase().includes("sorry") || 
          code.toLowerCase().includes("i found") || code.toLowerCase().includes("i cannot")) {
        console.log(`Claude returned invalid code format: ${code.substring(0, 50)}...`);
        return false;
      }
      
      // Extract website domain from the "from" email address
      let website = "Unknown";
      const emailMatch = from.match(/[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (emailMatch && emailMatch[1]) {
        website = emailMatch[1];
        
        // If it includes a website domain, extract just the main domain
        if (website.includes(".")) {
          const parts = website.split(".");
          if (parts.length >= 2) {
            website = parts.slice(-2).join(".");
          }
        }
      }
      
      console.log(`Magic code detected in message ${messageId}! Website: ${website}, Code: ${code}`);
      
      // Store the email ID to prevent reprocessing
      const emailId = messageId;
      
      // Store in database with email ID for deduplication
      await db.execute({
        sql: "INSERT INTO magic_codes (user_id, code, website, email_id) VALUES (?, ?, ?, ?)",
        args: [userId, code, website, emailId],
      });
      console.log(`Stored magic code in database for user ${userId}`);
      
      console.log(`Magic code found from ${website}: ${code}`);
      return true;
    } else {
      console.log(`No magic code detected in message ${messageId}`);
      return false;
    }
  } catch (error) {
    console.error(`Error processing message ${messageId} for magic codes:`, error);
    if (error.message) {
      console.error("Error details:", error.message);
    }
    return false;
  }
}

// We've replaced Pub/Sub with direct polling

// Health check endpoint
app.get("/", (c) => c.text("Magic Code Server Running"));

// Function to start email checking for all users
async function initializeAllUsersEmailChecking() {
  try {
    console.log("Starting email checking for all existing users...");
    
    // First, check if the users table exists before querying
    try {
      // Verify the table exists before querying
      const tableCheck = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
        args: []
      });
      
      if (!tableCheck.rows || tableCheck.rows.length === 0) {
        console.log("Users table doesn't exist yet - no users to initialize");
        return;
      }
    } catch (schemaError) {
      console.error("Error checking if users table exists:", schemaError);
      return;
    }
    
    try {
      // Use a simpler query format
      console.log("Querying for users with a simple query...");
      const usersResult = await db.execute("SELECT id, email, access_token, refresh_token FROM users");
      console.log("Query returned:", usersResult);
      
      if (!usersResult.rows) {
        console.log("No rows returned from database");
        return;
      }
      
      const users = usersResult.rows;
      console.log(`Found ${users.length} user(s) to initialize email checking for`);
      
      if (users.length === 0) {
        console.log("No users found in database to initialize email checking for");
        return;
      }
      
      // Set up email checking for each user
      let successCount = 0;
      for (let i = 0; i < users.length; i++) {
        try {
          const user = users[i];
          
          // Log the user structure to debug
          console.log(`User data structure:`, JSON.stringify(user));
          
          // Check if the user has the required fields
          if (!user || !user.id || !user.access_token || !user.refresh_token) {
            console.warn(`Skipping user due to missing required fields`);
            continue;
          }
          
          const userId = user.id;
          const accessToken = user.access_token;
          const refreshToken = user.refresh_token;
          
          console.log(`Initializing email checking for user: ${user.email || userId}`);
          await setupGmailWatch(userId, accessToken, refreshToken);
          successCount++;
        } catch (userError) {
          // Log error but continue with other users
          console.error(`Error initializing email checking for user:`, userError);
        }
      }
      
      console.log(`Email checking initialized for ${successCount} out of ${users.length} users`);
    } catch (queryError) {
      console.error("Error querying users table:", queryError);
    }
  } catch (error) {
    console.error("Error initializing email checking for all users:", error);
  }
}

// Cleanup function to prevent the checked_emails table from growing too large
async function cleanupOldCheckedEmails() {
  try {
    // Keep emails from the last 30 days, delete older ones
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    
    // Delete entries older than 30 days
    const result = await db.execute({
      sql: "DELETE FROM checked_emails WHERE checked_at < ?",
      args: [thirtyDaysAgo]
    });
    
    if (result.rowsAffected > 0) {
      console.log(`Cleaned up ${result.rowsAffected} old entries from checked_emails table`);
    }
  } catch (error) {
    console.error("Error cleaning up old checked emails:", error);
  }
  
  // Schedule next cleanup in 24 hours
  setTimeout(cleanupOldCheckedEmails, 24 * 60 * 60 * 1000);
}

// Initialize database and start server
(async () => {
  await initializeDatabase();
  
  serve({
    fetch: app.fetch,
    port: Number(PORT),
  });
  
  console.log(`Server is running on http://localhost:${PORT}`);
  
  // Start checking emails for all users
  await initializeAllUsersEmailChecking();
  
  // Start the periodic cleanup (after a 1-hour delay)
  setTimeout(cleanupOldCheckedEmails, 60 * 60 * 1000);
})();
