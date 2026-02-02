export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
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
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  // Helpful metadata: remaining requests etc if provided
  const meta = {
    status: res.status,
    remaining: res.headers.get("x-requests-remaining"),
    used: res.headers.get("x-requests-used"),
  };

  if (!res.ok) return { error: true, meta, data };
  return { error: false, meta, data };
}

async function handleSports(env) {
  // MMA key commonly: mma_mixed_martial_arts
  return json({
    ok: true,
    sportKey: "mma_mixed_martial_arts",
    note: "Use /events to list upcoming MMA events",
  });
}

async function handleEvents(url, env) {
  const sport = url.searchParams.get("sport") || "mma_mixed_martial_arts";

  // Odds API: GET /sports/{sport}/events
  const r = await oddsFetch(env, `/sports/${sport}/events`, {});
  return json(r, r.error ? 502 : 200);
}

async function handleSnapshot(url, env) {
  const sport = url.searchParams.get("sport") || "mma_mixed_martial_arts";

  // Markets you asked for
  // - h2h (moneyline)
  // - totals
  // - h2h_lay / spreads etc optional
  // - props may vary by plan + sport coverage
  const markets = url.searchParams.get("markets") || "h2h,totals";
  const regions = url.searchParams.get("regions") || "us";
  const oddsFormat = url.searchParams.get("oddsFormat") || "american";

  // Multiple books (Odds API uses "bookmakers" to filter)
  // Provide comma-separated bookmakers keys (e.g. "draftkings,fanduel")
  const bookmakers = url.searchParams.get("bookmakers") || "";

  // Event filter (recommended): eventId reduces payload
  const eventId = url.searchParams.get("eventId") || "";

  // Endpoint: GET /sports/{sport}/odds
  const params = {
    regions,
    markets,
    oddsFormat,
  };
  if (bookmakers) params.bookmakers = bookmakers;
  if (eventId) params.eventIds = eventId; // Odds API supports eventIds in some endpoints; if not, we’ll adapt.

  const r = await oddsFetch(env, `/sports/${sport}/odds`, params);
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
      const bmOut = { key: bm.key, title: bm.title, last_update: bm.last_update, markets: [] };

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

