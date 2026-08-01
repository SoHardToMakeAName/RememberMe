// web/app.js — RememberMe 网页版前端
// v0.15.0: 移除人格 UI。系统根据用户反馈自动调整人设。

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send");
const statusEl = $("#status");
const metaEl = $("#meta-content");
const composerEl = $("#composer");
const modelDisplayEl = $("#model-display");
const sessionListEl = $("#session-list");
const sessionNewBtn = $("#session-new");

let busy = false;
let currentSessionId = null;

function setStatus(text) { statusEl.textContent = text; }

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(200, inputEl.scrollHeight) + "px";
}

inputEl.addEventListener("input", autoGrow);

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composerEl.requestSubmit();
  }
});

function addMessage(role, text) {
  const empty = messagesEl.querySelector(".message.empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "message " + role;
  if (text) div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendTo(el, text) {
  if (el.textContent) el.textContent += text;
  else el.textContent = text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setMeta(text) { metaEl.textContent = text; }

// === Session 列表 ===
function renderSessions(sessions, currentId) {
  currentSessionId = currentId;
  sessionListEl.innerHTML = "";
  if (!sessions || sessions.length === 0) {
    const li = document.createElement("li");
    li.className = "session-empty";
    li.textContent = "暂无对话";
    sessionListEl.appendChild(li);
    return;
  }
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "session-item";
    if (s.id === currentId) li.classList.add("current");
    li.dataset.id = s.id;

    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = s.title || "(新对话)";

    const meta = document.createElement("div");
    meta.className = "session-meta";
    const count = document.createElement("span");
    count.textContent = s.messageCount + " 条";
    meta.appendChild(count);

    const del = document.createElement("button");
    del.className = "session-delete";
    del.textContent = "×";
    del.title = "删除对话";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSessionById(s.id, s.title || "(新对话)");
    });

    li.appendChild(title);
    li.appendChild(meta);
    li.appendChild(del);
    li.addEventListener("click", () => loadSessionById(s.id));
    sessionListEl.appendChild(li);
  }
}

async function loadSessions() {
  try {
    const resp = await fetch("/api/sessions");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    renderSessions(data.sessions, data.currentSessionId);
  } catch (e) {
    sessionListEl.innerHTML = '<li class="session-empty">加载失败</li>';
    console.error("loadSessions failed", e);
  }
}

async function loadSessionById(id) {
  if (id === currentSessionId) return;
  try {
    setStatus("加载对话…");
    const resp = await fetch("/api/session/load/" + encodeURIComponent(id), {
      method: "POST",
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    currentSessionId = data.sessionId;
    await Promise.all([loadSessions(), reloadMessages()]);
    setStatus("已加载对话");
    if (data.needsInit) {
      await promptPersonaInit(data.sessionId);
    }
  } catch (e) {
    setStatus("加载失败: " + e.message);
  }
}

sessionNewBtn.addEventListener("click", async () => {
  try {
    setStatus("新建对话…");
    const resp = await fetch("/api/session/new", { method: "POST" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    currentSessionId = data.sessionId;
    await Promise.all([loadSessions(), reloadMessages()]);
    setStatus("已开始新对话");
    if (data.needsInit) {
      await promptPersonaInit(data.sessionId);
    }
  } catch (e) {
    setStatus("新建失败: " + e.message);
  }
});

async function deleteSessionById(id, title) {
  const label = title ? `「${title}」` : "此对话";
  if (!confirm(`确定删除${label}？此操作不可撤销。`)) return;
  try {
    const resp = await fetch("/api/session/" + encodeURIComponent(id), {
      method: "DELETE",
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    await loadSessions();
    if (data.switchedToNew) {
      currentSessionId = data.newSessionId;
      await reloadMessages();
      setStatus("已删除并开新对话");
    } else {
      setStatus("已删除");
    }
  } catch (e) {
    setStatus("删除失败: " + e.message);
  }
}

// === 从后端拉当前消息，重渲染 ===
async function reloadMessages() {
  try {
    const resp = await fetch("/api/messages");
    if (!resp.ok) return;
    const data = await resp.json();
    renderMessages(data.messages || []);
  } catch (e) {
    console.error("reloadMessages failed", e);
  }
}

/**
 * v0.18.0: 大五人设初始化弹窗。
 * - 用户描述想要的人格 → 后端用 OCEAN 模型生成 JSON
 * - 用户不填或取消 → 用默认 OCEAN（0.5）
 */
async function promptPersonaInit(sessionId) {
  const description = prompt(
    "请简单描述一下你想对话的人格是怎样的？\n" +
    "（例如：一个像苏格拉底那样的智者 / 一个会讲冷笑话的朋友 / 一个温柔耐心的倾听者）\n\n" +
    "不填或点取消将使用中性默认人设。",
    "",
  );

  setStatus("正在生成大五人设...");
  try {
    const resp = await fetch(`/api/session/${encodeURIComponent(sessionId)}/persona/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: description || "" }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.persona?.ocean) {
      const o = data.persona.ocean;
      setStatus(`人设已就绪：O=${o.openness} C=${o.conscientiousness} E=${o.extraversion} A=${o.agreeableness} N=${o.neuroticism}`);
    } else {
      setStatus("已使用默认人设");
    }
  } catch (e) {
    setStatus("人设生成失败: " + e.message);
  }
}

function renderMessages(messages) {
  messagesEl.innerHTML = "";
  if (!messages || messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "message empty";
    empty.textContent = "说点什么吧。ta 在听。";
    messagesEl.appendChild(empty);
    return;
  }
  for (const m of messages) {
    addMessage(m.role, m.content);
  }
}

// === 启动时加载人格/模型/session/消息 ===
async function initControls() {
  try {
    const resp = await fetch("/api/state");
    if (resp.ok) {
      const state = await resp.json();
      if (state.model && modelDisplayEl) modelDisplayEl.textContent = state.model;
      if (state.learnerTotalFeedback === 0) {
        setStatus("冷启动 — 人设由你的反馈学习");
      }
    }
  } catch {}
  await loadSessions();
  await reloadMessages();
}

composerEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  autoGrow();
  busy = true;
  sendBtn.disabled = true;

  addMessage("user", text);
  const assistantDiv = addMessage("assistant", "");
  assistantDiv.classList.add("typing");
  appendTo(assistantDiv, "●");

  setStatus("思考中…");
  setMeta("");

  const startTime = Date.now();
  try {
    const resp = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let metaText = "";

    assistantDiv.classList.remove("typing");
    assistantDiv.textContent = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        try {
          const evt = JSON.parse(data);
          if (evt.type === "text") {
            fullText += evt.delta;
            assistantDiv.textContent = fullText;
            messagesEl.scrollTop = messagesEl.scrollHeight;
            if (fullText.length > 0) {
              const sec = ((Date.now() - startTime) / 1000).toFixed(1);
              setStatus("回复中… (" + fullText.length + " 字, " + sec + "s)");
            }
          } else if (evt.type === "status") {
            setStatus(evt.message);
          } else if (evt.type === "meta") {
            metaText += evt.delta;
            setMeta(metaText);
          } else if (evt.type === "done") {
            const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
            setStatus("就绪 (" + totalSec + "s)");
          } else if (evt.type === "corrected") {
            // naturalize 二阶段改写：用改写后的文本替换显示
            if (evt.text && evt.text !== fullText) {
              fullText = evt.text;
              assistantDiv.textContent = fullText;
              messagesEl.scrollTop = messagesEl.scrollHeight;
              if (evt.reason) setStatus("已润色: " + evt.reason.split("，")[0]);
            }
          } else if (evt.type === "session") {
            // /api/send 懒创建了新 session（首次发消息时），刷新 sidebar + 消息区
            currentSessionId = evt.sessionId;
            await Promise.all([loadSessions(), reloadMessages()]);
          } else if (evt.type === "error") {
            throw new Error(evt.message);
          }
        } catch (e) {
          console.error("SSE parse error", e);
        }
      }
    }
    await loadSessions();
  } catch (err) {
    appendTo(assistantDiv, "\n[错误: " + err.message + "]");
    setStatus("出错");
  } finally {
    assistantDiv.classList.remove("typing");
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
});

$("#clear").addEventListener("click", async () => {
  if (!confirm("归档当前对话并开始新对话？")) return;
  try {
    const resp = await fetch("/api/session/new", { method: "POST" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    currentSessionId = data.sessionId;
    await Promise.all([loadSessions(), reloadMessages()]);
    setStatus("已归档并开新对话");
    // v0.18.0: 新对话可能需要 init 人设
    if (data.needsInit) {
      await promptPersonaInit(data.sessionId);
    }
  } catch (e) {
    setStatus("清空失败: " + e.message);
  }
});

$("#export").addEventListener("click", () => {
  const messages = [...messagesEl.querySelectorAll(".message")].map((m) => ({
    role: m.classList.contains("user") ? "user" : "assistant",
    text: m.textContent || "",
  }));
  const blob = new Blob([JSON.stringify(messages, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "rememberme-" + Date.now() + ".json";
  a.click();
  URL.revokeObjectURL(url);
});

inputEl.focus();
setStatus("就绪");
initControls();