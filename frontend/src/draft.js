/**
 * draft.js — IndexedDB-based draft + submission system for offline-first support
 * Replaces localStorage with full offline capability including signatures
 */

const DB_NAME = "ServiceReportDB";
const DB_VERSION = 4; // v4: delete+recreate drafts store to fix keyPath 'key'→'id' migration
const STORE_DRAFTS = "drafts";
const STORE_SUBMISSIONS = "submissions";

let dbInstance = null;

// ─────────────────────────────────────────────────────────────────────────
// UTILITY: UUID Generator (works everywhere)
// ─────────────────────────────────────────────────────────────────────────

function generateUUID() {
  // Use crypto.randomUUID() if available, fallback to timestamp+random
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random hex string
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
}

// ─────────────────────────────────────────────────────────────────────────
// DATABASE INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────

export async function initOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => {
      console.error("[OFFLINE-DB] Open error:", req.error);
      reject(new Error("Failed to open IndexedDB: " + req.error));
    };
    req.onblocked = () => {
      console.warn(
        "[OFFLINE-DB] Upgrade blocked — close other tabs using this app",
      );
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      // Close when a higher version is requested (prevents blocking)
      dbInstance.onversionchange = () => {
        dbInstance.close();
        dbInstance = null;
        console.warn("[OFFLINE-DB] Connection closed for version upgrade");
      };
      console.log("[OFFLINE-DB] IndexedDB initialized");
      resolve(dbInstance);
    };

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      const oldVersion = event.oldVersion;

      // v4 migration: old drafts store was created with keyPath:'key' (signatures.js v1).
      // Delete it so it can be recreated with the correct keyPath:'id'.
      if (oldVersion < 4 && db.objectStoreNames.contains(STORE_DRAFTS)) {
        db.deleteObjectStore(STORE_DRAFTS);
        console.log("[OFFLINE-DB] Deleted old drafts store (keyPath fix)");
      }

      if (!db.objectStoreNames.contains("signatures")) {
        db.createObjectStore("signatures", {
          keyPath: "id",
          autoIncrement: true,
        });
        console.log("[OFFLINE-DB] Signatures store created");
      }

      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        const draftStore = db.createObjectStore(STORE_DRAFTS, {
          keyPath: "id",
        });
        draftStore.createIndex("updated_at", "updated_at", { unique: false });
        console.log("[OFFLINE-DB] Drafts store created with keyPath:id");
      }

      if (!db.objectStoreNames.contains(STORE_SUBMISSIONS)) {
        const subStore = db.createObjectStore(STORE_SUBMISSIONS, {
          keyPath: "id",
        });
        subStore.createIndex("submitted_at", "submitted_at", { unique: false });
        console.log("[OFFLINE-DB] Submissions store created");
      }
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// DRAFTS - Work In Progress
// ─────────────────────────────────────────────────────────────────────────

/** Serialize FormData preserving multi-value fields (e.g. tsp_workwith) as arrays. */
function formDataToObject(formData) {
  const obj = {};
  for (const key of formData.keys()) {
    const values = formData.getAll(key);
    obj[key] = values.length === 1 ? values[0] : values;
  }
  return obj;
}

export async function saveDraft(formData, signatures = null) {
  if (!dbInstance) await initOfflineDB();

  return new Promise((resolve, reject) => {
    const draft = {
      id: generateUUID(),
      status: "draft",
      item_name: formData.get("name") || "Untitled",
      formData: formDataToObject(formData),
      signatures: signatures || {},
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    console.log("[DRAFT] Creating with ID:", draft.id);

    try {
      const tx = dbInstance.transaction([STORE_DRAFTS], "readwrite");
      const store = tx.objectStore(STORE_DRAFTS);

      // Use put() instead of add() to avoid duplicate key errors
      const req = store.put(draft);

      req.onerror = () => {
        console.error("[DRAFT] Save error:", req.error);
        reject(new Error("Failed to save draft: " + req.error));
      };
      req.onsuccess = () => {
        console.log("[DRAFT] Saved successfully:", draft.id);
        resolve(draft.id);
      };

      tx.onerror = () => {
        console.error("[DRAFT] Transaction error:", tx.error);
        reject(new Error("Transaction failed: " + tx.error));
      };
    } catch (err) {
      console.error("[DRAFT] Exception:", err);
      reject(err);
    }
  });
}

export async function updateDraft(draftId, formData, signatures = null) {
  if (!dbInstance) await initOfflineDB();

  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction([STORE_DRAFTS], "readwrite");
    const store = tx.objectStore(STORE_DRAFTS);
    const getReq = store.get(draftId);

    getReq.onsuccess = () => {
      const draft = getReq.result;
      if (!draft) {
        reject(new Error("Draft not found"));
        return;
      }

      draft.item_name = formData.get("name") || draft.item_name;
      draft.formData = formDataToObject(formData);
      if (signatures) draft.signatures = signatures;
      draft.updated_at = Date.now();

      const putReq = store.put(draft);
      putReq.onsuccess = () => {
        console.log("[DRAFT] Updated:", draftId);
        resolve(draftId);
      };
      putReq.onerror = () => reject(new Error("Failed to update draft"));
    };
  });
}

export async function getDraft(draftId) {
  if (!dbInstance) await initOfflineDB();

  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction([STORE_DRAFTS], "readonly");
    const store = tx.objectStore(STORE_DRAFTS);
    const req = store.get(draftId);

    req.onerror = () => reject(new Error("Failed to get draft"));
    req.onsuccess = () => resolve(req.result);
  });
}

export async function getAllDrafts() {
  if (!dbInstance) await initOfflineDB();

  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction([STORE_DRAFTS], "readonly");
    const store = tx.objectStore(STORE_DRAFTS);
    const req = store.getAll();

    req.onerror = () => reject(new Error("Failed to get drafts"));
    req.onsuccess = () => resolve(req.result || []);
  });
}

export async function deleteDraft(draftId) {
  if (!dbInstance) await initOfflineDB();

  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction([STORE_DRAFTS], "readwrite");
    const store = tx.objectStore(STORE_DRAFTS);
    const req = store.delete(draftId);

    req.onerror = () => reject(new Error("Failed to delete draft"));
    req.onsuccess = () => {
      console.log("[DRAFT] Deleted:", draftId);
      resolve(true);
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SUBMISSIONS - Queued to Sync
// ─────────────────────────────────────────────────────────────────────────

export async function saveSubmission(formData, signatures = null) {
  if (!dbInstance) await initOfflineDB();

  return new Promise((resolve, reject) => {
    // Preserve multi-value fields (e.g. tsp_workwith sent as multiple entries)
    const formObj = {};
    for (const key of formData.keys()) {
      const values = formData.getAll(key);
      formObj[key] = values.length === 1 ? values[0] : values;
    }

    const submission = {
      id: generateUUID(),
      status: "local",
      item_name: formData.get("name") || "Untitled",
      formData: formObj,
      signatures: signatures || {},
      submitted_at: Date.now(),
      monday_item_id: null,
      sync_attempts: 0,
      last_sync_error: null,
      synced_at: null,
    };

    console.log("[SUBMISSION] Creating with ID:", submission.id);

    try {
      const tx = dbInstance.transaction([STORE_SUBMISSIONS], "readwrite");
      const store = tx.objectStore(STORE_SUBMISSIONS);

      // Use put() instead of add() to avoid duplicate key errors
      const req = store.put(submission);

      req.onerror = () => {
        console.error("[SUBMISSION] Save error:", req.error);
        reject(new Error("Failed to save submission: " + req.error));
      };
      req.onsuccess = () => {
        console.log("[SUBMISSION] Saved successfully:", submission.id);
        resolve(submission.id);
      };

      tx.onerror = () => {
        console.error("[SUBMISSION] Transaction error:", tx.error);
        reject(new Error("Transaction failed: " + tx.error));
      };
    } catch (err) {
      console.error("[SUBMISSION] Exception:", err);
      reject(err);
    }
  });
}

export async function getAllSubmissions() {
  if (!dbInstance) await initOfflineDB();

  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction([STORE_SUBMISSIONS], "readonly");
    const store = tx.objectStore(STORE_SUBMISSIONS);
    const req = store.getAll();

    req.onerror = () => reject(new Error("Failed to get submissions"));
    req.onsuccess = () => resolve(req.result || []);
  });
}

export async function deleteSubmission(id) {
  if (!dbInstance) await initOfflineDB();

  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction([STORE_SUBMISSIONS], "readwrite");
    const store = tx.objectStore(STORE_SUBMISSIONS);
    const req = store.delete(id);

    req.onerror = () => reject(new Error("Failed to delete submission"));
    req.onsuccess = () => {
      console.log("[SUBMISSION] Deleted:", id);
      resolve(true);
    };
  });
}

export async function updateSubmissionStatus(id, status, extra = {}) {
  if (!dbInstance) await initOfflineDB();

  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction([STORE_SUBMISSIONS], "readwrite");
    const store = tx.objectStore(STORE_SUBMISSIONS);
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const sub = getReq.result;
      if (!sub) {
        reject(new Error("Submission not found"));
        return;
      }
      Object.assign(sub, { status, ...extra });
      const putReq = store.put(sub);
      putReq.onsuccess = () => resolve(true);
      putReq.onerror = () => reject(new Error("Failed to update submission"));
    };
    getReq.onerror = () => reject(new Error("Failed to get submission"));
  });
}

export async function getPendingSubmissions() {
  const all = await getAllSubmissions();
  return all.filter((s) => s.status !== "synced");
}

// ─────────────────────────────────────────────────────────────────────────
// LEGACY FUNCTIONS (For Backward Compatibility)
// ─────────────────────────────────────────────────────────────────────────

export function loadDraft() {
  // Legacy: kept for compatibility, new code uses refreshDraftsList()
  console.log("[DRAFT] loadDraft() called (legacy)");
}

export function clearDraft() {
  // Legacy: kept for compatibility
  console.log("[DRAFT] clearDraft() called (legacy)");
}
