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

// Enums
export { Channel } from "./types.js";

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
  SendImagePromptOptions,
  ImageAttachment,
  TokenUsage,
  ThinkingLevel,
  ChannelsStatusResult,
  ChannelsChannelData,
  ChannelAccountSnapshot,
  ChannelUiMeta,
  WhatsAppChannelStatus,
  TelegramChannelStatus,
  DiscordChannelStatus,
  SlackChannelStatus,
  SignalChannelStatus,
  IMessageChannelStatus,
  GoogleChatChannelStatus,
  NostrChannelStatus,
  ChannelLogoutResult,
  ChannelLogoutOptions,
  WhatsAppLoginOptions,
  WhatsAppLoginStatusEvent,
  WhatsAppLoginStep,
  ChannelStatusEvent,
} from "./types.js";
