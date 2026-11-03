// Coin Rush — a one-room game for learning WebSockets.
//
// A WebSocket stays open. Either side can send a text frame whenever it
// wants. HTTP cannot do that: the browser would have to ask every time.
//
// Every frame is a JSON object with a "type":
//
//   client → server     join, move
//   server → one socket welcome                 (snapshot of the whole room)
//   server → every player  joined, moved, scored, left
//
// The server owns the coin and the scores. A client may ask to move.
// It cannot award itself a point.

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 8080;
const ARENA = { width: 640, height: 480, speed: 220, radius: 18 };
const COIN_R = 11;
const COLORS = ["#3dd6c6", "#ff8b6a", "#ffd166", "#9ad1ff", "#d4a5ff", "#b6e388"];

const pages = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/game.js": ["game.js", "text/javascript; charset=utf-8"],
};

const httpServer = http.createServer((req, res) => {
    const entry = pages[req.url];

    if (!entry) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
    }

    const filePath = path.join(__dirname, "public", entry[0]);
    const body = fs.readFileSync(filePath);

    res.writeHead(200, {
        "Content-Type": entry[1],
        "Cache-Control": "no-cache",
    });
    res.end(body);
});

const wss = new WebSocket.Server({ server: httpServer });

// socket → player object, or null if the pipe is open but they have not joined.
const sockets = new Map();
const players = new Map();
let nextId = 1;
let coin = placeCoin();

function placeCoin() {
    for (let attempt = 0; attempt < 30; attempt++) {
        const spot = {
            x: round(40 + Math.random() * (ARENA.width - 80)),
            y: round(40 + Math.random() * (ARENA.height - 80)),
            r: COIN_R,
        };
        let crowded = false;

        for (const player of players.values()) {
            if (Math.hypot(player.x - spot.x, player.y - spot.y) < 90) {
                crowded = true;
            }
        }

        if (!crowded) return spot;
    }

    return { x: ARENA.width / 2, y: ARENA.height / 2, r: COIN_R };
}

function placePlayer() {
    for (let attempt = 0; attempt < 30; attempt++) {
        const spot = {
            x: round(50 + Math.random() * (ARENA.width - 100)),
            y: round(50 + Math.random() * (ARENA.height - 100)),
        };
        const onCoin = Math.hypot(spot.x - coin.x, spot.y - coin.y) < 80;
        let onPlayer = false;

        for (const player of players.values()) {
            if (Math.hypot(player.x - spot.x, player.y - spot.y) < 60) {
                onPlayer = true;
            }
        }

        if (!onCoin && !onPlayer) return spot;
    }

    return { x: 80, y: 80 };
}

function round(n) {
    return Math.round(n * 10) / 10;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function cleanName(value) {
    const name = String(value ?? "").trim().slice(0, 12);
    return name || "Player";
}

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

// "except" lets us skip the player who already received a private welcome.
function broadcast(message, except) {
    const raw = JSON.stringify(message);

    for (const [socket, player] of sockets) {
        if (!player || socket === except) continue;
        if (socket.readyState === WebSocket.OPEN) socket.send(raw);
    }
}

function snapshot() {
    return {
        players: [...players.values()],
        coin,
        arena: ARENA,
    };
}

wss.on("connection", (socket) => {
    sockets.set(socket, null);
    console.log("WebSocket open —", wss.clients.size, "connection(s)");

    socket.on("message", (incoming) => {
        let data;

        try {
            data = JSON.parse(incoming.toString());
        } catch {
            send(socket, { type: "error", text: "that was not JSON" });
            return;
        }

        const player = sockets.get(socket);

        if (data.type === "join" && !player) {
            const spot = placePlayer();
            const joined = {
                id: "p" + nextId++,
                name: cleanName(data.name),
                x: spot.x,
                y: spot.y,
                color: COLORS[(nextId - 2) % COLORS.length],
                score: 0,
            };

            sockets.set(socket, joined);
            players.set(joined.id, joined);

            // Snapshot to the new socket only. A late joiner never saw the
            // earlier "joined" events, so they need the room as it is now.
            send(socket, { type: "welcome", you: joined, ...snapshot() });

            // Everyone who was already here learns that one player appeared.
            broadcast({ type: "joined", player: joined }, socket);
            console.log(`${joined.name} (${joined.id}) joined — ${players.size} playing`);
            return;
        }

        if (!player) {
            send(socket, { type: "error", text: "send join first" });
            return;
        }

        if (data.type === "move") {
            const x = Number(data.x);
            const y = Number(data.y);

            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                send(socket, { type: "error", text: "move needs numeric x and y" });
                return;
            }

            const edge = ARENA.radius;
            player.x = round(clamp(x, edge, ARENA.width - edge));
            player.y = round(clamp(y, edge, ARENA.height - edge));

            // Repeated to every player, including the sender, so each log
            // shows the server's copy of the position.
            broadcast({ type: "moved", id: player.id, x: player.x, y: player.y });

            const reached = Math.hypot(player.x - coin.x, player.y - coin.y) < ARENA.radius + COIN_R;

            if (reached) {
                player.score += 1;
                coin = placeCoin();
                broadcast({
                    type: "scored",
                    id: player.id,
                    name: player.name,
                    score: player.score,
                    coin,
                });
                console.log(`${player.name} scored ${player.score}`);
            }

            return;
        }

        // A client that sends "scored" (or anything else) does not get it.
        // Points are created here, not trusted from the browser.
        send(socket, {
            type: "error",
            text: "ignored. the server only accepts join and move",
        });
    });

    socket.on("close", () => {
        const player = sockets.get(socket);
        sockets.delete(socket);

        if (!player) {
            console.log("WebSocket closed before join");
            return;
        }

        players.delete(player.id);
        broadcast({ type: "left", id: player.id, name: player.name });
        console.log(`${player.name} (${player.id}) left — ${players.size} playing`);
    });

    socket.on("error", (err) => {
        console.log("socket error:", err.message);
    });
});

httpServer.listen(PORT, () => {
    console.log(`Coin Rush running at http://localhost:${PORT}`);
    console.log("Open that address in two browser windows, or run: node client.js");
});
