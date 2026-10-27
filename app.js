/* Webref Visualized — force-directed graph of spec references, plus a
 * radial "dive" view of one spec's definitions and who links to them.
 * Renders with <canvas> (≈770 nodes / ≈7.7k edges is too many for SVG).
 * Data is fetched live from the webref crawl by data.js.
 */
(async () => {
  "use strict";

  // ---------- Loading overlay --------------------------------------------------

  const loadingEl = document.getElementById("loading");
  const loadingText = document.getElementById("loading-text");
  const loadingBar = document.getElementById("loading-bar");
  const loadingDetail = document.getElementById("loading-detail");
  function showProgress(text, frac = null, detail = "") {
    loadingEl.classList.remove("done");
    loadingText.textContent = text;
    loadingDetail.textContent = detail;
    loadingBar.parentElement.classList.toggle("indeterminate", frac == null);
    loadingBar.style.width = `${Math.round((frac ?? 0) * 100)}%`;
  }
  function hideProgress() { loadingEl.classList.add("done"); }
  function progressReporter(labels) {
    return ({ phase, done, total }) => {
      const label = labels[phase] || phase;
      if (phase === "index") showProgress(label, null, WebrefData.base);
      else showProgress(label, total ? done / total : null, `${done.toLocaleString()} / ${total.toLocaleString()}`);
    };
  }

  // ---------- Data ------------------------------------------------------------

  let graph;
  try {
    graph = await WebrefData.loadGraph(progressReporter({
      index: "Fetching the spec index…",
      refs: "Loading each spec's references…",
    }));
  } catch (e) {
    showProgress("Could not load the webref crawl.", 0, `${e.message} — base: ${WebrefData.base}`);
    throw e;
  }
  showProgress("Laying out the graph…", null);

  const rawNodes = graph.nodes;
  const rawNodeById = new Map(rawNodes.map((n) => [n.id, n]));
  const rawLinks = graph.links.map((l) => ({
    source: rawNodeById.get(l.source),
    target: rawNodeById.get(l.target),
    kind: l.kind,
  }));
  for (const n of rawNodes) {
    n.r = 3 + Math.sqrt(n.inDegree) * 1.35;
    n.label = n.shortTitle || n.id;
  }

  // Collapsed variant: every multi-member series becomes one node, with the
  // members' references merged (normative wins) and self-references dropped.
  const seriesNodes = (graph.series || []).map((s) => ({
    ...s,
    isSeries: true,
    memberNodes: s.members.map((m) => rawNodeById.get(m)).filter(Boolean),
    label: s.shortTitle || s.series,
    standing: "good", composition: "full", hasRefs: true,
  }));
  const memberToSeries = new Map();
  for (const s of seriesNodes) for (const m of s.memberNodes) memberToSeries.set(m, s);
  const collapsedNodes = [...rawNodes.filter((n) => !memberToSeries.has(n)), ...seriesNodes];
  const collapsedLinks = (() => {
    const map = new Map();
    for (const l of rawLinks) {
      const s = memberToSeries.get(l.source) || l.source;
      const t = memberToSeries.get(l.target) || l.target;
      if (s === t) continue;
      const key = s.id + "\u0000" + t.id;
      const cur = map.get(key);
      if (!cur) map.set(key, { source: s, target: t, kind: l.kind });
      else if (l.kind === "normative") cur.kind = "normative";
    }
    return [...map.values()];
  })();
  {
    const inD = new Map(), outD = new Map();
    for (const l of collapsedLinks) {
      outD.set(l.source, (outD.get(l.source) || 0) + 1);
      inD.set(l.target, (inD.get(l.target) || 0) + 1);
    }
    for (const s of seriesNodes) {
      s.inDegree = inD.get(s) || 0; s.outDegree = outD.get(s) || 0;
      s.r = 3 + Math.sqrt(s.inDegree) * 1.35;
    }
  }

  // The "current" node/link sets; swapped by setCollapse().
  let nodes = rawNodes, links = rawLinks, nodeById = rawNodeById;
  // Maps any raw spec shortname to the node currently representing it.
  let specToNode = rawNodeById;

  function wireAdjacency() {
    for (const n of nodes) { n.out = []; n.in = []; n.neighbors = new Set(); }
    for (const l of links) {
      l.source.out.push(l);
      l.target.in.push(l);
      l.source.neighbors.add(l.target);
      l.target.neighbors.add(l.source);
    }
  }
  wireAdjacency();

  // ---------- Colors ----------------------------------------------------------

  const PALETTE = [
    "hsl(210 65% 50%)", "hsl(150 45% 42%)", "hsl(20 80% 56%)", "hsl(275 40% 55%)",
    "hsl(45 85% 50%)", "hsl(340 60% 55%)", "hsl(185 50% 42%)", "hsl(95 40% 45%)",
    "hsl(0 55% 52%)", "hsl(240 30% 55%)", "hsl(30 30% 50%)",
  ];
  const orgCounts = d3.rollup(nodes, (v) => v.length, (n) => n.organization);
  const orgs = [...orgCounts.entries()].sort((a, b) => b[1] - a[1]).map((d) => d[0]);
  const orgColor = new Map(orgs.map((o, i) => [o, PALETTE[i % PALETTE.length]]));
  const colorOf = (n) => orgColor.get(n.organization);

  // Definition type categories (for the dive view).
  const DFN_CATS = [
    { id: "concept", label: "Concepts & algorithms", color: "hsl(30 8% 48%)",
      types: ["dfn", "abstract-op", "grammar"] },
    { id: "idl", label: "Web IDL", color: "hsl(210 65% 50%)",
      types: ["interface", "attribute", "method", "dict-member", "dictionary", "enum", "enum-value",
        "typedef", "callback", "const", "constructor", "argument", "exception", "namespace",
        "extended-attribute", "interface-mixin", "callback-interface", "permission"] },
    { id: "css", label: "CSS", color: "hsl(275 40% 55%)",
      types: ["property", "value", "descriptor", "selector", "function", "type", "at-rule"] },
    { id: "markup", label: "Elements, attributes & events", color: "hsl(150 45% 42%)",
      types: ["element", "element-attr", "attr-value", "event", "element-state"] },
    { id: "cddl", label: "CDDL", color: "hsl(20 80% 56%)",
      types: ["cddl-key", "cddl-type", "cddl-value", "cddl-module", "cddl-parameter"] },
    { id: "other", label: "Other", color: "hsl(45 85% 45%)", types: [] },
  ];
  const catByType = new Map();
  for (const c of DFN_CATS) for (const t of c.types) catByType.set(t, c);
  const catOf = (dfn) => catByType.get(dfn.type) || DFN_CATS[DFN_CATS.length - 1];

  // ---------- State -----------------------------------------------------------

  const state = {
    mode: "graph", // "graph" | "dive"
    collapse: false, // collapse spec series into one node
    showNormative: true,
    showInformative: true,
    hideIsolated: true,
    minInDegree: 0,
    orgsOff: new Set(),
    selected: null,
    hovered: null,
    visibleNodes: [],
    visibleLinks: [],
    transform: d3.zoomIdentity,
  };

  // Dive-mode state (populated by enterDive()).
  const dive = {
    spec: null, data: null,
    showUnreferenced: false, catsOff: new Set(),
    nodes: [], dfnNodes: [], specNodes: [], groups: [], links: [],
    center: null, quadtree: null, R1: 0, R2: 0, slot: 10,
    selected: null, hovered: null,
  };

  // ---------- Canvas & simulation --------------------------------------------

  const stage = document.getElementById("stage");
  const canvas = document.getElementById("graph");
  const ctx = canvas.getContext("2d");
  let width = 0, height = 0, dpr = 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    width = stage.clientWidth;
    height = stage.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    simulation.force("center", d3.forceCenter(width / 2, height / 2));
    draw();
  }

  const simulation = d3.forceSimulation()
    .force("link", d3.forceLink().id((d) => d.id)
      .distance((l) => 30 + Math.min(l.source.r, l.target.r) * 2)
      .strength((l) => (l.kind === "normative" ? 0.08 : 0.03) /
        Math.min(4, Math.sqrt(Math.min(l.source.neighbors.size, l.target.neighbors.size)))))
    .force("charge", d3.forceManyBody().strength((d) => -40 - d.r * 10).distanceMax(600))
    .force("collide", d3.forceCollide((d) => d.r + 2.5).iterations(2))
    .force("x", d3.forceX().strength(0.02))
    .force("y", d3.forceY().strength(0.02))
    .alphaDecay(0.025)
    .on("tick", () => { if (state.mode === "graph") draw(); });

  // Seed positions in a disc so the first frames aren't a singularity.
  nodes.forEach((n, i) => {
    const a = i * 2.399963, r = 40 * Math.sqrt(i);
    n.x = 600 + r * Math.cos(a); n.y = 400 + r * Math.sin(a);
  });

  function applyFilters(reheat = 0.5) {
    const kindOk = (l) =>
      (l.kind === "normative" && state.showNormative) ||
      (l.kind === "informative" && state.showInformative);
    const nodeOk = (n) => !state.orgsOff.has(n.organization) && n.inDegree >= state.minInDegree;

    let visNodes = nodes.filter(nodeOk);
    const visSet = new Set(visNodes);
    const visLinks = links.filter((l) => kindOk(l) && visSet.has(l.source) && visSet.has(l.target));

    if (state.hideIsolated) {
      const connected = new Set();
      for (const l of visLinks) { connected.add(l.source); connected.add(l.target); }
      // Keep the selected node around even if it became isolated.
      visNodes = visNodes.filter((n) => connected.has(n) || n === state.selected);
    }

    state.visibleNodes = visNodes;
    state.visibleLinks = visLinks;
    for (const n of nodes) n.visible = false;
    for (const n of visNodes) n.visible = true;

    simulation.nodes(visNodes);
    simulation.force("link").links(visLinks);
    simulation.force("x").x(width / 2);
    simulation.force("y").y(height / 2);
    if (reheat) simulation.alpha(reheat).restart();
    draw();
  }

  function setCollapse(on) {
    if (on === state.collapse) return;
    state.collapse = on;
    document.getElementById("collapse-series").checked = on;
    const prevSelected = state.selected;
    if (on) {
      // Series nodes start at the centroid of their members.
      for (const s of seriesNodes) {
        const ms = s.memberNodes;
        s.x = d3.mean(ms, (m) => m.x); s.y = d3.mean(ms, (m) => m.y);
        s.vx = s.vy = 0;
      }
      nodes = collapsedNodes; links = collapsedLinks;
      nodeById = new Map(nodes.map((n) => [n.id, n]));
      specToNode = new Map(rawNodes.map((n) => [n.id, memberToSeries.get(n) || n]));
    } else {
      // Members burst out of where the collapsed node ended up.
      for (const s of seriesNodes) {
        s.memberNodes.forEach((m, i) => {
          const a = (i / s.memberNodes.length) * Math.PI * 2;
          m.x = s.x + 12 * Math.cos(a); m.y = s.y + 12 * Math.sin(a); m.vx = m.vy = 0;
        });
      }
      nodes = rawNodes; links = rawLinks; nodeById = rawNodeById; specToNode = rawNodeById;
    }
    wireAdjacency();
    renderStats();
    // Keep the selection meaningful across the switch.
    let next = null;
    if (prevSelected) {
      next = on ? (memberToSeries.get(prevSelected) || prevSelected)
        : (prevSelected.isSeries ? rawNodeById.get(prevSelected.current) : prevSelected);
    }
    state.selected = next; state.hovered = null;
    applyFilters(0.6);
    renderDetail();
    history.replaceState(null, "", next ? `#${encodeURIComponent(next.id)}` : location.pathname);
  }

  // ---------- Rendering: shared ----------------------------------------------

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const NORMATIVE = css("--normative"), INFORMATIVE = css("--informative"), TEXT = css("--text");
  const HALO = "hsl(40 20% 97% / 0.85)";
  const OUT_COLOR = "hsl(20 80% 50%)", IN_COLOR = "hsl(210 65% 45%)";

  function draw() {
    const t = state.transform;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);
    if (state.mode === "graph") drawGraph(t.k); else drawDive(t.k);
    ctx.restore();
  }

  function haloText(text, x, y, k, alpha = 1) {
    ctx.lineWidth = 3 / k;
    ctx.strokeStyle = HALO;
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = TEXT;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  }

  function drawArrow(s, tg, k) {
    const dx = tg.x - s.x, dy = tg.y - s.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const ex = tg.x - ux * (tg.r + 1), ey = tg.y - uy * (tg.r + 1);
    const sx = s.x + ux * s.r, sy = s.y + uy * s.r;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    const a = 5 / k;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - ux * a - uy * a * 0.55, ey - uy * a + ux * a * 0.55);
    ctx.lineTo(ex - ux * a + uy * a * 0.55, ey - uy * a - ux * a * 0.55);
    ctx.closePath(); ctx.fill();
  }

  // ---------- Rendering: graph mode ------------------------------------------

  function drawGraph(k) {
    const focus = state.selected || state.hovered;

    // Edges ---------------------------------------------------------------
    ctx.lineWidth = 0.8 / k;
    ctx.globalAlpha = focus ? 0.06 : 0.22;
    ctx.strokeStyle = NORMATIVE;
    ctx.beginPath();
    for (const l of state.visibleLinks) {
      if (l.kind !== "normative" || (focus && (l.source === focus || l.target === focus))) continue;
      ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y);
    }
    ctx.stroke();
    ctx.strokeStyle = INFORMATIVE;
    ctx.setLineDash([3 / k, 3 / k]);
    ctx.beginPath();
    for (const l of state.visibleLinks) {
      if (l.kind !== "informative" || (focus && (l.source === focus || l.target === focus))) continue;
      ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Focused edges, with arrowheads (outgoing = refs, incoming = cited by)
    if (focus) {
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.4 / k;
      for (const l of state.visibleLinks) {
        if (l.source !== focus && l.target !== focus) continue;
        const outgoing = l.source === focus;
        ctx.strokeStyle = ctx.fillStyle = outgoing ? OUT_COLOR : IN_COLOR;
        ctx.setLineDash(l.kind === "informative" ? [4 / k, 3 / k] : []);
        drawArrow(l.source, l.target, k);
      }
      ctx.setLineDash([]);
    }

    // Nodes ---------------------------------------------------------------
    for (const n of state.visibleNodes) {
      const related = focus && (n === focus || focus.neighbors.has(n));
      ctx.globalAlpha = focus ? (related ? 1 : 0.12) : 0.92;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = colorOf(n);
      ctx.fill();
      if (n === state.selected || n === state.hovered) {
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = TEXT;
        ctx.stroke();
      }
    }

    // Labels --------------------------------------------------------------
    ctx.globalAlpha = 1;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const labelMin = 11 / k; // only label nodes big enough on screen, or when zoomed in
    for (const n of state.visibleNodes) {
      const related = focus && (n === focus || focus.neighbors.has(n));
      const show = related || (!focus && (n.r >= labelMin || k > 2.2));
      if (!show) continue;
      const size = Math.max(10 / k, Math.min(13 / k, n.r * 0.9));
      ctx.font = `${n === focus ? 600 : 500} ${size}px Inter, system-ui, sans-serif`;
      haloText(n.label, n.x + n.r + 3 / k, n.y, k, focus && !related ? 0.3 : 1);
    }
  }

  // ---------- Dive mode: data loading & layout -------------------------------

  const dfnCache = new Map(); // node id -> {dfns, rawDfnCount}
  const expand = (n) => (n.isSeries ? n.memberNodes : [n]);

  function loadSpecData(node) {
    if (dfnCache.has(node.id)) return dfnCache.get(node.id);
    // Definitions come from the spec itself (or all series members, current
    // first so its version of a duplicate wins); link files are only fetched
    // for the specs the reference graph already told us point at this one.
    const targets = node.isSeries
      ? [rawNodeById.get(node.current), ...node.memberNodes.filter((m) => m.id !== node.current)].filter(Boolean)
      : [node];
    const referrers = [...new Set(node.in.flatMap((l) => expand(l.source)))];
    const p = WebrefData.loadDefinitions(targets, referrers, graph.resolve, progressReporter({
      dfns: `Loading definitions of ${node.label}…`,
      links: `Scanning links from the ${referrers.length} specs that reference ${node.label}…`,
    })).catch((e) => { dfnCache.delete(node.id); throw e; });
    dfnCache.set(node.id, p);
    return p;
  }

  async function enterDive(spec) {
    if (!spec || !spec.hasDfns) return;
    let data;
    try { data = await loadSpecData(spec); }
    catch (e) {
      showProgress(`Could not load definitions for ${spec.id}.`, 0, e.message);
      setTimeout(hideProgress, 3000);
      return;
    }
    state.mode = "dive";
    simulation.stop();
    dive.spec = spec; dive.data = data;
    dive.selected = dive.hovered = null;
    dive.catsOff = new Set();
    // Small specs: show everything; big ones: start with referenced dfns only.
    dive.showUnreferenced = data.dfns.length <= 150;
    document.getElementById("dive-show-unreferenced").checked = dive.showUnreferenced;
    for (const d of data.dfns) d.cat = catOf(d);
    layoutDive();
    renderDivePanel();
    setModeUI();
    history.replaceState(null, "", `#${encodeURIComponent(spec.id)}/dfns`);
    fitDive(0);
    hideProgress();
  }

  function exitDive() {
    const spec = dive.spec;
    state.mode = "graph";
    dive.spec = null; dive.data = null; dive.nodes = []; dive.links = []; dive.quadtree = null;
    setModeUI();
    simulation.alpha(0.05).restart();
    select(spec, { center: true });
  }

  function setModeUI() {
    const isDive = state.mode === "dive";
    document.getElementById("dive").hidden = !isDive;
    document.getElementById("filters").hidden = isDive;
    document.getElementById("detail").hidden = isDive || !state.selected;
    document.getElementById("search-panel").hidden = isDive;
    document.getElementById("hint-graph").hidden = isDive;
    document.getElementById("hint-dive").hidden = !isDive;
    tooltip.hidden = true;
    canvas.classList.remove("pointing");
  }

  function layoutDive() {
    const d = dive;
    const shown = d.data.dfns.filter((df) =>
      (d.showUnreferenced || df.refs.length) && !d.catsOff.has(df.cat.id));

    // Group by heading, preserving document order.
    const groups = [], byHeading = new Map();
    for (const df of shown) {
      const key = df.heading.id || "";
      let g = byHeading.get(key);
      if (!g) { g = { id: key, title: df.heading.title || "(no section)", number: df.heading.number, dfns: [] }; byHeading.set(key, g); groups.push(g); }
      g.dfns.push(df);
    }
    const GAP = groups.length > 1 ? 2 : 0;
    const totalSlots = shown.length + GAP * groups.length;
    const slot = 10;
    const R1 = Math.max(170, (totalSlots * slot) / (2 * Math.PI));
    const R2 = R1 + Math.max(220, R1 * 0.35);
    const step = (2 * Math.PI) / Math.max(totalSlots, 1);

    // Definition ring.
    const dfnNodes = [];
    let i = 0;
    for (const g of groups) {
      g.a0 = -Math.PI / 2 + i * step;
      for (const df of g.dfns) {
        const a = -Math.PI / 2 + (i + 0.5) * step;
        dfnNodes.push({ kind: "dfn", dfn: df, a, x: R1 * Math.cos(a), y: R1 * Math.sin(a),
          r: df.refs.length ? 2.4 + Math.sqrt(df.refs.length) * 1.2 : 1.7, group: g, specs: [] });
        i++;
      }
      g.a1 = -Math.PI / 2 + i * step;
      i += GAP;
    }

    // Referencing specs on the outer ring, at the circular mean of their dfns.
    // Refs are raw shortnames; map them to whatever node currently represents
    // that spec (its series when collapsed), skipping the spec itself.
    const specMap = new Map();
    for (const dn of dfnNodes) {
      const seen = new Set();
      for (const ref of dn.dfn.refs) {
        const spec = specToNode.get(ref);
        if (!spec || spec === d.spec || seen.has(spec)) continue;
        seen.add(spec);
        let sn = specMap.get(spec.id);
        if (!sn) { sn = { kind: "spec", spec, dfns: [], sx: 0, sy: 0 }; specMap.set(spec.id, sn); }
        sn.dfns.push(dn); dn.specs.push(sn);
        sn.sx += Math.cos(dn.a); sn.sy += Math.sin(dn.a);
      }
    }
    const specNodes = [...specMap.values()];
    for (const sn of specNodes) {
      sn.a = Math.atan2(sn.sy, sn.sx);
      sn.r = 4.5 + Math.sqrt(sn.dfns.length) * 1.7;
    }
    // Spread overlapping specs apart along the ring.
    specNodes.sort((a, b) => a.a - b.a);
    const n = specNodes.length;
    if (n > 1) {
      const sep = (a, b) => (a.r + b.r + 8) / R2;
      const need = specNodes.reduce((s, sn, j) => s + sep(sn, specNodes[(j + 1) % n]), 0);
      const scale = need > 2 * Math.PI ? (2 * Math.PI) / need : 1;
      for (let pass = 0; pass < 3; pass++) {
        for (let j = 1; j < n; j++) {
          const m = sep(specNodes[j - 1], specNodes[j]) * scale;
          if (specNodes[j].a - specNodes[j - 1].a < m) specNodes[j].a = specNodes[j - 1].a + m;
        }
        // Recentre so the forward push doesn't drift everything clockwise.
        const over = specNodes[n - 1].a - specNodes[0].a - (2 * Math.PI - sep(specNodes[n - 1], specNodes[0]) * scale);
        const shift = over > 0 ? over / 2 : 0;
        for (let j = n - 1; j >= 1; j--) {
          const m = sep(specNodes[j - 1], specNodes[j]) * scale;
          specNodes[j].a -= shift * (j / (n - 1));
          if (specNodes[j].a - specNodes[j - 1].a < m) specNodes[j - 1].a = specNodes[j].a - m;
        }
      }
    }
    for (const sn of specNodes) { sn.x = R2 * Math.cos(sn.a); sn.y = R2 * Math.sin(sn.a); }

    const center = { kind: "center", spec: d.spec, x: 0, y: 0, r: 26 };
    const dlinks = [];
    for (const dn of dfnNodes) for (const sn of dn.specs) dlinks.push({ dfn: dn, spec: sn });

    d.shown = shown; d.groups = groups; d.dfnNodes = dfnNodes; d.specNodes = specNodes;
    d.center = center; d.links = dlinks; d.R1 = R1; d.R2 = R2; d.slot = slot;
    d.nodes = [center, ...dfnNodes, ...specNodes];
    d.quadtree = d3.quadtree().x((p) => p.x).y((p) => p.y).addAll(d.nodes);
    if (d.selected && !d.nodes.includes(d.selected)) {
      // Re-find the equivalent node after a re-layout.
      d.selected = d.selected.kind === "dfn"
        ? dfnNodes.find((x) => x.dfn === d.selected.dfn) || null
        : d.selected.kind === "spec" ? specNodes.find((x) => x.spec === d.selected.spec) || null : center;
    }
    d.hovered = null;
  }

  function fitDive(duration = 500) {
    const R = dive.R2 + 160;
    const k = Math.min(4, 0.92 / Math.max((2 * R) / width, (2 * R) / height));
    const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(k);
    d3.select(canvas).transition().duration(duration).call(zoom.transform, t);
  }

  // ---------- Dive mode: rendering --------------------------------------------

  function drawDive(k) {
    const d = dive;
    const focus = d.selected || d.hovered;
    const focusDfns = new Set(), focusSpecs = new Set();
    if (focus) {
      if (focus.kind === "dfn") { focusDfns.add(focus); focus.specs.forEach((s) => focusSpecs.add(s)); }
      else if (focus.kind === "spec") { focusSpecs.add(focus); focus.dfns.forEach((x) => focusDfns.add(x)); }
    }
    const isLit = (l) => focus && focus.kind !== "center" && (l.dfn === focus || l.spec === focus);

    // Section arcs just inside the definition ring.
    const arcR = d.R1 - 16;
    ctx.lineWidth = 3 / k;
    ctx.lineCap = "butt";
    d.groups.forEach((g, gi) => {
      ctx.strokeStyle = gi % 2 ? "hsl(30 10% 70%)" : "hsl(30 10% 82%)";
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(0, 0, arcR, g.a0, g.a1); ctx.stroke();
      // Section label, if there's room on screen.
      const span = (g.a1 - g.a0) * arcR * k;
      if (span < 48) return;
      const mid = (g.a0 + g.a1) / 2;
      let label = (g.number ? g.number + " " : "") + g.title;
      ctx.font = `500 ${11 / k}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      const maxW = span / k - 10 / k;
      while (label.length > 4 && ctx.measureText(label).width > maxW) label = label.slice(0, -2).trimEnd() + "…";
      if (ctx.measureText(label).width > maxW) return;
      ctx.save();
      ctx.translate((arcR - 9 / k) * Math.cos(mid), (arcR - 9 / k) * Math.sin(mid));
      // Keep text upright: tangent direction, flipped on the bottom half.
      const flip = Math.sin(mid) > 0;
      ctx.rotate(mid + (flip ? -Math.PI / 2 : Math.PI / 2));
      ctx.textAlign = "center";
      ctx.textBaseline = flip ? "bottom" : "top";
      ctx.fillStyle = "hsl(30 6% 40%)";
      ctx.globalAlpha = 1;
      ctx.fillText(label, 0, 0);
      ctx.restore();
    });

    // Spokes from the centre to the definition ring (faint), and dfn→spec links.
    ctx.lineWidth = 0.7 / k;
    ctx.globalAlpha = focus ? 0.04 : 0.16;
    for (const l of d.links) {
      if (isLit(l)) continue;
      ctx.strokeStyle = colorOf(l.spec.spec);
      ctx.beginPath(); ctx.moveTo(l.dfn.x, l.dfn.y); ctx.lineTo(l.spec.x, l.spec.y); ctx.stroke();
    }
    if (focus && focus.kind !== "center") {
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 1.5 / k;
      for (const l of d.links) {
        if (!isLit(l)) continue;
        ctx.strokeStyle = ctx.fillStyle = IN_COLOR;
        drawArrow(l.spec, l.dfn, k);
      }
    }

    // Centre spec.
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(0, 0, d.center.r, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(d.spec); ctx.fill();
    if (focus === d.center) { ctx.lineWidth = 2.5 / k; ctx.strokeStyle = TEXT; ctx.stroke(); }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.max(14 / k, 16)}px Inter, system-ui, sans-serif`;
    haloText(d.spec.label, 0, d.center.r + Math.max(14 / k, 16), k);
    ctx.font = `400 ${Math.max(11 / k, 11)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = "hsl(30 6% 40%)";
    ctx.fillText(`${d.shown.length} of ${d.data.dfns.length} definitions · ${d.specNodes.length} linking specs`,
      0, d.center.r + Math.max(14 / k, 16) * 2.1);

    // Definition nodes.
    for (const dn of d.dfnNodes) {
      const lit = !focus || focusDfns.has(dn) || focus === d.center;
      ctx.globalAlpha = lit ? 0.95 : 0.15;
      ctx.beginPath(); ctx.arc(dn.x, dn.y, dn.r, 0, Math.PI * 2);
      if (dn.dfn.refs.length) { ctx.fillStyle = dn.dfn.cat.color; ctx.fill(); }
      else { ctx.lineWidth = 1 / k; ctx.strokeStyle = dn.dfn.cat.color; ctx.stroke(); }
      if (dn === d.selected || dn === d.hovered) { ctx.lineWidth = 2 / k; ctx.strokeStyle = TEXT; ctx.stroke(); }
    }
    // Spec nodes.
    for (const sn of d.specNodes) {
      const lit = !focus || focusSpecs.has(sn) || focus === d.center;
      ctx.globalAlpha = lit ? 0.95 : 0.15;
      ctx.beginPath(); ctx.arc(sn.x, sn.y, sn.r, 0, Math.PI * 2);
      ctx.fillStyle = colorOf(sn.spec); ctx.fill();
      if (sn === d.selected || sn === d.hovered) { ctx.lineWidth = 2 / k; ctx.strokeStyle = TEXT; ctx.stroke(); }
    }

    // Labels: dfns point inward, specs outward, both radially.
    ctx.globalAlpha = 1;
    ctx.textBaseline = "middle";
    const dfnLabelsOk = d.slot * k >= 13; // zoomed in enough that neighbours don't overlap
    for (const dn of d.dfnNodes) {
      const related = focusDfns.has(dn);
      if (!(related || (dfnLabelsOk && (!focus || focus === d.center)))) continue;
      ctx.font = `${related ? 600 : 400} ${11 / k}px Inter, system-ui, sans-serif`;
      radialLabel(dn.dfn.text, dn, false, k, related || !focus ? 1 : 0.4);
    }
    const specLabelsOk = n2sep(d) * k >= 11;
    for (const sn of d.specNodes) {
      const related = focusSpecs.has(sn);
      if (!(related || (specLabelsOk && (!focus || focus === d.center)))) continue;
      ctx.font = `${related ? 600 : 500} ${11.5 / k}px Inter, system-ui, sans-serif`;
      radialLabel(sn.spec.label, sn, true, k, related || !focus ? 1 : 0.4);
    }
  }

  // Approximate nearest-neighbour spacing of spec nodes along the outer ring.
  function n2sep(d) {
    if (d.specNodes.length < 2) return Infinity;
    let min = Infinity;
    for (let j = 1; j < d.specNodes.length; j++) min = Math.min(min, (d.specNodes[j].a - d.specNodes[j - 1].a) * d.R2);
    return min;
  }

  function radialLabel(text, node, outward, k, alpha) {
    ctx.save();
    ctx.translate(node.x, node.y);
    let a = node.a;
    const left = Math.cos(a) < 0;
    if (left) a += Math.PI;
    ctx.rotate(a);
    // After rotation, +x points radially outward (or inward if flipped for the left half).
    const inwardSign = left ? 1 : -1; // direction (in rotated frame) toward the centre
    const dir = outward ? -inwardSign : inwardSign;
    ctx.textAlign = dir > 0 ? "left" : "right";
    haloText(text, dir * (node.r + 4 / k), 0, k, alpha);
    ctx.restore();
  }

  // ---------- Interaction -----------------------------------------------------

  function nodeAt(px, py) {
    const [x, y] = state.transform.invert([px, py]);
    const k = state.transform.k;
    if (state.mode === "dive") {
      if (!dive.quadtree) return null;
      const n = dive.quadtree.find(x, y, 14 / k);
      return n && Math.hypot(n.x - x, n.y - y) <= Math.max(n.r + 2, 6 / k) ? n : null;
    }
    const n = simulation.find(x, y, 14 / k);
    return n && n.visible && Math.hypot(n.x - x, n.y - y) <= Math.max(n.r + 2, 6 / k) ? n : null;
  }

  const zoom = d3.zoom()
    .scaleExtent([0.02, 12])
    .filter((ev) => !ev.button && (ev.type !== "mousedown" || state.mode === "dive" || !nodeAt(ev.offsetX, ev.offsetY)))
    .on("zoom", (ev) => { state.transform = ev.transform; draw(); });

  const drag = d3.drag()
    .container(canvas)
    .subject((ev) => (state.mode === "graph" ? nodeAt(ev.x, ev.y) : null))
    .on("start", (ev) => {
      if (!ev.active) simulation.alphaTarget(0.2).restart();
      ev.subject.fx = ev.subject.x; ev.subject.fy = ev.subject.y;
      canvas.classList.add("dragging");
    })
    .on("drag", (ev) => {
      const [x, y] = state.transform.invert([ev.x, ev.y]);
      ev.subject.fx = x; ev.subject.fy = y;
    })
    .on("end", (ev) => {
      if (!ev.active) simulation.alphaTarget(0);
      ev.subject.fx = ev.subject.fy = null;
      canvas.classList.remove("dragging");
    });

  d3.select(canvas).call(drag).call(zoom);

  const tooltip = document.getElementById("tooltip");
  canvas.addEventListener("mousemove", (ev) => {
    const n = nodeAt(ev.offsetX, ev.offsetY);
    canvas.classList.toggle("pointing", !!n);
    if (state.mode === "dive") {
      if (n !== dive.hovered) { dive.hovered = n; draw(); }
    } else if (n !== state.hovered) { state.hovered = n; draw(); }
    if (n) {
      tooltip.hidden = false;
      tooltip.style.left = ev.offsetX + "px";
      tooltip.style.top = ev.offsetY + "px";
      tooltip.innerHTML = tooltipHtml(n);
    } else {
      tooltip.hidden = true;
    }
  });
  function tooltipHtml(n) {
    if (state.mode === "graph") {
      return `<div class="t">${esc(n.title || n.id)}</div>
        <div class="s">${esc(n.id)} · ${n.outDegree} refs → · ← ${n.inDegree} cited by</div>`;
    }
    if (n.kind === "dfn") {
      const df = n.dfn;
      const ctx2 = df.for.length ? ` for ${esc(df.for.join(", "))}` : "";
      return `<div class="t">${esc(df.text)}</div>
        <div class="s">${esc(df.type)}${ctx2} · §${esc(df.heading.number || "")} ${esc(df.heading.title || "")}</div>
        <div class="s">${df.refs.length ? `linked from ${df.refs.length} spec${df.refs.length === 1 ? "" : "s"}` : "no external links"}</div>`;
    }
    if (n.kind === "spec") {
      return `<div class="t">${esc(n.spec.title || n.spec.id)}</div>
        <div class="s">links to ${n.dfns.length} definition${n.dfns.length === 1 ? "" : "s"} of ${esc(dive.spec.label)}</div>`;
    }
    return `<div class="t">${esc(n.spec.title)}</div><div class="s">${esc(n.spec.id)}</div>`;
  }
  canvas.addEventListener("mouseleave", () => {
    state.hovered = null; dive.hovered = null; tooltip.hidden = true; draw();
  });
  canvas.addEventListener("click", (ev) => {
    const n = nodeAt(ev.offsetX, ev.offsetY);
    if (state.mode === "dive") selectDive(n); else select(n);
  });
  canvas.addEventListener("dblclick", (ev) => {
    const n = nodeAt(ev.offsetX, ev.offsetY);
    if (!n) return;
    const url = state.mode === "graph" ? n.url : n.kind === "dfn" ? n.dfn.href : n.spec.url;
    if (url) window.open(url, "_blank", "noopener");
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (state.mode === "dive") { if (dive.selected) selectDive(null); else exitDive(); }
      else { select(null); searchInput.blur(); }
    }
    if (ev.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      ev.preventDefault();
      (state.mode === "dive" ? diveSearch : searchInput).focus();
    }
  });

  function select(n, { center = false } = {}) {
    state.selected = n;
    if (n && !n.visible) applyFilters(0.3);
    renderDetail();
    if (n && center) flyTo(n);
    history.replaceState(null, "", n ? `#${encodeURIComponent(n.id)}` : location.pathname);
    draw();
  }

  function flyTo(n, minK = 1.4) {
    const k = Math.max(state.transform.k, minK);
    const t = d3.zoomIdentity.translate(width / 2 - n.x * k, height / 2 - n.y * k).scale(k);
    d3.select(canvas).transition().duration(650).ease(d3.easeCubicInOut).call(zoom.transform, t);
  }

  function selectDive(n, { center = false } = {}) {
    dive.selected = n;
    renderDiveDetail();
    if (n && center) flyTo(n, 1.6);
    draw();
  }

  // ---------- Sidebar: stats, legend, filters --------------------------------

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function renderStats() {
    document.getElementById("stats").innerHTML = [
      ["Specs", nodes.length],
      ["References", links.length],
      ["Normative", links.reduce((s, l) => s + (l.kind === "normative"), 0)],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v.toLocaleString()}</dd></div>`).join("");
  }
  renderStats();

  const legend = document.getElementById("org-legend");
  legend.innerHTML = orgs.map((o) =>
    `<li data-org="${esc(o)}" title="Click to toggle; double-click to solo">
       <span class="dot" style="background:${orgColor.get(o)};color:${orgColor.get(o)}"></span>
       <span class="name">${esc(o)}</span><span class="n">${orgCounts.get(o)}</span></li>`).join("");
  legend.addEventListener("click", (ev) => {
    const li = ev.target.closest("li"); if (!li) return;
    const o = li.dataset.org;
    state.orgsOff.has(o) ? state.orgsOff.delete(o) : state.orgsOff.add(o);
    syncLegend(); applyFilters();
  });
  legend.addEventListener("dblclick", (ev) => {
    const li = ev.target.closest("li"); if (!li) return;
    const o = li.dataset.org;
    const soloed = state.orgsOff.size === orgs.length - 1 && !state.orgsOff.has(o);
    state.orgsOff = soloed ? new Set() : new Set(orgs.filter((x) => x !== o));
    syncLegend(); applyFilters();
  });
  function syncLegend() {
    for (const li of legend.children) li.classList.toggle("off", state.orgsOff.has(li.dataset.org));
  }

  bindCheckbox("show-normative", "showNormative");
  bindCheckbox("show-informative", "showInformative");
  bindCheckbox("hide-isolated", "hideIsolated");
  document.getElementById("collapse-series").addEventListener("change", (ev) => setCollapse(ev.target.checked));
  function bindCheckbox(id, key) {
    const el = document.getElementById(id);
    el.checked = state[key];
    el.addEventListener("change", () => { state[key] = el.checked; applyFilters(); });
  }
  const minIn = document.getElementById("min-indegree");
  const minInOut = document.getElementById("min-indegree-out");
  minIn.addEventListener("input", () => {
    state.minInDegree = +minIn.value; minInOut.value = minIn.value; applyFilters(0.3);
  });

  // ---------- Sidebar: search (shared typeahead helper) ----------------------

  function typeahead(input, list, { search, render, onPick }) {
    let active = -1, matches = [];
    const paint = () => [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
    const run = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { list.hidden = true; matches = []; return; }
      matches = search(q);
      active = matches.length ? 0 : -1;
      list.innerHTML = matches.length ? matches.map((m, i) => `<li data-i="${i}">${render(m)}</li>`).join("")
        : `<li class="empty">No matches for “${esc(q)}”</li>`;
      list.hidden = false; paint();
    };
    const pick = (m) => { list.hidden = true; input.value = ""; onPick(m); };
    input.addEventListener("input", run);
    input.addEventListener("focus", run);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") { active = Math.min(matches.length - 1, active + 1); paint(); ev.preventDefault(); }
      else if (ev.key === "ArrowUp") { active = Math.max(0, active - 1); paint(); ev.preventDefault(); }
      else if (ev.key === "Enter" && matches.length) pick(matches[Math.max(0, active)]);
      else if (ev.key === "Escape") { list.hidden = true; input.blur(); ev.stopPropagation(); }
    });
    list.addEventListener("click", (ev) => {
      const li = ev.target.closest("li[data-i]"); if (li) pick(matches[+li.dataset.i]);
    });
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest(".search, .search-results")) list.hidden = true;
    });
  }

  const searchInput = document.getElementById("search");
  typeahead(searchInput, document.getElementById("search-results"), {
    search: (q) => {
      const score = (n) => {
        const id = n.id.toLowerCase(), title = (n.title || "").toLowerCase(), st = n.label.toLowerCase();
        if (id === q || st === q) return 0;
        if (id.startsWith(q) || st.startsWith(q)) return 1;
        if (id.includes(q) || st.includes(q)) return 2;
        if (title.includes(q)) return 3;
        return Infinity;
      };
      return nodes.map((n) => [score(n), n]).filter((d) => d[0] < Infinity)
        .sort((a, b) => a[0] - b[0] || b[1].inDegree - a[1].inDegree).slice(0, 12).map((d) => d[1]);
    },
    render: (n) => `<span>${esc(n.label)}</span><span class="id">${esc(n.id)}</span>`,
    onPick: (n) => select(n, { center: true }),
  });

  const diveSearch = document.getElementById("dive-search");
  typeahead(diveSearch, document.getElementById("dive-search-results"), {
    search: (q) => {
      const score = (df) => {
        const t = df.text.toLowerCase(), id = df.id.toLowerCase();
        if (t === q || id === q) return 0;
        if (t.startsWith(q) || id.startsWith(q)) return 1;
        if (t.includes(q) || id.includes(q)) return 2;
        if (df.for.some((f) => f.toLowerCase().includes(q))) return 3;
        return Infinity;
      };
      return dive.data.dfns.map((df) => [score(df), df]).filter((d) => d[0] < Infinity)
        .sort((a, b) => a[0] - b[0] || b[1].refs.length - a[1].refs.length).slice(0, 14).map((d) => d[1]);
    },
    render: (df) => `<span>${esc(df.text)}</span><span class="id">${esc(df.type)}${df.refs.length ? ` · ${df.refs.length}` : ""}</span>`,
    onPick: (df) => {
      // Make sure the definition is actually on the ring, then focus it.
      if (!df.refs.length && !dive.showUnreferenced) {
        dive.showUnreferenced = true; document.getElementById("dive-show-unreferenced").checked = true;
      }
      if (dive.catsOff.has(df.cat.id)) dive.catsOff.delete(df.cat.id);
      layoutDive(); renderDivePanel();
      selectDive(dive.dfnNodes.find((x) => x.dfn === df) || null, { center: true });
    },
  });

  // ---------- Sidebar: graph detail ------------------------------------------

  const detail = document.getElementById("detail");
  document.getElementById("detail-close").addEventListener("click", () => select(null));
  document.getElementById("detail-dive").addEventListener("click", () => enterDive(state.selected));

  function renderDetail() {
    const n = state.selected;
    detail.hidden = !n || state.mode === "dive";
    if (!n) return;
    document.getElementById("detail-org").textContent =
      [n.organization, ...(n.groups || [])].filter(Boolean).join(" · ");
    document.getElementById("detail-title").textContent = n.title || n.id;
    const bits = [`<code>${esc(n.id)}</code>`];
    if (n.isSeries) {
      bits.push(`collapsed series of ${n.memberNodes.length} specs: ` +
        n.memberNodes.map((m) => `<code>${esc(m.id)}</code>`).join(", "));
    }
    if (n.status) bits.push(esc(n.status));
    if (n.standing && n.standing !== "good") bits.push(esc(n.standing));
    if (n.composition && n.composition !== "full") bits.push(`${esc(n.composition)} spec`);
    if (!n.hasRefs) bits.push("no references extracted");
    document.getElementById("detail-meta").innerHTML = bits.join(" · ");
    const link = document.getElementById("detail-link");
    link.href = n.url || "#"; link.hidden = !n.url;
    const diveBtn = document.getElementById("detail-dive");
    diveBtn.disabled = !n.hasDfns;
    diveBtn.textContent = n.hasDfns ? "Explore definitions →" : "No definitions extracted";

    const sortRefs = (arr, other) => [...arr].sort((a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "normative" ? -1 : 1) || other(b).inDegree - other(a).inDegree);
    fillList("out-list", "out-count", sortRefs(n.out, (l) => l.target), (l) => l.target);
    fillList("in-list", "in-count", sortRefs(n.in, (l) => l.source), (l) => l.source);
  }
  function fillList(listId, countId, arr, other) {
    document.getElementById(countId).textContent = arr.length;
    const ul = document.getElementById(listId);
    ul.innerHTML = arr.length ? arr.map((l) => {
      const m = other(l);
      return `<li data-id="${esc(m.id)}" title="${esc(m.title)}">
        <span class="dot" style="background:${colorOf(m)}"></span>
        <span class="name">${esc(m.label)}</span>
        <span class="kind ${l.kind}">${l.kind === "normative" ? "norm" : "info"}</span></li>`;
    }).join("") : `<li class="empty">None</li>`;
  }
  detail.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-id]");
    if (li) select(nodeById.get(li.dataset.id), { center: true });
  });

  // ---------- Sidebar: dive panel ---------------------------------------------

  document.getElementById("dive-back").addEventListener("click", exitDive);
  document.getElementById("dive-show-unreferenced").addEventListener("change", (ev) => {
    dive.showUnreferenced = ev.target.checked;
    layoutDive(); renderDivePanel(); draw();
  });
  const diveTypes = document.getElementById("dive-types");
  diveTypes.addEventListener("click", (ev) => {
    const li = ev.target.closest("li"); if (!li) return;
    const c = li.dataset.cat;
    dive.catsOff.has(c) ? dive.catsOff.delete(c) : dive.catsOff.add(c);
    layoutDive(); renderDivePanel(); draw();
  });

  function renderDivePanel() {
    const d = dive, spec = d.spec;
    document.getElementById("dive-org").textContent =
      [spec.organization, ...(spec.groups || [])].filter(Boolean).join(" · ");
    document.getElementById("dive-title").textContent = spec.title || spec.id;
    const referenced = d.data.dfns.filter((x) => x.refs.length).length;
    const total = d.data.dfns.length, raw = d.data.rawDfnCount;
    document.getElementById("dive-stats").innerHTML = [
      ["Definitions", raw > total ? `${total.toLocaleString()} <small>of ${raw.toLocaleString()}</small>` : total.toLocaleString()],
      ["Linked to", referenced.toLocaleString()],
      ["By specs", d.specNodes.length.toLocaleString()],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");

    const counts = d3.rollup(d.data.dfns.filter((x) => d.showUnreferenced || x.refs.length), (v) => v.length, (x) => x.cat.id);
    diveTypes.innerHTML = DFN_CATS.filter((c) => counts.get(c.id)).map((c) =>
      `<li data-cat="${c.id}" class="${d.catsOff.has(c.id) ? "off" : ""}" title="Click to toggle">
         <span class="dot" style="background:${c.color};color:${c.color}"></span>
         <span class="name">${esc(c.label)}</span><span class="n">${counts.get(c.id)}</span></li>`).join("");
    renderDiveDetail();
  }

  const diveDetail = document.getElementById("dive-detail");
  function renderDiveDetail() {
    const n = dive.selected;
    diveDetail.hidden = !n;
    if (!n) return;
    if (n.kind === "dfn") {
      const df = n.dfn, c = df.cat;
      const specs = [...n.specs].sort((a, b) => b.dfns.length - a.dfns.length);
      diveDetail.innerHTML = `
        <p class="eyebrow">Definition · §${esc(df.heading.number || "")} ${esc(df.heading.title || "")}</p>
        <h3><code>${esc(df.text)}</code></h3>
        <p class="meta"><span class="type-tag" style="background:${c.color}">${esc(df.type)}</span>
          ${df.for.length ? ` for <code>${esc(df.for.join(", "))}</code>` : ""}
          ${df.access === "private" ? " · private" : ""}${df.informative ? " · informative" : ""}
          ${df.definedIn ? `<br>defined in ${df.definedIn.map((s) => `<code>${esc(s)}</code>`).join(", ")}` : ""}</p>
        <div class="actions">${df.href ? `<a class="button" href="${esc(df.href)}" target="_blank" rel="noopener">Open definition ↗</a>` : ""}</div>
        <div class="refs"><h3>Linked from <span class="count">${specs.length}</span></h3>
        <ul class="ref-list">${specs.length ? specs.map((sn) =>
          `<li data-spec="${esc(sn.spec.id)}" title="${esc(sn.spec.title)}">
             <span class="dot" style="background:${colorOf(sn.spec)}"></span>
             <span class="name">${esc(sn.spec.label)}</span>
             <span class="sub">${sn.dfns.length} dfn${sn.dfns.length === 1 ? "" : "s"}</span></li>`).join("")
          : `<li class="empty">No other spec links to this definition</li>`}</ul></div>`;
    } else if (n.kind === "spec") {
      const dfns = [...n.dfns].sort((a, b) => b.dfn.refs.length - a.dfn.refs.length);
      diveDetail.innerHTML = `
        <p class="eyebrow">${esc(n.spec.organization)}</p>
        <h3>${esc(n.spec.title || n.spec.id)}</h3>
        <p class="meta"><code>${esc(n.spec.id)}</code> · links to ${dfns.length} definition${dfns.length === 1 ? "" : "s"} of ${esc(dive.spec.label)}</p>
        <div class="actions">
          <a class="button" href="${esc(n.spec.url)}" target="_blank" rel="noopener">Open spec ↗</a>
          ${n.spec.hasDfns ? `<button class="button primary" type="button" data-dive="${esc(n.spec.id)}">Explore its definitions →</button>` : ""}
        </div>
        <div class="refs"><h3>Definitions used <span class="count">${dfns.length}</span></h3>
        <ul class="ref-list">${dfns.map((dn) =>
          `<li data-dfn="${esc(dn.dfn.id)}" title="${esc(dn.dfn.type)}${dn.dfn.for.length ? " for " + esc(dn.dfn.for.join(", ")) : ""}">
             <span class="dot" style="background:${dn.dfn.cat.color}"></span>
             <span class="name">${esc(dn.dfn.text)}</span>
             <span class="sub">${esc(dn.dfn.type)}</span></li>`).join("")}</ul></div>`;
    } else {
      diveDetail.innerHTML = `
        <p class="eyebrow">${esc(n.spec.organization)}</p>
        <h3>${esc(n.spec.title)}</h3>
        <p class="meta">Hover or click a definition on the ring, or a spec on the outer ring, to see what links where.</p>`;
    }
  }
  diveDetail.addEventListener("click", (ev) => {
    const dv = ev.target.closest("[data-dive]");
    if (dv) { enterDive(nodeById.get(dv.dataset.dive)); return; }
    const li = ev.target.closest("li[data-spec],li[data-dfn]");
    if (!li) return;
    const target = li.dataset.spec
      ? dive.specNodes.find((x) => x.spec.id === li.dataset.spec)
      : dive.dfnNodes.find((x) => x.dfn.id === li.dataset.dfn);
    if (target) selectDive(target, { center: true });
  });

  // ---------- Boot ------------------------------------------------------------

  window.addEventListener("resize", resize);
  resize();
  applyFilters(1);

  // Fit the graph once the layout has mostly settled, then honor any #hash.
  let fitted = false;
  simulation.on("tick.fit", () => {
    if (fitted || simulation.alpha() > 0.35) return;
    fitted = true;
    fitToView();
    hideProgress();
    renderSource();
    // The page is up: now quietly check whether the crawl has moved on.
    startRevalidation();
    const [id, sub] = decodeURIComponent(location.hash.slice(1)).split("/");
    if (id.startsWith("series:") && !state.collapse) setCollapse(true);
    if (id && nodeById.has(id)) {
      const n = nodeById.get(id);
      if (sub === "dfns") { state.selected = n; enterDive(n); } else select(n, { center: true });
    }
  });

  function fitToView() {
    const xs = d3.extent(state.visibleNodes, (d) => d.x), ys = d3.extent(state.visibleNodes, (d) => d.y);
    const w = xs[1] - xs[0] || 1, h = ys[1] - ys[0] || 1;
    const k = Math.min(12, 0.88 / Math.max(w / width, h / height));
    const t = d3.zoomIdentity
      .translate(width / 2 - k * (xs[0] + xs[1]) / 2, height / 2 - k * (ys[0] + ys[1]) / 2)
      .scale(k);
    d3.select(canvas).transition().duration(500).call(zoom.transform, t);
  }

  // ---------- Data source, caching & background revalidation ----------------

  const sourceEl = document.getElementById("source");
  function renderSource(status = "") {
    const src = WebrefData.sources;
    const served = src.cache + src.network
      ? (src.cache && !src.network ? "served from cache" : src.cache ? "mostly from cache" : "fetched from network")
      : "";
    sourceEl.innerHTML =
      `Data: <a href="${esc(graph.meta.source)}" target="_blank" rel="noopener">${esc(graph.meta.source)}</a>` +
      (graph.meta.crawlDate ? ` · crawled ${esc(new Date(graph.meta.crawlDate).toLocaleString())}` : "") +
      (served ? ` · ${served}` : "") + (status ? `<br>${status}` : "");
  }

  const toast = document.getElementById("toast");
  function showToast(text, { action, onAction } = {}) {
    document.getElementById("toast-text").textContent = text;
    const btn = document.getElementById("toast-action");
    btn.hidden = !action;
    btn.textContent = action || "";
    btn.onclick = onAction || null;
    toast.hidden = false;
  }
  document.getElementById("toast-close").addEventListener("click", () => { toast.hidden = true; });

  async function startRevalidation() {
    renderSource("Checking for a newer crawl…");
    try {
      const result = await WebrefData.revalidate(({ done, total }) =>
        renderSource(`Newer crawl found — refreshing cache ${done} / ${total}…`));
      if (result.updated) {
        renderSource(`Newer crawl available (${esc(new Date(result.date).toLocaleString())}).`);
        showToast(`A newer webref crawl from ${new Date(result.date).toLocaleString()} is cached and ready.`,
          { action: "Reload", onAction: () => location.reload() });
      } else {
        renderSource("Up to date.");
      }
    } catch (e) {
      console.warn("webref: revalidation failed", e);
      renderSource(navigator.onLine === false ? "Offline — showing cached data." : "Could not check for updates.");
    }
  }
})();
