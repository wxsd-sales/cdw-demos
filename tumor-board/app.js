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
 *
 * Logging: open the page with ?log=2 (before the # hash) for verbose logs, or
 * ?debug=1 for log level 2 + Webex SDK internal debug. Default logs important
 * milestones at console.info with prefix [tumor-board].
 */
(function () {
  "use strict";

  var webex;

  /** 0=off, 1=important (default), 2=verbose. Override: ?log=2 on the page URL (before #). */
  function logLevel() {
    var m = /(?:^|[?&])log=(\d)(?:&|$)/.exec(location.search);
    if (m) return parseInt(m[1], 10) || 1;
    if (/[\?&]debug=1(?:&|$)/.test(location.search)) return 2;
    return 1;
  }

  function log() {
    if (logLevel() < 1) return;
    var a = ["[tumor-board]"].concat(Array.prototype.slice.call(arguments));
    console.info.apply(console, a);
  }

  function logVerbose() {
    if (logLevel() < 2) return;
    var a = ["[tumor-board][v]"].concat(Array.prototype.slice.call(arguments));
    console.info.apply(console, a);
  }

  function logSafeToken(prefix, token) {
    if (!token) {
      log(prefix, "token: (empty)");
      return;
    }
    log(prefix, "token: present, len=" + String(token).length);
  }

  function logVideoEl(tag, el) {
    if (!el) {
      logVerbose(tag, "no element");
      return;
    }
    logVerbose(tag, {
      readyState: el.readyState,
      paused: el.paused,
      muted: el.muted,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      currentTime: el.currentTime,
      crossOrigin: el.crossOrigin,
      error: el.error ? el.error.code + " " + el.error.message : null,
    });
  }

  function logMediaStream(tag, ms) {
    if (!ms) {
      logVerbose(tag, "no stream");
      return;
    }
    var vt = ms.getVideoTracks();
    var at = ms.getAudioTracks();
    logVerbose(tag, {
      videoTracks: vt.map(function (t) {
        return {
          id: t.id,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState,
          label: t.label,
        };
      }),
      audioTracks: at.map(function (t) {
        return {
          id: t.id,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState,
        };
      }),
    });
  }

  function logMeetingSurface(tag, meeting) {
    if (!meeting) {
      log(tag, "meeting: (null)");
      return;
    }
    try {
      var pick = {};
      [
        "id",
        "state",
        "meetingState",
        "inLobby",
        "isJoined",
        "joined",
        "partnerMeetingId",
        "sipUri",
        "meetingInfo",
      ].forEach(function (k) {
        try {
          if (meeting[k] === undefined) return;
          if (k === "meetingInfo" && meeting[k] && typeof meeting[k] === "object") {
            pick.meetingInfoKeys = Object.keys(meeting[k]).slice(0, 20).join(",");
            return;
          }
          pick[k] = meeting[k];
        } catch (_) {}
      });
      log(tag, "meeting snapshot:", JSON.stringify(pick));
    } catch (e) {
      log(tag, "meeting snapshot failed:", e.message || String(e));
    }
  }

  function attachMeetingDebugEvents(meeting) {
    if (!meeting || typeof meeting.on !== "function") {
      log("meeting.on not available — skipping event taps");
      return;
    }
    var names = [
      "error",
      "media:ready",
      "media:stopped",
      "meeting:self:guestAdmitted",
      "meeting:guestAdmitted",
      "meeting:stateChange",
      "lobby:guestAdmitted",
    ];
    names.forEach(function (ev) {
      try {
        meeting.on(ev, function (payload) {
          if (ev === "error") {
            log("meeting event: error", payload && payload.message ? payload.message : payload);
          } else {
            logVerbose("meeting event:", ev, payload);
          }
        });
      } catch (_) {
        /* unknown event name on this SDK build */
      }
    });
  }

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
    logVideoEl("v-screen after play", v1);
    logVideoEl("v-publish after play", v2);
  }

  async function ensureMediaPublished(meeting, localStreams, reason, opts) {
    opts = opts || {};
    var tryAddMedia = opts.tryAddMedia === true;
    log("ensureMediaPublished:", reason, "tryAddMedia=", tryAddMedia);
    logMeetingSurface("before " + reason, meeting);
    if (tryAddMedia && typeof meeting.addMedia === "function") {
      try {
        await meeting.addMedia({
          localStreams: localStreams,
          allowMediaInLobby: true,
        });
        log("addMedia OK:", reason);
      } catch (e) {
        log("addMedia failed:", reason, e && e.message ? e.message : String(e));
      }
    }
    if (typeof meeting.publishStreams === "function" && localStreams.camera) {
      try {
        await meeting.publishStreams({ camera: localStreams.camera });
        log("publishStreams(camera) OK:", reason);
      } catch (e) {
        log("publishStreams failed:", reason, e && e.message ? e.message : String(e));
      }
    }
    if (typeof meeting.unmuteVideo === "function") {
      try {
        await meeting.unmuteVideo();
        log("unmuteVideo OK:", reason);
      } catch (e) {
        log("unmuteVideo:", reason, e && e.message ? e.message : String(e));
      }
    }
    logMeetingSurface("after " + reason, meeting);
  }

  async function joinAndPublish(token, sip) {
    log("joinAndPublish start; sip len=", String(sip).length);
    logSafeToken("joinAndPublish", token);

    if (!token || !sip) {
      setBanner("No token or SIP — videos only. Add token + sip to #p payload.", "err");
      return;
    }
    if (typeof Webex === "undefined") {
      setBanner("Webex SDK not loaded.", "err");
      return;
    }

    setBanner("Signing in to Webex…", "");
    var wxLog = logLevel() >= 2 ? "debug" : "error";
    webex = Webex.init({
      credentials: { access_token: token },
      config: {
        logger: { level: wxLog },
      },
    });
    log("Webex.init logger level:", wxLog);

    log("waiting for webex ready…");
    await new Promise(function (resolve, reject) {
      webex.once("ready", resolve);
      setTimeout(function () {
        reject(new Error("Webex ready timeout"));
      }, 15000);
    });
    log("webex ready; canAuthorize=", webex.canAuthorize);

    if (!webex.canAuthorize) {
      setBanner("Token not accepted by Webex SDK (canAuthorize false).", "err");
      return;
    }

    log("meetings.register…");
    await webex.meetings.register();
    log("meetings.register OK");

    if (typeof webex.meetings.syncMeetings === "function") {
      log("syncMeetings…");
      await webex.meetings.syncMeetings().catch(function (e) {
        log("syncMeetings warn:", e && e.message ? e.message : String(e));
      });
    }

    setBanner("Creating / joining meeting…", "");
    var meeting;
    try {
      var m = webex.meetings;
      log("meetings.create destination type=", typeof sip);
      if (typeof m.create === "function") {
        meeting = await m.create(sip);
      } else if (typeof m.createMeeting === "function") {
        meeting = await m.createMeeting(sip);
      } else {
        setBanner("SDK has no meetings.create / createMeeting.", "err");
        return;
      }
      log("meetings.create OK, meeting id=", meeting && meeting.id);
      logMeetingSurface("after create", meeting);
    } catch (e) {
      console.error(e);
      log("meetings.create error:", e && e.message ? e.message : String(e));
      setBanner("meetings.create failed: " + (e.message || String(e)), "err");
      return;
    }

    var v2 = document.getElementById("v-publish");
    logVideoEl("v-publish before capture", v2);
    var rawStream;
    try {
      rawStream = captureStreamForVideo(v2);
    } catch (err) {
      console.error(err);
      log("captureStream error:", err && err.message ? err.message : String(err));
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
    logMediaStream("captureStream raw", rawStream);

    var split = splitVideoAudioTracks(rawStream);
    var camStream = split.video;
    var micStream = split.audio;
    logMediaStream("split.video (camera)", camStream);
    logMediaStream("split.audio (mic)", micStream);

    var sdkCameraStream = new webex.meetings.mediaHelpers.LocalCameraStream(camStream);
    var localStreams = { camera: sdkCameraStream };
    if (micStream.getAudioTracks().length > 0) {
      localStreams.microphone = new webex.meetings.mediaHelpers.LocalMicrophoneStream(
        micStream
      );
      log("localStreams: camera + microphone");
    } else {
      log("localStreams: camera only (no audio tracks on capture)");
    }

    attachMeetingDebugEvents(meeting);

    if (typeof meeting.on === "function") {
      try {
        meeting.on("meeting:self:guestAdmitted", function () {
          log("event meeting:self:guestAdmitted — addMedia after lobby");
          setBanner("Admitted from lobby — publishing video…", "ok");
          void ensureMediaPublished(meeting, localStreams, "guestAdmitted", {
            tryAddMedia: true,
          });
        });
      } catch (e) {
        log("could not bind meeting:self:guestAdmitted", e.message || String(e));
      }
      try {
        meeting.on("meeting:guestAdmitted", function () {
          log("event meeting:guestAdmitted — addMedia after lobby");
          void ensureMediaPublished(meeting, localStreams, "guestAdmittedAlt", {
            tryAddMedia: true,
          });
        });
      } catch (_) {}
    }

    /* SDK expects { joinOptions, mediaOptions } — not only mediaOptions at top level. */
    var joinWithMediaPayload = {
      joinOptions: {},
      mediaOptions: {
        allowMediaInLobby: true,
        localStreams: localStreams,
      },
    };
    logVerbose("joinWithMedia payload keys:", Object.keys(joinWithMediaPayload));
    log("joinWithMedia…");

    setBanner("Joining with media…", "");
    try {
      if (typeof meeting.joinWithMedia === "function") {
        await meeting.joinWithMedia(joinWithMediaPayload);
        log("joinWithMedia resolved");
      } else if (typeof meeting.join === "function") {
        log("fallback: join + addMedia");
        await meeting.join({});
        if (typeof meeting.addMedia === "function") {
          await meeting.addMedia({
            localStreams: localStreams,
            allowMediaInLobby: true,
          });
        }
      } else {
        setBanner("Meeting object has no joinWithMedia/join.", "err");
        return;
      }
    } catch (e) {
      console.error(e);
      log("join/joinWithMedia error:", e && e.message ? e.message : String(e));
      setBanner("Join failed: " + (e.message || String(e)), "err");
      return;
    }

    logMeetingSurface("after join/joinWithMedia", meeting);
    /* joinWithMedia already attached streams; avoid duplicate addMedia — only nudge publish/mute. */
    await ensureMediaPublished(meeting, localStreams, "postJoin", {
      tryAddMedia: false,
    });

    setBanner(
      "Joined — if remote video is black, check lobby admit, host policy, or add ?log=2 for details.",
      "ok"
    );
    log("joinAndPublish finished OK");
  }

  async function main() {
    log("main() start; page log level=", logLevel(), "search=", location.search);
    var payload = parsePayload();
    if (!payload) {
      setBanner('Missing #p= payload. Macro should open with hash (see tumor-board-macro.js).', "err");
      return;
    }
    log("payload keys:", Object.keys(payload).join(","));
    var v1 = payload.v1 || payload.l;
    var v2 = payload.v2 || payload.r;
    if (!v1 || !v2) {
      setBanner("Payload needs v1 and v2 (or l/r) MP4 URLs.", "err");
      return;
    }
    log("v1 MP4 len=", String(v1).length, "v2 MP4 len=", String(v2).length);

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
