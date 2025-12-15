import type { PKCEConfig, TokenResponse, PKCEPair } from "./types.ts";
import * as crypto from "crypto";
import { config as dotenvConfig } from "dotenv";
import express from "express";

/**
 * Loads and validates OAuth PKCE configuration from environment variables
 * Note: PKCE flow doesn't require APP_SECRET (uses code_verifier instead)
 * @param validateGrantType - Whether to validate GRANT_TYPE matches PKCE (default true for standalone, false when called from other scripts)
 * @throws Error if required environment variables are missing or invalid
 * @returns PKCEConfig object with OAuth endpoints and credentials
 */
function loadConfig(validateGrantType: boolean = true): PKCEConfig {
  dotenvConfig();

  const requiredVars = [
    "APP_KEY",
    "AUTHORIZATION_ENDPOINT",
    "TOKEN_ENDPOINT",
    "REDIRECT_URLS",
  ];
  const missing = requiredVars.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  // Validate GRANT_TYPE is set to PKCE (case-insensitive) only when running standalone
  if (validateGrantType) {
    const grantType = process.env.GRANT_TYPE?.toUpperCase();
    if (grantType && grantType !== "PKCE") {
      throw new Error(
        `GRANT_TYPE is set to '${process.env.GRANT_TYPE}' but this script requires GRANT_TYPE=PKCE`
      );
    }
  }

  const firstRedirectUrl = process.env.REDIRECT_URLS!.split(",")[0];
  const redirectUrl = new URL(process.env.REDIRECT_URLS!.split(",")[0]);
  if (redirectUrl.pathname === "/") {
    throw new Error(
      "Redirect URL must include a non-root path (e.g., /callback)"
    );
  }

  const port = redirectUrl.port ? parseInt(redirectUrl.port) : 3000;
  const callbackPath = redirectUrl.pathname;

  return {
    APP_KEY: process.env.APP_KEY!,
    REDIRECT_URL: firstRedirectUrl,
    AUTHORIZATION_URL: process.env.AUTHORIZATION_ENDPOINT!,
    TOKEN_URL: process.env.TOKEN_ENDPOINT!,
    PORT: port,
    CALLBACK_PATH: callbackPath,
  };
}

/**
 * Generates PKCE code_verifier and code_challenge pair
 * code_verifier: Random 32-byte base64url string
 * code_challenge: SHA256 hash of code_verifier in base64url format
 * @returns PKCEPair with codeVerifier (kept secret) and codeChallenge (sent to auth server)
 */
function generatePKCEPair(): PKCEPair {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeVerifier, codeChallenge };
}

/**
 * Generates OAuth authorization URL with PKCE code_challenge
 * Uses S256 challenge method (SHA256 hash)
 * @param config - OAuth PKCE configuration
 * @param codeChallenge - SHA256 hash of code_verifier
 * @returns Full authorization URL to redirect user to
 */
function generateAuthUrl(config: PKCEConfig, codeChallenge: string): string {
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: config.APP_KEY,
    redirect_uri: config.REDIRECT_URL,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const fullAuthUrl = `${config.AUTHORIZATION_URL}?${authParams.toString()}`;

  console.log(
    `Please visit the following URL to authorize the application:`
  );
  console.log("--------------------------------------");
  console.log(`\t${fullAuthUrl}`);
  console.log("--------------------------------------");

  return fullAuthUrl;
}

/**
 * Exchanges authorization code for access token using PKCE
 * Sends code_verifier to prove ownership of code_challenge
 * No client_secret needed (PKCE flow)
 * @param code - Authorization code from OAuth callback
 * @param codeVerifier - Original code_verifier (proves PKCE challenge)
 * @param config - OAuth PKCE configuration
 * @returns Object with tokenResponse (on success) or error message
 */
async function requestAccessToken(
  code: string,
  codeVerifier: string,
  config: PKCEConfig
): Promise<{ tokenResponse: TokenResponse | null; error: string | null }> {
  const queryParameters = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.APP_KEY,
    code: code,
    redirect_uri: config.REDIRECT_URL,
    code_verifier: codeVerifier,
  });

  const response = await fetch(config.TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: queryParameters.toString(),
  });

  if (!response.ok) {
    console.error(
      "Failed to fetch access token:",
      response.status,
      response.statusText
    );
    return {
      tokenResponse: null,
      error: `Failed to fetch access token: ${response.status} ${response.statusText}`,
    };
  }

  const responseData = (await response.json()) as TokenResponse;
  return { tokenResponse: responseData, error: null };
}

/**
 * Refreshes access token using refresh token (PKCE flow)
 * Called automatically by refresh loop when token nears expiration
 * @param refreshToken - Valid refresh token from previous token response
 * @param config - OAuth PKCE configuration
 * @returns Object with tokenResponse (on success) or error message
 */
async function requestRefreshAccessToken(
  refreshToken: string,
  config: PKCEConfig
): Promise<{ tokenResponse: TokenResponse | null; error: string | null }> {
  const queryParameters = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.APP_KEY,
  });

  const response = await fetch(config.TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: queryParameters.toString(),
  });

  if (!response.ok) {
    console.error(
      "Failed to refresh access token:",
      response.status,
      response.statusText
    );
    return {
      tokenResponse: null,
      error: `Failed to refresh access token: ${response.status} ${response.statusText}`,
    };
  }

  const responseData = (await response.json()) as TokenResponse;
  return { tokenResponse: responseData, error: null };
}
type tokenCallback = (t: TokenResponse, isRefresh?: boolean) => void;

/**
 * Automatic token refresh loop (PKCE flow)
 * Refreshes tokens at 85% of expiration time to avoid token expiry
 * Retries up to 3 times on failure before giving up
 * Calls callback with new tokens for WebSocket reauthorization
 * @param tokenResponse - Initial token response with refresh_token
 * @param config - OAuth PKCE configuration
 * @param callback - Function to call with refreshed tokens
 */
async function refreshLoop(
  tokenResponse: TokenResponse,
  config: PKCEConfig,
  callback: tokenCallback
) {
  async function sleep(sec: number) {
    return new Promise((resolve) => setTimeout(resolve, sec * 1000));
  }

  let retries = 0;
  let refreshInterval = tokenResponse.expires_in * 0.85;
  while (true) {
    if (retries > 0) {
      // Retry after failure with 1 second delay
      console.log(`Retrying refresh... Attempt ${retries + 1}`);
      await sleep(1000);
    } else {
      // Normal refresh at 85% of token expiration
      const refreshDateTime = new Date(
        Date.now() + tokenResponse.expires_in * 1000
      );
      console.log(
        `Refresh logic will run every ${refreshInterval} seconds. Next refresh at ${refreshDateTime}`
      );
      await sleep(refreshInterval);
    }
    const { tokenResponse: refreshTokenResponse, error } =
      await requestRefreshAccessToken(
        tokenResponse?.refresh_token || "",
        config
      );
    if (error) {
      console.error("Error refreshing access token:", error);
      retries++;
      if (retries >= 3) {
        console.error("Max retries reached. Exiting refresh loop.");
        break;
      }
    } else if (refreshTokenResponse) {
      // Success: call callback and reset retry counter
      callback(refreshTokenResponse, true);

      retries = 0;
      refreshInterval = refreshTokenResponse.expires_in * 0.85;
      tokenResponse = refreshTokenResponse;
    }
  }
}

/**
 * Displays access token information to console
 * @param tokenResponse - Token response containing access token and expiration
 */
function printAccessToken(tokenResponse: TokenResponse) {
  console.log(`Token is expiring in ${tokenResponse.expires_in} seconds.`);
  console.log(`Access Token:\n\t${tokenResponse.access_token}`);
}

/**
 * Starts OAuth 2.0 Authorization Code Flow with PKCE server
 * Creates Express server to handle OAuth callback
 * Generates PKCE challenge pair for enhanced security
 * Automatically starts refresh loop when refresh token is available
 * @param tokenCallback - Callback to receive initial and refreshed tokens
 * @param validateGrantType - Whether to validate GRANT_TYPE matches PKCE (default true)
 * @returns void
 */
export function oauth2ServerPKCE(tokenCallback: tokenCallback, validateGrantType: boolean = true) {
  const app = express();
  const config = loadConfig(validateGrantType);
  const PORT = config.PORT;
  
  // Generate PKCE pair for this OAuth session
  const { codeVerifier, codeChallenge } = generatePKCEPair();
  let currentTokenResponse: TokenResponse | null = null;

  app.listen(PORT, (e) => {
    if (e) {
      console.log("Error starting server:", e);
    } else {
      console.log(`Express server started on http://localhost:${PORT}`);
    }
  });

  app.get("/", (req, res) => {
    res.send(
      "<h1>OAuth 2.0 Authorization Code Flow with PKCE Server is running</h1>"
    );
  });

  app.get(config.CALLBACK_PATH, async (req, res) => {
    const code = req.query["code"];
    
    // Exchange code for token using code_verifier
    const { tokenResponse, error } = await requestAccessToken(
      code as string,
      codeVerifier,
      config
    );
    if (error) {
      res.send(error);
    } else {
      res.send(
        "<h1>OAuth 2.0 Authorization Code Flow with PKCE has obtained a new access token!</h1>"
      );
    }
    if (!tokenResponse) {
      console.log(error);
      return;
    }
    
    // Pass initial token to callback
    tokenCallback(tokenResponse);
    
    // Start automatic refresh loop if refresh token available
    if (!tokenResponse.refresh_token) {
      console.log("No refresh token received; cannot start refresh loop.");
      return;
    }
    refreshLoop(tokenResponse, config, tokenCallback);
  });

  generateAuthUrl(config, codeChallenge);

  return currentTokenResponse;
}

// Only run the server if this file is executed directly
if (require.main === module) {
  oauth2ServerPKCE(printAccessToken);
}
