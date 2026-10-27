/* Webref Visualized — live data loading.
 *
 * Fetches the webref crawl straight from its published location (or any
 * other base URL, e.g. a local checkout) and builds the spec-reference graph
 * in the browser. Exposed as window.WebrefData.
 */
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  let BASE = params.get("base") || "https://w3c.github.io/webref/ed/";
  if (!BASE.endsWith("/")) BASE += "/";

  const cache = new Map(); // url -> Promise<json>
  const sources = { cache: 0, network: 0 }; // where responses came from (per service worker)
  let indexDate = null; // crawl date of the index we built the graph from
  const resolveUrl = (path) => new URL(path, new URL(BASE, location.href)).href;

  function fetchJson(path, init) {
    const url = resolveUrl(path);
    if (init?.cache === "reload" || !cache.has(url)) {
      const p = fetch(url, init).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
        const src = r.headers.get("X-Webref-Source");
        if (src) sources[src.startsWith("cache") ? "cache" : "network"]++;
        return r.json();
      }).catch((e) => { if (cache.get(url) === p) cache.delete(url); throw e; });
      cache.set(url, p);
    }
    return cache.get(url);
  }

  // ---------- Service worker & background revalidation ----------------------

  const swReady = (async () => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return null;
    try {
      return await navigator.serviceWorker.register("sw.js");
    } catch (e) {
      console.warn("webref: service worker registration failed", e);
      return null;
    }
  })();

  /** Wait (briefly) until the worker controls this page, so that even the
   *  very first visit's downloads land in the cache. */
  async function swControl() {
    if (!(await swReady)) return;
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 1000);
      navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  function swMessage(msg) {
    return new Promise((resolve) => {
      const ctl = navigator.serviceWorker?.controller;
      if (!ctl) return resolve(null);
      const id = Math.random().toString(36).slice(2);
      const onMsg = (ev) => {
        if (ev.data?.id !== id) return;
        navigator.serviceWorker.removeEventListener("message", onMsg);
        resolve(ev.data);
      };
      navigator.serviceWorker.addEventListener("message", onMsg);
      ctl.postMessage({ ...msg, id });
    });
  }

  /**
   * Check for a newer crawl without disturbing the loaded page. Re-fetches
   * index.json from the network; if its crawl date differs from the one we
   * loaded, purges the stale cache, re-warms it with everything this page
   * has fetched so far, and resolves {updated: true, date}.
   */
  async function revalidate(onProgress) {
    await swReady;
    const fresh = await fetch(resolveUrl("index.json"), { cache: "reload" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json();
    });
    if (!indexDate || fresh.date === indexDate) {
      return { updated: false, date: fresh.date, source: sources };
    }
    // The crawl moved on: everything but the fresh index is now stale.
    await swMessage({ type: "purge", keep: [resolveUrl("index.json")] });
    const urls = [...cache.keys()].filter((u) => u !== resolveUrl("index.json"));
    await pool(urls, 6, (u) => fetch(u, { cache: "reload" }),
      (done, total) => onProgress?.({ phase: "revalidate", done, total }));
    return { updated: true, date: fresh.date, previousDate: indexDate, source: sources };
  }

  /** Run `fn` over `items` with at most `limit` in flight, reporting progress. */
  async function pool(items, limit, fn, onProgress) {
    const results = new Array(items.length);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        try { results[i] = await fn(items[i], i); }
        catch (e) { console.warn("webref: failed to load", items[i], e); results[i] = null; }
        onProgress?.(++done, items.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  // ---------- URL resolution --------------------------------------------------

  function normalizeUrl(url) {
    if (!url) return null;
    let u;
    try { u = new URL(url.trim()); } catch { return null; }
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    let path = u.pathname || "/";
    for (const suffix of ["/index.html", "/index.htm", "/Overview.html"]) {
      if (path.endsWith(suffix)) path = path.slice(0, -suffix.length) + "/";
    }
    path = path.replace(/\/+$/, "") || "/";
    return `https://${host}${path}`;
  }

  function candidateUrls(spec) {
    const urls = [spec.url, spec.crawled];
    for (const key of ["nightly", "release"]) {
      const sub = spec[key] || {};
      urls.push(sub.url, ...(sub.alternateUrls || []));
    }
    urls.push(spec.series?.nightlyUrl, spec.series?.releaseUrl, ...(spec.versions || []));
    return new Set(urls.map(normalizeUrl).filter(Boolean));
  }

  function* urlPrefixes(url) {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    while (parts.length) {
      yield `${u.protocol}//${u.host}/${parts.join("/")}`;
      parts.pop();
    }
  }

  function makeResolver(specs) {
    const urlToShort = new Map();
    for (const spec of specs) {
      for (const u of candidateUrls(spec)) {
        // Prefer "full" specs over delta/fork specs when URLs collide.
        if (!urlToShort.has(u) || spec.seriesComposition === "full") urlToShort.set(u, spec.shortname);
      }
    }
    const shortSet = new Set(specs.map((s) => s.shortname));
    const seriesToShort = new Map();
    for (const spec of specs) {
      if (spec.series?.currentSpecification === spec.shortname) {
        seriesToShort.set((spec.series.shortname || "").toLowerCase(), spec.shortname);
      }
    }
    return function resolve(ref) {
      const url = normalizeUrl(ref.url);
      if (url) {
        if (urlToShort.has(url)) return urlToShort.get(url);
        for (const p of urlPrefixes(url)) if (urlToShort.has(p)) return urlToShort.get(p);
      }
      const name = (ref.name || "").toLowerCase();
      if (shortSet.has(name)) return name;
      if (seriesToShort.has(name)) return seriesToShort.get(name);
      return null;
    };
  }

  // ---------- Graph -----------------------------------------------------------

  /**
   * Load index.json and every spec's refs file.
   * @param onProgress ({phase, done, total}) => void
   * @returns {{meta, nodes, links, series, resolve}}
   */
  async function loadGraph(onProgress) {
    onProgress?.({ phase: "index", done: 0, total: 1 });
    await swControl();
    const index = await fetchJson("index.json");
    indexDate = index.date;
    const specs = index.results;
    const resolve = makeResolver(specs);

    const withRefs = specs.filter((s) => s.refs);
    const refsData = await pool(withRefs, 16, (s) => fetchJson(s.refs),
      (done, total) => onProgress?.({ phase: "refs", done, total }));

    // (source, target) -> kind; normative wins.
    const edges = new Map();
    withRefs.forEach((spec, i) => {
      const refs = refsData[i]?.refs || {};
      for (const kind of ["normative", "informative"]) {
        for (const ref of refs[kind] || []) {
          const target = resolve(ref);
          if (!target || target === spec.shortname) continue;
          const key = spec.shortname + "\u0000" + target;
          if (!edges.has(key) || kind === "normative") edges.set(key, kind);
        }
      }
    });

    const inDegree = new Map(), outDegree = new Map();
    const links = [];
    for (const [key, kind] of edges) {
      const [source, target] = key.split("\u0000");
      links.push({ source, target, kind });
      outDegree.set(source, (outDegree.get(source) || 0) + 1);
      inDegree.set(target, (inDegree.get(target) || 0) + 1);
    }

    const nodes = specs.map((spec) => {
      const short = spec.shortname, series = spec.series || {};
      const nightly = spec.nightly || {}, release = spec.release || {};
      return {
        id: short,
        title: spec.title,
        shortTitle: spec.shortTitle || series.shortTitle || short,
        url: nightly.url || spec.url,
        organization: spec.organization || "Unknown",
        groups: (spec.groups || []).map((g) => g.name),
        status: release.status || nightly.status || "",
        standing: spec.standing,
        composition: spec.seriesComposition,
        categories: spec.categories || [],
        series: series.shortname,
        inDegree: inDegree.get(short) || 0,
        outDegree: outDegree.get(short) || 0,
        hasRefs: !!refsData[withRefs.indexOf(spec)],
        hasDfns: !!spec.dfns,
        dfnsPath: spec.dfns || null,
        linksPath: spec.links || null,
      };
    });

    // Multi-member series (e.g. css-color-3/4/5/6).
    const bySeries = new Map();
    for (const spec of specs) {
      const name = spec.series?.shortname || spec.shortname;
      if (!bySeries.has(name)) bySeries.set(name, []);
      bySeries.get(name).push(spec);
    }
    const specByShort = new Map(specs.map((s) => [s.shortname, s]));
    const series = [];
    for (const [name, members] of bySeries) {
      if (members.length < 2) continue;
      const meta = members[0].series || {};
      const current = specByShort.get(meta.currentSpecification) || members[members.length - 1];
      const nightly = current.nightly || {}, release = current.release || {};
      series.push({
        id: `series:${name}`,
        series: name,
        title: meta.title || current.title,
        shortTitle: meta.shortTitle || current.shortTitle || name,
        members: members.map((m) => m.shortname),
        current: current.shortname,
        url: meta.nightlyUrl || nightly.url || current.url,
        organization: current.organization || "Unknown",
        groups: [...new Set(members.flatMap((m) => (m.groups || []).map((g) => g.name)))],
        status: release.status || nightly.status || "",
        categories: current.categories || [],
        hasDfns: members.some((m) => m.dfns),
      });
    }

    return {
      meta: { source: BASE, crawlDate: index.date, specCount: nodes.length, edgeCount: links.length },
      nodes, links, series, resolve,
    };
  }

  // ---------- Definitions -----------------------------------------------------

  function simplifyDfn(d, definedIn) {
    const heading = d.heading || {};
    return {
      id: d.id,
      href: d.href,
      text: (d.linkingText || [d.id])[0],
      type: d.type,
      for: d.for || [],
      access: d.access,
      informative: !!d.informative,
      heading: { id: heading.id, title: heading.title, number: heading.number },
      refs: new Set(),
      definedIn: [definedIn],
    };
  }

  /**
   * Load the definitions of a spec (or of all members of a series, merged and
   * de-duplicated), then load the links files of the given referring specs
   * and attach, to each definition, the referrers that link to it.
   *
   * @param targets   array of raw spec nodes whose definitions to load
   *                  (one spec, or the members of a series, current first)
   * @param referrers array of raw spec nodes known to reference the target(s)
   * @param resolve   resolver from loadGraph()
   * @param onProgress ({phase, done, total}) => void
   */
  async function loadDefinitions(targets, referrers, resolve, onProgress) {
    const targetShorts = new Set(targets.map((t) => t.id));
    const withDfns = targets.filter((t) => t.dfnsPath);
    const dfnFiles = await pool(withDfns, 8, (t) => fetchJson(t.dfnsPath),
      (done, total) => onProgress?.({ phase: "dfns", done, total }));

    // Merge, de-duplicating by id and — when merging several specs of a
    // series — also by (type, text, for), so re-defined terms collapse.
    const merged = [], byId = new Map(), byKey = new Map();
    const multi = withDfns.length > 1;
    withDfns.forEach((t, i) => {
      for (const d of dfnFiles[i]?.dfns || []) {
        const text = (d.linkingText || [d.id])[0];
        const key = [d.type, text.toLowerCase(), ...(d.for || [])].join("\u0000");
        const existing = byId.get(d.id) || (multi ? byKey.get(key) : null);
        if (existing) {
          if (!existing.definedIn.includes(t.id)) existing.definedIn.push(t.id);
          if (!byId.has(d.id)) byId.set(d.id, existing);
          continue;
        }
        const entry = simplifyDfn(d, t.id);
        byId.set(d.id, entry); byKey.set(key, entry); merged.push(entry);
      }
    });

    // Only the specs we already know reference the target need their links read.
    const linkable = referrers.filter((r) => r.linksPath && !targetShorts.has(r.id));
    const linkFiles = await pool(linkable, 16, (r) => fetchJson(r.linksPath),
      (done, total) => onProgress?.({ phase: "links", done, total }));
    linkable.forEach((r, i) => {
      const data = linkFiles[i]?.links || {};
      for (const category of ["rawlinks", "autolinks"]) {
        for (const [url, info] of Object.entries(data[category] || {})) {
          const target = info.specShortname || resolve({ url });
          if (!target || !targetShorts.has(target)) continue;
          for (const anchor of info.anchors || []) {
            const dfn = byId.get(anchor);
            if (dfn) dfn.refs.add(r.id);
          }
        }
      }
    });

    for (const d of merged) {
      d.refs = [...d.refs].sort();
      if (targets.length === 1) delete d.definedIn;
    }
    return {
      dfns: merged,
      rawDfnCount: dfnFiles.reduce((s, f) => s + (f?.dfns?.length || 0), 0),
    };
  }

  window.WebrefData = {
    get base() { return BASE; },
    get sources() { return { ...sources }; },
    loadGraph, loadDefinitions, revalidate,
  };
})();
