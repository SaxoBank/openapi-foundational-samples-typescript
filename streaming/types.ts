import { TextDecoder } from "util";

export type ReferenceId = ControlMessageReferenceId | string;

export interface RawStreamingMessage {
  messageId: number;
  referenceIdSize: number;
  referenceId: ReferenceId | ControlMessageReferenceId;
  payloadFormat: number;
  payloadSize: number;
  payload: ArrayBuffer;
}

export interface StreamingMessage {
  messageId: number;
  referenceId: ReferenceId;
  parsedPayload: any;
}

/**
 * Control Message Type Definitions
 */
export const ControlMessageReferenceIds = [
  "_resetsubscriptions",
  "_disconnect",
  "_heartbeat",
] as const;

export type ControlMessageReferenceId =
  (typeof ControlMessageReferenceIds)[number];

type HeartbeatReason =
  | "NoNewData"
  | "SubscriptionTemporarilyDisabled"
  | "SubscriptionPermanentlyDisabled";

export interface HeartbeatControlMessage extends StreamingMessage {
  referenceId: "_heartbeat";
  parsedPayload: [
    {
      ReferenceId: "_heartbeat";
      Heartbeats: Array<{
        OriginatingReferenceId: ReferenceId;
        Reason: HeartbeatReason;
      }>;
    }
  ];
}

export interface DisconnectControlMessage extends StreamingMessage {
  referenceId: "_disconnect";
  parsedPayload: [
    {
      ReferenceId: "_disconnect";
    }
  ];
}

export interface ResetSubscriptionsControlMessage extends StreamingMessage {
  referenceId: "_resetsubscriptions";
  parsedPayload: [
    {
      ReferenceId: "_resetsubscriptions";
      TargetReferenceIds?: ReferenceId[];
    }
  ];
}

/**
 * Saved File Format Types
 */
export interface SavedSubscriptionData {
  created_at: Date | null;
  initial_snapshot: {
    timestamp: Date | null;
    data: any;
  };
  messages: StreamingMessage[];
  activity_flags: {
    has_snapshot: boolean;
    update_count: number;
    last_heartbeat: Date | null;
  };
  status: "active" | "deleted" | "replaced";
}

export interface SavedSessionData {
  context_id: string;
  created_at: Date;
  reference_id_count: number;
  subscriptions: {
    [referenceId: string]: SavedSubscriptionData;
  };
}

export type SaxoWebsocket = {
  connection: WebSocket | null;
  contextId: string;
  contextCreatedAt?: Date;
  controlMessages: any[]
  subscriptions: {
    [string: string]: {
      snapshot: any;
      messages: any[];
      latestHeartbeat?: Date;
      status?: "active" | "deleted" | "replaced";
      updateCount?: number;
      createdAt?: Date;
      snapshotReceivedAt?: Date;
    };
  };
  url: string;
  onMessageHandler(
    messageFrame: { data: ArrayBuffer },
    utf8Decoder: TextDecoder
  ): void;
  open(
    url: string,
    contextId: string,
    accessToken: string,
    onMessageHandler?: Function
  ): boolean;
  close(): boolean;
  reauthorize(
    accessToken: string,
  ): Promise<boolean>;
};
