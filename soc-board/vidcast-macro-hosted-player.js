/********************************************************
 * Vidcast playlist macro for Cisco RoomOS — hosted player only.
 *
 * Home screen: playlist → opens vidcast-player.html?src=… in WebView, then
 * dismisses the extensions sheet. All playback UI is in the HTML page.
 *
 * Optional config.deviceId + config.botToken are appended as query params so
 * the page can call Webex xAPI (same pattern as video-kiosk-app handleDial):
 * POST …/xapi/command/UserInterface.WebView.Clear with Bearer token (needs
 * spark:xapi_commands scope).
 ********************************************************/

import xapi from "xapi";

const config = {
  button: {
    name: "SOC Board",
    color: "#6F739E",
    icon: "Tv",
  },
  panelId: "vidcast_hp",
  playlistId: "",
  /** Webex bot / integration access token (sent as `token=` on player URL). */
  botToken: "",
  /** Webex workspace device id (sent as `deviceId=` on player URL). */
  deviceId: "",
  playlistPageSize: 50,
  /** Full HTTPS URL to vidcast-player.html (no query string). */
  hostedPlayerPageUrl: "https://wxsd-sales.github.io/cdw-demos/soc-board/vidcast-player.html",
  /** Fallback when a playlist item has no MP4 URL. */
  vidcastShareBase: "https://app.vidcast.io/share/",
  autoDeleteWebCache: true,
  hidePanelAfterStartingVideo: true,
};

const PANEL_LOCATION = "HomeScreen";

let openingWebview = false;
let videos = [];
let loading = true;
let lastOpenedUrl = "";
/** WebView id when our player last became Visible (for ghost cleanup). */
let lastWebViewId = null;

xapi.Config.WebEngine.Mode.get()
  .then((mode) => init(mode))
  .catch((err) => console.warn("WebEngine not available:", JSON.stringify(err)));

async function init(webengineMode) {
  const ipv4 = await xapi.Status.Network[1].IPv4.Address.get();
  const ipv6 = await xapi.Status.Network[1].IPv6.Address.get();
  if (ipv4 === "" && ipv6 === "") {
    console.warn("No IPv4 or IPv6 — retrying in 10s");
    setTimeout(() => init(webengineMode), 10_000);
    return;
  }

  if (webengineMode === "Off") {
    console.log("WebEngine Off — enabling On");
    xapi.Config.WebEngine.Mode.set("On");
  }

  xapi.Config.WebEngine.Features.AllowDeviceCertificate.set("True");
  xapi.Config.HttpClient.Mode.set("On");

  await createPanels();

  videos = await fetchAllPlaylistVideos(config.playlistId);
  console.log("Vidcast videos loaded:", videos.length);
  loading = false;

  await createPanels();

  xapi.Event.UserInterface.Extensions.Widget.Action.on(processWidget);
  xapi.Status.UserInterface.WebView.on(processWebViews);
}

async function fetchAllPlaylistVideos(playlistId) {
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
      if (r.StatusCode !== "200" || !r.Body) {
        console.warn("Playlist HTTP", r.StatusCode, url);
        break;
      }

      let data;
      try {
        data = JSON.parse(r.Body);
      } catch (e) {
        console.warn("Playlist JSON parse error", e);
        break;
      }

      const chunk = data.content || [];
      if (chunk.length === 0) break;

      for (const item of chunk) {
        const name = item.name || "Untitled";
        const shareId = item.share_id;
        const mp4 = item.camera_asset_url;
        if (!shareId) continue;
        out.push({ name, shareId, mp4 });
      }

      if (chunk.length < size) break;
      page += 1;
    }
  } catch (e) {
    console.warn("fetchAllPlaylistVideos:", e.message);
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function hostedBase() {
  return (config.hostedPlayerPageUrl || "").trim().replace(/\/$/, "");
}

function extractSrcParam(fullUrl) {
  const q = fullUrl.indexOf("?");
  if (q === -1) return null;
  const qs = fullUrl.slice(q + 1);
  const parts = qs.split("&");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    try {
      if (decodeURIComponent(p.slice(0, eq)) === "src") {
        return decodeURIComponent(p.slice(eq + 1));
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

function isOurPlayerPageUrl(u) {
  const base = hostedBase();
  if (!base || !u) return false;
  const cut = u.indexOf("?");
  return (cut === -1 ? u : u.slice(0, cut)) === base;
}

/** WebView URL for this playlist item (hosted page + signed MP4, or Vidcast share). */
function buildPlayerUrl(item) {
  if (!item) return "";
  const base = hostedBase();
  if (!base) {
    console.warn("hostedPlayerPageUrl is empty");
    return "";
  }
  const mp4 = item.mp4 || "";
  if (!mp4) return config.vidcastShareBase + item.shareId;
  let url = base + "?src=" + encodeURIComponent(mp4);
  const dev = (config.deviceId || "").trim();
  const tok = (config.botToken || "").trim();
  if (dev) url += "&deviceId=" + encodeURIComponent(dev);
  if (tok) url += "&token=" + encodeURIComponent(tok);
  return url;
}

function urlMatchesOurPlayer(url) {
  if (!url || !lastOpenedUrl) return false;
  if (url === lastOpenedUrl) return true;
  const a = extractSrcParam(lastOpenedUrl);
  const b = extractSrcParam(url);
  return Boolean(a && b && a === b && isOurPlayerPageUrl(lastOpenedUrl) && isOurPlayerPageUrl(url));
}

async function openWebview(item) {
  const url = buildPlayerUrl(item);
  if (!url) {
    console.warn("No playback URL for item", item?.name);
    return;
  }

  console.log("Opening WebView:", item.name);
  openingWebview = true;
  lastOpenedUrl = url;

  xapi.Command.UserInterface.WebView.Display({
    Title: item.name,
    Target: "OSD",
    Url: url,
  })
    .then(() => console.log("WebView.Display OK"))
    .catch((e) => console.warn("WebView.Display error:", e.message));

  setTimeout(() => {
    openingWebview = false;
  }, 500);
}

async function closeWebview() {
  console.log("Closing WebView");
  lastOpenedUrl = "";
  lastWebViewId = null;
  xapi.Command.UserInterface.WebView.Clear({ Target: "OSD" })
    .then(() => {
      if (config.autoDeleteWebCache) {
        xapi.Command.WebEngine.DeleteStorage({ Type: "WebApps" });
      }
    })
    .catch((e) => console.warn("WebView.Clear:", e.message));
}

async function processWidget({ WidgetId, Type }) {
  if (!WidgetId.startsWith(config.panelId + PANEL_LOCATION)) return;

  const parts = WidgetId.split("-");
  const command = parts[parts.length - 2];
  const option = parts[parts.length - 1];

  if (command === "selection" && Type === "clicked") {
    const idx = parseInt(option, 10);
    if (Number.isNaN(idx)) return;
    await openWebview(videos[idx]);
    await createPanels();
    if (config.hidePanelAfterStartingVideo) {
      await hideVidcastPanels();
    }
  }
}

async function processWebViews({ Status, URL, ghost, id }) {
  if (Status && URL) {
    if (Status !== "Visible") return;
    if (!openingWebview) return;
    if (!urlMatchesOurPlayer(URL)) return;
    console.log("WebView visible id=", id);
    lastWebViewId = id;
    createPanels();
  } else if (ghost && id != null && id === lastWebViewId) {
    lastWebViewId = null;
    lastOpenedUrl = "";
    setTimeout(createPanels, 300);
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function createPanels() {
  const button = config.button;
  const panelId = config.panelId;
  const location = PANEL_LOCATION;

  function widget(id, type, name, options) {
    return (
      "<Widget><WidgetId>" +
      panelId +
      location +
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

  let pageXml;
  if (loading) {
    pageXml =
      "<Page><Name>Loading</Name>" +
      row(
        widget(
          "loading-text",
          "Text",
          "Loading Vidcast playlist…",
          "size=3;fontSize=normal;align=center"
        )
      ) +
      "<PageId>" +
      panelId +
      location +
      "-channels</PageId>" +
      "<Options>hideRowNames=1</Options></Page>";
  } else if (!videos.length) {
    pageXml =
      "<Page><Name>Videos</Name>" +
      row(widget("no-content", "Text", "No videos in playlist", "size=4;fontSize=normal;align=center")) +
      "<PageId>" +
      panelId +
      location +
      "-channels</PageId>" +
      "<Options>hideRowNames=1</Options></Page>";
  } else {
    let rows = "";
    for (let i = 0; i < videos.length; i++) {
      rows += row(widget("selection-" + i, "Button", videos[i].name, "size=3"));
    }
    pageXml =
      "<Page><Name>Videos</Name>" +
      rows +
      "<PageId>" +
      panelId +
      location +
      "-channels</PageId>" +
      "<Options>hideRowNames=1</Options></Page>";
  }

  let orderXml = "";
  const orderNum = await panelOrder(panelId + location);
  if (orderNum !== -1) orderXml = "<Order>" + orderNum + "</Order>";

  const panelXml =
    "<Extensions><Panel><Location>" +
    location +
    "</Location><Icon>" +
    button.icon +
    "</Icon><Color>" +
    button.color +
    "</Color><Name>" +
    escapeXml(button.name) +
    "</Name>" +
    orderXml +
    "<ActivityType>Custom</ActivityType>" +
    pageXml +
    "</Panel></Extensions>";

  return xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: panelId + location }, panelXml);
}

async function panelOrder(fullPanelId) {
  const list = await xapi.Command.UserInterface.Extensions.List({
    ActivityType: "Custom",
  });
  const panels = list?.Extensions?.Panel;
  if (!panels || !panels.length) return -1;
  for (let i = 0; i < panels.length; i++) {
    if (panels[i].PanelId === fullPanelId) return panels[i].Order;
  }
  return -1;
}

async function hideVidcastPanels() {
  try {
    await xapi.Command.UserInterface.Extensions.Panel.Close();
  } catch (e) {
    console.warn("Panel.Close:", e.message);
  }
}
