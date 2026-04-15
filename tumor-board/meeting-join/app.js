/**
 * Dual Vidcast → Webex join
 *
 * Intended to be served by meeting-join-server (Express). The playlist UUID lives
 * only in the server .env (VIDCAST_PLAYLIST_ID); the browser loads clips via
 * GET /api/first-two-videos (same origin).
 *
 * URL query parameters:
 *   token — Webex access token
 *   sip   — meeting destination for meetings.create
 *   autojoin=1 — skip the “Join Webex” tap when the hidden mic player cannot autoplay (may yield no mic).
 *
 * Flow (with token+sip): load clips and capture **before** join (Democast-style: capture then join),
 * then **start playback at t=0 only after joinWithMedia resolves** so the meeting does not miss
 * the opening seconds. When clip 1 fires `ended`, the client calls **meeting.leave()**.
 */
(function () {
  "use strict";

  function qs(name) {
    var u = new URLSearchParams(window.location.search);
    var v = u.get(name);
    return v == null ? "" : String(v).trim();
  }

  function log() {
    console.info.apply(console, ["[meeting-join]"].concat(Array.prototype.slice.call(arguments)));
  }

  function setBanner(text, kind) {
    var row = document.getElementById("banner-row");
    var msg = document.getElementById("banner-text");
    if (msg) msg.textContent = text || "";
    if (!row) return;
    row.className = "";
    if (kind === "err") row.classList.add("err");
    else if (kind === "ok") row.classList.add("ok");
  }

  function waitCanPlay(el) {
    return new Promise(function (resolve, reject) {
      if (!el) return reject(new Error("no video element"));
      if (el.readyState >= 3) return resolve();
      function done() {
        el.removeEventListener("canplay", onOk);
        el.removeEventListener("error", onErr);
        resolve();
      }
      function onOk() {
        done();
      }
      function onErr() {
        el.removeEventListener("canplay", onOk);
        el.removeEventListener("error", onErr);
        reject(new Error("video error"));
      }
      el.addEventListener("canplay", onOk, { once: true });
      el.addEventListener("error", onErr, { once: true });
    });
  }

  async function loadFirstTwoFromServer() {
    var r = await fetch("/api/first-two-videos", { credentials: "same-origin" });
    var body;
    try {
      body = await r.json();
    } catch (e) {
      throw new Error("Bad JSON from /api/first-two-videos");
    }
    if (!r.ok) {
      throw new Error(body.error || "Playlist API failed (" + r.status + ")");
    }
    if (!body.v1 || !body.v2) {
      throw new Error("Server response missing v1/v2");
    }
    log("clips:", body.label || "(no label)");
    return [body.v1, body.v2];
  }

  function isFirefox() {
    return /Firefox/i.test(navigator.userAgent || "");
  }

  function crossCaptureStream(el) {
    if (el && typeof el.mozCaptureStream === "function") {
      return el.mozCaptureStream();
    }
    if (!el || typeof el.captureStream !== "function") {
      throw new Error("captureStream not supported");
    }
    return el.captureStream();
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

  /**
   * Browsers often block unmuted hidden audio/video until a user gesture (Democast always joins
   * after a click). ?autojoin=1 skips the extra button and attempts join immediately.
   */
  async function ensureClip1MicSourcePlaying(v1) {
    var hv1 = document.getElementById("hv1");
    if (!hv1 || isFirefox()) return;

    hv1.muted = false;
    hv1.volume = 0.001;
    try {
      hv1.currentTime = v1.currentTime;
    } catch (e) {}
    await hv1.play().catch(function () {});

    if (!hv1.paused) {
      log("hv1 (clip-1 mic source) playing");
      return;
    }

    if (qs("autojoin") === "1") {
      log("hv1 still paused; ?autojoin=1 — continuing (mic may be silent until you interact)");
      return;
    }

    setBanner(
      "Tap “Join Webex” so the browser allows the hidden clip-1 player used for your microphone.",
      ""
    );
    var btn = document.getElementById("join-webex");
    if (btn) {
      btn.hidden = false;
      await new Promise(function (resolve) {
        btn.onclick = function () {
          btn.onclick = null;
          btn.hidden = true;
          resolve();
        };
      });
    }

    try {
      hv1.currentTime = v1.currentTime;
    } catch (e2) {}
    await hv1.play().catch(function () {});
    log("after gesture hv1 paused=", hv1.paused);
  }

  /**
   * After captureStream(), strip tracks Democast-style (media-manager.js captureMediaStreams).
   */
  function waitStreamActiveThen(stream, stripFn) {
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        try {
          stripFn();
        } catch (e) {
          log("strip after active:", e && e.message ? e.message : String(e));
        }
        resolve();
      }
      if (stream.active) {
        finish();
        return;
      }
      stream.addEventListener(
        "active",
        function onActive() {
          stream.removeEventListener("active", onActive);
          finish();
        },
        false
      );
      setTimeout(finish, 3500);
    });
  }

  /**
   * Clip 1 → camera (video) + microphone (audio). Clip 2 → share (video only).
   * Democast (non-Firefox): same MP4 on visible <video> + second hidden element, captureStream each,
   * strip audio from video capture and video from second capture (media-manager.js).
   * We use a hidden second <video> (hv1): muxed MP4 + autoplay policy behaves better than <audio>.
   * Firefox: single video captureStream + split (media-manager.js).
   */
  async function captureStreamsForJoin(v1, v2, clip1AudioEl) {
    if (!v1 || !v2) throw new Error("missing video elements");

    v1.volume = 0.001;
    if (clip1AudioEl) {
      clip1AudioEl.volume = 0.001;
    }

    var shareOnly = new MediaStream();
    crossCaptureStream(v2)
      .getVideoTracks()
      .forEach(function (t) {
        shareOnly.addTrack(t);
      });

    var cameraStream;
    var microphoneStream;
    var nAud;

    if (!isFirefox() && clip1AudioEl && typeof clip1AudioEl.captureStream === "function") {
      var mainVideoStream = crossCaptureStream(v1);
      var mainAudioStream = crossCaptureStream(clip1AudioEl);
      await Promise.all([
        waitStreamActiveThen(mainVideoStream, function () {
          mainVideoStream.getAudioTracks().forEach(function (t) {
            mainVideoStream.removeTrack(t);
          });
        }),
        waitStreamActiveThen(mainAudioStream, function () {
          mainAudioStream.getVideoTracks().forEach(function (t) {
            mainAudioStream.removeTrack(t);
          });
        }),
      ]);
      cameraStream = mainVideoStream;
      microphoneStream = mainAudioStream;
      nAud = microphoneStream.getAudioTracks().length;
      log(
        "clip1 Democast-style: camera v=", cameraStream.getVideoTracks().length,
        "mic a=", nAud
      );
    } else {
      var raw1 = crossCaptureStream(v1);
      var split1 = splitVideoAudioTracks(raw1);
      cameraStream = split1.video;
      microphoneStream = split1.audio;
      nAud = microphoneStream.getAudioTracks().length;
      log("clip1 Firefox/single-element: video=", cameraStream.getVideoTracks().length, "audio=", nAud);
    }

    return {
      camera: cameraStream,
      microphone: microphoneStream,
      shareVideo: shareOnly,
      hasMic: nAud > 0,
    };
  }

  function ensureAllTracksEnabled(mediaStream) {
    if (!mediaStream || typeof mediaStream.getTracks !== "function") return;
    mediaStream.getTracks().forEach(function (t) {
      t.enabled = true;
    });
  }

  /**
   * SDK often reports local camera as "muted" until client unmutes after join
   * (see also tumor-board ensureMediaPublished → unmuteVideo / unmuteAudio).
   */
  async function postJoinUnmuteLocalMedia(meeting, hasMic) {
    async function once(label) {
      if (typeof meeting.unmuteVideo === "function") {
        try {
          await meeting.unmuteVideo();
          log(label, "unmuteVideo OK");
        } catch (e) {
          log(label, "unmuteVideo:", e && e.message ? e.message : String(e));
        }
      }
      if (hasMic && typeof meeting.unmuteAudio === "function") {
        try {
          await meeting.unmuteAudio();
          log(label, "unmuteAudio OK");
        } catch (e) {
          log(label, "unmuteAudio:", e && e.message ? e.message : String(e));
        }
      }
    }
    await once("postJoin");
    await new Promise(function (r) {
      setTimeout(r, 750);
    });
    await once("postJoin+750ms");
  }

  async function postJoinUnmuteVideoOnly(meeting) {
    async function once(label) {
      if (typeof meeting.unmuteVideo === "function") {
        try {
          await meeting.unmuteVideo();
          log(label, "unmuteVideo OK");
        } catch (e) {
          log(label, "unmuteVideo:", e && e.message ? e.message : String(e));
        }
      }
    }
    await once("postJoinVideo");
    await new Promise(function (r) {
      setTimeout(r, 750);
    });
    await once("postJoinVideo+750ms");
  }

  async function postJoinUnmuteAudioOnly(meeting, hasMic) {
    async function once(label) {
      if (hasMic && typeof meeting.unmuteAudio === "function") {
        try {
          await meeting.unmuteAudio();
          log(label, "unmuteAudio OK");
        } catch (e) {
          log(label, "unmuteAudio:", e && e.message ? e.message : String(e));
        }
      }
    }
    await once("postJoinAudio");
    await new Promise(function (r) {
      setTimeout(r, 750);
    });
    await once("postJoinAudio+750ms");
  }

  /** After captureStream, keep clip-1 elements at t=0 so hv1 is not ahead of v1 when media attaches. */
  function pauseClipElementsAtZeroAfterCapture() {
    var v1 = document.getElementById("v1");
    var v2 = document.getElementById("v2");
    var hv1 = document.getElementById("hv1");
    var ff = isFirefox();
    try {
      if (v1) {
        v1.pause();
        v1.currentTime = 0;
      }
      if (v2) {
        v2.pause();
        v2.currentTime = 0;
      }
      if (hv1 && !ff) {
        hv1.pause();
        hv1.currentTime = 0;
      }
    } catch (e) {
      log("pauseClipElementsAtZeroAfterCapture:", e && e.message ? e.message : String(e));
    }
    log("clip elements paused at 0 after capture (mic timeline aligned)");
  }

  /**
   * joinWithMedia can leave one stream unpublished; Democast calls publishStreams when switching demos.
   */
  async function postJoinPublishStreams(meeting, localStreams, hasMic) {
    if (typeof meeting.publishStreams !== "function") return;
    var pub = {};
    if (localStreams.camera) pub.camera = localStreams.camera;
    if (hasMic && localStreams.microphone) pub.microphone = localStreams.microphone;
    if (localStreams.screenShare && localStreams.screenShare.video) {
      pub.screenShare = { video: localStreams.screenShare.video };
    }
    if (Object.keys(pub).length === 0) return;
    try {
      await meeting.publishStreams(pub);
      log("publishStreams OK:", Object.keys(pub).join(", "));
    } catch (e) {
      log("publishStreams:", e && e.message ? e.message : String(e));
    }
  }

  function attachLobbyRepublish(meeting, localStreams, hasMic) {
    if (!meeting || typeof meeting.on !== "function") return;
    var repub = function (why) {
      log("lobby event:", why, "— republish streams");
      void postJoinPublishStreams(meeting, localStreams, hasMic);
      void postJoinUnmuteLocalMedia(meeting, hasMic);
    };
    try {
      meeting.on("meeting:self:guestAdmitted", function () {
        repub("meeting:self:guestAdmitted");
      });
    } catch (e) {}
    try {
      meeting.on("meeting:guestAdmitted", function () {
        repub("meeting:guestAdmitted");
      });
    } catch (e2) {}
  }

  /**
   * Load sources and wait until media can play; **do not start playback** (Democast: capture / join
   * first, then handleAutoPlay-style play).
   */
  async function prepareMediaElements(url1, url2) {
    var v1 = document.getElementById("v1");
    var v2 = document.getElementById("v2");
    var hv1 = document.getElementById("hv1");
    var ff = isFirefox();

    v1.crossOrigin = "anonymous";
    v2.crossOrigin = "anonymous";
    v1.src = url1;
    v2.src = url2;
    if (hv1 && !ff) {
      hv1.crossOrigin = "anonymous";
      hv1.src = url1;
      hv1.loop = false;
    }

    v1.loop = false;
    v2.loop = true;

    v1.playsInline = true;
    v2.playsInline = true;
    v1.muted = true;
    v2.muted = true;
    v1.volume = 0.001;
    v2.volume = 0.001;

    if (hv1 && !ff) {
      hv1.muted = false;
      hv1.volume = 0.001;
      v1.addEventListener(
        "play",
        function () {
          try {
            hv1.currentTime = v1.currentTime;
          } catch (e) {}
          hv1.play().catch(function () {});
        },
        false
      );
    }

    var waits = [waitCanPlay(v1), waitCanPlay(v2)];
    if (hv1 && !ff && hv1.src) {
      waits.push(waitCanPlay(hv1));
    }
    await Promise.all(waits);
    try {
      v1.pause();
      v2.pause();
      v1.currentTime = 0;
      v2.currentTime = 0;
      if (hv1 && !ff) {
        hv1.pause();
        hv1.currentTime = 0;
      }
    } catch (e) {
      log("prepare pause/seek:", e && e.message ? e.message : String(e));
    }
    log(
      "media prepared (paused at 0)",
      v1.videoWidth + "x" + v1.videoHeight,
      v2.videoWidth + "x" + v2.videoHeight
    );
  }

  /** Start both clips from the beginning (call only after Webex join succeeds when using token+sip). */
  async function beginPlaybackFromStart() {
    var v1 = document.getElementById("v1");
    var v2 = document.getElementById("v2");
    var hv1 = document.getElementById("hv1");
    var ff = isFirefox();
    if (!v1 || !v2) return;
    try {
      v1.currentTime = 0;
      v2.currentTime = 0;
      if (hv1 && !ff) {
        hv1.currentTime = 0;
      }
    } catch (e) {
      log("beginPlayback seek:", e && e.message ? e.message : String(e));
    }
    await v1.play().catch(function () {});
    await v2.play().catch(function () {});
    if (hv1 && !ff) {
      try {
        hv1.currentTime = v1.currentTime;
      } catch (e2) {}
      await hv1.play().catch(function () {});
    }
    log("playback started from t=0");
  }

  function attachClip1EndedLeaveMeeting(meeting) {
    var v1 = document.getElementById("v1");
    if (!v1 || !meeting) return;
    v1.addEventListener(
      "ended",
      function onClip1Ended() {
        v1.removeEventListener("ended", onClip1Ended);
        log("clip 1 ended — leaving meeting");
        if (typeof meeting.leave === "function") {
          meeting.leave().catch(function (e) {
            log("meeting.leave:", e && e.message ? e.message : String(e));
          });
        }
      },
      false
    );
  }

  async function main() {
    var token = qs("token");
    var sip = qs("sip");

    setBanner("Loading playlist from server…", "");
    var v1url;
    var v2url;
    try {
      var pair = await loadFirstTwoFromServer();
      v1url = pair[0];
      v2url = pair[1];
    } catch (e) {
      console.error(e);
      setBanner(
        String(e.message || e) +
          " — Run meeting-join-server with .env VIDCAST_PLAYLIST_ID set.",
        "err"
      );
      return;
    }

    setBanner("Loading media…", "");
    try {
      await prepareMediaElements(v1url, v2url);
    } catch (e) {
      console.error(e);
      setBanner("Video failed: " + (e.message || String(e)), "err");
      return;
    }

    if (!token || !sip) {
      setBanner("Playing clips (no Webex). Add token= and sip= to join.", "ok");
      try {
        await beginPlaybackFromStart();
      } catch (e2) {
        console.error(e2);
      }
      return;
    }

    if (typeof Webex === "undefined") {
      setBanner("Webex SDK not loaded.", "err");
      return;
    }

    var v1 = document.getElementById("v1");
    var v2 = document.getElementById("v2");
    var hv1 = document.getElementById("hv1");

    await ensureClip1MicSourcePlaying(v1);

    setBanner("Joining Webex (camera+mic = clip 1, share = clip 2)…", "");

    var caps;
    try {
      caps = await captureStreamsForJoin(v1, v2, hv1);
    } catch (e) {
      console.error(e);
      setBanner(
        "captureStream failed (often MP4 CORS): CDN must allow this page origin. " +
          (e.message || String(e)),
        "err"
      );
      return;
    }
    if (!caps.hasMic) {
      log("warning: no audio tracks from clip 1 — join continues without microphone (check file has audio, CORS, autoplay)");
    }

    pauseClipElementsAtZeroAfterCapture();

    var webex = Webex.init({
      credentials: { access_token: token },
      config: { logger: { level: "error" } },
    });

    await new Promise(function (resolve, reject) {
      webex.once("ready", resolve);
      setTimeout(function () {
        reject(new Error("Webex ready timeout"));
      }, 20000);
    });
    if (!webex.canAuthorize) {
      setBanner("Token rejected (canAuthorize false).", "err");
      return;
    }

    await webex.meetings.register();
    if (typeof webex.meetings.syncMeetings === "function") {
      await webex.meetings.syncMeetings().catch(function () {});
    }

    var m = webex.meetings;
    var meeting =
      typeof m.create === "function"
        ? await m.create(sip)
        : typeof m.createMeeting === "function"
          ? await m.createMeeting(sip)
          : null;
    if (!meeting) {
      setBanner("SDK missing meetings.create / createMeeting.", "err");
      return;
    }
    log("meetings.create OK, id=", meeting.id);

    var Helpers = webex.meetings.mediaHelpers;
    if (!Helpers || !Helpers.LocalCameraStream) {
      setBanner("mediaHelpers.LocalCameraStream missing.", "err");
      return;
    }

    if (typeof Helpers.LocalDisplayStream !== "function") {
      setBanner("SDK has no LocalDisplayStream — cannot publish video 2 as share.", "err");
      return;
    }

    /* Before wrapping in Local* streams so the SDK sees enabled tracks (Democast builds clean streams). */
    ensureAllTracksEnabled(caps.camera);
    ensureAllTracksEnabled(caps.microphone);
    ensureAllTracksEnabled(caps.shareVideo);

    var localStreams = {
      camera: new Helpers.LocalCameraStream(caps.camera),
    };

    if (caps.hasMic && typeof Helpers.LocalMicrophoneStream === "function") {
      localStreams.microphone = new Helpers.LocalMicrophoneStream(caps.microphone);
      log("localStreams.microphone from clip 1");
    }

    localStreams.screenShare = {
      video: new Helpers.LocalDisplayStream(caps.shareVideo),
    };

    var joinPayload = {
      joinOptions: {},
      mediaOptions: {
        allowMediaInLobby: true,
        audioEnabled: true,
        videoEnabled: true,
        shareAudioEnabled: false,
        shareVideoEnabled: true,
        localStreams: localStreams,
      },
    };

    try {
      if (typeof meeting.joinWithMedia === "function") {
        await meeting.joinWithMedia(joinPayload);
      } else {
        await meeting.join({});
        await meeting.addMedia({
          localStreams: localStreams,
          allowMediaInLobby: true,
          audioEnabled: true,
          videoEnabled: true,
          shareAudioEnabled: false,
          shareVideoEnabled: true,
        });
      }
    } catch (e) {
      console.error(e);
      setBanner("Join failed: " + (e.message || String(e)), "err");
      return;
    }

    attachClip1EndedLeaveMeeting(meeting);
    attachLobbyRepublish(meeting, localStreams, caps.hasMic);
    await postJoinPublishStreams(meeting, localStreams, caps.hasMic);
    /* Unmute video before local play; defer audio until after v1/hv1 play together so ~1s of mic
       is not sent ahead of camera (hv1 could advance during gesture before capture). */
    await postJoinUnmuteVideoOnly(meeting);

    setBanner("Joined — starting playback…", "ok");
    try {
      await beginPlaybackFromStart();
    } catch (ePlay) {
      console.error(ePlay);
      log("beginPlaybackFromStart:", ePlay && ePlay.message ? ePlay.message : String(ePlay));
    }

    await postJoinUnmuteAudioOnly(meeting, caps.hasMic);

    setBanner(
      "Live — camera + mic = clip 1" + (caps.hasMic ? "" : " (no mic track)") + ", share = clip 2. Clip 1 end → leave.",
      "ok"
    );
    log("done");
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
