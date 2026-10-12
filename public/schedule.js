/* Scheduling UI: chunked upload, the schedule form, and the queue.
   Kept separate from app.js so the dashboard and the publisher stay independent. */

(function () {
  "use strict";

  var KEY_STORE = "spd-dash-key";
  // Netlify caps a function request body near 6MB. 4MB leaves room for headers
  // without flirting with the limit.
  var CHUNK = 4 * 1024 * 1024;

  var state = { file: null, mediaId: null, uploading: false, items: [] };

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function headers() {
    var k = localStorage.getItem(KEY_STORE);
    return k ? { "x-dash-key": k } : {};
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function mb(n) { return (n / 1048576).toFixed(1) + " MB"; }
  function when(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  // ------------------------------------------------------------- upload
  function setProgress(pct, label) {
    var dz = $("#dropzone");
    $(".dz-idle", dz).hidden = true;
    $(".dz-progress", dz).hidden = false;
    $(".dz-fill", dz).style.width = pct + "%";
    $(".dz-label", dz).textContent = label;
  }

  function resetDropzone(msg) {
    var dz = $("#dropzone");
    dz.classList.remove("has-file");
    $(".dz-progress", dz).hidden = true;
    $(".dz-idle", dz).hidden = false;
    if (msg) $(".dz-idle strong", dz).textContent = msg;
    state.file = null;
    state.mediaId = null;
    syncButton();
  }

  function upload(file) {
    if (state.uploading) return Promise.resolve();
    state.uploading = true;
    state.mediaId = null;
    syncButton();

    var uploadId = null;
    var total = Math.ceil(file.size / CHUNK);

    setProgress(0, "Starting " + file.name);

    return fetch("/api/upload?action=init", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, headers()),
      body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type || "video/mp4" })
    })
      .then(function (res) {
        return res.json().then(function (b) {
          if (!res.ok) throw new Error(b.error || "upload init failed");
          uploadId = b.uploadId;
        });
      })
      .then(function () {
        var chain = Promise.resolve();
        var _loop = function (i) {
          chain = chain.then(function () {
            var slice = file.slice(i * CHUNK, Math.min((i + 1) * CHUNK, file.size));
            return fetch("/api/upload?action=chunk&uploadId=" + uploadId + "&index=" + i, {
              method: "POST",
              headers: Object.assign({ "content-type": "application/octet-stream" }, headers()),
              body: slice
            }).then(function (res) {
              if (!res.ok) {
                return res.json().catch(function () { return {}; }).then(function (e) {
                  throw new Error(e.error || ("chunk " + i + " failed"));
                });
              }
              setProgress(Math.round(((i + 1) / total) * 92), "Uploading " + (i + 1) + " / " + total + " chunks");
            });
          });
        };
        for (var i = 0; i < total; i++) _loop(i);
        return chain;
      })
      .then(function () {
        setProgress(96, "Assembling");
        return fetch("/api/upload?action=finalize", {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, headers()),
          body: JSON.stringify({ uploadId: uploadId, chunks: total })
        });
      })
      .then(function (res) {
        return res.json().then(function (b) {
          if (!res.ok) throw new Error(b.error || "finalize failed");
          state.mediaId = b.mediaId;
          setProgress(100, "Ready · " + file.name + " · " + mb(b.bytes));
          $("#dropzone").classList.add("has-file");
        });
      })
      .catch(function (err) {
        resetDropzone("Upload failed");
        $("#scheduleMsg").textContent = err.message;
      })
      .then(function () {
        state.uploading = false;
        syncButton();
      });
  }

  function syncButton() {
    var btn = $("#scheduleBtn");
    if (!btn) return;
    btn.disabled = state.uploading || !state.mediaId || !$("#fWhen").value;
  }

  // ------------------------------------------------------------- queue
  function statusPill(s) {
    return '<span class="status-pill st-' + esc(s) + '">' + esc(s) + "</span>";
  }

  function platformCell(item, key) {
    var r = item.results[key];
    if (!item.targets[key] && r.status === "pending") return '<span class="dim">—</span>';
    if (r.status === "published") {
      return r.permalink
        ? '<a href="' + esc(r.permalink) + '" target="_blank" rel="noopener" style="color:#0ca30c">sent</a>'
        : '<span style="color:#0ca30c">sent</span>';
    }
    if (r.status === "failed") {
      return '<span style="color:#b33a3a">failed</span><span class="err-text">' + esc(r.error || "") + "</span>";
    }
    return '<span class="dim">queued</span>';
  }

  function renderQueue() {
    var host = $("#queueTable");
    if (!host) return;
    if (!state.items.length) {
      host.innerHTML = '<div class="empty">Nothing scheduled yet</div>';
      return;
    }
    var rows = state.items.slice().sort(function (a, b) {
      return String(b.scheduledAt).localeCompare(String(a.scheduledAt));
    });
    host.innerHTML =
      "<table><thead><tr>" +
      "<th>Publish at</th><th>Caption</th><th>Status</th><th>Instagram</th><th>YouTube</th><th>Size</th><th></th>" +
      "</tr></thead><tbody>" +
      rows.map(function (it) {
        var cancellable = it.status === "scheduled" || it.status === "failed";
        var removable = it.status === "published" || it.status === "cancelled" || it.status === "failed";
        return "<tr>" +
          "<td>" + esc(when(it.scheduledAt)) + "</td>" +
          '<td class="title-cell">' + esc(String(it.caption || it.filename || "").slice(0, 90)) + "</td>" +
          "<td>" + statusPill(it.status) + (it.attempts > 1 ? ' <span class="dim">x' + it.attempts + "</span>" : "") + "</td>" +
          "<td>" + platformCell(it, "instagram") + "</td>" +
          "<td>" + platformCell(it, "youtube") + "</td>" +
          "<td>" + (it.sizeBytes ? esc(mb(it.sizeBytes)) : '<span class="dim">—</span>') + "</td>" +
          "<td>" + (cancellable ? '<button class="chip" data-cancel="' + esc(it.id) + '">Cancel</button> ' : "") +
            (removable ? '<button class="chip" data-purge="' + esc(it.id) + '">Remove</button>' : "") + "</td>" +
          "</tr>";
      }).join("") +
      "</tbody></table>";

    $$("[data-cancel]", host).forEach(function (b) {
      b.addEventListener("click", function () { cancel(b.getAttribute("data-cancel")); });
    });
    $$("[data-purge]", host).forEach(function (b) {
      b.addEventListener("click", function () { purge(b.getAttribute("data-purge")); });
    });
  }

  function loadQueue() {
    return fetch("/api/schedule", { headers: headers() })
      .then(function (res) { return res.ok ? res.json() : { items: [] }; })
      .then(function (body) {
        state.items = body.items || [];
        renderQueue();
      })
      .catch(function () { /* the queue is not critical to the rest of the page */ });
  }

  function purge(id) {
    // Only clears the row here. Anything already posted stays posted.
    if (!window.confirm("Remove this from the list? Anything already published stays live.")) return;
    fetch("/api/schedule?purge=1&id=" + encodeURIComponent(id), { method: "DELETE", headers: headers() })
      .then(loadQueue);
  }

  function cancel(id) {
    if (!window.confirm("Cancel this scheduled post?")) return;
    fetch("/api/schedule?id=" + encodeURIComponent(id), { method: "DELETE", headers: headers() })
      .then(loadQueue);
  }

  // ------------------------------------------------------------- wiring
  function init() {
    var dz = $("#dropzone");
    if (!dz) return;
    var input = $("#fileInput");

    dz.addEventListener("click", function () { if (!state.uploading) input.click(); });
    input.addEventListener("change", function () {
      if (input.files && input.files[0]) { state.file = input.files[0]; upload(input.files[0]); }
    });
    ["dragenter", "dragover"].forEach(function (e) {
      dz.addEventListener(e, function (ev) { ev.preventDefault(); dz.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (e) {
      dz.addEventListener(e, function (ev) { ev.preventDefault(); dz.classList.remove("is-over"); });
    });
    dz.addEventListener("drop", function (ev) {
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f && !state.uploading) { state.file = f; upload(f); }
    });

    $("#fWhen").addEventListener("input", syncButton);

    $("#scheduleBtn").addEventListener("click", function () {
      var local = $("#fWhen").value;
      if (!local || !state.mediaId) return;
      $("#scheduleBtn").disabled = true;
      $("#scheduleMsg").textContent = "Scheduling";
      // datetime-local carries no zone; the browser reads it as local time,
      // which is what was meant. Stored as UTC.
      var iso = new Date(local).toISOString();
      fetch("/api/schedule", {
        method: "POST",
        headers: Object.assign({ "content-type": "application/json" }, headers()),
        body: JSON.stringify({
          mediaId: state.mediaId,
          filename: state.file ? state.file.name : null,
          caption: $("#fCaption").value,
          title: $("#fTitle").value,
          scheduledAt: iso,
          targets: { instagram: $("#fIg").checked, youtube: $("#fYt").checked }
        })
      })
        .then(function (res) {
          return res.json().then(function (b) {
            if (!res.ok) throw new Error(b.error || "could not schedule");
            $("#scheduleMsg").textContent = "Scheduled for " + when(iso);
            $("#fCaption").value = "";
            $("#fTitle").value = "";
            $("#fWhen").value = "";
            resetDropzone("Drop an MP4 here");
            return loadQueue();
          });
        })
        .catch(function (err) { $("#scheduleMsg").textContent = err.message; })
        .then(syncButton);
    });

    $("#queueRefresh").addEventListener("click", loadQueue);

    var note = $("#scheduleNote");
    if (note) {
      note.textContent =
        "The video is stored here and served at a public URL, because Instagram publishes by " +
        "fetching a URL rather than accepting an upload. Anyone with that link can read the file, " +
        "so treat it as public from the moment you upload. Reels want MP4, vertical, under 90 " +
        "seconds; Instagram rejects anything outside its spec at publish time, and the reason " +
        "shows up in the queue.";
    }

    loadQueue();
    document.addEventListener("spd:tab", function (ev) {
      if (ev.detail === "schedule") loadQueue();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
