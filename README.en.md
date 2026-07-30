# EmoTalk

[English](README.en.md) | [中文](README.md)

> An emotional companion chat app with a human touch.

---

## What is this

**A chat app you'd actually want to keep talking to.**

It doesn't aim to "complete tasks" — it aims to "hold you." It remembers what you've said, your emotional patterns, what you're going through, and responds in the right tone at the right moment.

- **Remembers you long-term** (no need to reintroduce yourself every time)
- **Cares proactively** (it thinks of you even when you're offline)
- **Speaks your way** (persona is yours to define; behavior preferences learn from feedback)

Provides both a **web interface** (default) and a **CLI interface**.

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

### 💡 Proactive care
When you've been idle past the threshold, the main reply naturally embeds an "oh, by the way..." at the end (referencing real content from your profile), without intruding.

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
| `/memory list` / `read <name>` / `types` / `save <type> <name> <desc>` | Memory management (2 main + 1 minor types) |
| `/memory auto <on\|off\|status>` | Auto-extract toggle (default on) |
| `/memory suggest` | Manually trigger an extraction |
| `/timeline` / `/timeline stats` | Emotional trajectory / stats |
| `/profile` / `/profile path` / `/profile scan` / `/profile reset` | User profile management |
| `/learner` / `/learner reset` | Persona learner status |
| `/reflect [days]` | Manually trigger reflection (default: 7-day lookback) |
| `/reflections list` / `read <date>` | Browse reflection history |
| `/proactive status\|trigger\|reset` | Proactive conversation state |
| `/stats` | Session stats (with compact recommendation) |
| `/compact` | Manually compact history |
| `/quiet` | Toggle `[emotion: ...]` debug labels |
| `/clear` | Clear current session history |
| `/help` | Full help |
| `/quit` | Exit |

### Proactive care

Both web and CLI embed an "oh, by the way..." at the end of the main reply when the user has been idle past the threshold (default 4h).

```bash
export EC_PROACTIVE=1                  # enable embedded proactive (default off)
export EC_PROACTIVE_IDLE_HOURS=4       # idle threshold
export EC_PROACTIVE_MAX_PER_DAY=2      # daily cap
export EC_PROACTIVE_QUIET_START=23     # quiet hours start (24h)
export EC_PROACTIVE_QUIET_END=8        # quiet hours end
export EC_PROACTIVE_COOLDOWN_MIN=60    # min interval between proactive messages
```

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
emotalk/
├── README.md / README.en.md           ← user docs
├── TECHNICAL.md                        ← developer docs (architecture, API, modules)
├── USER_MANUAL.md                      ← CLI user manual
├── STRESS_REPORT.md                    ← stress test report
├── package.json                        ← scripts: start, dev, repl, web, test
├── data/                               ← runtime data (gitignored)
│   ├── sessions/                       ← session history
│   ├── learned-prefs/                  ← feedback learning data
│   ├── memory/                         ← memory files
│   ├── timeline/                       ← emotional timeline
│   ├── profile/                        ← user profile
│   └── personality/                    ← OCEAN personas (per-session)
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
│   ├── embedded-proactive.ts           ← proactive care
│   ├── evolution/                      ← self-evolution layer (curator / lifecycle)
│   └── loop.ts                         ← runTurn core
├── examples/                           ← usage examples
├── tests/                              ← tests
│   ├── *.test.ts                       ← unit tests
│   ├── e2e.test.ts                     ← E2E tests
│   └── web-sessions.test.ts            ← Web API tests
└── personality/                        ← persona markdown docs
```

---

## License

Apache License 2.0. See [LICENSE](./LICENSE).
