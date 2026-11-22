# Review Sort for Amazon

Chrome extension (Manifest V3, no permissions) that adds a sort bar above Amazon search results.

## How the original works
"Amazon Sort by Review Count" (olefkhnepnhckieapdkjebebogajcmel) does two things:
1. Appends `sort=review-count-rank` to the URL. This is a hidden Amazon sort that only works when a department (`i=` / `rh=`) is set.
2. Reorders the cards on the current page by the review count scraped from each card.

## What this version adds
- Sort by **most reviews**, **highest stars**, or a **weighted score** (Bayesian average, so 5.0★ from 3 reviews doesn't beat 4.7★ from 20k).
- Merges up to **10 result pages** before sorting (fetched one at a time, 600 ms apart; stops if Amazon shows a captcha).
- Hide ads (sponsored results) and a minimum star filter. Each card shows only its rank in the current sort (and the weighted score for Best rated), nothing Amazon already shows.
- **Delivery date**: sort by soonest arrival, or keep only items arriving today, by tomorrow, or within 2/3/7/14 days. Uses the soonest option on the card (free or paid "fastest delivery"), and the last day of a range.
- The Sort menu has two groups, so it's clear what gets ranked:
  - **All results, Amazon's ranking**: *Featured* and *Most reviews (all results)*. The second one is Amazon's hidden review sort across every page. It reloads the page and uses the sidebar department, or shows a department picker (Amazon ignores this sort without one).
  - **First N pages, re-sorted**: our sorts, which re-rank only the pages loaded (N follows the Pages setting).
- A plain-language "how it works" card opens from the ⓘ next to the Review Sort name (click to open; click outside or press Escape to close).
- **Saved defaults**: set the bar the way you like and click *Save as default*; it then applies to every search on that Amazon site. In the ⋯ menu, *Forget defaults* removes them, and *Clear sorting* shows Amazon's own page once without them. Stored in that Amazon site's localStorage, so each country site keeps its own.
- Locale-aware number parsing (`12,345`, `12.345`, `12 345`, `12.3K`).

## Install
1. Open `chrome://extensions`, turn on Developer mode.
2. Click **Load unpacked** and pick this folder.
3. Search on Amazon; the bar appears above the results.

### Ardia / Violentmonkey
Run `./build-userscript.sh`, then `ardia scripts install review-sort.user.js` (or load the `.user.js` in Violentmonkey).
