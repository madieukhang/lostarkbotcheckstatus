// Bible request headers, extracted to a config-free module so loa-worker
// (which only needs MONGODB_URI) can import them without dragging in
// bot/config.js and its DISCORD_TOKEN/CHANNEL_ID validation. THIN-headers
// shape verified 10/10 PASS from a residential IP on 2026-05-04 - adding
// sec-ch-ua-* etc. actually triggered MORE CF suspicion (4/10 429s).
export const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};
