# Review Sort for Amazon

Chrome extension (Manifest V3, no permissions) that adds a sort bar above Amazon search results.

## How the original works
"Amazon Sort by Review Count" (olefkhnepnhckieapdkjebebogajcmel) does two things:
1. Appends `sort=review-count-rank` to the URL. This is a hidden Amazon sort that only works when a department (`i=` / `rh=`) is set.
2. Reorders the cards on the current page by the review count scraped from each card.

## What this version adds
- Sort by **most reviews**, **highest stars**, or a **weighted score** (Bayesian average, so 5.0★ from 3 reviews doesn't beat 4.7★ from 20k).
- Merges up to **10 result pages** before sorting (fetched one at a time, 600 ms apart; stops if Amazon shows a captcha).
- Hide sponsored results, minimum star filter, review/rating badge on each card.
- Amazon's native sort button that borrows the top sidebar department when none is picked.
- Locale-aware number parsing (`12,345`, `12.345`, `12 345`, `12.3K`).

## Install
1. Open `chrome://extensions`, turn on Developer mode.
2. Click **Load unpacked** and pick this folder.
3. Search on Amazon; the bar appears above the results.
