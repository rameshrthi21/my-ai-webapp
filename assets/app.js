(() => {
  "use strict";

  const STORAGE = {
    rules: "avr.rules.v1",
    csr: "avr.csr.v1",
    history: "avr.history.v1",
    aiEnabled: "avr.ai.enabled",
    aiKey: "avr.ai.key",
  };

  const SEVERITY_META = {
    violation: { label: "Violations", order: 0 },
    exception: { label: "Deviations needing exception", order: 1 },
    gap: { label: "Well-Architected gaps", order: 2 },
    pass: { label: "Passed", order: 3 },
  };

  const CSR_GROUPS = [
    { statuses: ["retired"], label: "Retired — prohibited" },
    { statuses: ["sunset"], label: "Sunset — migrate away" },
    { statuses: ["emerging"], label: "Emerging — needs approval" },
    { statuses: ["contain"], label: "Contain — existing use only" },
    { statuses: ["current", "strategic"], label: "Current & Strategic — approved" },
  ];

  function csrPillClass(status) {
    if (status === "retired") return "violation";
    if (status === "sunset") return "sunset";
    if (status === "emerging") return "gap";
    if (status === "contain") return "exception";
    return "pass"; // current, strategic
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    rulePack: null, // { version, name, pillars, rules }
    csrPack: null, // { version, name, statuses, entries }
    history: [],
    lastReview: null,
  };

  // ---------- persistence ----------
  // A standalone downloaded copy embeds its rule/CSR data as window.__EMBEDDED_*__
  // globals (see downloadStandaloneCopy) so it needs no fetch and works over file://.

  async function loadDefaultRulePack() {
    if (window.__EMBEDDED_RULES__) return window.__EMBEDDED_RULES__;
    const res = await fetch("assets/rules.default.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load default rule pack");
    return res.json();
  }

  async function loadRulePack() {
    const raw = localStorage.getItem(STORAGE.rules);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.warn("Stored rule pack was corrupt, falling back to defaults.", e);
      }
    }
    return loadDefaultRulePack();
  }

  function persistRulePack() {
    localStorage.setItem(STORAGE.rules, JSON.stringify(state.rulePack));
  }

  async function loadDefaultCsrPack() {
    if (window.__EMBEDDED_CSR__) return window.__EMBEDDED_CSR__;
    const res = await fetch("assets/csr.default.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load default Cloud Service Roadmap");
    return res.json();
  }

  async function loadCsrPack() {
    const raw = localStorage.getItem(STORAGE.csr);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.warn("Stored CSR was corrupt, falling back to defaults.", e);
      }
    }
    return loadDefaultCsrPack();
  }

  function persistCsrPack() {
    localStorage.setItem(STORAGE.csr, JSON.stringify(state.csrPack));
  }

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE.history) || "[]");
    } catch {
      return [];
    }
  }

  function persistHistory() {
    localStorage.setItem(STORAGE.history, JSON.stringify(state.history.slice(0, 50)));
  }

  // ---------- tabs ----------

  function setupTabs() {
    $$(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".tab").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-selected", "false");
        });
        $$(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        btn.setAttribute("aria-selected", "true");
        $(`#tab-${btn.dataset.tab}`).classList.add("active");
      });
    });
  }

  // ---------- rule engine ----------

  function pillarName(id) {
    const p = state.rulePack.pillars.find((x) => x.id === id);
    return p ? p.name : id;
  }

  function evaluate(text) {
    const lower = text.toLowerCase();
    const findings = [];

    for (const rule of state.rulePack.rules) {
      if (rule.type === "flag") {
        const hit = (rule.triggers || []).find((t) => lower.includes(t.toLowerCase()));
        if (hit) {
          findings.push({ rule, status: "violation", evidence: hit });
        } else {
          findings.push({ rule, status: "pass" });
        }
      } else if (rule.type === "conditional") {
        const hit = (rule.triggers || []).find((t) => lower.includes(t.toLowerCase()));
        if (hit) {
          const excused = (rule.exceptionKeywords || []).some((k) => lower.includes(k.toLowerCase()));
          if (excused) {
            findings.push({ rule, status: "pass", note: "Documented exception found in submission.", evidence: hit });
          } else {
            findings.push({ rule, status: "exception", evidence: hit });
          }
        } else {
          findings.push({ rule, status: "pass" });
        }
      } else if (rule.type === "require") {
        const found = (rule.expect || []).some((k) => lower.includes(k.toLowerCase()));
        findings.push({ rule, status: found ? "pass" : "gap" });
      }
    }
    return findings;
  }

  function matchCsr(text) {
    const lower = text.toLowerCase();
    const matches = [];
    for (const entry of state.csrPack.entries) {
      const names = [entry.name, ...(entry.aliases || [])];
      const hit = names.find((n) => n && lower.includes(n.toLowerCase()));
      if (hit) matches.push({ entry, matchedTerm: hit });
    }
    return matches;
  }

  function computeScores(findings) {
    const byPillar = {};
    for (const f of findings) {
      const p = f.rule.pillar;
      byPillar[p] = byPillar[p] || { pass: 0, total: 0 };
      byPillar[p].total++;
      if (f.status === "pass") byPillar[p].pass++;
    }
    const pillarScores = Object.entries(byPillar).map(([id, v]) => ({
      id,
      name: pillarName(id),
      score: v.total ? Math.round((v.pass / v.total) * 100) : 100,
      pass: v.pass,
      total: v.total,
    }));
    const totalPass = findings.filter((f) => f.status === "pass").length;
    const overall = findings.length ? Math.round((totalPass / findings.length) * 100) : 100;
    return { overall, pillarScores };
  }

  // ---------- review flow ----------

  function runReview() {
    const text = $("#design-input").value.trim();
    if (!text) {
      $("#review-status").textContent = "Enter an architecture description first.";
      return;
    }
    const workloadType = $("#workload-type").value;
    const findings = evaluate(text);
    const scores = computeScores(findings);
    const csrMatches = matchCsr(text);
    const meta = { workloadType, timestamp: new Date().toISOString(), textLength: text.length };

    state.lastReview = { text, findings, scores, csrMatches, meta };
    renderResults(findings, scores, meta, csrMatches);
    $("#review-status").textContent = "Review complete.";
    $("#btn-export").hidden = false;

    saveHistoryEntry({
      id: `r_${Date.now()}`,
      ts: meta.timestamp,
      workloadType,
      overall: scores.overall,
      counts: countByStatus(findings),
      csrFlagCount: csrMatches.filter((m) => m.entry.status === "retired" || m.entry.status === "sunset").length,
      snippet: text.slice(0, 160),
      text,
    });

    maybeRunAINarrative(text, findings, scores);
  }

  function countByStatus(findings) {
    const c = { violation: 0, exception: 0, gap: 0, pass: 0 };
    findings.forEach((f) => c[f.status]++);
    return c;
  }

  function scoreColor(score) {
    if (score >= 80) return "var(--pass)";
    if (score >= 50) return "var(--exception)";
    return "var(--violation)";
  }

  function renderResults(findings, scores, meta, csrMatches) {
    $("#results-empty").hidden = true;
    const content = $("#results-content");
    content.hidden = false;
    content.innerHTML = "";

    // score summary
    const summary = document.createElement("div");
    summary.className = "score-summary";
    summary.innerHTML = `
      <div class="score-ring" style="border-color:${scoreColor(scores.overall)};color:${scoreColor(scores.overall)}">${scores.overall}</div>
      <div class="pillar-bars">
        ${scores.pillarScores
          .map(
            (p) => `
          <div class="pillar-bar-row">
            <span>${escapeHtml(p.name)}</span>
            <span class="pillar-bar-track"><span class="pillar-bar-fill" style="width:${p.score}%;background:${scoreColor(p.score)}"></span></span>
            <span>${p.score}%</span>
          </div>`
          )
          .join("")}
      </div>
    `;
    content.appendChild(summary);

    if (meta.workloadType) {
      const wl = document.createElement("p");
      wl.className = "panel-desc";
      wl.textContent = `Workload type: ${$("#workload-type").selectedOptions[0].textContent}`;
      content.appendChild(wl);
    }

    renderCsrSection(content, csrMatches || []);

    const groups = ["violation", "exception", "gap", "pass"];
    for (const status of groups) {
      const items = findings.filter((f) => f.status === status);
      if (!items.length) continue;
      const group = document.createElement("div");
      group.className = "finding-group";
      const h3 = document.createElement("h3");
      h3.innerHTML = `${SEVERITY_META[status].label} <span class="count-badge">${items.length}</span>`;
      group.appendChild(h3);

      if (status === "pass") {
        const details = document.createElement("details");
        const summaryEl = document.createElement("summary");
        summaryEl.style.cursor = "pointer";
        summaryEl.style.fontSize = "13px";
        summaryEl.style.color = "var(--text-muted)";
        summaryEl.textContent = "Show passed rules";
        details.appendChild(summaryEl);
        items.forEach((f) => details.appendChild(findingCard(f)));
        group.appendChild(details);
      } else {
        items.forEach((f) => group.appendChild(findingCard(f)));
      }
      content.appendChild(group);
    }
  }

  function findingCard(f) {
    const card = document.createElement("div");
    card.className = `finding-card ${f.status}`;
    const r = f.rule;
    card.innerHTML = `
      <div class="finding-head">
        <span class="rule-id">${escapeHtml(r.id)}</span>
        <strong>${escapeHtml(r.title)}</strong>
        <span class="pill pillar-pill">${escapeHtml(pillarName(r.pillar))}</span>
      </div>
      <p class="finding-req">${escapeHtml(r.requirement)}</p>
      ${f.status !== "pass" ? `<p class="finding-rec">${escapeHtml(r.recommendation || "")}</p>` : ""}
      ${f.evidence ? `<p class="finding-evidence">Matched: "${escapeHtml(f.evidence)}"</p>` : ""}
      ${f.note ? `<p class="finding-evidence">${escapeHtml(f.note)}</p>` : ""}
    `;
    return card;
  }

  function csrStatusName(statusId) {
    const s = state.csrPack.statuses.find((x) => x.id === statusId);
    return s ? s.name : statusId;
  }

  function renderCsrSection(content, csrMatches) {
    const section = document.createElement("div");
    section.className = "finding-group";
    const h3 = document.createElement("h3");
    h3.innerHTML = `Cloud Service Roadmap <span class="count-badge">${csrMatches.length}</span>`;
    section.appendChild(h3);

    if (!csrMatches.length) {
      const note = document.createElement("p");
      note.className = "finding-evidence";
      note.textContent = "No technologies from the master CSR were recognized in this text. This only checks entries tracked in the Cloud Roadmap tab — an unmatched mention isn't thereby approved, it just isn't tracked yet.";
      section.appendChild(note);
      content.appendChild(section);
      return;
    }

    const flagCount = csrMatches.filter((m) => m.entry.status === "retired" || m.entry.status === "sunset").length;
    const trialCount = csrMatches.filter((m) => m.entry.status === "emerging").length;
    const summaryLine = document.createElement("p");
    summaryLine.className = "finding-evidence";
    summaryLine.textContent = `${csrMatches.length} technolog${csrMatches.length === 1 ? "y" : "ies"} recognized` +
      (flagCount ? ` — ${flagCount} flagged for migration/removal` : "") +
      (trialCount ? `, ${trialCount} in trial (needs approval)` : "") + ".";
    section.appendChild(summaryLine);

    for (const group of CSR_GROUPS) {
      const items = csrMatches.filter((m) => group.statuses.includes(m.entry.status));
      if (!items.length) continue;
      const sub = document.createElement("div");
      sub.style.margin = "10px 0";
      const subHead = document.createElement("p");
      subHead.style.fontSize = "12.5px";
      subHead.style.fontWeight = "700";
      subHead.style.color = "var(--text-muted)";
      subHead.style.margin = "0 0 6px";
      subHead.textContent = `${group.label} (${items.length})`;
      sub.appendChild(subHead);
      items.forEach((m) => sub.appendChild(csrMatchCard(m)));
      section.appendChild(sub);
    }

    content.appendChild(section);
  }

  function csrMatchCard(match) {
    const { entry, matchedTerm } = match;
    const card = document.createElement("div");
    card.className = `finding-card ${csrPillClass(entry.status)}`;
    card.innerHTML = `
      <div class="finding-head">
        <span class="rule-id">${escapeHtml(entry.id)}</span>
        <strong>${escapeHtml(entry.name)}</strong>
        <span class="pill pillar-pill">${escapeHtml(entry.category)}</span>
        <span class="pill ${csrPillClass(entry.status)}">${escapeHtml(csrStatusName(entry.status))}</span>
      </div>
      ${entry.notes ? `<p class="finding-req">${escapeHtml(entry.notes)}</p>` : ""}
      ${entry.replacement ? `<p class="finding-rec">Migrate to: ${escapeHtml(entry.replacement)}${entry.migrateBy ? ` (by ${escapeHtml(entry.migrateBy)})` : ""}</p>` : ""}
      <p class="finding-evidence">Matched: "${escapeHtml(matchedTerm)}"</p>
    `;
    return card;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- export ----------

  function exportReport() {
    if (!state.lastReview) return;
    const { findings, scores, meta, text, csrMatches } = state.lastReview;
    const lines = [];
    lines.push(`# Architecture Validation Report`);
    lines.push(``);
    lines.push(`Generated: ${meta.timestamp}`);
    if (meta.workloadType) lines.push(`Workload type: ${meta.workloadType}`);
    lines.push(`Overall score: ${scores.overall}/100`);
    lines.push(``);
    lines.push(`## Pillar scores`);
    scores.pillarScores.forEach((p) => lines.push(`- ${p.name}: ${p.score}% (${p.pass}/${p.total} rules passed)`));
    lines.push(``);

    lines.push(`## Cloud Service Roadmap (${(csrMatches || []).length} technolog${(csrMatches || []).length === 1 ? "y" : "ies"} recognized)`);
    if (!csrMatches || !csrMatches.length) {
      lines.push(`_No technologies from the master CSR were recognized in this text._`);
    } else {
      for (const group of CSR_GROUPS) {
        const items = csrMatches.filter((m) => group.statuses.includes(m.entry.status));
        if (!items.length) continue;
        lines.push(``);
        lines.push(`### ${group.label}`);
        items.forEach((m) => {
          lines.push(``);
          lines.push(`- **${m.entry.id} — ${m.entry.name}** (${m.entry.category}, ${csrStatusName(m.entry.status)})`);
          if (m.entry.notes) lines.push(`  ${m.entry.notes}`);
          if (m.entry.replacement) lines.push(`  Migrate to: ${m.entry.replacement}${m.entry.migrateBy ? ` (by ${m.entry.migrateBy})` : ""}`);
          lines.push(`  Matched: "${m.matchedTerm}"`);
        });
      }
    }
    lines.push(``);

    for (const status of ["violation", "exception", "gap"]) {
      const items = findings.filter((f) => f.status === status);
      lines.push(`## ${SEVERITY_META[status].label} (${items.length})`);
      if (!items.length) lines.push(`_None._`);
      items.forEach((f) => {
        lines.push(``);
        lines.push(`### ${f.rule.id} — ${f.rule.title}`);
        lines.push(`Pillar: ${pillarName(f.rule.pillar)}`);
        lines.push(`Requirement: ${f.rule.requirement}`);
        if (f.evidence) lines.push(`Matched text: "${f.evidence}"`);
        lines.push(`Recommendation: ${f.rule.recommendation || ""}`);
      });
      lines.push(``);
    }

    const passed = findings.filter((f) => f.status === "pass");
    lines.push(`## Passed (${passed.length})`);
    passed.forEach((f) => lines.push(`- ${f.rule.id} — ${f.rule.title}`));
    lines.push(``);
    lines.push(`---`);
    lines.push(`Submitted architecture text:`);
    lines.push(``);
    lines.push("```");
    lines.push(text);
    lines.push("```");

    if (state.lastReview.aiNarrative) {
      lines.push(``);
      lines.push(`## AI narrative synthesis`);
      lines.push(state.lastReview.aiNarrative);
    }

    downloadFile(`architecture-review-${Date.now()}.md`, lines.join("\n"), "text/markdown");
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- history ----------

  function saveHistoryEntry(entry) {
    state.history.unshift(entry);
    state.history = state.history.slice(0, 50);
    persistHistory();
    renderHistory();
  }

  function renderHistory() {
    const list = $("#history-list");
    if (!state.history.length) {
      list.className = "empty-state";
      list.textContent = "No reviews yet.";
      return;
    }
    list.className = "";
    list.innerHTML = "";
    state.history.forEach((h) => {
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div class="meta">
          <div>${escapeHtml(h.snippet)}${h.snippet.length >= 160 ? "…" : ""}</div>
          <div class="ts">${new Date(h.ts).toLocaleString()} · ${h.workloadType || "general"}</div>
        </div>
        <span class="pill ${h.overall >= 80 ? "pass" : h.overall >= 50 ? "exception" : "violation"}">${h.overall}%</span>
        <span class="pill violation" title="Violations">${h.counts.violation}</span>
        <span class="pill exception" title="Exceptions">${h.counts.exception}</span>
        <span class="pill gap" title="Gaps">${h.counts.gap}</span>
        ${h.csrFlagCount ? `<span class="pill sunset" title="Roadmap flags (retired/sunset)">⚠ ${h.csrFlagCount}</span>` : ""}
        <button class="btn-ghost btn-reload" type="button">Reload</button>
      `;
      item.querySelector(".btn-reload").addEventListener("click", () => {
        $("#design-input").value = h.text;
        $("#workload-type").value = h.workloadType || "";
        document.querySelector('.tab[data-tab="review"]').click();
        runReview();
      });
      list.appendChild(item);
    });
  }

  function clearHistory() {
    if (!confirm("Clear all saved review history?")) return;
    state.history = [];
    persistHistory();
    renderHistory();
  }

  // ---------- rule library ----------

  function renderRuleLibrary() {
    const list = $("#rules-list");
    list.innerHTML = "";
    const byPillar = {};
    state.rulePack.rules.forEach((r) => {
      byPillar[r.pillar] = byPillar[r.pillar] || [];
      byPillar[r.pillar].push(r);
    });
    state.rulePack.pillars.forEach((pillar) => {
      const rules = byPillar[pillar.id] || [];
      if (!rules.length) return;
      const heading = document.createElement("h3");
      heading.style.fontSize = "13px";
      heading.style.textTransform = "uppercase";
      heading.style.letterSpacing = "0.04em";
      heading.style.color = "var(--text-muted)";
      heading.style.margin = "16px 0 8px";
      heading.textContent = pillar.name;
      list.appendChild(heading);

      rules.forEach((rule) => list.appendChild(renderRuleItem(rule)));
    });
  }

  function renderRuleItem(rule) {
    const tpl = $("#rule-item-template");
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.ruleId = rule.id;
    $(".rule-id", node).textContent = rule.id;
    const sevPill = $(".severity-pill", node);
    sevPill.textContent = rule.severity;
    sevPill.classList.add(rule.severity);
    $(".pillar-pill", node).textContent = pillarName(rule.pillar);
    $(".rule-title", node).textContent = rule.title;
    $(".rule-requirement", node).textContent = rule.requirement;
    $(".rule-edit", node).addEventListener("click", () => openRuleEditor(rule));
    $(".rule-delete", node).addEventListener("click", () => deleteRule(rule.id));
    return node;
  }

  function deleteRule(id) {
    if (!confirm(`Delete rule ${id}?`)) return;
    state.rulePack.rules = state.rulePack.rules.filter((r) => r.id !== id);
    persistRulePack();
    renderRuleLibrary();
  }

  function openRuleEditor(existing) {
    closeRuleEditor();
    const isNew = !existing;
    const editor = document.createElement("div");
    editor.className = "rule-editor";
    editor.id = "active-rule-editor";
    const pillarOptions = state.rulePack.pillars.map((p) => `<option value="${p.id}" ${existing && existing.pillar === p.id ? "selected" : ""}>${p.name}</option>`).join("");

    const r = existing || {
      id: "",
      pillar: state.rulePack.pillars[0].id,
      severity: "violation",
      type: "flag",
      title: "",
      requirement: "",
      triggers: [],
      expect: [],
      exceptionKeywords: [],
      recommendation: "",
    };

    editor.innerHTML = `
      <h3 style="margin-top:0">${isNew ? "Add rule" : `Edit ${escapeHtml(r.id)}`}</h3>
      <div class="rule-editor-grid">
        <div>
          <label class="field-label">Rule ID</label>
          <input type="text" id="edit-id" value="${escapeHtml(r.id)}" ${isNew ? "" : "readonly"} placeholder="e.g. SEC-09" />
        </div>
        <div>
          <label class="field-label">Pillar</label>
          <select id="edit-pillar">${pillarOptions}</select>
        </div>
        <div>
          <label class="field-label">Severity</label>
          <select id="edit-severity">
            <option value="violation" ${r.severity === "violation" ? "selected" : ""}>Violation</option>
            <option value="exception" ${r.severity === "exception" ? "selected" : ""}>Deviation needing exception</option>
            <option value="gap" ${r.severity === "gap" ? "selected" : ""}>Well-Architected gap</option>
          </select>
        </div>
        <div>
          <label class="field-label">Rule type</label>
          <select id="edit-type">
            <option value="flag" ${r.type === "flag" ? "selected" : ""}>Flag (anti-pattern present = fail)</option>
            <option value="conditional" ${r.type === "conditional" ? "selected" : ""}>Conditional (fail unless exception documented)</option>
            <option value="require" ${r.type === "require" ? "selected" : ""}>Require (must be mentioned at all = pass)</option>
          </select>
        </div>
      </div>
      <label class="field-label">Title</label>
      <input type="text" id="edit-title" value="${escapeHtml(r.title)}" />
      <label class="field-label">Requirement (the actual rule text, cited when it fires)</label>
      <textarea id="edit-requirement" rows="2">${escapeHtml(r.requirement)}</textarea>
      <label class="field-label">Trigger phrases (comma-separated; used by Flag / Conditional types)</label>
      <input type="text" id="edit-triggers" value="${escapeHtml((r.triggers || []).join(", "))}" />
      <label class="field-label">Exception phrases (comma-separated; Conditional type only)</label>
      <input type="text" id="edit-exceptions" value="${escapeHtml((r.exceptionKeywords || []).join(", "))}" />
      <label class="field-label">Expected phrases (comma-separated; Require type — pass if any appear)</label>
      <input type="text" id="edit-expect" value="${escapeHtml((r.expect || []).join(", "))}" />
      <label class="field-label">Recommendation</label>
      <textarea id="edit-recommendation" rows="2">${escapeHtml(r.recommendation)}</textarea>
      <div class="actions-row">
        <button id="edit-save" class="btn-primary" type="button">Save rule</button>
        <button id="edit-cancel" class="btn-ghost" type="button">Cancel</button>
      </div>
    `;

    $("#rules-list").prepend(editor);
    editor.scrollIntoView({ behavior: "smooth", block: "center" });

    $("#edit-cancel", editor).addEventListener("click", closeRuleEditor);
    $("#edit-save", editor).addEventListener("click", () => {
      const id = $("#edit-id", editor).value.trim();
      if (!id) {
        alert("Rule ID is required.");
        return;
      }
      if (isNew && state.rulePack.rules.some((x) => x.id === id)) {
        alert("A rule with this ID already exists.");
        return;
      }
      const split = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
      const updated = {
        id,
        pillar: $("#edit-pillar", editor).value,
        severity: $("#edit-severity", editor).value,
        type: $("#edit-type", editor).value,
        title: $("#edit-title", editor).value.trim(),
        requirement: $("#edit-requirement", editor).value.trim(),
        triggers: split($("#edit-triggers", editor).value),
        exceptionKeywords: split($("#edit-exceptions", editor).value),
        expect: split($("#edit-expect", editor).value),
        recommendation: $("#edit-recommendation", editor).value.trim(),
      };
      if (isNew) {
        state.rulePack.rules.push(updated);
      } else {
        const idx = state.rulePack.rules.findIndex((x) => x.id === existing.id);
        state.rulePack.rules[idx] = updated;
      }
      persistRulePack();
      closeRuleEditor();
      renderRuleLibrary();
    });
  }

  function closeRuleEditor() {
    const existing = $("#active-rule-editor");
    if (existing) existing.remove();
  }

  function exportRules() {
    downloadFile(`rule-pack-${Date.now()}.json`, JSON.stringify(state.rulePack, null, 2), "application/json");
  }

  function importRulesFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.rules || !parsed.pillars) throw new Error("File must contain 'pillars' and 'rules'.");
        if (!confirm(`Import will replace your current rule pack (${state.rulePack.rules.length} rules) with "${parsed.name || "imported pack"}" (${parsed.rules.length} rules). Continue?`)) return;
        state.rulePack = parsed;
        persistRulePack();
        renderRuleLibrary();
      } catch (e) {
        alert("Could not import file: " + e.message);
      }
    };
    reader.readAsText(file);
  }

  async function resetRulesToDefault() {
    if (!confirm("Reset the rule library to the built-in defaults? Your custom rules will be lost unless exported first.")) return;
    state.rulePack = await loadDefaultRulePack();
    persistRulePack();
    renderRuleLibrary();
  }

  // ---------- Cloud Service Roadmap (CSR) library ----------

  function renderCsrLibrary() {
    const list = $("#csr-list");
    list.innerHTML = "";
    const byCategory = {};
    state.csrPack.entries.forEach((e) => {
      byCategory[e.category] = byCategory[e.category] || [];
      byCategory[e.category].push(e);
    });
    Object.keys(byCategory)
      .sort()
      .forEach((category) => {
        const heading = document.createElement("h3");
        heading.style.fontSize = "13px";
        heading.style.textTransform = "uppercase";
        heading.style.letterSpacing = "0.04em";
        heading.style.color = "var(--text-muted)";
        heading.style.margin = "16px 0 8px";
        heading.textContent = category;
        list.appendChild(heading);
        byCategory[category].forEach((entry) => list.appendChild(renderCsrItem(entry)));
      });
  }

  function renderCsrItem(entry) {
    const tpl = $("#csr-item-template");
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.csrId = entry.id;
    $(".rule-id", node).textContent = entry.id;
    const statusPill = $(".status-pill", node);
    statusPill.textContent = csrStatusName(entry.status);
    statusPill.classList.add(csrPillClass(entry.status));
    $(".category-pill", node).textContent = entry.category;
    $(".csr-title", node).textContent = entry.name;
    $(".csr-notes", node).textContent = entry.notes + (entry.replacement ? ` Migrate to: ${entry.replacement}${entry.migrateBy ? ` (by ${entry.migrateBy})` : ""}.` : "");
    $(".csr-edit", node).addEventListener("click", () => openCsrEditor(entry));
    $(".csr-delete", node).addEventListener("click", () => deleteCsrEntry(entry.id));
    return node;
  }

  function deleteCsrEntry(id) {
    if (!confirm(`Delete CSR entry ${id}?`)) return;
    state.csrPack.entries = state.csrPack.entries.filter((e) => e.id !== id);
    persistCsrPack();
    renderCsrLibrary();
  }

  function openCsrEditor(existing) {
    closeCsrEditor();
    const isNew = !existing;
    const editor = document.createElement("div");
    editor.className = "rule-editor";
    editor.id = "active-csr-editor";
    const statusOptions = state.csrPack.statuses
      .map((s) => `<option value="${s.id}" ${existing && existing.status === s.id ? "selected" : ""}>${s.name}</option>`)
      .join("");
    const categoryList = [...new Set(state.csrPack.entries.map((e) => e.category))].sort();

    const e = existing || {
      id: "",
      name: "",
      category: "",
      status: state.csrPack.statuses[0].id,
      aliases: [],
      replacement: "",
      migrateBy: "",
      notes: "",
    };

    editor.innerHTML = `
      <h3 style="margin-top:0">${isNew ? "Add technology" : `Edit ${escapeHtml(e.id)}`}</h3>
      <div class="rule-editor-grid">
        <div>
          <label class="field-label">Entry ID</label>
          <input type="text" id="edit-csr-id" value="${escapeHtml(e.id)}" ${isNew ? "" : "readonly"} placeholder="e.g. CSR-045" />
        </div>
        <div>
          <label class="field-label">Status</label>
          <select id="edit-csr-status">${statusOptions}</select>
        </div>
      </div>
      <label class="field-label">Technology name</label>
      <input type="text" id="edit-csr-name" value="${escapeHtml(e.name)}" />
      <label class="field-label">Category</label>
      <input type="text" id="edit-csr-category" value="${escapeHtml(e.category)}" list="csr-category-list" placeholder="e.g. Compute" />
      <datalist id="csr-category-list">${categoryList.map((c) => `<option value="${escapeHtml(c)}">`).join("")}</datalist>
      <label class="field-label">Aliases (comma-separated — alternate names matched during review)</label>
      <input type="text" id="edit-csr-aliases" value="${escapeHtml((e.aliases || []).join(", "))}" />
      <div class="rule-editor-grid">
        <div>
          <label class="field-label">Migrate to (replacement, if sunset/retired)</label>
          <input type="text" id="edit-csr-replacement" value="${escapeHtml(e.replacement || "")}" />
        </div>
        <div>
          <label class="field-label">Migrate by (optional, free text)</label>
          <input type="text" id="edit-csr-migrateby" value="${escapeHtml(e.migrateBy || "")}" placeholder="e.g. Q4 2026" />
        </div>
      </div>
      <label class="field-label">Notes / rationale</label>
      <textarea id="edit-csr-notes" rows="2">${escapeHtml(e.notes || "")}</textarea>
      <div class="actions-row">
        <button id="edit-csr-save" class="btn-primary" type="button">Save entry</button>
        <button id="edit-csr-cancel" class="btn-ghost" type="button">Cancel</button>
      </div>
    `;

    $("#csr-list").prepend(editor);
    editor.scrollIntoView({ behavior: "smooth", block: "center" });

    $("#edit-csr-cancel", editor).addEventListener("click", closeCsrEditor);
    $("#edit-csr-save", editor).addEventListener("click", () => {
      const id = $("#edit-csr-id", editor).value.trim();
      const name = $("#edit-csr-name", editor).value.trim();
      if (!id || !name) {
        alert("Entry ID and technology name are required.");
        return;
      }
      if (isNew && state.csrPack.entries.some((x) => x.id === id)) {
        alert("A CSR entry with this ID already exists.");
        return;
      }
      const split = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
      const updated = {
        id,
        name,
        category: $("#edit-csr-category", editor).value.trim() || "Uncategorized",
        status: $("#edit-csr-status", editor).value,
        aliases: split($("#edit-csr-aliases", editor).value),
        replacement: $("#edit-csr-replacement", editor).value.trim() || null,
        migrateBy: $("#edit-csr-migrateby", editor).value.trim() || null,
        notes: $("#edit-csr-notes", editor).value.trim(),
      };
      if (isNew) {
        state.csrPack.entries.push(updated);
      } else {
        const idx = state.csrPack.entries.findIndex((x) => x.id === existing.id);
        state.csrPack.entries[idx] = updated;
      }
      persistCsrPack();
      closeCsrEditor();
      renderCsrLibrary();
    });
  }

  function closeCsrEditor() {
    const existing = $("#active-csr-editor");
    if (existing) existing.remove();
  }

  function exportCsr() {
    downloadFile(`cloud-service-roadmap-${Date.now()}.json`, JSON.stringify(state.csrPack, null, 2), "application/json");
  }

  function importCsrFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.entries || !parsed.statuses) throw new Error("File must contain 'statuses' and 'entries'.");
        if (!confirm(`Import will replace your current Cloud Service Roadmap (${state.csrPack.entries.length} entries) with "${parsed.name || "imported roadmap"}" (${parsed.entries.length} entries). Continue?`)) return;
        state.csrPack = parsed;
        persistCsrPack();
        renderCsrLibrary();
      } catch (e) {
        alert("Could not import file: " + e.message);
      }
    };
    reader.readAsText(file);
  }

  async function resetCsrToDefault() {
    if (!confirm("Reset the Cloud Service Roadmap to the built-in defaults? Your custom entries will be lost unless exported first.")) return;
    state.csrPack = await loadDefaultCsrPack();
    persistCsrPack();
    renderCsrLibrary();
  }

  // ---------- AI narrative (optional) ----------

  function getAISettings() {
    return {
      enabled: localStorage.getItem(STORAGE.aiEnabled) === "true",
      key: localStorage.getItem(STORAGE.aiKey) || "",
    };
  }

  async function maybeRunAINarrative(text, findings, scores) {
    const { enabled, key } = getAISettings();
    if (!enabled || !key) return;

    const status = $("#review-status");
    status.textContent = "Review complete. Generating AI narrative…";

    const violations = findings.filter((f) => f.status === "violation");
    const exceptions = findings.filter((f) => f.status === "exception");
    const gaps = findings.filter((f) => f.status === "gap");

    const findingsSummary = [
      `Violations: ${violations.map((f) => `${f.rule.id} (${f.rule.title})`).join("; ") || "none"}`,
      `Deviations needing exception: ${exceptions.map((f) => `${f.rule.id} (${f.rule.title})`).join("; ") || "none"}`,
      `Well-Architected gaps: ${gaps.map((f) => `${f.rule.id} (${f.rule.title})`).join("; ") || "none"}`,
      `Overall score: ${scores.overall}/100`,
    ].join("\n");

    const prompt = `You are assisting an enterprise architecture review board. A rule engine already scored a submitted architecture and produced the structured findings below. Write a concise (150-200 word) plain-language narrative summary for the review board: what stands out, what's most urgent to fix before approval, and one sentence of overall risk posture. Do not repeat the raw finding list verbatim; synthesize it.\n\nFindings:\n${findingsSummary}\n\nSubmitted architecture description:\n${text.slice(0, 4000)}`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`${res.status} ${errText.slice(0, 200)}`);
      }
      const data = await res.json();
      const narrative = (data.content || []).map((b) => b.text || "").join("\n").trim();
      if (narrative) {
        state.lastReview.aiNarrative = narrative;
        renderAINarrative(narrative);
        status.textContent = "Review complete, with AI narrative.";
      } else {
        status.textContent = "Review complete. AI narrative returned empty.";
      }
    } catch (e) {
      console.warn("AI narrative failed", e);
      status.textContent = "Review complete. AI narrative failed — check your API key and network in Settings.";
    }
  }

  function renderAINarrative(text) {
    const content = $("#results-content");
    const box = document.createElement("div");
    box.className = "finding-group";
    box.innerHTML = `<h3>AI narrative synthesis</h3><div class="finding-card pass" style="border-left-color:var(--brand)">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
    content.appendChild(box);
  }

  // ---------- diagram import ----------

  async function importDiagram(file) {
    const status = $("#import-status");
    status.textContent = `Extracting text from ${file.name}…`;
    try {
      const result = await window.DiagramImport.extractArchitectureTextFromOfficeFile(file);
      const header = `(Imported from "${file.name}" — ${result.formatLabel}, ${result.unitCount} ${result.kindLabel}${result.unitCount === 1 ? "" : "s"}. These are the diagram's text labels only, not its visual layout. Review this and add anything the diagram didn't spell out — regions, RTO/RPO, scale targets, compliance scope, etc. — before running the review.)\n\n`;
      $("#design-input").value = header + result.text;
      status.textContent = `Imported ${result.unitCount} ${result.kindLabel}${result.unitCount === 1 ? "" : "s"} from ${file.name}. Review the text below before running.`;
    } catch (e) {
      console.warn("Diagram import failed", e);
      status.textContent = `Could not import: ${e.message}`;
    }
  }

  // ---------- standalone download ----------

  function safeForScriptTag(jsonOrJs) {
    // Prevents a literal "</script" inside embedded data/code from
    // prematurely closing the <script> block it's injected into.
    return jsonOrJs.replace(/<\/script/gi, "<\\/script");
  }

  async function downloadStandaloneCopy(triggerBtn) {
    const statusEl = $("#standalone-status");
    const originalBtnText = triggerBtn ? triggerBtn.textContent : null;
    const setStatus = (msg) => {
      if (statusEl) statusEl.textContent = msg;
      if (triggerBtn) triggerBtn.textContent = msg;
    };
    if (triggerBtn) triggerBtn.disabled = true;
    setStatus("Building standalone copy…");
    try {
      const [htmlRes, cssRes, diagramJsRes, appJsRes] = await Promise.all([
        fetch(location.href, { cache: "no-store" }),
        fetch("assets/style.css", { cache: "no-store" }),
        fetch("assets/diagram-import.js", { cache: "no-store" }),
        fetch("assets/app.js", { cache: "no-store" }),
      ]);
      if (!htmlRes.ok || !cssRes.ok || !diagramJsRes.ok || !appJsRes.ok) {
        throw new Error("Could not fetch page assets. This only works from the hosted site, not an already-downloaded standalone copy.");
      }
      let html = await htmlRes.text();
      const css = await cssRes.text();
      const diagramJs = await diagramJsRes.text();
      const appJs = await appJsRes.text();

      const cssTag = /<link[^>]*href=["']assets\/style\.css["'][^>]*>/;
      const diagramTag = /<script[^>]*src=["']assets\/diagram-import\.js["'][^>]*><\/script>/;
      const appTag = /<script[^>]*src=["']assets\/app\.js["'][^>]*><\/script>/;
      if (!cssTag.test(html) || !diagramTag.test(html) || !appTag.test(html)) {
        throw new Error("Page structure has changed in a way this bundler doesn't recognize — could not locate one of the asset tags.");
      }

      // Function replacers (not string replacers): a string replacement argument treats
      // "$$" in it as a special pattern (collapsed to a literal "$"), and app.js's own
      // source uses "$$" (the querySelectorAll helper) dozens of times — a string
      // replacement would silently corrupt every one of them.
      html = html.replace(cssTag, () => `<style>\n${safeForScriptTag(css)}\n</style>`);

      const embeddedData =
        `<script>\n` +
        `window.__EMBEDDED_RULES__ = ${safeForScriptTag(JSON.stringify(state.rulePack))};\n` +
        `window.__EMBEDDED_CSR__ = ${safeForScriptTag(JSON.stringify(state.csrPack))};\n` +
        `window.__STANDALONE_SNAPSHOT_AT__ = ${JSON.stringify(new Date().toISOString())};\n` +
        `</script>`;
      html = html.replace(diagramTag, () => `${embeddedData}\n<script>\n${safeForScriptTag(diagramJs)}\n</script>`);
      html = html.replace(appTag, () => `<script>\n${safeForScriptTag(appJs)}\n</script>`);

      downloadFile(`architecture-review-standalone-${Date.now()}.html`, html, "text/html");
      if (statusEl) statusEl.textContent = "Downloaded — open the file directly in a browser, no server or connection needed.";
    } catch (e) {
      console.warn("Standalone build failed", e);
      if (statusEl) statusEl.textContent = `Could not build standalone copy: ${e.message}`;
      if (triggerBtn) alert(`Could not build standalone copy: ${e.message}`);
    } finally {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = originalBtnText;
      }
    }
  }

  // ---------- sample ----------

  const FLAWED_SAMPLE = `We are building a customer-facing order management API for the retail division.

Compute: a single EC2 instance running in one availability zone hosts the API. No auto-restart configured.
Data: orders are stored in a PostgreSQL database with a public endpoint open to 0.0.0.0/0 for ease of access from the vendor's office. Encryption at rest is not configured yet.
Auth: the database password is hardcoded in the application config file that's checked into the repo. There is no MFA on the admin console, and no exception has been filed.
Networking: everything sits in a single subnet with no security groups restricting east-west traffic.
Region: deployed to a non-approved region because it was cheapest at the time.
Data classification: the API stores customer PII (names, addresses, phone numbers) - not otherwise documented.
Deployment: changes are currently applied by SSHing into the box and editing files directly in production when something breaks.
Monitoring: there is no centralized logging or alerting configured yet.
Scale: we expect roughly 200 requests per second at peak, but no latency target has been agreed.
Cost: the instance runs 24/7 at a fixed size with no autoscaling, and no budget alerts are configured.`;

  // ---------- wiring ----------

  async function init() {
    setupTabs();
    state.rulePack = await loadRulePack();
    state.csrPack = await loadCsrPack();
    state.history = loadHistory();

    renderRuleLibrary();
    renderCsrLibrary();
    renderHistory();

    $("#btn-review").addEventListener("click", runReview);
    $("#btn-clear").addEventListener("click", () => {
      $("#design-input").value = "";
      $("#review-status").textContent = "";
    });
    $("#btn-sample").addEventListener("click", () => {
      $("#design-input").value = FLAWED_SAMPLE;
    });
    $("#btn-export").addEventListener("click", exportReport);

    $("#btn-import-diagram").addEventListener("click", () => $("#file-import-diagram").click());
    $("#file-import-diagram").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importDiagram(file);
      e.target.value = "";
    });

    $("#btn-add-rule").addEventListener("click", () => openRuleEditor(null));
    $("#btn-export-rules").addEventListener("click", exportRules);
    $("#btn-import-rules").addEventListener("click", () => $("#file-import-rules").click());
    $("#file-import-rules").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importRulesFromFile(file);
      e.target.value = "";
    });
    $("#btn-reset-rules").addEventListener("click", resetRulesToDefault);

    $("#btn-add-csr").addEventListener("click", () => openCsrEditor(null));
    $("#btn-export-csr").addEventListener("click", exportCsr);
    $("#btn-import-csr").addEventListener("click", () => $("#file-import-csr").click());
    $("#file-import-csr").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importCsrFromFile(file);
      e.target.value = "";
    });
    $("#btn-reset-csr").addEventListener("click", resetCsrToDefault);

    $("#btn-download-standalone").addEventListener("click", (e) => downloadStandaloneCopy(e.currentTarget));
    $("#btn-download-standalone-top").addEventListener("click", (e) => downloadStandaloneCopy(e.currentTarget));

    $("#btn-clear-history").addEventListener("click", clearHistory);

    const { enabled, key } = getAISettings();
    $("#ai-toggle").checked = enabled;
    $("#api-key-input").value = key ? "••••••••••••" : "";
    $("#ai-toggle").addEventListener("change", (e) => {
      localStorage.setItem(STORAGE.aiEnabled, e.target.checked ? "true" : "false");
    });
    $("#btn-save-key").addEventListener("click", () => {
      const val = $("#api-key-input").value.trim();
      if (!val || val === "••••••••••••") return;
      localStorage.setItem(STORAGE.aiKey, val);
      $("#api-key-input").value = "••••••••••••";
      $("#key-status").textContent = "Key saved to this browser's local storage.";
    });
    $("#btn-clear-key").addEventListener("click", () => {
      localStorage.removeItem(STORAGE.aiKey);
      $("#api-key-input").value = "";
      $("#key-status").textContent = "Key cleared.";
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
