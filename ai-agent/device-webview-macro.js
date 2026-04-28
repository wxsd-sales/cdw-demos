/********************************************************
 * AI Agent launcher macro for Cisco RoomOS.
 *
 * Home screen tile -> opens ai-agent/index.html immediately in OSD WebView.
 * No intermediate panel menu is shown; tap tile and the web app launches.
 *
 * The URL can include token/deviceId/number query params so the page can:
 *  - place calls (Dial API)
 *  - close itself (UserInterface.WebView.Clear API)
 *
 * IMPORTANT: keep secrets out of source control. Set token at deploy time.
 ********************************************************/

import xapi from "xapi";

const PANEL_LOCATION = "HomeScreen";

const config = {
  button: {
    name: "AI Agent",
    color: "#111111",
    icon: "Webex",
  },
  panelId: "ai_agent_launcher",
  hostedPageUrl: "https://wxsd-sales.github.io/cdw-demos/ai-agent/index.html",
  instructionsUrl: "https://wxsd-sales.github.io/cdw-demos/ai-agent/instructions.png",
  instructionsTitle: "Instructions",
  // Provide these at deployment time (do not commit secrets).
  botToken: "",
  deviceId: "",
  dialNumber: "1110",
  ignorePanelClickMs: 1500,
};

let macroLoadedAt = 0;
let openingWebview = false;
let overlayOpen = false;

xapi.Config.WebEngine.Mode.get()
  .then((mode) => init(mode))
  .catch((err) => console.warn("ai-agent-launcher: WebEngine unavailable:", JSON.stringify(err)));

async function init(webengineMode) {
  const ipv4 = await xapi.Status.Network[1].IPv4.Address.get();
  const ipv6 = await xapi.Status.Network[1].IPv6.Address.get();
  if (ipv4 === "" && ipv6 === "") {
    console.warn("ai-agent-launcher: no IP yet, retrying in 10s");
    setTimeout(() => init(webengineMode), 10_000);
    return;
  }

  if (webengineMode === "Off") {
    console.log("ai-agent-launcher: enabling WebEngine");
    await xapi.Config.WebEngine.Mode.set("On");
  }

  await xapi.Config.WebEngine.Features.AllowDeviceCertificate.set("True");
  await createPanel();

  macroLoadedAt = Date.now();
  xapi.Event.UserInterface.Extensions.Panel.Clicked.on(processPanelClicked);
  xapi.Status.SystemUnit.State.NumberOfActiveCalls.on(processCallCount);
  xapi.Status.SystemUnit.State.NumberOfActiveCalls.get()
    .then((n) => processCallCount(n))
    .catch((e) => console.warn("ai-agent-launcher: initial call count failed:", e));
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
  if (!panels || !panels.length) return -1;
  for (let i = 0; i < panels.length; i++) {
    if (panels[i].PanelId === fullPanelId) return panels[i].Order;
  }
  return -1;
}

async function createPanel() {
  const location = PANEL_LOCATION;
  const panelId = config.panelId + location;
  const orderNum = await panelOrder(panelId);
  const orderXml = orderNum !== -1 ? "<Order>" + orderNum + "</Order>" : "";

  const panelXml =
    "<Extensions><Panel>" +
    "<Location>" + location + "</Location>" +
    "<Icon>" + config.button.icon + "</Icon>" +
    "<Color>" + config.button.color + "</Color>" +
    "<Name>" + escapeXml(config.button.name) + "</Name>" +
    orderXml +
    "<ActivityType>Custom</ActivityType>" +
    "<Page><Name>Launch</Name><PageId>" + panelId + "-launch</PageId>" +
    "<Row><Widget><WidgetId>" + panelId + "-hint</WidgetId>" +
    "<Type>Text</Type><Options>size=2;fontSize=small;align=center</Options>" +
    "<Name>Tap the tile to open AI Agent</Name></Widget></Row>" +
    "<Options>hideRowNames=1</Options></Page>" +
    "</Panel></Extensions>";

  await xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: panelId }, panelXml);
}

function buildLaunchUrl() {
  let url = (config.hostedPageUrl || "").trim();
  if (!url) return "";

  const params = [];
  const dev = (config.deviceId || "").trim();
  const tok = (config.botToken || "").trim();
  const num = (config.dialNumber || "").trim();
  if (tok) params.push("token=" + encodeURIComponent(tok));
  if (dev) params.push("deviceId=" + encodeURIComponent(dev));
  if (num) params.push("number=" + encodeURIComponent(num));

  if (params.length) {
    url += (url.indexOf("?") === -1 ? "?" : "&") + params.join("&");
  }
  return url;
}

async function processPanelClicked(event) {
  if (!event || event.PanelId !== config.panelId + PANEL_LOCATION) return;
  const elapsed = Date.now() - macroLoadedAt;
  if (elapsed < (config.ignorePanelClickMs ?? 0)) return;
  if (openingWebview) return;

  const url = buildLaunchUrl();
  if (!url) {
    console.warn("ai-agent-launcher: hostedPageUrl is empty");
    return;
  }

  openingWebview = true;
  console.log("ai-agent-launcher: opening", url);

  try {
    await xapi.Command.UserInterface.WebView.Display({
      Mode: "Fullscreen",
      Target: "OSD",
      Title: "AI Agent",
      Url: url,
    });
    // Dismiss panel sheet so the launch feels direct.
    await xapi.Command.UserInterface.Extensions.Panel.Close();
  } catch (e) {
    console.warn("ai-agent-launcher: WebView.Display failed:", e.message);
  } finally {
    setTimeout(() => {
      openingWebview = false;
    }, 500);
  }
}

function includesWatchedNumber(call) {
  const needle = String(config.dialNumber || "").trim();
  if (!needle) return false;
  const callback = String(call?.CallbackNumber || "");
  const display = String(call?.DisplayName || "");
  const remote = String(call?.RemoteNumber || "");
  return callback.indexOf(needle) >= 0 || display.indexOf(needle) >= 0 || remote.indexOf(needle) >= 0;
}

async function getActiveCalls() {
  try {
    const raw = await xapi.Status.Call.get();
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed) return [];
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {
        return [];
      }
    }
    return [raw];
  } catch (e) {
    console.warn("ai-agent-launcher: Status.Call read failed:", e.message || e);
    return [];
  }
}

async function processCallCount(value) {
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return;
  if (n === 0) {
    hideInstructionsOverlay();
    return;
  }

  const calls = await getActiveCalls();
  const hasMatchingOutgoingCall = calls.some(
    (call) => String(call?.Direction || "") === "Outgoing" && includesWatchedNumber(call)
  );

  if (hasMatchingOutgoingCall) {
    showInstructionsOverlay();
  } else {
    hideInstructionsOverlay();
  }
}

function showInstructionsOverlay() {
  if (overlayOpen) return;
  overlayOpen = true;
  xapi.Command.UserInterface.WebView.Display({
    Mode: "Fullscreen",
    Target: "OSD",
    Title: config.instructionsTitle,
    Url: config.instructionsUrl,
  }).catch((e) => {
    overlayOpen = false;
    console.warn("ai-agent-launcher: instructions display failed:", e.message);
  });
}

function hideInstructionsOverlay() {
  if (!overlayOpen) return;
  overlayOpen = false;
  xapi.Command.UserInterface.WebView.Clear({ Target: "OSD" }).catch((e) =>
    console.warn("ai-agent-launcher: instructions clear failed:", e.message)
  );
}
