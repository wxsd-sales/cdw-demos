#!/usr/bin/env node
/**
 * Headless Chromium: open meeting-join and click #join-webex (user gesture for clip-1 audio).
 *
 * Pattern from Democast in-meeting-demos @ 876bd83 (nodePuppeteer/customCall.js): puppeteer.launch
 * with --no-sandbox, system Chromium executablePath, page.goto, page.evaluate clicks.
 *
 * Override URL: JOIN_URL=http://127.0.0.1:10031/?token=...&sip=...
 * Otherwise set JOIN_SIP and JOIN_TOKEN; host/port from PORT (default 3040).
 */
"use strict";

const puppeteer = require("puppeteer-core");

function buildJoinUrl() {
  if (process.env.JOIN_URL && String(process.env.JOIN_URL).trim()) {
    return String(process.env.JOIN_URL).trim();
  }
  const sip = process.env.JOIN_SIP && String(process.env.JOIN_SIP).trim();
  if (!sip) {
    console.error(
      "[puppeteer-join] Set JOIN_URL or JOIN_SIP (e.g. from POST /command start).",
    );
    process.exit(1);
  }
  const token = process.env.JOIN_TOKEN && String(process.env.JOIN_TOKEN).trim();
  if (!token) {
    console.error(
      "[puppeteer-join] JOIN_TOKEN is required unless JOIN_URL is set (server supplies OAuth access token).",
    );
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3040;
  const q = new URLSearchParams();
  q.set("token", token);
  q.set("sip", sip);
  return `http://127.0.0.1:${port}/?${q.toString()}`;
}

const JOIN_URL = buildJoinUrl();
const EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=site-per-process",
      "--disable-web-security",
      "--enable-automation",
      "--use-fake-ui-for-media-stream",
      "--no-user-gesture-required",
    ],
  });

  const page = await browser.newPage();
  page.on("console", (msg) => {
    try {
      console.log("[page]", msg.type(), msg.text());
    } catch (_) {}
  });
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));

  console.log("[puppeteer-join] goto", JOIN_URL);
  await page.goto(JOIN_URL, { waitUntil: "networkidle2", timeout: 300000 });

  await page.waitForSelector("#join-webex", { timeout: 120000 });

  try {
    await page.waitForFunction(
      () => {
        var b = document.getElementById("join-webex");
        return b && b.hidden === false;
      },
      { timeout: 120000, polling: 250 }
    );
    console.log("[puppeteer-join] #join-webex visible — clicking");
  } catch (e) {
    console.log(
      "[puppeteer-join] button stayed hidden (autoplay may have started hv1) — still clicking if present:",
      e && e.message ? e.message : String(e)
    );
  }

  await page.evaluate(() => {
    var b = document.getElementById("join-webex");
    if (b) b.click();
  });

  await new Promise(function (r) {
    setTimeout(r, 5000);
  });
  console.log("[puppeteer-join] post-click wait done; holding browser until SIGTERM/SIGINT");

  await new Promise(function (resolve) {
    function shutdown() {
      resolve();
    }
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });

  await browser.close().catch(function () {});
  console.log("[puppeteer-join] browser closed");
}

main().catch(function (e) {
  console.error("[puppeteer-join] fatal:", e);
  process.exit(1);
});
