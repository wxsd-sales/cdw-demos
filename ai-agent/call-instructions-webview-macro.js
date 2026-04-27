/********************************************************
 * AI Agent kiosk — in-call instructions overlay (RoomOS macro)
 *
 * After the kiosk “Appointment Management” flow places a call (via xAPI
 * Dial), this macro shows a fullscreen WebView with your instructions image
 * (GitHub Pages). When the last active call ends, the overlay is cleared.
 *
 * Deploy: upload to the codec that runs the kiosk WebView, enable the macro.
 * Set config.instructionsUrl to the HTTPS URL of instructions.png (or a tiny
 * HTML page that shows it full-viewport).
 ********************************************************/

import xapi from "xapi";

const config = {
  /** Full HTTPS URL to instructions.png on GitHub Pages (edit for your site). */
  instructionsUrl:
    "https://wxsd-sales.github.io/cdw-demos/ai-agent/instructions.png",
  mode: "Fullscreen",
  target: "OSD",
  title: "Instructions",
  numberToWatch: ""
};

let overlayOpen = false;

xapi.Status.SystemUnit.State.NumberOfActiveCalls.on(processCallCount);

xapi.Status.SystemUnit.State.NumberOfActiveCalls.get()
  .then((n) => processCallCount(n))
  .catch((e) =>
    console.warn("call-instructions: initial call count failed:", e)
  );

function processCallCount(value) {
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return;
  if (n > 0) {
    xapi.Status.Call.get().then((call) => {
      call = JSON.parse(call);
      console.log(call);
      if(call && call.Direction == "Outgoing" && (call.CallbackNumber.indexOf(config.numberToWatch) >= 0 || call.DisplayName.indexOf(config.numberToWatch) >= 0) ){
        showInstructionsOverlay();
      } else {
        hideInstructionsOverlay();
      }
    })
  } else {
    hideInstructionsOverlay();
  }
}

function showInstructionsOverlay() {
  if (overlayOpen) return;
  overlayOpen = true;
  console.log(
    "call-instructions: opening overlay —",
    config.instructionsUrl
  );
  xapi.Command.UserInterface.WebView.Display({
    Mode: config.mode,
    Target: config.target,
    Title: config.title,
    Url: config.instructionsUrl,
  }).catch((e) => {
    overlayOpen = false;
    console.warn("call-instructions: WebView.Display failed:", e.message);
  });
}

function hideInstructionsOverlay() {
  if (!overlayOpen) return;
  overlayOpen = false;
  console.log("call-instructions: clearing overlay");
  xapi.Command.UserInterface.WebView.Clear().catch((e) =>
    console.warn("call-instructions: WebView.Clear failed:", e.message)
  );
}
