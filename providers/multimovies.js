// MultiMovies v2 — movie/series source for the Zangetsu provider repo.
//
// REWRITTEN for the new site (https://m1.multimovies.courses). The old
// DooPlay WordPress theme is gone, so everything WordPress is dropped:
// no <article class="item">, no /?s= search, no doo_player_ajax, no
// /movies|/tvshows/ slugs. What the new site actually serves:
//
//   Home   /                          poster rails (<article class="poster-card">,
//                                      <article class="cinema-slide"> hero,
//                                      <ol class="top-ranked-list"> Top Movies/Shows,
//                                      <a class="episode-preview"> latest episodes)
//   Detail /movie/<slug>  /series/<slug>
//                                      <h1 class="cinejoy-detail-title">,
//                                      <p class="cinejoy-detail-overview">,
//                                      JSON-LD Movie/TVSeries (genre, datePublished),
//                                      watchItem = {...} (titleId/poster/type),
//                                      watchConfig = {..., initialServers: [...]}
//   Search /search?q=<query>          (form action="/search", input name="q";
//                                      JSON-LD SearchAction urlTemplate confirms it)
//   Series episodes
//           /series/<slug>/season/<S>/episode/<E>  (cinejoy-ep-card blocks,
//           id ep-item-<S>-<E>, name + desc; one season per page, the rest
//           at ?season=N — "Available seasons" in the spec box)
//
// Video chain (new): detail/episode page -> watchConfig.initialServers
//   -> server iframe embed. GD mirror is still the iqsmartgames embed, so
//   its old chain is kept verbatim below: embed page -> mymovieapi /
//   myseriesapi -> embedhelper.php (base64 mresult) -> StreamWish-family
//   embed -> packed-JS unpack -> master.m3u8. Every other server is
//   resolved by fetching its embed page and pulling a .m3u8 (or
//   stream_proxy) URL out of it (direct URL, file:/sources:,
//   <source>/<video>, or one nested iframe deep). If no server yields
//   a stream URL, the iframe embed URLs themselves are returned as a
//   last resort so the app is never left empty-handed.
//
// QuickJS rules (Zangetsu): regex + fetch() + absUrl() + htmlText() only.
// No browser APIs at all. fetch() responses are read via r.body, JSON
// via JSON.parse(r.body). Only var and Promise (.then) syntax is used.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'multimovies';

// Domain rotates, fetched from the upstream list when the repo sets URLS.
var DEFAULT_MAIN = 'https://m1.multimovies.courses';
var URLS = '';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _urls = null;
function _loadUrls() {
  if (_urls) return Promise.resolve(_urls);
  if (!URLS) { _urls = {}; return Promise.resolve(_urls); }
  return fetch(URLS, { headers: { 'User-Agent': UA } }).then(function (r) {
    try { _urls = JSON.parse(r.body || '{}'); } catch (e) { _urls = {}; }
    return _urls;
  }).catch(function () { _urls = {}; return _urls; });
}
function _main() {
  return _loadUrls().then(function (j) {
    return String(j['multimovies'] || DEFAULT_MAIN).replace(/\/$/, '');
  });
}

function getInfo() {
  return {
    name: 'MultiMovies', lang: 'hi', baseUrl: DEFAULT_MAIN,
    logo: DEFAULT_MAIN + '/assets/img/logo.png',
    type: 'movie', version: '2.0.0'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _quality(s) { var m = String(s || '').match(/(\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (a[i] && !s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }
// Use the host absUrl — QuickJS has no URL constructor, so relative
// hrefs must be resolved through it, never built by hand.
function _abs(href, base) { return absUrl(href, base); }
function _baseOf(url) { return (String(url).match(/^(https?:\/\/[^/]+)/) || [])[1] || ''; }
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
// base64 -> JSON (mresult), decoded with the sandbox base64ToBytes helper.
function _b64json(s) {
  try {
    var b = base64ToBytes(String(s || ''));
    var str = '';
    for (var i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
    return JSON.parse(str);
  } catch (e) { return null; }
}
function _decodeEntities(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\s*(?:download|watch)\s+/i, '');
  t = t.replace(/\s*[-|–:]\s*MultiMovies.*$/i, '');
  t = t.replace(/\s*★.*$/, '');
  return _trim(t);
}
// Balanced {...} / [...] slice starting at the bracket at the given index.
// String-aware, so braces inside quoted values don't break the count.
function _balanced(s, at) {
  if (at < 0 || at >= s.length) return '';
  var open = s[at], close = open === '{' ? '}' : ']';
  var depth = 0, inStr = null, esc = false;
  for (var i = at; i < s.length; i++) {
    var c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(at, i + 1); }
  }
  return '';
}
// Parse a top-level assignment value such as watchItem = {...}
// or "key": {...} from the page script.
function _extractJson(html, key) {
  var idx = html.indexOf(key + ' =');
  if (idx < 0) idx = html.indexOf('"' + key + '":');
  if (idx < 0) return null;
  var b = html.indexOf('{', idx);
  var br = html.indexOf('[', idx);
  var at = (b >= 0 && (br < 0 || b < br)) ? b : br;
  if (at < 0) return null;
  try { return JSON.parse(_balanced(html, at)); } catch (e) { return null; }
}

// ── catalog cards ─────────────────────────────────────────────────────────────
// New card markup (all verified in the attached home/movie pages):
//   <article class="poster-card">
//     <a class="poster-art" href="/movie/night-silence">
//       <img src="https://image.tmdb.org/t/p/w500/….jpg" alt="Night Silence">
//     <div class="poster-caption"><a href="/movie/night-silence">Night Silence</a>
//       <button data-save-title="{&quot;titleId&quot;:177488,…,&quot;type&quot;:&quot;movie&quot;,…}">
//     <p class="poster-meta">2024 <span>·</span> Movie</p>
//   Hero: <article class="cinema-slide"><h1>BLACK TORCH</h1> …
//         <a href="/series/black-torch-172778"> (the /watch/movie/<id> CTA is skipped)
//   Top lists: <ol class="top-ranked-list"><li><a class="top-ranked-art" href="…">
//         <img …><div class="top-ranked-copy"><a href="…">Title</a><span>2026 ★ 10.0
function _cardFromBlock(inner, main) {
  var dec = _decodeEntities(inner);
  var hrefs = [], hm;
  var hre = /href=['"]([^'"]+)['"]/gi;
  while ((hm = hre.exec(dec)) !== null) hrefs.push(hm[1]);
  var href = null, i;
  for (i = 0; i < hrefs.length; i++) {
    if (/^\/(movie|series)\/[^/]+/i.test(hrefs[i]) &&
        hrefs[i].indexOf('/season/') < 0) { href = hrefs[i]; break; }
  }
  if (!href) {
    for (i = 0; i < hrefs.length; i++) {
      if (/^\/(movie|series)\/[^/]+/i.test(hrefs[i])) { href = hrefs[i]; break; }
    }
  }
  if (!href) return null;
  // An episode link stands for its series: /series/<slug>/season/1/episode/12
  href = href.replace(/(\/series\/[^/]+)\/season\/\d+\/episode\/\d+.*/i, '$1');
  var url = _abs(href, main);
  if (!/\/(movie|series)\//i.test(url)) return null;

  var type = /\/series\//i.test(url) ? 'series' : 'movie';
  var tm = dec.match(/"type"\s*:\s*"(movie|tv)"/i);
  if (tm) type = (tm[1].toLowerCase() === 'tv') ? 'series' : 'movie';
  else {
    var meta = (dec.match(/poster-meta[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    if (/series/i.test(meta)) type = 'series';
    else if (/movie/i.test(meta)) type = 'movie';
  }

  // Note: alt="..." can contain an apostrophe (WHAT'S MY NAME?), so match
  // the closing quote of the same kind instead of [^'"].
  var altM = dec.match(/<img[^>]+alt="([^"]*)"/i) ||
    dec.match(/<img[^>]+alt='([^']*)'/i);
  var title = _cleanTitle(
    (altM && altM[1]) ||
    (dec.match(/<div[^>]*poster-caption[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] ||
    (dec.match(/<div[^>]*top-ranked-copy[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] ||
    (dec.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
    (dec.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] ||
    (dec.match(/"title"\s*:\s*"([^"]+)"/i) || [])[1] || '');
  if (!title) return null;

  var img = null, im;
  var ire = /<img[^>]+src=['"]([^'"]+)['"]/gi;
  while ((im = ire.exec(dec)) !== null) {
    var src = im[1];
    if (src.indexOf('http') === 0 && src.indexOf('no-poster') < 0 &&
        src.indexOf('logo.png') < 0) { img = src; break; }
  }
  if (!img) {
    var rel = (dec.match(/<img[^>]+src=['"](\/[^'"]+)['"]/i) || [])[1];
    if (rel) img = _abs(rel, main);
  }
  return {
    id: url, title: title, cover: img || null,
    url: url, type: type, sourceId: SOURCE_ID
  };
}

function _cards(html, main) {
  var out = [], seen = {};
  function push(c) { if (c && !seen[c.url]) { seen[c.url] = 1; out.push(c); } }
  var m;
  // Poster rails + hero slides.
  var re = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  while ((m = re.exec(html)) !== null) push(_cardFromBlock(m[1], main));
  // Top Movies / Top Shows ranked lists.
  var liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while ((m = liRe.exec(html)) !== null) {
    if (m[1].indexOf('top-ranked') >= 0) push(_cardFromBlock(m[1], main));
  }
  // "You Might Also Like" rec cards + latest-episode previews (anchor-only).
  var aRe = /<a([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = aRe.exec(html)) !== null) {
    if (m[1].indexOf('cinejoy-rec-card') >= 0 ||
        m[1].indexOf('episode-preview') >= 0) {
      push(_cardFromBlock(m[0], main));
    }
  }
  if (out.length) return out;
  // Generic fallback (e.g. the search page, whose wrapper class is unknown):
  // every /movie/<slug> or /series/<slug> link with a titled image nearby.
  var gRe = /<a[^>]*href=['"](\/(?:movie|series)\/[^'"]+)['"][^>]*>([\s\S]{0,600}?)<\/a>/gi;
  while ((m = gRe.exec(html)) !== null) {
    if (m[1].indexOf('/season/') >= 0) continue;
    push(_cardFromBlock(m[0], main));
  }
  return out;
}

function getHome(opts) {
  return _main().then(function (main) {
    return _get(main + '/', main + '/').then(function (html) {
      var rows = [], m;
      // One row per <h2> shelf on the home page, in page order.
      var heads = [];
      var hRe = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
      while ((m = hRe.exec(html)) !== null) {
        heads.push({ title: _cleanTitle(m[1]), end: hRe.lastIndex });
      }
      for (var i = 0; i < heads.length; i++) {
        var seg = html.slice(heads[i].end,
          i + 1 < heads.length ? html.indexOf('<h2', heads[i].end) : html.length);
        if (heads[i].title === 'Latest episodes') continue; // episode links, not titles
        var items = _cards(seg, main);
        if (items.length >= 3) rows.push({ title: heads[i].title, items: items });
      }
      if (rows.length >= 2) return rows;
      // Fallback: the old per-section fetches, on the new paths.
      var fallback = [
        { title: 'Latest Movies', path: '/movies/' },
        { title: 'Latest TV Shows', path: '/series/' },
        { title: 'Bollywood', path: '/genre/bollywood-movies/' },
        { title: 'Anime (Hindi)', path: '/genre/anime-hindi/' },
        { title: 'Action', path: '/genre/action/' },
        { title: 'Animation', path: '/genre/animation/' }
      ];
      return Promise.all(fallback.map(function (row) {
        return _get(main + row.path, main + '/').then(function (h) {
          return { title: row.title, items: _cards(h, main) };
        }).catch(function () { return { title: row.title, items: [] }; });
      }));
    });
  }).catch(function () { return []; });
}

function search(query, page, opts) {
  return _main().then(function (main) {
    // Verified: form action="/search", input name="q"; JSON-LD SearchAction
    // urlTemplate is https://m1.multimovies.courses/search?q={search_term_string}.
    // Pagination param is NOT confirmed on the live site — '&page=' is a guess.
    var u = main + '/search?q=' + encodeURIComponent(query || '');
    if (page && page > 1) u += '&page=' + page;
    return _get(u, main + '/').then(function (html) { return _cards(html, main); });
  }).catch(function () { return []; });
}

// ── detail / episodes ─────────────────────────────────────────────────────────
// Series episodes — exact card markup, verified on the Dutton Ranch page:
//   <div class="cinejoy-season-grid active" id="cinejoy-season-1">
//     <div class="cinejoy-ep-card" id="ep-item-1-1">
//       <a href="/series/dutton-ranch-163067/season/1/episode/1"
//          class="cinejoy-ep-thumb-link" …>
//         <img class="cinejoy-ep-img" alt="The Untold Want" src="…/w500/….jpg">
//         <span class="cinejoy-ep-badge-num">E1</span>
//         <span class="cinejoy-ep-eye-btn" data-season="1" data-episode="1">
//       <div class="cinejoy-ep-body">
//         <a class="cinejoy-ep-name" title="The Untold Want">The Untold Want</a>
//         <p class="cinejoy-ep-desc">Beth and Rip fight to rebuild…</p>
//   The detail page shows ONE season at a time (grid id cinejoy-season-N,
//   pill "Season N"); other seasons live at ?season=N — see getDetail,
//   which fetches the missing seasons and merges them here.
function _sortEpisodes(out) {
  out.sort(function (a, b) {
    var as = a.id.match(/S(\d+)E(\d+)/), bs = b.id.match(/S(\d+)E(\d+)/);
    if (as && bs) { if (as[1] !== bs[1]) return as[1] - bs[1]; return as[2] - bs[2]; }
    return 0;
  });
  return out;
}
function _episodes(html, main, detailUrl) {
  var out = [], seen = {};
  function add(s, e, url, name) {
    var key = s + '-' + e;
    if (seen[key]) return;
    seen[key] = 1;
    out.push({ id: 'S' + s + 'E' + e, number: e,
      title: 'S' + s + ' E' + e + (name ? ' · ' + name : ''), url: url });
  }
  // 1. Exact episode cards: split on id="ep-item-<S>-<E>".
  var parts = html.split(/id=['"]ep-item-(\d+)-(\d+)['"]/);
  var i;
  for (i = 1; i + 2 < parts.length; i += 3) {
    var s = parseInt(parts[i], 10) || 1, e = parseInt(parts[i + 1], 10) || 0;
    var chunk = _decodeEntities(parts[i + 2]);
    var href = (chunk.match(/href=['"]([^'"]*\/season\/\d+\/episode\/\d+[^'"]*)['"]/) || [])[1];
    var name = _trim(htmlText(
      (chunk.match(/cinejoy-ep-name[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || ''));
    if (!name) {
      var altM = chunk.match(/<img[^>]+alt="([^"]*)"/i) ||
        chunk.match(/<img[^>]+alt='([^']*)'/i);
      name = _trim(htmlText((altM && altM[1]) || ''));
    }
    if (!name || /^episode\s*\d+$/i.test(name)) name = '';
    var url = href ? _abs(href, main)
      : detailUrl.replace(/\/$/, '').replace(/#.*$/, '') +
        '/season/' + s + '/episode/' + e;
    add(s, e, url, name);
  }
  if (out.length) return _sortEpisodes(out);
  // 2. Fallback: any /series/…/season/<S>/episode/<E> anchor on the page
  // (latest-episodes rail, next-episode nav, …). Name from the image alt.
  var re = /href=['"]([^'"]*\/series\/[^'"]*?\/season\/(\d+)\/episode\/(\d+)[^'"]*)['"]/gi;
  var m, matches = [];
  while ((m = re.exec(html)) !== null) {
    matches.push({ href: m[1], s: parseInt(m[2], 10), e: parseInt(m[3], 10), at: m.index });
  }
  for (i = 0; i < matches.length; i++) {
    var end = (i + 1 < matches.length) ? matches[i + 1].at : matches[i].at + 1800;
    if (end - matches[i].at > 1800) end = matches[i].at + 1800;
    var win = _decodeEntities(html.slice(matches[i].at, end));
    var altM2 = win.match(/<img[^>]+alt="([^"]*)"/i) ||
      win.match(/<img[^>]+alt='([^']*)'/i);
    var nm = _trim(htmlText((altM2 && altM2[1]) || ''));
    if (!nm || /^episode\s*\d+$/i.test(nm)) nm = '';
    add(matches[i].s, matches[i].e, _abs(matches[i].href, main), nm);
  }
  if (out.length) return _sortEpisodes(out);
  // 3. No episode markup at all: fall back to the script data.
  // seasonEpisodeNumbers holds THIS page's season only (watchConfig.season).
  var cfg = _extractJson(html, 'watchConfig') || {};
  var nums = _extractJson(html, 'seasonEpisodeNumbers') || [];
  var season = parseInt(cfg.season, 10) || 1;
  if (nums.length) {
    for (var j = 0; j < nums.length; j++) {
      var n = parseInt(nums[j], 10) || (j + 1);
      add(season, n, detailUrl.replace(/\/$/, '').replace(/#.*$/, '') +
        '/season/' + season + '/episode/' + n, '');
    }
    return _sortEpisodes(out);
  }
  if (cfg.episode) {
    var ep = parseInt(cfg.episode, 10) || 1;
    add(season, ep, detailUrl, '');
  }
  return out;
}

// How many seasons a series has: the spec box ("Available seasons"), else
// the highest season grid / episode season seen on the page.
function _totalSeasons(html, episodes) {
  var spec = (html.match(/Available seasons<\/span>\s*<span[^>]*>(\d+)</i) || [])[1];
  if (spec) return parseInt(spec, 10) || 1;
  var total = 0, gm;
  var gre = /id=['"]cinejoy-season-(\d+)['"]/gi;
  while ((gm = gre.exec(html)) !== null) {
    total = Math.max(total, parseInt(gm[1], 10) || 0);
  }
  for (var i = 0; i < episodes.length; i++) {
    var sm = episodes[i].id.match(/S(\d+)E\d+/);
    if (sm) total = Math.max(total, parseInt(sm[1], 10) || 0);
  }
  return total || 1;
}

function getDetail(url, opts) {
  return _main().then(function (main) {
    var u = _abs(url, main);
    return _get(u, main + '/').then(function (html) {
      var item = _extractJson(html, 'watchItem') || {};
      var cfg = _extractJson(html, 'watchConfig') || {};

      // JSON-LD (Movie / TVSeries): fullest genre + datePublished.
      var ld = null, lm;
      var ldRe = /<script[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi;
      while ((lm = ldRe.exec(html)) !== null) {
        try {
          var j = JSON.parse(lm[1]);
          if (j && (j['@type'] === 'Movie' || j['@type'] === 'TVSeries')) { ld = j; break; }
        } catch (e) {}
      }

      var isSeries = /\/series\//i.test(u) ||
        item.type === 'tv' || item.type === 'series' ||
        /og:type" content="video\.tv_show"/i.test(html) ||
        (ld && ld['@type'] === 'TVSeries') ||
        /\/season\/\d+\/episode\/\d+/i.test(html);

      var title = _cleanTitle(
        item.title ||
        (html.match(/<h1[^>]*cinejoy-detail-title[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
        (ld && ld.name) ||
        (html.match(/og:title" content="([^"]+)"/) || [])[1] ||
        (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || 'Untitled');

      var poster = item.poster ||
        (html.match(/og:image" content="([^"]+)"/) || [])[1] ||
        (ld && ld.image) || null;

      var description = _trim(htmlText(
        (html.match(/<p[^>]*cinejoy-detail-overview[^>]*>([\s\S]*?)<\/p>/i) || [])[1] ||
        (ld && ld.description) ||
        (html.match(/og:description" content="([^"]+)"/) || [])[1] ||
        (html.match(/<meta name="description" content="([^"]+)"/) || [])[1] || ''));

      // JSON-LD can be short (Dutton Ranch: only [Drama]) while the page
      // genres line lists the rest (Drama • Western), so merge both.
      var genres = [];
      if (ld && ld.genre) {
        var lg = (typeof ld.genre === 'string') ? [ld.genre] : ld.genre;
        for (var li = 0; li < lg.length; li++) {
          if (lg[li] && genres.indexOf(lg[li]) < 0) genres.push(lg[li]);
        }
      }
      var gblock = (html.match(/<div[^>]*cinejoy-detail-genres[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
      var parts = htmlText(gblock).split(/[•·,]/);
      for (var gi = 0; gi < parts.length; gi++) {
        var g = _trim(parts[gi]);
        if (g && genres.indexOf(g) < 0) genres.push(g);
      }

      var year = null;
      var datePub = (ld && ld.datePublished) ||
        (html.match(/Release Date<\/span>\s*<span[^>]*>([^<]+)/i) || [])[1] || '';
      var ym = String(datePub).match(/(19|20)\d{2}/);
      if (ym) year = ym[0];
      if (!year) {
        var pill = (html.match(/cinejoy-meta-pill[^>]*>(\d{4})</i) || [])[1];
        if (pill) year = pill;
      }
      if (!year) {
        var ty = title.match(/(19|20)\d{2}/);
        if (ty) year = ty[0];
      }

      var base = {
        id: u, title: title, cover: (poster && poster.indexOf('http') === 0) ? poster : null,
        url: u, description: description, status: 'unknown', genres: genres, studios: [],
        type: isSeries ? 'series' : 'movie', sourceId: SOURCE_ID, year: year,
        subCount: 0, dubCount: 0, episodes: []
      };

      if (isSeries) {
        var eps = _episodes(html, main, u);
        base.episodes = eps; base.subCount = eps.length;
      } else {
        base.episodes = [{ id: 'movie', number: 1, title: title, url: u }];
        base.subCount = 1;
      }

      // Tracker-sync ids. watchItem.titleId is the site's INTERNAL id — it is
      // NOT the TMDB id. The real ids live in the server embed URLs, e.g.
      //   Cineverse  …/embed/tmdb/movie?id=1234139        -> tmdb 1234139
      //   GD mirror  …/embed/movie/tt33318732?key=…       -> imdb tt33318732
      //   Nexus/Vidrift/Filmu/Vidbolt  …/movie/1234139    -> tmdb 1234139
      //   Series:    …/embed/tv/299167/1/1  /  …/tv/299167/s1/e1 -> tmdb 299167
      var servers = _initialServers(html);
      var tmdb = null, imdb = null, si;
      for (si = 0; si < servers.length; si++) {
        var su = servers[si].url || '';
        if (!imdb) imdb = (su.match(/(tt\d{6,})/) || [])[1] || null;
        if (!tmdb) {
          tmdb = (su.match(/\/embed\/tmdb\/(?:movie|tv)\?id=(\d+)/) ||
            su.match(/[?&]id=(\d+)/) ||
            su.match(/\/(?:movie|tv)\/(\d+)/) ||
            su.match(/\/embed\/(?:movie|tv)\/(\d+)/) || [])[1] || null;
        }
        if (tmdb && imdb) break;
      }
      base.tmdbId = tmdb ? parseInt(tmdb, 10) : null;
      base.imdbId = imdb || null;
      base.tmdbIsTv = !!isSeries;
      if (!isSeries) return base;
      // Multi-season: this page shows one season only. Fetch every season
      // the spec box promises that is not already on this page
      // (?season=N is how the site itself switches seasons).
      var total = _totalSeasons(html, base.episodes);
      var have = {}, ei;
      for (ei = 0; ei < base.episodes.length; ei++) {
        var hm = base.episodes[ei].id.match(/S(\d+)E\d+/);
        if (hm) have[parseInt(hm[1], 10)] = 1;
      }
      var missing = [];
      for (var sn = 1; sn <= total && sn <= 20; sn++) {
        if (!have[sn]) missing.push(sn);
      }
      if (!missing.length) return base;
      var clean = u.split('#')[0];
      var sep = clean.indexOf('?') >= 0 ? '&' : '?';
      return Promise.all(missing.map(function (n) {
        return _get(clean + sep + 'season=' + n, main + '/').then(function (sh) {
          return _episodes(sh, main, u);
        }).catch(function () { return []; });
      })).then(function (lists) {
        var seen = {}, merged = [];
        base.episodes.forEach(function (e) {
          if (!seen[e.id]) { seen[e.id] = 1; merged.push(e); }
        });
        lists.forEach(function (list) {
          (list || []).forEach(function (e) {
            if (!seen[e.id]) { seen[e.id] = 1; merged.push(e); }
          });
        });
        base.episodes = _sortEpisodes(merged);
        base.subCount = base.episodes.length;
        return base;
      });
    });
  });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// ── video resolution (initialServers -> embeds -> .m3u8) ─────────────────────
// Servers come from the page itself — no ajax, no player-option POSTs.
//   watchConfig = { …, "initialServers": [
//     {"id":"autoembed_1","name":"Cineverse","type":"iframe",
//      "url":"https://rozgarlelo.modiplay.xyz/embed/tmdb/movie?id=1234139",
//      "quality":"HD","is_custom":false},
//     {"id":"autoembed_2","name":"GD mirror","type":"iframe",
//      "url":"https://streams.iqsmartgames.com/embed/movie/tt33318732?key=…", …} ]}
// Fallback: the visible server chips
//   <button class="server-chip" data-id="autoembed_2"
//     data-url="https://streams.iqsmartgames.com/embed/movie/tt33318732?key=…">
//     <span class="server-name">GD mirror</span><span class="server-badge">HD</span>
function _normServers(list) {
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var s = list[i] || {};
    if (!s.url) continue;
    out.push({ id: String(s.id || ('server_' + (i + 1))),
      name: String(s.name || ('Server ' + (i + 1))),
      type: String(s.type || 'iframe'), url: String(s.url),
      quality: String(s.quality || 'HD') });
  }
  return out;
}
function _initialServers(html) {
  var cfg = _extractJson(html, 'watchConfig');
  if (cfg && cfg.initialServers && cfg.initialServers.length) {
    return _normServers(cfg.initialServers);
  }
  var idx = html.indexOf('"initialServers"');
  if (idx >= 0) {
    var at = html.indexOf('[', idx);
    try {
      var arr = JSON.parse(_balanced(html, at));
      if (arr && arr.length) return _normServers(arr);
    } catch (e) {}
  }
  var out = [], m;
  var re = /<button([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((m = re.exec(html)) !== null) {
    if (m[1].indexOf('server-chip') < 0) continue;
    var url = (m[1].match(/data-url=['"]([^'"]+)['"]/i) || [])[1];
    if (!url) continue;
    var name = _trim(htmlText(
      (m[2].match(/server-name[^>]*>([^<]+)/i) || [])[1] || ''));
    var quality = _trim(htmlText(
      (m[2].match(/server-badge[^>]*>([^<]+)/i) || [])[1] || 'HD'));
    out.push({ id: (m[1].match(/data-id=['"]([^'"]+)['"]/i) || [])[1] || ('server_' + (out.length + 1)),
      name: name || ('Server ' + (out.length + 1)), type: 'iframe',
      url: url, quality: quality || 'HD' });
  }
  return out;
}

function _src(url, quality, label, referer) {
  return {
    url: url, quality: quality || 'auto',
    container: (/\.m3u8(\?|$)/i.test(url) || url.indexOf('stream_proxy') !== -1)
      ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA, 'Referer': referer || '' },
    kind: 'sub', audioLang: '', subtitles: [], label: _trim(label || '')
  };
}

// A single-quoted JS string reader honoring \' and \\ escapes. Returns the
// decoded string plus the index just past the closing quote.
function _readStr(s, i) {
  var out = ''; i++;
  while (i < s.length) {
    var c = s[i];
    if (c === '\\') { out += s[i + 1]; i += 2; continue; }
    if (c === "'") return { str: out, next: i + 1 };
    out += c; i++;
  }
  return { str: out, next: i };
}

// Robust Dean-Edwards p,a,c,k,e,d unpacker. The host's built-in unpackJs is
// rigid (it slices on a literal .split('|'),0,{})) tail and hardcodes base
// 62), which silently mis-decodes StreamHG/EarnVids — so we unpack here.
function _unpack(s) {
  s = String(s);
  var h = s.indexOf("}('");
  if (h < 0 || s.indexOf(".split('|')") < 0) return s;
  var p = _readStr(s, h + 2);             // payload (template)
  var rest = s.slice(p.next);             // ,BASE,COUNT,'DICT'.split('|')…
  var m = rest.match(/^,(\d+),(\d+),/);
  if (!m) return s;
  var base = parseInt(m[1], 10), count = parseInt(m[2], 10);
  var d = _readStr(s, p.next + m[0].length); // dictionary
  var dict = d.str.split('|');
  function enc(n) {
    return (n < base ? '' : enc(Math.floor(n / base))) +
      ((n = n % base) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  }
  var out = p.str;
  while (count--) {
    if (dict[count]) out = out.replace(new RegExp('\\b' + enc(count) + '\\b', 'g'), dict[count]);
  }
  return out;
}

function _m3u8FromHtml(hay) {
  return (hay.match(/https?:\/\/[^"'\\ ]+\.m3u8[^"'\\ ]*/) || [])[0] ||
    (hay.match(/https?:\/\/[^"'\\ ]*stream_proxy[^"'\\ ]*/) || [])[0] ||
    (hay.match(/["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)/i) || [])[1] ||
    (hay.match(/["']hls\d?["']\s*:\s*["']([^"']+\.m3u8[^"']*)/i) || [])[1] ||
    (hay.match(/<source[^>]+src=['"]([^'"]+\.m3u8[^'"]*)['"]/i) || [])[1] ||
    (hay.match(/<video[^>]+src=['"]([^'"]+\.m3u8[^'"]*)['"]/i) || [])[1] ||
    (function () {
      var sm = hay.match(/sources\s*:\s*\[([\s\S]*?)\]/i);
      if (!sm) return null;
      return (sm[1].match(/["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)/i) || [])[1] ||
        (sm[1].match(/https?:\/\/[^"'\\ ]+\.m3u8[^"'\\ ]*/) || [])[0] || null;
    })() || '';
}

// Generic embed page (Cineverse / Nexus / Vidrift / VIDOUT / Filmu / Vidbolt):
// fetch it, unpack any packed JS, pull a .m3u8 out; if there is none, follow
// one nested <iframe> and try again. Returns [] when nothing plays.
function _resolveEmbed(embed, name, quality, pageRef) {
  var ref = _baseOf(embed) + '/';
  return _get(embed, pageRef || ref).then(function (html) {
    var unp = ''; try { unp = _unpack(html); } catch (e) {}
    var m3 = _m3u8FromHtml(html + ' ' + unp);
    if (m3) return [_src(m3, quality, 'MultiMovies [' + (name || 'Server') + ']', ref)];
    var nested = (html.match(/<iframe[^>]+src=['"](https?:\/\/[^'"]+)['"]/i) || [])[1] || '';
    if (!nested || nested === embed || _baseOf(nested) === _baseOf(embed)) return [];
    return _get(nested, ref).then(function (h2) {
      var u2 = ''; try { u2 = _unpack(h2); } catch (e) {}
      var m32 = _m3u8FromHtml(h2 + ' ' + u2);
      if (!m32) return [];
      return [_src(m32, quality, 'MultiMovies [' + (name || 'Server') + ']', _baseOf(nested) + '/')];
    }).catch(function () { return []; });
  }).catch(function () { return []; });
}

// embed page (iqsmartgames) inline var, e.g.  api_url  = "https://...".
function _embedVar(html, name) {
  var m = html.match(new RegExp(name + '\\s*=\\s*[\'"]([^\'"]*)[\'"]'));
  return m ? m[1] : '';
}

function _embedHelper(playerBase, slug) {
  return fetch(playerBase + '/embedhelper.php', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Referer': playerBase + '/', 'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'sid=' + encodeURIComponent(slug)
  }).then(function (r) {
    var j = null; try { j = JSON.parse(r.body || 'null'); } catch (e) {}
    return j;
  }).catch(function () { return null; });
}

// GD mirror (iqsmartgames) chain — unchanged from v1, it still works:
// embed page -> /mymovieapi or /myseriesapi -> embedhelper.php
// (mresult = {server: fileId} + siteUrls host map) -> StreamWish-family
// embed -> packed-JS unpack -> master.m3u8.
function _iqChain(embedUrl, main) {
  return _get(embedUrl, main + '/').then(function (html) {
    var apiUrl = _embedVar(html, 'api_url') || _baseOf(embedUrl);
    var playerBase = _embedVar(html, 'player_base') ||
      _baseOf(embedUrl).replace('://streams.', '://pro.');
    var myKey = _embedVar(html, 'myKey');
    var finalId = _embedVar(html, 'FinalID');
    var idType = _embedVar(html, 'idType') || 'imdbid';
    var season = _embedVar(html, 'season');
    var isTv = /\/embed\/tv\//i.test(embedUrl);
    var epname = '';

    var pm = embedUrl.match(/\/embed\/(?:movie|tv)\/([^\/?]+)(?:\/(\d+)\/(\d+))?/);
    if (!finalId && pm) finalId = pm[1];
    if (isTv && pm) { season = season || pm[2] || '1'; epname = pm[3] || '1'; }
    if (!finalId || !myKey) return [];

    var apiPath = isTv
      ? '/myseriesapi?' + idType + '=' + encodeURIComponent(finalId) +
        '&season=' + encodeURIComponent(season || '1') +
        '&epname=' + encodeURIComponent(epname || '1') + '&key=' + encodeURIComponent(myKey)
      : '/mymovieapi?' + idType + '=' + encodeURIComponent(finalId) +
        '&key=' + encodeURIComponent(myKey);

    return _get(apiUrl + apiPath, apiUrl + '/').then(function (body) {
      var j = null; try { j = JSON.parse(body || 'null'); } catch (e) {}
      var data = (j && j.data) || [];
      if (!data.length) return [];
      var jobs = data.slice(0, 3).map(function (d) {
        var quality = _quality(d && d.filename) || 'auto';
        return _embedHelper(playerBase, d && d.fileslug).then(function (eh) {
          if (!eh || !eh.mresult) return [];
          var mr = _b64json(eh.mresult) || {};
          var su = eh.siteUrls || {}, names = eh.siteFriendlyNames || {};
          var embeds = [];
          Object.keys(mr).forEach(function (k) {
            if (su[k] && mr[k]) embeds.push({ url: su[k] + mr[k], name: names[k] || k });
          });
          return Promise.all(embeds.slice(0, 8).map(function (e) {
            return _resolveEmbed(e.url, e.name, quality);
          })).then(function (lists) {
            return lists.reduce(function (a, b) { return a.concat(b || []); }, []);
          });
        }).catch(function () { return []; });
      });
      return Promise.all(jobs).then(function (lists) {
        return lists.reduce(function (a, b) { return a.concat(b || []); }, []);
      });
    });
  }).catch(function () { return []; });
}

function getVideoSources(pageUrl) {
  return _main().then(function (main) {
    var u = _abs(pageUrl, main);
    return _get(u, main + '/').then(function (html) {
      var servers = _initialServers(html);
      if (!servers.length) {
        // Last-resort scan: any /embed/ URL in the page markup.
        var em = html.match(/https?:\/\/[^"'<> ]+\/embed\/[^"'<> ]+/gi) || [];
        servers = _uniq(em).slice(0, 7).map(function (e, i) {
          return { id: 'server_' + (i + 1), name: 'Server ' + (i + 1),
            type: 'iframe', url: e, quality: 'HD' };
        });
      }
      if (!servers.length) throw new Error('MultiMovies: no players');
      // GD mirror first — its chain is the proven one — then the rest in order.
      servers.sort(function (a, b) {
        var ai = a.url.indexOf('iqsmartgames') !== -1 ? 0 : 1;
        var bi = b.url.indexOf('iqsmartgames') !== -1 ? 0 : 1;
        return ai - bi;
      });
      var jobs = servers.slice(0, 7).map(function (s) {
        if (/\.m3u8(\?|#|$)/i.test(s.url) || s.url.indexOf('stream_proxy') !== -1) {
          return Promise.resolve([_src(s.url, s.quality,
            'MultiMovies [' + s.name + ']', u)]);
        }
        if (s.url.indexOf('iqsmartgames') !== -1) return _iqChain(s.url, main);
        return _resolveEmbed(s.url, s.name, s.quality, u);
      });
      return Promise.all(jobs).then(function (lists) {
        var out = [], seen = {};
        lists.forEach(function (list) {
          (list || []).forEach(function (s) {
            if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
          });
        });
        if (out.length) return out;
        // No .m3u8 anywhere (embed loads its stream via JS/API): hand the
        // iframe embeds back instead of failing outright.
        return servers.map(function (s) {
          return _src(s.url, s.quality,
            'MultiMovies [' + s.name + '] (iframe)', u);
        });
      });
    });
  }).then(function (sources) {
    var out = [], seen = {};
    (sources || []).forEach(function (s) {
      if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
    });
    if (!out.length) throw new Error('MultiMovies: no playable sources');
    return out;
  });
}
