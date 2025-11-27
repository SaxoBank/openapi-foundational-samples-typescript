import type { Config, TokenResponse, tokenCallback } from "./types.ts";

import { config as dotenvConfig } from "dotenv";
import express from "express";

/**
 * Loads and validates OAuth configuration from environment variables
 * @param validateGrantType - Whether to validate GRANT_TYPE matches Code (default true for standalone, false when called from other scripts)
 * @throws Error if required environment variables are missing or invalid
 * @returns Config object with OAuth endpoints and credentials
 */
function loadConfig(validateGrantType: boolean = true): Config {
  dotenvConfig();

  const requiredVars = [
    "APP_KEY",
    "APP_SECRET",
    "AUTHORIZATION_ENDPOINT",
    "TOKEN_ENDPOINT",
    "REDIRECT_URLS",
  ];
  const missing = requiredVars.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  // Validate GRANT_TYPE is set to Code (case-insensitive) only when running standalone
  if (validateGrantType) {
    const grantType = process.env.GRANT_TYPE?.toUpperCase();
    if (grantType && grantType !== "CODE") {
      throw new Error(
        `GRANT_TYPE is set to '${process.env.GRANT_TYPE}' but this script requires GRANT_TYPE=Code`
      );
    }
  }

  const redirectUrl = new URL(process.env.REDIRECT_URLS!);
  if (redirectUrl.pathname === "/") {
    throw new Error(
      "Redirect URL must include a non-root path (e.g., /callback)"
    );
  }

  const port = redirectUrl.port ? parseInt(redirectUrl.port) : 3000;
  const callbackPath = redirectUrl.pathname;

  return {
    APP_KEY: process.env.APP_KEY!,
    APP_SECRET: process.env.APP_SECRET!,
    REDIRECT_URL: process.env.REDIRECT_URLS!,
    AUTHORIZATION_URL: process.env.AUTHORIZATION_ENDPOINT!,
    TOKEN_URL: process.env.TOKEN_ENDPOINT!,
    PORT: port,
    CALLBACK_PATH: callbackPath,
  };
}

/**
 * Generates OAuth authorization URL for user authentication
 * Constructs URL with required parameters: response_type, client_id, redirect_uri
 * @param config - OAuth configuration
 * @returns Full authorization URL to redirect user to
 */
function generateAuthUrl(config: Config): string {
  // Construct full authorization URL
  const authParams: URLSearchParams = new URLSearchParams({
    response_type: "code",
    client_id: config.APP_KEY,
    redirect_uri: config.REDIRECT_URL,
  });

  const fullAuthUrl: string = `${
    config.AUTHORIZATION_URL
  }?${authParams.toString()}`;

  console.log(
    `Please visit the following URL to authorize the application:`
  );
  console.log("--------------------------------------");
  console.log(`\t${fullAuthUrl}`);
  console.log("--------------------------------------");

  return fullAuthUrl;
}

/**
 * Exchanges authorization code for access token
 * Uses Basic Auth header for client credentials (recommended approach)
 * @param code - Authorization code from OAuth callback
 * @param config - OAuth configuration
 * @returns Object with tokenResponse (on success) or error message
 */
async function requestAccessToken(
  code: string,
  config: Config
): Promise<{ tokenResponse: TokenResponse | null; error: string | null }> {
  const queryParameters: URLSearchParams = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: config.REDIRECT_URL,
    // We instead suggest to include them as a basic auth header.
    // But they can be included as query params instead!
    // client_id: config.APP_KEY,
    // client_secret: config.APP_SECRET,
  });
  const basicAuth = Buffer.from(
    `${config.APP_KEY}:${config.APP_SECRET}`
  ).toString("base64");

  const response = await fetch(config.TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
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
  // console.log("Access Token Response Status:", response.status);
  const responseData = (await response.json()) as TokenResponse;
  // console.log("Access Token Response Data:", responseData);
  return { tokenResponse: responseData, error: null };
}

/**
 * Refreshes access token using refresh token
 * Called automatically by refresh loop when token nears expiration
 * @param refreshToken - Valid refresh token from previous token response
 * @param config - OAuth configuration
 * @returns Object with refreshTokenResponse (on success) or error message
 */
async function requestRefreshAccessToken(
  refreshToken: string,
  config: Config
): Promise<{
  refreshTokenResponse: TokenResponse | null;
  error: string | null;
}> {
  const queryParameters: URLSearchParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const basicAuth = Buffer.from(
    `${config.APP_KEY}:${config.APP_SECRET}`
  ).toString("base64");

  const response = await fetch(config.TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
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
      refreshTokenResponse: null,
      error: `Failed to refresh access token: ${response.status} ${response.statusText}`,
    };
  }
  const responseData = (await response.json()) as TokenResponse;
  return { refreshTokenResponse: responseData, error: null };
}

/**
 * Automatic token refresh loop
 * Refreshes tokens at 85% of expiration time to avoid token expiry
 * Retries up to 3 times on failure before giving up
 * Calls callback with new tokens for WebSocket reauthorization
 * @param tokenResponse - Initial token response with refresh_token
 * @param config - OAuth configuration
 * @param callback - Function to call with refreshed tokens
 */
async function refreshLoop(
  tokenResponse: TokenResponse,
  config: Config,
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
    const { refreshTokenResponse, error } = await requestRefreshAccessToken(
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
 * @param isRefresh - Whether this is a refreshed token (default: false)
 */
function printAccessToken(tokenResponse: TokenResponse, isRefresh = false) {
  console.log(`Token is expiring in ${tokenResponse.expires_in} seconds.`);
  console.log(`Access Token:\n\t${tokenResponse.access_token}`);
}

/**
 * Starts OAuth 2.0 Authorization Code Flow server
 * Creates Express server to handle OAuth callback
 * Automatically starts refresh loop when refresh token is available
 * @param tokenCallback - Callback to receive initial and refreshed tokens
 * @param validateGrantType - Whether to validate GRANT_TYPE matches Code (default true)
 * @returns void
 */
export function oauth2Server(tokenCallback: tokenCallback, validateGrantType: boolean = true) {
  const app = express();
  const config = loadConfig(validateGrantType);
  const PORT = config.PORT;
  let currentTokenResponse: TokenResponse | null = null;

  app.listen(PORT, (e) => {
    if (e) {
      console.log("Error starting server:", e);
    } else {
      console.log(`Express server started on http://localhost:${PORT}`);
    }
  });

  app.get("/", (req, res) => {
    res.send("<h1>OAuth 2.0 Authorization Code Flow Server is running</h1>");
  });

  // OAuth callback endpoint - receives authorization code and exchanges for token
  app.get(config.CALLBACK_PATH, async (req, res) => {
    const code = req.query["code"];
    const { tokenResponse, error } = await requestAccessToken(
      code as string,
      config
    );
    if (error) {
      res.send(error);
    } else {
      res.send(
        "<h1>OAuth 2.0 Authorization Code Flow has generated a new access token!</h1>"
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

  generateAuthUrl(config);

  return;
}

// Only run the server if this file is executed directly
if (require.main === module) {
  oauth2Server(printAccessToken);
}
