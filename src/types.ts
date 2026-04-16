// ---------------------------------------------------------------------------
// ControlUIClaw SDK — Type Definitions
// ---------------------------------------------------------------------------

/** Connection states used internally. */
export type ConnectionState = "disconnected" | "connecting" | "connected";

// ── Wire Protocol ──────────────────────────────────────────────────────────

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
}

export interface EventFrame {
  type: "event";
  event: string;
  payload?: Record<string, unknown>;
}

// ── Handshake / Auth ───────────────────────────────────────────────────────

export interface ClientInfo {
  id: string;
  version: string;
  platform: string;
  mode: string;
}

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

export interface DeviceAuthFields {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}

export interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: ClientInfo;
  role: string;
  scopes: string[];
  caps?: string[];
  auth?: { token?: string };
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  };
  locale?: string;
  userAgent?: string;
}

export interface HelloPayload {
  protocol: number;
  server?: { version?: string; [key: string]: unknown };
  [key: string]: unknown;
}

// ── Session Types ──────────────────────────────────────────────────────────

export interface Session {
  key: string;
  status?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt?: number;
  createdAt?: number;
  lastMessage?: unknown;
  [key: string]: unknown;
}

export interface SessionsListResult {
  sessions: Session[];
}

// ── Thinking ──────────────────────────────────────────────────────────────

/**
 * Thinking level for extended reasoning.
 *
 * - `"off"`      — no thinking
 * - `"minimal"`  — very brief internal reasoning
 * - `"low"`      — light reasoning
 * - `"medium"`   — moderate reasoning (default when enabled)
 * - `"high"`     — deep reasoning
 * - `"xhigh"`    — maximum reasoning depth
 * - `"adaptive"` — provider picks automatically
 */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive";

// ── Token Usage ───────────────────────────────────────────────────────────

/** Per-message token usage counters. */
export interface TokenUsage {
  /** Input / prompt tokens. */
  input?: number;
  /** Output / completion tokens. */
  output?: number;
  /** Total tokens (input + output when available). */
  totalTokens?: number;
  /** Tokens served from prompt cache. */
  cacheRead?: number;
  /** Tokens written to prompt cache. */
  cacheWrite?: number;
  /** Provider-reported cost (when available). */
  cost?: Record<string, unknown>;
}

// ── Attachments ───────────────────────────────────────────────────────────

/** Image/file attachment metadata extracted from chat history messages. */
export interface Attachment {
  /** MIME type (e.g. "image/jpeg", "image/png"). */
  mimeType: string;
  /** Size in bytes (when the gateway omits inline data). */
  bytes: number;
  /** Filesystem path on the gateway host (user messages only). */
  dataUrl: string;
}

// ── Chat Types ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role?: string;
  text?: string;
  content?: string | ContentBlock[];
  choices?: ChatChoice[];
  /** Normalized token usage (present on assistant messages). */
  usage?: TokenUsage;
  /** Model identifier (e.g. "sonnet-4.6") when reported by the gateway. */
  model?: string;
  /** Image/file attachments associated with this message. */
  attachments?: Attachment[];
  [key: string]: unknown;
}

export interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

export interface ChatChoice {
  delta?: { content?: string };
  message?: { content?: string };
}

export interface ChatHistoryResult {
  messages?: ChatMessage[];
  items?: ChatMessage[];
}

// ── Public API Types ───────────────────────────────────────────────────────

/** Options passed to `ControlUIClaw.init()`. */
export interface InitOptions {
  /** WebSocket URL of the gateway (e.g. wss://host:18789). */
  url: string;

  /** Auth token (optional if device auth alone is sufficient). */
  token?: string;

  /** Client identification sent during handshake. */
  clientInfo?: Partial<ClientInfo>;

  /** Role claimed during handshake. Defaults to "operator". */
  role?: string;

  /** Scopes requested during handshake. */
  scopes?: string[];

  /** Protocol version range. Defaults to { min: 3, max: 3 }. */
  protocol?: { min: number; max: number };

  /** Additional capabilities to advertise. */
  caps?: string[];

  /** Auto-reconnect on disconnect. Defaults to true. */
  autoReconnect?: boolean;

  /** Initial reconnect backoff in ms. Defaults to 800. */
  initialBackoffMs?: number;

  /** Maximum reconnect backoff in ms. Defaults to 15000. */
  maxBackoffMs?: number;

  /** Custom device identity. If omitted, one is auto-generated and cached. */
  deviceIdentity?: DeviceIdentity;

  /**
   * Default thinking level for all chat.send requests.
   * Can be overridden per-message via `sendPrompt()` options.
   * Defaults to `"off"`.
   */
  thinking?: ThinkingLevel;
}

/** Options for `sendPrompt()`. */
export interface SendPromptOptions {
  /**
   * Thinking level for this message.
   * Overrides the default set in `InitOptions.thinking`.
   */
  thinking?: ThinkingLevel;
}

/** A single image attachment for `sendImagePrompt()`. */
export interface ImageAttachment {
  /** MIME type (e.g. "image/png", "image/jpeg"). */
  mimeType: string;
  /** Optional file name for the attachment. */
  fileName?: string;
  /** Base64-encoded image data. */
  data: string;
}

/** Options for `sendImagePrompt()`. */
export interface SendImagePromptOptions extends SendPromptOptions {
  /**
   * One or more image attachments to include with the message.
   * Each attachment should contain base64-encoded image data.
   */
  images: ImageAttachment[];
}

/** Returned by `connect()` — either success or an error. */
export interface ConnectResult {
  ok: boolean;
  protocol?: number;
  serverVersion?: string;
  error?: { code: string; message: string };
}

/**
 * Streamed by `sessionHealth()`.
 *
 * Codes: "connected", "disconnected", "reconnecting", "error"
 * plus any gateway-level error events.
 */
export interface HealthEvent {
  code: string;
  message: string;
}

/**
 * Streamed by `chatEvents()`.
 *
 * - `stream`  — streaming token(s) arrived
 * - `final`   — run completed, full message available
 * - `error`   — run failed
 * - `aborted` — run was cancelled
 */
export interface ChatEvent {
  type: "stream" | "final" | "error" | "aborted";
  runId: string;
  sessionKey: string;
  /** Extracted text (accumulated for delta, full for final). */
  text: string;
  /** Thinking / reasoning text (when extended thinking is enabled). */
  thinking?: string;
  /** Token usage for this event (typically populated on `final`). */
  usage?: TokenUsage;
  /** Model identifier (e.g. "gpt-5.4", "sonnet-4.6") when reported by the gateway. */
  model?: string;
  /** Raw payload from the gateway for advanced use. */
  raw: Record<string, unknown>;
}

/** A function that unsubscribes the listener when called. */
export type Unsubscribe = () => void;

// ── Channel Types ─────────────────────────────────────────────────────────

/** Generic per-account status snapshot returned by `channels.status`. */
export interface ChannelAccountSnapshot {
  accountId: string;
  name?: string | null;
  enabled?: boolean | null;
  configured?: boolean | null;
  linked?: boolean | null;
  running?: boolean | null;
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastProbeAt?: number | null;
  mode?: string | null;
  dmPolicy?: string | null;
  allowFrom?: string[] | null;
  tokenSource?: string | null;
  botTokenSource?: string | null;
  appTokenSource?: string | null;
  credentialSource?: string | null;
  baseUrl?: string | null;
  cliPath?: string | null;
  dbPath?: string | null;
  port?: number | null;
  probe?: unknown;
  audit?: unknown;
  application?: unknown;
  [key: string]: unknown;
}

/** Per-channel status shapes matching the gateway health snapshot. */

export interface WhatsAppChannelStatus {
  configured: boolean;
  linked: boolean;
  running: boolean;
  connected: boolean;
  authAgeMs?: number | null;
  reconnectAttempts: number;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  self?: { id?: string; name?: string; [key: string]: unknown } | null;
  lastDisconnect?: { reason?: string; [key: string]: unknown } | null;
}

export interface TelegramChannelStatus {
  configured: boolean;
  running: boolean;
  tokenSource?: string | null;
  mode?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: { ok?: boolean; username?: string; [key: string]: unknown } | null;
  lastProbeAt?: number | null;
}

export interface DiscordChannelStatus {
  configured: boolean;
  running: boolean;
  tokenSource?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: { ok?: boolean; username?: string; [key: string]: unknown } | null;
  lastProbeAt?: number | null;
}

export interface SlackChannelStatus {
  configured: boolean;
  running: boolean;
  botTokenSource?: string | null;
  appTokenSource?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: { ok?: boolean; [key: string]: unknown } | null;
  lastProbeAt?: number | null;
}

export interface SignalChannelStatus {
  configured: boolean;
  running: boolean;
  baseUrl: string;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: { ok?: boolean; [key: string]: unknown } | null;
  lastProbeAt?: number | null;
}

export interface IMessageChannelStatus {
  configured: boolean;
  running: boolean;
  cliPath?: string | null;
  dbPath?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: { ok?: boolean; [key: string]: unknown } | null;
  lastProbeAt?: number | null;
}

export interface GoogleChatChannelStatus {
  configured: boolean;
  running: boolean;
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: { ok?: boolean; [key: string]: unknown } | null;
  lastProbeAt?: number | null;
}

export interface NostrChannelStatus {
  configured: boolean;
  running: boolean;
  publicKey?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  profile?: { name?: string; about?: string; [key: string]: unknown } | null;
}

/** Per-channel status map returned inside `ChannelsStatusResult`. */
export type ChannelsChannelData = {
  whatsapp?: WhatsAppChannelStatus;
  telegram?: TelegramChannelStatus;
  discord?: DiscordChannelStatus | null;
  googlechat?: GoogleChatChannelStatus | null;
  slack?: SlackChannelStatus | null;
  signal?: SignalChannelStatus | null;
  imessage?: IMessageChannelStatus | null;
  nostr?: NostrChannelStatus | null;
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null;
};

/** UI metadata for a channel entry. */
export interface ChannelUiMeta {
  id: string;
  label: string;
  detailLabel?: string;
  systemImage?: string;
}

/** Full result returned by `getChannelsStatus()`. */
export interface ChannelsStatusResult {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelSystemImages?: Record<string, string>;
  channelMeta?: ChannelUiMeta[];
  channels: ChannelsChannelData;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
  channelDefaultAccountId: Record<string, string>;
}

/** Known channel identifiers. */
export enum Channel {
  WhatsApp = "whatsapp",
  Telegram = "telegram",
  Discord = "discord",
  Slack = "slack",
  Signal = "signal",
  IMessage = "imessage",
  GoogleChat = "googlechat",
  Nostr = "nostr",
}

/** Options for `logoutChannel()`. */
export interface ChannelLogoutOptions {
  accountId?: string;
}

/** Result from `logoutChannel()`. */
export interface ChannelLogoutResult {
  channel: string;
  accountId: string;
  cleared: boolean;
  loggedOut?: boolean;
  envToken?: boolean;
  [key: string]: unknown;
}

// ── WhatsApp Login Types ──────────────────────────────────────────────────

/** Progress steps emitted during `startWhatsAppChannelLogin()`. */
export type WhatsAppLoginStep =
  | "qr_ready"
  | "scanning"
  | "authenticating"
  | "connected"
  | "failed";

/** Event payload delivered to the `onStatus` callback. */
export interface WhatsAppLoginStatusEvent {
  step: WhatsAppLoginStep;
  /** QR code data URL (present when `step` is `"qr_ready"`). */
  qrDataUrl?: string;
  /** Human-readable status message. */
  message?: string;
  /** Error detail (present when `step` is `"failed"`). */
  error?: string;
}

/** Options for `startWhatsAppChannelLogin()`. */
export interface WhatsAppLoginOptions {
  /** Force re-login even if already authenticated. */
  force?: boolean;
  /** Overall timeout in ms for the full login flow. */
  timeoutMs?: number;
  /** Target account id. */
  accountId?: string;
  /** Called with progress updates throughout the login flow. */
  onStatus: (event: WhatsAppLoginStatusEvent) => void;
}

// ── Channel Status Listener ───────────────────────────────────────────────

/** Channel status change event emitted by `onChannelStatus()`. */
export interface ChannelStatusEvent {
  /** Timestamp of the health snapshot. */
  ts: number;
  /** Per-channel status data. */
  channels: ChannelsChannelData;
  /** Per-channel per-account snapshots. */
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
}
