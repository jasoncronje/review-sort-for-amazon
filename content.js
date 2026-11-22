// Review Sort for Amazon
// Adds a toolbar above Amazon search results that can:
//  1. Use Amazon's own hidden "review-count-rank" sort (works inside a department).
//  2. Re-sort results locally by review count, star rating or a weighted score,
//     optionally pulling in several result pages first so the sort covers more than one page.
(() => {
  "use strict";

  const RESULT_SEL = 'div.s-result-item[data-asin]:not([data-asin=""])[data-component-type="s-search-result"]';
  const SLOT_SEL = "div.s-main-slot.s-search-results, div.s-main-slot";
  const BAR_ID = "rsa-bar";
  const FETCH_DELAY_MS = 600; // be gentle so Amazon doesn't serve a captcha
  const MAX_PAGES = 10;

  // ---------- parsing ----------

  // Parses "12,345", "12.345", "12 345", "(12.3K)", "1,2 k", "2M" into an integer.
  function parseCount(raw) {
    if (!raw) return 0;
    let s = String(raw).replace(/[()  ]/g, " ").trim();
    const m = s.match(/(\d[\d.,\s]*)\s*([kKmM])?/);
    if (!m) return 0;
    const suffix = (m[2] || "").toLowerCase();
    const num = m[1].trim();
    if (suffix) {
      const f = parseFloat(num.replace(/\s/g, "").replace(",", "."));
      return Math.round(f * (suffix === "k" ? 1e3 : 1e6)) || 0;
    }
    return parseInt(num.replace(/[^\d]/g, ""), 10) || 0;
  }

  function lastNumberToken(text) {
    const tokens = String(text).match(/\d[\d.,\s  ]*\s*[kKmM]?(?![a-z])/g);
    return tokens ? tokens[tokens.length - 1] : "";
  }

  function getReviewCount(card) {
    // Newer layout: the reviews link has an aria-label like "12,345 ratings".
    const link = card.querySelector('a[href*="#customerReviews"], a[href*="customerReviews"]');
    if (link) {
      const label = link.getAttribute("aria-label");
      if (label) {
        const n = parseCount(lastNumberToken(label));
        if (n) return n;
      }
      const n = parseCount(link.textContent);
      if (n) return n;
    }
    const block = card.querySelector('[data-cy="reviews-block"]');
    const candidates = [
      ...(block ? block.querySelectorAll("span.s-underline-text, span[aria-label], a span") : []),
      ...card.querySelectorAll("span.s-underline-text, span.a-size-base.s-underline-text"),
    ];
    for (const el of candidates) {
      const n = parseCount(el.getAttribute("aria-label") || el.textContent);
      if (n) return n;
    }
    return 0;
  }

  function getRating(card) {
    const alt = card.querySelector("i[class*='a-star'] span.a-icon-alt, span.a-icon-alt");
    if (!alt) return 0;
    const m = alt.textContent.match(/(\d+(?:[.,]\d+)?)/);
    const r = m ? parseFloat(m[1].replace(",", ".")) : 0;
    return r > 0 && r <= 5 ? r : 0;
  }

  // ---------- delivery date ----------

  const DAY_MS = 864e5;
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  // Calendar days, not 24-hour blocks, so daylight-saving changes don't shift the date.
  const daysFromToday = (n) => { const d = startOfToday(); d.setDate(d.getDate() + n); return d; };

  // Month names for English plus the page's own language (amazon.de -> "Dez.", amazon.fr -> "déc.").
  const MONTHS = (() => {
    const map = new Map();
    const langs = [...new Set(["en", document.documentElement.lang || "en"])];
    for (const lang of langs) {
      for (const month of ["short", "long"]) {
        let fmt;
        try { fmt = new Intl.DateTimeFormat(lang, { month }); } catch { continue; }
        for (let m = 0; m < 12; m++) {
          const name = fmt.format(new Date(2026, m, 15)).toLowerCase().replace(/\.$/, "");
          map.set(name, m);
        }
      }
    }
    map.set("sept", 8);
    return map;
  })();
  const MONTH_RE = [...MONTHS.keys()].sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const MD_RANGE = new RegExp(`(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:\\s*[-–]\\s*(?:(${MONTH_RE})\\.?\\s+)?(\\d{1,2}))?`, "gi");
  const DM_RANGE = new RegExp(`(\\d{1,2})\\.?\\s*(?:[-–]\\s*(\\d{1,2})\\.?\\s*)?(${MONTH_RE})`, "gi");

  // Month/day with no year: pick the year that puts it nearest after today (Dec -> Jan rollover).
  function dateFrom(month, day) {
    const today = startOfToday();
    const d = new Date(today.getFullYear(), month, day);
    if (d < today - 60 * DAY_MS) d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  // Latest date one delivery option promises ("Nov 30 - Dec 2" -> Dec 2), or null.
  function optionDate(text) {
    const t = text.toLowerCase();
    if (/\btoday\b|\bheute\b|aujourd|\bhoy\b|\boggi\b|vandaag/.test(t)) return startOfToday();
    if (/\btomorrow\b|\bovernight\b|\bmorgen\b|demain|mañana|domani/.test(t)) return daysFromToday(1);
    let best = null;
    for (const m of t.matchAll(MD_RANGE)) {
      const m1 = MONTHS.get(m[1].replace(/\.$/, ""));
      const end = m[4] ? dateFrom(m[3] ? MONTHS.get(m[3].replace(/\.$/, "")) : m1, +m[4]) : dateFrom(m1, +m[2]);
      if (!best || end > best) best = end;
    }
    if (!best) {
      for (const m of t.matchAll(DM_RANGE)) {
        const end = dateFrom(MONTHS.get(m[3].replace(/\.$/, "")), +(m[2] || m[1]));
        if (!best || end > best) best = end;
      }
    }
    return best;
  }

  // Soonest arrival across the card's delivery options (free, or paid "fastest delivery").
  // Returns ms timestamp of the day, or Infinity when the card shows no date.
  function getDeliveryDate(card) {
    const block = card.querySelector('[data-cy="delivery-recipe"], .udm-delivery-block, .s-align-children-center');
    if (!block) return Infinity;
    // Bold spans hold one date per option; fall back to the whole block when they don't.
    let soonest = Infinity;
    for (const s of block.querySelectorAll("span.a-text-bold")) {
      const d = optionDate(s.textContent);
      if (d && +d < soonest) soonest = +d;
    }
    if (!isFinite(soonest)) {
      const text = block.textContent.replace(/\.udm[^}]*\}/g, " ");
      const d = optionDate(text);
      if (d) soonest = +d;
    }
    return soonest;
  }

  function isSponsored(card) {
    return (
      card.classList.contains("AdHolder") ||
      !!card.querySelector(".puis-sponsored-label-text, .s-sponsored-label-text, [aria-label='Sponsored']")
    );
  }

  // "No-name" brands (see gen-brands.py): a hand-made list of 1,000 brands plus ~717k
  // China-owned US trademark names packed in a Bloom filter. Well-known brands are kept.
  // A card matches on its brand line, or the first 1-3 words of its title.
  const brandSet = (s) => new Set((s || "").split("|").filter(Boolean));
  const NO_NAME = brandSet(globalThis.RSA_NO_NAME_BRANDS);
  const KEEP = brandSet(globalThis.RSA_KEEP_BRANDS);
  // Decoded on first use (a search with the filter on), not on every Amazon page.
  let MARKS;
  const marks = () => (MARKS === undefined ? (MARKS = decodeMarks()) : MARKS);
  function decodeMarks() {
    const f = globalThis.RSA_CN_MARKS;
    if (!f) return null;
    const raw = atob(f.bits), bits = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bits[i] = raw.charCodeAt(i);
    return { m: f.m, k: f.k, bits };
  }
  function fnv(s, seed) {
    let h = seed;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h;
  }
  function inMarks(key) {
    const MARKS = marks();
    if (!MARKS) return false;
    const h1 = fnv(key, 2166136261), h2 = (fnv(key, 0x9747b28c) | 1) >>> 0;
    for (let i = 0; i < MARKS.k; i++) {
      const p = (h1 + i * h2) % MARKS.m;
      if (!(MARKS.bits[p >> 3] & (1 << (p & 7)))) return false;
    }
    return true;
  }
  const brandWords = (s) => s.toUpperCase().match(/[A-Z0-9]+/g) || [];
  // null = can't tell, true = no-name, false = known brand
  function judgeBrand(ws) {
    for (let n = 1; n <= Math.min(3, ws.length); n++) {
      const part = ws.slice(0, n), squashed = part.join("");
      if (KEEP.has(squashed)) return false;
      if (squashed.length >= 3 && NO_NAME.has(squashed)) return true;
      if (squashed.length >= 4 && inMarks(part.join(" "))) return true;
    }
    return null;
  }
  function isNoName(card) {
    const recipe = card.querySelector('[data-cy="title-recipe"]');
    // Some layouts (fashion, home) print the brand on its own line above the title.
    const brandLine = recipe?.querySelector("h2.a-size-mini span, .a-row > span.a-size-base-plus.a-color-base, .a-row > span.a-size-medium.a-color-base");
    if (brandLine && !brandLine.closest("a")) {
      // Amazon named the brand, so trust that and don't guess from the title's first words.
      return judgeBrand(brandWords(brandLine.textContent)) === true;
    }
    const h2 = card.querySelector("h2");
    return !!judgeBrand(brandWords(h2?.getAttribute("aria-label") || h2?.textContent || ""));
  }

  // Bayesian average: pulls low-review products toward a prior so 5.0 from 3 reviews
  // doesn't beat 4.7 from 20,000.
  function weightedScore(rating, count, prior = 4.0, weight = 300) {
    if (!rating) return 0;
    return (count / (count + weight)) * rating + (weight / (count + weight)) * prior;
  }

  // ---------- page helpers ----------

  const isSearchPage = () =>
    /\/s(\/|\?|$)/.test(location.pathname + location.search) || location.pathname.startsWith("/s");

  const slot = () => document.querySelector(SLOT_SEL);
  const params = () => new URLSearchParams(location.search);
  const hasDepartment = () => {
    const p = params();
    const i = p.get("i");
    return (i && i !== "aps") || p.has("rh") || p.has("node") || p.has("bbn");
  };

  function decorate(card) {
    if (card.dataset.rsaDone) return;
    card.dataset.rsaDone = "1";
    card.dataset.rsaReviews = String(getReviewCount(card));
    card.dataset.rsaRating = String(getRating(card));
    card.dataset.rsaSponsored = isSponsored(card) ? "1" : "0";

    card.dataset.rsaDelivery = String(getDeliveryDate(card));
  }

  function noName(card) {
    if (!card.dataset.rsaNoName) card.dataset.rsaNoName = isNoName(card) ? "1" : "0";
    return card.dataset.rsaNoName === "1";
  }

  function readCard(card) {
    decorate(card);
    const count = +card.dataset.rsaReviews;
    const rating = +card.dataset.rsaRating;
    return {
      el: card, asin: card.dataset.asin, count, rating, score: weightedScore(rating, count),
      sponsored: card.dataset.rsaSponsored === "1", noName: () => noName(card), delivery: +card.dataset.rsaDelivery,
    };
  }

  async function fetchPage(n) {
    const url = new URL(location.href);
    url.searchParams.set("page", String(n));
    const res = await fetch(url.toString(), { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (/validateCaptcha|api-services-support@amazon\.com/.test(html)) throw new Error("captcha");
    const doc = new DOMParser().parseFromString(html, "text/html");
    return [...doc.querySelectorAll(RESULT_SEL)].map((el) => document.importNode(el, true));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- state + actions ----------

  const state = { extra: [], pagesLoaded: 1, busy: false, again: false, order: new Map(), touched: false };

  function setStatus(text) {
    const s = document.getElementById("rsa-status");
    if (s) s.textContent = text;
  }

  async function loadPages(target) {
    const lastPage = +(document.querySelector(".s-pagination-item.s-pagination-disabled:not(.s-pagination-previous):not(.s-pagination-next)")?.textContent || 0) ||
      +([...document.querySelectorAll(".s-pagination-item")].map((e) => +e.textContent).filter(Boolean).pop() || MAX_PAGES);
    const startPage = +(params().get("page") || 1);
    const want = Math.min(target, MAX_PAGES);
    while (state.pagesLoaded < want) {
      const page = startPage + state.pagesLoaded;
      if (lastPage && page > lastPage) break;
      setStatus(`Loading page ${page} of ${startPage + want - 1}…`);
      try {
        const cards = await fetchPage(page);
        if (!cards.length) break;
        // Keep repeats too: applySort picks the best copy of each product (organic over ad).
        for (const c of cards) { c.dataset.rsaPage = String(state.pagesLoaded + 1); state.extra.push(c); }
      } catch (err) {
        setStatus(err.message === "captcha" ? "Amazon asked for a captcha. Stopped early." : `Couldn't load page ${page}.`);
        return false;
      }
      state.pagesLoaded++;
      await sleep(FETCH_DELAY_MS);
    }
    return true;
  }

  const val = (id) => document.getElementById(id).value;
  const pressed = (id) => document.getElementById(id).getAttribute("aria-pressed") === "true";

  // Runs on every control change. A change made while pages are loading re-runs once at the end.
  async function applySort() {
    if (state.busy) { state.again = true; return; }
    const container = slot();
    if (!container) return;
    state.busy = true;
    const bar = document.getElementById(BAR_ID);
    bar.classList.add("is-busy");
    try {
      const key = val("rsa-key");
      const pages = +val("rsa-pages");
      const ok = await loadPages(pages);
      const pagesUsed = Math.min(pages, state.pagesLoaded);
      const hideAds = pressed("rsa-ads");
      const hideNoName = noNameEnabled() && pressed("rsa-noname");
      const minRating = +val("rsa-min");
      const byDays = val("rsa-by"); // "" = any
      const deadline = byDays === "" ? Infinity : +daysFromToday(+byDays);

      const current = [...container.querySelectorAll(RESULT_SEL)];
      const unique = new Map();
      for (const e of [...current, ...state.extra]) {
        if (!state.order.has(e.dataset.asin)) state.order.set(e.dataset.asin, state.order.size); // Amazon's own order
        e.classList.add("rsa-hidden"); // shown again below if it's the copy we keep
        if (+(e.dataset.rsaPage || 1) > pages) continue; // from a page beyond the Pages setting
        // Same product listed twice (often an ad plus a normal listing): keep the normal one,
        // so "Hide ads" never removes the product entirely.
        const prev = unique.get(e.dataset.asin);
        if (!prev || (isSponsored(prev) && !isSponsored(e))) unique.set(e.dataset.asin, e);
      }
      const all = [...unique.values()].map(readCard);

      const pos = (x) => state.order.get(x.asin);
      const sorters = {
        featured: (a, b) => pos(a) - pos(b),
        native: (a, b) => pos(a) - pos(b), // Amazon already ranked every result by reviews
        reviews: (a, b) => b.count - a.count || b.rating - a.rating,
        rating: (a, b) => b.rating - a.rating || b.count - a.count,
        score: (a, b) => b.score - a.score || b.count - a.count,
        delivery: (a, b) => (a.delivery - b.delivery) || b.score - a.score, // Infinity - Infinity is NaN -> falls through
      };
      all.sort(sorters[key]);

      // Insert all cards before the first current result, so banners above stay put.
      const anchor = current[0] || null;
      const frag = document.createDocumentFragment();
      let shown = 0;
      for (const item of all) {
        const hide = (hideAds && item.sponsored) || (hideNoName && item.noName()) || (minRating && item.rating < minRating) || item.delivery > deadline;
        item.el.classList.toggle("rsa-hidden", !!hide);
        if (!hide) shown++;
        // Only what the listing doesn't already show: the rank in our order, and the weighted
        // score for "Best rated" (Amazon shows the count and delivery date itself).
        let badge = item.el.querySelector(".rsa-badge");
        if (key === "featured" || key === "native" || hide) { badge?.remove(); }
        else {
          if (!badge) {
            badge = document.createElement("div");
            badge.className = "rsa-badge";
            placeBadge(item.el, badge);
          }
          const label = { reviews: "most reviewed", rating: "highest rated", score: "best rated", delivery: "soonest to arrive" }[key];
          badge.innerHTML = `<b>#${shown}</b> ${label}` +
            (key === "score" ? `<span title="Star rating adjusted for how many reviews back it up">Weighted score ${item.score.toFixed(2)}</span>` : "");
        }
        frag.appendChild(item.el);
      }
      if (anchor && anchor.parentNode === container) container.insertBefore(frag, anchor);
      else container.prepend(frag);

      // Hide in-feed widgets/carousels between results so the sorted list reads cleanly.
      container.querySelectorAll(":scope > div:not([data-component-type='s-search-result'])").forEach((el) => {
        if (el.querySelector(RESULT_SEL) || el.matches(".s-pagination-container, [cel_widget_id*='MAIN-PAGINATION']")) return;
        if (el.compareDocumentPosition(container.querySelector(RESULT_SEL)) & Node.DOCUMENT_POSITION_PRECEDING) el.classList.add("rsa-hidden");
      });

      if (ok) setStatus(`${shown.toLocaleString()} results from ${pagesUsed} page${pagesUsed > 1 ? "s" : ""}`);
      document.getElementById("rsa-reset").hidden = false;
      refreshMore();
    } finally {
      state.busy = false;
      bar.classList.remove("is-busy");
      if (state.again) { state.again = false; applySort(); }
    }
  }

  // Put the summary line in the card's text column, right under the star rating, so it sits
  // with the product details in both the grid and the wide list layout.
  function placeBadge(card, badge) {
    const after = card.querySelector('[data-cy="reviews-block"]') || card.querySelector('[data-cy="title-recipe"]');
    if (after) { after.after(badge); return; }
    const h2 = card.querySelector("h2");
    const row = h2 && (h2.closest("a") || h2).parentElement;
    if (row) row.append(badge);
    else (card.querySelector(".s-card-container, .puis-card-container") || card).prepend(badge);
  }

  // Marks a dropdown as changed from its default, the way Amazon outlines an applied filter.
  function markSet(select) {
    const base = BASE[Object.keys(FIELDS).find((k) => FIELDS[k] === select.id)];
    select.closest(".rsa-dd").classList.toggle("is-set", base === undefined ? select.selectedIndex !== 0 : select.value !== base);
  }

  // ---------- saved defaults ----------
  // Kept in this Amazon site's localStorage (each country site has its own), so the same
  // code works as an extension content script and as an Ardia/Violentmonkey userscript.

  const STORE_KEY = "rsa-defaults-v1";
  const SKIP_KEY = "rsa-skip-defaults"; // set by Clear so the reload shows Amazon's own page
  const BASE = { key: "featured", by: "", min: "0", pages: "3", ads: false, noname: false };
  const FIELDS = { key: "rsa-key", by: "rsa-by", min: "rsa-min", pages: "rsa-pages" };

  // Add-on settings (not search defaults). Kept per Amazon site, like the defaults.
  const SETTINGS_KEY = "rsa-settings-v1";
  const SETTINGS_BASE = { noNameFilter: false }; // experimental features are off until turned on
  function loadSettings() {
    try { return { ...SETTINGS_BASE, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
    catch { return { ...SETTINGS_BASE }; }
  }
  function saveSettings(v) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(v)); return true; } catch { return false; }
  }
  const noNameEnabled = () => loadSettings().noNameFilter === true;

  function loadDefaults() {
    try { const v = JSON.parse(localStorage.getItem(STORE_KEY)); return v && typeof v === "object" ? { ...BASE, ...v } : null; }
    catch { return null; }
  }
  function saveDefaults(v) {
    try { v ? localStorage.setItem(STORE_KEY, JSON.stringify(v)) : localStorage.removeItem(STORE_KEY); return true; }
    catch { return false; }
  }
  const sameSettings = (a, b) => !!a && !!b && Object.keys(BASE).every((k) => a[k] === b[k]);
  const changesResults = (v) => v.key !== BASE.key || v.by !== BASE.by || v.min !== BASE.min || v.ads || v.noname;

  function readControls() {
    const v = {};
    for (const [k, id] of Object.entries(FIELDS)) v[k] = val(id);
    v.ads = pressed("rsa-ads");
    v.noname = noNameEnabled() && pressed("rsa-noname");
    return v;
  }
  function writeControls(v) {
    for (const [k, id] of Object.entries(FIELDS)) {
      const sel = document.getElementById(id);
      sel.value = v[k];
      if (sel.selectedIndex < 0) sel.value = BASE[k]; // a saved option that no longer exists
      markSet(sel);
    }
    document.getElementById("rsa-ads").setAttribute("aria-pressed", String(!!v.ads));
    document.getElementById("rsa-noname").setAttribute("aria-pressed", String(!!v.noname));
  }

  // Shows "Save as default" when the bar differs from what's saved, and "Forget defaults" when
  // something is saved.
  function refreshDefaultsUI() {
    const saved = loadDefaults();
    const same = sameSettings(saved, readControls());
    // Offered only after you change something here, so Clear or Forget don't nag.
    document.getElementById("rsa-save").hidden = !state.touched || same || (!saved && sameSettings(BASE, readControls()));
    document.getElementById("rsa-forget").hidden = !saved;
    document.getElementById("rsa-forget").textContent = same ? "Forget defaults" : "Forget saved defaults";
    refreshMore();
  }

  // The ⋯ button only shows when its menu has something in it.
  function refreshMore() {
    const empty = [...document.querySelectorAll("#rsa-menu button")].every((b) => b.hidden);
    document.getElementById("rsa-more").hidden = empty;
    if (empty) document.getElementById("rsa-menu").hidden = true;
  }

  function resetSort() {
    // Reload the page as Amazon served it, without applying saved defaults this once.
    try { sessionStorage.setItem(SKIP_KEY, "1"); } catch {}
    if (nativeActive()) location.href = withoutNativeSort();
    else location.reload();
  }

  // Amazon ignores review-count-rank without a department, so borrow the top
  // department from the left sidebar's category links when none is set.
  function topDepartmentParams() {
    const link = document.querySelector(
      '#s-refinements a[href*="rh=n%3A"], #s-refinements a[href*="rh=n:"], #departments a[href*="i="]'
    );
    if (!link) return null;
    const p = new URL(link.href, location.origin).searchParams;
    const out = {};
    for (const k of ["i", "rh"]) if (p.get(k)) out[k] = p.get(k);
    return Object.keys(out).length ? out : null;
  }

  function nativeSort() {
    const url = new URL(location.href);
    if (!hasDepartment()) {
      const dept = topDepartmentParams();
      if (!dept) {
        showDepartmentPicker();
        return;
      }
      for (const [k, v] of Object.entries(dept)) url.searchParams.set(k, v);
    }
    url.searchParams.set("sort", "review-count-rank");
    url.searchParams.delete("page");
    location.href = url.toString();
  }

  // Broad searches have no department in the sidebar. Offer Amazon's own list from the
  // search box dropdown ("search-alias=electronics" -> i=electronics).
  function showDepartmentPicker() {
    if (document.getElementById("rsa-dept")) return;
    const opts = [...document.querySelectorAll("select#searchDropdownBox option")]
      .map((o) => ({ alias: (o.value.match(/search-alias=([\w-]+)/) || [])[1], name: o.textContent.trim() }))
      .filter((o) => o.alias && o.alias !== "aps");
    if (!opts.length) {
      setStatus("Amazon's sort needs a department. Pick one in the left sidebar first.");
      return;
    }
    const wrap = document.createElement("label");
    wrap.className = "rsa-dd is-set";
    wrap.innerHTML = `<span class="rsa-dd-label">Department</span>`;
    const sel = document.createElement("select");
    sel.id = "rsa-dept";
    wrap.append(sel);
    wrap.insertAdjacentHTML("beforeend", CHEVRON);
    sel.innerHTML = `<option value="">Choose one</option>` +
      opts.map((o) => `<option value="${o.alias}">${o.name.replace(/</g, "&lt;")}</option>`).join("");
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      const url = new URL(location.href);
      url.searchParams.set("i", sel.value);
      url.searchParams.set("sort", "review-count-rank");
      url.searchParams.delete("page");
      location.href = url.toString();
    });
    document.querySelector("#rsa-bar .rsa-controls").append(wrap);
    setStatus("Amazon's sort needs a department.");
    sel.focus();
  }

  // ---------- UI ----------

  const CHEVRON = `<svg class="rsa-chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const dropdown = (id, label, title, options) => `
      <label class="rsa-dd" title="${title}"><span class="rsa-dd-label">${label}</span>
        <select id="${id}">${options.map(([v, t, sel]) => `<option value="${v}"${sel ? " selected" : ""}>${t}</option>`).join("")}</select>${CHEVRON}
      </label>`;

  const PENDING_KEY = "rsa-pending-sort"; // the sort to apply after leaving Amazon's ranking
  const nativeActive = () => params().get("sort") === "review-count-rank";

  // The second group's label says how much of the search gets re-sorted.
  function labelOurs() {
    const n = +val("rsa-pages");
    document.getElementById("rsa-ours").setAttribute("label", n === 1 ? "Custom Sort (this page)" : `Custom Sort (first ${n} pages)`);
  }

  // Moving into or out of Amazon's own ranking needs a new page from Amazon.
  // Returns true when it navigates (or waits on the department picker).
  function switchRanking(key) {
    if (key === "native" && !nativeActive()) { nativeSort(); return true; }
    if (key !== "native" && nativeActive()) {
      try { sessionStorage.setItem(PENDING_KEY, key); } catch {} // also stops a saved default sending us back
      location.href = withoutNativeSort();
      return true;
    }
    return false;
  }
  function withoutNativeSort() {
    const url = new URL(location.href);
    url.searchParams.delete("sort");
    url.searchParams.delete("page");
    return url.toString();
  }

  function buildBar() {
    const bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Review sort");
    bar.innerHTML = `
      <div class="rsa-brand"><span class="rsa-mark" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M1 9V5M5 9V1M9 9V3" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></span>Review Sort
        <button id="rsa-info" class="rsa-info" type="button" aria-expanded="false" aria-controls="rsa-tip" aria-label="How Review Sort works">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".95" fill="currentColor"/></svg>
        </button>
        <div id="rsa-tip" class="rsa-tip" role="dialog" aria-label="How Review Sort works" hidden>
          <h4>Find what people actually buy and like</h4>
          <p>Amazon puts popular and sponsored items first. Review Sort reorders the results so the most trusted products rise to the top.</p>
          <div class="rsa-tip-row"><span class="rsa-tip-ic" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 10h15M10 2.5c2.2 2.4 2.2 12.6 0 15M10 2.5c-2.2 2.4-2.2 12.6 0 15" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span><div><b>Amazon Sort</b><span>Amazon lines up every matching product by number of reviews. The most thorough option, but it can only sort by reviews.</span></div></div>
          <div class="rsa-tip-row"><span class="rsa-tip-ic" aria-hidden="true"><svg viewBox="0 0 20 20"><rect x="5.5" y="3" width="10" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 6v10.5A1.5 1.5 0 0 0 5 18h8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8.5 7.5h4M8.5 10.5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span><div><b>Custom Sort</b><span>Sorts Amazon doesn't offer: best rated, highest stars and soonest delivery, plus filters for arrival date and ads. To do this, Review Sort reorders the first pages you'd see (you pick how many with Pages).</span></div></div>
          <div class="rsa-tip-row"><span class="rsa-tip-ic" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></span><div><b>Best rated</b><span>Weighs stars against how many people gave them, so 5 stars from 3 people won't beat 4.7 stars from 20,000.</span></div></div>
          <div class="rsa-tip-foot">Like your setup? Click <b>Save as default</b> and it's used on every search. More options are under <b>⋯ → Settings</b>.</div>
        </div>
      </div>
      <div class="rsa-controls">
        <label class="rsa-dd" title="Order of results"><span class="rsa-dd-label">Sort</span>
          <select id="rsa-key">
            <optgroup label="Amazon Sort">
              <option value="featured">Featured</option>
              <option value="native">Most reviews (all results)</option>
            </optgroup>
            <optgroup id="rsa-ours" label="Custom Sort (first 3 pages)">
              <option value="reviews">Most reviews</option>
              <option value="score">Best rated</option>
              <option value="rating">Highest stars</option>
              <option value="delivery">Soonest delivery</option>
            </optgroup>
          </select>${CHEVRON}
        </label>
        ${dropdown("rsa-by", "Arrives", "Soonest option on the card, free or paid", [
          ["", "Any time"], ["0", "Today"], ["1", "By tomorrow"], ["2", "Within 2 days"],
          ["3", "Within 3 days"], ["7", "Within a week"], ["14", "Within 2 weeks"],
        ])}
        ${dropdown("rsa-min", "Stars", "Minimum star rating", [["0", "Any"], ["4", "4 & up"], ["4.5", "4.5 & up"]])}
        ${dropdown("rsa-pages", "Pages", "Result pages to load and merge before sorting", [
          ["1", "1"], ["2", "2"], ["3", "3", true], ["5", "5"], ["10", "10"],
        ])}
        <button id="rsa-ads" class="rsa-chip" type="button" aria-pressed="false">
          <svg class="rsa-tick" viewBox="0 0 12 10" aria-hidden="true"><path d="M1 5.5l3.2 3L11 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Hide ads
        </button>
        <button id="rsa-noname" ${noNameEnabled() ? "" : "hidden"} title="Hides brands whose US trademark is owned from China, except well-known ones like Anker or Xiaomi" class="rsa-chip" type="button" aria-pressed="false">
          <svg class="rsa-tick" viewBox="0 0 12 10" aria-hidden="true"><path d="M1 5.5l3.2 3L11 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Hide no-name brands
        </button>
      </div>
      <div class="rsa-meta">
        <span id="rsa-status" aria-live="polite"></span>
        <button id="rsa-save" class="rsa-link" type="button" hidden title="Use these settings on every Amazon search">Save as default</button>
        <div class="rsa-menu-wrap">
          <button id="rsa-more" class="rsa-more" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="More options">
            <svg viewBox="0 0 16 4" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="8" cy="2" r="1.6"/><circle cx="14" cy="2" r="1.6"/></svg>
          </button>
          <div id="rsa-menu" class="rsa-menu" role="menu" hidden>
            <button id="rsa-reset" role="menuitem" type="button" hidden>Clear sorting</button>
            <button id="rsa-forget" role="menuitem" type="button" hidden>Forget defaults</button>
            <button id="rsa-open-settings" role="menuitem" type="button">Settings</button>
          </div>
        </div>
      </div>`;
    // The "Include" dropdown is marked set only when it differs from its default (3 pages).
    bar.querySelectorAll("select").forEach((sel) => {
      sel.addEventListener("change", () => {
        if (sel.id === "rsa-key" && switchRanking(sel.value)) return;
        if (sel.id === "rsa-pages") labelOurs();
        markSet(sel);
        state.touched = true;
        refreshDefaultsUI();
        applySort();
      });
    });
    bar.querySelectorAll(".rsa-chip").forEach((chip) => chip.addEventListener("click", (e) => {
      const b = e.currentTarget;
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      state.touched = true;
      refreshDefaultsUI();
      applySort();
    }));
    const more = bar.querySelector("#rsa-more"), menu = bar.querySelector("#rsa-menu");
    const setMenu = (open) => { menu.hidden = !open; more.setAttribute("aria-expanded", String(open)); };
    more.addEventListener("click", () => {
      setMenu(menu.hidden);
      if (!menu.hidden) menu.querySelector("button:not([hidden]):not(:disabled)")?.focus();
    });
    menu.addEventListener("click", () => setMenu(false));
    const info = bar.querySelector("#rsa-info"), tip = bar.querySelector("#rsa-tip");
    const setTip = (open) => { tip.hidden = !open; info.setAttribute("aria-expanded", String(open)); };
    info.addEventListener("click", () => setTip(tip.hidden));
    document.addEventListener("click", (e) => {
      if (!bar.isConnected) return;
      if (!e.target.closest?.(".rsa-menu-wrap")) setMenu(false);
      if (!e.target.closest?.(".rsa-brand")) setTip(false);
    });
    bar.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!menu.hidden) { setMenu(false); more.focus(); }
      if (!tip.hidden) { setTip(false); info.focus(); }
    });
    bar.querySelector("#rsa-reset").addEventListener("click", resetSort);
    bar.querySelector("#rsa-open-settings").addEventListener("click", openSettings);
    bar.querySelector("#rsa-save").addEventListener("click", () => {
      setStatus(saveDefaults(readControls()) ? "Saved. These settings now apply to every search." : "Couldn't save: this browser blocks site storage.");
      refreshDefaultsUI();
    });
    bar.querySelector("#rsa-forget").addEventListener("click", () => {
      saveDefaults(null);
      state.touched = false;
      setStatus("Defaults forgotten. Searches open in Amazon's order.");
      refreshDefaultsUI();
    });
    return bar;
  }

  // ---------- settings ----------
  // A dialog on the Amazon page itself, so it works the same in the extension and as a
  // userscript (which has no extension pages). Opened from ⋯ -> Settings.
  const DIALOG_ID = "rsa-dialog";

  function openSettings() {
    document.getElementById(DIALOG_ID)?.remove();
    const dlg = document.createElement("dialog");
    dlg.id = DIALOG_ID;
    dlg.setAttribute("aria-labelledby", "rsa-dialog-title");
    const site = location.hostname.replace(/^www\./, "");
    dlg.innerHTML = `<div class="rsa-dlg-body">
      <div class="rsa-dlg-head">
        <h2 id="rsa-dialog-title">Review Sort settings</h2>
        <button type="button" class="rsa-dlg-x" aria-label="Close"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
      <section>
        <h3>Defaults for every search</h3>
        <p class="rsa-dlg-note">Applied each time you search on ${site}.</p>
        <div class="rsa-dlg-fields"></div>
        <label class="rsa-dlg-check"><input type="checkbox" id="rsa-d-ads"> Hide ads</label>
        <label class="rsa-dlg-check" id="rsa-d-noname-row"><input type="checkbox" id="rsa-d-noname"> Hide no-name brands</label>
        <div class="rsa-dlg-actions">
          <button type="button" class="rsa-btn-primary" id="rsa-d-save">Save defaults</button>
          <button type="button" class="rsa-btn" id="rsa-d-forget">Use Amazon's normal results</button>
          <span class="rsa-dlg-msg" role="status"></span>
        </div>
      </section>
      <section class="rsa-dlg-exp">
        <h3>Experimental <span class="rsa-tag">Beta</span></h3>
        <label class="rsa-switch-row">
          <span><b>No-name brand filter</b>
            <span class="rsa-dlg-note">Adds a "Hide no-name brands" button. It hides brands whose US trademark is owned from China, except well-known ones like Anker or Xiaomi. It can miss unbranded listings and now and then hide a real brand.</span></span>
          <input type="checkbox" role="switch" id="rsa-d-exp-noname" class="rsa-switch">
        </label>
      </section></div>`;
    // The default fields reuse the bar's own dropdowns, so the choices always match.
    const fields = dlg.querySelector(".rsa-dlg-fields");
    const labels = { key: "Sort", by: "Arrives", min: "Stars", pages: "Pages" };
    for (const [k, id] of Object.entries(FIELDS)) {
      const sel = document.getElementById(id).cloneNode(true);
      sel.id = "rsa-d-" + k;
      sel.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
      const row = document.createElement("label");
      row.className = "rsa-dlg-field";
      row.innerHTML = `<span>${labels[k]}</span>`;
      row.append(sel);
      fields.append(row);
    }
    const $ = (sel) => dlg.querySelector(sel);
    const msg = (t) => { $(".rsa-dlg-msg").textContent = t; };
    const fill = () => {
      const v = loadDefaults() || BASE;
      for (const k of Object.keys(FIELDS)) {
        const sel = $("#rsa-d-" + k);
        sel.value = v[k];
        if (sel.selectedIndex < 0) sel.value = BASE[k];
      }
      $("#rsa-d-ads").checked = !!v.ads;
      $("#rsa-d-noname").checked = !!v.noname && noNameEnabled();
      $("#rsa-d-noname-row").hidden = !noNameEnabled();
      $("#rsa-d-exp-noname").checked = noNameEnabled();
    };
    fill();

    $("#rsa-d-save").addEventListener("click", () => {
      const v = { ads: $("#rsa-d-ads").checked, noname: noNameEnabled() && $("#rsa-d-noname").checked };
      for (const k of Object.keys(FIELDS)) v[k] = $("#rsa-d-" + k).value;
      if (!saveDefaults(v)) { msg("Couldn't save: this browser blocks site storage."); return; }
      if (v.key === "native" && !nativeActive()) {
        msg("Saved. Amazon's own ranking starts on your next search.");
        v.key = val("rsa-key"); // switching to it needs a new page; leave this one as is
      } else if (v.key !== "native" && nativeActive()) {
        msg("Saved. Applies from your next search.");
        v.key = "native"; // this page is Amazon's ranking; leave it
      } else msg("Saved.");
      writeControls(v);
      state.touched = false;
      refreshDefaultsUI();
      applySort();
    });
    $("#rsa-d-forget").addEventListener("click", () => {
      saveDefaults(null);
      state.touched = false;
      refreshDefaultsUI();
      fill();
      msg("Defaults cleared. Searches open as Amazon shows them.");
    });
    $("#rsa-d-exp-noname").addEventListener("change", (e) => {
      const on = e.target.checked;
      saveSettings({ ...loadSettings(), noNameFilter: on });
      const chip = document.getElementById("rsa-noname");
      chip.hidden = !on;
      if (!on && chip.getAttribute("aria-pressed") === "true") {
        chip.setAttribute("aria-pressed", "false");
        applySort();
      }
      $("#rsa-d-noname-row").hidden = !on;
      if (!on) $("#rsa-d-noname").checked = false;
      refreshDefaultsUI();
      msg(on ? "No-name brand filter turned on. Its button is now in the bar." : "No-name brand filter turned off.");
    });
    const close = () => { dlg.close(); dlg.remove(); document.getElementById("rsa-more")?.focus(); };
    $(".rsa-dlg-x").addEventListener("click", close);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); }); // backdrop (the body fills the dialog box)
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); }); // Escape
    document.body.append(dlg);
    dlg.showModal();
  }

  function inject() {
    if (!isSearchPage() || document.getElementById(BAR_ID)) return;
    const container = slot();
    if (!container || !container.querySelector(RESULT_SEL)) return;
    const host = container.closest(".s-desktop-content, .sg-col-inner, .s-matching-dir") || container.parentNode;
    host.insertBefore(buildBar(), host.firstChild === container ? container : host.firstChild);

    let skip = false, pending = null;
    try {
      skip = sessionStorage.getItem(SKIP_KEY) === "1"; sessionStorage.removeItem(SKIP_KEY);
      pending = sessionStorage.getItem(PENDING_KEY); sessionStorage.removeItem(PENDING_KEY);
    } catch {}
    const saved = loadDefaults();
    let start = saved && !skip ? { ...saved } : { ...BASE };
    if (pending) { start.key = pending; state.touched = true; }
    if (!noNameEnabled()) start.noname = false;
    if (nativeActive()) start.key = "native";
    else if (start.key === "native") {
      // A saved default of Amazon's ranking: go there when Amazon can do it without asking.
      // Only when the search already has a department, so it never quietly narrows a broad
      // search, and never over a sort the shopper picked in Amazon's own dropdown.
      if (!pending && hasDepartment() && !params().get("s")) { writeControls(start); nativeSort(); return; }
      start.key = "featured";
    }
    writeControls(start);
    labelOurs();
    if (changesResults(start)) applySort();
    refreshDefaultsUI();
  }

  inject();
  // Amazon swaps result content in place on some filter clicks; re-inject when that happens.
  new MutationObserver(() => {
    if (!document.getElementById(BAR_ID)) {
      state.extra = []; state.pagesLoaded = 1; state.order = new Map();
      inject();
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Expose parsers for testing.
  window.__rsa = { parseCount, lastNumberToken, weightedScore, getReviewCount, getRating, optionDate, getDeliveryDate };
})();
