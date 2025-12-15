#!/usr/bin/env node
/**
 * Saxo OpenAPI balance streaming with WebSocket binary protocol.
 * Auto-fetches ClientKey and handles control messages.
 */

import { config } from "dotenv";
import { createSaxoWebsocketClient, parseMessageFrame } from "./streaming";
import { TextDecoder } from "util";
import * as crypto from "crypto";
import * as readline from "readline";
import {
  SaxoWebsocket,
  HeartbeatControlMessage,
  ResetSubscriptionsControlMessage,
  StreamingMessage,
  SavedSubscriptionData,
  SavedSessionData,
} from "./types";

import fs from "fs";
import path from "path";
import { oauth2Server } from "../auth/authSampleCode";
import { oauth2ServerPKCE } from "../auth/authSamplePkce";
import { TokenResponse } from "../auth/types";

// Load environment variables and setup logging
config();

// Global variables for auth state
let globalAccessToken: string | null = null;

// Configuration interface
interface AppConfig {
  readonly BASE_URL: string;
  readonly WEBSOCKET_CONNECT: string;
  readonly WEBSOCKET_REAUTHORIZE: string;
}

// Load and validate environment variables
function loadConfig(): AppConfig {
  const baseUrl = process.env.OPEN_API_BASE_URL;
  if (!baseUrl) {
    throw new Error("Missing OPEN_API_BASE_URL environment variable");
  }

  if (!baseUrl.includes("gateway.saxobank.com")) {
    throw new Error(
      `Invalid OPEN_API_BASE_URL: '${baseUrl}'. Must contain "gateway.saxobank.com"`
    );
  }

  return {
    BASE_URL: baseUrl.replace(/\/$/, ""),
    WEBSOCKET_CONNECT: process.env.WEBSOCKET_CONNECT || "",
    WEBSOCKET_REAUTHORIZE: process.env.WEBSOCKET_REAUTHORIZE || "",
  };
}

const { BASE_URL, WEBSOCKET_CONNECT, WEBSOCKET_REAUTHORIZE } = loadConfig();

/**
 * Prompts user for access token input via console
 * @returns Promise that resolves to the entered access token
 */
async function promptForAccessToken(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Please enter your ACCESS_TOKEN: ", (token) => {
      rl.close();
      resolve(token.trim());
    });
  });
}

/**
 * Generates a random base64url-encoded string for unique IDs
 * Used for creating context IDs and reference IDs
 */
function randomString(): string {
  return crypto.randomBytes(4).toString("base64url");
}

/**
 * Fetches client information from the OpenAPI
 * Returns ClientKey and ClientId needed for subscriptions
 * @param accessToken - Valid OAuth access token
 */
async function getClient(accessToken: string): Promise<any> {
  const response: Response = await fetch(`${BASE_URL}/port/v1/clients/me`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    console.log(`Failed to get client: HTTP ${response.status}`);
    return;
  }
  const clientData = await response.json();
  return clientData;
}

/**
 * Creates a new balance subscription via the OpenAPI
 * Stores the initial snapshot and initializes tracking metadata
 * @param contextId - WebSocket context ID
 * @param referenceId - Unique identifier for this subscription
 * @param clientKey - Client key from getClient()
 * @param accessToken - Valid OAuth access token
 * @param ws - WebSocket client instance
 * @returns Subscription response body including initial snapshot
 */
async function subscribeToBalances(
  contextId: string,
  referenceId: string,
  clientKey: string,
  accessToken: string,
  ws: SaxoWebsocket
): Promise<any> {
  const subscriptionRequest = {
    Arguments: { ClientKey: clientKey },
    ContextId: contextId,
    ReferenceId: referenceId,
  };

  const response: Response = await fetch(
    `${BASE_URL}/port/v1/balances/subscriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(subscriptionRequest),
    }
  );
  if (!response.ok) {
    console.log(
      `Failed to create balance subscription: HTTP ${response.status}`
    );
    return;
  }

  console.log("Balance subscription created successfully");
  const responseBody = (await response.json()) as any;

  // Initialize subscription tracking with metadata
  ws.subscriptions[referenceId] = {
    snapshot: responseBody.Snapshot,
    messages: [],
    status: "active",
    updateCount: 0,
    createdAt: new Date(),
    snapshotReceivedAt: new Date(),
  };
  return responseBody;
}

/**
 * Replaces an existing subscription with a new one
 * Used for handling _resetsubscriptions control messages
 * Old subscription is marked as "replaced", new one as "active"
 * Automatically saves subscription history after replacement
 * @param contextId - WebSocket context ID
 * @param referenceId - New subscription's reference ID
 * @param replaceReferenceId - Old subscription's reference ID to replace
 * @param clientKey - Client key from getClient()
 * @param accessToken - Valid OAuth access token
 * @param ws - WebSocket client instance
 * @returns New subscription response body
 */
async function replaceBalanceSubscription(
  contextId: string,
  referenceId: string,
  replaceReferenceId: string,
  clientKey: string,
  accessToken: string,
  ws: SaxoWebsocket
): Promise<any> {
  const subscriptionRequest = {
    Arguments: { ClientKey: clientKey },
    ContextId: contextId,
    ReferenceId: referenceId,
    ReplaceReferenceId: replaceReferenceId,
  };

  const response: Response = await fetch(
    `${BASE_URL}/port/v1/balances/subscriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(subscriptionRequest),
    }
  );
  if (!response.ok) {
    console.error(
      `Failed to replace subscription ${referenceId}: HTTP ${response.status}`
    );
  } else {
    console.log(`Replaced subscription '${replaceReferenceId}' with  '${referenceId}'`);
  }
  const responseBody = (await response.json()) as any;

  // Create new subscription and mark old one as replaced
  ws.subscriptions[referenceId] = {
    snapshot: responseBody.Snapshot,
    messages: [],
    status: "active",
    updateCount: 0,
    createdAt: new Date(),
    snapshotReceivedAt: new Date(),
  };
  ws.subscriptions[replaceReferenceId].status = "replaced";
  
  // Save immediately after replacement
  saveMessagesToFiles(ws);
  
  return responseBody;
}

/**
 * Deletes an existing subscription via the OpenAPI
 * Marks subscription as "deleted" in tracking
 * Automatically saves subscription history after deletion
 * @param contextId - WebSocket context ID
 * @param referenceId - Reference ID of subscription to delete
 * @param accessToken - Valid OAuth access token
 * @param ws - WebSocket client instance
 */
async function deleteBalanceSubscription(
  contextId: string,
  referenceId: string,
  accessToken: string,
  ws: SaxoWebsocket
): Promise<void> {
  const response: Response = await fetch(
    `${BASE_URL}/port/v1/balances/subscriptions/${contextId}/${referenceId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  if (!response.ok) {
    console.error(
      `Failed to delete subscription ${referenceId}: HTTP ${response.status}`
    );
  } else {
    console.log(`Deleted subscription ${referenceId}`);
  }
  ws.subscriptions[referenceId].status = "deleted";
  
  // Save immediately after deletion
  saveMessagesToFiles(ws);
}

/**
 * Saves subscription and control message history to JSON files
 * Creates streaming/stream_history/ directory if needed
 * Transforms in-memory subscription data to include:
 * - Context metadata (ID, created_at, reference_id_count)
 * - Initial snapshots with timestamps
 * - Last 50 messages per subscription
 * - Activity flags (has_snapshot, update_count, last_heartbeat)
 * - Subscription status (active/deleted/replaced)
 * @param ws - WebSocket client instance, or null to skip
 */
function saveMessagesToFiles(ws: SaxoWebsocket | null): void {
  if (!ws) return;
  try {
    const historyDir = path.join(__dirname, "stream_history");
    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
    }
    
    // Transform subscriptions to include activity flags and initial snapshot
    const totalReferenceIdCount = Object.keys(ws.subscriptions).length;
    
    const subscriptionsWithFlags = Object.entries(ws.subscriptions).reduce((acc, [key, sub]) => {
      // Keep only the last 50 messages for saving
      const lastMessages = sub.messages.slice(-50);
      
      acc[key] = {
        created_at: sub.createdAt || null,
        initial_snapshot: {
          timestamp: sub.snapshotReceivedAt || null,
          data: sub.snapshot
        },
        messages: lastMessages,
        activity_flags: {
          has_snapshot: !!sub.snapshot,
          update_count: sub.updateCount || 0,
          last_heartbeat: sub.latestHeartbeat || null
        },
        status: sub.status || "active",
      } as SavedSubscriptionData;
      return acc;
    }, {} as Record<string, SavedSubscriptionData>);
    
    const outputData: SavedSessionData = {
      context_id: ws.contextId,
      created_at: ws.contextCreatedAt || new Date(),
      reference_id_count: totalReferenceIdCount,
      subscriptions: subscriptionsWithFlags
    };
    
    fs.writeFileSync(
      path.join(historyDir, "subscriptions.json"),
      JSON.stringify(outputData, null, 2)
    );
    fs.writeFileSync(
      path.join(historyDir, "control-messages.json"),
      JSON.stringify(ws.controlMessages, null, 2)
    );
    console.log("Messages saved to streaming/stream_history/");
  } catch (error) {
    console.error("Failed to save message files:", error);
  }
}

async function main(): Promise<void> {
  let wsForCleanup: SaxoWebsocket | null = null;
  try {
    // Subset of properties we show when changed.
    const subsetForDelta = [
      "TotalValue",
      "CollateralAvailable",
      "MarginAvailableForTrading",
    ];
    // Properties to load from snapshot (not changing, but useful for context!)
    const subsetFromSnapshot = ["Currency"];

    const ws = createSaxoWebsocketClient();
    wsForCleanup = ws;

    // Generate unique context and reference IDs for this WebSocket session
    const contextId = "ctx-" + randomString();
    ws.contextCreatedAt = new Date();
    let referenceId = "balances-" + randomString();

    /**
     * Callback for OAuth flows to receive tokens
     * Called initially with access token, and later when tokens are refreshed
     * When refreshed token received, reauthorizes the WebSocket connection
     * @param tokenResponse - Token data including access_token and expires_in
     * @returns null (required by callback interface)
     */
    function getTokenAndReauthorize(
      tokenResponse: TokenResponse
    ): TokenResponse | null {
      console.log(
        `New access token received, expiring in ${tokenResponse.expires_in} seconds.`
      );
      console.log(`Access Token:\n\t${tokenResponse.access_token}`);

      // Update global access token
      globalAccessToken = tokenResponse.access_token;

      // Reauthorize WebSocket if connection is open
      if (ws && ws.connection && ws.connection.readyState === 1) {
        // WebSocket is open
        console.log("Reauthorizing WebSocket with new token...");
        ws.reauthorize(tokenResponse.access_token);
      }

      return null;
    }
    
    // Select authentication method based on environment configuration
    // Priority: GRANT_TYPE → ACCESS_TOKEN → Console prompt
    
    // Option 1: OAuth Authorization Code Flow (with automatic refresh)
    if (process.env["GRANT_TYPE"]?.toLowerCase() === "code") {
      console.log("Starting OAuth2 server...");
      oauth2Server(getTokenAndReauthorize, false);
      console.log("Waiting for access token from OAuth2 flow...");
      while (!globalAccessToken) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } 
    // Option 2: OAuth PKCE Flow (with automatic refresh)
    else if (process.env["GRANT_TYPE"]?.toLowerCase() === "pkce") {
      console.log("Starting OAuth2 PKCE server...");
      oauth2ServerPKCE(getTokenAndReauthorize, false);
      console.log("Waiting for access token from OAuth2 PKCE flow...");
      while (!globalAccessToken) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } 
    // Option 3: Direct token from .env (no refresh, manual management)
    else if (process.env["ACCESS_TOKEN"]) {
      console.log("Using ACCESS_TOKEN from .env file.");
      globalAccessToken = process.env["ACCESS_TOKEN"];
    } 
    // Option 4: Console prompt fallback
    else {
      console.log("No GRANT_TYPE or ACCESS_TOKEN found in .env file.");
      globalAccessToken = await promptForAccessToken();
    }

    console.log("Access token received, proceeding with streaming setup...");

    // Fetch client info to get ClientKey
    let saxoClient: any | null = null;
    saxoClient = await getClient(globalAccessToken);
    if (!saxoClient) return;
    console.log("Client fetched:", saxoClient.ClientId, saxoClient.ClientKey);

    /**
     * WebSocket message handler
     * Parses binary frames and routes messages based on referenceId:
     * - _disconnect: Server disconnection, save history and close
     * - _resetsubscriptions: Replace subscriptions (server request)
     * - _heartbeat: Track heartbeat timestamps, delete if permanently disabled
     * - Other: Balance update messages, stored with update count
     * @param messageFrame - Raw binary WebSocket message
     * @param utf8Decoder - TextDecoder for parsing strings from binary
     */
    function onMessageHandler(
      messageFrame: { data: ArrayBuffer },
      utf8Decoder: TextDecoder
    ): void {
      var parsedMessages: StreamingMessage[] = parseMessageFrame(
        messageFrame.data,
        utf8Decoder
      );
      parsedMessages.forEach((message) => {
        console.log(
          "Received message:",
          message.messageId,
          message.referenceId
        );

        // Keeping track of received messages:
        switch (message.referenceId) {
          case "_disconnect":
            // Server is closing the connection
            console.log(
              "WebSocket disconnected by server. You must create a new login session and re-create the websocket and subscriptions."
            );
            saveMessagesToFiles(ws);
            ws.close();
            break;
          case "_resetsubscriptions":
            // Server requesting subscription refresh (e.g., after reconnection)
            let targetReferenceIds = (
              message as ResetSubscriptionsControlMessage
            ).parsedPayload[0].TargetReferenceIds;
            
            // If no specific targets, reset all active subscriptions
            if (
              targetReferenceIds === undefined ||
              targetReferenceIds.length === 0
            ) {
              targetReferenceIds = Object.keys(ws.subscriptions).filter(
                (refId) => ws.subscriptions[refId].status === "active"
              );
            }

            // Reset all active subscriptions
            targetReferenceIds.forEach((targetReferenceId) => {
              if (ws.subscriptions[targetReferenceId]) {
                console.log(`Resetting subscription for ${targetReferenceId}`);
                const newRefId = "balances-" + randomString();
                replaceBalanceSubscription(
                  contextId,
                  newRefId,
                  targetReferenceId,
                  saxoClient?.["ClientKey"],
                  globalAccessToken!,
                  ws
                );
              }
            });
            
            // Store control message and limit history
            ws.controlMessages.push(message);
            // Keep only the last 50 control messages
            if (ws.controlMessages.length > 50) {
              ws.controlMessages.shift();
            }
            break;
          case "_heartbeat":
            // Server heartbeat to indicate subscription is alive
            (
              message as HeartbeatControlMessage
            ).parsedPayload[0].Heartbeats.forEach((hb) => {
              if (ws.subscriptions[hb.OriginatingReferenceId]) {
                ws.subscriptions[hb.OriginatingReferenceId].latestHeartbeat =
                  new Date();
                
                // Delete subscription if permanently disabled
                if (hb.Reason === "SubscriptionPermanentlyDisabled") {
                  console.log(
                    `Subscription permanently disabled for ${hb.OriginatingReferenceId}. Deleting the subscription`
                  );
                  deleteBalanceSubscription(
                    contextId,
                    hb.OriginatingReferenceId,
                    globalAccessToken!,
                    ws
                  );
                }
              }
            });
            break;
          default:
            // Balance update message for an active subscription
            const subscription = ws.subscriptions[message.referenceId];
            if (subscription) {
              // Store message and maintain 50-message limit
              subscription.messages.push(message);
              // Keep only the last 50 messages
              if (subscription.messages.length > 50) {
                subscription.messages.shift();
              }
              // Increment update count
              subscription.updateCount = (subscription.updateCount || 0) + 1;
              
              // Extract and display key balance fields
              const subsetValues = subsetForDelta.reduce((acc, key) => {
                if (message.parsedPayload[key] === undefined) return acc;
                acc[key] = message.parsedPayload[key];
                return acc;
              }, {} as { [key: string]: number | string });
              
              // Add snapshot context (e.g., currency)
              subsetFromSnapshot.forEach((key) => {
                const snapshotValueForKey = subscription.snapshot[key];
                if (snapshotValueForKey !== undefined) {
                  subsetValues[key] = snapshotValueForKey;
                }
              });
              console.log(subsetValues);
              console.log("--------------------------------------");
              break;
            }
            console.log("Unknown referenceId, ignore:", message.referenceId);
        }
      });
    }

    // Open WebSocket connection, include message handler.
    ws.open(WEBSOCKET_CONNECT, contextId, globalAccessToken, onMessageHandler);

    // Subscribe to balance updates for the client
    var subscription = await subscribeToBalances(
      contextId,
      referenceId,
      saxoClient.ClientKey,
      globalAccessToken,
      ws
    );
    if (!subscription) return;
    
    // Keep process running and wait for manual termination
    // Handles Ctrl+C gracefully by saving history before exit
    return new Promise<void>((resolve: () => void): void => {
      process.on("SIGINT", (): void => {
        console.log("Terminating...");
        saveMessagesToFiles(ws);
        ws.close();
        resolve();
        process.exit(0);
      });
    });
  } catch (error) {
    console.error("Error in main:", error);
    // Ensure history is saved even on error
    if (wsForCleanup) {
      saveMessagesToFiles(wsForCleanup);
      wsForCleanup.close();
    }
    throw error;
  }
}

main();
