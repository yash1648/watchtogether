const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || "*";

const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
  },
});

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

// In-memory room store
// rooms[code] = { code, host, createdAt, video: { type, url, ytId, playing, currentTime, updatedAt }, members: {} }
const rooms = {};

// Clean up stale rooms every 2 hours
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    if (now - rooms[code].createdAt > 7200000 && Object.keys(rooms[code].members).length === 0) {
      delete rooms[code];
    }
  }
}, 3600000);

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// REST: health check
app.get("/health", (req, res) => res.json({ ok: true }));

// REST: create room
app.post("/api/rooms", (req, res) => {
  let code = genCode();
  while (rooms[code]) code = genCode();
  rooms[code] = {
    code,
    host: null,
    createdAt: Date.now(),
    video: null,
    members: {},
  };
  res.json({ code });
});

// REST: check room exists
app.get("/api/rooms/:code", (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({ code: room.code, memberCount: Object.keys(room.members).length });
});

io.on("connection", (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // Join room
  socket.on("join-room", ({ code, username, color }, cb) => {
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room) return cb && cb({ error: "Room not found" });

    currentRoom = code;
    currentUser = { id: socket.id, username, color };

    // Set host if first
    if (!room.host || !room.members[room.host]) {
      room.host = socket.id;
    }

    room.members[socket.id] = { id: socket.id, username, color, joinedAt: Date.now() };
    socket.join(code);

    // Send current state to joiner
    cb &&
      cb({
        ok: true,
        isHost: room.host === socket.id,
        video: room.video,
        members: Object.values(room.members),
      });

    // Notify others
    socket.to(code).emit("user-joined", {
      user: room.members[socket.id],
      members: Object.values(room.members),
    });

    // Signal existing peers to initiate WebRTC with the new user
    const otherIds = Object.keys(room.members).filter((id) => id !== socket.id);
    otherIds.forEach((peerId) => {
      io.to(peerId).emit("peer-joined", { peerId: socket.id, username });
    });
  });

  // Chat message
  socket.on("chat-message", (msg) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const full = {
      ...msg,
      id: uuidv4(),
      senderId: socket.id,
      username: currentUser?.username,
      color: currentUser?.color,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    io.to(currentRoom).emit("chat-message", full);
  });

  // Reaction
  socket.on("reaction", ({ emoji }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit("reaction", {
      emoji,
      username: currentUser?.username,
      color: currentUser?.color,
      id: uuidv4(),
    });
  });

  // Video control (host only broadcast)
  socket.on("video-control", (data) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    room.video = { ...data, updatedAt: Date.now() };
    socket.to(currentRoom).emit("video-control", { ...data, fromHost: room.host === socket.id });
  });

  // Screen share started
  socket.on("screen-share-start", () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("screen-share-start", { sharerId: socket.id, username: currentUser?.username });
  });

  // Screen share stopped
  socket.on("screen-share-stop", () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("screen-share-stop", { sharerId: socket.id });
  });

  // WebRTC signaling
  socket.on("rtc-offer", ({ to, offer }) => {
    io.to(to).emit("rtc-offer", { from: socket.id, offer });
  });

  socket.on("rtc-answer", ({ to, answer }) => {
    io.to(to).emit("rtc-answer", { from: socket.id, answer });
  });

  socket.on("rtc-ice", ({ to, candidate }) => {
    io.to(to).emit("rtc-ice", { from: socket.id, candidate });
  });

  // Audio signaling
  socket.on("audio-offer", ({ to, offer }) => {
    io.to(to).emit("audio-offer", { from: socket.id, offer });
  });

  socket.on("audio-answer", ({ to, answer }) => {
    io.to(to).emit("audio-answer", { from: socket.id, answer });
  });

  socket.on("audio-ice", ({ to, candidate }) => {
    io.to(to).emit("audio-ice", { from: socket.id, candidate });
  });

  // Mic status toggle
  socket.on("mic-toggle", ({ enabled }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("mic-toggle", { userId: socket.id, username: currentUser?.username, enabled });
  });

  // Request sync (new joiner asks host for current time)
  socket.on("request-sync", () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || !room.host) return;
    io.to(room.host).emit("sync-request", { requesterId: socket.id });
  });

  socket.on("sync-response", ({ to, currentTime, playing }) => {
    io.to(to).emit("sync-response", { currentTime, playing });
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;

    delete room.members[socket.id];

    // Transfer host if needed
    if (room.host === socket.id) {
      const remaining = Object.keys(room.members);
      room.host = remaining.length > 0 ? remaining[0] : null;
      if (room.host) {
        io.to(room.host).emit("you-are-host");
      }
    }

    io.to(currentRoom).emit("user-left", {
      userId: socket.id,
      username: currentUser?.username,
      members: Object.values(room.members),
      newHost: room.host,
    });

    // Notify WebRTC peers
    socket.to(currentRoom).emit("peer-left", { peerId: socket.id });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`WatchTogether server running on port ${PORT}`));
