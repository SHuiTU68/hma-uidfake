/*
 * The page's logic, and its whole job.
 *
 * It does not parse a config, decide a rule or hold one: every read comes from
 * sync-tool (--status, --packages, --get-config) and every write goes back
 * through it (--set-config), so the page and the running policy cannot disagree
 * about which format a file is in. The tool is the one place that reads and
 * writes the config, and it validates before it writes. What is left here is the
 * shape of a phone screen over that.
 */

"use strict";

const MODULE_DIR = "/data/adb/modules/hma-uidfake";
const TOOL = MODULE_DIR + "/sync-tool";
const TMP = "/data/local/tmp/hma-uidfake-webui.json";

/* ---- talking to sync-tool ---- */

/* KernelSU runs module WebUI JS and gives it `ksu`. exec runs as root and hands
 * back stdout; older and newer builds disagree on whether that is a bare string
 * or an {errno, stdout, stderr} object, so both are taken. */
function hasRoot() {
  return typeof ksu !== "undefined" && ksu && typeof ksu.exec === "function";
}

function execRaw(command) {
  return new Promise((resolve, reject) => {
    if (!hasRoot()) {
      reject(new Error("this page needs the KernelSU manager: no ksu.exec"));
      return;
    }
    let done = false;
    const finish = (data) => {
      if (done) return;
      done = true;
      if (typeof data === "string") {
        resolve({ errno: 0, stdout: data, stderr: "" });
        return;
      }
      if (data && typeof data === "object") {
        const errno = typeof data.errno === "number" ? data.errno : 0;
        resolve({
          errno: errno,
          stdout: typeof data.stdout === "string" ? data.stdout : "",
          stderr: typeof data.stderr === "string" ? data.stderr : "",
        });
        return;
      }
      resolve({ errno: 0, stdout: String(data == null ? "" : data), stderr: "" });
    };
    try {
      const r = ksu.exec(command);
      if (r && typeof r.then === "function") r.then(finish, reject);
      else finish(r);
    } catch (e) {
      reject(e);
    }
  });
}

/* One sync-tool command whose stdout is one JSON document. A non-zero exit or a
 * body that does not parse is raised, never half-read. */
async function runJson(command) {
  const r = await execRaw(command);
  const text = (r.stdout || "").trim();
  if (r.errno !== 0 && !text) {
    throw new Error((r.stderr || "").trim() || "sync-tool exited " + r.errno);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("sync-tool did not answer with JSON: " + firstLine(text));
  }
  return parsed;
}

async function runOk(command) {
  const r = await execRaw(command);
  if (r.errno !== 0) {
    throw new Error((r.stderr || "").trim() || "sync-tool exited " + r.errno);
  }
  return r.stdout;
}

function firstLine(text) {
  const line = (text || "").split("\n")[0] || "";
  return line.length > 160 ? line.slice(0, 157) + "..." : line;
}

const api = {
  status: () => runJson(TOOL + " --status"),
  packages: () => runJson(TOOL + " --packages"),
  config: () => runJson(TOOL + " --get-config"),
  save: async (config) => {
    /* base64 keeps the document out of the shell's quoting: it is the one
     * alphabet that survives a pipe unchanged. */
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(config))));
    await runOk(
      "echo " + b64 + " | base64 -d > " + TMP + " && " + TOOL +
        " --set-config < " + TMP,
    );
  },
};

/* ---- what the page holds ---- */

const state = {
  status: null,
  packages: [],
  config: { version: 2, mode: "blacklist", hide_system: false, templates: {}, apps: {} },
  ready: false,
  editor: null, // {kind:"caller"|"template", key, entry}
};

/* ---- small helpers ---- */

function $(id) {
  return document.getElementById(id);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(message, kind) {
  const box = $("toast");
  box.textContent = message;
  box.className = "toast" + (kind ? " " + kind : "");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add("hidden"), 2600);
}

let busyCount = 0;
function busy(on) {
  busyCount += on ? 1 : -1;
  if (busyCount < 0) busyCount = 0;
  $("busy").classList.toggle("hidden", busyCount === 0);
}

/* Wrap a mutating action so every path gets the spinner and the toast. */
async function guard(label, fn) {
  busy(true);
  try {
    await fn();
  } catch (e) {
    toast(label + ": " + e.message, "bad");
  } finally {
    busy(false);
  }
}

/* ---- status ---- */

const KIND = { native: "native", hma: "hma", hmaoss: "hma-oss" };

function renderStatus() {
  const wrap = $("status-cards");
  wrap.replaceChildren();
  const st = state.status;
  if (!st) {
    wrap.append(el("div", "empty", "Loading…"));
    return;
  }

  const sourceLabel = st.source === "none" ? "none (module idle)" : st.source;
  const sourceCard = el("div", "card");
  sourceCard.append(el("div", "k", "Rule source"));
  const v = el("div", "v small", sourceLabel);
  sourceCard.append(v);
  if (st.source === "none") sourceCard.classList.add("warn");
  wrap.append(sourceCard);

  const pairs = el("div", "card");
  pairs.append(el("div", "k", "Pairs pushed"));
  pairs.append(el("div", "v", String(st.rules || 0)));
  wrap.append(pairs);

  const k = st.kernel;
  if (k) {
    const native = el("div", "card" + (k.native > 0 ? " ok" : ""));
    native.append(el("div", "k", "Hooked (native)"));
    native.append(el("div", "v", String(k.native)));
    wrap.append(native);

    const compat = el("div", "card");
    compat.append(el("div", "k", "Hooked (compat)"));
    compat.append(el("div", "v", String(k.compat)));
    wrap.append(compat);

    const apk = el(
      "div",
      "card" + (k.apk_failed > 0 ? " warn" : k.apk_inodes > 0 ? " ok" : ""),
    );
    apk.append(el("div", "k", "APK inodes"));
    apk.append(el("div", "v", String(k.apk_inodes)));
    if (k.apk_failed_total)
      apk.append(el("div", "meta", k.apk_failed_total + " failed total"));
    wrap.append(apk);

    const lsm = el("div", "card" + (k.lsm_state ? " ok" : " warn"));
    lsm.append(el("div", "k", "LSM setuid"));
    lsm.append(el("div", "v", k.lsm_state ? "on" : "off"));
    wrap.append(lsm);

    const arch = el("div", "card");
    arch.append(el("div", "k", "Kernel"));
    arch.append(
      el("div", "v small", `va_bits ${k.va_bits}, page ${1 << k.page_shift}`),
    );
    wrap.append(arch);

    if (k.last_error) {
      const err = el("div", "card bad");
      err.append(el("div", "k", "Last error"));
      err.append(el("div", "v small", String(k.last_error)));
      wrap.append(err);
    }
  } else {
    const note = el("div", "card warn");
    note.append(el("div", "k", "Kernel"));
    note.append(el("div", "v small", st.kernel_note || "unavailable"));
    wrap.append(note);
  }

  $("subtitle").textContent = k
    ? `${st.rules} pair(s) · source ${sourceLabel}`
    : `source ${sourceLabel}`;
}

/* ---- apps ---- */

function packageByName(name) {
  return state.packages.find((p) => p.name === name) || null;
}

function ruleCount() {
  return Object.keys(state.config.apps || {}).length;
}

function renderApps() {
  const list = $("app-list");
  list.replaceChildren();
  const search = $("app-search").value.trim().toLowerCase();
  const filter = $("app-filter").value;
  const apps = state.config.apps || {};

  let rows = state.packages;
  if (filter === "callers")
    rows = rows.filter((p) => Object.prototype.hasOwnProperty.call(apps, p.name));
  else if (filter === "user") rows = rows.filter((p) => !p.system);

  if (search)
    rows = rows.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        String(p.uid).includes(search),
    );

  $("apps-hint").textContent =
    `${rows.length} shown · ${rowCountLabel(ruleCount(), "rule")} · ` +
    `${rowCountLabel(state.packages.length, "app")}`;

  if (!rows.length) {
    list.append(el("li", "empty", "No packages match."));
    return;
  }

  for (const p of rows) {
    const li = el("li", "tappable");
    const name = el("div", "name");
    name.append(el("span", "pkg", p.name));
    name.append(el("span", "meta", "uid " + p.uid + (p.system ? " · system" : "")));
    li.append(name);

    if (Object.prototype.hasOwnProperty.call(apps, p.name))
      li.append(el("span", "badge on", "rule"));
    if (p.system) li.append(el("span", "badge sys", "system"));

    li.addEventListener("click", () => openCaller(p.name));
    list.append(li);
  }
}

function rowCountLabel(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

/* ---- templates ---- */

function renderTemplates() {
  const list = $("tpl-list");
  list.replaceChildren();
  const templates = state.config.templates || {};
  const names = Object.keys(templates).sort();

  if (!names.length) {
    list.append(el("li", "empty", "No templates yet."));
    return;
  }

  for (const name of names) {
    const members = Array.isArray(templates[name]) ? templates[name] : [];
    const li = el("li", "tappable");
    const box = el("div", "name");
    box.append(el("span", "pkg", name));
    box.append(el("span", "meta", rowCountLabel(members.length, "package")));
    li.append(box);
    li.append(el("span", "badge", "template"));
    li.addEventListener("click", () => openTemplate(name));
    list.append(li);
  }
}

/* ---- the editor ---- */

function isWhitelist(entry) {
  const mode = entry && entry.mode ? entry.mode : state.config.mode;
  return mode === "whitelist";
}

function entryHide(entry) {
  return entry && Array.isArray(entry.hide) ? entry.hide.slice() : [];
}

function entryTemplates(entry) {
  return entry && Array.isArray(entry.templates) ? entry.templates.slice() : [];
}

function openCaller(name) {
  const entry = (state.config.apps || {})[name];
  state.editor = {
    kind: "caller",
    key: name,
    entry: entry ? JSON.parse(JSON.stringify(entry)) : {},
  };
  renderEditor();
  $("editor").classList.remove("hidden");
}

function openTemplate(name) {
  const members = (state.config.templates || {})[name];
  state.editor = {
    kind: "template",
    key: name,
    entry: { hide: Array.isArray(members) ? members.slice() : [] },
  };
  renderEditor();
  $("editor").classList.remove("hidden");
}

function closeEditor() {
  state.editor = null;
  $("editor").classList.add("hidden");
}

function renderEditor() {
  const ed = state.editor;
  if (!ed) return;
  const list = $("editor-list");
  list.replaceChildren();

  const isCaller = ed.kind === "caller";
  $("editor-title").textContent = ed.key;

  /* The controls only exist for a caller; a template is a package list alone. */
  $("editor-all").parentElement.classList.toggle("hidden", !isCaller);
  $("editor-whitelist").parentElement.classList.toggle("hidden", !isCaller);
  $("editor-system").parentElement.classList.toggle("hidden", !isCaller);
  $("editor-remove").classList.toggle("hidden", !isCaller);
  $("editor-remove").textContent =
    isCaller && (state.config.apps || {})[ed.key] ? "Remove rule" : "Clear";

  if (isCaller) {
    $("editor-whitelist").checked = isWhitelist(ed.entry);
    $("editor-all").checked = ed.entry.hide_all === true;
    $("editor-system").checked =
      ed.entry.hide_system === undefined
        ? state.config.hide_system === true
        : ed.entry.hide_system === true;
  }

  const whitelist = isCaller && isWhitelist(ed.entry);
  $("editor-hint").textContent = !isCaller
    ? "The packages this template hides for every caller that applies it."
    : whitelist
      ? "Whitelist: checked packages stay visible; everything else is hidden."
      : "Blacklist: checked packages are hidden from this caller.";

  const search = $("editor-search").value.trim().toLowerCase();
  const hide = new Set(entryHide(ed.entry));
  const applied = new Set(isCaller ? entryTemplates(ed.entry) : []);
  /* Every package, plus — for a caller — the templates, so both halves of a
   * rule are editable in one place. */
  const rows = [...state.packages];

  if (search && !isCaller) {
    /* Templates have no rows of their own below; filter the package list. */
  }

  if (search)
    rows.length = 0,
      state.packages.forEach((p) => {
        if (p.name.toLowerCase().includes(search) || String(p.uid).includes(search))
          rows.push(p);
      });

  if (isCaller && !search) {
    const tplNames = Object.keys(state.config.templates || {}).sort();
    for (const t of tplNames) {
      const li = el("li");
      const box = el("div", "name");
      box.append(el("span", "pkg", t));
      box.append(el("span", "meta", "template"));
      li.append(box);
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.style.width = "18px";
      chk.style.height = "18px";
      chk.style.accentColor = "var(--accent)";
      chk.checked = applied.has(t);
      chk.addEventListener("change", () => {
        if (chk.checked) applied.add(t);
        else applied.delete(t);
        ed.entry.templates = [...applied];
      });
      li.append(chk);
      list.append(li);
    }
  }

  for (const p of rows) {
    const li = el("li");
    const box = el("div", "name");
    box.append(el("span", "pkg", p.name));
    box.append(el("span", "meta", "uid " + p.uid + (p.system ? " · system" : "")));
    li.append(box);
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.style.width = "18px";
    chk.style.height = "18px";
    chk.style.accentColor = "var(--accent)";
    chk.checked = hide.has(p.name);
    chk.addEventListener("change", () => {
      if (chk.checked) hide.add(p.name);
      else hide.delete(p.name);
      ed.entry.hide = [...hide];
    });
    li.append(chk);
    list.append(li);
  }

  if (!list.children.length)
    list.append(el("li", "empty", "No packages match."));
}

function saveEditor() {
  const ed = state.editor;
  if (!ed) return;
  const hide = entryHide(ed.entry);

  if (ed.kind === "template") {
    state.config.templates = state.config.templates || {};
    const name = ed.key;
    const members = ed.entry.hide || [];
    if (!members.length) delete state.config.templates[name];
    else state.config.templates[name] = members;
    return persist("Template saved");
  }

  const apps = state.config.apps || (state.config.apps = {});
  const entry = {};
  const whitelist = $("editor-whitelist").checked;
  const hideAll = $("editor-all").checked;
  const system = $("editor-system").checked;

  if (whitelist !== (state.config.mode === "whitelist"))
    entry.mode = whitelist ? "whitelist" : "blacklist";
  if (hideAll) entry.hide_all = true;
  if (system !== (state.config.hide_system === true)) entry.hide_system = system;
  const templates = entryTemplates(ed.entry);
  if (templates.length) entry.templates = templates;
  if (hide.length) entry.hide = hide;

  /* An entry that says nothing is the same as no entry: it is dropped, so the
   * config does not grow a rule per package that was looked at. */
  if (Object.keys(entry).length === 0) delete apps[ed.key];
  else apps[ed.key] = entry;

  persist("Rule saved");
}

function removeEditor() {
  const ed = state.editor;
  if (!ed || ed.kind !== "caller") {
    closeEditor();
    return;
  }
  if (state.config.apps) delete state.config.apps[ed.key];
  persist("Rule removed");
}

async function persist(message) {
  closeEditor();
  await guard("Save failed", async () => {
    await api.save(state.config);
    await loadAll(false);
    toast(message, "ok");
  });
}

/* ---- raw editor ---- */

function renderRaw() {
  $("raw-path").textContent = (state.status && state.status.config) || "";
  const present = state.status && state.status.config_present;
  $("raw-json").value = JSON.stringify(state.config, null, 2);
  $("raw-json").dataset.present = present ? "1" : "";
}

async function applyRaw() {
  let parsed;
  try {
    parsed = JSON.parse($("raw-json").value);
  } catch (e) {
    toast("Not valid JSON: " + e.message, "bad");
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    toast("The config has to be a JSON object", "bad");
    return;
  }
  await guard("Save failed", async () => {
    await api.save(parsed);
    await loadAll(false);
    toast("Config applied", "ok");
  });
}

/* ---- loading ---- */

function normalizeConfig(answer) {
  let config = answer && answer.config ? answer.config : {};
  if (typeof config !== "object" || Array.isArray(config)) config = {};
  if (!config.version) config.version = 2;
  if (!config.mode) config.mode = "blacklist";
  if (!config.apps || typeof config.apps !== "object") config.apps = {};
  if (!config.templates || typeof config.templates !== "object")
    config.templates = {};
  return config;
}

async function loadAll(withPackages) {
  const [status, config] = await Promise.all([api.status(), api.config()]);
  state.status = status;
  state.config = normalizeConfig(config);
  if (withPackages || !state.packages.length) {
    const packs = await api.packages();
    state.packages = (packs && packs.packages) || [];
    state.packages.sort((a, b) => a.name.localeCompare(b.name));
  }
  state.ready = true;
  renderStatus();
  renderApps();
  renderTemplates();
  renderRaw();
}

/* ---- wiring ---- */

function switchTab(name) {
  for (const tab of document.querySelectorAll(".tab"))
    tab.classList.toggle("active", tab.dataset.tab === name);
  for (const panel of document.querySelectorAll(".panel"))
    panel.classList.toggle("active", panel.id === "tab-" + name);
}

function init() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  $("refresh").addEventListener("click", () =>
    guard("Refresh failed", () => loadAll(true)),
  );
  $("sync-now").addEventListener("click", () =>
    guard("Sync failed", async () => {
      await loadAll(false);
      toast("Re-synced", "ok");
    }),
  );

  $("app-search").addEventListener("input", renderApps);
  $("app-filter").addEventListener("change", renderApps);

  $("tpl-add").addEventListener("click", () => {
    const name = $("tpl-name").value.trim();
    if (!name) return;
    state.config.templates = state.config.templates || {};
    if (state.config.templates[name]) {
      toast("That template already exists", "bad");
      return;
    }
    state.config.templates[name] = [];
    $("tpl-name").value = "";
    openTemplate(name);
  });

  $("raw-load").addEventListener("click", () =>
    guard("Reload failed", async () => {
      await loadAll(false);
      toast("Reloaded from file", "ok");
    }),
  );
  $("raw-apply").addEventListener("click", applyRaw);

  $("editor-close").addEventListener("click", closeEditor);
  $("editor-save").addEventListener("click", saveEditor);
  $("editor-remove").addEventListener("click", removeEditor);
  $("editor-search").addEventListener("input", renderEditor);
  $("editor").addEventListener("click", (e) => {
    if (e.target === $("editor")) closeEditor();
  });

  if (!hasRoot()) {
    toast("Open this page from the KernelSU manager", "bad");
    $("status-cards").replaceChildren(
      el("div", "card bad", "This page needs the KernelSU manager (ksu) to run sync-tool."),
    );
    return;
  }

  guard("Load failed", () => loadAll(true));
}

document.addEventListener("DOMContentLoaded", init);
