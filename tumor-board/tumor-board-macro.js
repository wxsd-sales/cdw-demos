/********************************************************
 * Tumor board — RoomOS macro
 *
 * 1) Optionally starts a Webex instant meeting (xCommand).
 * 2) Fetches the same Vidcast playlist as vidcast-macro.js (sorted by name),
 *    takes the first two camera_asset_url values.
 * 3) Opens a hosted tumor-board/index.html with #p=<base64url JSON> carrying
 *    v1, v2, token, sip so the WebView can play clip A fullscreen, publish clip B
 *    into the meeting via Webex JS SDK (see tumor-board/app.js).
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
  /**
   * SIP / meeting destination for meetings.create (e.g. room’s instant meeting).
   * If empty, macro tries to read from Call status after InstantMeeting.Start.
   */
  meetingSip: "",
  startInstantMeeting: true,
  /** Wait before reading Call status for SIP (ms). */
  instantMeetingDelayMs: 3500,
  autoDeleteWebCache: true,
  closeContentWithPanel: false,
  debugVerbose: false,
};

let openingWebview = false;
let lastOpenedUrl = "";
let videos = [];
let loading = true;

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

async function tryInstantMeeting() {
  if (!config.startInstantMeeting) return;
  try {
    await xapi.Command.Webex.Meetings.InstantMeeting.Start({});
    console.log("[tumorbd] InstantMeeting.Start OK");
  } catch (e) {
    console.warn("[tumorbd] InstantMeeting.Start:", e.message || e);
  }
}

function normalizeCallEntry(c) {
  if (!c || typeof c !== "object") return "";
  return (
    c.CallbackAddress ||
    c.RemoteURI ||
    c.URI ||
    (c.Detail && (c.Detail.CallbackAddress || c.Detail.RemoteURI)) ||
    ""
  );
}

async function readSipFromActiveCall() {
  try {
    const raw = await xapi.Status.Call.get();
    const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    for (const c of list) {
      const uri = normalizeCallEntry(c);
      if (uri && String(uri).indexOf("@") >= 0) return String(uri);
    }
  } catch (e) {
    dbg("readSipFromActiveCall", e.message || String(e));
  }
  return "";
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

async function openTumorBoardWebView(title, url) {
  dbg("WebView URL length", String(url.length));
  openingWebview = true;
  lastOpenedUrl = url;
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

  let sip = (config.meetingSip || "").trim();

  if (config.startInstantMeeting) {
    await tryInstantMeeting();
    await sleep(config.instantMeetingDelayMs);
  }

  if (!sip) {
    sip = await readSipFromActiveCall();
  }
  if (!sip) {
    console.warn(
      "[tumorbd] No SIP — set config.meetingSip or fix Call status read after instant meeting"
    );
  }

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

  dbg("init", {
    playerPageUrl: config.playerPageUrl,
    hasToken: !!config.webexAccessToken,
    meetingSipSet: !!config.meetingSip,
  });
}

xapi.Config.WebEngine.Mode.get()
  .then((m) => init(m))
  .catch((e) => console.warn("[tumorbd] WebEngine:", JSON.stringify(e)));
