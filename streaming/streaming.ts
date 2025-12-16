import { TextDecoder } from "util";
import { StreamingMessage, SaxoWebsocket } from "./types";

export const createSaxoWebsocketClient = (): SaxoWebsocket => {
  const ws: SaxoWebsocket = {
    connection: null,
    controlMessages: [],
    contextId: "",
    subscriptions: {},
    url: "",
    onMessageHandler(messageFrame, utf8Decoder): void {
      var parsedMessages: StreamingMessage[] = parseMessageFrame(
        messageFrame.data,
        utf8Decoder
      );
      parsedMessages.forEach((message) => {
        console.log("Received message:", message);
      });
    },
    open(url, contextId, accessToken, onMessageHandler): boolean {
      try {
        const utf8Decoder = new TextDecoder();
        console.log("Connecting to websocket...", url);
        if (onMessageHandler) {
          this.onMessageHandler = onMessageHandler as (
            messageFrame: { data: ArrayBuffer },
            utf8Decoder: TextDecoder
          ) => void;
        }
        this.contextId = contextId;
        this.url = url;
        const wsPath = `${url}?contextId=${contextId}`;
        this.connection = new WebSocket(
          `${wsPath}&Authorization=Bearer ${accessToken}`
        );
        this.connection.binaryType = "arraybuffer";
        console.log("Creating websocket connection to:", wsPath);

        this.connection.onmessage = (messageFrame: { data: ArrayBuffer }) => {
          this.onMessageHandler(messageFrame, utf8Decoder);
        };
        this.connection.onopen = (_evt: any) => {
          console.log("Connected to websocket...");
        };
        this.connection.onclose = (evt: {
          wasClean: boolean;
          code: number;
        }) => {
          if (evt.wasClean === true) {
            // Most likely 1000 (Normal Closure), or 1001 (Going Away)
            console.log("Streaming disconnected with code " + evt.code + ".");
          } else {
            console.error("Streaming disconnected with code " + evt.code + ".");
          }
        };
        this.connection.onerror = (evt: any) => {
          console.error("WebSocket error:", evt);
        };
        return true;
      } catch (error) {
        console.error("Error connecting to streaming:", error);
        return false;
      }
    },
    close(): boolean {
      if (this.connection !== null) {
        this.connection.close();
      }
      return true;
    },
    async reauthorize(url: string, accessToken: string): Promise<boolean> {
      if (this.connection !== null && this.url && this.contextId) {
        const reauthPath = `${url}?ContextId=${this.contextId}`;
        console.log("Reauthorizing websocket via:", reauthPath);
        const response = await fetch(reauthPath, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        if (response.ok) {
          console.log("WebSocket reauthorization successful.");
        } else {
          console.error(
            "WebSocket reauthorization failed with status:",
            response.status
          );
          return false;
        }
      }
      return true;
    },
  };
  return ws;
};

export function parseMessageFrame(
  data: ArrayBuffer,
  utf8Decoder: TextDecoder
): StreamingMessage[] {
  const message = new DataView(data);
  const parsedMessages: StreamingMessage[] = [];
  let index = 0;
  let messageId;
  let referenceIdSize;
  let referenceIdBuffer;
  let referenceId;
  let payloadFormat;
  let payloadSize;
  let payloadBuffer;
  let payload;
  function fromBytesLe(bytes: Uint8Array, unsigned: boolean = false) {
    const low =
      bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24) | 0;
    const high =
      bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24) | 0;
    const twoPwr16Dbl = 1 << 16;
    const twoPwr32Dbl = twoPwr16Dbl * twoPwr16Dbl;
    if (unsigned) {
      return (high >>> 0) * twoPwr32Dbl + (low >>> 0);
    }
    return high * twoPwr32Dbl + (low >>> 0);
  }

  while (index < data.byteLength) {
    messageId = fromBytesLe(new Uint8Array(data, index, 8));
    index += 8;
    index += 2;
    referenceIdSize = message.getInt8(index);
    index += 1;
    referenceIdBuffer = new Int8Array(data, index, referenceIdSize);
    referenceId = String.fromCharCode.apply(
      String,
      Array.from(referenceIdBuffer)
    );
    index += referenceIdSize;
    payloadFormat = message.getUint8(index);
    index += 1;
    payloadSize = message.getUint32(index, true);
    index += 4;
    payloadBuffer = new Uint8Array(data, index, payloadSize);
    payload = null;
    switch (payloadFormat) {
      case 0:
        try {
          payload = JSON.parse(utf8Decoder.decode(payloadBuffer));
        } catch (error) {
          console.error(error);
        }
        break;
      case 1:
        console.error(
          "Protocol Buffers are not supported in this example.",
          payloadFormat
        );
        break;
      default:
        console.error("Unsupported payloadFormat: " + payloadFormat);
    }
    index += payloadSize;

    if (payload !== null) {
      const message: StreamingMessage = {
        messageId,
        referenceId,
        parsedPayload: payload,
      };
      parsedMessages.push(message);
    }
  }
  return parsedMessages;
}
