/********************************************************
 * Tumor board — RoomOS macro
 *
 * 1) Dials into the fixed meeting at config.meetingSip (xapi.Command.Dial).
 * 2) Fetches the same Vidcast playlist as vidcast-macro.js (sorted by name),
 *    takes the first two camera_asset_url values.
 * 3) Opens a hosted tumor-board/index.html with #p=<base64url JSON> carrying
 *    v1, v2, token, sip so the WebView can play clip A fullscreen, publish clip B
 *    into the meeting via Webex JS SDK (see tumor-board/app.js).
 * 4) If closeWebViewWhenCallEnds is true, clears the WebView when every call ends,
 *    but only if a live call was seen during this WebView session (avoids closing
 *    when the flow opened with no call).
 *
 * Edit config below. Allowlist api.vidcast.io + CDN for HttpClient; WebView needs
 * your GitHub Pages origin + jsdelivr (Webex SDK) + Vidcast MP4 hosts.
 ********************************************************/

import xapi from "xapi";

const config = {
  button: {
    name: "Tumor board",
    color: "#5B4A8A",
    icon: "Tv",
    showInCall: true,
  },
  panelId: "tumorbd",
  /** Published tumor-board/index.html (no trailing slash before #). */
  playerPageUrl:
    "https://wxsd-sales.github.io/cdw-demos/tumor-board/index.html",
  /** Same playlist as vidcast-macro.js */
  playlistId: "19aea050-4da1-4ed7-a4a1-84d64dd76b43",
  playlistPageSize: 50,
  /**
   * Webex REST access token for the identity that will join and publish
   * (paste short-lived token while testing — prefer a proper secrets flow later).
   */
  webexAccessToken: "",
  /** SIP / Webex address the codec dials before opening the WebView (see Dial.Number). */
  //meetingSip: "rtaylorhansoncdw@honor-health-ebc-sbx.webex.com",
  meetingSip: "rtaylorhansoncoe@coe-sbx.webex.com",
  /** If false, skip Dial (e.g. you are already in the meeting). */
  dialMeetingOnStart: true,
  /** Wait after Dial before opening the WebView so the call can connect (ms). */
  dialJoinDelayMs: 5000,
  autoDeleteWebCache: true,
  closeContentWithPanel: false,
  debugVerbose: false,
  /** When true, clear the tumor-board WebView after all calls end (device left meeting). */
  closeWebViewWhenCallEnds: true,
};

let openingWebview = false;
let lastOpenedUrl = "";
/** True once we have seen at least one live call while this WebView session is open. */
let hadCallWhileWebViewOpen = false;
let videos = [];
let loading = true;
let callEndDebounceTimer = null;

function dbg(tag, obj) {
  if (!config.debugVerbose) return;
  try {
    console.log(
      "[tumorbd] " + tag,
      typeof obj === "string" ? obj : JSON.stringify(obj)
    );
  } catch (_) {
    console.log("[tumorbd] " + tag);
  }
}

function utf8Bytes(str) {
  const a = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) a.push(c);
    else if (c < 0x800) {
      a.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      a.push(
        0xe0 | (c >> 12),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      );
    }
  }
  return a;
}

const B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64Url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPlaylistTwoMp4(playlistId) {
  const out = [];
  let page = 0;
  const size = config.playlistPageSize;
  try {
    while (true) {
      const url =
        "https://api.vidcast.io/v1/playlists/" +
        encodeURIComponent(playlistId) +
        "/videos?page=" +
        page +
        "&pageSize=" +
        size +
        "&skipUnavailable=false";
      const r = await xapi.Command.HttpClient.Get({ Url: url });
      if (r.StatusCode !== "200" || !r.Body) break;
      const data = JSON.parse(r.Body);
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
  } catch (e) {
    console.warn("[tumorbd] fetchPlaylist:", e.message);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function buildPayloadUrl(v1, v2, token, sip) {
  const base = config.playerPageUrl.trim().replace(/#.*$/, "");
  const payload = JSON.stringify({
    v1,
    v2,
    token: token || "",
    sip: sip || "",
  });
  return base + "#p=" + bytesToBase64Url(utf8Bytes(payload));
}

function dialNumberFromMeetingSip(sip) {
  const s = String(sip || "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  if (lower.indexOf("sip:") === 0 || lower.indexOf("h323:") === 0) return s;
  return "sip:" + s;
}

async function dialMeetingIfConfigured() {
  if (!config.dialMeetingOnStart) return true;
  const raw = (config.meetingSip || "").trim();
  if (!raw) {
    console.warn("[tumorbd] dialMeetingOnStart is true but meetingSip is empty");
    return false;
  }
  const number = dialNumberFromMeetingSip(raw);
  try {
    await xapi.Command.Dial({ Number: number });
    console.log("[tumorbd] Dial OK:", number);
    return true;
  } catch (e) {
    console.warn("[tumorbd] Dial:", e.message || e);
    return false;
  }
}

function urlMatchesPlayer(url) {
  if (!url || !lastOpenedUrl) return false;
  if (url === lastOpenedUrl) return true;
  try {
    const a = lastOpenedUrl.split("#")[0];
    const b = url.split("#")[0];
    return a.length > 0 && b.length > 0 && a.split("?")[0] === b.split("?")[0];
  } catch (_) {
    return false;
  }
}

function normalizeCalls(raw) {
  if (raw == null || raw === "") return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** Treat common in-call states as live; empty list or only disconnected = no call. */
function hasLiveCall(calls) {
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (!c || typeof c !== "object") continue;
    const st = String(c.Status || c.status || "").toLowerCase();
    if (
      st === "connected" ||
      st === "ringing" ||
      st === "proceeding" ||
      st === "dialing" ||
      st === "alerting" ||
      st === "onhold" ||
      st === "hold" ||
      st === "joining"
    ) {
      return true;
    }
  }
  return false;
}

async function refreshHadCallWhileWebViewOpen() {
  if (!lastOpenedUrl) return;
  try {
    const raw = await xapi.Status.Call.get();
    if (hasLiveCall(normalizeCalls(raw))) hadCallWhileWebViewOpen = true;
  } catch (_) {
    /* ignore */
  }
}

function scheduleCallEndCheck() {
  if (!config.closeWebViewWhenCallEnds) return;
  if (callEndDebounceTimer) clearTimeout(callEndDebounceTimer);
  callEndDebounceTimer = setTimeout(() => {
    callEndDebounceTimer = null;
    void maybeCloseWebViewAfterCallsEnded();
  }, 400);
}

async function maybeCloseWebViewAfterCallsEnded() {
  if (!lastOpenedUrl || openingWebview) return;
  if (!config.closeWebViewWhenCallEnds) return;
  try {
    const raw = await xapi.Status.Call.get();
    const calls = normalizeCalls(raw);
    const live = hasLiveCall(calls);
    if (live) {
      hadCallWhileWebViewOpen = true;
      return;
    }
    if (!hadCallWhileWebViewOpen) return;
    dbg("all calls ended — closing tumor board WebView");
    await closeWebView();
    createPanels();
  } catch (e) {
    dbg("maybeCloseWebViewAfterCallsEnded", e.message || String(e));
  }
}

async function openTumorBoardWebView(title, url) {
  dbg("WebView URL length", String(url.length));
  openingWebview = true;
  lastOpenedUrl = url;
  hadCallWhileWebViewOpen = false;
  await refreshHadCallWhileWebViewOpen();
  xapi.Command.UserInterface.WebView.Display({
    Title: title.slice(0, 200),
    Target: "OSD",
    Url: url,
  })
    .then(() => console.log("[tumorbd] WebView.Display OK"))
    .catch((e) => console.warn("[tumorbd] WebView.Display:", e.message));
  setTimeout(() => {
    openingWebview = false;
  }, 500);
}

async function closeWebView() {
  lastOpenedUrl = "";
  hadCallWhileWebViewOpen = false;
  xapi.Command.UserInterface.WebView.Clear({ Target: "OSD" })
    .then(() => {
      if (config.autoDeleteWebCache) {
        xapi.Command.WebEngine.DeleteStorage({ Type: "WebApps" });
      }
    })
    .catch((e) => console.warn("[tumorbd] WebView.Clear:", e.message));
}

async function checkPlayerOpen() {
  const raw = await xapi.Status.UserInterface.WebView.get();
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  return list.some((w) => urlMatchesPlayer(w.URL));
}

async function runStartFlow() {
  if (videos.length < 2 || !videos[0].mp4 || !videos[1].mp4) {
    console.warn("[tumorbd] Need 2 playlist items with camera_asset_url");
    return;
  }

  const sip = (config.meetingSip || "").trim();
  if (!sip) {
    console.warn("[tumorbd] meetingSip is empty — set config.meetingSip");
  }

  await dialMeetingIfConfigured();
  const delay = Math.max(0, Number(config.dialJoinDelayMs) || 0);
  if (delay > 0) await sleep(delay);

  const url = buildPayloadUrl(
    videos[0].mp4,
    videos[1].mp4,
    config.webexAccessToken,
    sip
  );

  const title = "Tumor: " + videos[0].name + " | " + videos[1].name;
  await openTumorBoardWebView(title, url);
  await createPanels();
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function panelOrder(fullPanelId) {
  const list = await xapi.Command.UserInterface.Extensions.List({
    ActivityType: "Custom",
  });
  const panels = list?.Extensions?.Panel;
  if (!panels?.length) return -1;
  for (let i = 0; i < panels.length; i++) {
    if (panels[i].PanelId === fullPanelId) return panels[i].Order;
  }
  return -1;
}

async function createPanel(location) {
  const panelId = config.panelId;
  const loc = location;
  const fullId = panelId + loc;
  const playerOpen = await checkPlayerOpen();
  const state = loading ? "loading" : "ready";

  function widget(id, type, name, options) {
    return (
      "<Widget><WidgetId>" +
      fullId +
      "-" +
      id +
      "</WidgetId><Name>" +
      escapeXml(name) +
      "</Name><Type>" +
      type +
      "</Type><Options>" +
      options +
      "</Options></Widget>"
    );
  }

  function row(inner) {
    return "<Row>" + inner + "</Row>";
  }

  let body = "";
  if (state === "loading") {
    body =
      "<Page><Name>Loading</Name>" +
      row(
        widget(
          "loadingtext",
          "Text",
          "Loading playlist…",
          "size=4;fontSize=normal;align=center"
        )
      ) +
      "<PageId>" +
      fullId +
      "-main</PageId><Options>hideRowNames=1</Options></Page>";
  } else if (videos.length < 2) {
    body =
      "<Page><Name>Tumor board</Name>" +
      row(
        widget(
          "needtwo",
          "Text",
          "Playlist needs 2+ videos with MP4 URLs.",
          "size=3;fontSize=normal;align=center"
        )
      ) +
      "<PageId>" +
      fullId +
      "-main</PageId><Options>hideRowNames=1</Options></Page>";
  } else {
    const sub =
      (playerOpen ? "WebView open — " : "") +
      videos[0].name +
      " + " +
      videos[1].name;
    body =
      "<Page><Name>Tumor board</Name>" +
      row(widget("start", "Button", "Start tumor board", "size=4")) +
      row(widget("close", "Button", "Close WebView", "size=3")) +
      row(
        widget(
          "subtext",
          "Text",
          sub,
          "size=2;fontSize=small;align=center"
        )
      ) +
      "<PageId>" +
      fullId +
      "-main</PageId><Options>hideRowNames=1</Options></Page>";
  }

  let orderXml = "";
  const orderNum = await panelOrder(fullId);
  if (orderNum !== -1) orderXml = "<Order>" + orderNum + "</Order>";

  const panelXml =
    "<Extensions><Panel><Location>" +
    loc +
    "</Location><Icon>" +
    config.button.icon +
    "</Icon><Color>" +
    config.button.color +
    "</Color><Name>" +
    escapeXml(config.button.name) +
    "</Name>" +
    orderXml +
    "<ActivityType>Custom</ActivityType>" +
    body +
    "</Panel></Extensions>";

  return xapi.Command.UserInterface.Extensions.Panel.Save(
    { PanelId: fullId },
    panelXml
  );
}

async function createPanels() {
  const loc = config.button.showInCall
    ? "HomeScreenAndCallControls"
    : "HomeScreen";
  await createPanel(loc);
  await createPanel("ControlPanel");
}

async function processWidget({ WidgetId, Type, Value }) {
  if (!WidgetId.startsWith(config.panelId)) return;
  if (Type !== "clicked") return;

  if (WidgetId.endsWith("-start")) {
    await runStartFlow();
    return;
  }
  if (WidgetId.endsWith("-close")) {
    await closeWebView();
    createPanels();
    return;
  }
}

async function init(webengineMode) {
  const ipv4 = await xapi.Status.Network[1].IPv4.Address.get();
  const ipv6 = await xapi.Status.Network[1].IPv6.Address.get();
  if (ipv4 === "" && ipv6 === "") {
    setTimeout(() => init(webengineMode), 10_000);
    return;
  }

  if (webengineMode === "Off") xapi.Config.WebEngine.Mode.set("On");
  xapi.Config.WebEngine.Features.AllowDeviceCertificate.set("True");
  xapi.Config.HttpClient.Mode.set("On");

  videos = await fetchPlaylistTwoMp4(config.playlistId);
  loading = false;
  console.log("[tumorbd] Playlist count:", videos.length);

  await createPanels();
  xapi.Event.UserInterface.Extensions.Widget.Action.on(processWidget);

  if (config.closeWebViewWhenCallEnds) {
    xapi.Status.Call.on(scheduleCallEndCheck);
    try {
      xapi.Event.CallDisconnect.on(scheduleCallEndCheck);
    } catch (_) {
      /* optional on older CE */
    }
  }

  dbg("init", {
    playerPageUrl: config.playerPageUrl,
    hasToken: !!config.webexAccessToken,
    meetingSipSet: !!config.meetingSip,
  });
}

xapi.Config.WebEngine.Mode.get()
  .then((m) => init(m))
  .catch((e) => console.warn("[tumorbd] WebEngine:", JSON.stringify(e)));
