# WatchTogether 🎬

A real-time watch party app with **screen sharing**, **YouTube sync**, **live chat**, and **emoji reactions**.

---

## Architecture

```
watchtogether/
├── server/      → Node.js + Socket.io  (deploy to Render)
└── client/      → Vite + vanilla JS    (deploy to Vercel)
```

---

## 🚀 Deploy in 10 minutes

### Step 1 — Deploy the Server to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your repo → select the **`server`** folder as root directory
4. Set these:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment variables:**
     - `CLIENT_URL` = your Vercel URL (add after Step 2, then redeploy)
     - `PORT` = `3001` (Render sets this automatically)
5. Deploy → copy the URL e.g. `https://watchtogether-server.onrender.com`

### Step 2 — Deploy the Client to Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project**
2. Connect your repo → set **root directory** to `client`
3. Set environment variable:
   - `VITE_SERVER_URL` = your Render server URL from Step 1
4. Deploy → done!

### Step 3 — Update CORS on Render

Go back to Render → your server service → Environment → set:
- `CLIENT_URL` = your Vercel URL (e.g. `https://watchtogether.vercel.app`)
Then **Manual Deploy → Deploy latest commit**.

---

## 🛠 Run locally

**Terminal 1 — Server:**
```bash
cd server
npm install
npm run dev
```

**Terminal 2 — Client:**
```bash
cd client
npm install
npm run dev
```

Open `http://localhost:5173`

---

## Features

| Feature | How it works |
|---|---|
| 🖥 Screen sharing | WebRTC `getDisplayMedia` — peer-to-peer, server just signals |
| 🎬 YouTube sync | YouTube IFrame API — host controls playback, synced to all |
| 💬 Live chat | Socket.io rooms — real-time messages |
| 🎉 Reactions | Floating emoji via Socket.io broadcast |
| 👥 Members list | Live presence with host badge |
| 🔗 Room codes | 6-char codes, share with friends |

---

## How to use

1. Open the app → enter your name → **Create a room**
2. Share the 6-character room code with friends
3. Friends enter the code → **Join room**
4. **Share screen:** Click "Share Screen" — everyone sees your screen live
5. **Watch YouTube:** Paste a YouTube URL → Load — synced for everyone
6. **Chat + React** in the sidebar

> **Tip:** The first person in the room is the Host. If they leave, the next person becomes host automatically.
