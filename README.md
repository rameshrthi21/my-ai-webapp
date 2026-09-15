# Architecture Validation & Design Review

An AI-assisted architecture reviewer, in your browser. Submit a proposed
design and it's checked against an editable rule pack — flagging **violations**
(hard rule breaks), **deviations needing an exception** (soft/recommended
patterns not followed, with no documented waiver), and **Well-Architected
gaps** (required considerations never addressed) — with every finding cited
to the exact rule that raised it.

It's the automated extension of a manual architecture review board: instead
of a person checking a submitted design against the roadmap and standards by
hand, this reads the design and does the first pass, grounded in your own
enterprise patterns rather than generic cloud guidance.

## Live app

Once the `Deploy to GitHub Pages` workflow has run, the app is served at:

```
https://rameshrthi21.github.io/my-ai-webapp/
```

(First run: in the repo's **Settings → Pages**, make sure the source is set
to **GitHub Actions** — the workflow will then configure and deploy it
automatically on every push.)

## How it works

- **`assets/rules.default.json`** is the seed rule pack — ~30 rules across
  Security, Reliability, Cost Optimization, Operational Excellence,
  Performance Efficiency, and Enterprise Governance. Each rule has:
  - a `type`: `flag` (anti-pattern present → fail), `conditional` (fail
    unless a documented exception phrase is present), or `require` (must be
    mentioned somewhere in the submission → pass)
  - a `requirement` — the actual rule text, shown/cited whenever it fires
  - `triggers` / `expect` / `exceptionKeywords` — the phrases the engine
    matches against the submitted text
  - a `recommendation` — what to do about it
- The **Review** tab runs the submitted text through every rule in the
  active pack, scores each Well-Architected pillar, and lists findings
  grouped by severity.
- The **Rule Library** tab lets you edit, add, delete, import, or export the
  rule pack — this is meant to be replaced with your organization's actual
  architecture standards, not left as generic defaults.
- The **History** tab keeps past reviews in `localStorage` so you can reload
  and re-check a submission later.
- The **Settings** tab has an optional, off-by-default AI narrative layer:
  bring your own Anthropic API key (stored only in your browser's
  `localStorage`, sent directly from your browser to Anthropic's API) and
  each review gets a short plain-language synthesis on top of the
  deterministic findings. The core tool works fully offline without this.

Everything runs client-side. No backend, no database, no data leaves your
browser unless you explicitly turn on the AI narrative feature.

## Customizing for your org

1. Open the **Rule Library** tab and edit/add/remove rules to match your
   actual enterprise patterns, approved service catalog, data residency
   policy, tagging standard, etc.
2. Use **Export JSON** to save your customized pack, and **Import JSON** to
   load it back in (or to share it with teammates / commit it to the repo
   as a new default).
3. To ship a customized pack as the new default for everyone, replace
   `assets/rules.default.json` with your exported file and push.

## Local development

No build step — it's static HTML/CSS/JS. Serve the repo root with any
static file server, e.g.:

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000/`.
