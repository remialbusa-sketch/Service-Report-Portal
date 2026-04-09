/**
 * main.js — Application entry point.
 * Imports styles (Vite bundles them to main.css) and orchestrates all modules.
 * Depends on CDN globals: window.$, window.SignaturePad, window.bootstrap
 */

import "./style.css";

import {
  openDB,
  buildSignaturePads,
  initPads,
  updatePendingBadge,
  syncPending,
  clearPending,
  uploadSignature,
  saveSignatureBlob,
  sigBlobs,
  pads,
  SIG_PADS,
  captureSignature,
  clearPad,
} from "./signatures.js";

import {
  loadDraft,
  clearDraft,
  saveSubmission,
  getPendingSubmissions,
  deleteSubmission,
  updateSubmissionStatus,
} from "./draft.js";
import { initOfflineUI } from "./offline-ui.js";

// ── Select2 initialisation ────────────────────────────────────────────────────

/** Render a person option with avatar/initials like Monday's people column */
function formatPerson(person) {
  if (!person.id) return person.text;
  const photo = person.photo
    ? `<img src="${person.photo}" class="people-avatar" alt="" />`
    : `<span class="people-initials">${person.initials || "?"}</span>`;
  return window.$(
    `<span class="people-option">${photo}<span class="people-name">${person.text}</span></span>`,
  );
}

/** Render a selected person tag */
function formatPersonSelection(person) {
  if (!person.id) return person.text;
  const photo = person.photo
    ? `<img src="${person.photo}" class="people-avatar-sm" alt="" />`
    : `<span class="people-initials-sm">${person.initials || "?"}</span>`;
  return window.$(`<span class="people-tag">${photo} ${person.text}</span>`);
}

function initSelect2() {
  if (!window.$ || !window.$.fn.select2) {
    setTimeout(initSelect2, 100);
    return;
  }
  try {
    // Service request dropdown
    window.$('select[name="linked_item_id"]').select2({
      placeholder: "Type to search service requests...",
      allowClear: true,
      width: "100%",
      ajax: {
        url: "/search_linked_items",
        dataType: "json",
        delay: 300,
        data: (params) => ({ q: params.term || "" }),
        processResults: (data) => ({ results: data.results }),
        cache: false,
      },
      minimumInputLength: 1,
      language: {
        inputTooShort: () => "Type at least 1 character to search…",
        searching: () => "Searching Monday.com…",
        noResults: () => "No service requests found",
      },
    });

    // Machine System dropdown with search
    window.$(".machine-picker").select2({
      placeholder: "Search machine systems…",
      allowClear: true,
      width: "100%",
      minimumResultsForSearch: 0,
    });

    // People picker — TSP WORKWITH
    window.$(".people-picker").select2({
      placeholder: "Search team members…",
      allowClear: true,
      width: "100%",
      ajax: {
        url: "/api/users",
        dataType: "json",
        delay: 250,
        data: (params) => ({ q: params.term || "" }),
        processResults: (data) => ({ results: data.results }),
        cache: true,
      },
      minimumInputLength: 0,
      templateResult: formatPerson,
      templateSelection: formatPersonSelection,
      language: {
        searching: () => "Searching team members…",
        noResults: () => "No members found",
      },
    });
  } catch (e) {
    console.error("Select2 init error:", e);
  }
}

// ── Network status badge ──────────────────────────────────────────────────────

async function refreshNetworkBadge() {
  const badge = document.getElementById("networkBadge");
  if (!badge) return;
  const pending = await getPendingSubmissions();
  const isOnline = navigator.onLine;
  if (!isOnline) {
    badge.className = "badge bg-danger me-2";
    badge.textContent =
      pending.length > 0 ? `Offline · ${pending.length} queued` : "Offline";
    badge.style.display = "inline";
  } else if (pending.length > 0) {
    badge.className = "badge bg-warning text-dark me-2";
    badge.textContent = `${pending.length} queued`;
    badge.style.display = "inline";
  } else {
    badge.className = "badge bg-success me-2";
    badge.textContent = "Online";
    badge.style.display = "inline";
  }
}

// ── Pending submissions sync engine ──────────────────────────────────────────

async function syncPendingSubmissions() {
  const pending = await getPendingSubmissions();
  if (!pending.length) {
    await refreshNetworkBadge();
    return;
  }
  console.log(`[SYNC] Draining outbox: ${pending.length} submission(s)`);

  for (const sub of pending) {
    try {
      // Reconstruct FormData from stored plain object
      const fd = new FormData();
      for (const [key, val] of Object.entries(sub.formData)) {
        if (Array.isArray(val)) {
          for (const v of val) fd.append(key, String(v));
        } else if (val != null) {
          fd.append(key, String(val));
        }
      }

      await updateSubmissionStatus(sub.id, "syncing");

      const res = await fetch("/submit", {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        body: fd,
      });
      const result = await res.json();

      if (result.success) {
        // Upload any stored signature blobs
        if (sub.signatures) {
          for (const [key, blob] of Object.entries(sub.signatures)) {
            if (blob) {
              try {
                await uploadSignature(key, blob, result.item_id);
              } catch (sigErr) {
                console.warn(
                  `[SYNC] Sig ${key} upload failed, saving:`,
                  sigErr,
                );
                await saveSignatureBlob(key, blob, result.item_id);
              }
            }
          }
        }
        await deleteSubmission(sub.id);
        console.log(`[SYNC] Synced submission ${sub.id.slice(0, 8)}`);
      } else {
        await updateSubmissionStatus(sub.id, "error", {
          last_sync_error: result.error || "Server rejected submission",
          sync_attempts: (sub.sync_attempts || 0) + 1,
        });
        console.warn(
          `[SYNC] Server error for ${sub.id.slice(0, 8)}:`,
          result.error,
        );
      }
    } catch (err) {
      await updateSubmissionStatus(sub.id, "local", {
        last_sync_error: err.message,
        sync_attempts: (sub.sync_attempts || 0) + 1,
      });
      console.warn(
        `[SYNC] Network error for ${sub.id.slice(0, 8)}:`,
        err.message,
      );
    }
  }

  await updatePendingBadge();
  await refreshNetworkBadge();
}

// ── Form submission ───────────────────────────────────────────────────────────

async function handleSubmit(e) {
  e.preventDefault();

  const form = document.getElementById("mainForm");
  const btn = document.getElementById("submitBtn");
  const statusDiv = document.getElementById("uploadStatus");

  btn.disabled = true;
  btn.textContent = "Submitting...";
  statusDiv.style.display = "block";
  statusDiv.className = "upload-status bg-info-subtle text-info";
  statusDiv.textContent = "Preparing submission…";

  try {
    // Auto-capture any unsaved signature drawings
    for (const cfg of SIG_PADS) {
      const pad = pads[cfg.key];
      if (pad && !pad.isEmpty() && !sigBlobs[cfg.key]) {
        const canvas = document.getElementById(`canvas-${cfg.key}`);
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (blob) sigBlobs[cfg.key] = blob;
      }
    }

    // Collect form data + Select2 AJAX values
    const formData = new FormData(form);
    if (window.$ && window.$.fn.select2) {
      const peopleEl = window.$("#field-workwith");
      if (peopleEl.length) {
        formData.delete("tsp_workwith");
        const selected = peopleEl.select2("data") || [];
        console.log("[WORKWITH] select2 data:", selected);
        for (const item of selected) {
          if (item.id) formData.append("tsp_workwith", item.id);
        }
        console.log(
          "[WORKWITH] FormData tsp_workwith:",
          formData.getAll("tsp_workwith"),
        );
      }

      const assignedEl = window.$("#field-assigned");
      if (assignedEl.length) {
        formData.delete("tsp_assigned");
        const selectedAssigned = assignedEl.select2("data") || [];
        console.log("[ASSIGNED] select2 data:", selectedAssigned);
        for (const item of selectedAssigned) {
          if (item.id) formData.append("tsp_assigned", item.id);
        }
        console.log(
          "[ASSIGNED] FormData tsp_assigned:",
          formData.getAll("tsp_assigned"),
        );
      }
    }

    // ── OFFLINE PATH ─────────────────────────────────────────────────────────
    if (!navigator.onLine) {
      await saveSubmission(formData, { ...sigBlobs });
      statusDiv.className = "upload-status bg-warning-subtle text-warning";
      statusDiv.innerHTML = `
        <div>
          💾 <strong>Saved offline</strong>
          <br/><small>Your report is queued and will sync to Monday.com automatically when you reconnect.</small>
        </div>`;
      for (const key of Object.keys(sigBlobs)) delete sigBlobs[key];
      for (const cfg of SIG_PADS) clearPad(cfg.key);
      form.reset();
      clearDraft();
      await updatePendingBadge();
      await refreshNetworkBadge();
      btn.disabled = false;
      btn.textContent = "Submit to Monday.com";
      return;
    }

    // ── ONLINE PATH ───────────────────────────────────────────────────────────
    statusDiv.textContent = "Creating item on Monday.com...";

    let result;
    try {
      const res = await fetch("/submit", {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        body: formData,
      });
      result = await res.json();
    } catch (networkErr) {
      // Network failed mid-request — save to outbox
      console.warn(
        "[SUBMIT] Network error, saving to outbox:",
        networkErr.message,
      );
      await saveSubmission(formData, { ...sigBlobs });
      statusDiv.className = "upload-status bg-warning-subtle text-warning";
      statusDiv.innerHTML = `
        <div>
          💾 <strong>Saved offline</strong>
          <br/><small>Connection lost. Report queued and will sync when reconnected.</small>
        </div>`;
      for (const key of Object.keys(sigBlobs)) delete sigBlobs[key];
      for (const cfg of SIG_PADS) clearPad(cfg.key);
      form.reset();
      clearDraft();
      await updatePendingBadge();
      await refreshNetworkBadge();
      btn.disabled = false;
      btn.textContent = "Submit to Monday.com";
      return;
    }

    if (!result.success || !result.item_id) {
      statusDiv.className = "upload-status bg-danger-subtle text-danger";
      statusDiv.textContent =
        "Error: " + (result.error || "Failed to create item");
      btn.disabled = false;
      btn.textContent = "Submit to Monday.com";
      return;
    }

    const itemId = result.item_id;
    statusDiv.textContent = `Item created (ID: ${itemId}). Uploading signatures…`;

    // Step 2: Upload signatures
    const sigKeys = Object.keys(sigBlobs);
    let uploaded = 0;
    let failed = 0;

    for (const key of sigKeys) {
      statusDiv.textContent = `Uploading ${key}… (${uploaded + 1}/${sigKeys.length})`;
      try {
        const uploadResult = await uploadSignature(key, sigBlobs[key], itemId);
        if (uploadResult.success) {
          uploaded++;
        } else {
          console.warn(`[SIG] ${key} failed:`, uploadResult.error);
          await saveSignatureBlob(key, sigBlobs[key], itemId);
          failed++;
        }
      } catch (err) {
        console.error(`[SIG] ${key} error:`, err);
        await saveSignatureBlob(key, sigBlobs[key], itemId);
        failed++;
      }
    }

    // Step 3: Show result
    if (failed === 0 && sigKeys.length > 0) {
      statusDiv.className = "upload-status bg-success-subtle text-success";
      statusDiv.textContent = `Done! Item created + ${uploaded} signature(s) uploaded.`;
    } else if (failed > 0) {
      statusDiv.className = "upload-status bg-warning-subtle text-warning";
      statusDiv.textContent = `Item created. ${uploaded} uploaded, ${failed} saved offline (use Sync).`;
    } else {
      statusDiv.className = "upload-status bg-success-subtle text-success";
      statusDiv.textContent = `Item "${result.item_name}" created successfully!`;
    }

    // Cleanup
    for (const key of sigKeys) delete sigBlobs[key];
    for (const cfg of SIG_PADS) clearPad(cfg.key);
    form.reset();
    clearDraft();
    await updatePendingBadge();
    await refreshNetworkBadge();
  } catch (err) {
    console.error("[SUBMIT] Error:", err);
    statusDiv.className = "upload-status bg-danger-subtle text-danger";
    statusDiv.textContent = "Submission error: " + err.message;
  }

  btn.disabled = false;
  btn.textContent = "Submit to Monday.com";
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  // IndexedDB
  try {
    await openDB();
  } catch (e) {
    console.warn("IndexedDB unavailable:", e);
  }

  // Initialize offline-first UI (drafts + submissions tabs)
  try {
    await initOfflineUI();
  } catch (e) {
    console.warn("[OFFLINE] UI init failed:", e);
  }

  // Signature pads (DOM injection + initialise after CDN scripts loaded)
  buildSignaturePads();

  // Wait for CDN scripts (deferred) then init pads + select2
  const waitForCDN = () => {
    if (window.SignaturePad && window.$) {
      initPads();
      initSelect2();
    } else {
      setTimeout(waitForCDN, 50);
    }
  };
  waitForCDN();

  // Form events
  document.getElementById("mainForm")?.addEventListener("submit", handleSubmit);
  // Note: saveDraftBtn click is handled by offline-ui.js initOfflineUI() via [data-action='save-draft']

  // Sidebar pending-signature actions
  document.getElementById("syncBtn")?.addEventListener("click", syncPending);
  document
    .getElementById("clearPendingBtn")
    ?.addEventListener("click", clearPending);

  // Draft restore + pending badge
  loadDraft();
  await updatePendingBadge();
  await refreshNetworkBadge();

  // Sync any queued submissions if already online
  if (navigator.onLine) {
    syncPendingSubmissions();
  }

  // Network status listeners
  window.addEventListener("online", () => {
    refreshNetworkBadge();
    syncPendingSubmissions();
  });
  window.addEventListener("offline", refreshNetworkBadge);

  // Service Worker registration
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => console.log("[SW] Registered, scope:", reg.scope))
      .catch((err) => console.warn("[SW] Registration failed:", err));
  }

  console.log("[INIT] Service Report Portal ready");
});
