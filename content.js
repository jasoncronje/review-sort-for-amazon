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
    if (/\btomorrow\b|\bovernight\b|\bmorgen\b|demain|mañana|domani/.test(t)) return new Date(+startOfToday() + DAY_MS);
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

  function readCard(card) {
    decorate(card);
    const count = +card.dataset.rsaReviews;
    const rating = +card.dataset.rsaRating;
    return {
      el: card, asin: card.dataset.asin, count, rating, score: weightedScore(rating, count),
      sponsored: card.dataset.rsaSponsored === "1", delivery: +card.dataset.rsaDelivery,
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
    const seen = new Set([...document.querySelectorAll(RESULT_SEL)].map((e) => e.dataset.asin).concat(state.extra.map((e) => e.dataset.asin)));
    while (state.pagesLoaded < want) {
      const page = startPage + state.pagesLoaded;
      if (lastPage && page > lastPage) break;
      setStatus(`Loading page ${page} of ${startPage + want - 1}…`);
      try {
        const cards = await fetchPage(page);
        if (!cards.length) break;
        for (const c of cards) if (!seen.has(c.dataset.asin)) { seen.add(c.dataset.asin); state.extra.push(c); }
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
      const ok = await loadPages(+val("rsa-pages"));
      const hideAds = document.getElementById("rsa-ads").getAttribute("aria-pressed") === "true";
      const minRating = +val("rsa-min");
      const byDays = val("rsa-by"); // "" = any
      const deadline = byDays === "" ? Infinity : +startOfToday() + +byDays * DAY_MS;

      const current = [...container.querySelectorAll(RESULT_SEL)];
      const unique = new Map();
      for (const e of [...current, ...state.extra]) {
        if (!state.order.has(e.dataset.asin)) state.order.set(e.dataset.asin, state.order.size); // Amazon's own order
        if (unique.has(e.dataset.asin)) e.classList.add("rsa-hidden"); // same product listed twice (ad + organic)
        else unique.set(e.dataset.asin, e);
      }
      const all = [...unique.values()].map(readCard);

      const pos = (x) => state.order.get(x.asin);
      const sorters = {
        featured: (a, b) => pos(a) - pos(b),
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
        const hide = (hideAds && item.sponsored) || (minRating && item.rating < minRating) || item.delivery > deadline;
        item.el.classList.toggle("rsa-hidden", !!hide);
        if (!hide) shown++;
        // Only what the listing doesn't already show: the rank in our order, and the weighted
        // score for "Best rated" (Amazon shows the count and delivery date itself).
        let badge = item.el.querySelector(".rsa-badge");
        if (key === "featured" || hide) { badge?.remove(); }
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

      if (ok) setStatus(`${shown.toLocaleString()} results from ${state.pagesLoaded} page${state.pagesLoaded > 1 ? "s" : ""}`);
      document.getElementById("rsa-reset").hidden = false;
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
  const BASE = { key: "featured", by: "", min: "0", pages: "3", ads: false };
  const FIELDS = { key: "rsa-key", by: "rsa-by", min: "rsa-min", pages: "rsa-pages" };

  function loadDefaults() {
    try { const v = JSON.parse(localStorage.getItem(STORE_KEY)); return v && typeof v === "object" ? { ...BASE, ...v } : null; }
    catch { return null; }
  }
  function saveDefaults(v) {
    try { v ? localStorage.setItem(STORE_KEY, JSON.stringify(v)) : localStorage.removeItem(STORE_KEY); return true; }
    catch { return false; }
  }
  const sameSettings = (a, b) => !!a && !!b && Object.keys(BASE).every((k) => a[k] === b[k]);
  const changesResults = (v) => v.key !== BASE.key || v.by !== BASE.by || v.min !== BASE.min || v.ads;

  function readControls() {
    const v = {};
    for (const [k, id] of Object.entries(FIELDS)) v[k] = val(id);
    v.ads = document.getElementById("rsa-ads").getAttribute("aria-pressed") === "true";
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
  }

  function resetSort() {
    // Reload the page as Amazon served it, without applying saved defaults this once.
    try { sessionStorage.setItem(SKIP_KEY, "1"); } catch {}
    location.reload();
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
    wrap.className = "rsa-dd";
    wrap.innerHTML = `<span class="rsa-dd-label">Department:</span>`;
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
    document.getElementById("rsa-native").after(wrap);
    setStatus("Amazon's sort needs a department.");
    sel.focus();
  }

  // ---------- UI ----------

  const CHEVRON = `<svg class="rsa-chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const dropdown = (id, label, title, options) => `
      <label class="rsa-dd" title="${title}"><span class="rsa-dd-label">${label}</span>
        <select id="${id}">${options.map(([v, t, sel]) => `<option value="${v}"${sel ? " selected" : ""}>${t}</option>`).join("")}</select>${CHEVRON}
      </label>`;

  function buildBar() {
    const bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Review sort");
    const nativeActive = params().get("sort") === "review-count-rank";
    bar.innerHTML = `
      <div class="rsa-controls">
        ${dropdown("rsa-key", "Sort by:", "Order of results", [
          ["featured", "Featured"], ["reviews", "Most reviews"], ["score", "Best rated"],
          ["rating", "Highest stars"], ["delivery", "Soonest delivery"],
        ])}
        ${dropdown("rsa-by", "Arrives:", "Soonest option on the card, free or paid", [
          ["", "Any time"], ["0", "Today"], ["1", "By tomorrow"], ["2", "Within 2 days"],
          ["3", "Within 3 days"], ["7", "Within a week"], ["14", "Within 2 weeks"],
        ])}
        ${dropdown("rsa-min", "Rating:", "Minimum star rating", [["0", "Any"], ["4", "4 stars & up"], ["4.5", "4.5 stars & up"]])}
        ${dropdown("rsa-pages", "Include:", "Result pages to load and merge before sorting", [
          ["1", "This page"], ["2", "2 pages"], ["3", "3 pages", true], ["5", "5 pages"], ["10", "10 pages"],
        ])}
        <button id="rsa-ads" class="rsa-chip" type="button" aria-pressed="false">
          <svg class="rsa-tick" viewBox="0 0 12 10" aria-hidden="true"><path d="M1 5.5l3.2 3L11 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Hide sponsored
        </button>
      </div>
      <div class="rsa-meta">
        <span id="rsa-status" aria-live="polite"></span>
        <button id="rsa-reset" class="rsa-link" type="button" hidden>Clear</button>
        <button id="rsa-save" class="rsa-link" type="button" hidden title="Use these settings on every Amazon search">Save as default</button>
        <button id="rsa-forget" class="rsa-link" type="button" hidden>Forget defaults</button>
        <button id="rsa-native" class="rsa-link" type="button" title="Amazon's own review-count sort across every page. Needs a department."
          ${nativeActive ? "disabled" : ""}>${nativeActive ? "Using Amazon's review sort" : "Use Amazon's review sort"}</button>
      </div>`;
    // The "Include" dropdown is marked set only when it differs from its default (3 pages).
    bar.querySelectorAll("select").forEach((sel) => {
      sel.addEventListener("change", () => {
        markSet(sel);
        state.touched = true;
        refreshDefaultsUI();
        applySort();
      });
    });
    bar.querySelector("#rsa-ads").addEventListener("click", (e) => {
      const b = e.currentTarget;
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      state.touched = true;
      refreshDefaultsUI();
      applySort();
    });
    bar.querySelector("#rsa-reset").addEventListener("click", resetSort);
    bar.querySelector("#rsa-native").addEventListener("click", nativeSort);
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

  function inject() {
    if (!isSearchPage() || document.getElementById(BAR_ID)) return;
    const container = slot();
    if (!container || !container.querySelector(RESULT_SEL)) return;
    const host = container.closest(".s-desktop-content, .sg-col-inner, .s-matching-dir") || container.parentNode;
    host.insertBefore(buildBar(), host.firstChild === container ? container : host.firstChild);

    let skip = false;
    try { skip = sessionStorage.getItem(SKIP_KEY) === "1"; sessionStorage.removeItem(SKIP_KEY); } catch {}
    const saved = loadDefaults();
    if (saved && !skip) {
      writeControls(saved);
      if (changesResults(saved)) applySort();
    }
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
