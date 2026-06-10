import { io } from "socket.io-client";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

// ─── STATE ───────────────────────────────────────────────────────────────────
const state = {
  username: "",
  color: "",
  roomCode: "",
  isHost: false,
  socket: null,
  peers: {}, // peerId -> RTCPeerConnection
  localStream: null, // screen share stream
  isSharing: false,
  ytPlayer: null,
  ytReady: false,
  ytVideoId: null,
  members: [],
  micStream: null,
  micEnabled: false,
  audioPeers: {},
};

const COLORS = [
  "#7c6cf0","#3fd68c","#f0a83f","#f05c5c",
  "#4fc3f7","#ff80ab","#69f0ae","#ffd740",
  "#e040fb","#40c4ff",
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const nowTime = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function showToast(msg, color = "var(--green)") {
  const t = $("toast");
  t.textContent = msg;
  t.style.color = color;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function extractYtId(url) {
  url = url.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─── YOUTUBE API ─────────────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = () => {
  state.ytReady = true;
};

function loadYouTubeAPI() {
  if (document.getElementById("yt-api-script")) return;
  const s = document.createElement("script");
  s.id = "yt-api-script";
  s.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(s);
}

function initYTPlayer(videoId) {
  $("yt-wrap").classList.remove("hidden");
  $("stage-empty").classList.add("hidden");
  $("yt-controls").style.display = "flex";

  if (state.ytPlayer) {
    state.ytPlayer.loadVideoById(videoId);
    state.ytVideoId = videoId;
    return;
  }
  state.ytPlayer = new YT.Player("yt-frame", {
    videoId,
    playerVars: { autoplay: 1, controls: 1, rel: 0 },
    events: {
      onStateChange: (e) => {
        if (!state.isHost) return;
        const t = state.ytPlayer.getCurrentTime();
        if (e.data === YT.PlayerState.PLAYING) {
          state.socket.emit("video-control", { action: "play", currentTime: t, videoId: state.ytVideoId });
        } else if (e.data === YT.PlayerState.PAUSED) {
          state.socket.emit("video-control", { action: "pause", currentTime: t, videoId: state.ytVideoId });
        }
      },
    },
  });
  state.ytVideoId = videoId;
}

// ─── WEBRTC ───────────────────────────────────────────────────────────────────
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

async function createPeer(peerId, initiator) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peers[peerId] = pc;

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      state.socket.emit("rtc-ice", { to: peerId, candidate });
    }
  };

  pc.ontrack = (e) => {
    const video = $("screen-video");
    if (e.streams && e.streams[0]) {
      video.srcObject = e.streams[0];
      video.classList.remove("hidden");
      $("stage-empty").classList.add("hidden");
      $("yt-wrap").classList.add("hidden");
    }
  };

  pc.onconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
      pc.close();
      delete state.peers[peerId];
    }
  };

  // Add local stream tracks if sharing
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  }

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket.emit("rtc-offer", { to: peerId, offer });
  }

  return pc;
}

async function startScreenShare() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, displaySurface: "monitor" },
      audio: true,
    });
    state.localStream = stream;
    state.isSharing = true;

    // Show own preview
    const video = $("screen-video");
    video.srcObject = stream;
    video.muted = true;
    video.classList.remove("hidden");
    $("stage-empty").classList.add("hidden");
    $("yt-wrap").classList.add("hidden");
    $("sharer-label").textContent = `${state.username} (you) — sharing screen`;
    $("sharer-label").classList.remove("hidden");

    $("btn-screenshare").classList.add("hidden");
    $("btn-stop-share").classList.remove("hidden");

    // Notify server + create offers to all existing peers
    state.socket.emit("screen-share-start");
    for (const peerId of Object.keys(state.peers)) {
      // Close old peer, create fresh one with the stream
      state.peers[peerId]?.close();
      delete state.peers[peerId];
      await createPeer(peerId, true);
    }

    // Auto-stop when browser ends share
    stream.getVideoTracks()[0].onended = stopScreenShare;

    addMessage({ type: "system", text: `${state.username} started screen sharing` });
  } catch (e) {
    if (e.name !== "NotAllowedError") {
      showToast("Could not share screen", "var(--red)");
    }
  }
}

function stopScreenShare() {
  if (!state.isSharing) return;
  state.localStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.isSharing = false;

  $("screen-video").srcObject = null;
  $("screen-video").classList.add("hidden");
  $("sharer-label").classList.add("hidden");
  $("btn-screenshare").classList.remove("hidden");
  $("btn-stop-share").classList.add("hidden");

  // Close all peer connections (they'll reconnect without stream)
  for (const pc of Object.values(state.peers)) pc.close();
  state.peers = {};

  state.socket.emit("screen-share-stop");
  addMessage({ type: "system", text: `${state.username} stopped screen sharing` });

  // Show empty if no YT video either
  if (!state.ytVideoId) {
    $("stage-empty").classList.remove("hidden");
  }
}

// ─── AUDIO (VOICE CHAT) ─────────────────────────────────────────────────────
async function initMic(initiatePeers = false) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.micStream = stream;
    state.micEnabled = true;

    if (initiatePeers) {
      // Late mic enable — send offers to existing members
      for (const member of state.members) {
        if (member.id !== state.socket.id && !state.audioPeers[member.id]) {
          createAudioPeer(member.id, true);
        }
      }
    }
    // On initial join, we don't initiate — existing members receive
    // peer-joined and send audio-offers to us instead.

    updateMicUI();
  } catch (e) {
    console.warn("Mic access denied or unavailable:", e.message);
    state.micStream = null;
    state.micEnabled = false;
    updateMicUI();
  }
}

async function createAudioPeer(peerId, initiator) {
  // Close existing peer if any
  if (state.audioPeers[peerId]) {
    state.audioPeers[peerId].close();
    delete state.audioPeers[peerId];
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.audioPeers[peerId] = pc;

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      state.socket.emit("audio-ice", { to: peerId, candidate });
    }
  };

  pc.ontrack = (e) => {
    const audioId = `audio-${peerId}`;
    let audio = document.getElementById(audioId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = audioId;
      audio.autoplay = true;
      audio.style.display = "none";
      document.body.appendChild(audio);
    }
    if (e.streams && e.streams[0]) {
      audio.srcObject = e.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
      pc.close();
      delete state.audioPeers[peerId];
      const audioEl = document.getElementById(`audio-${peerId}`);
      if (audioEl) audioEl.remove();
    }
  };

  // Add local mic tracks
  if (state.micStream && state.micEnabled) {
    state.micStream.getTracks().forEach((t) => pc.addTrack(t, state.micStream));
  }

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket.emit("audio-offer", { to: peerId, offer });
  }

  return pc;
}

function closeAllAudioPeers() {
  for (const peerId of Object.keys(state.audioPeers)) {
    state.audioPeers[peerId]?.close();
    delete state.audioPeers[peerId];
    const audioEl = document.getElementById(`audio-${peerId}`);
    if (audioEl) audioEl.remove();
  }
}

function toggleMic() {
  if (!state.micStream) {
    // First-time mic access (late enable) — create audio peers to existing members
    initMic(true);
    return;
  }
  state.micEnabled = !state.micEnabled;
  state.micStream.getAudioTracks().forEach((t) => {
    t.enabled = state.micEnabled;
  });
  state.socket.emit("mic-toggle", { enabled: state.micEnabled });
  updateMicUI();
}

function updateMicUI() {
  const btn = $("btn-mic");
  const icon = document.getElementById("mic-icon");
  const label = document.getElementById("mic-label");
  if (state.micEnabled && state.micStream) {
    btn.classList.remove("muted");
    icon.innerHTML = `<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/>`;
    label.textContent = "Mic";
  } else {
    btn.classList.add("muted");
    icon.innerHTML = `<line x1="2" y1="2" x2="22" y2="22"/><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/>`;
    label.textContent = "Muted";
  }
}

// ─── MESSAGES ────────────────────────────────────────────────────────────────
function addMessage(msg) {
  const el = $("messages");
  const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 60;

  const div = document.createElement("div");
  div.className = "msg" + (msg.type === "system" ? " system" : msg.type === "reaction" ? " reaction-msg" : "");

  if (msg.type === "system") {
    div.innerHTML = `<div class="msg-body">${esc(msg.text)}</div>`;
  } else if (msg.type === "reaction") {
    div.innerHTML = `
      <div class="msg-hdr">
        <div class="msg-av" style="background:${esc(msg.color)}">${esc((msg.username||"?").slice(0,2).toUpperCase())}</div>
        <span class="msg-name" style="color:${esc(msg.color)}">${esc(msg.username)}</span>
      </div>
      <div class="msg-body">${esc(msg.emoji)}</div>`;
  } else {
    div.innerHTML = `
      <div class="msg-hdr">
        <div class="msg-av" style="background:${esc(msg.color)}">${esc((msg.username||"?").slice(0,2).toUpperCase())}</div>
        <span class="msg-name" style="color:${esc(msg.color)}">${esc(msg.username)}</span>
        <span class="msg-time">${esc(msg.time)}</span>
      </div>
      <div class="msg-body">${esc(msg.text)}</div>`;
  }

  el.appendChild(div);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function floatEmoji(emoji) {
  const zone = $("float-zone");
  const el = document.createElement("div");
  el.className = "float-emoji";
  el.textContent = emoji;
  el.style.bottom = Math.random() * 20 + "px";
  el.style.right = Math.random() * 60 + "px";
  zone.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ─── MEMBERS RENDER ──────────────────────────────────────────────────────────
function renderMembers(members) {
  state.members = members;
  $("viewer-count").textContent = members.length;
  const el = $("members-list");
  el.innerHTML = "";
  members.forEach((m) => {
    const isMe = m.id === state.socket.id;
    const isHost = m.id === state.roomHostId;
    el.innerHTML += `
      <div class="member-item">
        <div class="member-av" style="background:${esc(m.color)}">${esc(m.username.slice(0,2).toUpperCase())}</div>
        <div class="member-info">
          <div class="member-name">${esc(m.username)}${isMe ? " (you)" : ""}</div>
          <div class="member-role">${isHost ? "👑 Host" : "Viewer"}</div>
        </div>
        <div class="member-online"></div>
      </div>`;
  });
}
let state_roomHostId = null;
Object.defineProperty(state, 'roomHostId', {
  get: () => state_roomHostId,
  set: (v) => { state_roomHostId = v; }
});

// ─── SOCKET SETUP ────────────────────────────────────────────────────────────
function setupSocket() {
  const socket = io(SERVER_URL, { transports: ["websocket", "polling"] });
  state.socket = socket;

  socket.on("connect", () => console.log("Connected:", socket.id));

  socket.on("user-joined", ({ user, members }) => {
    addMessage({ type: "system", text: `${user.username} joined the room 👋` });
    renderMembers(members);
  });

  socket.on("user-left", ({ username, members, newHost }) => {
    addMessage({ type: "system", text: `${username} left the room` });
    state.roomHostId = newHost;
    renderMembers(members);
  });

  socket.on("you-are-host", () => {
    state.isHost = true;
    $("h-status").textContent = "You are now the host";
    setTimeout(() => ($("h-status").textContent = ""), 3000);
    showToast("You are now the host 👑");
  });

  // WebRTC: someone joined, I should initiate
  socket.on("peer-joined", async ({ peerId }) => {
    // Screen share
    if (state.isSharing) {
      await createPeer(peerId, true);
    }
    // Voice chat
    if (state.micStream && state.micEnabled) {
      await createAudioPeer(peerId, true);
    }
  });

  socket.on("peer-left", ({ peerId }) => {
    // Screen share cleanup
    state.peers[peerId]?.close();
    delete state.peers[peerId];
    const video = $("screen-video");
    if (video.srcObject) {
      const activeTracks = Array.from(video.srcObject.getTracks()).filter(t => t.readyState === "live");
      if (activeTracks.length === 0) {
        video.srcObject = null;
        video.classList.add("hidden");
        $("sharer-label").classList.add("hidden");
        if (!state.ytVideoId) $("stage-empty").classList.remove("hidden");
      }
    }
    // Audio peer cleanup
    state.audioPeers[peerId]?.close();
    delete state.audioPeers[peerId];
    const audioEl = document.getElementById(`audio-${peerId}`);
    if (audioEl) audioEl.remove();
  });

  // WebRTC signaling
  socket.on("rtc-offer", async ({ from, offer }) => {
    const pc = await createPeer(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("rtc-answer", { to: from, answer });
  });

  socket.on("rtc-answer", async ({ from, answer }) => {
    const pc = state.peers[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on("rtc-ice", async ({ from, candidate }) => {
    const pc = state.peers[from];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });

  // Audio signaling
  socket.on("audio-offer", async ({ from, offer }) => {
    if (!state.micStream) return;
    const pc = await createAudioPeer(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("audio-answer", { to: from, answer });
  });

  socket.on("audio-answer", async ({ from, answer }) => {
    const pc = state.audioPeers[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on("audio-ice", async ({ from, candidate }) => {
    const pc = state.audioPeers[from];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });

  // Mic status broadcast
  socket.on("mic-toggle", ({ userId, username, enabled }) => {
    if (enabled) {
      showToast(`${username} turned on mic`);
    } else {
      showToast(`${username} muted mic`);
    }
  });

  // Screen share notifications
  socket.on("screen-share-start", ({ username }) => {
    $("sharer-label").textContent = `${username} is sharing screen`;
    $("sharer-label").classList.remove("hidden");
    addMessage({ type: "system", text: `${username} started screen sharing` });
  });

  socket.on("screen-share-stop", ({ sharerId }) => {
    $("sharer-label").classList.add("hidden");
    // Clear video if it was from this peer
    const video = $("screen-video");
    video.srcObject = null;
    video.classList.add("hidden");
    if (!state.ytVideoId) $("stage-empty").classList.remove("hidden");
    addMessage({ type: "system", text: "Screen share ended" });
  });

  // Chat
  socket.on("chat-message", (msg) => {
    addMessage(msg);
  });

  // Reactions
  socket.on("reaction", (data) => {
    addMessage({ type: "reaction", ...data });
    floatEmoji(data.emoji);
  });

  // Video control sync
  socket.on("video-control", (data) => {
    if (!state.ytPlayer || !state.ytReady) return;
    if (data.videoId && data.videoId !== state.ytVideoId) {
      initYTPlayer(data.videoId);
    }
    if (data.action === "play") {
      if (Math.abs(state.ytPlayer.getCurrentTime() - data.currentTime) > 2) {
        state.ytPlayer.seekTo(data.currentTime, true);
      }
      state.ytPlayer.playVideo();
    } else if (data.action === "pause") {
      state.ytPlayer.seekTo(data.currentTime, true);
      state.ytPlayer.pauseVideo();
    } else if (data.action === "seek") {
      state.ytPlayer.seekTo(data.currentTime, true);
    }
  });

  // Sync request/response
  socket.on("sync-request", ({ requesterId }) => {
    if (!state.ytPlayer) return;
    socket.emit("sync-response", {
      to: requesterId,
      currentTime: state.ytPlayer.getCurrentTime(),
      playing: state.ytPlayer.getPlayerState() === YT.PlayerState.PLAYING,
    });
  });

  socket.on("sync-response", ({ currentTime, playing }) => {
    if (!state.ytPlayer) return;
    state.ytPlayer.seekTo(currentTime, true);
    if (playing) state.ytPlayer.playVideo();
    else state.ytPlayer.pauseVideo();
  });
}

// ─── ROOM ENTER/LEAVE ────────────────────────────────────────────────────────
function enterRoom(code, isHost, video, members) {
  state.roomCode = code;
  state.isHost = isHost;

  $("lobby").style.display = "none";
  $("room").classList.remove("hidden");
  $("hdr-code").textContent = code;
  $("hdr-code").onclick = () => {
    navigator.clipboard.writeText(code).then(() => showToast("Room code copied!"));
  };

  renderMembers(members || []);

  if (video) {
    loadYouTubeAPI();
    // Wait for YT API
    const tryInit = setInterval(() => {
      if (state.ytReady || window.YT?.Player) {
        clearInterval(tryInit);
        initYTPlayer(video.ytId || video.videoId);
      }
    }, 300);
  }

  addMessage({ type: "system", text: `You joined room ${code}` });
}

function leaveRoom() {
  stopScreenShare();
  for (const pc of Object.values(state.peers)) pc.close();
  state.peers = {};
  // Cleanup audio
  closeAllAudioPeers();
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
  }
  state.micEnabled = false;
  state.socket?.disconnect();
  state.socket = null;
  state.ytPlayer = null;
  state.ytVideoId = null;
  state.isHost = false;
  state.roomCode = "";
  state.isSharing = false;

  $("room").classList.add("hidden");
  $("lobby").style.display = "flex";
  $("messages").innerHTML = "";
  $("yt-controls").style.display = "none";
  $("yt-wrap").classList.add("hidden");
  $("screen-video").srcObject = null;
  $("screen-video").classList.add("hidden");
  $("stage-empty").classList.remove("hidden");
  $("sharer-label").classList.add("hidden");
  $("inp-yt").value = "";

  setupSocket();
}

// ─── EVENT LISTENERS ─────────────────────────────────────────────────────────
function setupUI() {
  // Lobby: create
  $("btn-create").onclick = async () => {
    const name = $("inp-name").value.trim();
    if (!name) { $("inp-name").focus(); return; }
    state.username = name;
    state.color = COLORS[Math.floor(Math.random() * COLORS.length)];
    $("lobby-err").textContent = "";

    try {
      const res = await fetch(`${SERVER_URL}/api/rooms`, { method: "POST" });
      const { code } = await res.json();
      state.socket.emit("join-room", { code, username: name, color: state.color }, (resp) => {
        if (resp?.error) { $("lobby-err").textContent = resp.error; return; }
        state.roomHostId = state.socket.id;
        enterRoom(code, true, null, resp.members);
        initMic();
      });
    } catch {
      $("lobby-err").textContent = "Could not connect to server. Is it running?";
    }
  };

  // Lobby: join
  $("btn-join").onclick = () => {
    const name = $("inp-name").value.trim();
    const code = $("inp-code").value.trim().toUpperCase();
    if (!name) { $("inp-name").focus(); return; }
    if (!code) { $("inp-code").focus(); return; }
    state.username = name;
    state.color = COLORS[Math.floor(Math.random() * COLORS.length)];
    $("lobby-err").textContent = "";

    state.socket.emit("join-room", { code, username: name, color: state.color }, (resp) => {
      if (resp?.error) { $("lobby-err").textContent = resp.error; return; }
      loadYouTubeAPI();
      enterRoom(code, resp.isHost, resp.video, resp.members);
      initMic();
      if (resp.video) {
        const trySync = setInterval(() => {
          if (state.ytReady) {
            clearInterval(trySync);
            state.socket.emit("request-sync");
          }
        }, 400);
      }
    });
  };

  $("inp-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-create").click();
  });
  $("inp-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-join").click();
    e.target.value = e.target.value.toUpperCase();
  });

  // Leave
  $("btn-leave").onclick = leaveRoom;

  // Mic toggle
  $("btn-mic").onclick = toggleMic;

  // Screen share
  $("btn-screenshare").onclick = startScreenShare;
  $("btn-stop-share").onclick = stopScreenShare;

  // YouTube load
  $("btn-load-yt").onclick = () => {
    const url = $("inp-yt").value.trim();
    const id = extractYtId(url);
    if (!id) { showToast("Enter a valid YouTube URL", "var(--red)"); return; }
    loadYouTubeAPI();

    $("yt-wrap").classList.remove("hidden");
    $("stage-empty").classList.add("hidden");
    $("yt-controls").style.display = "flex";

    const tryInit = setInterval(() => {
      if (state.ytReady || window.YT?.Player) {
        clearInterval(tryInit);
        state.ytVideoId = id;
        initYTPlayer(id);
        state.socket.emit("video-control", { action: "load", ytId: id, videoId: id });
        addMessage({ type: "system", text: `${state.username} loaded a YouTube video` });
      }
    }, 300);
    $("inp-yt").value = "";
  };
  $("inp-yt").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-load-yt").click();
  });

  // YT play/pause/sync
  $("btn-play").onclick = () => {
    state.ytPlayer?.playVideo();
    state.socket.emit("video-control", { action: "play", currentTime: state.ytPlayer?.getCurrentTime() || 0, videoId: state.ytVideoId });
  };
  $("btn-pause").onclick = () => {
    state.ytPlayer?.pauseVideo();
    state.socket.emit("video-control", { action: "pause", currentTime: state.ytPlayer?.getCurrentTime() || 0, videoId: state.ytVideoId });
  };
  $("btn-sync").onclick = () => {
    if (state.isHost) {
      const t = state.ytPlayer?.getCurrentTime() || 0;
      const playing = state.ytPlayer?.getPlayerState() === YT.PlayerState.PLAYING;
      state.socket.emit("video-control", { action: playing ? "play" : "pause", currentTime: t, videoId: state.ytVideoId });
      showToast("Synced everyone to your position");
    } else {
      state.socket.emit("request-sync");
      showToast("Syncing to host…");
    }
  };

  // Chat
  const sendChat = () => {
    const text = $("inp-chat").value.trim();
    if (!text) return;
    $("inp-chat").value = "";
    state.socket.emit("chat-message", { type: "chat", text });
  };
  $("btn-send").onclick = sendChat;
  $("inp-chat").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });

  // Reactions
  document.querySelectorAll(".r-btn").forEach((btn) => {
    btn.onclick = () => {
      const emoji = btn.dataset.e;
      state.socket.emit("reaction", { emoji });
      floatEmoji(emoji);
    };
  });

  // Tabs
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`panel-${tab.dataset.tab}`).classList.add("active");
    };
  });
}

// ─── BOOT ────────────────────────────────────────────────────────────────────
setupSocket();
setupUI();
