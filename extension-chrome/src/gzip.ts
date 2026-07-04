// Deterministic gzip for storage payloads. fflate is bundled so every
// platform takes the same code path — CompressionStream is NOT available in
// the iOS Safari extension context (discovered via field diagnostics: queues
// were silently shipping uncompressed there, 2x over budget), and a
// feature-detected fallback means different contexts can disagree about the
// stored format. No chrome APIs here; trivially unit-testable.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";

export function gzipToB64(text: string): string {
  const bytes = gzipSync(strToU8(text));
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function gunzipFromB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return strFromU8(gunzipSync(bytes));
}
