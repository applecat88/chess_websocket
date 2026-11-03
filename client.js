// Terminal player for Coin Rush.
//
// Same messages as the browser, with no canvas. Start the server first,
// then run: node client.js
// The bot walks toward the coin. Watch the browser log fill with "moved".

const WebSocket = require("ws");

const socket = new WebSocket("ws://localhost:8080");

let me = null;
let coin = null;
let timer = null;

socket.on("open", () => {
    console.log("socket open — sending join");
    socket.send(JSON.stringify({ type: "join", name: "Bot" }));
});

socket.on("message", (incoming) => {
    const raw = incoming.toString();
    const data = JSON.parse(raw);

    if (data.type !== "moved") {
        console.log("↓", raw);
    }

    if (data.type === "welcome") {
        me = data.you;
        coin = data.coin;
        console.log(`I am ${me.name} (${me.id}) at ${me.x}, ${me.y}`);
        // A dumb client: every step is whatever the server last accepted.
        timer = setInterval(walk, 800);
    }

    if (data.type === "moved" && me && data.id === me.id) {
        me.x = data.x;
        me.y = data.y;
    }

    if (data.type === "scored") {
        coin = data.coin;
    }
});

socket.on("close", () => {
    clearInterval(timer);
    console.log("socket closed");
});

socket.on("error", (err) => {
    console.error("connection failed:", err.message);
});

function walk() {
    if (!me || !coin || socket.readyState !== WebSocket.OPEN) return;

    const dx = coin.x - me.x;
    const dy = coin.y - me.y;
    const distance = Math.hypot(dx, dy) || 1;
    const step = Math.min(16, distance);

    me.x = Math.round((me.x + (dx / distance) * step) * 10) / 10;
    me.y = Math.round((me.y + (dy / distance) * step) * 10) / 10;

    const message = { type: "move", x: me.x, y: me.y };
    socket.send(JSON.stringify(message));
    console.log("↑", JSON.stringify(message));
}
