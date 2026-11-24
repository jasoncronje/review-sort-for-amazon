# Chrome Web Store listing

Upload `dist/review-sort-<version>.zip` (made by `./build-store.sh`). The store build leaves out
brands.js, so the experimental no-name brand filter and its Settings section don't appear.

## Store listing tab

**Name** (from manifest): Review Sort for Amazon

**Summary** (from manifest, 132 chars max):
Sort Amazon search results by most reviews, best rated or soonest delivery, and filter by arrival date, stars and ads.

**Category:** Shopping

**Language:** English

**Description:**

Find what people actually buy and like on Amazon.

Amazon puts popular and sponsored items first. Review Sort adds a small bar above Amazon search results so you can reorder them by what matters to you.

AMAZON SORT
• Most reviews (all results): uses Amazon's own review-count ranking across every page of results.

CUSTOM SORT
Sorts Amazon doesn't offer, applied to the first pages of results (you choose 1 to 10 pages):
• Most reviews
• Best rated: weighs stars against how many people left them, so 5 stars from 3 reviews won't beat 4.7 stars from 20,000
• Highest stars
• Soonest delivery

FILTERS
• Arrives: today, by tomorrow, or within 2, 3, 7 or 14 days
• Stars: 4 & up or 4.5 & up
• Hide ads (sponsored results)

Each result shows its place in your sort. Click "Save as default" to use your setup on every search, and change it any time under ⋯ → Settings.

Works on Amazon sites in 23 countries, including amazon.com, .co.uk, .de, .ca, .co.jp and .com.au.

PRIVACY
Review Sort asks for no browser permissions, collects no data and has no servers. It reads the Amazon results page you're on and the next result pages you choose, inside your browser. Your settings stay in your browser.

Not affiliated with or endorsed by Amazon.

**Graphic assets:**
- Store icon: `icons/icon128.png` (source: `store-assets/icon.svg`)
- Screenshots (1280×800): `store-assets/screenshots/` (all 4, in order)
- Small promo tile (440×280): `store-assets/promo-440x280.png`

## Privacy practices tab

**Single purpose:**
Reorders and filters Amazon search results by review count, rating and delivery date.

**Permission justification:**
- Host permissions (content script on Amazon sites): the extension adds its sort bar to Amazon search result pages and reads the results shown there. To sort across several pages it requests the next result pages from the same Amazon site, one at a time.
- No other permissions are requested.

**Remote code:** No, I am not using remote code. All JavaScript is in the package.

**Data usage:** tick none of the data types. Certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** not required when no data is collected. If the form insists, use a page that says:
"Review Sort for Amazon collects no personal data. It has no servers and sends nothing anywhere. Its settings are saved in your browser's local storage on the Amazon site."

## Distribution tab
- Visibility: Public (or Unlisted to test first)
- Regions: all
- Pricing: free
