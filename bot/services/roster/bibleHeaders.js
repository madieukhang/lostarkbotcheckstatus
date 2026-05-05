// Bible request headers, extracted to a config-free module so loa-worker
// (which only needs MONGODB_URI) can import them without dragging in
// bot/config.js and its DISCORD_TOKEN/CHANNEL_ID validation. THIN-headers
// shape verified 10/10 PASS from a residential IP on 2026-05-04 - adding
// sec-ch-ua-* etc. actually triggered MORE CF suspicion (4/10 429s).
//
// Referer is set to the bible homepage. A request to `/character/NA/X/__data.json`
// without any Referer at all stands out from real browser traffic (browsers
// always set Referer when navigating from another page). Using the homepage
// is a generic "just landed" approximation; the alternative (the specific
// character page) is hard to set correctly per-request and offers little
// extra cover. Real Phase 3 production scan saw 0 HTTP 403 with this combo.
export const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://lostark.bible/',
};
