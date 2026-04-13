// ---------------------------------------------------------------------------
// ControlUIClaw SDK — Public API
// ---------------------------------------------------------------------------

export { ControlUIClaw } from "./client.js";

// Crypto utilities (for advanced / custom auth flows)
export {
  getOrCreateDeviceIdentity,
  clearCachedIdentity,
  buildDeviceAuthPayload,
  signPayload,
  base64UrlEncode,
  base64UrlDecode,
} from "./crypto.js";

// Types
export type {
  InitOptions,
  ConnectResult,
  HealthEvent,
  ChatEvent,
  Unsubscribe,
  ConnectionState,
  Session,
  ChatMessage,
  ContentBlock,
  ChatChoice,
  ChatHistoryResult,
  ClientInfo,
  DeviceIdentity,
  HelloPayload,
  SendPromptOptions,
  TokenUsage,
  ThinkingLevel,
} from "./types.js";
