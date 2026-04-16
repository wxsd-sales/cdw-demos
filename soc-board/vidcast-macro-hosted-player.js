/********************************************************
 * Vidcast playlist macro (hosted HTML5 player variant) for Cisco RoomOS.
 *
 * Same UX as vidcast-macro.js, but default playback uses a small static page
 * (soc-board/vidcast-player.html) deployed to HTTPS — WebView opens that URL
 * with ?src=<encoded MP4> instead of a large data: URL. Reduces WebKit load.
 *
 * Deploy vidcast-player.html (e.g. GitHub Pages), set hostedPlayerPageUrl
 * below, and allowlist that origin on the codec WebEngine if required.
 *
 * If playlist fetch fails, allowlist Vidcast hosts for HttpClient on the device
 * (e.g. api.vidcast.io, app.vidcast.io, and CDN hostnames used for MP4s).
 ********************************************************/

import xapi from "xapi";

/* ========== Configuration (edit here) ========== */

const config = {
  /** Main panel tile on Home / Control Panel */
  button: {
    name: "SOC Board (hosted)",
    color: "#6F739E",
    icon: "Tv",
    showInCall: true,
  },
  /** Unique id prefix (differs from vidcast-macro.js so both can coexist) */
  panelId: "vidcast_hp",
  /** Public playlist UUID from Vidcast */
  playlistId: "",
  /** API page size (max items per request) */
  playlistPageSize: 50,
  /**
   * How to play video in WebView:
   * - "hosted":  Open hostedPlayerPageUrl?src=<encoded MP4> (see vidcast-player.html).
   * - "dataurl": Minimal HTML5 <video> in a data: URL (original behavior).
   * - "share":   https://app.vidcast.io/share/{shareId}
   * - "direct":  Open the signed MP4 URL directly in WebView.
   */
  playbackMode: "hosted",
  /**
   * Full HTTPS URL to deployed vidcast-player.html (no query string).
   * Example: https://your-org.github.io/cdw/soc-board/vidcast-player.html
   */
  hostedPlayerPageUrl: "https://wxsd-sales.github.io/cdw-demos/soc-board/vidcast-player.html",
  /** Base URL for share mode */
  vidcastShareBase: "https://app.vidcast.io/share/",
  /** Clear WebView storage when closing (matches IPTV default) */
  autoDeleteWebCache: true,
  /** Close WebView when panel closes and no separate controller (see IPTV) */
  closeContentWithPanel: false,
  /**
   * When true, logs when WebView status URLs do not match (after data: payload normalization).
   */
  debugLogWebViewMismatch: false,
};

/* ========== State ========== */

let openingWebview = false;
let integrationViews = [];
let panelOpen = false;
let videos = [];
let loading = true;
let selectedIndex = 0;
let syncUITimer = null;
/** URL we last opened; used to detect “our” WebView */
let lastOpenedUrl = "";
/** Location suffix when Controls was last opened (e.g. HomeScreen / ControlPanel); close uses same panel for Videos page. */
let lastControlsLocationSuffix = "HomeScreen";
/** Avoid re-entrant PageOpened → goToVideos loops. */
let syncingVideosFromPanelOpen = false;

/* ========== Bootstrap ========== */

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

  xapi.Event.UserInterface.Extensions.Event.PageOpened.on(processPageOpen);

  if (config.closeContentWithPanel) {
    xapi.Event.UserInterface.Extensions.Event.PageClosed.on(processPageClose);
  }

  xapi.Status.UserInterface.WebView.on(processWebViews);
  xapi.Status.Audio.VolumeMute.on(processVolumeMute);
  xapi.Status.Audio.Volume.on(processVolumeChange);

  xapi.Status.Conference.Call.Capabilities.Presentation.on(() => createPanels());

  xapi.Status.Conference.Presentation.LocalInstance.on(async ({ Source, ghost }) => {
    const open = await checkIfPlayerIsOpen();
    if (Source && Source === "1000" && open) return createPanels();
    if (ghost && open) return createPanels();
    if (ghost && !open) return createPanels();
  });
}

/* ========== Vidcast API ========== */

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

/* ========== Playback URL ========== */

function normalizeHostedBase() {
  let base = (config.hostedPlayerPageUrl || "").trim();
  base = base.replace(/\/$/, "");
  return base;
}

/** Decode `src` query parameter from a player URL (handles encoded & in value). */
function extractSrcQueryParam(fullUrl) {
  const q = fullUrl.indexOf("?");
  if (q === -1) return null;
  const qs = fullUrl.slice(q + 1);
  const parts = qs.split("&");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    let key;
    let val;
    try {
      key = decodeURIComponent(p.slice(0, eq));
      val = decodeURIComponent(p.slice(eq + 1));
    } catch (e) {
      continue;
    }
    if (key === "src") return val;
  }
  return null;
}

function isOurHostedPlayerPageUrl(fullUrl) {
  const base = normalizeHostedBase();
  if (!base || !fullUrl) return false;
  const cut = fullUrl.indexOf("?");
  const noQuery = cut === -1 ? fullUrl : fullUrl.slice(0, cut);
  return noQuery === base;
}

function buildPlaybackUrl(item) {
  if (!item) return "";

  if (config.playbackMode === "hosted") {
    const base = normalizeHostedBase();
    if (!base) {
      console.warn("hostedPlayerPageUrl is empty; set it or change playbackMode");
      return "";
    }
    const mp4 = item.mp4 || "";
    if (!mp4) {
      return config.vidcastShareBase + item.shareId;
    }
    return base + "?src=" + encodeURIComponent(mp4);
  }

  if (config.playbackMode === "share") {
    return config.vidcastShareBase + item.shareId;
  }

  if (config.playbackMode === "direct") {
    return item.mp4 || config.vidcastShareBase + item.shareId;
  }

  /* dataurl — wrap signed MP4 in a tiny page (no external host) */
  const src = item.mp4 || "";
  if (!src) {
    return config.vidcastShareBase + item.shareId;
  }

  const safeJsString = encodeURIComponent(src);
  const html =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>" +
    "<body style=\"margin:0;background:#000\">" +
    "<video id=\"v\" controls playsinline autoplay " +
    "style=\"width:100%;height:100vh;object-fit:contain\"></video>" +
    "<script>" +
    "(function(){var u=decodeURIComponent('" +
    safeJsString +
    "');var e=document.getElementById('v');if(e)e.src=u;})();" +
    "</script></body></html>";

  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

/**
 * RoomOS often normalizes data: URLs in status (e.g. %20 vs literal space) so the
 * string no longer matches what we passed to WebView.Display. Compare decoded HTML payload.
 */
function decodeDataUrlPayload(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  try {
    return decodeURIComponent(dataUrl.slice(comma + 1));
  } catch {
    return null;
  }
}

function urlMatchesOurPlayer(url) {
  if (!url || !lastOpenedUrl) return false;
  if (url === lastOpenedUrl) return true;

  if (config.playbackMode === "hosted") {
    const lastSrc = extractSrcQueryParam(lastOpenedUrl);
    const urlSrc = extractSrcQueryParam(url);
    if (lastSrc && urlSrc && lastSrc === urlSrc) {
      if (isOurHostedPlayerPageUrl(lastOpenedUrl) && isOurHostedPlayerPageUrl(url)) {
        return true;
      }
    }
    return false;
  }

  if (
    config.playbackMode === "dataurl" &&
    lastOpenedUrl.indexOf("data:text/html") === 0 &&
    url.indexOf("data:text/html") === 0
  ) {
    const a = decodeDataUrlPayload(lastOpenedUrl);
    const b = decodeDataUrlPayload(url);
    return a != null && b != null && a === b;
  }
  return false;
}

function urlPreview(u) {
  if (u == null || u === "") return { len: 0, head: "(empty)", tail: "" };
  return {
    len: u.length,
    head: u.slice(0, 120),
    tail: u.length > 120 ? u.slice(-80) : "",
  };
}

/* ========== WebView ========== */

async function openWebview(item) {
  const url = buildPlaybackUrl(item);
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
    .then(() => {
      console.log("WebView.Display OK");
      if (config.debugLogWebViewMismatch) {
        console.log(
          "[Vidcast] Stored lastOpenedUrl preview:",
          JSON.stringify(urlPreview(lastOpenedUrl))
        );
      }
    })
    .catch((e) => console.warn("WebView.Display error:", e.message));

  setTimeout(() => {
    openingWebview = false;
  }, 500);
}

async function closeWebview() {
  console.log("Closing WebView");
  lastOpenedUrl = "";
  xapi.Command.UserInterface.WebView.Clear({ Target: "OSD" })
    .then(() => {
      if (config.autoDeleteWebCache) {
        xapi.Command.WebEngine.DeleteStorage({ Type: "WebApps" });
      }
    })
    .catch((e) => console.warn("WebView.Clear:", e.message));
}

async function switchToVideo(index) {
  if (index < 0 || index >= videos.length) return;
  selectedIndex = index;
  const item = videos[selectedIndex];
  if (await checkIfPlayerIsOpen()) {
    await closeWebview();
    await new Promise((r) => setTimeout(r, 200));
  }
  await openWebview(item);
  await createPanels();
  processChannelChange();
}

/* ========== Widget events ========== */

async function processWidget({ WidgetId, Type, Value }) {
  if (!WidgetId.startsWith(config.panelId)) return;

  const parts = WidgetId.split("-");
  const idPrefix = parts[0];
  const command = parts[1];
  const option = parts[2];

  const playerOpen = await checkIfPlayerIsOpen();

  if (command === "selection" && Type === "clicked") {
    const idx = parseInt(option, 10);
    if (Number.isNaN(idx)) return;
    selectedIndex = idx;
    await openWebview(videos[idx]);
    await createPanels();
    const locationSuffix =
      idPrefix.length > config.panelId.length
        ? idPrefix.slice(config.panelId.length)
        : "HomeScreen";
    await goToControls(locationSuffix);
    return;
  }

  if (command === "close" && Type === "clicked") {
    await closeWebview();
    await createPanels();
    await goToVideos();
    return;
  }

  if (command === "presentation" && Type === "clicked") {
    const webViewId = await getWebViewId();
    if (!webViewId) {
      console.warn("Presentation: no WebView id");
      return;
    }
    const instance = await getWebViewPresentationInstance();
    if (instance) {
      await xapi.Command.Presentation.Stop({ PresentationSource: "WebView" });
      await xapi.Command.Presentation.Start({
        PresentationSource: "WebView",
        SendingMode: "LocalOnly",
        WebViewId: webViewId,
      });
    } else {
      await xapi.Command.Presentation.Start({
        PresentationSource: "WebView",
        SendingMode: "LocalRemote",
        WebViewId: webViewId,
      });
    }
    return;
  }

  if (command === "changechannel" && Type === "clicked") {
    if (!playerOpen) return;
    if (Value === "increment") {
      selectedIndex = selectedIndex >= videos.length - 1 ? 0 : selectedIndex + 1;
    } else if (Value === "decrement") {
      selectedIndex = selectedIndex <= 0 ? videos.length - 1 : selectedIndex - 1;
    } else {
      return;
    }
    await switchToVideo(selectedIndex);
    return;
  }

  if (command === "devicecontrols") {
    if (option === "togglemute" && Type === "clicked") {
      xapi.Command.Audio.Volume.ToggleMute();
    } else if (option === "volume" && Type === "released") {
      const level = Math.round((Value / 255) * 100);
      xapi.Command.Audio.Volume.Set({ Level: level });
    }
  }
}

function processVolumeChange(value) {
  const mapped = Math.round((value / 100) * 255);
  xapi.Command.UserInterface.Extensions.Widget.SetValue({
    Value: mapped,
    WidgetId: config.panelId + "-devicecontrols-volume",
  }).catch(() => {});
}

function processVolumeMute(state) {
  xapi.Command.UserInterface.Extensions.Widget.SetValue({
    Value: state === "On" ? "active" : "inactive",
    WidgetId: config.panelId + "-devicecontrols-togglemute",
  }).catch(() => {});
}

function processChannelChange() {
  const name = videos[selectedIndex]?.name ?? "";
  xapi.Command.UserInterface.Extensions.Widget.SetValue({
    Value: name,
    WidgetId: config.panelId + "-changechannel",
  }).catch(() => {});
}

async function processPageClose(event) {
  if (!config.closeContentWithPanel) return;
  if (!event.PageId.startsWith(config.panelId)) return;
  if (openingWebview) return;

  const controllers = await anyControllers();
  if (!controllers) return;
  panelOpen = false;

  const calls = await xapi.Status.SystemUnit.State.NumberOfActiveCalls.get();
  if (calls === 1) return;
  setTimeout(() => {
    if (!panelOpen) {
      closeWebview();
      createPanels();
    }
  }, 300);
}

async function processPageOpen(event) {
  if (!event.PageId.startsWith(config.panelId)) return;
  panelOpen = true;

  /* Persisted Controls page with no our WebView → show Videos (both panel instances). */
  if (!event.PageId.endsWith("-controls")) return;
  if (syncingVideosFromPanelOpen || openingWebview) return;

  const playerOpen = await checkIfPlayerIsOpen();
  if (playerOpen) return;

  syncingVideosFromPanelOpen = true;
  try {
    await goToVideos();
  } finally {
    syncingVideosFromPanelOpen = false;
  }
}

function syncUI() {
  xapi.Status.Audio.VolumeMute.get().then(processVolumeMute);
  xapi.Status.Audio.Volume.get().then(processVolumeChange);
  processChannelChange();
}

async function checkIfPlayerIsOpen() {
  const raw = await xapi.Status.UserInterface.WebView.get();
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    if (config.debugLogWebViewMismatch && lastOpenedUrl) {
      console.warn(
        "[Vidcast] checkIfPlayerIsOpen: no WebView entries but lastOpenedUrl is set",
        JSON.stringify(urlPreview(lastOpenedUrl))
      );
    }
    return false;
  }

  const match = list.some((w) => urlMatchesOurPlayer(w.URL));

  if (config.debugLogWebViewMismatch && lastOpenedUrl && !match) {
    console.warn(
      "[Vidcast] Player-open check failed: no WebView matched (string or data: payload)."
    );
    console.warn(
      "[Vidcast] Expected URL preview:",
      JSON.stringify(urlPreview(lastOpenedUrl))
    );
    list.forEach((w, i) => {
      const u = w.URL;
      const decA = decodeDataUrlPayload(lastOpenedUrl);
      const decB = decodeDataUrlPayload(u);
      console.warn(
        "[Vidcast] WebView[" + i + "]:",
        JSON.stringify({
          id: w.id,
          Status: w.Status,
          Type: w.Type,
          urlPreview: urlPreview(u),
          strictEqualToLastOpened: u === lastOpenedUrl,
          dataPayloadsEqual: decA != null && decB != null && decA === decB,
        })
      );
    });
  }

  return match;
}

async function getWebViewId() {
  const raw = await xapi.Status.UserInterface.WebView.get();
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const hit = list.find((w) => urlMatchesOurPlayer(w.URL));
  return hit?.id;
}

async function processWebViews({ Status, Type, URL, ghost, id }) {
  if (Status && URL) {
    if (Status !== "Visible") return;
    if (!openingWebview) return;
    if (!urlMatchesOurPlayer(URL)) return;
    console.log("WebView visible id=", id, "Type=", Type);
    integrationViews.push({ Status, Type, URL, id });
    createPanels();
  } else if (ghost) {
    const ix = integrationViews.findIndex((w) => w.id === id);
    if (ix === -1) return;
    integrationViews = [];
    lastOpenedUrl = "";
    setTimeout(createPanels, 300);
  }
}

async function presentationAvailable() {
  try {
    const v = await xapi.Status.Conference.Call.Capabilities.Presentation.get();
    return v === "True";
  } catch {
    return false;
  }
}

async function getWebViewPresentationInstance() {
  const presentations = await xapi.Status.Conference.Presentation.get();
  const local = presentations?.LocalInstance;
  if (!local) return undefined;
  const hit = local.filter(
    (inst) => inst.SendingMode === "LocalRemote" && inst.Source === "1000"
  );
  return hit?.[0]?.id;
}

/* ========== Panels (mirrors IPTV structure) ========== */

async function createPanels() {
  await createPanel(config.button.showInCall ? "HomeScreenAndCallControls" : "HomeScreen");
  await createPanel("ControlPanel");
  clearTimeout(syncUITimer);
  syncUITimer = setTimeout(syncUI, 500);
}

/** Same location suffixes as createPanels — used so both panels stay on the same page (Videos vs Controls). */
function vidcastPanelLocationSuffixes() {
  return [
    config.button.showInCall ? "HomeScreenAndCallControls" : "HomeScreen",
    "ControlPanel",
  ];
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function createPanel(location) {
  const button = config.button;
  const panelId = config.panelId;
  const playerOpen = await checkIfPlayerIsOpen();
  const canPresent = await presentationAvailable();
  const presenting = (await getWebViewPresentationInstance()) ? true : false;
  const state = loading ? "loading" : "ready";

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

  function createListPage() {
    let rows = "";
    if (!videos.length) {
      rows = row(
        widget(
          "no-content",
          "Text",
          loading ? "Loading playlist…" : "No videos in playlist",
          "size=4;fontSize=normal;align=center"
        )
      );
    } else {
      for (let i = 0; i < videos.length; i++) {
        rows += row(widget("selection-" + i, "Button", videos[i].name, "size=3"));
      }
    }
    return (
      "<Page><Name>Videos</Name>" +
      rows +
      "<PageId>" +
      panelId +
      location +
      "-channels</PageId>" +
      "<Options>hideRowNames=1</Options></Page>"
    );
  }

  function createControlsPage(visible, startPresentation, isPresenting) {
    let playerControls = row(
      "<Widget><WidgetId>" +
        panelId +
        "-player-not-visible</WidgetId>" +
        "<Name>Player closed — choose a video</Name>" +
        "<Type>Text</Type>" +
        "<Options>size=3;fontSize=normal;align=center</Options></Widget>"
    );
    let closeButton = "";
    let presentationButton = "";

    if (visible) {
      playerControls =
        "<Row><Widget><WidgetId>" +
        panelId +
        "-changechannel</WidgetId>" +
        "<Type>Spinner</Type>" +
        "<Options>size=3;style=vertical</Options></Widget></Row>" +
        "<Row><Widget><WidgetId>" +
        panelId +
        "-player-audio-text</WidgetId>" +
        "<Name>Volume</Name>" +
        "<Type>Text</Type>" +
        "<Options>size=3;fontSize=normal;align=center</Options></Widget></Row>" +
        "<Row><Widget><WidgetId>" +
        panelId +
        "-devicecontrols-togglemute</WidgetId>" +
        "<Type>Button</Type>" +
        "<Options>size=1;icon=volume_muted</Options></Widget>" +
        "<Widget><WidgetId>" +
        panelId +
        "-devicecontrols-volume</WidgetId>" +
        "<Type>Slider</Type>" +
        "<Options>size=3</Options></Widget></Row>";

      closeButton =
        "<Row><Widget><WidgetId>" +
        panelId +
        "-close</WidgetId>" +
        "<Name>Close content</Name>" +
        "<Type>Button</Type>" +
        "<Options>size=4</Options></Widget></Row>";
    }

    if (visible && startPresentation) {
      const label = isPresenting ? "Stop sharing" : "Share in call";
      presentationButton =
        "<Row><Widget><WidgetId>" +
        panelId +
        "-presentation</WidgetId>" +
        "<Name>" +
        escapeXml(label) +
        "</Name>" +
        "<Type>Button</Type>" +
        "<Options>size=4</Options></Widget></Row>";
    }

    return (
      "<Page><Name>Controls</Name>" +
      playerControls +
      closeButton +
      presentationButton +
      "<PageId>" +
      panelId +
      location +
      "-controls</PageId>" +
      "<Options>hideRowNames=1</Options></Page>"
    );
  }

  let channelsXml = "";
  let controlsXml = "";

  if (state === "loading") {
    channelsXml =
      "<Page><Name>Loading</Name><Row><Widget><WidgetId>" +
      panelId +
      "-loading-text</WidgetId>" +
      "<Name>Loading Vidcast playlist…</Name>" +
      "<Type>Text</Type>" +
      "<Options>size=3;fontSize=normal;align=center</Options></Widget></Row>" +
      "<PageId>" +
      panelId +
      "-channels</PageId>" +
      "<Options>hideRowNames=1</Options></Page>";
  } else {
    channelsXml = createListPage();
    controlsXml = createControlsPage(playerOpen, canPresent, presenting);
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
    channelsXml +
    controlsXml +
    "</Panel></Extensions>";

  return xapi.Command.UserInterface.Extensions.Panel.Save(
    { PanelId: panelId + location },
    panelXml
  );
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

async function anyControllers() {
  const peripherals = await xapi.Status.Peripherals.ConnectedDevice.get();
  const touchPanels = peripherals.filter((d) => d.Type === "TouchPanel");
  return touchPanels.length > 0;
}

async function goToControls(locationSuffix) {
  lastControlsLocationSuffix = locationSuffix;
  const suffixes = vidcastPanelLocationSuffixes();
  for (let i = 0; i < suffixes.length; i++) {
    const panelKey = config.panelId + suffixes[i];
    await xapi.Command.UserInterface.Extensions.Panel.Open({
      PageId: panelKey + "-controls",
      PanelId: panelKey,
    });
  }
}

/** Opens the Videos list page on every Vidcast panel instance (keeps Home vs Control Panel in sync). */
async function goToVideos() {
  const suffixes = vidcastPanelLocationSuffixes();
  for (let i = 0; i < suffixes.length; i++) {
    const panelKey = config.panelId + suffixes[i];
    await xapi.Command.UserInterface.Extensions.Panel.Open({
      PageId: panelKey + "-channels",
      PanelId: panelKey,
    });
  }
}
