(() => {
  "use strict";

  const STORAGE = {
    rules: "avr.rules.v1",
    csr: "avr.csr.v2",
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

  // Badge derivation mirrors the reference Cloud Service Roadmap site: state=Allowed -> allowed;
  // state=In-Evaluation -> evaluation; state=Denied + an enterprise alternative exists -> enterprise
  // (takes priority over exceptionPossible, since "use the central service" beats "ask for an
  // exception"); state=Denied + exceptionPossible -> exception; state=Denied otherwise -> denied.
  const CSR_BADGES = {
    allowed: { label: "Allowed", icon: "✓", pillClass: "pass" },
    denied: { label: "Denied", icon: "✕", pillClass: "violation" },
    exception: { label: "Exception possible", icon: "⚠", pillClass: "exception" },
    enterprise: { label: "Enterprise service available", icon: "⬢", pillClass: "enterprise" },
    evaluation: { label: "In evaluation", icon: "⏳", pillClass: "evaluation" },
  };

  const CSR_GROUPS = [
    { keys: ["denied"], label: "Denied" },
    { keys: ["exception"], label: "Exception possible" },
    { keys: ["enterprise"], label: "Enterprise service available instead" },
    { keys: ["evaluation"], label: "In evaluation" },
    { keys: ["allowed"], label: "Allowed" },
  ];

  function csrBadgeKey(entry, subscriptionType) {
    const status = entry.status[subscriptionType];
    if (!status) return "evaluation";
    if (status.state === "Allowed") return "allowed";
    if (status.state === "In-Evaluation") return "evaluation";
    if (entry.enterpriseServiceAlternative) return "enterprise";
    if (status.exceptionPossible) return "exception";
    return "denied";
  }

  function subscriptionTypeName(id) {
    const t = (state.csrPack.subscriptionTypes || []).find((x) => x.id === id);
    return t ? t.name : id;
  }

  function regionName(id) {
    const r = (state.csrPack.regions || []).find((x) => x.id === id);
    return r ? r.name : id;
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

  function matchRegions(text) {
    const lower = text.toLowerCase();
    const matches = [];
    for (const region of state.csrPack.regions || []) {
      if (lower.includes(region.name.toLowerCase()) || lower.includes(region.id.toLowerCase())) {
        matches.push(region);
      }
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
    const subscriptionType = $("#subscription-type").value;
    const findings = evaluate(text);
    const scores = computeScores(findings);
    const csrMatches = matchCsr(text);
    const regionMatches = matchRegions(text);
    const meta = { workloadType, subscriptionType, timestamp: new Date().toISOString(), textLength: text.length };

    state.lastReview = { text, findings, scores, csrMatches, regionMatches, meta };
    renderResults(findings, scores, meta, csrMatches, regionMatches);
    $("#review-status").textContent = "Review complete.";
    $("#btn-export").hidden = false;

    saveHistoryEntry({
      id: `r_${Date.now()}`,
      ts: meta.timestamp,
      workloadType,
      subscriptionType,
      overall: scores.overall,
      counts: countByStatus(findings),
      csrFlagCount: csrMatches.filter((m) => csrBadgeKey(m.entry, subscriptionType) === "denied").length,
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

  function renderResults(findings, scores, meta, csrMatches, regionMatches) {
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

    renderCsrSection(content, csrMatches || [], meta.subscriptionType, regionMatches || []);

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

  function renderCsrSection(content, csrMatches, subscriptionType, regionMatches) {
    const section = document.createElement("div");
    section.className = "finding-group";
    const h3 = document.createElement("h3");
    h3.innerHTML = `Cloud Service Roadmap <span class="count-badge">${csrMatches.length}</span>`;
    section.appendChild(h3);

    const subLine = document.createElement("p");
    subLine.className = "finding-evidence";
    subLine.textContent = `Checked against: ${subscriptionTypeName(subscriptionType)}` +
      (regionMatches.length ? ` · Region(s) mentioned: ${regionMatches.map((r) => r.name).join(", ")}` : "");
    section.appendChild(subLine);

    if (!csrMatches.length) {
      const note = document.createElement("p");
      note.className = "finding-evidence";
      note.textContent = "No services from the master Cloud Service Roadmap were recognized in this text. This only checks entries tracked in the Cloud Roadmap tab — an unmatched mention isn't thereby approved, it just isn't tracked yet.";
      section.appendChild(note);
      content.appendChild(section);
      return;
    }

    for (const group of CSR_GROUPS) {
      const items = csrMatches.filter((m) => group.keys.includes(csrBadgeKey(m.entry, subscriptionType)));
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
      items.forEach((m) => sub.appendChild(csrMatchCard(m, subscriptionType, regionMatches)));
      section.appendChild(sub);
    }

    content.appendChild(section);
  }

  function csrMatchCard(match, subscriptionType, regionMatches) {
    const { entry, matchedTerm } = match;
    const status = entry.status[subscriptionType] || {};
    const badgeKey = csrBadgeKey(entry, subscriptionType);
    const badge = CSR_BADGES[badgeKey];
    const allowedRegions = (entry.allowedRegions && entry.allowedRegions[subscriptionType]) || [];

    let regionNote = "";
    if (badgeKey === "allowed" || badgeKey === "exception" || badgeKey === "enterprise") {
      if (!allowedRegions.length) {
        regionNote = `<p class="finding-evidence">No regions pre-approved for ${escapeHtml(subscriptionTypeName(subscriptionType))} — case by case only.</p>`;
      } else if (regionMatches.length) {
        const outside = regionMatches.filter((r) => !allowedRegions.includes(r.id));
        if (outside.length) {
          regionNote = `<p class="finding-evidence">⚠ Mentioned region${outside.length === 1 ? "" : "s"} not pre-approved for this status: ${escapeHtml(outside.map((r) => r.name).join(", "))}. Approved regions: ${escapeHtml(allowedRegions.map(regionName).join(", "))}.</p>`;
        }
      }
    }

    const exceptionLine =
      status.exceptionPossible && status.exceptionLink
        ? `<p class="finding-rec">Exception possible: request via <a href="${escapeHtml(status.exceptionLink)}" target="_blank" rel="noopener">the Exception Catalog</a>.</p>`
        : "";

    const enterpriseLine = entry.enterpriseServiceAlternative
      ? `<p class="finding-rec">Use the central enterprise service instead: <strong>${escapeHtml(entry.enterpriseServiceAlternative.name)}</strong> — ${escapeHtml(entry.enterpriseServiceAlternative.description || "")}${entry.enterpriseServiceAlternative.link ? ` (<a href="${escapeHtml(entry.enterpriseServiceAlternative.link)}" target="_blank" rel="noopener">details</a>)` : ""}</p>`
      : "";

    const card = document.createElement("div");
    card.className = `finding-card ${badge.pillClass}`;
    card.innerHTML = `
      <div class="finding-head">
        <span class="rule-id">${escapeHtml(entry.id)}</span>
        <strong>${escapeHtml(entry.name)}</strong>
        <span class="pill pillar-pill">${escapeHtml(entry.category)}</span>
        <span class="pill ${badge.pillClass}">${badge.icon} ${escapeHtml(badge.label)}</span>
      </div>
      ${status.notes ? `<p class="finding-req">${escapeHtml(status.notes)}</p>` : ""}
      ${exceptionLine}
      ${enterpriseLine}
      ${regionNote}
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
    const { findings, scores, meta, text, csrMatches, regionMatches } = state.lastReview;
    const lines = [];
    lines.push(`# Architecture Validation Report`);
    lines.push(``);
    lines.push(`Generated: ${meta.timestamp}`);
    if (meta.workloadType) lines.push(`Workload type: ${meta.workloadType}`);
    if (meta.subscriptionType) lines.push(`Subscription type: ${subscriptionTypeName(meta.subscriptionType)}`);
    lines.push(`Overall score: ${scores.overall}/100`);
    lines.push(``);
    lines.push(`## Pillar scores`);
    scores.pillarScores.forEach((p) => lines.push(`- ${p.name}: ${p.score}% (${p.pass}/${p.total} rules passed)`));
    lines.push(``);

    lines.push(`## Cloud Service Roadmap (${(csrMatches || []).length} service${(csrMatches || []).length === 1 ? "" : "s"} recognized, checked against ${subscriptionTypeName(meta.subscriptionType)})`);
    if (regionMatches && regionMatches.length) lines.push(`Region(s) mentioned: ${regionMatches.map((r) => r.name).join(", ")}`);
    if (!csrMatches || !csrMatches.length) {
      lines.push(`_No services from the master Cloud Service Roadmap were recognized in this text._`);
    } else {
      for (const group of CSR_GROUPS) {
        const items = csrMatches.filter((m) => group.keys.includes(csrBadgeKey(m.entry, meta.subscriptionType)));
        if (!items.length) continue;
        lines.push(``);
        lines.push(`### ${group.label}`);
        items.forEach((m) => {
          const status = m.entry.status[meta.subscriptionType] || {};
          lines.push(``);
          lines.push(`- **${m.entry.id} — ${m.entry.name}** (${m.entry.category})`);
          if (status.notes) lines.push(`  ${status.notes}`);
          if (status.exceptionPossible && status.exceptionLink) lines.push(`  Exception possible: ${status.exceptionLink}`);
          if (m.entry.enterpriseServiceAlternative) lines.push(`  Enterprise alternative: ${m.entry.enterpriseServiceAlternative.name} — ${m.entry.enterpriseServiceAlternative.link || ""}`);
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
        ${h.csrFlagCount ? `<span class="pill violation" title="Denied services">⚠ ${h.csrFlagCount}</span>` : ""}
        <button class="btn-ghost btn-reload" type="button">Reload</button>
      `;
      item.querySelector(".btn-reload").addEventListener("click", () => {
        $("#design-input").value = h.text;
        $("#workload-type").value = h.workloadType || "";
        $("#subscription-type").value = h.subscriptionType || "vnet";
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
    renderEnterpriseServices();
    renderRegionsList();
  }

  function renderCsrItem(entry) {
    const tpl = $("#csr-item-template");
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.csrId = entry.id;
    $(".rule-id", node).textContent = entry.id;
    const statusPill = $(".status-pill", node);
    const vnetKey = csrBadgeKey(entry, "vnet");
    const extKey = csrBadgeKey(entry, "external");
    statusPill.innerHTML = `vNET: ${CSR_BADGES[vnetKey].icon} ${escapeHtml(CSR_BADGES[vnetKey].label)}`;
    statusPill.classList.add(CSR_BADGES[vnetKey].pillClass);
    const extPill = document.createElement("span");
    extPill.className = `pill ${CSR_BADGES[extKey].pillClass}`;
    extPill.textContent = `External: ${CSR_BADGES[extKey].icon} ${CSR_BADGES[extKey].label}`;
    statusPill.after(extPill);
    $(".category-pill", node).textContent = entry.category;
    $(".csr-title", node).textContent = entry.name;
    $(".csr-notes", node).textContent = entry.description || "";
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

  function statusEditorBlock(subType, label, status) {
    const s = { state: "In-Evaluation", exceptionPossible: false, notes: "", exceptionLink: "", ...(status || {}) };
    return `
      <fieldset style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:10px;">
        <legend style="padding:0 6px;font-size:12.5px;font-weight:700;color:var(--text-muted);">${escapeHtml(label)}</legend>
        <label class="field-label">State</label>
        <select id="edit-csr-${subType}-state">
          <option value="Allowed" ${s.state === "Allowed" ? "selected" : ""}>Allowed</option>
          <option value="Denied" ${s.state === "Denied" ? "selected" : ""}>Denied</option>
          <option value="In-Evaluation" ${s.state === "In-Evaluation" ? "selected" : ""}>In-Evaluation</option>
        </select>
        <label class="field-label">Notes</label>
        <textarea id="edit-csr-${subType}-notes" rows="2">${escapeHtml(s.notes || "")}</textarea>
        <label class="field-label"><input type="checkbox" id="edit-csr-${subType}-exception" ${s.exceptionPossible ? "checked" : ""} /> Exception possible (Denied only)</label>
        <label class="field-label">Exception link (optional)</label>
        <input type="text" id="edit-csr-${subType}-exceptionlink" value="${escapeHtml(s.exceptionLink || "")}" placeholder="https://..." />
        <label class="field-label">Allowed regions (comma-separated region IDs)</label>
        <input type="text" id="edit-csr-${subType}-regions" list="csr-region-list" placeholder="e.g. westeurope, eastus" />
      </fieldset>
    `;
  }

  function openCsrEditor(existing) {
    closeCsrEditor();
    const isNew = !existing;
    const editor = document.createElement("div");
    editor.className = "rule-editor";
    editor.id = "active-csr-editor";
    const categoryList = [...new Set(state.csrPack.entries.map((e) => e.category))].sort();
    const enterpriseOptions = (state.csrPack.enterpriseServices || [])
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join("");

    const e = existing || {
      id: "",
      name: "",
      category: "",
      description: "",
      aliases: [],
      tags: [],
      lastReviewed: "",
      status: { vnet: {}, external: {} },
      allowedRegions: { vnet: [], external: [] },
      enterpriseServiceAlternative: null,
    };

    editor.innerHTML = `
      <h3 style="margin-top:0">${isNew ? "Add service" : `Edit ${escapeHtml(e.id)}`}</h3>
      <datalist id="csr-region-list">${(state.csrPack.regions || []).map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join("")}</datalist>
      <div class="rule-editor-grid">
        <div>
          <label class="field-label">Entry ID (slug)</label>
          <input type="text" id="edit-csr-id" value="${escapeHtml(e.id)}" ${isNew ? "" : "readonly"} placeholder="e.g. azure-example-service" />
        </div>
        <div>
          <label class="field-label">Category</label>
          <input type="text" id="edit-csr-category" value="${escapeHtml(e.category)}" list="csr-category-list" placeholder="e.g. Compute" />
          <datalist id="csr-category-list">${categoryList.map((c) => `<option value="${escapeHtml(c)}">`).join("")}</datalist>
        </div>
      </div>
      <label class="field-label">Service name</label>
      <input type="text" id="edit-csr-name" value="${escapeHtml(e.name)}" />
      <label class="field-label">Description</label>
      <textarea id="edit-csr-description" rows="2">${escapeHtml(e.description || "")}</textarea>
      <label class="field-label">Aliases (comma-separated — alternate names matched during review)</label>
      <input type="text" id="edit-csr-aliases" value="${escapeHtml((e.aliases || []).join(", "))}" />
      <label class="field-label">Tags (comma-separated)</label>
      <input type="text" id="edit-csr-tags" value="${escapeHtml((e.tags || []).join(", "))}" />
      <label class="field-label">Last reviewed</label>
      <input type="text" id="edit-csr-lastreviewed" value="${escapeHtml(e.lastReviewed || "")}" placeholder="YYYY-MM-DD" />

      ${statusEditorBlock("vnet", "vNET / Private status", e.status.vnet)}
      ${statusEditorBlock("external", "External / Public status", e.status.external)}

      <fieldset style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:10px;">
        <legend style="padding:0 6px;font-size:12.5px;font-weight:700;color:var(--text-muted);">Enterprise service alternative (optional)</legend>
        <label class="field-label">If denied, point to a centrally managed alternative</label>
        <select id="edit-csr-enterprise-alt">
          <option value="">— None —</option>
          ${enterpriseOptions}
        </select>
      </fieldset>

      <div class="actions-row">
        <button id="edit-csr-save" class="btn-primary" type="button">Save entry</button>
        <button id="edit-csr-cancel" class="btn-ghost" type="button">Cancel</button>
      </div>
    `;

    $("#csr-list").prepend(editor);
    $(`#edit-csr-vnet-regions`, editor).value = ((e.allowedRegions && e.allowedRegions.vnet) || []).join(", ");
    $(`#edit-csr-external-regions`, editor).value = ((e.allowedRegions && e.allowedRegions.external) || []).join(", ");
    $("#edit-csr-enterprise-alt", editor).value = (e.enterpriseServiceAlternative && e.enterpriseServiceAlternative.id) || "";
    editor.scrollIntoView({ behavior: "smooth", block: "center" });

    $("#edit-csr-cancel", editor).addEventListener("click", closeCsrEditor);
    $("#edit-csr-save", editor).addEventListener("click", () => {
      const id = $("#edit-csr-id", editor).value.trim();
      const name = $("#edit-csr-name", editor).value.trim();
      if (!id || !name) {
        alert("Entry ID and service name are required.");
        return;
      }
      if (isNew && state.csrPack.entries.some((x) => x.id === id)) {
        alert("A CSR entry with this ID already exists.");
        return;
      }
      const split = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
      const readStatus = (subType) => ({
        state: $(`#edit-csr-${subType}-state`, editor).value,
        notes: $(`#edit-csr-${subType}-notes`, editor).value.trim(),
        exceptionPossible: $(`#edit-csr-${subType}-exception`, editor).checked,
        exceptionLink: $(`#edit-csr-${subType}-exceptionlink`, editor).value.trim() || undefined,
      });
      const altId = $("#edit-csr-enterprise-alt", editor).value;
      const altService = altId ? (state.csrPack.enterpriseServices || []).find((s) => s.id === altId) : null;
      const updated = {
        id,
        name,
        category: $("#edit-csr-category", editor).value.trim() || "Uncategorized",
        description: $("#edit-csr-description", editor).value.trim(),
        aliases: split($("#edit-csr-aliases", editor).value),
        tags: split($("#edit-csr-tags", editor).value),
        lastReviewed: $("#edit-csr-lastreviewed", editor).value.trim() || null,
        status: { vnet: readStatus("vnet"), external: readStatus("external") },
        allowedRegions: {
          vnet: split($("#edit-csr-vnet-regions", editor).value),
          external: split($("#edit-csr-external-regions", editor).value),
        },
        enterpriseServiceAlternative: altService
          ? { id: altService.id, name: altService.name, description: altService.description, link: altService.link }
          : null,
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
        if (!parsed.entries) throw new Error("File must contain an 'entries' array.");
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

  // ---------- Enterprise service alternatives & regions (reference sub-sections) ----------

  function renderEnterpriseServices() {
    const host = $("#enterprise-services-list");
    if (!host) return;
    host.innerHTML = "";
    (state.csrPack.enterpriseServices || []).forEach((s) => {
      const card = document.createElement("div");
      card.className = "rule-item";
      card.innerHTML = `
        <header class="rule-item-head">
          <span class="rule-id">${escapeHtml(s.id)}</span>
          <span class="pill pillar-pill">${escapeHtml(s.category || "")}</span>
          <button class="btn-icon ent-delete" type="button" title="Delete">🗑️</button>
        </header>
        <h3 class="rule-title">${escapeHtml(s.name)}</h3>
        <p class="rule-requirement">${escapeHtml(s.description || "")}${s.owner ? ` Owner: ${escapeHtml(s.owner)}.` : ""}${s.link ? ` <a href="${escapeHtml(s.link)}" target="_blank" rel="noopener">Details</a>` : ""}</p>
      `;
      $(".ent-delete", card).addEventListener("click", () => {
        if (!confirm(`Delete enterprise service "${s.name}"? Entries referencing it will keep a stale reference until re-saved.`)) return;
        state.csrPack.enterpriseServices = state.csrPack.enterpriseServices.filter((x) => x.id !== s.id);
        persistCsrPack();
        renderCsrLibrary();
      });
      host.appendChild(card);
    });
  }

  function openEnterpriseEditor() {
    const id = prompt("Enterprise service ID (slug, e.g. enterprise-ai-foundry):");
    if (!id) return;
    if ((state.csrPack.enterpriseServices || []).some((s) => s.id === id)) {
      alert("An enterprise service with this ID already exists.");
      return;
    }
    const name = prompt("Name:") || id;
    const category = prompt("Category:") || "";
    const description = prompt("Description:") || "";
    const owner = prompt("Owner (team name):") || "";
    const link = prompt("Link (optional):") || "";
    state.csrPack.enterpriseServices = state.csrPack.enterpriseServices || [];
    state.csrPack.enterpriseServices.push({ id, name, category, description, owner, link });
    persistCsrPack();
    renderCsrLibrary();
  }

  function renderRegionsList() {
    const host = $("#regions-list");
    if (!host) return;
    host.innerHTML = "";
    (state.csrPack.regions || []).forEach((r) => {
      const card = document.createElement("div");
      card.className = "rule-item";
      card.innerHTML = `
        <header class="rule-item-head">
          <span class="rule-id">${escapeHtml(r.id)}</span>
          <span class="pill ${r.vnetAvailable ? "pass" : "violation"}">vNET: ${r.vnetAvailable ? "✓" : "✕"}</span>
          <span class="pill ${r.externalAvailable ? "pass" : "violation"}">External: ${r.externalAvailable ? "✓" : "✕"}</span>
          <button class="btn-icon region-delete" type="button" title="Delete">🗑️</button>
        </header>
        <h3 class="rule-title">${escapeHtml(r.name)}</h3>
        <p class="rule-requirement">${escapeHtml(r.notes || "")}</p>
      `;
      $(".region-delete", card).addEventListener("click", () => {
        if (!confirm(`Delete region "${r.name}"?`)) return;
        state.csrPack.regions = state.csrPack.regions.filter((x) => x.id !== r.id);
        persistCsrPack();
        renderCsrLibrary();
      });
      host.appendChild(card);
    });
  }

  function openRegionEditor() {
    const id = prompt("Region ID (Azure region slug, e.g. eastus2):");
    if (!id) return;
    if ((state.csrPack.regions || []).some((r) => r.id === id)) {
      alert("A region with this ID already exists.");
      return;
    }
    const name = prompt("Region display name:") || id;
    const vnetAvailable = confirm("Available for vNET / Private subscriptions? OK = yes, Cancel = no");
    const externalAvailable = confirm("Available for External / Public subscriptions? OK = yes, Cancel = no");
    const notes = prompt("Notes (optional):") || "";
    state.csrPack.regions = state.csrPack.regions || [];
    state.csrPack.regions.push({ id, name, vnetAvailable, externalAvailable, notes });
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
    $("#btn-add-enterprise-service").addEventListener("click", openEnterpriseEditor);
    $("#btn-add-region").addEventListener("click", openRegionEditor);

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
