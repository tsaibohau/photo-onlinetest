// .phop container: ZIP with an uncompressed `mimetype` entry first.
// Requires global JSZip (loaded from CDN in the page).

import { PHASE0 } from './config.js';

export const MIME = 'application/x-phop';
export const FORMAT = 'phop/0.1';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBytes = (d) => (typeof d === 'string' ? enc.encode(d) : d);
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class PhopError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function sha256hex(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- IndexedDB: device key + handoff ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('photopath', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('keys');
      req.result.createObjectStore('handoff');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

/** This device's non-extractable AES-GCM key. Created on first use. */
export async function getOrCreateDeviceKey() {
  const existing = await idb('keys', 'readonly', (s) => s.get('device'));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const keyId = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const rec = { key, keyId };
  await idb('keys', 'readwrite', (s) => s.put(rec, 'device'));
  return rec;
}

async function getDeviceKey(keyId) {
  const rec = await idb('keys', 'readonly', (s) => s.get('device'));
  return rec && rec.keyId === keyId ? rec.key : null;
}

export const saveHandoff = (blob) => idb('handoff', 'readwrite', (s) => s.put(blob, 'last'));
export const loadHandoff = () => idb('handoff', 'readonly', (s) => s.get('last'));

// ---------- write ----------
/**
 * @param {object} manifest  base manifest (title, coordinateSystem, …)
 * @param {Record<string, Uint8Array|string>} payload  e.g. {'map.webp': bytes, 'graph.json': '…'}
 * @param {'UNLICENSED'|'ORGANIZER'} mode
 */
export async function buildPhop(manifest, payload, mode, { bindToDevice = PHASE0.bindFreeFilesToDevice } = {}) {
  const files = {};
  for (const [name, data] of Object.entries(payload)) {
    files[`payload/${name}`] = 'sha256-' + (await sha256hex(toBytes(data)));
  }
  const fullManifest = {
    format: FORMAT,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    creator: 'photopath-web/0.1',
    ...manifest,
    mode,
    files,
  };
  const license = {
    type: mode,
    issuedAt: fullManifest.createdAt,
    billing: { phase: 0, enforced: false },
  };

  const zip = new JSZip();
  zip.file('mimetype', MIME, { compression: 'STORE' });
  zip.file('manifest.json', JSON.stringify(fullManifest, null, 2));

  if (mode === 'UNLICENSED' && bindToDevice) {
    const inner = new JSZip();
    for (const [name, data] of Object.entries(payload)) inner.file(`payload/${name}`, data);
    const innerBytes = await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const { key, keyId } = await getOrCreateDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, innerBytes);
    license.notice = '本檔案未經主辦方授權，僅供下載者本人於原裝置使用';
    license.deviceBinding = { keyId, alg: 'AES-GCM-256', iv: b64(iv) };
    zip.file('license.json', JSON.stringify(license, null, 2));
    zip.file('payload.enc', new Uint8Array(cipher));
  } else {
    if (mode === 'UNLICENSED') {
      // Phase 0: still marked unlicensed, but readable on any device.
      license.notice = '本檔案未經主辦方授權（Beta 期間暫時開放在任何裝置開啟）';
      license.deviceBinding = null;
      license.billing.temporaryOpenAccess = true;
    }
    license.signature = null; // Phase 1: Ed25519 by server
    zip.file('license.json', JSON.stringify(license, null, 2));
    for (const [name, data] of Object.entries(payload)) zip.file(`payload/${name}`, data);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: MIME });
}

// ---------- read ----------
/** Returns {manifest, license, files: {name: Uint8Array}} or throws PhopError. */
export async function readPhop(input) {
  const bytes = new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input);
  // Local file header: name at offset 30, data right after (STORE).
  const sig = dec.decode(bytes.subarray(30, 30 + 8 + MIME.length));
  if (sig !== 'mimetype' + MIME) throw new PhopError('NOT_PHOP', '這不是 .phop 檔案');

  const zip = await JSZip.loadAsync(bytes);
  const readJSON = async (n) => JSON.parse(await zip.file(n).async('string'));
  const manifest = await readJSON('manifest.json');
  const license = await readJSON('license.json');

  let source = zip;
  if (license.type === 'UNLICENSED' && license.deviceBinding) {
    const b = license.deviceBinding;
    const key = b && (await getDeviceKey(b.keyId));
    if (!key) {
      throw new PhopError(
        'OTHER_DEVICE',
        '此檔案未經授權，僅能在建立它的裝置上開啟。'
      );
    }
    const cipher = await zip.file('payload.enc').async('uint8array');
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(b.iv) }, key, cipher);
    } catch {
      throw new PhopError('DECRYPT_FAILED', '檔案解密失敗，可能已損毀或不是在此裝置建立。');
    }
    source = await JSZip.loadAsync(plain);
  }

  const files = {};
  for (const [path, hash] of Object.entries(manifest.files || {})) {
    const f = source.file(path);
    if (!f) throw new PhopError('MISSING_FILE', `檔案缺少 ${path}`);
    const data = await f.async('uint8array');
    if ('sha256-' + (await sha256hex(data)) !== hash) {
      throw new PhopError('HASH_MISMATCH', `${path} 的雜湊不符，檔案可能已損毀`);
    }
    files[path.replace(/^payload\//, '')] = data;
  }
  return { manifest, license, files };
}

export const json = (bytes) => JSON.parse(dec.decode(bytes));
