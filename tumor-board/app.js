/**
 * Tumor board: fullscreen video A on the WebView; video B captured and published
 * into a Webex meeting via the Meetings JS SDK (Democast-style).
 *
 * Payload in URL hash #p=<base64url UTF-8 JSON>:
 *   { "v1": "<mp4>", "v2": "<mp4>", "token": "<webex access token>", "sip": "<sip or meeting destination>" }
 * Any field may be omitted for partial testing (e.g. videos only without join).
 *
 * The publish element (#v-publish) uses crossOrigin="anonymous" before load so
 * captureStream() is allowed; the Vidcast CDN must send Access-Control-Allow-Origin
 * (e.g. * or your Pages host) on the MP4 response or capture will still fail.
 */
(function () {
  "use strict";

  var webex;

  function fromBase64Url(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    try {
      return decodeURIComponent(
        Array.prototype.map
          .call(atob(s), function (c) {
            return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join("")
      );
    } catch (e) {
      return null;
    }
  }

  function parsePayload() {
    var h = window.location.hash || "";
    if (h.indexOf("#p=") !== 0) return null;
    try {
      var raw = fromBase64Url(h.slice(3));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.error("[tumor-board] payload parse", err);
      return null;
    }
  }

  function setBanner(text, kind) {
    var el = document.getElementById("banner");
    if (!el) return;
    el.textContent = text || "";
    el.className = "banner";
    if (kind === "err") el.classList.add("banner-err");
    else if (kind === "ok") el.classList.add("banner-ok");
  }

  function splitVideoAudioTracks(mediaStream) {
    var vTracks = mediaStream.getVideoTracks();
    var aTracks = mediaStream.getAudioTracks();
    var vStream = new MediaStream();
    var aStream = new MediaStream();
    vTracks.forEach(function (t) {
      vStream.addTrack(t);
    });
    aTracks.forEach(function (t) {
      aStream.addTrack(t);
    });
    return { video: vStream, audio: aStream };
  }

  function captureStreamForVideo(el) {
    if (!el) return null;
    try {
      if (typeof el.captureStream === "function") return el.captureStream();
      if (typeof el.mozCaptureStream === "function") return el.mozCaptureStream();
    } catch (err) {
      console.error("[tumor-board] captureStream", err);
      throw err;
    }
    return null;
  }

  function waitCanPlay(el) {
    return new Promise(function (resolve, reject) {
      if (!el) {
        reject(new Error("no element"));
        return;
      }
      if (el.readyState >= 3) {
        resolve();
        return;
      }
      var done = function () {
        el.removeEventListener("canplay", onOk);
        el.removeEventListener("error", onErr);
        resolve();
      };
      var onOk = function () {
        done();
      };
      var onErr = function () {
        el.removeEventListener("canplay", onOk);
        el.removeEventListener("error", onErr);
        reject(new Error("video error"));
      };
      el.addEventListener("canplay", onOk, { once: true });
      el.addEventListener("error", onErr, { once: true });
    });
  }

  async function startVideos(v1src, v2src) {
    var v1 = document.getElementById("v-screen");
    var v2 = document.getElementById("v-publish");
    if (!v1 || !v2) throw new Error("missing video elements");
    v1.src = v1src;
    /* Required for captureStream(): CORS-enabled media. Set before src. */
    v2.crossOrigin = "anonymous";
    v2.src = v2src;
    v1.muted = true;
    v2.muted = true;
    v1.playsInline = true;
    v2.playsInline = true;
    await Promise.all([waitCanPlay(v1), waitCanPlay(v2)]);
    await v1.play().catch(function () {});
    await v2.play().catch(function () {});
  }

  async function joinAndPublish(token, sip) {
    if (!token || !sip) {
      setBanner("No token or SIP — videos only. Add token + sip to #p payload.", "err");
      return;
    }
    if (typeof Webex === "undefined") {
      setBanner("Webex SDK not loaded.", "err");
      return;
    }

    setBanner("Signing in to Webex…", "");
    webex = Webex.init({
      credentials: { access_token: token },
      config: {
        logger: { level: "error" },
      },
    });

    await new Promise(function (resolve, reject) {
      webex.once("ready", resolve);
      setTimeout(function () {
        reject(new Error("Webex ready timeout"));
      }, 15000);
    });

    if (!webex.canAuthorize) {
      setBanner("Token not accepted by Webex SDK (canAuthorize false).", "err");
      return;
    }

    await webex.meetings.register();

    if (typeof webex.meetings.syncMeetings === "function") {
      await webex.meetings.syncMeetings().catch(function () {});
    }

    setBanner("Creating / joining meeting…", "");
    var meeting;
    try {
      var m = webex.meetings;
      if (typeof m.create === "function") {
        meeting = await m.create(sip);
      } else if (typeof m.createMeeting === "function") {
        meeting = await m.createMeeting(sip);
      } else {
        setBanner("SDK has no meetings.create / createMeeting.", "err");
        return;
      }
    } catch (e) {
      console.error(e);
      setBanner("meetings.create failed: " + (e.message || String(e)), "err");
      return;
    }

    var v2 = document.getElementById("v-publish");
    var rawStream;
    try {
      rawStream = captureStreamForVideo(v2);
    } catch (err) {
      console.error(err);
      setBanner(
        "Cannot capture second video (CORS). MP4 host must allow this page with Access-Control-Allow-Origin, and #v-publish needs crossOrigin (already set). " +
          (err && err.message ? err.message : String(err)),
        "err"
      );
      return;
    }
    if (!rawStream) {
      setBanner("captureStream not supported on this browser.", "err");
      return;
    }
    var split = splitVideoAudioTracks(rawStream);
    var camStream = split.video;
    var micStream = split.audio;

    var sdkCameraStream = new webex.meetings.mediaHelpers.LocalCameraStream(camStream);
    var localStreams = { camera: sdkCameraStream };
    if (micStream.getAudioTracks().length > 0) {
      localStreams.microphone = new webex.meetings.mediaHelpers.LocalMicrophoneStream(
        micStream
      );
    }

    var meetingOptions = {
      mediaOptions: {
        allowMediaInLobby: true,
        shareAudioEnabled: false,
        shareVideoEnabled: true,
        localStreams: localStreams,
      },
    };

    setBanner("Joining with media…", "");
    try {
      if (typeof meeting.joinWithMedia === "function") {
        await meeting.joinWithMedia(meetingOptions);
      } else if (typeof meeting.join === "function") {
        await meeting.join();
        if (typeof meeting.addMedia === "function") {
          await meeting.addMedia({
            localStreams: localStreams,
            audioEnabled: !!localStreams.microphone,
            videoEnabled: true,
          });
        }
      } else {
        setBanner("Meeting object has no joinWithMedia/join.", "err");
        return;
      }
    } catch (e) {
      console.error(e);
      setBanner("Join failed: " + (e.message || String(e)), "err");
      return;
    }

    setBanner("Publishing second video into meeting.", "ok");
  }

  async function main() {
    var payload = parsePayload();
    if (!payload) {
      setBanner('Missing #p= payload. Macro should open with hash (see tumor-board-macro.js).', "err");
      return;
    }
    var v1 = payload.v1 || payload.l;
    var v2 = payload.v2 || payload.r;
    if (!v1 || !v2) {
      setBanner("Payload needs v1 and v2 (or l/r) MP4 URLs.", "err");
      return;
    }

    try {
      await startVideos(v1, v2);
    } catch (e) {
      console.error(e);
      setBanner("Video failed: " + (e.message || String(e)), "err");
      return;
    }

    setBanner("Videos playing. Starting Webex…", "ok");
    await joinAndPublish(payload.token || "", payload.sip || "");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      main().catch(function (e) {
        console.error(e);
        setBanner(String(e.message || e), "err");
      });
    });
  } else {
    main().catch(function (e) {
      console.error(e);
      setBanner(String(e.message || e), "err");
    });
  }
})();
