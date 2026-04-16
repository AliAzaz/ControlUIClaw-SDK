# ControlUIClaw SDK — WebSocket Integration Guide

A developer guide for connecting to the ControlUIClaw gateway via the `@controluiclaw/sdk` WebSocket client. Covers initialization, connection lifecycle, event mapping, health monitoring, extended thinking, token usage tracking, and graceful teardown.

## Prerequisites

- Node.js 18+ or a modern browser with WebSocket and Web Crypto support
- A running ControlUIClaw gateway (default port `18789`)
- An auth token (optional if device-only auth is sufficient)

Install the SDK:

```bash
npm install @controluiclaw/sdk
```

## Quick Start

```ts
import { ControlUIClaw } from "@controluiclaw/sdk";

// 1. Initialize (with thinking enabled)
const claw = ControlUIClaw.init({
  url: "wss://your-gateway-host:18789",
  token: "your-auth-token",
  thinking: "medium",
});

// 2. Subscribe to health events before connecting
const unsubHealth = claw.sessionHealth((event) => {
  console.log(`[${event.code}] ${event.message}`);
});

// 3. Subscribe to chat events (with thinking + usage)
const unsubChat = claw.chatEvents((event) => {
  console.log(event.text);
  if (event.thinking) console.log("Reasoning:", event.thinking);
  if (event.usage) console.log("Tokens:", event.usage);
});

// 4. Connect
const result = await claw.connect();
if (!result.ok) {
  console.error("Connection failed:", result.error);
}

// 5. When done, disconnect and clean up
unsubHealth();
unsubChat();
claw.disconnect();
```

---

## Initialization

Create a client instance with `ControlUIClaw.init()`. This does not open a WebSocket — it only configures the client. The connection is established later when you call `connect()`.

```ts
const claw = ControlUIClaw.init({
  url: "wss://gateway-host:18789",     // Required — gateway WebSocket URL
  token: "your-auth-token",            // Optional auth token
  role: "operator",                    // Defaults to "operator"
  scopes: [                            // Defaults to full operator scopes
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
  ],
  thinking: "medium",                  // Default thinking level for all messages
  autoReconnect: true,                 // Auto-reconnect on drop (default: true)
  initialBackoffMs: 800,               // First retry delay (default: 800ms)
  maxBackoffMs: 15_000,                // Max retry delay cap (default: 15s)
  protocol: { min: 3, max: 3 },        // Protocol version range
  caps: ["tool-events"],               // Additional capabilities to advertise
  clientInfo: {                        // Override client identification
    id: "my-app",
    version: "2.0.0",
    platform: "web",
    mode: "sdk",
  },
});
```

### `InitOptions` Reference

| Field             | Type              | Default                          | Description                                       |
| ----------------- | ----------------- | -------------------------------- | ------------------------------------------------- |
| `url`             | `string`          | —                                | WebSocket URL of the gateway (required)            |
| `token`           | `string`          | `undefined`                      | Auth token sent during handshake                   |
| `role`            | `string`          | `"operator"`                     | Role claimed during handshake                      |
| `scopes`          | `string[]`        | Full operator scopes             | Scopes requested during handshake                  |
| `thinking`        | `ThinkingLevel`   | `"off"`                          | Default thinking level for all chat.send requests  |
| `autoReconnect`   | `boolean`         | `true`                           | Automatically reconnect on disconnection           |
| `initialBackoffMs`| `number`          | `800`                            | Initial reconnect backoff in milliseconds          |
| `maxBackoffMs`    | `number`          | `15000`                          | Maximum reconnect backoff in milliseconds          |
| `protocol`        | `{min, max}`      | `{min: 3, max: 3}`              | Protocol version range for negotiation             |
| `caps`            | `string[]`        | `["tool-events"]`                | Capabilities to advertise to the gateway           |
| `clientInfo`      | `Partial<ClientInfo>` | Auto-detected                | Client identification metadata                     |
| `deviceIdentity`  | `DeviceIdentity`  | Auto-generated                   | Custom Ed25519 device identity for auth            |

---

## Connect

Call `connect()` to open the WebSocket and complete the gateway handshake. The method returns a `ConnectResult` and never throws.

```ts
const result = await claw.connect();

if (result.ok) {
  console.log("Protocol:", result.protocol);       // e.g. 3
  console.log("Server:", result.serverVersion);     // e.g. "2026.4.1"
} else {
  console.error(result.error?.code, result.error?.message);
}
```

### What Happens During Connect

The handshake follows a challenge-response flow:

1. The client opens a WebSocket connection to the gateway URL.
2. The gateway sends a `connect.challenge` event containing a `nonce` and timestamp.
3. The SDK signs the nonce with the device's Ed25519 private key and sends a `connect` request frame containing client metadata, auth token, device signature, scopes, and capabilities.
4. The gateway validates the signature and responds with a `hello-ok` payload containing the negotiated protocol version, server info, features, snapshot, and policy limits.
5. The SDK automatically subscribes to session events (`sessions.subscribe`).

You do not need to handle any of these steps manually — `connect()` manages the entire flow.

### `ConnectResult`

| Field           | Type     | Description                                         |
| --------------- | -------- | --------------------------------------------------- |
| `ok`            | `boolean`| Whether the connection succeeded                     |
| `protocol`      | `number` | Negotiated protocol version (present when `ok`)      |
| `serverVersion` | `string` | Gateway server version (present when `ok`)           |
| `error`         | `object` | `{ code, message }` when `ok` is false               |

### Connection State

Check the current state at any time:

```ts
claw.state;        // "disconnected" | "connecting" | "connected"
claw.isConnected;  // boolean shorthand
```

---

## Disconnect

Call `disconnect()` to close the WebSocket, cancel any pending requests, and stop auto-reconnect.

```ts
claw.disconnect();
```

After disconnecting, the client emits a `disconnected` health event and transitions to the `"disconnected"` state. You can call `connect()` again to re-establish the connection.

### Cleanup Pattern

Always unsubscribe your listeners when tearing down to prevent memory leaks:

```ts
// Store unsubscribe handles
const unsubHealth = claw.sessionHealth(onHealth);
const unsubChat = claw.chatEvents(onChat);

// On teardown
function cleanup() {
  unsubHealth();
  unsubChat();
  claw.disconnect();
}
```

---

## Event Mapping

The SDK maps raw gateway wire-protocol frames into two typed event streams: **health events** and **chat events**. Subscribe to each with a callback that receives structured event objects.

### Health Events — `sessionHealth()`

Connection lifecycle, gateway errors, and session-list changes. Subscribe **before** calling `connect()` so you capture the initial connection events.

```ts
const unsub = claw.sessionHealth((event: HealthEvent) => {
  switch (event.code) {
    case "connecting":
      // WebSocket opening, handshake in progress
      break;
    case "connected":
      // Handshake complete, gateway ready
      break;
    case "disconnected":
      // WebSocket closed
      break;
    case "reconnecting":
      // Auto-reconnect scheduled (includes backoff delay in message)
      break;
    case "error":
      // WebSocket error or gateway-level error event
      break;
    case "sessions_changed":
      // The sessions list was updated server-side
      break;
    case "event":
      // Any other unhandled gateway event (forwarded as-is)
      break;
  }
});
```

#### `HealthEvent`

| Field     | Type     | Description                                    |
| --------- | -------- | ---------------------------------------------- |
| `code`    | `string` | Event code (see table below)                   |
| `message` | `string` | Human-readable description                     |

#### Health Event Codes

| Code                | Trigger                                                    |
| ------------------- | ---------------------------------------------------------- |
| `connecting`        | WebSocket is opening                                        |
| `connected`         | Handshake complete; includes protocol version and server version |
| `disconnected`      | WebSocket closed; includes close code and reason            |
| `reconnecting`      | Auto-reconnect scheduled; includes backoff delay            |
| `error`             | WebSocket error, handshake failure, or gateway error event  |
| `sessions_changed`  | Gateway notified that the sessions list was updated         |
| `event`             | Catch-all for unhandled gateway events                      |

### Chat Events — `chatEvents()`

Streaming tokens, completed messages, errors, and aborted runs. Chat events now include **thinking content** and **token usage** when available.

```ts
const unsub = claw.chatEvents((event: ChatEvent) => {
  switch (event.type) {
    case "stream":
      // Streaming token chunk arrived
      console.log("Streaming:", event.text);
      if (event.thinking) console.log("Thinking:", event.thinking);
      break;
    case "final":
      // Run complete — full response available
      console.log("Final:", event.text);
      if (event.thinking) console.log("Reasoning:", event.thinking);
      if (event.usage) console.log("Usage:", event.usage);
      break;
    case "error":
      // Run failed
      console.error("Error:", event.text);
      break;
    case "aborted":
      // Run was cancelled
      console.log("Aborted");
      break;
  }
});
```

#### `ChatEvent`

| Field        | Type                                           | Description                                      |
| ------------ | ---------------------------------------------- | ------------------------------------------------ |
| `type`       | `"stream" \| "final" \| "error" \| "aborted"` | Event type                                       |
| `runId`      | `string`                                       | Unique run identifier                            |
| `sessionKey` | `string`                                       | Session this event belongs to                    |
| `text`       | `string`                                       | Extracted text (accumulated delta or full final)  |
| `thinking`   | `string \| undefined`                          | Thinking/reasoning text (when extended thinking is enabled) |
| `usage`      | `TokenUsage \| undefined`                      | Token usage counters (typically populated on `final`) |
| `raw`        | `Record<string, unknown>`                      | Raw gateway payload for advanced use             |

---

## Extended Thinking

Extended thinking enables the model to show its internal reasoning process. Set a thinking level globally or per-message.

### Thinking Levels

| Level       | Description                                    |
| ----------- | ---------------------------------------------- |
| `"off"`     | No thinking (default)                          |
| `"minimal"` | Very brief internal reasoning                  |
| `"low"`     | Light reasoning                                |
| `"medium"`  | Moderate reasoning                             |
| `"high"`    | Deep reasoning                                 |
| `"xhigh"`   | Maximum reasoning depth                        |
| `"adaptive"`| Provider picks automatically                   |

### Global Default

Set a default thinking level at initialization:

```ts
const claw = ControlUIClaw.init({
  url: "wss://gateway:18789",
  token: "xxx",
  thinking: "medium",
});
```

### Per-Message Override

Override the default for a specific message:

```ts
// Use high thinking for a complex question
await claw.sendPrompt(sessionKey, "Solve this step by step", { thinking: "high" });

// Disable thinking for a simple question
await claw.sendPrompt(sessionKey, "What time is it?", { thinking: "off" });
```

### Accessing Thinking Content

Thinking text arrives in chat events via the `thinking` field:

```ts
claw.chatEvents((event) => {
  // During streaming, thinking may arrive incrementally
  if (event.type === "stream" && event.thinking) {
    updateThinkingUI(event.thinking);
  }

  // On final, the complete thinking is available
  if (event.type === "final" && event.thinking) {
    console.log("Full reasoning:", event.thinking);
  }
});
```

---

## Token Usage

Every chat event can carry token usage counters. Usage is typically populated on `final` events with the complete totals, though `stream` events may carry partial usage from some providers.

### `TokenUsage`

| Field         | Type                      | Description                              |
| ------------- | ------------------------- | ---------------------------------------- |
| `input`       | `number \| undefined`     | Input / prompt tokens                    |
| `output`      | `number \| undefined`     | Output / completion tokens               |
| `totalTokens` | `number \| undefined`     | Total tokens (input + output)            |
| `cacheRead`   | `number \| undefined`     | Tokens served from prompt cache          |
| `cacheWrite`  | `number \| undefined`     | Tokens written to prompt cache           |
| `cost`        | `Record<string, unknown>` | Provider-reported cost (when available)   |

### Accessing Usage

```ts
claw.chatEvents((event) => {
  if (event.type === "final" && event.usage) {
    console.log(`Input: ${event.usage.input} tokens`);
    console.log(`Output: ${event.usage.output} tokens`);
    console.log(`Total: ${event.usage.totalTokens} tokens`);

    if (event.usage.cacheRead) {
      console.log(`Cache read: ${event.usage.cacheRead} tokens`);
    }
  }
});
```

The SDK normalizes usage from different providers, accepting both camelCase (`inputTokens`, `outputTokens`) and snake_case (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) field names.

---

## Session Title Derivation

The SDK derives human-readable titles for sessions when the gateway doesn't provide one. This uses the same cascading priority as the gateway:

1. **`displayName`** — explicit user-set name
2. **`label`** — if it looks like a real label (not raw metadata/JSON)
3. **First user message** — truncated to 60 characters at word boundaries
4. **Session key prefix + date** — fallback using the first 8 characters of the key

### Automatic Derivation

`listSessions()` automatically derives titles for sessions that are missing a `derivedTitle`:

```ts
const sessions = await claw.listSessions();

for (const session of sessions) {
  // derivedTitle is always populated — either from the gateway or derived client-side
  console.log(session.derivedTitle);
}
```

### Manual Derivation

Use the static method to derive a title yourself:

```ts
const title = ControlUIClaw.deriveSessionTitle(session, "Hello, how are you?");
// → "Hello, how are you?"

const title2 = ControlUIClaw.deriveSessionTitle(session);
// → Falls back to session key prefix like "a1b2c3d4 (2026-04-13)"
```

---

## Health Events — Deep Dive

Health events serve as the single observability surface for connection state. Use them to drive UI indicators, trigger reconnection logic, or feed monitoring dashboards.

### Recommended Patterns

**Connection status indicator:**

```ts
let isOnline = false;

claw.sessionHealth((event) => {
  if (event.code === "connected") {
    isOnline = true;
    updateStatusDot("green");
  }
  if (event.code === "disconnected" || event.code === "error") {
    isOnline = false;
    updateStatusDot("red");
  }
  if (event.code === "reconnecting") {
    updateStatusDot("yellow");
  }
});
```

**Error logging:**

```ts
claw.sessionHealth((event) => {
  if (event.code === "error") {
    // event.message contains the human-readable error:
    // - "Handshake failed: ..."
    // - "WebSocket error"
    // - Gateway-level errors (billing, auth, rate limits)
    reportError(event.message);
  }
});
```

**Session list refresh:**

```ts
claw.sessionHealth(async (event) => {
  if (event.code === "sessions_changed") {
    const sessions = await claw.listSessions();
    renderSessionList(sessions);
  }
});
```

### Auto-Reconnect Behavior

When `autoReconnect` is enabled (the default), the SDK automatically attempts to reconnect after an unexpected disconnection. The reconnect cycle works as follows:

1. On disconnect, the SDK emits `disconnected`, then `reconnecting`.
2. After the backoff delay, it opens a new WebSocket and re-runs the handshake.
3. On success, it emits `connected` and resets the backoff timer.
4. On failure, it backs off exponentially (factor of 1.7x) up to `maxBackoffMs`, then retries.

Calling `disconnect()` stops the reconnect cycle entirely.

---

## Wire Protocol Reference

The SDK abstracts the wire protocol, but understanding it helps when debugging or building advanced integrations.

### Frame Types

All messages over the WebSocket are JSON-encoded frames with a `type` discriminator:

**Request frame** (client to gateway):

```json
{
  "type": "req",
  "id": "unique-request-id",
  "method": "chat.send",
  "params": { "sessionKey": "...", "message": "...", "thinking": "medium" }
}
```

**Response frame** (gateway to client):

```json
{
  "type": "res",
  "id": "unique-request-id",
  "ok": true,
  "payload": { ... }
}
```

**Event frame** (gateway to client, server-initiated):

```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "state": "final",
    "runId": "...",
    "message": { "content": [{ "type": "text", "text": "..." }, { "type": "thinking", "thinking": "..." }] },
    "usage": { "input": 150, "output": 320, "totalTokens": 470 }
  }
}
```

### Gateway Events

| Event                | Description                                   | SDK Mapping          |
| -------------------- | --------------------------------------------- | -------------------- |
| `connect.challenge`  | Handshake nonce from gateway                   | Handled internally   |
| `tick`               | Periodic keepalive with server timestamp       | Silently ignored     |
| `chat`               | Chat state change (delta, final, error, abort) | `chatEvents()`       |
| `sessions.changed`   | Sessions list updated                          | `sessionHealth()`    |
| `error`              | Gateway-level error                            | `sessionHealth()`    |
| `session.error`      | Session-scoped error                           | `sessionHealth()`    |
| `session.tool`       | Tool invocation event                          | Silently ignored     |
| *(other)*            | Any unrecognized event                         | `sessionHealth()` as `code: "event"` |

---

## Sessions and Chat

### List Sessions

```ts
const sessions = await claw.listSessions({ limit: 20 });

for (const session of sessions) {
  console.log(session.derivedTitle || session.label || session.key);
  console.log("  Status:", session.status);
  console.log("  Updated:", new Date(session.updatedAt));
}
```

### Send a Prompt

```ts
const sessionKey = ControlUIClaw.createSessionKey();

// Basic send
await claw.sendPrompt(sessionKey, "What is the weather in Berlin?");

// With thinking enabled
await claw.sendPrompt(sessionKey, "Explain quantum entanglement step by step", {
  thinking: "high",
});
```

Responses arrive asynchronously through `chatEvents()`. The SDK generates a unique idempotency key per send to prevent duplicate processing.

### `SendPromptOptions`

| Field      | Type            | Default                  | Description                                  |
| ---------- | --------------- | ------------------------ | -------------------------------------------- |
| `thinking` | `ThinkingLevel` | Inherited from init      | Thinking level override for this message     |

### Load Chat History

```ts
const history = await claw.chatHistory(sessionKey, { limit: 50 });

for (const msg of history.messages ?? history.items ?? []) {
  console.log(`${msg.role}: ${ControlUIClaw.extractText(msg)}`);
}
```

### Generic Requests

For gateway methods not covered by the convenience methods above, use `request()` directly:

```ts
const result = await claw.request<{ status: string }>(
  "agents.status",
  { agentId: "main" },
);
```

---

## Channel Management

The SDK provides typed methods for connecting, disconnecting, and monitoring messaging channels (WhatsApp, Telegram, Discord, Slack, etc.).

### Channel Enum

Use the `Channel` enum for type-safe channel references:

```ts
import { Channel } from "@controluiclaw/sdk";

Channel.WhatsApp   // "whatsapp"
Channel.Telegram   // "telegram"
Channel.Discord    // "discord"
Channel.Slack      // "slack"
Channel.Signal     // "signal"
Channel.IMessage   // "imessage"
Channel.GoogleChat // "googlechat"
Channel.Nostr      // "nostr"
```

### Get Channel Status

Retrieve the status of all configured channels and their accounts:

```ts
// Basic status (no probes)
const status = await claw.getChannelsStatus();
console.log(status.channelOrder);                // ["whatsapp", "telegram", ...]
console.log(status.channels.whatsapp?.connected); // true / false

// With health probes (slower, more accurate)
const probed = await claw.getChannelsStatus(true, 10000);
```

### Connect WhatsApp (QR Code)

WhatsApp uses QR code pairing. `startWhatsAppChannelLogin()` handles the full flow and reports progress via a callback:

```ts
await claw.startWhatsAppChannelLogin({
  onStatus: (event) => {
    switch (event.step) {
      case "qr_ready":
        renderQrCode(event.qrDataUrl);          // show QR in your UI
        break;
      case "scanning":
        showSpinner("Waiting for scan...");
        break;
      case "authenticating":
        showSpinner("Authenticating...");
        break;
      case "connected":
        showSuccess("WhatsApp connected!");
        break;
      case "failed":
        showError(event.error);
        break;
    }
  },
  timeoutMs: 120000,
  force: false,        // set true to force re-login
});
```

### Connect Telegram (Bot Token)

```ts
await claw.setTelegramChannelToken("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");

// With a specific account
await claw.setTelegramChannelToken("token", "bot2");
```

### Connect Discord (Bot Token)

```ts
await claw.setDiscordChannelToken("MTIzNDU2Nzg5MDEy...");
```

### Connect Slack (Bot + App Tokens)

```ts
await claw.setSlackChannelTokens("xoxb-...", "xapp-...");
```

### Disconnect Any Channel

```ts
await claw.logoutChannel(Channel.WhatsApp);
await claw.logoutChannel(Channel.Telegram, { accountId: "bot2" });
```

### Real-Time Channel Status

Subscribe to live channel status changes. The callback fires whenever the gateway health snapshot updates:

```ts
const unsub = claw.onChannelStatus((event) => {
  const wa = event.channels.whatsapp;
  console.log("WhatsApp connected:", wa?.connected);
  console.log("Telegram running:", event.channels.telegram?.running);
});

// Later:
unsub();
```

---

## Device Authentication

The SDK uses Ed25519 key pairs for device authentication. By default, a key pair is auto-generated on first connect and cached in `sessionStorage` (browser) or in memory (Node.js).

### How It Works

1. On first connection, the SDK generates an Ed25519 key pair.
2. The public key's SHA-256 fingerprint becomes the device ID.
3. During handshake, the SDK signs a payload containing the device ID, client info, role, scopes, timestamp, auth token, and challenge nonce.
4. The gateway verifies the signature against the public key.

### Custom Device Identity

Provide your own key pair for persistent device identity across sessions:

```ts
import { getOrCreateDeviceIdentity, clearCachedIdentity } from "@controluiclaw/sdk";

// Generate and retrieve a device identity
const identity = await getOrCreateDeviceIdentity();
console.log("Device ID:", identity.deviceId);

// Use a custom identity
const claw = ControlUIClaw.init({
  url: "wss://gateway:18789",
  deviceIdentity: {
    deviceId: "my-device-fingerprint",
    publicKey: "base64url-encoded-public-key",
    privateKey: "base64url-encoded-private-key",
  },
});

// Clear cached identity (for key rotation or testing)
clearCachedIdentity();
```

### Crypto Backend

The SDK uses the Web Crypto API's native Ed25519 support when available. On older browsers that lack native Ed25519, it falls back to the `@noble/ed25519` library (listed as an optional dependency).

---

## Full Integration Example

A complete example showing initialization with thinking, health monitoring, chat streaming with usage tracking, and cleanup:

```ts
import { ControlUIClaw } from "@controluiclaw/sdk";

async function main() {
  const claw = ControlUIClaw.init({
    url: "wss://gateway-host:18789",
    token: "your-token",
    thinking: "medium",
  });

  // Health monitoring
  const unsubHealth = claw.sessionHealth((event) => {
    console.log(`[health] ${event.code}: ${event.message}`);

    if (event.code === "connected") {
      console.log("Ready to send messages");
    }

    if (event.code === "error") {
      console.error("Gateway error:", event.message);
    }
  });

  // Chat event streaming with thinking + usage
  const streamBuffers = new Map<string, string>();

  const unsubChat = claw.chatEvents((event) => {
    switch (event.type) {
      case "stream": {
        const buffer = (streamBuffers.get(event.runId) ?? "") + event.text;
        streamBuffers.set(event.runId, buffer);
        process.stdout.write(event.text);
        break;
      }
      case "final":
        streamBuffers.delete(event.runId);
        console.log("\n[complete]");

        // Show thinking if present
        if (event.thinking) {
          console.log("\n--- Reasoning ---");
          console.log(event.thinking);
        }

        // Show token usage
        if (event.usage) {
          console.log("\n--- Usage ---");
          console.log(`  Input:  ${event.usage.input} tokens`);
          console.log(`  Output: ${event.usage.output} tokens`);
          console.log(`  Total:  ${event.usage.totalTokens} tokens`);
          if (event.usage.cacheRead) console.log(`  Cache:  ${event.usage.cacheRead} read`);
        }
        break;
      case "error":
        streamBuffers.delete(event.runId);
        console.error("\n[error]", event.text);
        break;
      case "aborted":
        streamBuffers.delete(event.runId);
        console.log("\n[aborted]");
        break;
    }
  });

  // Connect
  const result = await claw.connect();
  if (!result.ok) {
    console.error("Failed to connect:", result.error);
    return;
  }

  // List sessions with derived titles
  const sessions = await claw.listSessions();
  for (const s of sessions) {
    console.log(`${s.derivedTitle} [${s.status}]`);
  }

  // Send a message with high thinking
  const sessionKey = ControlUIClaw.createSessionKey();
  await claw.sendPrompt(sessionKey, "Explain the P vs NP problem", {
    thinking: "high",
  });

  // Disconnect after 30 seconds
  setTimeout(() => {
    unsubHealth();
    unsubChat();
    claw.disconnect();
    console.log("Disconnected");
  }, 30_000);
}

main();
```

---

## API Reference Summary

### `ControlUIClaw` Instance Methods

| Method | Returns | Description |
| --- | --- | --- |
| `connect()` | `Promise<ConnectResult>` | Open WebSocket and complete handshake |
| `disconnect()` | `void` | Close connection and stop reconnects |
| `listSessions(options?)` | `Promise<Session[]>` | Fetch sessions with derived titles |
| `sendPrompt(key, msg, opts?)` | `Promise<void>` | Send a message with optional thinking level |
| `sendImagePrompt(key, msg, opts)` | `Promise<void>` | Send a message with image attachments |
| `chatHistory(key, options?)` | `Promise<ChatHistoryResult>` | Load chat history for a session |
| `sessionHealth(cb)` | `Unsubscribe` | Subscribe to health/connection events |
| `chatEvents(cb)` | `Unsubscribe` | Subscribe to chat events with thinking + usage |
| `getChannelsStatus(probe?, timeoutMs?)` | `Promise<ChannelsStatusResult>` | Get all channel statuses |
| `startWhatsAppChannelLogin(opts)` | `Promise<void>` | Full WhatsApp QR login flow with callback |
| `setTelegramChannelToken(token, acct?)` | `Promise<void>` | Set Telegram bot token |
| `setDiscordChannelToken(token, acct?)` | `Promise<void>` | Set Discord bot token |
| `setSlackChannelTokens(bot, app, acct?)` | `Promise<void>` | Set Slack bot + app tokens |
| `logoutChannel(channel, opts?)` | `Promise<ChannelLogoutResult>` | Disconnect any channel |
| `onChannelStatus(cb)` | `Unsubscribe` | Subscribe to real-time channel status |
| `request<T>(method, params?)` | `Promise<T>` | Generic gateway request |

### `ControlUIClaw` Static Methods

| Method | Returns | Description |
| --- | --- | --- |
| `init(options)` | `ControlUIClaw` | Create a new client instance |
| `createSessionKey(prefix?)` | `string` | Generate a unique session key |
| `extractText(msg)` | `string` | Extract readable text from any message shape |
| `deriveSessionTitle(session, firstMsg?)` | `string` | Derive a human-readable session title |

### Exported Types & Enums

| Export | Kind | Description |
| --- | --- | --- |
| `Channel` | enum | Channel identifiers (`WhatsApp`, `Telegram`, `Discord`, etc.) |
| `InitOptions` | type | Configuration for `init()` |
| `ConnectResult` | type | Result of `connect()` |
| `HealthEvent` | type | Health/connection event |
| `ChatEvent` | type | Chat event with text, thinking, and usage |
| `Session` | type | Session metadata |
| `SendPromptOptions` | type | Options for `sendPrompt()` |
| `SendImagePromptOptions` | type | Options for `sendImagePrompt()` |
| `ImageAttachment` | type | Image attachment data for `sendImagePrompt()` |
| `TokenUsage` | type | Token usage counters |
| `ThinkingLevel` | type | Thinking level union |
| `ChatMessage` | type | Chat message from history |
| `ContentBlock` | type | Message content block (text or thinking) |
| `ChatHistoryResult` | type | Chat history response |
| `ClientInfo` | type | Client identification |
| `DeviceIdentity` | type | Ed25519 device key pair |
| `ChannelsStatusResult` | type | Full result from `getChannelsStatus()` |
| `ChannelsChannelData` | type | Per-channel status map |
| `ChannelAccountSnapshot` | type | Generic per-account status |
| `WhatsAppChannelStatus` | type | WhatsApp-specific status fields |
| `TelegramChannelStatus` | type | Telegram-specific status fields |
| `DiscordChannelStatus` | type | Discord-specific status fields |
| `SlackChannelStatus` | type | Slack-specific status fields |
| `WhatsAppLoginOptions` | type | Options for `startWhatsAppChannelLogin()` |
| `WhatsAppLoginStatusEvent` | type | Progress events during WhatsApp login |
| `ChannelLogoutResult` | type | Result from `logoutChannel()` |
| `ChannelStatusEvent` | type | Real-time channel status event |

---

## Troubleshooting

**"Already connected or connecting"** — You called `connect()` while the client is already connected or mid-handshake. Call `disconnect()` first if you need to reconnect.

**"Not connected"** — You called `request()`, `sendPrompt()`, or `listSessions()` before the connection was established. Wait for `connect()` to resolve with `ok: true`, or check `claw.isConnected` before making requests.

**"Request timed out"** — The gateway did not respond within 30 seconds. This may indicate the gateway is overloaded or the network connection is unstable.

**"Ed25519 not available"** — Neither native Web Crypto Ed25519 nor `@noble/ed25519` could be loaded. Install the optional dependency: `npm install @noble/ed25519`.

**Thinking not appearing** — Ensure you set a thinking level either globally (`thinking: "medium"` in `InitOptions`) or per-message (`{ thinking: "high" }` in `sendPrompt`). The gateway must support extended thinking for the configured model.

**Usage showing undefined** — Token usage is provider-dependent. Not all providers report usage on every event. Check `event.usage` on `final` events for the most complete data.

**Session titles showing raw metadata** — The SDK automatically filters out raw JSON/metadata labels and derives titles from the first user message instead. If titles are still not appearing, ensure `listSessions()` has access to `chat.history` for fallback derivation.

**Handshake failures** — Check that your gateway URL is correct and reachable. Verify that `wss://` is used for TLS endpoints and `ws://` only for private LAN addresses. Ensure your auth token is valid if one is required.
