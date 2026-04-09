// ---------------------------------------------------------------------------
// ControlUIClaw SDK — Ed25519 Device Identity & Signing
// ---------------------------------------------------------------------------
//
// Provides Ed25519 key generation, signing, and device identity management.
// Uses Web Crypto API (native Ed25519) where available, with a fallback to
// the @noble/ed25519 library for older browsers.
// ---------------------------------------------------------------------------

import type { DeviceIdentity, DeviceAuthFields } from "./types.js";

// ── Base64url helpers ──────────────────────────────────────────────────────

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

export function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintPublicKey(publicKeyBytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", publicKeyBytes.buffer as ArrayBuffer);
  return bytesToHex(new Uint8Array(hash));
}

// ── Crypto Backend Abstraction ─────────────────────────────────────────────

interface CryptoBackend {
  generateKeypair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
  sign(privateKeyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
}

let _backend: CryptoBackend | null = null;

async function initCryptoBackend(): Promise<CryptoBackend> {
  if (_backend) return _backend;

  // Try native Web Crypto Ed25519 first
  try {
    await crypto.subtle.generateKey("Ed25519" as any, true, ["sign", "verify"]);
    _backend = {
      async generateKeypair() {
        const keyPair = await crypto.subtle.generateKey(
          "Ed25519" as any,
          true,
          ["sign", "verify"],
        );
        const rawPublic = new Uint8Array(
          await crypto.subtle.exportKey("raw", keyPair.publicKey),
        );
        const pkcs8 = new Uint8Array(
          await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
        );
        // PKCS8 for Ed25519 is 48 bytes; raw 32-byte key starts at offset 16
        return { publicKey: rawPublic, privateKey: pkcs8.slice(16) };
      },
      async sign(privateKeyBytes: Uint8Array, message: Uint8Array) {
        const header = new Uint8Array([
          0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
          0x70, 0x04, 0x22, 0x04, 0x20,
        ]);
        const pkcs8 = new Uint8Array(48);
        pkcs8.set(header);
        pkcs8.set(privateKeyBytes, 16);
        const key = await crypto.subtle.importKey(
          "pkcs8",
          pkcs8.buffer as ArrayBuffer,
          "Ed25519" as any,
          false,
          ["sign"],
        );
        return new Uint8Array(
          await crypto.subtle.sign("Ed25519" as any, key, message.buffer as ArrayBuffer),
        );
      },
    };
    return _backend;
  } catch {
    // Native Ed25519 not supported — fall through
  }

  // Fallback: @noble/ed25519 (must be installed as a dependency)
  try {
    const noble = await import("@noble/ed25519");
    _backend = {
      async generateKeypair() {
        const privateKey = noble.utils.randomPrivateKey();
        const publicKey = await noble.getPublicKeyAsync(privateKey);
        return { publicKey, privateKey };
      },
      async sign(privateKeyBytes: Uint8Array, message: Uint8Array) {
        return await noble.signAsync(message, privateKeyBytes);
      },
    };
    return _backend;
  } catch {
    throw new Error(
      "Ed25519 not available: neither Web Crypto Ed25519 nor @noble/ed25519 could be loaded.",
    );
  }
}

// ── Device Identity ────────────────────────────────────────────────────────

const STORAGE_KEY = "controluiclaw-device-identity-v1";
let _cachedIdentity: DeviceIdentity | null = null;

function loadStoredIdentity(): DeviceIdentity | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p?.version === 1 && p.deviceId && p.publicKey && p.privateKey) {
      return {
        deviceId: p.deviceId,
        publicKey: p.publicKey,
        privateKey: p.privateKey,
      };
    }
  } catch {
    // Ignore storage errors (SSR, restricted contexts, etc.)
  }
  return null;
}

function storeIdentity(identity: DeviceIdentity): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, ...identity, createdAtMs: Date.now() }),
    );
  } catch {
    // Ignore
  }
}

/**
 * Returns an Ed25519 device identity. If one was previously generated in this
 * session it is reused; otherwise a fresh keypair is created and cached.
 *
 * You can also provide your own identity via `ControlUIClawClientOptions.deviceIdentity`.
 */
export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  if (_cachedIdentity) return _cachedIdentity;

  await initCryptoBackend();

  const stored = loadStoredIdentity();
  if (stored) {
    _cachedIdentity = stored;
    return _cachedIdentity;
  }

  const backend = await initCryptoBackend();
  const { publicKey, privateKey } = await backend.generateKeypair();
  const deviceId = await fingerprintPublicKey(publicKey);

  _cachedIdentity = {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
  storeIdentity(_cachedIdentity);
  return _cachedIdentity;
}

/**
 * Clears the cached device identity (useful for testing or key rotation).
 */
export function clearCachedIdentity(): void {
  _cachedIdentity = null;
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore
  }
}

// ── Auth Payload Construction ──────────────────────────────────────────────

/**
 * Builds the canonical string that gets signed for device authentication.
 */
export function buildDeviceAuthPayload(fields: DeviceAuthFields): string {
  return [
    "v2",
    fields.deviceId,
    fields.clientId,
    fields.clientMode,
    fields.role,
    fields.scopes.join(","),
    String(fields.signedAtMs),
    fields.token ?? "",
    fields.nonce,
  ].join("|");
}

/**
 * Signs a payload string with the given Ed25519 private key.
 * Returns the signature as a base64url-encoded string.
 */
export async function signPayload(
  privateKeyBase64Url: string,
  payload: string,
): Promise<string> {
  const backend = await initCryptoBackend();
  const key = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const sig = await backend.sign(key, data);
  return base64UrlEncode(sig);
}
