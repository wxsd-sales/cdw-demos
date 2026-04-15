/**
 * Serves ../meeting-join and provides GET /api/first-two-videos (playlist from .env).
 *
 * Copy .env.example to .env and set VIDCAST_PLAYLIST_ID.
 *
 *   npm install
 *   npm start
 *
 * Open (only these query params are supported by the front end):
 *   http://localhost:3040/?token=…&sip=…
 *
 * POST /command — JSON body
 * `{"command":"start","sip":"…","user":"…"}` (user must match an entry in USERLIST, case-insensitive)
 * or `{"command":"end"}`. Starts or stops puppeteer-join.js (serialized; duplicate start
 * kills the previous run first).
 *
 * Optional: PORT=8080 npm start
 *
 * Docker (build context must be parent `tumor-board/` so static files can be copied):
 *   docker build -f meeting-join-server/Dockerfile -t meeting-join .
 *   docker run --rm -p 10031:10031 meeting-join
 * Put VIDCAST_PLAYLIST_ID in meeting-join-server/.env — it is COPY’d into the image at build time.
 * Webex: WEBEX_CLIENT_ID, WEBEX_CLIENT_SECRET, comma-separated REFRESH_TOKEN and USERLIST
 * (same length; process exits on mismatch). Each slot is refreshed after listen and every 24h.
 * GET /ready returns 503 until every slot has an access token (readinessProbe).
 * See meeting-join-server/Dockerfile and puppeteer-join.js (Democast ref: in-meeting-demos @876bd83).
 */

"use strict";

const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");

const WEBEX_TOKEN_URL = "https://webexapis.com/v1/access_token";
/** Re-fetch access token on this cadence for long-running containers (ms). */
const WEBEX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Avoid hanging forever if Webex is unreachable (ms). */
const WEBEX_FETCH_TIMEOUT_MS = Number(process.env.WEBEX_FETCH_TIMEOUT_MS) || 30000;
/** Retry initial OAuth if it fails (e.g. cold start network). */
const WEBEX_INITIAL_RETRY_MS = Number(process.env.WEBEX_INITIAL_RETRY_MS) || 30000;

function parseCommaSeparatedEnv(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const webexUsers = parseCommaSeparatedEnv("USERLIST");
const webexRefreshFromEnv = parseCommaSeparatedEnv("REFRESH_TOKEN");

if (webexUsers.length !== webexRefreshFromEnv.length) {
  console.error(
    `[meeting-join-server] USERLIST entries (${webexUsers.length}) must equal REFRESH_TOKEN entries (${webexRefreshFromEnv.length}).`,
  );
  process.exit(1);
}
if (webexUsers.length === 0) {
  console.error(
    "[meeting-join-server] USERLIST and REFRESH_TOKEN must each list at least one comma-separated value.",
  );
  process.exit(1);
}

/** In-memory refresh tokens (aligned with webexUsers); updated when Webex returns a new refresh_token. */
let webexRefreshTokens = webexRefreshFromEnv.slice();
/** access_token per slot; null until first successful refresh for that index. */
let webexAccessTokens = webexUsers.map(() => null);

let webexRefreshTimer = null;
let webexInitialRetryTimer = null;

/** One refresh chain at a time (parallel refresh_token calls can invalidate each other). */
let webexRefreshQueue = Promise.resolve();

function runWebexRefreshSerialized(fn) {
  const next = webexRefreshQueue.then(() => fn());
  webexRefreshQueue = next.catch(() => {});
  return next;
}

async function webexExchangeRefreshToken(refreshToken) {
  const clientId =
    process.env.WEBEX_CLIENT_ID && String(process.env.WEBEX_CLIENT_ID).trim();
  const clientSecret =
    process.env.WEBEX_CLIENT_SECRET &&
    String(process.env.WEBEX_CLIENT_SECRET).trim();
  const rt = refreshToken && String(refreshToken).trim();
  if (!clientId || !clientSecret || !rt) {
    throw new Error(
      "Missing WEBEX_CLIENT_ID, WEBEX_CLIENT_SECRET, or refresh_token for slot",
    );
  }

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  form.set("refresh_token", rt);

  const r = await fetch(WEBEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(WEBEX_FETCH_TIMEOUT_MS),
  });

  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error(`Webex token HTTP ${r.status}: response was not JSON`);
  }

  if (!r.ok) {
    const msg =
      (data && (data.message || data.errors || data.error)) || raw.slice(0, 200);
    throw new Error(`Webex token HTTP ${r.status}: ${String(msg)}`);
  }

  const at = data.access_token;
  if (typeof at !== "string" || !at.trim()) {
    throw new Error("Webex token response missing access_token");
  }

  return {
    accessToken: at.trim(),
    newRefreshToken:
      typeof data.refresh_token === "string" && data.refresh_token.trim()
        ? data.refresh_token.trim()
        : null,
    expiresIn: data.expires_in,
  };
}

async function refreshWebexAccessTokenAtIndex(i) {
  const rt = webexRefreshTokens[i];
  if (!rt) {
    throw new Error(`Missing refresh token at USERLIST/REFRESH_TOKEN index ${i}`);
  }
  const out = await webexExchangeRefreshToken(rt);
  webexAccessTokens[i] = out.accessToken;
  if (out.newRefreshToken) webexRefreshTokens[i] = out.newRefreshToken;
  console.log(
    `[meeting-join-server] Webex slot ${i} (${webexUsers[i]}) access token ok (expires_in=${out.expiresIn ?? "?"})`,
  );
}

async function refreshAllWebexAccessTokens() {
  for (let i = 0; i < webexUsers.length; i++) {
    await refreshWebexAccessTokenAtIndex(i);
  }
}

function webexUserListIndex(userInput) {
  if (typeof userInput !== "string" || !userInput.trim()) return -1;
  const needle = userInput.trim().toLowerCase();
  for (let i = 0; i < webexUsers.length; i++) {
    if (webexUsers[i].toLowerCase() === needle) return i;
  }
  return -1;
}

function allWebexAccessTokensReady() {
  return (
    webexAccessTokens.length === webexUsers.length &&
    webexAccessTokens.every((t) => typeof t === "string" && t.length > 0)
  );
}

function scheduleWebexTokenRefresh() {
  if (webexRefreshTimer) clearInterval(webexRefreshTimer);
  webexRefreshTimer = setInterval(() => {
    runWebexRefreshSerialized(() => refreshAllWebexAccessTokens()).catch((e) => {
      console.error(
        "[meeting-join-server] scheduled Webex token refresh failed:",
        e && e.message ? e.message : String(e),
      );
    });
  }, WEBEX_REFRESH_INTERVAL_MS);
}

function envForPuppeteerChild(sip, joinToken) {
  const env = { ...process.env, JOIN_SIP: sip, JOIN_TOKEN: joinToken };
  delete env.WEBEX_CLIENT_SECRET;
  delete env.WEBEX_CLIENT_ID;
  delete env.REFRESH_TOKEN;
  delete env.USERLIST;
  return env;
}

const PORT = Number(process.env.PORT) || 3040;
const STATIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.join(__dirname, "..", "meeting-join");
const VIDCAST_API = "https://api.vidcast.io";

async function fetchFirstTwoMp4FromPlaylist(playlistId) {
  const id = String(playlistId || "").trim();
  if (!id) throw new Error("empty playlist id");

  const out = [];
  let page = 0;
  const size = 50;

  while (true) {
    const url =
      `${VIDCAST_API}/v1/playlists/${encodeURIComponent(id)}` +
      `/videos?page=${page}&pageSize=${size}&skipUnavailable=false`;
    const r = await fetch(url);
    if (!r.ok) {
      throw new Error(`Vidcast HTTP ${r.status} for playlist`);
    }
    const data = await r.json();
    const chunk = data.content || [];
    if (chunk.length === 0) break;
    for (const item of chunk) {
      if (!item.share_id) continue;
      out.push({
        name: item.name || "Untitled",
        mp4: item.camera_asset_url || "",
      });
    }
    if (chunk.length < size) break;
    page += 1;
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  if (out.length < 2) {
    throw new Error("Need at least 2 videos with MP4 in playlist");
  }
  if (!out[0].mp4 || !out[1].mp4) {
    throw new Error("First two sorted items missing camera_asset_url");
  }

  return {
    v1: out[0].mp4,
    v2: out[1].mp4,
    label: `${out[0].name} | ${out[1].name}`,
  };
}

/** Serialized /command handling so concurrent POSTs do not race child lifecycle. */
let commandQueue = Promise.resolve();

function runSerialized(fn) {
  const next = commandQueue.then(() => fn());
  commandQueue = next.catch(() => {});
  return next;
}

let puppeteerChild = null;

function waitChildClose(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", resolve);
    child.once("error", resolve);
  });
}

async function stopPuppeteerIfRunning() {
  const c = puppeteerChild;
  if (!c) return;
  puppeteerChild = null;
  try {
    c.kill("SIGTERM");
  } catch (_) {}
  await Promise.race([
    waitChildClose(c),
    new Promise((r) => setTimeout(r, 10000)),
  ]);
  if (c.exitCode === null && c.signalCode === null) {
    try {
      c.kill("SIGKILL");
    } catch (_) {}
    await Promise.race([
      waitChildClose(c),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  }
}

function startPuppeteerJoin(sip, joinToken) {
  if (!joinToken) {
    throw new Error(
      "Webex access token is not available for this user; check OAuth and GET /ready",
    );
  }
  const scriptPath = path.join(__dirname, "puppeteer-join.js");
  const child = spawn(process.execPath, [scriptPath], {
    env: envForPuppeteerChild(sip, joinToken),
    stdio: "inherit",
  });
  puppeteerChild = child;
  child.on("close", (code, signal) => {
    if (puppeteerChild === child) puppeteerChild = null;
    console.log(
      `[meeting-join-server] puppeteer-join exited code=${code} signal=${signal || ""}`,
    );
  });
  child.on("error", (err) => {
    console.error("[meeting-join-server] puppeteer-join spawn error:", err);
    if (puppeteerChild === child) puppeteerChild = null;
  });
}

const app = express();
app.use(express.json());

app.post("/command", (req, res) => {
  runSerialized(async () => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const command = body.command;

    if (command === "end") {
      await stopPuppeteerIfRunning();
      res.json({ ok: true });
      return;
    }

    if (command === "start") {
      const sip = body.sip;
      if (typeof sip !== "string" || !sip.trim()) {
        res.status(400).json({
          ok: false,
          error: 'Invalid or missing "sip" for command "start"',
        });
        return;
      }
      const user = body.user;
      if (typeof user !== "string" || !user.trim()) {
        res.status(400).json({
          ok: false,
          error: 'Invalid or missing "user" for command "start"',
        });
        return;
      }
      const slot = webexUserListIndex(user);
      if (slot < 0) {
        res.status(400).json({
          ok: false,
          error: '"user" does not match any entry in USERLIST',
        });
        return;
      }
      const joinToken = webexAccessTokens[slot];
      if (!joinToken) {
        res.status(503).json({
          ok: false,
          error:
            "Webex access token for this user not ready yet; retry or check GET /ready",
        });
        return;
      }
      await stopPuppeteerIfRunning();
      try {
        startPuppeteerJoin(sip.trim(), joinToken);
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message || e) });
        return;
      }
      res.json({ ok: true });
      return;
    }

    res.status(400).json({
      ok: false,
      error: 'Body must include "command": "start" or "end"',
    });
  }).catch((e) => {
    console.error("[meeting-join-server] POST /command", e);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
});

app.get("/alive", async (req, res) => {
  res.status(200).json({ "ok": "true" });
});

/** Kubernetes readinessProbe: 503 until every Webex slot has an access token. */
app.get("/ready", (req, res) => {
  if (allWebexAccessTokensReady()) {
    res.status(200).json({ ok: true, slots: webexUsers.length });
    return;
  }
  res.status(503).json({ ok: false, reason: "webex_token_pending" });
});

app.get("/api/first-two-videos", async (req, res) => {
  try {
    const playlistId = process.env.VIDCAST_PLAYLIST_ID;
    if (!playlistId || !String(playlistId).trim()) {
      res.status(500).json({
        error:
          "VIDCAST_PLAYLIST_ID is not set. Add it to meeting-join-server/.env (see .env.example).",
      });
      return;
    }
    const body = await fetchFirstTwoMp4FromPlaylist(playlistId);
    res.json(body);
  } catch (e) {
    console.error("[meeting-join-server] /api/first-two-videos", e);
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.use(express.static(STATIC_DIR));

async function shutdownSignal() {
  if (webexRefreshTimer) {
    clearInterval(webexRefreshTimer);
    webexRefreshTimer = null;
  }
  if (webexInitialRetryTimer) {
    clearTimeout(webexInitialRetryTimer);
    webexInitialRetryTimer = null;
  }
  await stopPuppeteerIfRunning();
  process.exit(0);
}
process.once("SIGTERM", shutdownSignal);
process.once("SIGINT", shutdownSignal);

function scheduleInitialWebexTokenRetry() {
  if (webexInitialRetryTimer) return;
  webexInitialRetryTimer = setTimeout(() => {
    webexInitialRetryTimer = null;
    void ensureWebexTokenThenSchedule();
  }, WEBEX_INITIAL_RETRY_MS);
}

async function ensureWebexTokenThenSchedule() {
  try {
    await runWebexRefreshSerialized(() => refreshAllWebexAccessTokens());
    if (webexInitialRetryTimer) {
      clearTimeout(webexInitialRetryTimer);
      webexInitialRetryTimer = null;
    }
    scheduleWebexTokenRefresh();
  } catch (e) {
    console.error(
      "[meeting-join-server] Webex token refresh failed:",
      e && e.message ? e.message : String(e),
    );
    scheduleInitialWebexTokenRetry();
  }
}

app.listen(PORT, () => {
  const pid = process.env.VIDCAST_PLAYLIST_ID;
  console.log(
    `[meeting-join-server] http://localhost:${PORT}/  static ← ${STATIC_DIR}`
  );
  console.log(
    `[meeting-join-server] GET /api/first-two-videos  playlist=${pid ? "(set)" : "MISSING .env"}`,
  );
  console.log(
    `[meeting-join-server] POST /command  start (sip+user)|end  (${webexUsers.length} USERLIST slot(s))`,
  );
  console.log(
    `[meeting-join-server] GET /ready 503 until all Webex slots have tokens (readinessProbe)`,
  );
  console.log(
    `[meeting-join-server] Webex token refresh every ${WEBEX_REFRESH_INTERVAL_MS / 3600000}h`,
  );
  console.log(
    `[meeting-join-server] Example: http://localhost:${PORT}/?token=…&sip=…`,
  );
  void ensureWebexTokenThenSchedule();
});
