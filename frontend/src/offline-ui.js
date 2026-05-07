/**
 * offline-ui.js — Tab UI handlers for drafts and submissions
 * Integrates with draft.js for offline-first workflow
 */

import {
  initOfflineDB,
  saveDraft,
  updateDraft,
  getDraft,
  getAllDrafts,
  deleteDraft,
  saveSubmission,
  getAllSubmissions,
  deleteSubmission,
} from "./draft.js";

import { sigBlobs, pads, SIG_PADS } from "./signatures.js";

let currentEditingDraftId = null;

// ─────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────

export async function initOfflineUI() {
  try {
    await initOfflineDB();
    console.log("[OFFLINE-UI] Initialized");

    // Attach button handlers
    const saveDraftBtn = document.querySelector("[data-action='save-draft']");
    if (saveDraftBtn) {
      saveDraftBtn.addEventListener("click", handleSaveDraft);
    }

    // Auto-refresh lists every 5 seconds
    setInterval(refreshDraftsList, 5000);
    setInterval(refreshSubmissionsList, 5000);

    // Initial load
    await refreshDraftsList();
    await refreshSubmissionsList();
  } catch (err) {
    console.error("[OFFLINE-UI] Init error:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SAVE DRAFT HANDLER
// ─────────────────────────────────────────────────────────────────────────

async function handleSaveDraft(e) {
  e.preventDefault();

  const form = document.getElementById("mainForm");
  const btn = document.querySelector("[data-action='save-draft']");
  const statusDiv = document.getElementById("uploadStatus");

  btn.disabled = true;
  btn.textContent = "Saving…";
  statusDiv.style.display = "block";
  statusDiv.className = "alert alert-info";
  statusDiv.innerHTML =
    "<i class='fas fa-spinner fa-spin'></i> Saving draft locally…";

  try {
    // Capture any unsaved signatures
    for (const cfg of SIG_PADS) {
      const pad = pads[cfg.key];
      if (pad && !pad.isEmpty() && !sigBlobs[cfg.key]) {
        const canvas = document.getElementById(`canvas-${cfg.key}`);
        if (canvas) {
          const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, "image/png"),
          );
          if (blob) sigBlobs[cfg.key] = blob;
        }
      }
    }

    // Collect form data
    const formData = new FormData(form);

    // Sync plain email input for tsp_workwith (no longer a Select2)
    const workwithInput = document.getElementById("field-workwith");
    if (workwithInput) {
      formData.delete("tsp_workwith");
      const emailVal = workwithInput.value.trim();
      if (emailVal) formData.append("tsp_workwith", emailVal);
    }

    // Save or update draft
    if (currentEditingDraftId) {
      await updateDraft(currentEditingDraftId, formData, sigBlobs);
      console.log("[DRAFT] Updated draft:", currentEditingDraftId);
    } else {
      const draftId = await saveDraft(formData, sigBlobs);
      console.log("[DRAFT] Saved new draft:", draftId);
    }

    // Show success
    statusDiv.className = "alert alert-success";
    statusDiv.innerHTML = `
      <i class='fas fa-check-circle'></i> <strong>✓ Draft saved</strong>
      <br/>
      <small>You can continue editing or submit later.</small>
    `;

    btn.disabled = false;
    btn.textContent = "Save Draft";

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 4000);

    // Refresh lists
    await refreshDraftsList();
  } catch (error) {
    console.error("[DRAFT] Error:", error);
    statusDiv.className = "alert alert-danger";
    statusDiv.innerHTML = `<i class='fas fa-exclamation-circle'></i> Error: ${error.message}`;
    btn.disabled = false;
    btn.textContent = "Save Draft";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SUBMIT FORM HANDLER (Intercept existing form submit)
// ─────────────────────────────────────────────────────────────────────────

export function patchFormSubmitForOffline(originalSubmitHandler) {
  return async (e) => {
    // If editing a draft, convert it to submission first
    if (currentEditingDraftId) {
      await convertDraftToSubmission(currentEditingDraftId);
      currentEditingDraftId = null;
    }

    // Then call original submit handler
    return originalSubmitHandler(e);
  };
}

// ─────────────────────────────────────────────────────────────────────────
// DRAFT EDITING
// ─────────────────────────────────────────────────────────────────────────

async function editDraft(draftId) {
  try {
    const draft = await getDraft(draftId);
    if (!draft) {
      alert("Draft not found");
      return;
    }

    // Populate form fields
    const form = document.getElementById("mainForm");
    const formData = draft.formData || {};

    for (const [key, value] of Object.entries(formData)) {
      // Skip internal helper keys
      if (key.startsWith("_")) continue;
      // AJAX Select2 fields need special handling below
      if (key === "linked_item_id" || key === "tsp_workwith") continue;

      const field = form.elements[key];
      if (!field) continue;

      if (Array.isArray(value) && field.multiple) {
        Array.from(field.options).forEach((opt) => {
          opt.selected = value.includes(opt.value);
        });
      } else {
        field.value = Array.isArray(value) ? value[value.length - 1] : value;
      }
      // Trigger update for any non-AJAX Select2 (guard against throwing on plain inputs)
      try {
        if (window.$ && window.$(field).data("select2")) {
          window.$(field).trigger("change");
        }
      } catch (_) {
        /* not a Select2 element */
      }
    }

    // Restore Service Request Number (AJAX Select2) using saved text
    const linkedId = formData["linked_item_id"];
    const linkedText = formData["_linked_item_text"] || linkedId;
    if (linkedId && window.$ && window.$.fn.select2) {
      const selectEl = window.$("select[name='linked_item_id']");
      if (selectEl.length) {
        selectEl.find(`option[value='${linkedId}']`).remove();
        selectEl
          .append(new Option(linkedText, linkedId, true, true))
          .trigger("change");
      }
    }

    // Restore TSP WORKWITH (plain email input)
    const workwithEmailField = document.getElementById("field-workwith");
    if (workwithEmailField) {
      const stored = formData["tsp_workwith"];
      workwithEmailField.value = Array.isArray(stored)
        ? stored[0] || ""
        : stored || "";
    }

    // Restore signatures — update in-memory blobs AND the preview DOM
    for (const [key, blob] of Object.entries(draft.signatures || {})) {
      if (!blob) continue;
      sigBlobs[key] = blob;
      try {
        const url = URL.createObjectURL(blob);
        const thumb = document.getElementById(`thumb-${key}`);
        const preview = document.getElementById(`preview-${key}`);
        const box = document.getElementById(`box-${key}`);
        if (thumb) thumb.src = url;
        if (preview) preview.style.display = "block";
        if (box) box.classList.add("has-signature");
      } catch (err) {
        console.warn(
          `[DRAFT] Could not restore signature preview for ${key}:`,
          err,
        );
      }
    }

    // Mark as editing
    currentEditingDraftId = draftId;

    // Scroll to form
    form.scrollIntoView({ behavior: "smooth" });

    // Switch to Fill Report tab
    const tab = new window.bootstrap.Tab(document.getElementById("tab-form"));
    tab.show();

    const statusDiv = document.getElementById("uploadStatus");
    statusDiv.style.display = "block";
    statusDiv.className = "alert alert-info";
    statusDiv.innerHTML = `✏️ <strong>Editing draft</strong> — Changes will be saved`;

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 3000);

    console.log("[DRAFT] Editing:", draftId);
  } catch (err) {
    console.error("[EDIT] Error:", err);
    alert(`Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE DRAFT (with confirmation)
// ─────────────────────────────────────────────────────────────────────────

async function deleteDraftUI(draftId) {
  if (!confirm("Delete this draft? This cannot be undone.")) return;

  try {
    await deleteDraft(draftId);
    if (currentEditingDraftId === draftId) {
      currentEditingDraftId = null;
    }
    await refreshDraftsList();

    const statusDiv = document.getElementById("uploadStatus");
    statusDiv.style.display = "block";
    statusDiv.className = "alert alert-warning";
    statusDiv.innerHTML = "✓ Draft deleted";

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 2000);
  } catch (err) {
    console.error("[DELETE] Error:", err);
    alert(`Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CONVERT DRAFT TO SUBMISSION
// ─────────────────────────────────────────────────────────────────────────

async function convertDraftToSubmission(draftId) {
  try {
    const draft = await getDraft(draftId);
    if (!draft) return;

    // Create submission from draft formData
    const formData = new FormData();
    for (const [key, value] of Object.entries(draft.formData)) {
      if (Array.isArray(value)) {
        for (const v of value) formData.append(key, v);
      } else {
        formData.append(key, value);
      }
    }

    // Save as submission
    await saveSubmission(formData, draft.signatures);

    // Delete the draft
    await deleteDraft(draftId);

    console.log("[DRAFT] Converted to submission:", draftId);
    await refreshDraftsList();
    await refreshSubmissionsList();
  } catch (err) {
    console.error("[CONVERT] Error:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// REFRESH DRAFTS LIST (Tab 2)
// ─────────────────────────────────────────────────────────────────────────

async function refreshDraftsList() {
  try {
    const drafts = await getAllDrafts();
    const container = document.getElementById("draftsList");
    const countBadge = document.getElementById("drafts-count");

    if (!container) return;

    countBadge.textContent = drafts.length;

    if (drafts.length === 0) {
      container.innerHTML =
        '<p class="text-muted text-center py-4"><i class="fas fa-inbox"></i> No drafts saved yet.</p>';
      return;
    }

    let html = "";
    for (const draft of drafts.sort((a, b) => b.updated_at - a.updated_at)) {
      const date = new Date(draft.updated_at).toLocaleString();
      const name = draft.item_name || `Draft ${draft.id.slice(0, 8)}`;

      html += `
        <div class="list-group-item d-flex justify-content-between align-items-center p-3">
          <div class="flex-grow-1">
            <h6 class="mb-1">${name}</h6>
            <small class="text-muted">Last edited: ${date}</small>
          </div>
          <div class="btn-group-sm ms-2 d-flex gap-1">
            <button class="btn btn-sm btn-primary" onclick="window.editDraft('${draft.id}')">
              <i class="fas fa-edit"></i> Edit
            </button>
            <button class="btn btn-sm btn-success" onclick="window.submitDraft('${draft.id}')">
              <i class="fas fa-paper-plane"></i> Submit
            </button>
            <button class="btn btn-sm btn-danger" onclick="window.deleteDraftUI('${draft.id}')">
              <i class="fas fa-trash"></i> Delete
            </button>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
  } catch (err) {
    console.error("[DRAFTS] Error:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// REFRESH SUBMISSIONS LIST (Tab 3)
// ─────────────────────────────────────────────────────────────────────────

async function refreshSubmissionsList() {
  try {
    const submissions = await getAllSubmissions();
    const container = document.getElementById("submissionsList");
    const countBadge = document.getElementById("submissions-count");

    if (!container) return;

    countBadge.textContent = submissions.length;

    if (submissions.length === 0) {
      container.innerHTML =
        '<p class="text-muted text-center py-4"><i class="fas fa-check-circle"></i> No submissions yet.</p>';
      return;
    }

    let html = "";
    for (const sub of submissions.sort(
      (a, b) => b.submitted_at - a.submitted_at,
    )) {
      const date = new Date(sub.submitted_at).toLocaleString();
      const name = sub.item_name || `Item ${sub.id.slice(0, 8)}`;
      const isSynced = sub.status === "synced";

      let statusBadge = "";
      if (isSynced) {
        statusBadge =
          '<span class="badge bg-success"><i class="fas fa-check"></i> Synced</span>';
      } else if (sub.status === "syncing") {
        statusBadge =
          '<span class="badge bg-warning"><i class="fas fa-spinner fa-spin"></i> Syncing</span>';
      } else if (sub.status === "error") {
        statusBadge =
          '<span class="badge bg-danger"><i class="fas fa-exclamation"></i> Error</span>';
      } else {
        statusBadge =
          '<span class="badge bg-info"><i class="fas fa-cloud-upload-alt"></i> Local</span>';
      }

      const editBtn = !isSynced
        ? `<button class="btn btn-sm btn-outline-primary me-1" onclick="editSubmissionUI('${sub.id}')" title="Edit & re-submit"><i class="fas fa-pencil-alt"></i> Edit</button>`
        : "";

      const deleteBtn = `<button class="btn btn-sm btn-outline-danger" onclick="deleteSubmissionUI('${sub.id}')" title="Delete"><i class="fas fa-trash"></i></button>`;

      html += `
        <div class="list-group-item p-3">
          <div class="d-flex justify-content-between align-items-start">
            <div class="flex-grow-1">
              <h6 class="mb-1">${name}</h6>
              <small class="text-muted">Submitted: ${date}</small>
              ${sub.monday_item_id ? `<br/><small class="text-success"><i class="fas fa-check"></i> Monday ID: ${sub.monday_item_id}</small>` : ""}
              ${sub.last_sync_error ? `<br/><small class="text-danger"><i class="fas fa-exclamation"></i> ${sub.last_sync_error}</small>` : ""}
            </div>
            <div class="ms-2 d-flex flex-column align-items-end gap-1">
              ${statusBadge}
              <div class="mt-1">${editBtn}${deleteBtn}</div>
            </div>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
  } catch (err) {
    console.error("[SUBMISSIONS] Error:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// EXPORT GLOBAL FUNCTIONS (For HTML onclick handlers)
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// SUBMIT DRAFT DIRECTLY
// ─────────────────────────────────────────────────────────────────────────

async function submitDraft(draftId) {
  await editDraft(draftId);
  // Wait for Select2 and signature previews to settle before triggering submit
  setTimeout(() => {
    const submitBtn = document.getElementById("submitBtn");
    if (submitBtn) {
      submitBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      submitBtn.click();
    }
  }, 400);
}

// ─────────────────────────────────────────────────────────────────────────
// SUBMISSION ACTIONS
// ─────────────────────────────────────────────────────────────────────────

async function deleteSubmissionUI(id) {
  const confirmed = window.confirm(
    "Are you sure you want to delete this pending submission? This cannot be undone.",
  );
  if (!confirmed) return;
  try {
    await deleteSubmission(id);
    await refreshSubmissionsList();
    if (window.refreshNetworkBadge) window.refreshNetworkBadge();
  } catch (err) {
    console.error("[SUBMISSIONS] Delete error:", err);
    alert("Failed to delete submission.");
  }
}

async function editSubmissionUI(id) {
  try {
    const all = await getAllSubmissions();
    const sub = all.find((s) => s.id === id);
    if (!sub) {
      alert("Submission not found.");
      return;
    }

    const form = document.getElementById("mainForm");
    if (!form) return;

    // Populate form fields from stored formData
    for (const [key, val] of Object.entries(sub.formData || {})) {
      const values = Array.isArray(val) ? val : [val];
      const els = form.querySelectorAll(`[name="${key}"]`);
      if (!els.length) continue;
      const el = els[0];
      if (el.tagName === "SELECT" && el.multiple) {
        for (const opt of el.options) {
          opt.selected = values.includes(opt.value);
        }
        if (window.$ && window.$.fn.select2) {
          window.$(el).trigger("change");
        }
      } else if (el.type === "checkbox") {
        for (const e of els) {
          e.checked = values.includes(e.value);
        }
      } else if (el.type === "radio") {
        for (const e of els) {
          e.checked = e.value === String(val);
        }
      } else {
        el.value = Array.isArray(val) ? (val[0] ?? "") : (val ?? "");
      }
    }

    // Switch to the form tab
    const formTab = document.querySelector('[data-bs-target="#tabpane-form"]');
    if (formTab) formTab.click();

    // Scroll to top of form
    form.scrollIntoView({ behavior: "smooth", block: "start" });

    // Delete the outbox copy so re-submit creates a fresh one
    await deleteSubmission(id);
    await refreshSubmissionsList();
    if (window.refreshNetworkBadge) window.refreshNetworkBadge();
  } catch (err) {
    console.error("[SUBMISSIONS] Edit error:", err);
    alert("Failed to load submission for editing.");
  }
}

window.editDraft = editDraft;
window.deleteDraftUI = deleteDraftUI;
window.submitDraft = submitDraft;
window.refreshDraftsList = refreshDraftsList;
window.refreshSubmissionsList = refreshSubmissionsList;
window.deleteSubmissionUI = deleteSubmissionUI;
window.editSubmissionUI = editSubmissionUI;
