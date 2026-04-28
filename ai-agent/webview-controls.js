(function (window) {
  var WEBEX_API = "https://webexapis.com/v1";

  function getUrlCredentials() {
    var p = new URLSearchParams(window.location.search);
    return {
      deviceId: (p.get("deviceId") || "").trim(),
      token: (p.get("token") || p.get("webexToken") || "").trim(),
    };
  }

  async function clearWebViewsViaWebex() {
    var cred = getUrlCredentials();
    if (!cred.deviceId || !cred.token) {
      console.warn("Close: missing deviceId or token in page URL");
      return false;
    }

    var res = await fetch(WEBEX_API + "/xapi/command/UserInterface.WebView.Clear", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + cred.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deviceId: cred.deviceId,
        arguments: {
          Target: "OSD",
        },
      }),
    });

    if (!res.ok) {
      var errText = await res.text().catch(function () {
        return "";
      });
      console.warn("WebView.Clear xAPI failed:", res.status, errText);
      return false;
    }
    return true;
  }

  function bindCloseButton(buttonId) {
    var closeBtn = document.getElementById(buttonId);
    if (!closeBtn) return;

    closeBtn.addEventListener("click", function (e) {
      e.preventDefault();
      var cred = getUrlCredentials();
      if (cred.deviceId && cred.token) {
        clearWebViewsViaWebex().catch(function (err) {
          console.warn("Close WebView request error:", err);
        });
      } else {
        window.close();
      }
    });
  }

  function applyCurrentQueryToLink(linkId, fallbackPath) {
    var link = document.getElementById(linkId);
    if (!link) return;
    var q = window.location.search;
    link.href = (fallbackPath || link.getAttribute("href") || "") + (q || "");
  }

  window.AIAgentWebViewControls = {
    getUrlCredentials: getUrlCredentials,
    clearWebViewsViaWebex: clearWebViewsViaWebex,
    bindCloseButton: bindCloseButton,
    applyCurrentQueryToLink: applyCurrentQueryToLink,
  };
})(window);
