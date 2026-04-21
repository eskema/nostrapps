const DB_NAME = 'nostrapps-data';
const DB_VERSION = 1;
const STORE = 'instance';

let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: ['instanceId', 'key'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function get(instanceId, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get([instanceId, key]);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function set(instanceId, key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ instanceId, key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function del(instanceId, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete([instanceId, key]);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function keys(instanceId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const range = IDBKeyRange.bound([instanceId, ''], [instanceId, '\uffff']);
    const req = tx.objectStore(STORE).getAllKeys(range);
    req.onsuccess = () => resolve(req.result.map((k) => k[1]));
    req.onerror = () => reject(req.error);
  });
}

export async function clear(instanceId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const range = IDBKeyRange.bound([instanceId, ''], [instanceId, '\uffff']);
    tx.objectStore(STORE).delete(range);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
