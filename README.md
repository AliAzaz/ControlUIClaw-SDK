# ControlUIClaw SDK — WebSocket Integration Guide

A developer guide for connecting to the ControlUIClaw gateway via the `@controluiclaw/sdk` WebSocket client. Covers initialization, connection lifecycle, event mapping, health monitoring, and graceful teardown.

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

// 1. Initialize
const claw = ControlUIClaw.init({
  url: "wss://your-gateway-host:18789",
  token: "your-auth-token",
});

// 2. Subscribe to health events before connecting
const unsubHealth = claw.sessionHealth((event) => {
  console.log(`[${event.code}] ${event.message}`);
});

// 3. Connect
const result = await claw.connect();
if (!result.ok) {
  console.error("Connection failed:", result.error);
}

// 4. When done, disconnect and clean up
unsubHealth();
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

Streaming tokens, completed messages, errors, and aborted runs.

```ts
const unsub = claw.chatEvents((event: ChatEvent) => {
  switch (event.type) {
    case "stream":
      // Streaming token chunk arrived
      console.log("Streaming:", event.text);
      break;
    case "final":
      // Run complete — full response available
      console.log("Final:", event.text);
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

| Field        | Type                                         | Description                                     |
| ------------ | -------------------------------------------- | ----------------------------------------------- |
| `type`       | `"stream" \| "final" \| "error" \| "aborted"` | Event type                                      |
| `runId`      | `string`                                     | Unique run identifier                            |
| `sessionKey` | `string`                                     | Session this event belongs to                    |
| `text`       | `string`                                     | Extracted text (accumulated delta or full final)  |
| `raw`        | `Record<string, unknown>`                    | Raw gateway payload for advanced use             |

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
  "params": { "sessionKey": "...", "message": "..." }
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
  "payload": { "state": "delta", "runId": "...", "message": { ... } },
  "seq": 42,
  "stateVersion": { "presence": 5, "health": 3 }
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

await claw.sendPrompt(sessionKey, "What is the weather in Berlin?");
```

Responses arrive asynchronously through `chatEvents()`. The SDK generates a unique idempotency key per send to prevent duplicate processing.

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

A complete example showing initialization, health monitoring, chat streaming, and cleanup:

```ts
import { ControlUIClaw } from "@controluiclaw/sdk";

async function main() {
  const claw = ControlUIClaw.init({
    url: "wss://gateway-host:18789",
    token: "your-token",
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

  // Chat event streaming
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

  // Send a message
  const sessionKey = ControlUIClaw.createSessionKey();
  await claw.sendPrompt(sessionKey, "Hello, what can you help me with?");

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

## Troubleshooting

**"Already connected or connecting"** — You called `connect()` while the client is already connected or mid-handshake. Call `disconnect()` first if you need to reconnect.

**"Not connected"** — You called `request()`, `sendPrompt()`, or `listSessions()` before the connection was established. Wait for `connect()` to resolve with `ok: true`, or check `claw.isConnected` before making requests.

**"Request timed out"** — The gateway did not respond within 30 seconds. This may indicate the gateway is overloaded or the network connection is unstable.

**"Ed25519 not available"** — Neither native Web Crypto Ed25519 nor `@noble/ed25519` could be loaded. Install the optional dependency: `npm install @noble/ed25519`.

**Handshake failures** — Check that your gateway URL is correct and reachable. Verify that `wss://` is used for TLS endpoints and `ws://` only for private LAN addresses. Ensure your auth token is valid if one is required.
