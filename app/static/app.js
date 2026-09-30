"use strict";

// --------------------------------------------------------------------------- //
// 状态
// --------------------------------------------------------------------------- //
const state = {
  clauses: [], // { id, original, body(内部形态 [[c3]]) }
  orderIds: [],
  editingId: null,
  preview: null, // 服务端 /api/preview 返回
  dragId: null,
  mergeMode: false,
  mergePicks: [], // 合并模式下已选条款 id（最多两条）
};

const MARKER = /\[\[(?:原(\d+)\?|(\d+))\]\]/g; // 预览文本中的引用形态

const $ = (sel) => document.querySelector(sel);

const importPanel = $("#import-panel");
const desk = $("#desk");
const importText = $("#import-text");
const importErrors = $("#import-errors");
const clauseList = $("#clause-list");
const previewText = $("#preview-text");
const brokenBanner = $("#broken-banner");
const downloadBtn = $("#download-btn");
const statCount = $("#stat-count");
const statBroken = $("#stat-broken");
const mergeBtn = $("#merge-btn");
const mergeBanner = $("#merge-banner");
const mergeHint = $("#merge-hint");
const mergeConfirmBtn = $("#merge-confirm-btn");
const mergeCancelBtn = $("#merge-cancel-btn");

// --------------------------------------------------------------------------- //
// 工具
// --------------------------------------------------------------------------- //
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error("api error");
    err.status = res.status;
    err.errors = (data.detail && data.detail.errors) || ["请求失败"];
    throw err;
  }
  return data;
}

function snapshot() {
  return {
    order_ids: state.orderIds,
    clauses: state.clauses.map((c) => ({ id: c.id, body: c.body })),
  };
}

// --------------------------------------------------------------------------- //
// 导入
// --------------------------------------------------------------------------- //
const SAMPLE = [
  "1|甲方应在合同签订后七日内交付设备。",
  "2|乙方按第 [[1]] 条验收合格后三十日内付款。",
  "3|设备规格与数量见附件，不符合的按 [[1]] 退换。",
  "4|因本合同产生的争议，按 [[5]] 处理。",
  "5|争议提交甲方所在地仲裁委员会仲裁。",
].join("\n");

$("#sample-btn").addEventListener("click", () => {
  importText.value = SAMPLE;
  importErrors.hidden = true;
});

$("#import-btn").addEventListener("click", async () => {
  try {
    const data = await api("/api/import", { text: importText.value });
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: c.original,
      body: c.body,
    }));
    state.orderIds = state.clauses.map((c) => c.id);
    state.editingId = null;
    importErrors.hidden = true;
    importPanel.hidden = true;
    desk.hidden = false;
    render();
  } catch (e) {
    importErrors.innerHTML = e.errors.map((m) => `<li>${esc(m)}</li>`).join("");
    importErrors.hidden = false;
  }
});

$("#reimport-btn").addEventListener("click", () => {
  if (!confirm("重新导入将丢弃当前草稿，确定继续？")) return;
  state.clauses = [];
  state.orderIds = [];
  state.editingId = null;
  state.preview = null;
  state.mergeMode = false;
  state.mergePicks = [];
  desk.hidden = true;
  importPanel.hidden = false;
});

// --------------------------------------------------------------------------- //
// 渲染（数据全部以服务端 /api/preview 为准）
// --------------------------------------------------------------------------- //
async function render() {
  let data;
  try {
    data = await api("/api/preview", snapshot());
  } catch (e) {
    alert("预览刷新失败：\n" + e.errors.join("\n"));
    return;
  }
  state.preview = data;

  clauseList.textContent = "";
  let brokenTotal = 0;
  const brokenLines = [];

  for (const item of data.items) {
    brokenTotal += item.broken.length;
    if (item.broken.length) {
      const marks = item.broken.map((b) => `[[原${b.original}?]]`).join("、");
      brokenLines.push(
        `<li>第 ${item.display} 条（导入时原第 ${item.original} 条）中的 ${esc(marks)} 已失去目标（原条款已删除）</li>`,
      );
    }

    const li = document.createElement("li");
    li.className = "card" + (item.broken.length ? " source-broken" : "");
    li.id = `card-${item.id}`;
    li.dataset.id = item.id;

    const isEditing = state.editingId === item.id;
    const isPicked = state.mergePicks.includes(item.id);
    if (isPicked) li.classList.add("picked");
    const busy = state.editingId || state.mergeMode;
    li.innerHTML = `
      <div class="card-head">
        ${
          state.mergeMode
            ? `<input type="checkbox" class="merge-check" data-action="pick" ${
                isPicked ? "checked" : ""
              } ${state.mergePicks.length >= 2 && !isPicked ? "disabled" : ""} aria-label="选择本条用于合并" />`
            : '<span class="grip" title="拖拽调整顺序">⠿</span>'
        }
        <span class="num">${item.display}</span>
        <span class="orig">（原第 ${item.original} 条）</span>
        ${item.broken.length ? '<span class="warn-tag">含失效引用</span>' : ""}
        <span class="card-actions">
          ${
            isEditing || state.mergeMode
              ? ""
              : `<button data-action="up" ${
                  item.display === 1 || busy ? "disabled" : ""
                }>↑</button>
                 <button data-action="down" ${
                   item.display === data.items.length || busy ? "disabled" : ""
                 }>↓</button>
                 <button data-action="edit" ${busy ? "disabled" : ""}>编辑正文</button>
                 <button data-action="delete" class="danger" ${
                   busy ? "disabled" : ""
                 }>删除</button>`
          }
        </span>
      </div>
      ${isEditing ? editorHtml(item) : `<div class="card-body">${bodyHtml(item)}</div>`}
    `;
    clauseList.appendChild(li);
  }

  // 顶部状态
  statCount.textContent = `共 ${data.items.length} 条`;
  statBroken.hidden = brokenTotal === 0;
  statBroken.textContent = `${brokenTotal} 处失效引用`;
  downloadBtn.disabled = data.has_broken;
  syncMergeUi(data.items.length);

  // 失效引用横幅
  if (brokenLines.length) {
    brokenBanner.hidden = false;
    brokenBanner.innerHTML =
      `<strong>存在失效引用，修复前禁止下载。</strong>请编辑下列条款，把失效标记改为有效的 [[当前编号]]，或删除该标记：<ul>${brokenLines.join(
        "",
      )}</ul>`;
  } else {
    brokenBanner.hidden = true;
    brokenBanner.textContent = "";
  }

  // 纯文本预览：直接用服务端解析出的 text 拼装，与 /api/export 完全同一逻辑
  const plain = data.items.map((it) => `${it.display}|${it.text}`).join("\n");
  previewText.textContent = plain;
  previewText.classList.toggle("blocked", data.has_broken);

  attachDnd();
}

// 预览正文：把 [[n]] 渲染为可点击引用、[[原X?]] 渲染为失效标记
function bodyHtml(item) {
  let html = "";
  let last = 0;
  for (const m of item.text.matchAll(MARKER)) {
    html += esc(item.text.slice(last, m.index));
    if (m[1] !== undefined) {
      html += `<span class="ref dead" title="失效引用：原第 ${m[1]} 条已删除，请编辑本条修复">[[原${m[1]}?]]</span>`;
    } else {
      const target = state.orderIds[parseInt(m[2], 10) - 1];
      html += `<button type="button" class="ref" data-goto="${esc(target)}">[[${m[2]}]]</button>`;
    }
    last = m.index + m[0].length;
  }
  html += esc(item.text.slice(last));
  return html;
}

function editorHtml(item) {
  return `
    <div class="editor">
      <textarea data-role="edit-text">${esc(item.text)}</textarea>
      <div class="editor-actions">
        <button data-action="save" class="primary">保存</button>
        <button data-action="cancel">取消</button>
        <span class="edit-hint">
          单行条款（回车不换行）；[[数字]] 按保存当刻的显示编号绑定；${
            item.broken.length ? "<b>请先修复 [[原X?]] 标记</b>，否则无法保存；" : ""
          }Ctrl+Enter 快速保存
        </span>
      </div>
      <ul class="edit-errors" data-role="edit-errors" hidden></ul>
    </div>`;
}

// --------------------------------------------------------------------------- //
// 列表交互（事件委托）
// --------------------------------------------------------------------------- //
clauseList.addEventListener("click", async (ev) => {
  const goto = ev.target.closest("[data-goto]");
  if (goto) {
    const card = document.getElementById(`card-${goto.dataset.goto}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
    }
    return;
  }

  const btn = ev.target.closest("[data-action]");
  const card = btn ? btn.closest(".card") : ev.target.closest(".card");
  const id = card ? card.dataset.id : null;
  const action = btn ? btn.dataset.action : null;

  // 合并模式：只允许选条款；引用跳转已在上面处理，重排/编辑/删除全部停用
  if (state.mergeMode) {
    if (["up", "down", "edit", "delete"].includes(action)) return;
    if (id) toggleMergePick(id);
    return;
  }

  if (["up", "down", "edit", "delete"].includes(action) && state.editingId) return;

  if (action === "up" || action === "down") {
    const idx = state.orderIds.indexOf(id);
    const j = action === "up" ? idx - 1 : idx + 1;
    if (j < 0 || j >= state.orderIds.length) return;
    [state.orderIds[idx], state.orderIds[j]] = [state.orderIds[j], state.orderIds[idx]];
    render();
  } else if (action === "edit") {
    state.editingId = id;
    render().then(() => {
      const ta = clauseList.querySelector(`#card-${id} textarea`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.addEventListener("keydown", onEditorKey);
      }
    });
  } else if (action === "delete") {
    const inbound = state.clauses.filter(
      (c) => c.id !== id && c.body.includes(`[[${id}]]`),
    ).length;
    const msg =
      `确定删除该条款？\n` +
      (inbound ? `有 ${inbound} 条条款引用它，删除后这些引用将标为失效，修复前无法下载。\n` : "") +
      `（编号会自动重排，此操作在重新导入或刷新前不可撤销）`;
    if (!confirm(msg)) return;
    state.orderIds = state.orderIds.filter((x) => x !== id);
    state.clauses = state.clauses.filter((c) => c.id !== id);
    render();
  } else if (action === "cancel") {
    state.editingId = null;
    render();
  } else if (action === "save") {
    await saveEdit(id);
  }
});

function onEditorKey(ev) {
  if (ev.key === "Enter" && !ev.shiftKey) {
    // 只处理单行条款：Enter 不插入换行；Ctrl/⌘+Enter 保存
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) saveEdit(state.editingId);
  }
}

async function saveEdit(id) {
  const card = document.getElementById(`card-${id}`);
  const text = card.querySelector("textarea").value;
  const errBox = card.querySelector('[data-role="edit-errors"]');
  try {
    const data = await api("/api/save", { ...snapshot(), edit_id: id, text });
    const clause = state.clauses.find((c) => c.id === id);
    clause.body = data.body;
    state.editingId = null;
    render();
  } catch (e) {
    errBox.innerHTML = e.errors.map((m) => `<li>${esc(m)}</li>`).join("");
    errBox.hidden = false;
  }
}

// --------------------------------------------------------------------------- //
// 合并两条条款
// --------------------------------------------------------------------------- //
function syncMergeUi(total) {
  mergeBtn.disabled = Boolean(state.editingId) || total < 2;
  mergeBanner.hidden = !state.mergeMode;
  if (!state.mergeMode) return;
  const n = state.mergePicks.length;
  const pos = (cid) => state.orderIds.indexOf(cid) + 1;
  mergeHint.textContent =
    n === 0
      ? "请点选两条要合并的条款（按当前显示顺序，用全角分号“；”连接正文）。"
      : n === 1
        ? `已选第 ${pos(state.mergePicks[0])} 条，再选一条。`
        : `已选第 ${pos(state.mergePicks[0])} 条与第 ${pos(state.mergePicks[1])} 条：前者保留位置与身份，后者并入后移除。`;
  mergeConfirmBtn.disabled = n !== 2;
}

function toggleMergePick(id) {
  const i = state.mergePicks.indexOf(id);
  if (i >= 0) {
    state.mergePicks.splice(i, 1);
  } else {
    if (state.mergePicks.length >= 2) return; // 最多两条
    state.mergePicks.push(id);
  }
  render();
}

function exitMergeMode() {
  state.mergeMode = false;
  state.mergePicks = [];
  render();
}

mergeBtn.addEventListener("click", () => {
  if (state.editingId || state.clauses.length < 2) return;
  state.mergeMode = true;
  state.mergePicks = [];
  render();
});
mergeCancelBtn.addEventListener("click", exitMergeMode);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.mergeMode && !state.editingId) exitMergeMode();
});

mergeConfirmBtn.addEventListener("click", async () => {
  if (state.mergePicks.length !== 2) return;
  const pos = (cid) => state.orderIds.indexOf(cid) + 1;
  const [a, b] = state.mergePicks;
  const first = pos(a) < pos(b) ? a : b;
  const second = pos(a) < pos(b) ? b : a;
  const ok = confirm(
    `将把第 ${pos(second)} 条并入第 ${pos(first)} 条：\n` +
      `· 正文按显示顺序用全角分号“；”连接，沿用第 ${pos(first)} 条的位置与身份；\n` +
      `· 第 ${pos(second)} 条移除，其余条款顺序不变；\n` +
      `· 所有原指向第 ${pos(second)} 条的引用（含这两条正文内的）改指合并结果；其他引用与已失效引用不变。\n\n` +
      `此操作在重新导入或刷新前不可撤销，确定合并？`,
  );
  if (!ok) return;

  let data;
  try {
    data = await api("/api/merge", { ...snapshot(), pick_ids: [first, second] });
  } catch (e) {
    // 操作失败：草稿保持不变，仅提示
    alert("合并失败，草稿未改动：\n" + e.errors.join("\n"));
    return;
  }
  // 成功后原子替换为服务端返回的同一份草稿，列表/预览/下载状态立即一致
  state.orderIds = data.order_ids;
  state.clauses = data.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  state.mergeMode = false;
  state.mergePicks = [];
  state.editingId = null;
  await render();
  const card = document.getElementById(`card-${data.merged_id}`);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
  }
});

// --------------------------------------------------------------------------- //
// 拖拽重排
// --------------------------------------------------------------------------- //
function attachDnd() {
  if (state.mergeMode) return; // 合并模式不渲染 grip，也不允许拖拽
  for (const card of clauseList.querySelectorAll(".card")) {
    const grip = card.querySelector(".grip");
    if (!grip) continue;
    grip.addEventListener("mousedown", () => {
      if (!state.editingId) card.draggable = true;
    });
    card.addEventListener("mouseup", () => (card.draggable = false));

    card.addEventListener("dragstart", (ev) => {
      if (state.editingId) {
        ev.preventDefault();
        return;
      }
      state.dragId = card.dataset.id;
      card.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.draggable = false;
      card.classList.remove("dragging");
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      state.dragId = null;
    });
    card.addEventListener("dragover", (ev) => {
      if (!state.dragId || state.dragId === card.dataset.id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      card.classList.add("drag-over");
    });
    card.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const targetId = card.dataset.id;
      if (!state.dragId || state.dragId === targetId) return;
      const rect = card.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      moveClause(state.dragId, targetId, after);
    });
  }
}

function moveClause(srcId, targetId, after) {
  const ids = state.orderIds.filter((x) => x !== srcId);
  let idx = ids.indexOf(targetId);
  if (after) idx += 1;
  ids.splice(idx, 0, srcId);
  state.orderIds = ids;
  render();
}

// --------------------------------------------------------------------------- //
// 下载（以服务端 /api/export 为准，保证与预览一致）
// --------------------------------------------------------------------------- //
downloadBtn.addEventListener("click", async () => {
  try {
    const data = await api("/api/export", snapshot());
    const blob = new Blob([data.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    a.href = url;
    a.download = `clauses-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(e.errors.join("\n"));
  }
});
