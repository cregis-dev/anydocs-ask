# anydocs-ask Console — UI Redesign Brief

> Audience: a fresh design pass (no prior context). Read top-to-bottom; everything you need is here.

---

## 1. What is being designed

**anydocs-ask** is a local-first Q&A service that lets users ask natural-language questions against a documentation project (a folder of `pages/<lang>/*.json` + `navigation/<lang>.json`). It runs as a local Node service on `127.0.0.1`; it is NOT a public web app.

The product has two surfaces:

| Surface | Purpose | Audience |
|---|---|---|
| **CLI** (`anydocs-ask serve / eval / golden / analyze ...`) | Power-user / agent / CI use | Engineers, AI agents, automation |
| **Console** (web UI on `127.0.0.1:4100`) | Day-to-day human use | **Doc authors / ordinary users** |

**Goal of this redesign**: position **Console as the primary interface** for ordinary users (people who write docs, want to dogfood Q&A quality, and review eval reports). The CLI stays available but stops being the place where most workflows happen.

The console talks to a workspace at `~/anydocs-ask-runtime/` that contains one or more registered documentation projects. Per project, it spawns / reaps a child `serve` Node process that exposes `/v1/ask`. The console itself is a tab dashboard for managing those projects.

---

## 2. Target users

### Primary — "Doc Author Daria"
- Writes / maintains a documentation site (e.g., product docs, internal handbook).
- Wants to ask "would my docs actually answer this question?" and see citations.
- Moderately technical: comfortable with terminals but prefers a UI.
- Pain: today she keeps bouncing back to CLI commands for tasks that should be 1-click.

### Secondary — "Tool Operator Theo"
- Runs the service for a team, wires it into Reader clients, sets up gateways.
- Cares about traffic, error rates, latency, eval regression alerts.
- More technical than Daria, but still appreciates a clear UI over `jq`-ing JSON.

### Out of scope — Agents / automation
- They use the CLI. The UI does not need to be agent-readable beyond reasonable HTML semantics.

---

## 3. Five canonical user journeys

The redesign must make these feel natural and obvious. Numbered in priority order.

1. **First-time setup**: I just installed anydocs-ask. I want to add my docs folder, see it index, and ask my first question.
2. **Dogfood a question**: I made some doc edits. I want to ask 3 questions, see if citations are right, and iterate.
3. **Run an eval**: My golden case set has 30 questions. I want to run them all, see R@5 / Citation / Answer-rule pass rates, and compare against the last report.
4. **Manage the golden case set**: I want to generate candidate questions from doc structure, approve/reject them one by one, and flush approved ones into the active case set.
5. **Diagnose live traffic**: My Reader integration is in production. I want to see this week's confidence / latency / error trends and drill into the worst requests.

---

## 4. Current state of the console (audit)

I just did a structural cleanup. **Before** and **after** screenshots are in this repo at:

```
tests/.tmp/console-audit/               ← BEFORE (messy)
  01-home.png
  02-project-default.png
  03a-index-top.png      03b-index-mid.png
  04a-eval-stopped-top.png  04b/c/d-eval-...png   (eval tab w/ candidates)
  05-traffic-stopped.png
  06-config-drawer.png
  07-ask-running.png

tests/.tmp/console-audit/after/         ← AFTER cleanup (better IA, still ugly)
  01-home.png
  02-project-stopped-ask.png
  03-eval-top.png  03b-eval-mid.png  03c-eval-cases.png
  04-traffic-stopped.png
  05-index-stopped.png
  06-ask-running.png
  07-eval-running.png
  08-eval-approved-tab.png
  09-eval-run-clicked.png
  10-banner-post-eval.png
```

**Look at the AFTER folder for the current visual baseline.** The structural problems (Run Eval button buried under 500 pending candidates, badge column overlapping query text, disabled-form-for-stopped-state, etc.) have been fixed in code. Style is still developer-pragma:

- All-caps card headers in tiny letter-spacing
- Single 1-pixel border cards on a `#fafafa` background
- Github-flavored color palette (`--accent: #0969da`)
- Mixed CJK/English copy throughout
- Spartan: no illustrations, no shadows beyond hairline, no microinteractions

**What's good and should stay**:
- Information density (developers DO want everything visible at once)
- Sober, no-marketing aesthetic
- Sticky header with project switcher
- Light/dark mode via `prefers-color-scheme`
- Monospace for paths, IDs, numbers

**What needs design love**:
- Visual hierarchy is flat — every card looks the same weight
- Hard to know "what should I look at first"
- Empty states are bland one-liners, not warm welcomes
- KPI tiles are bare numbers with tiny labels
- Lifecycle states (stopped / warming / ready / asking / answer) have no visual narrative
- Tab system uses underline only — barely visible
- Forms use system browser default styling
- No iconography beyond ▶ ⚙ ◆ emoji
- Mobile / narrow widths not considered (this is OK — desktop-first)

---

## 5. Design goals

1. **Task-oriented IA**: Each tab opens with its main action visible at first glance. No scrolling-past 500 list items to find the run button.
2. **Plain English first**: Replace internal jargon (题集 / workshop / golden / R@5 / RRF) with friendly labels, but keep the technical term reachable via tooltip / details. CJK stays welcome but should never be the only label for a control.
3. **State-aware first screens**: A stopped project, a warming project, a ready project, and a project with errors should each feel visually distinct, not just have a different pill in the corner.
4. **Confident empty states**: Empty Reports, empty Traffic, empty Golden Cases — each is a teaching moment, not "—".
5. **Calm density**: Reduce visual noise. Group related metrics. Don't make every card look equally important.
6. **Dev-tool aesthetic**: Linear, GitHub, Vercel-dashboard, Fly.io feel. NOT Stripe-marketing or Notion-consumer. Sober colors, real data, modest shadows. We are tools for builders, not a product page.
7. **Light + dark mode parity**: Both modes get equal attention. Default-system, override via OS.
8. **Accessible-by-default**: Sufficient contrast, focus rings, semantic HTML, no color-only meaning.

---

## 6. Hard technical constraints (READ CAREFULLY — affects what you can deliver)

The implementation is **server-rendered HTML strings from Hono html templates + a single inline `<style>` block + a small bootstrap script using vanilla JS**. There is NO bundler, NO framework, NO Tailwind, NO npm-installed component library.

### Must work with this stack:
- **HTML**: server-rendered. The designer can write semantic HTML5 — `<header>`, `<main>`, `<section>`, `<dl>`, `<table>`, `<details>`, etc.
- **CSS**: a single `<style>` block per page (or a shared one). Use **CSS variables** for theming. Use modern CSS (grid, flexbox, container queries OK, `:has()` OK). NO Tailwind classes. NO CSS-in-JS. NO PostCSS-only syntax.
- **JS**: vanilla. Direct DOM, `addEventListener`, `fetch`. The designer can specify event-driven interactions but should not assume a reactive framework.
- **Fonts**: system stack only — `ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", sans-serif`. Mono: `ui-monospace, SFMono-Regular, Menlo, monospace`.
- **Icons**: inline SVG only (designer should provide SVG source for any icons used). No icon font dependency, no Lucide / Heroicons package.
- **Images**: avoid them. Use SVG, CSS, or unicode.

### Width and viewport
- Designed for **desktop**, target 1280–1920 wide.
- Main content max-width **~1240px** centered.
- Must still be usable down to **~720px wide** (split-screen with a doc).
- Mobile (<720px) is **out of scope**. Don't waste design effort there.

### Color tokens (current — feel free to update)
```css
--bg:        #fafafa  (dark: #0d1117)
--bg-elev:   #ffffff  (dark: #161b22)
--bg-soft:   #f3f4f6  (dark: #1c2128)
--bd:        #e5e7eb  (dark: #30363d)
--bd-soft:   #eef0f2  (dark: #21262d)
--fg:        #1f2328  (dark: #e6edf3)
--fg-soft:   #57606a  (dark: #9da7b3)
--fg-mute:   #8b939c  (dark: #6e7681)
--link:      #0969da  (dark: #4493f8)
--accent:    #0969da  (dark: #4493f8)
--ok:        #1f883d  (dark: #3fb950)
--warn:      #9a6700  (dark: #d29922)
--err:       #cf222e  (dark: #f85149)
--run:       #0969da  (dark: #4493f8)
```
You may propose a new palette, but keep these semantic tokens — the code references them.

---

## 7. Pages and states to design

For each page, deliver **all listed states**. Each "state" is a separate mockup.

### 7.1 Home (`GET /`) — project list

**Role**: Landing page. Pick a project, or set up the first one.

**Content**:
- Sticky header: brand wordmark `◆ anydocs-ask / console`, project switcher `<select>` (when projects exist), gear (config drawer), host hint `127.0.0.1:4100`.
- Page heading `projects` + workspace path
- Workspace KPI strip (shown when ≥1 project): `valid / total · indexed · running · golden cases · runs·7d · most recent project`
- Project cards grid (3 per row at 1240px): one card per registered project
- Add Project card / form: path + optional name + Add button

**Card per-project contents**:
- Name (mono)
- Status pills: `idle | warming | running:port`, `indexed | not indexed`
- Stats row: `N cases · N runs·7d · eval YYYY-MM-DD | no eval yet`
- Path (short form, e.g. `~/workspace/docs_home/hermes-docs`, hover for full)
- Primary action: `open + start →` (when idle) / `open →` (when running)

**States to design**:
1. **First-run / empty workspace**: zero projects registered. Strong "add your first project" CTA with example commands.
2. **Single project, idle**: most common starting screen.
3. **Multiple projects mixed**: 5 cards, 2 running 1 idle 1 invalid 1 not-indexed. Shows how to differentiate at a glance.
4. **Invalid project**: missing `pages/` or `navigation/` — show what's broken, soft-greyed, no open button.

### 7.2 Project page — Ask tab (`GET /p/:name#ask`)

**Role**: Q&A scratchpad. Ask a question, see answer + citations + retrieval trace.

**Layout**: two-column. Left sidebar 320px: status card + lifecycle card + reports card. Right main: tabs (Ask / Index / Eval / Traffic), the Ask card.

**Ask card contents**:
- Title `Ask` + persist toggle (dry-run vs writes-to-runs)
- Question textarea (multiline, ⌘↵ submits)
- Ask button + status text (`ready` / `waiting…` / `error message`)
- Result section (hidden until answered):
  - Tabs: `answer | citations N | meta`
  - **Answer**: rendered markdown
  - **Clarify**: when LLM asks back instead of answering (different visual treatment)
  - **Citations**: numbered chips, each with page title + snippet
  - **Meta**: kind / confidence / retrieval set / latency / fused top-5 table

**Sidebar STATUS card**:
- `path` (short form, ellipsis), optional `id` (only when ≠ name)
- `indexed` (yes/no tag), `process` (`stopped` or `:port pid N`)

**Sidebar LIFECYCLE card**: `start` / `stop` buttons (one enabled per state).

**Sidebar REPORTS card** (hidden when empty): grouped by kind (eval / analyze / golden), list of recent report files.

**Next-action banner** (above tabs, when applicable):
- Levels: `info` (blue) / `warn` (yellow) / `err` (red)
- Title + detail + CTA button jumping to the relevant tab
- Examples: "Project is not running" / "Cases ready — run your first eval" / "Last 7d error rate 8.3%"

**States to design**:
1. **Stopped**: Ask form replaced by a big "▶ Start project" gate. Sidebar shows `stopped`. Banner says "Project is not running" + Start CTA.
2. **Warming**: Start clicked, child is loading embedder + indexing. Spinner, "warming…" text, ask button disabled but textarea allows queuing a question.
3. **Ready, no answer yet**: Form enabled, focus in textarea, no result section.
4. **Asking** (in-flight): Submit clicked. Disabled form, "thinking…" status, faint progress affordance.
5. **Answer received**: Result section visible, default tab `answer`. Show markdown rendering with code blocks.
6. **Clarify**: Backend returned `kind=clarify` — different banner above answer text, suggestion to refine question.
7. **Error**: Network or LLM error (e.g. invalid credential). Friendly error card explaining what likely went wrong + link to config drawer.

### 7.3 Project page — Index tab (`#index`)

**Role**: See what's in the doc set + the index DB. Trigger reindex.

**Sections**:
- **INDEX** card: KPI tiles `on disk N` / `in DB N` / `chunks N` / `embed cache N vectors` / `last indexed ISO`. With `reindex` button. Show drift warning when on-disk ≠ DB.
- **CONTENT EXPLORER**: per-language tabs (e.g., `en 108`, `zh 50`). Tree of pages grouped by nav section. Each row: title (mono) · slug · `published | draft | unlisted`.

**States**:
1. **Healthy, idle**: counts match, no warnings.
2. **Drift warning**: on disk 108, in DB 100. Warn-yellow banner explaining what to do.
3. **Has orphans / missing files**: warn-red badges on specific rows.
4. **Empty docs**: no pages on disk. Big "drop files into pages/<lang>/" empty state.
5. **Search overlay (NEW — current console has none)**: text input above the tree, fuzzy filter highlights matches. Optional but desired.

### 7.4 Project page — Eval tab (`#eval`)

**Role**: Run eval against approved cases, compare to baseline, manage golden cases.

**Sections** (in order):
1. **Metric row**: two cards side-by-side — LATEST EVAL (R@5 / Citation / Answer-rule + deltas vs baseline) and BASELINE (pinned or "not pinned" with explainer).
2. **RUN EVAL** (highlighted, primary action card): big `▶ run` button + baseline selector dropdown. Tagline: "Runs every approved case · medium docs take 10–30s." Collapsible "CLI equivalent" details.
3. **LATEST REPORT** (collapsible details, when a report exists): inline markdown render + link to standalone.
4. **GOLDEN CASES** card with two sub-tabs:
   - **Approved** (the active case set): summary (N cases, last edited) + by-lang / by-tag / by-source bar charts.
   - **Pending review** (workshop): summary (pending / approved / rejected counts), buttons `+ from structure` / `+ from runs`, optional `flush N approved → cases.jsonl`, then the candidate row list:
     - Each row: badge (template_id), question text, meta line (lang · must_cite pages · optional ctx), approve / reject buttons. Up to 50 rendered, with "load more" tail.
5. **HISTORY** (table, when ≥1 report): date · R@5 · Cit · Ans · pin button per row. Sparklines for trends.

**States**:
1. **No cases yet**: Approved tab empty with prompt to seed via Pending. Pending tab also empty with `+ from structure` CTA.
2. **Cases exist, no eval run**: Latest eval card shows the empty-with-CTA copy.
3. **One eval done, no baseline pinned**: Baseline card explains how to pin. Metric card shows latest values without deltas.
4. **Multiple evals + pinned baseline**: Metric card shows deltas (green/red), history table has sparklines.
5. **Eval running** (rare but possible): the Run Eval button becomes a progress indicator (we don't have real progress per-case but we should reflect "running…" state).
6. **Pending review with hundreds of candidates**: Show pagination affordance / "showing 50 of 526" tail row.

### 7.5 Project page — Traffic tab (`#traffic`)

**Role**: 7-day rolling traffic dashboard + analyze tool.

**Sections**:
1. **Health strip** (KPI cards, hidden when 0 runs): `queries·7d (split reader/console)` · `mean confidence` · `p95 latency / p50` · `non-answer rate (split error / clarify)`. Each card has a 7-day sparkline.
2. **Runs table** (when ≥1 run): filterable by query text / source / kind. Row expand on click to show fused retrieval table + answer markdown + re-ask shortcut.
3. **Empty state** (no runs): friendly card explaining dogfood vs real-traffic ways to produce data.
4. **ANALYZE RUNS** card (hidden until ≥1 run or ≥1 prior analyze report): `▶ run analyze · 7d` button + `include console traffic` checkbox. Inline latest report markdown when present, history details below.

**States**:
1. **Stopped or no runs ever**: Health strip hidden. Empty state card visible. Analyze section hidden.
2. **Has runs, no analyze yet**: Health strip + runs table + analyze CTA card.
3. **Has runs + recent analyze report**: All sections visible. Analyze report rendered inline.
4. **Concerning metrics**: P95 latency > 3s and error rate > 5% — show warn / err tinting on the KPI cards.

### 7.6 Config drawer (right-side slide-over, triggered by ⚙)

**Role**: Read-only summary of effective env / config files. Author-comfort: "what credentials is this actually using?"

**Content**:
- Section per source, in precedence order:
  - `WORKSPACE · .env` — file path, mtime, redacted key=value pairs (show `abcd***xy` form for secrets, full value for non-secrets like model name).
  - `WORKSPACE · .console.json` — file path, JSON pairs, or "file does not exist (defaults apply)".
  - `PROJECT · anydocs.ask.json` — same treatment.
- Read-only notice + how secrets are redacted.
- Close button (×).

**State**: just one — drawer open.

### 7.7 Report viewer (`GET /p/:name/reports/<filename>`)

**Role**: Standalone rendering of a single eval / analyze / baseline markdown report.

**Content**: minimal — page heading with report filename + breadcrumb back to project, then the rendered markdown content (with code blocks, tables, sparkline ascii art preserved as `<pre>`). Print-friendly.

---

## 8. Components / patterns to formalize

These appear across multiple pages — please design them as reusable components in the deliverable:

- **Card** (3 variants: default, flush, highlighted-primary)
- **Pill** (5 variants: neutral, ok, warn, err, running)
- **Tag** (smaller than pill; for inline labels)
- **KPI tile** (number + label + optional spark + optional warn/err tint)
- **Tabs** (used at two nesting levels — top tabs for Ask/Index/Eval/Traffic, inner tabs for Approved/Pending in Golden cases, and for answer/citations/meta in Ask result)
- **Empty state** (icon + heading + body + optional CTA)
- **Next-action banner** (info/warn/err variants)
- **Status pill with dot** (idle / warming / ready / error)
- **Code chip** (`<code>` inline) and `<pre>` block
- **Form input + label + helper text**
- **Primary button / secondary button / destructive button / icon button (gear, ×)**
- **Sparkline** (currently ascii `▁▂▃▅▇` — feel free to upgrade to inline SVG)
- **Citation chip** (numbered circle, used in answer text and citation list)
- **Detail / disclosure** (collapsed-by-default `<details>`)
- **Diff indicator** (`+0.05` green / `-0.03` red / `±0.00` mute — used in eval metric deltas)

---

## 9. Tone, voice, and copy guidance

- **Headings**: sentence case, not Title Case, not ALL CAPS. "Run eval", not "Run Eval" or "RUN EVAL".
- **Empty-state body**: 1 sentence direct, 1 sentence "here's how to make this useful". Not preachy. No marketing.
- **Errors**: name the problem in plain words, then "likely cause" + "what to try". Never raw stack traces in default view; offer a "show details" disclosure.
- **CLI hints**: when a CLI command exists for the same thing, put it inside a `<details>` labelled "CLI equivalent" — not as the primary CTA.
- **Bilingual**: every label is fine in English. Optional Chinese subtitle for first-time-user-facing text (banners, empty states). Avoid Chinese-only labels on controls. Replace existing colloquialisms (`金准` / `钉固` / `题集` / `召回悬崖`) with clearer terms — keep one canonical English form, and only add Chinese if it actively helps.

---

## 10. Deliverable format (please follow precisely)

Produce a single **`design-output/`** folder containing:

```
design-output/
  index.html                    ← gallery: thumbnails linking to every state below
  styles.css                    ← all shared CSS (single file, variables-based)
  README.md                     ← rationale, type scale, spacing scale, color palette
  pages/
    home-empty.html
    home-single-idle.html
    home-multiple-mixed.html
    home-invalid.html
    ask-stopped.html
    ask-warming.html
    ask-ready.html
    ask-asking.html
    ask-answer.html
    ask-clarify.html
    ask-error.html
    index-healthy.html
    index-drift.html
    index-empty.html
    eval-no-cases.html
    eval-cases-no-run.html
    eval-one-run-no-baseline.html
    eval-multi-with-baseline.html
    eval-running.html
    eval-pending-review.html
    traffic-empty.html
    traffic-active.html
    traffic-with-analyze.html
    config-drawer.html
    report-viewer.html
  components.html              ← isolated showcase of every component variant
  icons.svg                    ← sprite of any inline SVG icons used
```

Each `.html` file is **self-contained** (links to `../styles.css`) and **uses realistic data**, not Lorem ipsum. Sample data hints:

- Project name: `hermes-docs`
- Workspace: `/Users/shawn/anydocs-ask-runtime`
- Pages: 107 on disk, 460 chunks in DB
- Sample question: "What is hermes and how do I install it?"
- Sample answer: 3-paragraph markdown with 2 citations and a fenced code block
- Sample metrics: R@5 = 0.78, Citation pass = 0.65, Answer-rule pass = 0.82
- Sample report file: `2026-05-12-eval.md`

The `README.md` in the deliverable must include:
- Type scale (sizes / line-heights / weights for each role)
- Spacing scale (4/8/12/16/24/32px or whatever you choose)
- Color palette table (light + dark hex values per token)
- Shadow + radius scale
- Notes on responsive thresholds
- Any departures from current tokens, with rationale

Both **light and dark mode** must be visually verified — use `prefers-color-scheme` automatic OR a query-param toggle (`?theme=dark`) so the reviewer can see both.

---

## 11. Explicit non-goals

- Mobile UI (<720px). Don't waste effort here.
- Marketing pages, onboarding videos, animations beyond <300ms transitions.
- New brand identity. Wordmark `◆ anydocs-ask` stays.
- Localization beyond the current bilingual ZH/EN pattern. No need for fr/de/ja.
- Accessibility-audit checklist (covered by us in implementation; just don't fight a11y — semantic HTML + focus rings are the minimum).
- Real-time updates / websockets. Console polls; designs should accommodate occasional state flips but no streaming UI.

---

## 12. Process expectations

- One round of mockups → I review → one round of revisions → final.
- Please ask clarifying questions in your first response before producing full mockups if anything in this brief is ambiguous.
- If you want to propose changes to the IA / page structure (not just visual treatment), do so as a paragraph at the top of your response — I'll approve or reject before you proceed.
