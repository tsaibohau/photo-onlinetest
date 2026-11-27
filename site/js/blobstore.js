// Tiny IndexedDB key–value store for things too big for localStorage (photos of evacuation maps,
// the aligned background handed from the walking survey to the editor).
const DB = 'photopath-survey', STORE = 'kv';

function open() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((ok, fail) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); ok(req?.result); };
    tx.onerror = () => { db.close(); fail(tx.error); };
  });
}

export const putBlob = (key, value) => run('readwrite', (s) => s.put(value, key));
export const getBlob = (key) => run('readonly', (s) => s.get(key));
export const delBlob = (key) => run('readwrite', (s) => s.delete(key));
