// DCF CF Chat — Backend Server
// Node.js + Express + Socket.io
// Real-time community chat for DegenCoinFlip visitors
'use strict';

const express     = require('express');
const http        = require('http');
const { Server }  = require('socket.io');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
require('dotenv').config();

// ================================================================
// CONFIG
// ================================================================
const PORT                = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV            = process.env.NODE_ENV || 'development';
const MAX_MSG_LENGTH      = 250;
const COOLDOWN_MS         = 2000;
const MAX_MSG_HISTORY     = 50;
const RATE_LIMIT_WINDOW   = 10_000; // 10 seconds
const RATE_LIMIT_MAX_MSGS = 8;       // max messages per window
const TYPING_CLEANUP_MS   = 6_000;
const CLEANUP_INTERVAL_MS = 60_000;

// ================================================================
// PROFANITY FILTER
// ================================================================
const PROFANITY_WORDS = [
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'cock', 'ass',
  'asshole', 'bastard', 'whore', 'slut', 'nigger', 'nigga', 'faggot',
  'retard', 'spic', 'kike', 'chink', 'wetback', 'fag',
];

const PROFANITY_REGEX = new RegExp(
  `\\b(${PROFANITY_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi'
);

function filterProfanity(text) {
  return text.replace(PROFANITY_REGEX, (match) => '*'.repeat(match.length));
}

// ================================================================
// HTML SANITIZER
// ================================================================
function sanitize(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// ================================================================
// ID GENERATOR
// ================================================================
function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ================================================================
// IN-MEMORY STATE
// ================================================================
// rooms[roomName] = { users: Map<socketId, UserObj>, messageCount }
const rooms = new Map();

// messageHistory is global (same lobby for everyone)
const messageHistory = [];

// rate limit map: socketId → { count, windowStart }
const rateLimitMap = new Map();

// typing cleanup timers: `${room}:${username}` → timer
const typingTimers = new Map();

function getOrCreateRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, { users: new Map(), messageCount: 0 });
  }
  return rooms.get(name);
}

// ================================================================
// RATE LIMITER
// ================================================================
function checkRateLimit(socketId) {
  const now = Date.now();
  let data = rateLimitMap.get(socketId);

  if (!data || now - data.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(socketId, { count: 1, windowStart: now, lastMsg: now });
    return { allowed: true, cooldown: false };
  }

  const timeSinceLast = now - data.lastMsg;

  // Per-message cooldown
  if (timeSinceLast < COOLDOWN_MS) {
    return { allowed: false, cooldown: true, retryIn: COOLDOWN_MS - timeSinceLast };
  }

  // Burst limit
  if (data.count >= RATE_LIMIT_MAX_MSGS) {
    return { allowed: false, cooldown: false, reason: 'Slow down — too many messages!' };
  }

  data.count++;
  data.lastMsg = now;
  return { allowed: true };
}

// ================================================================
// EXPRESS APP
// ================================================================
const app    = express();
const server = http.createServer(app);

// ── MIDDLEWARE ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

app.use(cors({
  origin: (origin, cb) => {
    // Allow: chrome extensions, any origin in dev, or explicit allow-list in prod
    if (
      !origin ||
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('moz-extension://') ||
      NODE_ENV !== 'production' ||
      (process.env.ALLOWED_ORIGINS || '').split(',').includes(origin)
    ) {
      cb(null, true);
    } else {
      cb(null, true); // Be permissive — adjust for prod if needed
    }
  },
  methods: ['GET', 'POST'],
  credentials: false,
}));

app.use(express.json({ limit: '20kb' }));

// ── ROUTES ──
app.get('/', (_req, res) => {
  const roomSummary = [];
  rooms.forEach((room, name) => {
    roomSummary.push({ room: name, online: room.users.size, messages: room.messageCount });
  });
  res.json({
    name: 'DCF CF Chat Server',
    version: '1.0.0',
    status: 'running',
    uptime: Math.floor(process.uptime()),
    env: NODE_ENV,
    rooms: roomSummary,
    totalConnections: [...rooms.values()].reduce((acc, r) => acc + r.users.size, 0),
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

app.get('/wallet/balance', async (_req, res) => {
  try {
    const sol = await fetchSolBalance();
    res.json({ sol, timestamp: Date.now(), address: HOUSE_WALLET, source: 'solana-rpc' });
  } catch (err) {
    // Fallback to last known snapshot
    const last = walletSnapshots[walletSnapshots.length - 1];
    if (last) {
      res.json({ sol: last.sol, timestamp: last.timestamp, address: HOUSE_WALLET, source: 'cache' });
    } else {
      res.status(503).json({ error: err.message });
    }
  }
});

app.get('/wallet/stats', (_req, res) => {
  const snaps = walletSnapshots;
  const current = snaps[snaps.length - 1] || null;
  const prev1h  = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const oldest  = snaps.length >= 1 ? snaps[0] : null;

  const sols = snaps.map(s => s.sol);
  res.json({
    address:    HOUSE_WALLET,
    solscanUrl: SOLSCAN_LINK,
    current:    current ? current.sol : null,
    prev1h:     prev1h  ? prev1h.sol  : null,
    oldest:     oldest  ? oldest.sol  : null,
    high:       sols.length ? Math.max(...sols) : null,
    low:        sols.length ? Math.min(...sols)  : null,
    avg:        sols.length ? sols.reduce((a, b) => a + b, 0) / sols.length : null,
    snapshots:  snaps,
    dataPoints: snaps.length,
    lastChecked: current ? current.timestamp : null,
  });
});

app.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30'), 50);
  res.json({ messages: messageHistory.slice(-limit) });
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ================================================================
// SOCKET.IO
// ================================================================
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60_000,
  pingInterval: 25_000,
  maxHttpBufferSize: 1e5, // 100 KB max payload
});

// ── CONNECTION ──
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  log('info', `Connected   ${socket.id} from ${ip}`);

  let currentRoom = null;
  let currentUser = null;
  let lastMsgText  = '';

  // ── JOIN ROOM ──
  socket.on('join', (payload) => {
    if (!payload || typeof payload !== 'object') return;

    let { room, username } = payload;

    // Validate
    if (!room || typeof room !== 'string') return;
    if (!username || typeof username !== 'string') return;

    room     = room.trim().slice(0, 50);
    username = sanitize(username.trim().slice(0, 24));

    if (!room || !username) return;

    // Leave previous room
    if (currentRoom) {
      leaveCurrentRoom(socket, currentRoom, currentUser);
    }

    // Join
    currentRoom = room;
    currentUser = username;
    socket.join(room);

    const roomData = getOrCreateRoom(room);
    roomData.users.set(socket.id, {
      username,
      joinedAt: Date.now(),
      socketId: socket.id,
    });

    log('info', `JOIN  ${username} → ${room} (${roomData.users.size} online)`);

    // Send back: room info + history
    socket.emit('room_joined', {
      room,
      username,
      onlineCount: roomData.users.size,
      history: messageHistory.slice(-MAX_MSG_HISTORY),
    });

    // Notify others
    socket.to(room).emit('user_joined', {
      username,
      onlineCount: roomData.users.size,
    });

    // Broadcast updated count
    io.to(room).emit('online_count', { count: roomData.users.size });
  });

  // ── MESSAGE ──
  socket.on('message', (payload) => {
    if (!currentRoom || !currentUser) return;
    if (!payload || typeof payload !== 'object') return;

    let { text } = payload;
    if (typeof text !== 'string') return;

    text = text.trim();
    if (!text || text.length === 0) return;
    if (text.length > MAX_MSG_LENGTH) {
      socket.emit('error', { message: `Message too long (max ${MAX_MSG_LENGTH} chars)` });
      return;
    }

    // ── COMMANDS ──
    if (text.toLowerCase() === '/house') {
      // Prevent spam — 30s cooldown on the command globally
      const now = Date.now();
      if (now - lastWalletCommandAt < 30_000) {
        const wait = Math.ceil((30_000 - (now - lastWalletCommandAt)) / 1000);
        socket.emit('error', { message: `Wallet command cooldown — wait ${wait}s` });
      } else {
        lastWalletCommandAt = now;
        log('info', `/house command used by ${currentUser}`);
        checkWallet(false);
      }
      return; // Never broadcast the command text
    }

    // Rate limit
    const rl = checkRateLimit(socket.id);
    if (!rl.allowed) {
      socket.emit('error', {
        message: rl.cooldown
          ? `Cooldown active — wait ${Math.ceil(rl.retryIn / 1000)}s`
          : (rl.reason || 'Slow down!'),
      });
      return;
    }

    // Duplicate message guard
    if (text === lastMsgText) {
      socket.emit('error', { message: 'Duplicate message detected' });
      return;
    }
    lastMsgText = text;

    // Sanitize + filter
    text = sanitize(text);
    text = filterProfanity(text);

    const msg = {
      id:        genId(),
      username:  currentUser,
      text,
      timestamp: Date.now(),
      reactions: {},
    };

    // Store
    messageHistory.push(msg);
    if (messageHistory.length > MAX_MSG_HISTORY) messageHistory.shift();

    const roomData = rooms.get(currentRoom);
    if (roomData) roomData.messageCount++;

    // Stop typing
    clearTyping(currentRoom, currentUser, socket);

    // Broadcast
    io.to(currentRoom).emit('message', msg);
    log('msg', `[${currentRoom}] ${currentUser}: ${text.slice(0, 80)}`);
  });

  // ── TYPING START ──
  socket.on('typing_start', () => {
    if (!currentRoom || !currentUser) return;

    const key = `${currentRoom}:${currentUser}`;

    // Clear old timer
    if (typingTimers.has(key)) clearTimeout(typingTimers.get(key));

    // Auto-stop after TYPING_CLEANUP_MS
    typingTimers.set(key, setTimeout(() => {
      socket.to(currentRoom).emit('typing_stop', { username: currentUser });
      typingTimers.delete(key);
    }, TYPING_CLEANUP_MS));

    socket.to(currentRoom).emit('typing_start', { username: currentUser });
  });

  // ── TYPING STOP ──
  socket.on('typing_stop', () => {
    if (!currentRoom || !currentUser) return;
    clearTyping(currentRoom, currentUser, socket);
    socket.to(currentRoom).emit('typing_stop', { username: currentUser });
  });

  // ── REACTION ──
  socket.on('reaction', (payload) => {
    if (!currentRoom || !currentUser) return;
    if (!payload || typeof payload !== 'object') return;

    const { messageId, emoji } = payload;
    if (!messageId || typeof messageId !== 'string') return;
    if (!emoji || typeof emoji !== 'string') return;
    if (emoji.length > 8) return; // sanity check

    io.to(currentRoom).emit('reaction', {
      messageId,
      emoji,
      username: currentUser,
      timestamp: Date.now(),
    });
  });

  // ── PING ──
  socket.on('ping', () => {
    socket.emit('pong', { ts: Date.now() });
  });

  // ── DISCONNECT ──
  socket.on('disconnect', (reason) => {
    log('info', `Disconnected ${socket.id} (${reason})`);

    if (currentRoom && currentUser) {
      clearTyping(currentRoom, currentUser, socket);
      leaveCurrentRoom(socket, currentRoom, currentUser);
    }

    rateLimitMap.delete(socket.id);
  });

  // ── ERROR ──
  socket.on('error', (err) => {
    log('error', `Socket error ${socket.id}: ${err.message}`);
  });
});

// ================================================================
// HELPERS
// ================================================================
function leaveCurrentRoom(socket, room, username) {
  socket.leave(room);
  const roomData = rooms.get(room);
  if (!roomData) return;

  roomData.users.delete(socket.id);

  const count = roomData.users.size;
  socket.to(room).emit('user_left', { username, onlineCount: count });
  io.to(room).emit('online_count', { count });

  if (roomData.users.size === 0) {
    rooms.delete(room);
    log('info', `Room "${room}" is now empty — removed`);
  }
}

function clearTyping(room, username, socket) {
  const key = `${room}:${username}`;
  if (typingTimers.has(key)) {
    clearTimeout(typingTimers.get(key));
    typingTimers.delete(key);
  }
}

function log(level, msg) {
  const ts = new Date().toISOString();
  const prefix = { info: '→', msg: '💬', error: '✖', warn: '⚠' }[level] || '·';
  console.log(`[${ts}] ${prefix} ${msg}`);
}

// ================================================================
// PERIODIC CLEANUP
// ================================================================
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  rateLimitMap.forEach((data, id) => {
    if (now - data.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(id);
      cleaned++;
    }
  });
  if (cleaned > 0) log('info', `Cleanup: removed ${cleaned} stale rate-limit entries`);
}, CLEANUP_INTERVAL_MS);


// ================================================================
// HOUSE WALLET TRACKER
// ================================================================
const HOUSE_WALLET    = 'EWBFhigrnx6q5MMaGgxcg22dZtqTcZwiut8ZG7QCAFo';
const SOLSCAN_LINK    = `https://solscan.io/account/${HOUSE_WALLET}`;
const SOLANA_RPC      = 'https://api.mainnet-beta.solana.com';
const WALLET_ROOM     = 'degencoinflip-lobby';
const WALLET_INTERVAL = 60 * 60 * 1000; // 1 hour

// Stores up to 24 hourly snapshots: { sol, timestamp }
const walletSnapshots = [];

async function fetchSolBalance() {
  const res = await fetch(SOLANA_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [HOUSE_WALLET],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Solana RPC: ${json.error.message}`);
  return json.result.value / 1_000_000_000; // lamports to SOL
}

function formatSol(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function broadcastWalletMsg(text) {
  const msg = {
    id:        genId(),
    username:  'Wallet Bot',
    text,
    timestamp: Date.now(),
    reactions: {},
    isBot:     true,
  };
  messageHistory.push(msg);
  if (messageHistory.length > MAX_MSG_HISTORY) messageHistory.shift();
  io.to(WALLET_ROOM).emit('message', msg);
}

async function checkWallet(isInitial) {
  try {
    const sol  = await fetchSolBalance();
    const prev = walletSnapshots[walletSnapshots.length - 1] || null;

    walletSnapshots.push({ sol, timestamp: Date.now() });
    if (walletSnapshots.length > 24) walletSnapshots.shift();

    if (isInitial) {
      broadcastWalletMsg(
        `House Wallet Tracker online\nCurrent: ${formatSol(sol)} SOL\nUpdates every hour. ${SOLSCAN_LINK}`
      );
    } else {
      const change    = prev ? sol - prev.sol : null;
      const arrow     = change === null ? '' : change >= 0 ? ' UP' : ' DOWN';
      const changeStr = change !== null
        ? ` (${change >= 0 ? '+' : ''}${formatSol(change)} SOL${arrow})`
        : '';
      const prevStr   = prev ? formatSol(prev.sol) + ' SOL' : 'N/A';

      broadcastWalletMsg(
        `House Wallet Update\nNow: ${formatSol(sol)} SOL${changeStr}\n1hr ago: ${prevStr}\n${SOLSCAN_LINK}`
      );
    }

    log('info', `Wallet check: ${formatSol(sol)} SOL`);
  } catch (err) {
    log('error', `Wallet tracker: ${err.message}`);
  }
}

// Wait 8s for socket.io to be ready, then run immediately + every hour
setTimeout(() => {
  checkWallet(true);
  setInterval(() => checkWallet(false), WALLET_INTERVAL);
}, 8_000);

// ================================================================
// START
// ================================================================
server.listen(PORT, () => {
  log('info', `DCF CF Chat Server v1.0.0`);
  log('info', `Listening on port ${PORT} [${NODE_ENV}]`);
  log('info', `Health: http://localhost:${PORT}/health`);
});

// ── GRACEFUL SHUTDOWN ──
function gracefulShutdown(signal) {
  log('info', `Received ${signal} — shutting down gracefully...`);
  io.emit('server_shutdown', { message: 'Server restarting. Reconnecting...' });
  server.close(() => {
    log('info', 'Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log('error', `Uncaught Exception: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled Rejection: ${reason}`);
});

module.exports = { app, server, io };
