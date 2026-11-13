/**
 * Chrome derives an extension's ID from its public key: the first 128 bits of SHA-256 over the
 * DER key, written with the letters a-p instead of hex digits. The manifest carries a fixed "key"
 * so the unpacked extension has the same ID on every machine, which the native host manifest's
 * allowed_origins needs.
 */
export async function extensionIdFromKey(base64Key: string): Promise<string> {
  const der = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  let id = "";
  for (const byte of digest.subarray(0, 16)) id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  return id;
}
