/**
 * 最强乱斗联机：房间码 + 权威 tick 快照
 * 启动：npm start   端口：8790（Render 用 PORT）
 * 路径：/ws · /health · 可选静态站 /
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8790;
const PUBLIC_DIR = path.join(__dirname, "public");
const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const ARENA = { halfX: 560, halfY: 300 };
const MAX_PLAYERS = 6;

/** @type {Map<string, any>} id -> client */
const clients = new Map();
/** @type {Map<string, Room>} code -> room */
const rooms = new Map();

const CHAR_ALIASES = {
  quanlan: "huangquan",
  liekong: "xuanji",
  tiebi: "yankai",
  yingxi: "leisha",
};

const CHARS = {
  huangquan: { hp: 100, speed: 225, color: "#f27a38" },
  xuanji: { hp: 88, speed: 240, color: "#8cb8ff" },
  shuizan: { hp: 95, speed: 235, color: "#59c7d9" },
  leisha: { hp: 82, speed: 265, color: "#bfd959" },
  yankai: { hp: 125, speed: 198, color: "#9eb87a", blockMul: 0.22 },
  yanlu: { hp: 92, speed: 215, color: "#ff5933" },
  huying: { hp: 90, speed: 250, color: "#e68c40" },
  juwan: { hp: 105, speed: 230, color: "#f28ca6" },
};

function resolveChar(id) {
  const mapped = CHAR_ALIASES[id] || id;
  return CHARS[mapped] ? mapped : "huangquan";
}

function uid() {
  return crypto.randomBytes(6).toString("hex");
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 5; i++) c += alphabet[(Math.random() * alphabet.length) | 0];
  if (rooms.has(c)) return makeCode();
  return c;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj, exceptId) {
  for (const id of room.members) {
    if (exceptId && id === exceptId) continue;
    const c = clients.get(id);
    if (c) send(c.ws, obj);
  }
}

function lobbyPayload(room) {
  const members = [];
  for (const id of room.members) {
    const c = clients.get(id);
    if (!c) continue;
    members.push({ id, name: c.name, char: c.charId });
  }
  return { t: "lobby", code: room.code, host: room.hostId, members };
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.members = new Set([hostId]);
    this.playing = false;
    this.seed = (Math.random() * 1e9) | 0;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    this._timer = null;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.players.clear();
    let i = 0;
    for (const id of this.members) {
      const c = clients.get(id);
      if (!c) continue;
      const ang = (i / Math.max(1, this.members.size)) * Math.PI * 2;
      const p = new Player(id, c.name, c.charId, Math.cos(ang) * 180, Math.sin(ang) * 120);
      this.players.set(id, p);
      i++;
    }
    broadcastRoom(this, { t: "start", seed: this.seed });
    this._timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.playing = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.players.clear();
  }

  tick() {
    const dt = TICK_MS / 1000;
    for (const p of this.players.values()) {
      p.simulate(dt, this);
    }
    // Resolve melee / skill hits from attack pulses
    for (const attacker of this.players.values()) {
      if (!attacker.hitPulse) continue;
      const pulse = attacker.hitPulse;
      attacker.hitPulse = null;
      for (const victim of this.players.values()) {
        if (victim.id === attacker.id || victim.dead || victim.invuln > 0) continue;
        const dx = victim.x - attacker.x;
        const dy = victim.y - attacker.y;
        const dist = Math.hypot(dx, dy);
        if (dist > pulse.range) continue;
        // facing cone
        const ang = Math.atan2(dy, dx);
        const face = Math.atan2(attacker.fy, attacker.fx);
        let diff = Math.abs(ang - face);
        while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
        if (diff > ((pulse.arc || 90) * Math.PI) / 180 / 2) continue;
        const killed = victim.applyHit(pulse.dmg, pulse.kb, attacker);
        if (killed) {
          broadcastRoom(this, {
            t: "kill",
            text: `${attacker.name} 击败了 ${victim.name}`,
          });
        }
      }
    }
    // Projectiles
    for (const p of this.players.values()) {
      for (let i = p.projectiles.length - 1; i >= 0; i--) {
        const pr = p.projectiles[i];
        pr.life -= dt;
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        let hit = false;
        for (const victim of this.players.values()) {
          if (victim.id === p.id || victim.dead) continue;
          if (Math.hypot(victim.x - pr.x, victim.y - pr.y) < 18) {
            const killed = victim.applyHit(pr.dmg, pr.kb, p);
            if (killed) {
              broadcastRoom(this, {
                t: "kill",
                text: `${p.name} 击败了 ${victim.name}`,
              });
            }
            hit = true;
            break;
          }
        }
        if (hit || pr.life <= 0) p.projectiles.splice(i, 1);
      }
    }

    const players = [];
    for (const p of this.players.values()) players.push(p.snap());
    broadcastRoom(this, { t: "snap", players, tMs: Date.now() });
  }
}

class Player {
  constructor(id, name, charId, x, y) {
    this.id = id;
    this.name = name;
    this.charId = resolveChar(charId);
    const def = CHARS[this.charId];
    this.hpMax = def.hp;
    this.hp = def.hp;
    this.speed = def.speed;
    this.blockMul = def.blockMul || 0.45;
    this.x = x;
    this.y = y;
    this.fx = 1;
    this.fy = 0;
    this.aw = 0;
    this.st = 0; // idle
    this.steal = 0;
    this.dead = false;
    this.respawn = 0;
    this.invuln = 1.0;
    this.stun = 0;
    this.dashCd = 0;
    this.dashLeft = 0;
    this.atkCd = 0;
    this.skillCd = [0, 0, 0];
    this.combo = 0;
    this.comboWin = 0;
    this.input = {};
    this.hitPulse = null;
    this.projectiles = [];
    this.vx = 0;
    this.vy = 0;
  }

  applyInput(inp) {
    this.input = inp || {};
  }

  simulate(dt, room) {
    if (this.dead) {
      this.respawn -= dt;
      if (this.respawn <= 0) {
        this.dead = false;
        this.hp = this.hpMax;
        this.invuln = 1.2;
        this.x = (Math.random() - 0.5) * 400;
        this.y = (Math.random() - 0.5) * 240;
        this.st = 0;
      }
      return;
    }
    this.invuln = Math.max(0, this.invuln - dt);
    this.stun = Math.max(0, this.stun - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.dashLeft = Math.max(0, this.dashLeft - dt);
    this.atkCd = Math.max(0, this.atkCd - dt);
    this.comboWin = Math.max(0, this.comboWin - dt);
    this.steal = Math.max(0, this.steal - dt);
    for (let i = 0; i < 3; i++) this.skillCd[i] = Math.max(0, this.skillCd[i] - dt);
    if (this.comboWin <= 0) this.combo = 0;

    const inp = this.input;
    const mx = Number(inp.mx) || 0;
    const my = Number(inp.my) || 0;
    let ax = Number(inp.ax);
    let ay = Number(inp.ay);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || (ax === 0 && ay === 0)) {
      ax = this.fx;
      ay = this.fy;
    }
    const alen = Math.hypot(ax, ay) || 1;
    this.fx = ax / alen;
    this.fy = ay / alen;

    if (this.stun > 0) {
      this.st = 5;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.vx *= 0.85;
      this.vy *= 0.85;
      this.clamp();
      return;
    }

    if (inp.blk) {
      this.st = 2;
      this.x += mx * this.speed * 0.35 * dt;
      this.y += my * this.speed * 0.35 * dt;
      this.clamp();
      return;
    }

    if (inp.dsh && this.dashCd <= 0) {
      this.dashCd = 1.1;
      this.dashLeft = 0.16;
      this.st = 3;
    }

    if (inp.ult && this.aw >= 100) {
      this.aw = 0;
      this.hitPulse = { dmg: 45, range: 140, arc: 360, kb: 600 };
      this.st = 4;
    } else if (inp.s1 && this.skillCd[0] <= 0) {
      this.castSkill(0);
    } else if (inp.s2 && this.skillCd[1] <= 0) {
      this.castSkill(1);
    } else if (inp.s3 && this.skillCd[2] <= 0) {
      this.castSkill(2);
    } else if (inp.atk && this.atkCd <= 0) {
      this.doM1();
    }

    if (this.dashLeft > 0) {
      this.x += this.fx * 520 * dt;
      this.y += this.fy * 520 * dt;
      this.st = 3;
    } else {
      this.x += mx * this.speed * dt;
      this.y += my * this.speed * dt;
      if (this.st !== 1 && this.st !== 4) this.st = 0;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= 0.8;
    this.vy *= 0.8;
    this.clamp();
  }

  doM1() {
    const dmgs = [8, 9, 11, 16];
    const ranges = [56, 58, 62, 70];
    const dmg = dmgs[this.combo % 4];
    const range = ranges[this.combo % 4];
    this.combo = (this.combo + 1) % 4;
    this.comboWin = 0.55;
    this.atkCd = this.combo === 0 ? 0.38 : 0.22;
    this.st = 1;
    this.hitPulse = { dmg, range, arc: 80, kb: 120 + dmg * 10 };
  }

  castSkill(idx) {
    this.skillCd[idx] = [5, 7, 8][idx];
    this.st = 4;
    const id = this.charId;
    const fireFan = (count, spread, dmg, speed = 500, life = 0.8, kb = 120) => {
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : -spread / 2 + (spread * i) / Math.max(1, count - 1);
        const cs = Math.cos(t);
        const sn = Math.sin(t);
        const fx = this.fx * cs - this.fy * sn;
        const fy = this.fx * sn + this.fy * cs;
        this.projectiles.push({
          x: this.x + fx * 20,
          y: this.y + fy * 20,
          vx: fx * speed,
          vy: fy * speed,
          life,
          dmg,
          kb,
        });
      }
    };
    const blink = (dist) => {
      this.x += this.fx * dist;
      this.y += this.fy * dist;
      this.invuln = Math.max(this.invuln, 0.15);
      this.clamp();
    };
    const dashHit = (dmg, range, kb) => {
      this.dashLeft = 0.18;
      this.dashCd = Math.max(this.dashCd, 0.4);
      this.hitPulse = { dmg, range, arc: 100, kb };
    };
    const aoe = (dmg, range, kb) => {
      this.hitPulse = { dmg, range, arc: 360, kb };
    };
    const cone = (dmg, range, kb) => {
      this.hitPulse = { dmg, range, arc: 120, kb };
    };

    if (id === "xuanji") {
      if (idx === 0) fireFan(1, 0, 16, 540, 0.9, 110);
      else if (idx === 1) blink(175);
      else fireFan(3, 0.52, 10, 500, 0.7, 90);
    } else if (id === "yanlu") {
      if (idx === 0) fireFan(1, 0, 18, 480, 0.95, 130);
      else if (idx === 1) aoe(20, 95, 170);
      else cone(24, 88, 190);
    } else if (id === "huying") {
      if (idx === 0) fireFan(4, 0.62, 9, 460, 0.65, 80);
      else if (idx === 1) blink(150);
      else this.steal = 1.8;
    } else if (id === "leisha") {
      if (idx === 0) this.steal = 2.1;
      else if (idx === 1) dashHit(21, 155, 140);
      else dashHit(18, 90, 80);
    } else if (id === "shuizan") {
      if (idx === 0) cone(18, 95, 180);
      else if (idx === 1) dashHit(20, 160, 160);
      else dashHit(16, 80, 60);
    } else if (id === "yankai") {
      if (idx === 0) cone(15, 72, 210);
      else if (idx === 1) this.blockMul = 0.08;
      else cone(28, 90, 240);
    } else if (id === "juwan") {
      if (idx === 0) dashHit(20, 200, 200);
      else if (idx === 1) aoe(19, 100, 180);
      else dashHit(18, 100, 70);
    } else {
      // huangquan default
      if (idx === 0) dashHit(22, 180, 220);
      else if (idx === 1) aoe(18, 90, 160);
      else cone(26, 80, 240);
    }
  }

  applyHit(dmg, kb, attacker) {
    if (this.dead || this.invuln > 0) return false;
    let final = dmg;
    const inp = this.input || {};
    if (inp.blk) final *= this.blockMul;
    this.hp -= final;
    this.aw = Math.min(100, this.aw + final * 0.35);
    attacker.aw = Math.min(100, attacker.aw + final * 0.45);
    const dx = this.x - attacker.x;
    const dy = this.y - attacker.y;
    const len = Math.hypot(dx, dy) || 1;
    this.vx += (dx / len) * kb * 0.02;
    this.vy += (dy / len) * kb * 0.02;
    this.stun = Math.max(this.stun, 0.08 + final * 0.004);
    this.steal = 0;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.respawn = 3;
      this.st = 6;
      return true;
    }
    return false;
  }

  clamp() {
    this.x = Math.max(-ARENA.halfX, Math.min(ARENA.halfX, this.x));
    this.y = Math.max(-ARENA.halfY, Math.min(ARENA.halfY, this.y));
  }

  snap() {
    return {
      id: this.id,
      name: this.name,
      char: this.charId,
      x: this.x,
      y: this.y,
      fx: this.fx,
      fy: this.fy,
      hp: this.hp,
      hm: this.hpMax,
      aw: this.aw,
      st: this.st,
      steal: this.steal,
    };
  }
}

function getRoomOf(id) {
  const c = clients.get(id);
  if (!c || !c.roomCode) return null;
  return rooms.get(c.roomCode) || null;
}

function leaveRoom(id) {
  const room = getRoomOf(id);
  const c = clients.get(id);
  if (!room || !c) return;
  room.members.delete(id);
  c.roomCode = "";
  if (room.playing) room.players.delete(id);
  if (room.members.size === 0) {
    room.stop();
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === id) {
    room.hostId = [...room.members][0];
  }
  broadcastRoom(room, lobbyPayload(room));
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".css": "text/css; charset=utf-8",
    ".pck": "application/octet-stream",
  };
  return map[ext] || "application/octet-stream";
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  cors(res);
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  if (urlPath === "/health") {
    cors(res);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        name: "strongest-arena-net",
        rooms: rooms.size,
        clients: clients.size,
        ws: "/ws",
      })
    );
    return;
  }
  if (urlPath === "/api/net") {
    cors(res);
    const host = req.headers.host || "localhost";
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const wsProto = proto === "https" ? "wss" : "ws";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ws: `${wsProto}://${host}/ws`,
        play: process.env.PLAY_URL || "https://jay20130321.github.io/strongest-arena/",
        at: Date.now(),
      })
    );
    return;
  }
  if (serveStatic(req, res)) return;
  cors(res);
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("最强乱斗联机服务运行中。/health · WebSocket /ws\n");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let id = "";
  ws.on("message", (buf) => {
    let data;
    try {
      data = JSON.parse(String(buf));
    } catch {
      return;
    }
    const t = data.t;
    if (t === "hello") {
      id = String(data.id || uid());
      clients.set(id, {
        ws,
        id,
        name: String(data.name || "挑战者").slice(0, 16),
        charId: "huangquan",
        roomCode: "",
      });
      send(ws, { t: "welcome", id });
      return;
    }
    const c = clients.get(id);
    if (!c) return;

    if (t === "create") {
      leaveRoom(id);
      const code = makeCode();
      c.name = String(data.name || c.name).slice(0, 16);
      c.charId = resolveChar(data.char);
      const room = new Room(code, id);
      rooms.set(code, room);
      c.roomCode = code;
      send(ws, lobbyPayload(room));
      return;
    }

    if (t === "join") {
      const code = String(data.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { t: "err", text: "房间不存在" });
        return;
      }
      if (room.members.size >= MAX_PLAYERS) {
        send(ws, { t: "err", text: "房间已满" });
        return;
      }
      if (room.playing) {
        send(ws, { t: "err", text: "对局已开始，请等待下一局" });
        return;
      }
      leaveRoom(id);
      c.name = String(data.name || c.name).slice(0, 16);
      c.charId = resolveChar(data.char);
      c.roomCode = code;
      room.members.add(id);
      broadcastRoom(room, lobbyPayload(room));
      return;
    }

    if (t === "leave") {
      leaveRoom(id);
      return;
    }

    if (t === "start") {
      const room = getRoomOf(id);
      if (!room || room.hostId !== id) {
        send(ws, { t: "err", text: "仅房主可开始" });
        return;
      }
      room.start();
      return;
    }

    if (t === "input") {
      const room = getRoomOf(id);
      if (!room || !room.playing) return;
      const p = room.players.get(id);
      if (p) p.applyInput(data);
      return;
    }

    if (t === "chat") {
      const room = getRoomOf(id);
      const text = String(data.text || "").slice(0, 80);
      if (room) broadcastRoom(room, { t: "chat", from: c.name, text });
      return;
    }
  });

  ws.on("close", () => {
    if (!id) return;
    leaveRoom(id);
    clients.delete(id);
  });
});

server.listen(PORT, () => {
  console.log(`最强乱斗联机服务 http://0.0.0.0:${PORT}  ws://0.0.0.0:${PORT}/ws`);
});
