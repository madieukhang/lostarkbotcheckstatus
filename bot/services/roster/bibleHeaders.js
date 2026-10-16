// Bible request headers, kept in a config-free module so loa-worker (which
// only needs MONGODB_URI) can import them without bot/config.js and its
// DISCORD_TOKEN/CHANNEL_ID validation. The set is intentionally small: extra
// browser-client hints raise the number of upstream rate-limit challenges
// without improving compatibility.
//
// Referer is the bible homepage. A request with no Referer stands out from
// browser navigation traffic, and the homepage is a generic value that needs
// no per-request character URL.
export const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://lostark.bible/',
};
