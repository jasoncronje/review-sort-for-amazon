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
  }

  function readCard(card) {
    decorate(card);
    const count = +card.dataset.rsaReviews;
    const rating = +card.dataset.rsaRating;
    return { el: card, asin: card.dataset.asin, count, rating, score: weightedScore(rating, count), sponsored: card.dataset.rsaSponsored === "1" };
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

  const state = { extra: [], pagesLoaded: 1, busy: false, original: null };

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
      setStatus(`Loading page ${page}…`);
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

  async function applySort() {
    if (state.busy) return;
    const container = slot();
    if (!container) return;
    state.busy = true;
    const btn = document.getElementById("rsa-apply");
    btn.disabled = true;
    try {
      if (!state.original) state.original = [...container.querySelectorAll(RESULT_SEL)];
      const key = document.getElementById("rsa-key").value;
      const pages = +document.getElementById("rsa-pages").value;
      const hideAds = document.getElementById("rsa-ads").checked;
      const minRating = +document.getElementById("rsa-min").value;

      const ok = await loadPages(pages);

      const current = [...container.querySelectorAll(RESULT_SEL)];
      const unique = new Map();
      for (const e of [...current, ...state.extra]) {
        if (unique.has(e.dataset.asin)) e.classList.add("rsa-hidden"); // same product listed twice (ad + organic)
        else unique.set(e.dataset.asin, e);
      }
      const all = [...unique.values()].map(readCard);

      const sorters = {
        reviews: (a, b) => b.count - a.count || b.rating - a.rating,
        rating: (a, b) => b.rating - a.rating || b.count - a.count,
        score: (a, b) => b.score - a.score || b.count - a.count,
      };
      all.sort(sorters[key]);

      // Insert all sorted cards before the first current result, so banners above stay put.
      const anchor = current[0] || null;
      const frag = document.createDocumentFragment();
      let shown = 0;
      for (const item of all) {
        const hide = (hideAds && item.sponsored) || (minRating && item.rating < minRating);
        item.el.classList.toggle("rsa-hidden", !!hide);
        if (!hide) shown++;
        let badge = item.el.querySelector(".rsa-badge");
        if (!badge) {
          badge = document.createElement("div");
          badge.className = "rsa-badge";
          (item.el.querySelector(".s-card-container, .puis-card-container") || item.el).prepend(badge);
        }
        badge.textContent = `${item.count.toLocaleString()} reviews · ${item.rating ? item.rating.toFixed(1) + "★" : "no rating"}`;
        frag.appendChild(item.el);
      }
      if (anchor && anchor.parentNode === container) container.insertBefore(frag, anchor);
      else container.prepend(frag);

      // Hide in-feed widgets/carousels between results so the sorted list reads cleanly.
      container.querySelectorAll(":scope > div:not([data-component-type='s-search-result'])").forEach((el) => {
        if (el.querySelector(RESULT_SEL) || el.matches(".s-pagination-container, [cel_widget_id*='MAIN-PAGINATION']")) return;
        if (el.compareDocumentPosition(container.querySelector(RESULT_SEL)) & Node.DOCUMENT_POSITION_PRECEDING) el.classList.add("rsa-hidden");
      });

      if (ok) setStatus(`Sorted ${shown} products from ${state.pagesLoaded} page${state.pagesLoaded > 1 ? "s" : ""}.`);
      document.getElementById("rsa-reset").hidden = false;
    } finally {
      state.busy = false;
      btn.disabled = false;
    }
  }

  function resetSort() {
    // Simplest faithful reset: reload the page as Amazon served it.
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
    const sel = document.createElement("select");
    sel.id = "rsa-dept";
    sel.innerHTML = `<option value="">Pick a department…</option>` +
      opts.map((o) => `<option value="${o.alias}">${o.name.replace(/</g, "&lt;")}</option>`).join("");
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      const url = new URL(location.href);
      url.searchParams.set("i", sel.value);
      url.searchParams.set("sort", "review-count-rank");
      url.searchParams.delete("page");
      location.href = url.toString();
    });
    document.getElementById("rsa-native").after(sel);
    setStatus("Amazon's sort needs a department.");
    sel.focus();
  }

  // ---------- UI ----------

  function buildBar() {
    const bar = document.createElement("div");
    bar.id = BAR_ID;
    const nativeActive = params().get("sort") === "review-count-rank";
    bar.innerHTML = `
      <span class="rsa-title">Sort</span>
      <select id="rsa-key" title="What to sort by">
        <option value="reviews">Most reviews</option>
        <option value="score">Best rated (weighted)</option>
        <option value="rating">Highest stars</option>
      </select>
      <select id="rsa-pages" title="How many result pages to include">
        ${[1, 2, 3, 5, 10].map((n) => `<option value="${n}"${n === 3 ? " selected" : ""}>${n === 1 ? "This page" : n + " pages"}</option>`).join("")}
      </select>
      <select id="rsa-min" title="Minimum star rating">
        <option value="0">Any stars</option><option value="4">4★+</option><option value="4.5">4.5★+</option>
      </select>
      <label class="rsa-check"><input type="checkbox" id="rsa-ads" checked> Hide sponsored</label>
      <button id="rsa-apply" class="rsa-primary" type="button">Sort</button>
      <button id="rsa-reset" type="button" hidden>Reset</button>
      <button id="rsa-native" type="button" title="Amazon's own review-count sort across all pages. Needs a department; the top one is used if none is picked."
        ${nativeActive ? "disabled" : ""}>${nativeActive ? "Amazon sort on" : "Amazon's sort"}</button>
      <span id="rsa-status"></span>`;
    bar.querySelector("#rsa-apply").addEventListener("click", applySort);
    bar.querySelector("#rsa-reset").addEventListener("click", resetSort);
    bar.querySelector("#rsa-native").addEventListener("click", nativeSort);
    return bar;
  }

  function inject() {
    if (!isSearchPage() || document.getElementById(BAR_ID)) return;
    const container = slot();
    if (!container || !container.querySelector(RESULT_SEL)) return;
    const host = container.closest(".s-desktop-content, .sg-col-inner, .s-matching-dir") || container.parentNode;
    host.insertBefore(buildBar(), host.firstChild === container ? container : host.firstChild);
  }

  inject();
  // Amazon swaps result content in place on some filter clicks; re-inject when that happens.
  new MutationObserver(() => {
    if (!document.getElementById(BAR_ID)) {
      state.extra = []; state.pagesLoaded = 1; state.original = null;
      inject();
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Expose parsers for testing.
  window.__rsa = { parseCount, lastNumberToken, weightedScore, getReviewCount, getRating };
})();
