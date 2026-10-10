// Local, encrypted storage (architecture.md §17, security-threat-model.md §3.3). Every record is AES-GCM encrypted with
// a non-extractable WebCrypto key that lives in IndexedDB: the key can be used by this extension but never read out.
// Nothing here is synced or sent anywhere.

const DB = 'jmo';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => {
          db.close();
          resolve(r.result);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
}

let keyPromise: Promise<CryptoKey> | null = null;
function masterKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const existing = await tx<CryptoKey | undefined>('keys', 'readonly', (s) => s.get('master'));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await tx('keys', 'readwrite', (s) => s.put(key, 'master'));
    return key;
  })();
  return keyPromise;
}

interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

export async function put<T>(id: string, value: T): Promise<void> {
  const key = await masterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  await tx('records', 'readwrite', (s) => s.put({ iv, data } satisfies Sealed, id));
  notify(id);
}

export async function get<T>(id: string): Promise<T | null> {
  const rec = await tx<Sealed | undefined>('records', 'readonly', (s) => s.get(id));
  if (!rec) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource }, await masterKey(), rec.data);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null; // key was reset: the record is unreadable by design
  }
}

export async function del(id: string): Promise<void> {
  await tx('records', 'readwrite', (s) => s.delete(id));
  notify(id);
}

export async function keys(prefix = ''): Promise<string[]> {
  const all = await tx<IDBValidKey[]>('records', 'readonly', (s) => s.getAllKeys());
  return all.map(String).filter((k) => k.startsWith(prefix));
}

/** "Delete all local data": records, the key itself, and extension storage. */
export async function wipeAll(): Promise<void> {
  keyPromise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  notify('*');
}

// Cross-page change notifications (side panel ↔ options page) without sending any data.
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('jmo-store') : null;
const listeners = new Set<(id: string) => void>();
function notify(id: string) {
  channel?.postMessage(id);
  listeners.forEach((l) => l(id));
}
channel?.addEventListener('message', (e) => listeners.forEach((l) => l(String(e.data))));
export function onChange(fn: (id: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
