# DCF CF Chat

> Real-time community chat overlay for [DegenCoinFlip](https://degencoinflip.com) visitors.
> **Not affiliated with DegenCoinFlip.** Does not interact with game mechanics, wallets, or transactions.

---

## 📦 Project Structure

```
dcf-cf-chat/
├── extension/               Chrome Extension (MV3)
│   ├── manifest.json
│   ├── background.js        Service worker
│   ├── content.js           Sidebar chat injection
│   ├── chat.css             Sidebar styles
│   ├── popup.html/css/js    Extension popup
│   ├── lib/
│   │   └── socket.io.min.js Socket.IO browser client
│   └── icons/               Extension icons (16/32/48/128px)
└── server/                  Node.js Backend
    ├── server.js            Express + Socket.IO
    ├── package.json
    ├── .env.example
    ├── Dockerfile
    └── docker-compose.yml
```

---

## 🔧 Prerequisites

- **Node.js** ≥ 18.x
- **npm** ≥ 8.x
- **Chrome** or Chromium-based browser
- A deployed backend URL (see deployment sections below)

---

## 🚀 Quick Start — Local Development

### 1. Start the Backend

```bash
cd server
npm install
cp .env.example .env
# Edit .env if needed (default PORT=3000)
npm run dev        # uses nodemon for hot-reload
# OR
npm start          # production mode
```

Server starts at → `http://localhost:3000`

Verify: `curl http://localhost:3000/health`

---

### 2. Configure the Extension

Open `extension/content.js` and update the `DEFAULT_SERVER` constant on line ~18:

```javascript
const DEFAULT_SERVER = 'http://localhost:3000'; // local dev
// OR after deploying:
const DEFAULT_SERVER = 'https://your-app.railway.app';
```

> You can also set this from the extension popup **Settings → Server URL** without editing code.

---

### 3. Load the Extension in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `extension/` folder
5. Navigate to `https://degencoinflip.com` — the chat sidebar appears automatically!

---

## ☁️ Deployment

### Deploy to Railway

Railway is the easiest option — zero config, free tier available.

1. Create a free account at [railway.app](https://railway.app)
2. Install Railway CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   ```
3. Deploy:
   ```bash
   cd server
   railway init          # create a new project
   railway up            # deploy
   ```
4. Get your URL:
   ```bash
   railway domain        # e.g. https://dcf-cf-chat-production.up.railway.app
   ```
5. Set environment variables in Railway Dashboard → Variables:
   ```
   NODE_ENV=production
   ALLOWED_ORIGINS=https://degencoinflip.com
   ```
6. Update `DEFAULT_SERVER` in `extension/content.js` with your Railway URL.

---

### Deploy to Render

1. Create a free account at [render.com](https://render.com)
2. Click **"New Web Service"**
3. Connect your GitHub repo (push the `server/` folder or full repo)
4. Configure:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Root Directory**: `server` (if deploying from monorepo)
5. Add environment variables:
   ```
   NODE_ENV=production
   PORT=10000
   ALLOWED_ORIGINS=https://degencoinflip.com
   ```
6. Render auto-assigns a URL like: `https://dcf-cf-chat.onrender.com`

> ⚠️ Free Render services **sleep after 15 min of inactivity**. Use a paid plan or Railway for always-on.

---

### Deploy with Docker

#### Build and run locally:
```bash
cd server
cp .env.example .env
docker-compose up --build -d
```

#### Build for production:
```bash
docker build -t dcf-cf-chat-server .
docker run -d \
  --name dcf-cf-chat \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e ALLOWED_ORIGINS=https://degencoinflip.com \
  dcf-cf-chat-server
```

#### Push to a registry (e.g. Docker Hub):
```bash
docker tag dcf-cf-chat-server yourusername/dcf-cf-chat:latest
docker push yourusername/dcf-cf-chat:latest
```

#### Deploy on VPS (Ubuntu):
```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Pull and run
docker pull yourusername/dcf-cf-chat:latest
docker run -d \
  -p 80:3000 \
  -e NODE_ENV=production \
  -e ALLOWED_ORIGINS=https://degencoinflip.com \
  --restart unless-stopped \
  yourusername/dcf-cf-chat:latest
```

---

## ⚙️ Configuration

### Backend Environment Variables

| Variable          | Default     | Description                              |
|-------------------|-------------|------------------------------------------|
| `PORT`            | `3000`      | Server port (Railway/Render auto-set)   |
| `NODE_ENV`        | `development` | Environment mode                       |
| `ALLOWED_ORIGINS` | *(open)*    | Comma-separated allowed CORS origins    |

### Extension Settings (via popup)

| Setting      | Description                                    |
|--------------|------------------------------------------------|
| Username     | Your display name (saved in Chrome Storage)   |
| Server URL   | Backend URL — set after deploying              |
| Notifications | Badge updates for new messages               |

---

## 🛡️ Security Features

| Feature                    | Implementation                         |
|----------------------------|----------------------------------------|
| Message cooldown           | 2-second per-socket cooldown           |
| Burst rate limiting        | Max 8 messages / 10 seconds            |
| Max message length         | 250 characters                         |
| HTML sanitization          | All text escaped on server             |
| Profanity filter           | Regex word-list replacement            |
| Duplicate detection        | Last-message comparison per socket     |
| Socket payload limit       | 100 KB max                             |
| Helmet.js                  | Security headers on all HTTP responses |
| Non-root Docker user       | Runs as uid 1001                       |

---

## 🎨 Customization

### Add Custom Profanity Words

In `server/server.js`, find `PROFANITY_WORDS` array and add entries:

```javascript
const PROFANITY_WORDS = [
  'fuck', 'shit', /* ... existing ... */,
  'yourword',   // ← add here
];
```

### Change the Chat Room

In `extension/content.js`:
```javascript
const ROOM = 'your-custom-room-name';
```

### Replace Icons

Replace the files in `extension/icons/` with your own 16×16, 32×32, 48×48, and 128×128 PNGs.

For best results, download the official logo from `https://iili.io/CnWb9e9.png` and resize.

---

## 🏗️ Architecture

```
[degencoinflip.com tab]
        │
  content.js (injected)
        │  Socket.IO WebSocket
        ▼
  [Backend Server]  ─── Socket.IO rooms ───  [Other users]
   Express + Node
```

- `background.js` — MV3 service worker; manages badge, relays messages between popup ↔ content
- `content.js` — All chat UI + socket logic; auto-reconnects
- `popup.js` — Shows status, settings panel; communicates via `chrome.tabs.sendMessage`
- `server.js` — Stateful Socket.IO server; rooms, history (in-memory), rate limiting

---

## 📋 Chrome Web Store Compliance

This extension:
- ✅ Only injects a community chat sidebar
- ✅ Does NOT read wallet addresses or private keys
- ✅ Does NOT access game outcomes or coinflip results
- ✅ Does NOT modify game functionality
- ✅ Does NOT make financial transactions
- ✅ Does NOT scrape private user data
- ✅ Discloses it is not affiliated with DegenCoinFlip

---

## 📄 License

MIT — See [LICENSE](LICENSE)

---

*DCF CF Chat is an independent community project and is NOT affiliated with, endorsed by, or connected to DegenCoinFlip or its operators.*
