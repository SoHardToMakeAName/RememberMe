# RememberMe

[English](README.en.md) | [中文](README.md)

[![CI](https://github.com/SoHardToMakeAName/RememberMe/actions/workflows/ci.yml/badge.svg)](https://github.com/SoHardToMakeAName/RememberMe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jokab1074/rememberme.svg)](https://www.npmjs.com/package/@jokab1074/rememberme)

> **RememberMe MCP is live** — see the [MCP server (as a memory backend)](#mcp-server-as-a-memory-backend) section.

> An AI companion that **actually remembers you**. Switch models, switch platforms, close and reopen — it still knows who you are, what you like, and what you've been through.

---

## What is this

**It remembers you**.

Not the polite "we have your account on file" kind. It actually persists — as local data — **who you are, what you like, and what you've been through**. Come back six months later, ask "do you remember me?", and it picks up from the topic you left mid-sentence.

This isn't the "start over every time" experience of generic chatbots. RememberMe's core promise: **all the context it builds about you persists across sessions, across interfaces, across models**.

- **Remembers who you are** — your name, occupation, life stage, location, the topics on your mind
- **Remembers what you like** — preferences grow from your real feedback, not developer-imposed defaults like "users prefer concise replies"
- **Remembers what you've been through** — recurring emotional patterns are named and kept (`work-burnout`, `life-aversion` — not just a daily mood log)
- **Remembers what you talked about** — six months later, the conversation context is still there

Provides a **web interface** (default), a **CLI interface**, and an **MCP server** — so Claude Code, Claude Desktop, Cursor and other AIs can use your long-term memory directly.

---

## 🧠 How it remembers you

> Strictly speaking, RememberMe is a **context orchestrator** — it composes your profile, memories, emotional patterns, and conversation history into a system prompt that's better tuned to *this* moment, so that the same LLM performs noticeably better with you than it does in a generic chat window. It doesn't plan or act on its own; when you want *other* AIs to share this memory, the same store is also exposed as an MCP server (see below).

### Your profile lives in local markdown files

- **Who you are** (basic info) — name, occupation, location, stored as fields in `data/profile/PROFILE.md`
- **What you like** (preferences + communication style) — grown from your real feedback, not predefined "length / tone / depth / format" dimensions
- **What you've been through** (events + emotional patterns) — recurring emotional reactions stored as `emotion`-type memories, only kept when ≥2 pieces of evidence exist

Every entry is a **plain text file** — you can open it in any editor, read it, modify it.

### Come back six months later, it still remembers

- The topic you left mid-sentence
- Your emotional patterns ("you always get anxious when talking about work", not "you're feeling off today")
- Your preferences (you said "don't reply too long" — now it replies briefly)
- Across sessions, across interfaces (CLI ↔ Web), across models (Claude / DeepSeek / GPT-4) — same memory

### On privacy: two boundaries to be clear about

- ✅ **Local data**: your profile, memories, reflections, and feedback-learned observations only live in `data/`, covered by `.gitignore`. RememberMe does not upload them to any RememberMe-controlled server.
- ⚠️ **LLM calls**: to work, RememberMe has to send conversation content to the LLM provider you configured (Anthropic / DeepSeek / OpenAI / etc.). RememberMe itself does not store conversations outside your local disk, but **you have to trust your LLM provider** — this is a constraint shared by every LLM-based application.

### 🌐 The web UI binds to localhost only

The web server binds **127.0.0.1** by default, so other devices on the same WiFi / LAN **cannot reach it**.
(Earlier versions omitted `hostname`, and Bun defaults to `0.0.0.0` — reachable from the LAN, where `/api/send` spends your API key on whoever asks. Tightened in v0.22.0.)

| What you want | How |
|---|---|
| Local use only (default) | nothing to set |
| Use it from another device on your LAN | `HOST=0.0.0.0 EC_WEB_TOKEN=your-token bun run start` |
| Genuinely open with no auth (not recommended) | `HOST=0.0.0.0 EC_WEB_ALLOW_UNAUTHENTICATED=1 bun run start` |

- With `EC_WEB_TOKEN` set, every `/api/*` route requires `Authorization: Bearer <token>`; the browser asks for the token once and keeps it in `localStorage`
- **Listening on a non-loopback address without a token → the server refuses to start** (better to fail than to silently hand your key away)
- Every `/api/*` route also checks the `Origin` header, blocking browser-originated cross-site requests (CSRF)

---

## Core Features

### 🧠 Multi-layer memory
Not just "what you said" — it distinguishes "which are recurring emotional patterns" from "which are life events that actually affect you" from "which are external resources."
- `emotion` — recurring patterns (requires ≥2 evidence)
- `event` — life events with emotional impact
- `reference` — external resources (doctor/therapist/contact)

### 👤 User profile
Automatically accumulates 6 dimensions of long-term info: basic info, communication style, topics of interest, preferences & taboos, emotional baseline, recent changes.

### 🪞 Daily reflection
The background process reads your emotional timeline, recent memories, and profile, then distills them into "today's insights" — over time, the AI knows you better and better.

### 🌊 Big-Five persona (OCEAN)
No more hardcoded personas. On a new session, you describe the persona you want in one sentence ("Socrates", "gentle older sister", "brutally honest buddy"), and the LLM translates it into 5 numeric dimensions (Openness / Conscientiousness / Extraversion / Agreeableness / Neuroticism) + a free-text preferences string. **Per-session**, persisted to `data/personality/{sessionId}.json`.

### 🪄 Auto-learn your preferences
Feedback you give in conversation ("don't reply too long," "don't use emoji," "call me Lao Wang") is auto-classified as positive/negative/neutral, extracted into natural-language observations, and accumulated in `data/learned-prefs/default.json`. Each next reply's system prompt carries these observations as soft hints (not hard rules).

### 💬 Per-session conversations
Each session is persisted to `data/sessions/` with persona + history + title. Click any session in the left sidebar to switch.

### 📝 Pure Markdown config
Profile, memories, and reflections are all `.md` files. **No YAML, no JSON config** (except runtime data).

### 🌐 Web interface (default)
Default launches a Bun.serve() HTTP server. Open `http://localhost:3000` to use. SSE streaming + live status bar.

### 🔌 MCP server (as a memory backend)
The same memory store is also packaged as an MCP server, so any MCP client — Claude Code, Claude Desktop, Cursor, VS Code — can read and write your long-term memory. Four tools: three reads (`list_memories` / `read_memory` / `read_profile`) and one write (`record_turn`). Details in the [MCP server](#mcp-server-as-a-memory-backend) section below.

---

## Quick Start

```bash
# 1. Install deps (need bun ≥ 1.1)
bun install

# 2. Set API key (any one, Anthropic recommended)
export ANTHROPIC_API_KEY=sk-ant-xxx
# or (OpenAI-compatible: DeepSeek/Moonshot/self-hosted)
export OPENAI_API_KEY=sk-xxx

# 3. Launch (web by default)
bun run start            # → http://localhost:3000
bun run repl             # → CLI mode (src/index.ts)
```

Or put your API key in `settings.json` (Anthropic SDK format, gitignored):

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-your-key-here",
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_MODEL": "deepseek-v4-flash"
  }
}
```

First launch auto-creates `data/profile/PROFILE.md` and `data/sessions/`. Start chatting.

---

## How to use

### Web version (default)

Visit `http://localhost:3000`:
- Left sidebar: session list (+ new conversation), persona init entry, model input, clear/export buttons
- Right area: chat message stream + input
- Enter to send, Shift+Enter for newline
- Status bar shows: `Thinking... (N chars, Ns)` → `Ready (N s)`
- **New session + persona init**: click "+ New conversation" → modal pops up → describe the persona you want ("Socrates") → LLM converts to OCEAN values + free-text preferences → saved to `data/personality/{sessionId}.json`
- **Switch session**: click any item in the left list → load that conversation instantly (persona switches with the session)
- **Switch model**: type new model name in input field → click "Apply"

> New sessions start with one-sentence persona generation → OCEAN; if you skip, you get the default neutral persona (all OCEAN 0.5).

### CLI mode

```bash
bun run repl
```

#### REPL commands

| Command | What it does |
|---|---|
| Just type | Start chatting |
| `/persona show` | Show current OCEAN persona + preferences |
| `/persona init <one-sentence description>` | Use LLM to generate OCEAN for current session (prompted on first launch) |
| `/persona describe <text>` | Edit `preferences` without calling LLM |
| `/persona reset` | Reset persona to neutral default (all 0.5) |
| `/session list` | List all sessions (most-recent-active first) |
| `/session current` | Show current session details (id + title + history length + persona) |
| `/session new [description]` | Create new session (optionally init persona immediately; CLI and web share session data) |
| `/session switch <id>` | Switch to a specific session (save current → load target → reload persona) |
| `/session save` | Manually save current session (also auto-saved on exit) |
| `/session delete <id>` | Delete a session + its persona file (cannot delete the current one) |
| `/memory list` / `read <name>` / `types` / `save <type> <name> <desc>` | Memory management (2 main + 1 minor types) |
| `/memory auto <on\|off\|status>` | Auto-extract toggle (default on) |
| `/memory suggest` | Manually trigger an extraction |
| `/timeline` / `/timeline stats` | Emotional trajectory / stats |
| `/profile` / `/profile path` / `/profile scan` / `/profile reset` | User profile management |
| `/learner` / `/learner reset` | Persona learner status |
| `/reflect [days]` | Manually trigger reflection (default: 7-day lookback) |
| `/reflections list` / `read <date>` | Browse reflection history |
| `/stats` | Session stats (with compact recommendation) |
| `/compact` | Manually compact history |
| `/quiet` | Toggle `[emotion: ...]` debug labels |
| `/clear` | Clear current session history |
| `/help` | Full help |
| `/quit` | Exit (auto-saves current session) |

### CLI & Web share sessions

`data/sessions/` is shared between CLI and web:
- Chat on web → start CLI → CLI auto-loads the most recent session with real conversation
- Chat on CLI → quit web → restart web → web loads the same session
- Switch sessions with `/session switch <id>` (CLI) or the left sidebar (web)

### MCP server (as a memory backend)

Mount RememberMe on any MCP client (Claude Code / Claude Desktop / Cursor / VS Code …) and **other AIs** get your long-term memory too.

Four tools:

| Tool | Type | What it does |
|---|---|---|
| `list_memories` | read | List all memories (name + description + date) |
| `read_memory` | read | Fetch one memory in full |
| `read_profile` | read | Read the 6 sections of the user profile |
| `record_turn` | **write** | The host says "this turn is worth keeping"; the memory system decides what to write |

**Design**: the host model only decides *whether* a turn is worth recording. Extraction and pattern induction run server-side using RememberMe's original rubric, so the **type judgment and pattern quality are identical** to the web/CLI paths (same `extractMemoryCandidates()`).

<details>
<summary><b>Use it from your local Claude Code (development build)</b></summary>

```bash
# 1. Build (re-run after changing src/mcp/)
bun install
bun run build:mcp

# 2. Register with Claude Code (-s local = this project only, stored in ~/.claude.json)
#    Replace <REPO> with your absolute repo path
claude mcp add rememberme -s local \
  -e REMEMBERME_DATA_DIR=<REPO>/data \
  -- node <REPO>/dist/mcp/index.js

# 3. Verify
claude mcp list        # should show rememberme ... ✔ Connected
```

Then **restart Claude Code** (MCP tools are loaded at session start). The tools appear as `mcp__rememberme__list_memories` and friends.

Swap `-s local` for `-s user` to make it available in every project.

> ⚠️ **Scope decides where it works**: `claude mcp list` only shows the local entry of the project you're currently in, plus global user entries. With `-s local` you must `cd` into the repo root to see it; from anywhere else it prints "No MCP servers configured". A local entry with the same name **shadows** the user entry — check which scope you're looking at when debugging.
>
> **`REMEMBERME_DATA_DIR` must be an absolute path.** Without it the server falls back to `~/.rememberme/data` and won't see this repo's `data/`. Resolution order: `REMEMBERME_DATA_DIR` → `dataDir` in `settings.json` → `~/.rememberme/data`.
>
> You can also run straight from source (changes take effect immediately, no rebuild):
> ```bash
> claude mcp add rememberme-dev -s local \
>   -e REMEMBERME_DATA_DIR=<REPO>/data \
>   -- bun run <REPO>/src/mcp/index.ts
> ```

</details>

<details>
<summary><b>Install with npx (after publish)</b></summary>

The npm package name is **`@jokab1074/rememberme`**:

```bash
claude mcp add rememberme -s user -- npx -y @jokab1074/rememberme
```

The published package carries an `mcpName` field (`io.github.SoHardToMakeAName/RememberMe`) used for [MCP Registry](https://registry.modelcontextprotocol.io) ownership verification; the manifest is the `server.json` at the repo root.

**First run needs an API key.** The MCP server looks for configuration in this order:

```
1. REMEMBERME_SETTINGS environment variable
2. ~/.rememberme/settings.json
3. <package dir>/../settings.json
```

An npm install lives in `node_modules/`, so step 3 won't find your repo's `settings.json` — only `~/.rememberme/settings.json` is left. Create it (see `settings.json.example` for the format):

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-your-key",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5-20250929"
  }
}
```

Or point it at a config you already have:

```bash
claude mcp add rememberme -s user \
  -e REMEMBERME_SETTINGS=/path/to/settings.json \
  -- npx -y @jokab1074/rememberme
```

Without a key the three read tools still work, and `record_turn` tells you exactly where to configure it:

> Unable to extract memory: no usable LLM config.
> No API key configured. Set ANTHROPIC_API_KEY in ~/.rememberme/settings.json or the project settings.json…

**Data directory**: the npm build defaults to `~/.rememberme/data` (memories in `~/.rememberme/data/memory/`, profile at `~/.rememberme/data/profile/PROFILE.md`) — the coherent location for a globally-installed npm package. Point `REMEMBERME_DATA_DIR` at an absolute path to change it.

</details>

**Read-only mode** (don't want the server calling an LLM / spending quota):

```bash
REMEMBERME_MCP_DISABLE_LLM=1   # leaves the 3 read tools; record_turn returns a clear error
```

> The MCP server implementation lives in [`src/mcp/`](src/mcp/);
> see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the overall design.

---

## How the persona works (OCEAN)

### Big Five (OCEAN)

The academically validated 5-dimension model (each 0-1):

| Dimension | Meaning | High score |
|---|---|---|
| **Openness** | Imagination, curiosity, abstract thinking | Loves new ideas, cross-domain connections |
| **Conscientiousness** | Organization, self-discipline, reliability | Organizes before speaking |
| **Extraversion** | Warmth, talkativeness, energy | Actively extends topics |
| **Agreeableness** | Trust, cooperation, altruism | Gentle, non-confrontational |
| **Neuroticism** | Emotional sensitivity, anxiety | High = anxious / Low = stable |

### How it works

1. **On new session**: modal asks "describe the persona you want" (1 sentence)
2. **LLM translates**: maps description to 5 OCEAN values + free-text preferences
3. **Persisted**: written to `data/personality/{sessionId}.json`
4. **Stable after that**: this file is the session's persona source of truth
5. **Injected per turn**: numbers + behavior hints + free-text preferences go into the system prompt

### Skip path

Don't fill the modal → default OCEAN (all 0.5) + generic preferences. You can `/learner reset` later.

### Feedback overlay

After each user message, a background feedback classifier runs (fire-and-forget):
- Positive feedback ("right, that's it") → `positivePatterns` accumulate
- Negative feedback ("too long") → `negativePatterns` accumulate
- Neutral (new topic) → not written

These observations **don't write back to the persona JSON** — they accumulate in `data/learned-prefs/{userId}.json`. The next system prompt merges persona + feedback observations:

```
【大五人格】
- Openness: 0.85（高开放性：喜欢新想法、跨领域联想）
- ...

【用户过去喜欢的】（反馈学习）
- 用户喜欢举具体例子
- 用户喜欢引用典故

【核心原则】人设 + 反馈都是参考，不是束缚。灵活调整。
```

**Feedback wins over persona**: when the user explicitly says "don't do X", feedback takes priority.

---

## Directory structure

```
rememberme/
├── README.md / README.en.md           ← user docs
├── ARCHITECTURE.md                    ← developer docs (architecture, data flow, modules)
├── USER_MANUAL.md                     ← CLI user manual
├── package.json                       ← scripts: start, dev, repl, web, mcp, build:mcp
├── server.json                        ← MCP Registry manifest
├── settings.json.example              ← API key template (the real settings.json is never committed)
├── data/                               ← runtime data (gitignored)
│   ├── sessions/                       ← session history
│   ├── learned-prefs/                  ← feedback learning data
│   ├── memory/                         ← memory files
│   ├── timeline/                       ← emotional timeline
│   ├── profile/                        ← user profile
│   └── personality/                    ← OCEAN personas (per-session)
├── locales/                           ← i18n strings (zh-CN / en)
├── web/                                ← web frontend
│   ├── index.html
│   ├── style.css
│   └── app.js                          ← SSE stream consumer
├── src/                                ← core code
│   ├── index.ts                        ← REPL entry
│   ├── web.ts                          ← web backend (Bun.serve + SSE)
│   ├── provider.ts                     ← LLM provider abstraction (Anthropic + OpenAI-compatible)
│   ├── profile.ts                      ← user profile
│   ├── memory.ts                       ← 5 memory types
│   ├── timeline.ts                     ← emotional timeline
│   ├── reflection.ts                   ← daily reflection
│   ├── prompt.ts                       ← 5-layer system prompt assembler
│   ├── compact.ts                      ← auto-compact
│   ├── sessions.ts                     ← session management
│   ├── feedback-detector.ts            ← feedback classifier
│   ├── persona-learner.ts              ← dynamic persona learner
│   ├── bigfive.ts                      ← OCEAN data model
│   ├── persona-init.ts                 ← persona init (description → OCEAN)
│   ├── classify.ts                     ← emotion detection + memory recall (side-query)
│   ├── evolution/                      ← self-evolution layer (curator / lifecycle)
│   ├── mcp/                            ← MCP server (npm package: rememberme)
│   │   ├── index.ts                    ← entry (stdio transport + stdout guard)
│   │   ├── server.ts                   ← wires up the 4 tools
│   │   ├── config.ts                   ← data dir / settings path resolution
│   │   ├── provider.ts                 ← the server's own LLM provider
│   │   ├── instructions.ts             ← instructions (when to call record_turn)
│   │   ├── build.ts                    ← distribution build (used by prepack)
│   │   └── tools/                      ← list_memories / read_memory / read_profile / record_turn
│   └── loop.ts                         ← runTurn core
└── personality/                        ← persona markdown docs
```

> **Not in the repo**: `tests/` (regression tests), `scripts/` (one-off and experiment scripts),
> `experiments/` (throwaway experiment scaffolding), `dist/` (build output).
> The repo keeps only what's needed to run and to publish.


---

## 🔒 Privacy

RememberMe itself uploads nothing. All runtime artifacts live in `data/`, which is in `.gitignore` — **never committed**:

```
.gitignored runtime data:
├── data/profile/PROFILE.md          ← your profile (only .example template is committed)
├── data/personality/*.json          ← your OCEAN persona
├── data/sessions/*.json            ← conversation history
├── data/memory/MEMORY.md + emotion/*.md + event/*.md + reference/*.md  ← memories
├── data/timeline/*.jsonl            ← emotional timeline
├── data/reflections/*.md            ← daily reflections
├── data/learned-prefs/*.json        ← feedback-learned observations
└── settings.json                    ← API key (use .example placeholder in repo)
```

**Local data: safe to**
- Paste PROFILE.md content in issues / PRs / screenshots (won't be collected)
- Push this repo to public GitHub (no conversation data leaks)
- List this project on your résumé (reviewers see only code + docs)

**But one boundary to be clear about: LLM calls**
- For RememberMe to work, it has to send conversation content to the LLM provider you configured (Anthropic / DeepSeek / OpenAI / etc.)
- RememberMe itself doesn't store copies of those conversations outside your local disk, but **you have to trust your LLM provider** — this is a constraint shared by every LLM-based application
- Picking a self-hosted / local model (e.g. Ollama) eliminates this external dependency entirely

---

## 🛠 Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun 1.1+** | Built-in TypeScript / tests / HTTP server, zero build step |
| LLM | **Anthropic SDK** (OpenAI/DeepSeek/Moonshot compatible) | Custom baseURL keeps Anthropic protocol while allowing alternative endpoints |
| HTTP | **Bun.serve** | Built-in SSE streaming, zero extra deps |
| Frontend | Plain HTML / CSS / Vanilla JS | No React/Vue, 3 files, easy to read/modify |
| Storage | **Pure Markdown + JSON** | User data readable, hand-editable, git-diffable |
| Tests | **bun:test** | 346 cases, runs at runtime, ~80s (test code is not in the public repo) |
| Big Five persona | 5 dimensions 0-1 + free-text preferences | Academic standard + LLM translation + per-session storage |
| Feedback learning | LLM free-text observations + positive/negative examples | No predefined enums, open dimensions |

---

## License

Apache License 2.0. See [LICENSE](./LICENSE).
