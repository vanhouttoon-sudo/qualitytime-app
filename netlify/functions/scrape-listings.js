// netlify/functions/scrape-listings.js
//
// Haalt vastgoedpanden op bij een lijst bronnen (RE_BRON_CONFIG hieronder) en geeft
// een genormaliseerde JSON-lijst terug aan de front-end (incl. eerste foto per pand).
//
// BELANGRIJKE BEPERKINGEN — lees dit voor je support-tickets opent:
//
// 1. Grote portalen (Immoweb, Zimmo, Immovlan, Logic-Immo, ...) renderen hun
//    zoekresultaten met JavaScript (React/Next.js) en zitten vaak achter
//    Cloudflare/Akamai bot-bescherming. Een gewone server-side fetch() zoals hier
//    krijgt dan enkel de "lege" HTML-schil binnen, of een blokkade-pagina.
//    Deze functie probeert 3 dingen per pagina, in volgorde:
//      a) JSON-LD structured data (<script type="application/ld+json">)
//      b) Ingebedde Next.js/React state (__NEXT_DATA__ of vergelijkbare <script> JSON)
//      c) Een generieke "gok"-strategie op basis van links + prijs-patronen + afbeeldingen
//    Voor JS-zware portalen kan dit alsnog 0 resultaten opleveren. Dat is een
//    serverbeperking (geen headless browser hier), geen bug.
// 2. Kleinere, server-gerenderde makelaarssites (bv. Heylenvastgoed, Onevastgoed,
//    Provas, Walls, Hansimmo, Area, ...) werken doorgaans beter met deze aanpak.
// 3. Respecteer robots.txt en gebruiksvoorwaarden van elke bron. Sommige portalen
//    verbieden scraping expliciet — gebruik dit op eigen verantwoordelijkheid en
//    overweeg deze bronnen te verwijderen uit RE_BRON_CONFIG als je twijfelt.
// 4. Voor het beste resultaat: vervang `zoekUrl` per bron hieronder door een eigen
//    opgeslagen zoekopdracht (regio + prijs + kamers) op die site, in plaats van
//    de kale homepage.

const cheerio = require('cheerio');

// ── CONFIGUREER HIER JE BRONNEN ──────────────────────────────────────────────
// zoekUrl: de pagina die gescraped wordt (idealiter een opgeslagen zoekopdracht)
// selectors: optioneel — CSS-selectors specifiek voor die site. Als je die kent
//            (via "Element inspecteren" in je browser) werkt de scraper veel
//            betrouwbaarder dan met de generieke gok-strategie.
const RE_BRON_CONFIG = [
  {
    naam: 'Heylenvastgoed',
    zoekUrl: 'https://www.heylenvastgoed.be/nl/te-koop',
    selectors: null // nog niet uitgemeten — valt terug op generieke strategie
  },
  {
    naam: 'Onevastgoed',
    zoekUrl: 'https://www.onevastgoed.be/te-koop',
    selectors: null
  },
  {
    naam: 'Provas',
    zoekUrl: 'https://provas.be/te-koop',
    selectors: null
  },
  {
    naam: 'Walls',
    zoekUrl: 'https://www.walls.be/te-koop',
    selectors: null
  },
  {
    naam: 'Immoweb',
    zoekUrl: 'https://www.immoweb.be/nl/zoeken/huis-en-appartement/te-koop?countries=BE&postalCodes=BE-2140,BE-2018,BE-2600,BE-2650,BE-2540,BE-2530',
    selectors: null // grote kans op 0 resultaten (JS-rendering + bot-bescherming)
  },
  {
    naam: 'Zimmo',
    zoekUrl: 'https://www.zimmo.be/nl/antwerpen/te-koop/',
    selectors: null
  },
  {
    naam: 'Immovlan',
    zoekUrl: 'https://www.immovlan.be/nl/vastgoed?transactiontypes=for-sale&towns=antwerpen',
    selectors: null
  }
];

const REGIO_HINTS = [
  'Borgerhout','Mortsel','Edegem','Hove','Boechout','Berchem','Deurne','Wilrijk',
  'Kontich','Antwerpen','2018 Antwerpen'
];

const FETCH_TIMEOUT_MS = 9000;
const MAX_PER_BRON = 20;

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8'
      }
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function guessRegio(tekst) {
  if (!tekst) return 'Onbekend';
  const found = REGIO_HINTS.find(r => tekst.toLowerCase().includes(r.toLowerCase()));
  return found || 'Onbekend';
}

function parsePrice(tekst) {
  if (!tekst) return 0;
  const m = String(tekst).replace(/\s/g, '').match(/€?\s?([\d.,]{4,})/);
  if (!m) return 0;
  const num = m[1].replace(/\./g, '').replace(',', '.');
  return Math.round(parseFloat(num)) || 0;
}

function absoluteUrl(base, maybeRelative) {
  try { return new URL(maybeRelative, base).href; } catch (e) { return maybeRelative; }
}

// ── Strategie A: JSON-LD structured data ─────────────────────────────────────
function extractFromJsonLd($, baseUrl, bronNaam) {
  const out = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch (e) { return; }
    const items = Array.isArray(data) ? data : [data];
    items.forEach(item => {
      const type = item['@type'];
      const isListing = type === 'RealEstateListing' || type === 'Product' || type === 'Residence' || type === 'House' || type === 'Apartment';
      if (!isListing && !item.offers) return;
      const adres = item.name || (item.address && (item.address.streetAddress || item.address)) || '';
      const prijs = item.offers ? parsePrice(item.offers.price || item.offers.lowPrice) : parsePrice(item.price);
      const foto = Array.isArray(item.image) ? item.image[0] : item.image;
      const url = item.url || baseUrl;
      if (!adres && !prijs) return;
      out.push({
        adres: String(adres).slice(0, 80),
        prijs,
        regio: guessRegio(JSON.stringify(item)),
        kamers: Number(item.numberOfRooms) || 0,
        opp: Number(item.floorSize && item.floorSize.value) || 0,
        tuin: /tuin|garden/i.test(JSON.stringify(item)),
        foto: foto ? absoluteUrl(baseUrl, foto) : null,
        url: absoluteUrl(baseUrl, url),
        bron: bronNaam,
        datum: new Date().toISOString().slice(0, 10)
      });
    });
  });
  return out;
}

// ── Strategie B: ingebedde Next.js/React state ───────────────────────────────
function extractFromEmbeddedState($, baseUrl, bronNaam) {
  const out = [];
  const scriptIds = ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__'];
  scriptIds.forEach(id => {
    const raw = $('#' + id).contents().text() || $('script#' + id).text();
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    // Generieke diepe zoektocht naar objecten die op een pand lijken
    const seen = new Set();
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
      seen.add(node);
      const keys = Object.keys(node);
      const looksLikeListing = keys.some(k => /price|prijs/i.test(k)) &&
                                keys.some(k => /address|adres|street|location/i.test(k));
      if (looksLikeListing) {
        const priceKey = keys.find(k => /price|prijs/i.test(k));
        const addrKey = keys.find(k => /address|adres|street/i.test(k));
        const imgKey = keys.find(k => /image|photo|picture|media/i.test(k));
        const urlKey = keys.find(k => /url|link|slug/i.test(k));
        const adres = typeof node[addrKey] === 'string' ? node[addrKey] : JSON.stringify(node[addrKey]).slice(0, 80);
        const prijs = parsePrice(node[priceKey]);
        let foto = node[imgKey];
        if (Array.isArray(foto)) foto = foto[0];
        if (foto && typeof foto === 'object') foto = foto.url || foto.src || null;
        if (adres && prijs) {
          out.push({
            adres: adres.slice(0, 80),
            prijs,
            regio: guessRegio(adres),
            kamers: 0, opp: 0, tuin: false,
            foto: foto ? absoluteUrl(baseUrl, foto) : null,
            url: node[urlKey] ? absoluteUrl(baseUrl, node[urlKey]) : baseUrl,
            bron: bronNaam,
            datum: new Date().toISOString().slice(0, 10)
          });
        }
      }
      Object.values(node).forEach(v => { if (v && typeof v === 'object') walk(v, depth + 1); });
    })(data, 0);
  });
  return out.slice(0, MAX_PER_BRON);
}

// ── Strategie C: generieke gok op basis van links/prijzen/afbeeldingen ───────
function extractGeneric($, baseUrl, bronNaam) {
  const out = [];
  const priceRe = /€\s?[\d.,]{4,}/;
  $('a[href]').each((i, el) => {
    if (out.length >= MAX_PER_BRON) return;
    const $a = $(el);
    const blockText = $a.text();
    const parentText = $a.parent().text();
    const scope = priceRe.test(blockText) ? blockText : (priceRe.test(parentText) ? parentText : null);
    if (!scope) return;
    const priceMatch = scope.match(priceRe);
    const prijs = parsePrice(priceMatch[0]);
    if (prijs < 50000 || prijs > 3000000) return; // sanity check, filtert ruis
    let img = $a.find('img').attr('src') || $a.find('img').attr('data-src') || $a.parent().find('img').attr('src');
    const href = $a.attr('href');
    if (!href || href === '#') return;
    const adres = ($a.attr('title') || $a.text() || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Adres onbekend';
    out.push({
      adres,
      prijs,
      regio: guessRegio(adres + ' ' + parentText),
      kamers: 0, opp: 0, tuin: /tuin/i.test(parentText),
      foto: img ? absoluteUrl(baseUrl, img) : null,
      url: absoluteUrl(baseUrl, href),
      bron: bronNaam,
      datum: new Date().toISOString().slice(0, 10)
    });
  });
  return out;
}

async function scrapeBron(bron) {
  try {
    const res = await fetchWithTimeout(bron.zoekUrl);
    if (!res.ok) return { naam: bron.naam, ok: false, reden: 'HTTP ' + res.status, listings: [] };
    const html = await res.text();
    const $ = cheerio.load(html);

    let listings = extractFromJsonLd($, bron.zoekUrl, bron.naam);
    if (!listings.length) listings = extractFromEmbeddedState($, bron.zoekUrl, bron.naam);
    if (!listings.length) listings = extractGeneric($, bron.zoekUrl, bron.naam);

    // dedupliceer binnen dezelfde bron op adres
    const uniek = [];
    const gezien = new Set();
    listings.forEach(l => {
      const key = (l.adres || '').toLowerCase().replace(/\s/g, '');
      if (key && !gezien.has(key)) { gezien.add(key); uniek.push(l); }
    });

    return { naam: bron.naam, ok: uniek.length > 0, reden: uniek.length ? null : 'Geen panden herkend (mogelijk JS-rendering/bot-bescherming)', listings: uniek.slice(0, MAX_PER_BRON) };
  } catch (err) {
    return { naam: bron.naam, ok: false, reden: err.name === 'AbortError' ? 'Timeout' : err.message, listings: [] };
  }
}

exports.handler = async function (event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const resultaten = await Promise.all(RE_BRON_CONFIG.map(scrapeBron));

    const listings = resultaten.flatMap(r => r.listings);
    const bronStatus = resultaten.map(r => ({ naam: r.naam, ok: r.ok, reden: r.reden, aantal: r.listings.length }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        listings,
        bronStatus,
        aangemaakt: new Date().toISOString()
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, listings: [], bronStatus: [] })
    };
  }
};
