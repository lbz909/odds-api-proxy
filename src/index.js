export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/") {
      return new Response("Odds API Proxy running", { status: 200 });
    }

    // Upcoming MMA events
if (url.pathname === "/events") {
  const key = env.ODDS_API_KEY;

  if (!key) {
    return new Response(
      JSON.stringify({ error: "ODDS_API_KEY secret not set in Worker runtime" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const apiUrl =
    "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/events" +
    `?apiKey=${encodeURIComponent(key)}`;

  const res = await fetch(apiUrl);

  return new Response(await res.text(), {
  status: res.status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  },
});

    // Odds for a specific event
    if (url.pathname === "/odds") {
      const eventId = url.searchParams.get("eventId");

      if (!eventId) {
        return new Response(
          JSON.stringify({ error: "Missing eventId" }),
          { status: 400 }
        );
      }

      const apiUrl =
        `https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/events/${eventId}/odds?regions=us&markets=h2h`;

      const res = await fetch(apiUrl, {
        headers: {
          "X-Api-Key": env.ODDS_API_KEY
        }
      });

      return new Response(await res.text(), {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};
