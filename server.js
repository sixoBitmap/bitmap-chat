const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// rooms: roomCode -> Map(clientId -> { ws, name })
const rooms = new Map();

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function getRoom(room) {
  if (!rooms.has(room)) rooms.set(room, new Map());
  return rooms.get(room);
}

function makeId() {
  // short-ish id
  return crypto.randomUUID().slice(0, 8);
}

wss.on("connection", (ws) => {
  const clientId = makeId();
  let joinedRoom = null;

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // JOIN ROOM
    if (msg.type === "join") {
      const room = String(msg.room || "").trim().toUpperCase();
      const name = String(msg.name || "USER").slice(0, 16);

      if (!/^[A-Z0-9-]{3,20}$/.test(room)) {
        return send(ws, { type:"error", error:"Invalid room code." });
      }

      joinedRoom = room;

      const r = getRoom(room);

      // tell joiner who already exists
      const peers = Array.from(r.entries()).map(([id, info]) => ({ id, name: info.name }));
      send(ws, { type:"welcome", id: clientId, room, peers });

      // add them
      r.set(clientId, { ws, name });

      // notify others
      for (const [id, info] of r.entries()) {
        if (id === clientId) continue;
        send(info.ws, { type:"peer-joined", peer: { id: clientId, name } });
      }
      return;
    }

    // SIGNAL FORWARD
    if (msg.type === "signal") {
      if (!joinedRoom) return;
      const to = String(msg.to || "");
      const r = rooms.get(joinedRoom);
      if (!r) return;
      const dest = r.get(to);
      if (!dest) return;

      send(dest.ws, { type:"signal", from: clientId, data: msg.data });
      return;
    }
  });

  ws.on("close", () => {
    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;

    r.delete(clientId);

    for (const [, info] of r.entries()) {
      send(info.ws, { type:"peer-left", id: clientId });
    }

    if (r.size === 0) rooms.delete(joinedRoom);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Signaling server on port", PORT);
});