/********************************************************
 * Instant meeting + SIP log — RoomOS macro (standalone)
 *
 * One tap from the home screen (or control panel tile): Panel.Clicked runs the flow
 * immediately — no extension page to open first (same pattern as wxsd-sales dial-button-macro).
 * Webex instant meeting start, then poll xapi.Status.Call for CallbackNumber (sipFromCallbackNumber).
 *
 * Requires Webex / instant meeting on the codec.
 * CDW uses xapi.command('HttpClient Post', …) — ensure HttpClient is enabled and
 * https://cdw.wbx.ninja is allowed on the device if your firmware requires URL allowlisting.
 ********************************************************/

import xapi from "xapi";

const remoteUser = "";

const config = {
  panelId: "insiplog",
  button: {
    name: "Tumor Board",
    color: "#0B6E4F",
    //icon: "Video",
    icon: "Tv",
    showInCall: false,
  },
  /** Ignore Panel.Clicked for this long after macro load (avoids spurious run on enable). */
  ignorePanelClickMs: 2000,
  /** Wait after InstantMeeting.Start before first Status.Call read (ms). */
  delayAfterStartMs: 3500,
  /** Poll interval until CallbackNumber is usable (ms). */
  pollIntervalMs: 1500,
  /** Max poll attempts after the initial delay. */
  maxPollRetries: 12,
  logPrefix: "[instant-sip]",
  /** Logs full JSON for each poll row (your device log style). */
  logFullCall: true,
  /** CDW meeting-join server (POST JSON `{ command, sip? }`). */
  cdwCommandUrl: "https://cdw.wbx.ninja/command",
  /** HttpClient Post `Header` array entries (RoomOS expects "Name: value" strings). */
  cdwHttpHeaders: ["Content-Type: application/json"],
  /** Shown on device OSD (UserInterface Message Alert) after CDW start and participant add. */
  initializingAlertText: "Initializing. Please wait...",
  /** Alert `Duration` in seconds (see xCommand UserInterface Message Alert Display). */
  initializingAlertDuration: 15,
};

var macroLoadedAt = Date.now();
var runInFlight = false;

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

function log(msg, obj) {
  if (obj !== undefined) {
    try {
      console.log(config.logPrefix, msg, JSON.stringify(obj));
    } catch (_) {
      console.log(config.logPrefix, msg, String(obj));
    }
  } else {
    console.log(config.logPrefix, msg);
  }
}

function postCdwCommand(body) {
  var payload = JSON.stringify(body);
  log("CDW HttpClient Post body", payload);
  return xapi
    .command(
      "HttpClient Post",
      {
        Header: config.cdwHttpHeaders,
        Url: config.cdwCommandUrl
      },
      payload
    )
    .then(function (r) {
      if (r && r.StatusCode && String(r.StatusCode) !== "200") {
        log("CDW /command HTTP " + r.StatusCode, r.Body || "");
      }
    })
    .catch(function (e) {
      log(
        "CDW /command HttpClient Post error",
        e && e.message ? e.message : String(e)
      );
    });
}

function sipFromCallbackNumber(c) {
  if (!c || typeof c !== "object") return "";
  var cb = c.CallbackNumber;
  if (cb == null || cb === "") return "";
  var s = String(cb);
  if (s.indexOf("@") < 0) return "";
  s = s.replace("spark:","");
  return s;
}

function callsFromStatus(raw) {
  if (raw == null || raw === "") return [];
  return Array.isArray(raw) ? raw : [raw];
}

async function readCalls() {
  const raw = await xapi.Status.Call.get();
  return callsFromStatus(raw);
}

async function startInstantMeeting() {
  log("Webex.Meetings.InstantMeeting.Start …");
  await xapi.Command.Webex.Meetings.InstantMeeting.Start({});
  log("InstantMeeting.Start command returned OK");
}

async function pollAndLogSip() {
  await sleep(Math.max(0, config.delayAfterStartMs | 0));

  var interval = Math.max(500, config.pollIntervalMs | 0);
  var max = Math.max(1, config.maxPollRetries | 0);

  for (var attempt = 1; attempt <= max; attempt++) {
    var list = await readCalls();
    log("poll attempt " + attempt + "/" + max + ", call count=" + list.length);

    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (config.logFullCall && c && typeof c === "object") {
        log(JSON.stringify(c));
      }
      var sip = sipFromCallbackNumber(c);
      if (sip) {
        log("=== CallbackNumber (SIP / spark URI for Dial or SDK) ===");
        log(sip);
        log("=== end ===");
        await postCdwCommand({ command: "start", sip: sip, user: remoteUser });
        let res = await xapi.Status.Conference.Call.get();
        console.log(res);
        console.log(JSON.parse(res).id);
        await xapi.Command.Conference.Participant.Add({ CallId: JSON.parse(res).id, DisplayName: "Meeting Simulation", Number: remoteUser });
        
        return sip;
      }
    }

    if (attempt < max) await sleep(interval);
  }

  console.warn(
    config.logPrefix,
    "No CallbackNumber with @ after " +
      max +
      " attempts. Increase delays or check Status.Call."
  );
  return "";
}

async function run() {
  if (runInFlight) {
    log("run skipped (already in progress)");
    return;
  }
  runInFlight = true;
  try {
    await startInstantMeeting();
    try {
      await xapi.Command.UserInterface.Message.Alert.Display({
        Text: config.initializingAlertText,
        Duration: config.initializingAlertDuration,
      });
    } catch (e) {
      log(
        "UserInterface.Message.Alert.Display failed",
        e && e.message ? e.message : String(e)
      );
    }
    await pollAndLogSip();
  } catch (e) {
    console.warn(
      config.logPrefix,
      "run error:",
      e && e.message ? e.message : String(e)
    );
  } finally {
    runInFlight = false;
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function processPanelClicked(event) {
  if (!event || !event.PanelId) return;
  if (!String(event.PanelId).startsWith(config.panelId)) return;
  var elapsed = Date.now() - macroLoadedAt;
  if (elapsed < (config.ignorePanelClickMs | 0)) {
    log(
      "Panel.Clicked ignored (" +
        elapsed +
        "ms after macro load; spurious click on enable?)"
    );
    return;
  }
  log("Panel.Clicked — starting instant meeting (" + event.PanelId + ")");
  void run();
}

async function panelOrder(fullPanelId) {
  var list = await xapi.Command.UserInterface.Extensions.List({
    ActivityType: "Custom",
  });
  var panels = list && list.Extensions && list.Extensions.Panel;
  if (!panels || !panels.length) return -1;
  for (var i = 0; i < panels.length; i++) {
    if (panels[i].PanelId === fullPanelId) return panels[i].Order;
  }
  return -1;
}

async function savePanel(location) {
  var fullId = config.panelId + location;
  var orderXml = "";
  var orderNum = await panelOrder(fullId);
  if (orderNum !== -1) orderXml = "<Order>" + orderNum + "</Order>";

  /* Panel tile only (no Page): Panel.Clicked starts run — see dial-button-macro Panel.Save. */
  var panelXml =
    "<Extensions><Panel><Location>" +
    location +
    "</Location><Icon>" +
    config.button.icon +
    "</Icon><Color>" +
    config.button.color +
    "</Color><Name>" +
    escapeXml(config.button.name) +
    "</Name>" +
    orderXml +
    "<ActivityType>Custom</ActivityType>" +
    "</Panel></Extensions>";

  return xapi.Command.UserInterface.Extensions.Panel.Save(
    { PanelId: fullId },
    panelXml
  );
}

async function createPanels() {
  var loc = config.button.showInCall
    ? "HomeScreenAndCallControls"
    : "HomeScreen";
  await savePanel(loc);
  await savePanel("ControlPanel");
}

async function init() {
  macroLoadedAt = Date.now();
  await createPanels();
  xapi.Event.UserInterface.Extensions.Panel.Clicked.on(processPanelClicked);
  /* When the active call disconnects, tell CDW to stop Puppeteer. If this event
     is not available on your firmware, replace with the xAPI your CE docs use for “call ended”. */
  xapi.Event.CallDisconnect.on(function () {
    void postCdwCommand({ command: "end" });
  });
  log("macro ready — tap the Tumor Board tile (home or control panel) to start");
}

init().catch(function (e) {
  console.warn(
    config.logPrefix,
    "init failed:",
    e && e.message ? e.message : String(e)
  );
});
