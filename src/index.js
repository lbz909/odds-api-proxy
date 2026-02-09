export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (path === "/sports") return await handleSports(env);
      if (path === "/events") return await handleEvents(url, env);
      if (path === "/snapshot") return await handleSnapshot(url, env);

      return json({ error: "Not found", path }, 404);
    } catch (err) {
      return json({ error: "Worker error", message: String(err) }, 500);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// --- The Odds API calls ---
// IMPORTANT: The Odds API key MUST be query param apiKey, not header.
async function oddsFetch(env, endpoint, params = {}) {
  const base = "https://api.the-odds-api.com/v4";
  const u = new URL(base + endpoint);

  // attach params
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }

  // attach apiKey (required)
  u.searchParams.set("apiKey", env.ODDS_API_KEY);

  const res = await fetch(u.toString());
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  // Helpful metadata: remaining requests etc if provided
  const meta = {
    status: res.status,
    remaining: res.headers.get("x-requests-remaining"),
    used: res.headers.get("x-requests-used"),
  };

  if (!res.ok) return { error: true, meta, data };
  return { error: false, meta, data };
}

// Defaults
const DEFAULT_SPORT = "mma_mixed_martial_arts";

async function handleSports(env) {
  // Fetch full list of sports from The Odds API
  const r = await oddsFetch(env, `/sports`, {});
  if (r.error) return json(r, 502);

  // Keep response light + GPT-friendly
  const sports = Array.isArray(r.data)
    ? r.data.map((s) => ({
        key: s.key,
        title: s.title,
        group: s.group,
        active: s.active,
      }))
    : r.data;

  return json({
    ok: true,
    defaultSport: DEFAULT_SPORT,
    sports,
    meta: r.meta,
    note: "Use sport keys in /events?sport=... and /snapshot?sport=...",
  });
}

async function handleEvents(url, env) {
  const sport = url.searchParams.get("sport") || DEFAULT_SPORT;

  // Odds API: GET /sports/{sport}/events
  const r = await oddsFetch(env, `/sports/${sport}/events`, {});
  return json(r, r.error ? 502 : 200);
}

async function handleSnapshot(url, env) {
  const sport = url.searchParams.get("sport") || DEFAULT_SPORT;

  // Markets (varies by sport/book/plan). Common: h2h, totals, spreads
  const markets = url.searchParams.get("markets") || "h2h,totals";
  const regions = url.searchParams.get("regions") || "us";
  const oddsFormat = url.searchParams.get("oddsFormat") || "american";

  // Optional: filter specific bookmakers
  const bookmakers = url.searchParams.get("bookmakers") || "";

  // Optional: single event targeting
  const eventId = url.searchParams.get("eventId") || "";

  // Base endpoint
  // If eventId is provided, prefer per-event odds endpoint (best for props/expanded markets)
  const endpoint = eventId
    ? `/sports/${sport}/events/${eventId}/odds`
    : `/sports/${sport}/odds`;

  const params = {
    regions,
    markets,
    oddsFormat,
  };

  if (bookmakers) params.bookmakers = bookmakers;

  // If no single eventId, allow multi-event filter via eventIds query param
  // (Backwards compatible + useful for batch calls)
  if (!eventId) {
    const eventIds = url.searchParams.get("eventIds") || "";
    if (eventIds) params.eventIds = eventIds;
  }

  const r = await oddsFetch(env, endpoint, params);
  if (r.error) return json(r, 502);

  // Normalize into a "market snapshot" with implied probabilities
  const normalized = normalizeSnapshot(r.data);

  return json({
    ok: true,
    meta: r.meta,
    query: { sport, regions, markets, oddsFormat, bookmakers, eventId },
    snapshot: normalized,
  });
}

// --- normalization helpers ---
function americanToImpliedProb(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;

  if (a > 0) return 100 / (a + 100);
  // a < 0
  return (-a) / ((-a) + 100);
}

function normalizeSnapshot(raw) {
  // raw is array of events with bookmakers -> markets -> outcomes
  if (!Array.isArray(raw)) return raw;

  return raw.map((ev) => {
    const out = {
      id: ev.id,
      commence_time: ev.commence_time,
      home_team: ev.home_team,
      away_team: ev.away_team,
      bookmakers: [],
    };

    for (const bm of ev.bookmakers || []) {
      const bmOut = {
        key: bm.key,
        title: bm.title,
        last_update: bm.last_update,
        markets: [],
      };

      for (const m of bm.markets || []) {
        const mOut = { key: m.key, outcomes: [] };
        for (const o of m.outcomes || []) {
          const price = o.price;
          mOut.outcomes.push({
            name: o.name,
            price,
            impliedProb: americanToImpliedProb(price),
            point: o.point ?? null, // totals/spreads lines
          });
        }
        bmOut.markets.push(mOut);
      }

      out.bookmakers.push(bmOut);
    }

    return out;
  });
}