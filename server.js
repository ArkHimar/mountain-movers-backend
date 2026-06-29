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
function freshDB() {
  return {
    participants: {}, checkins: [], quizSubmissions: [],
    impactWall: [], prayerWall: [], testimonyWall: [],
    linkClicks: { mixlr: 0, youtube: 0 },
    users: {},        // id -> user record (with hashed password)
    userLogins: {},   // loginKey(lowercased phone/email) -> userId
    sessions: {},     // token -> { userId, role, createdAt }
    events: [],       // unified activity log
    gamePlays: [],    // word-climb / seven-mountains results
    fiveMinutes: [],  // "Five Minutes With…" guest entries (staff-posted)
  };
}
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = freshDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    // upgrade older db.json files in place
    const f = freshDB();
    for (const k of Object.keys(f)) if (db[k] === undefined) db[k] = f[k];
    return db;
  } catch (e) {
    console.error("DB read failed, starting fresh:", e.message);
    return freshDB();
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

// Send a plain-text / CSV response (with CORS)
function sendText(res, status, text, contentType, filename) {
  const headers = {
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  };
  if (filename) headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  res.writeHead(status, headers);
  res.end(text);
}

// ---------- Auth helpers ----------
const ROLES = ["admin", "staff", "guest", "attendant"];
// Codes that authorise an elevated role at registration. Override in env.
const ROLE_CODES = {
  admin: process.env.ADMIN_CODE || "rccg-admin-2026",
  staff: process.env.STAFF_CODE || "rccg-staff-2026",
  guest: process.env.GUEST_CODE || "rccg-guest-2026",
  // attendant needs no code
};

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), s, 64).toString("hex");
  return { salt: s, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function makeToken() { return crypto.randomBytes(24).toString("hex"); }

// Pull a session token from Authorization header, body, or ?token=
function getToken(req, body, url) {
  const auth = req.headers["authorization"] || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (body && body.token) return String(body.token);
  if (url) { const t = url.searchParams.get("token"); if (t) return t; }
  return null;
}
function getUser(db, token) {
  if (!token) return null;
  const sess = db.sessions[token];
  if (!sess) return null;
  return db.users[sess.userId] || null;
}
// Public-safe view of a user
function userView(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, role: u.role, phone: u.phone || "", email: u.email || "", createdAt: u.createdAt };
}
// Is the request from an admin? (admin token OR legacy ADMIN_KEY)
function isAdminReq(db, req, body, url) {
  const u = getUser(db, getToken(req, body, url));
  if (u && u.role === "admin") return true;
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (ADMIN_KEY && url && url.searchParams.get("key") === ADMIN_KEY) return true;
  if (ADMIN_KEY && body && body.key === ADMIN_KEY) return true;
  return false;
}
function hasRole(db, req, body, url, roles) {
  const u = getUser(db, getToken(req, body, url));
  if (u && roles.includes(u.role)) return true;
  // ADMIN_KEY counts as admin
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (roles.includes("admin") && ADMIN_KEY) {
    if ((url && url.searchParams.get("key") === ADMIN_KEY) || (body && body.key === ADMIN_KEY)) return true;
  }
  return false;
}

// Append to the unified activity log
function logEvent(db, type, info) {
  db.events.push({
    id: crypto.randomUUID(),
    type,                                  // checkin | quiz | prayer | impact | testimony | game | click | login | register
    name: (info && info.name) || "",
    role: (info && info.role) || "",
    userId: (info && info.userId) || null,
    detail: (info && info.detail) || "",
    at: new Date().toISOString(),
  });
  // keep the log from growing without bound on the free tier
  if (db.events.length > 20000) db.events = db.events.slice(-15000);
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
    logEvent(db, "checkin", { name: p.name, detail: venue });
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
  logEvent(db, "quiz", { name: p.name, detail: `score ${score}/${total || "?"}` });
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
  logEvent(db, "impact", { name: p.name, detail: message.trim().slice(0, 80) });
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
  logEvent(db, "prayer", { name: p.name, detail: request.trim().slice(0, 80) });
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
  logEvent(db, "testimony", { name: p.name, detail: (mountain || "").trim() });
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
  logEvent(db, "click", { detail: target });
  saveDB(db);
  send(res, 200, { ok: true, linkClicks: db.linkClicks });
});

// Track a game play (Word Climb / Seven Mountains) — optional auth
// body: { game, name, score, token }
route("POST", "/api/track/game", async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const game = (body.game || "").trim();
  if (!game) return send(res, 400, { ok: false, error: "game is required" });
  const db = loadDB();
  const user = getUser(db, getToken(req, body, url));
  const name = (body.name || (user && user.name) || "Guest").toString().trim();
  db.gamePlays.push({
    id: crypto.randomUUID(),
    game,
    name,
    score: typeof body.score === "number" ? body.score : null,
    userId: user ? user.id : null,
    at: new Date().toISOString(),
  });
  logEvent(db, "game", { name, role: user ? user.role : "", userId: user ? user.id : null, detail: game });
  saveDB(db);
  send(res, 200, { ok: true });
});

// Admin report — link clicks, quiz takers, and check-ins.
// Optionally protected: set ADMIN_KEY in the environment, then call
// /api/report?key=YOUR_KEY. If ADMIN_KEY is not set, the report is open.
route("GET", "/api/report", async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = loadDB();
  // Allow an admin account token OR the legacy ADMIN_KEY. If no ADMIN_KEY is
  // set and no admin is logged in, the report stays open (demo-friendly).
  const ADMIN_KEY = process.env.ADMIN_KEY;
  const adminLoggedIn = (() => { const u = getUser(db, getToken(req, null, url)); return u && u.role === "admin"; })();
  if (ADMIN_KEY && !adminLoggedIn && url.searchParams.get("key") !== ADMIN_KEY) {
    return send(res, 401, { ok: false, error: "unauthorized" });
  }

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

// ===================== AUTH =====================

// Register a new account.
// body: { name, password, phone?, email?, role?, code? }
route("POST", "/api/auth/register", async (req, res) => {
  const body = await readBody(req);
  const name = (body.name || "").trim();
  const password = String(body.password || "");
  const phone = (body.phone || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  let role = (body.role || "attendant").trim();

  if (!name) return send(res, 400, { ok: false, error: "name is required" });
  if (password.length < 6) return send(res, 400, { ok: false, error: "password must be at least 6 characters" });
  if (!phone && !email) return send(res, 400, { ok: false, error: "a phone number or email is required" });
  if (!ROLES.includes(role)) role = "attendant";

  // Elevated roles require the correct code
  if (role !== "attendant") {
    if (!body.code || body.code !== ROLE_CODES[role]) {
      return send(res, 403, { ok: false, error: `a valid ${role} code is required to register as ${role}` });
    }
  }

  const db = loadDB();
  const loginKey = (email || phone).toLowerCase();
  if (db.userLogins[loginKey]) {
    return send(res, 409, { ok: false, error: "an account with that phone/email already exists — please log in" });
  }

  const id = crypto.randomUUID();
  const { salt, hash } = hashPassword(password);
  db.users[id] = {
    id, name, phone, email, role,
    salt, passHash: hash,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };
  db.userLogins[loginKey] = id;
  if (phone) db.userLogins[phone.toLowerCase()] = id; // allow login by phone too

  const token = makeToken();
  db.sessions[token] = { userId: id, role, createdAt: new Date().toISOString() };
  logEvent(db, "register", { name, role, userId: id });
  saveDB(db);

  send(res, 200, { ok: true, token, user: userView(db.users[id]) });
});

// Log in.
// body: { login (phone or email), password }
route("POST", "/api/auth/login", async (req, res) => {
  const body = await readBody(req);
  const login = (body.login || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!login || !password) return send(res, 400, { ok: false, error: "login and password are required" });

  const db = loadDB();
  const userId = db.userLogins[login];
  const user = userId && db.users[userId];
  if (!user || !verifyPassword(password, user.salt, user.passHash)) {
    return send(res, 401, { ok: false, error: "incorrect login or password" });
  }
  user.lastLoginAt = new Date().toISOString();
  const token = makeToken();
  db.sessions[token] = { userId: user.id, role: user.role, createdAt: new Date().toISOString() };
  logEvent(db, "login", { name: user.name, role: user.role, userId: user.id });
  saveDB(db);
  send(res, 200, { ok: true, token, user: userView(user) });
});

// Who am I? (token in Authorization header or ?token=)
route("GET", "/api/auth/me", async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = loadDB();
  const user = getUser(db, getToken(req, null, url));
  if (!user) return send(res, 401, { ok: false, error: "not logged in" });
  send(res, 200, { ok: true, user: userView(user) });
});

// Log out (invalidate token)
route("POST", "/api/auth/logout", async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = getToken(req, body, url);
  const db = loadDB();
  if (token && db.sessions[token]) { delete db.sessions[token]; saveDB(db); }
  send(res, 200, { ok: true });
});

// ===================== FIVE MINUTES WITH… =====================

route("GET", "/api/five-minutes/recent", async (req, res) => {
  const db = loadDB();
  send(res, 200, { ok: true, items: db.fiveMinutes.slice().reverse() });
});

// Add a guest entry — staff or admin only.
// body: { token, status, name, role, when, blurb }
route("POST", "/api/five-minutes/add", async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = loadDB();
  if (!hasRole(db, req, body, url, ["staff", "admin"])) {
    return send(res, 403, { ok: false, error: "staff or admin login required" });
  }
  const name = (body.name || "").trim();
  if (!name) return send(res, 400, { ok: false, error: "guest name is required" });
  const poster = getUser(db, getToken(req, body, url));
  const entry = {
    id: crypto.randomUUID(),
    status: ["today", "upcoming", "aired"].includes(body.status) ? body.status : "upcoming",
    name,
    role: (body.role || "").trim(),
    when: (body.when || "").trim(),
    blurb: (body.blurb || "").trim().slice(0, 400),
    postedBy: poster ? poster.name : "admin",
    at: new Date().toISOString(),
  };
  db.fiveMinutes.push(entry);
  saveDB(db);
  send(res, 200, { ok: true, entry });
});

// Delete a guest entry — staff or admin only.
route("POST", "/api/five-minutes/delete", async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = loadDB();
  if (!hasRole(db, req, body, url, ["staff", "admin"])) {
    return send(res, 403, { ok: false, error: "staff or admin login required" });
  }
  const before = db.fiveMinutes.length;
  db.fiveMinutes = db.fiveMinutes.filter((e) => e.id !== body.id);
  saveDB(db);
  send(res, 200, { ok: true, removed: before - db.fiveMinutes.length });
});

// ===================== ADMIN ANALYTICS =====================

// Activity stats for the dashboard graph (admin only).
route("GET", "/api/admin/stats", async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = loadDB();
  if (!isAdminReq(db, req, null, url)) return send(res, 401, { ok: false, error: "unauthorized" });

  // Canonical totals (robust even before event logging existed)
  const totals = {
    checkins: db.checkins.length,
    quizzes: db.quizSubmissions.length,
    prayers: db.prayerWall.length,
    impact: db.impactWall.length,
    testimonies: db.testimonyWall.length,
    games: db.gamePlays.length,
    clicks: (db.linkClicks.mixlr || 0) + (db.linkClicks.youtube || 0),
    logins: db.events.filter((e) => e.type === "login").length,
  };

  // Per-day breakdown from the event log
  const byDay = {};
  db.events.forEach((e) => {
    const day = (e.at || "").slice(0, 10);
    if (!day) return;
    if (!byDay[day]) byDay[day] = {};
    byDay[day][e.type] = (byDay[day][e.type] || 0) + 1;
  });

  const usersByRole = { admin: 0, staff: 0, guest: 0, attendant: 0 };
  Object.values(db.users).forEach((u) => { usersByRole[u.role] = (usersByRole[u.role] || 0) + 1; });

  send(res, 200, {
    ok: true,
    generatedAt: new Date().toISOString(),
    totals,
    byDay,
    usersByRole,
    totalUsers: Object.keys(db.users).length,
  });
});

// Daily activity export as CSV (admin only). ?date=YYYY-MM-DD or ?date=all
route("GET", "/api/admin/activity.csv", async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = loadDB();
  if (!isAdminReq(db, req, null, url)) return sendText(res, 401, "unauthorized", "text/plain");

  const dateParam = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const csvEsc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;

  // Merge every activity into one timestamped list
  const rows = [];
  db.checkins.forEach((c) => rows.push([c.at, "check-in", c.name, c.venue]));
  db.quizSubmissions.forEach((q) => rows.push([q.at, "quiz", q.name, `score ${q.score}/${q.total || "?"}`]));
  db.prayerWall.forEach((p) => rows.push([p.at, "prayer", p.name, p.request]));
  db.impactWall.forEach((m) => rows.push([m.at, "60s-impact", m.name, m.message]));
  db.testimonyWall.forEach((t) => rows.push([t.at, "testimony", t.name, t.mountain || t.testimony]));
  db.gamePlays.forEach((g) => rows.push([g.at, "game", g.name, g.game + (g.score != null ? ` (${g.score})` : "")]));
  db.events.filter((e) => ["login", "register", "click"].includes(e.type))
    .forEach((e) => rows.push([e.at, e.type, e.name, e.detail]));

  const filtered = dateParam === "all" ? rows : rows.filter((r) => (r[0] || "").slice(0, 10) === dateParam);
  filtered.sort((a, b) => new Date(a[0]) - new Date(b[0]));

  const header = "Timestamp,Date,Time,Activity,Name,Detail";
  const lines = filtered.map((r) => {
    const d = new Date(r[0]);
    const date = isNaN(d) ? "" : d.toISOString().slice(0, 10);
    const time = isNaN(d) ? "" : d.toISOString().slice(11, 19);
    return [r[0], date, time, r[1], r[2], r[3]].map(csvEsc).join(",");
  });
  const csv = [header, ...lines].join("\r\n");
  const fname = `mountain-movers-activity-${dateParam}.csv`;
  sendText(res, 200, csv, "text/csv; charset=utf-8", fname);
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
