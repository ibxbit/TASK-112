import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

// jsdom's WebCrypto shim rejects the sliced ArrayBuffer salts produced by
// AuthService/BackupService. Unconditionally install Node's WebCrypto so
// PBKDF2/AES-GCM paths run identically to the browser.
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
  writable: true,
});
