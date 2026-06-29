/**
 * Mountain Movers Convention App — Backend
 * Plain Node.js (no dependencies) so it deploys cleanly on any free Node host
 * (Render, Railway, Cyclic, Glitch, etc.) with zero install surprises.
 *
 * Data is stored in a local JSON file (db.json). This is fine for a
 * convention-week app. If you outgrow it, swap saveDB()/loadDB() for a
 * real database later — every route already goes through those two
 * functions only.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 4000;
const DB_PATH = path.join(__dirname, "db.json");

// ---------- Tiny JSON "database" ----------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = { participants: {}, checkins: [], quizSubmissions: [], impactWall: [], prayerWall: [], testimonyWall: [], linkClicks: { mixlr: 0, youtube: 0 } };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!db.impactWall) db.impactWall = []; // upgrade older db.json files in place
    if (!db.prayerWall) db.prayerWall = []; // upgrade older db.json files in place
    if (!db.testimonyWall) db.testimonyWall = []; // upgrade older db.json files in place
    if (!db.linkClicks) db.linkClicks = { mixlr: 0, youtube: 0 }; // upgrade older db.json files in place
    return db;
  } catch (e) {
    console.error("DB read failed, starting fresh:", e.message);
    return { participants: {}, checkins: [], quizSubmissions: [], impactWall: [], prayerWall: [], testimonyWall: [], linkClicks: { mixlr: 0, youtube: 0 } };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Points configuration — change freely
const POINTS = {
  checkin: 10,        // per unique venue/spot check-in
  quizCorrect: 5,      // per correct quiz answer
  quizComplete: 15,    // bonus for finishing the whole quiz
  impactSubmit: 10,    // for submitting a "60 Seconds of Impact" message
};

const VENUES = ["main-3x3-km", "old-auditorium", "dtce", "psf", "around-the-camp"];

function getOrCreateParticipant(db, name, phone) {
  const key = (phone && phone.trim()) ? phone.trim() : name.trim().toLowerCase();
  if (!db.participants[key]) {
    db.participants[key] = {
      id: key,
      name: name.trim(),
      phone: phone ? phone.trim() : "",
      points: 0,
      venuesVisited: [],
      quizScore: 0,
      quizCompletedAt: null,
      impactSubmitted: false,
      createdAt: new Date().toISOString(),
    };
  }
  // upgrade older participant records that predate this field
  if (db.participants[key].impactSubmitted === undefined) {
    db.participants[key].impactSubmitted = false;
  }
  return db.participants[key];
}

// ---------- Helpers ----------
function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB safety cap
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function leaderboardView(db) {
  return Object.values(db.participants)
    .map((p) => ({
      name: p.name,
      points: p.points,
      venuesVisited: p.venuesVisited.length,
      quizScore: p.quizScore,
      impactSubmitted: !!p.impactSubmitted,
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 50);
}

// ---------- Routes ----------
const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

route("GET", "/api/health", async (req, res) => {
  send(res, 200, { ok: true, time: new Date().toISOString() });
});

// Check in at a venue
// body: { name, phone, venue }
route("POST", "/api/checkin", async (req, res) => {
  const body = await readBody(req);
  const { name, phone, venue } = body;
  if (!name || !venue) return send(res, 400, { ok: false, error: "name and venue are required" });
  if (!VENUES.includes(venue)) return send(res, 400, { ok: false, error: "unknown venue" });

  const db = loadDB();
  const p = getOrCreateParticipant(db, name, phone);

  const already = p.venuesVisited.includes(venue);
  if (!already) {
    p.venuesVisited.push(venue);
    p.points += POINTS.checkin;
    db.checkins.push({
      id: crypto.randomUUID(),
      participantId: p.id,
      name: p.name,
      venue,
      at: new Date().toISOString(),
    });
    saveDB(db);
  }

  send(res, 200, {
    ok: true,
    alreadyCheckedIn: already,
    participant: { name: p.name, points: p.points, venuesVisited: p.venuesVisited },
  });
});

// Get check-in count + recent log for a venue
route("GET", "/api/checkins/:venue", async (req, res, params) => {
  const venue = params.venue;
  if (!VENUES.includes(venue)) return send(res, 404, { ok: false, error: "unknown venue" });
  const db = loadDB();
  const entries = db.checkins.filter((c) => c.venue === venue);
  const recent = entries.slice(-20).reverse().map((c) => ({ name: c.name, at: c.at }));
  send(res, 200, { ok: true, venue, total: entries.length, recent });
});

// Submit quiz results
// body: { name, phone, answers: [{questionId, correct}], score }
route("POST", "/api/quiz/submit", async (req, res) => {
  const body = await readBody(req);
  const { name, phone, score, total } = body;
  if (!name || typeof score !== "number") {
    return send(res, 400, { ok: false, error: "name and numeric score are required" });
  }

  const db = loadDB();
  const p = getOrCreateParticipant(db, name, phone);

  const isFirstAttempt = !p.quizCompletedAt;
  const pointsEarned = score * POINTS.quizCorrect + (isFirstAttempt ? POINTS.quizComplete : 0);

  // Only count points + leaderboard score for the best attempt
  if (score > p.quizScore || isFirstAttempt) {
    p.points += isFirstAttempt ? pointsEarned : (score - p.quizScore) * POINTS.quizCorrect;
    p.quizScore = Math.max(p.quizScore, score);
  }
  p.quizCompletedAt = new Date().toISOString();

  db.quizSubmissions.push({
    id: crypto.randomUUID(),
    participantId: p.id,
    name: p.name,
    score,
    total: total || null,
    at: new Date().toISOString(),
  });
  saveDB(db);

  send(res, 200, {
    ok: true,
    participant: { name: p.name, points: p.points, quizScore: p.quizScore },
  });
});

// Leaderboard
route("GET", "/api/leaderboard", async (req, res) => {
  const db = loadDB();
  send(res, 200, { ok: true, leaderboard: leaderboardView(db) });
});

// Submit a "60 Seconds of Impact" message
// body: { name, phone, location, message }
route("POST", "/api/impact/submit", async (req, res) => {
  const body = await readBody(req);
  const { name, phone, location, message } = body;
  if (!name || !message || !message.trim()) {
    return send(res, 400, { ok: false, error: "name and message are required" });
  }
  if (message.trim().length > 400) {
    return send(res, 400, { ok: false, error: "message is too long (max 400 characters)" });
  }

  const db = loadDB();
  const p = getOrCreateParticipant(db, name, phone);

  const isFirst = !p.impactSubmitted;
  if (isFirst) {
    p.impactSubmitted = true;
    p.points += POINTS.impactSubmit;
  }

  db.impactWall.push({
    id: crypto.randomUUID(),
    participantId: p.id,
    name: p.name,
    location: (location || "").trim(),
    message: message.trim(),
    at: new Date().toISOString(),
  });
  saveDB(db);

  send(res, 200, {
    ok: true,
    alreadySubmitted: !isFirst,
    participant: { name: p.name, points: p.points },
  });
});

// Recent / all "60 Seconds of Impact" wall messages
route("GET", "/api/impact/recent", async (req, res) => {
  const db = loadDB();
  const recent = db.impactWall.slice(-60).reverse();
  send(res, 200, { ok: true, total: db.impactWall.length, recent });
});

// Submit a prayer request to the Prayer Wall
// body: { name, phone, location, request }
route("POST", "/api/prayer/submit", async (req, res) => {
  const body = await readBody(req);
  const { name, phone, location, request } = body;
  if (!name || !request || !request.trim()) {
    return send(res, 400, { ok: false, error: "name and request are required" });
  }
  if (request.trim().length > 400) {
    return send(res, 400, { ok: false, error: "request is too long (max 400 characters)" });
  }

  const db = loadDB();
  const p = getOrCreateParticipant(db, name, phone);

  const isFirst = !p.prayerSubmitted;
  if (isFirst) {
    p.prayerSubmitted = true;
    p.points += POINTS.impactSubmit; // same reward as an impact message
  }

  db.prayerWall.push({
    id: crypto.randomUUID(),
    participantId: p.id,
    name: p.name,
    location: (location || "").trim(),
    request: request.trim(),
    prayedFor: 0,
    at: new Date().toISOString(),
  });
  saveDB(db);

  send(res, 200, {
    ok: true,
    alreadySubmitted: !isFirst,
    participant: { name: p.name, points: p.points },
  });
});

// Recent prayer requests
route("GET", "/api/prayer/recent", async (req, res) => {
  const db = loadDB();
  const recent = db.prayerWall.slice(-80).reverse();
  send(res, 200, { ok: true, total: db.prayerWall.length, recent });
});

// Mark "I prayed for this" on a request
// body: { id }
route("POST", "/api/prayer/pray", async (req, res) => {
  const body = await readBody(req);
  const { id } = body;
  if (!id) return send(res, 400, { ok: false, error: "id is required" });
  const db = loadDB();
  const item = db.prayerWall.find((x) => x.id === id);
  if (!item) return send(res, 404, { ok: false, error: "not found" });
  item.prayedFor = (item.prayedFor || 0) + 1;
  saveDB(db);
  send(res, 200, { ok: true, prayedFor: item.prayedFor });
});

// Submit a testimony ("What mountain did God move for you?")
// body: { name, phone, location, testimony, mountain }
route("POST", "/api/testimony/submit", async (req, res) => {
  const body = await readBody(req);
  const { name, phone, location, testimony, mountain } = body;
  if (!name || !testimony || !testimony.trim()) {
    return send(res, 400, { ok: false, error: "name and testimony are required" });
  }
  if (testimony.trim().length > 600) {
    return send(res, 400, { ok: false, error: "testimony is too long (max 600 characters)" });
  }

  const db = loadDB();
  const p = getOrCreateParticipant(db, name, phone);

  const isFirst = !p.testimonySubmitted;
  if (isFirst) {
    p.testimonySubmitted = true;
    p.points += POINTS.impactSubmit;
  }

  db.testimonyWall.push({
    id: crypto.randomUUID(),
    participantId: p.id,
    name: p.name,
    location: (location || "").trim(),
    mountain: (mountain || "").trim(),
    testimony: testimony.trim(),
    at: new Date().toISOString(),
  });
  saveDB(db);

  send(res, 200, {
    ok: true,
    alreadySubmitted: !isFirst,
    participant: { name: p.name, points: p.points },
  });
});

// Recent testimonies
route("GET", "/api/testimony/recent", async (req, res) => {
  const db = loadDB();
  const recent = db.testimonyWall.slice(-80).reverse();
  send(res, 200, { ok: true, total: db.testimonyWall.length, recent });
});

// Track a click on a live-platform link (Mixlr / YouTube)
// body: { target: "mixlr" | "youtube" }
route("POST", "/api/track/click", async (req, res) => {
  const body = await readBody(req);
  const target = (body.target || "").toLowerCase();
  if (target !== "mixlr" && target !== "youtube") {
    return send(res, 400, { ok: false, error: "target must be 'mixlr' or 'youtube'" });
  }
  const db = loadDB();
  if (!db.linkClicks) db.linkClicks = { mixlr: 0, youtube: 0 };
  db.linkClicks[target] = (db.linkClicks[target] || 0) + 1;
  saveDB(db);
  send(res, 200, { ok: true, linkClicks: db.linkClicks });
});

// Admin report — link clicks, quiz takers, and check-ins.
// Optionally protected: set ADMIN_KEY in the environment, then call
// /api/report?key=YOUR_KEY. If ADMIN_KEY is not set, the report is open.
route("GET", "/api/report", async (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (ADMIN_KEY) {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.searchParams.get("key") !== ADMIN_KEY) {
      return send(res, 401, { ok: false, error: "unauthorized" });
    }
  }

  const db = loadDB();
  const clicks = db.linkClicks || { mixlr: 0, youtube: 0 };

  // Quiz takers: participants who have completed the quiz at least once
  const quizTakers = Object.values(db.participants)
    .filter((p) => p.quizCompletedAt)
    .map((p) => ({ name: p.name, quizScore: p.quizScore, at: p.quizCompletedAt }))
    .sort((a, b) => new Date(b.at) - new Date(a.at));

  // Check-ins: group by participant, plus a per-venue tally
  const perVenue = {};
  VENUES.forEach((v) => (perVenue[v] = 0));
  const peopleMap = {};
  db.checkins.forEach((c) => {
    perVenue[c.venue] = (perVenue[c.venue] || 0) + 1;
    if (!peopleMap[c.participantId]) peopleMap[c.participantId] = { name: c.name, venues: [], lastAt: c.at };
    peopleMap[c.participantId].venues.push(c.venue);
    if (new Date(c.at) > new Date(peopleMap[c.participantId].lastAt)) peopleMap[c.participantId].lastAt = c.at;
  });
  const checkinPeople = Object.values(peopleMap).sort((a, b) => b.venues.length - a.venues.length);

  send(res, 200, {
    ok: true,
    generatedAt: new Date().toISOString(),
    linkClicks: {
      mixlr: clicks.mixlr || 0,
      youtube: clicks.youtube || 0,
      total: (clicks.mixlr || 0) + (clicks.youtube || 0),
    },
    quiz: {
      totalTakers: quizTakers.length,
      totalAttempts: db.quizSubmissions.length,
      takers: quizTakers,
    },
    checkins: {
      totalCheckins: db.checkins.length,
      uniquePeople: checkinPeople.length,
      perVenue,
      people: checkinPeople,
    },
    impactMessages: (db.impactWall || []).length,
    prayerRequests: (db.prayerWall || []).length,
    testimonies: (db.testimonyWall || []).length,
  });
});

// Lookup a single participant's progress (for "my progress" view)
route("GET", "/api/participant/:id", async (req, res, params) => {
  const db = loadDB();
  const key = decodeURIComponent(params.id).trim().toLowerCase();
  const p = db.participants[key] || Object.values(db.participants).find(
    (x) => x.name.trim().toLowerCase() === key
  );
  if (!p) return send(res, 404, { ok: false, error: "not found" });
  send(res, 200, { ok: true, participant: p });
});

// ---------- Tiny router matching ----------
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const patternParts = r.pattern.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = pathParts[i];
      } else if (patternParts[i] !== pathParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const match = matchRoute(req.method, url.pathname);
  if (!match) return send(res, 404, { ok: false, error: "not found" });

  try {
    await match.handler(req, res, match.params);
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, error: "server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Mountain Movers backend running on port ${PORT}`);
});
