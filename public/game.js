// Browser half of Coin Rush.
//
// new WebSocket(...) opens the pipe. After that, nobody polls.
// socket.send writes a frame. The "message" event is a frame arriving.
// The canvas is only a picture of those frames, plus your own keyboard.

const canvas = document.querySelector("#arena");
const ctx = canvas.getContext("2d");
const nameInput = document.querySelector("#name");
const connectBtn = document.querySelector("#connect");
const disconnectBtn = document.querySelector("#disconnect");
const statusEl = document.querySelector("#status");
const scoresEl = document.querySelector("#scores");
const coinEl = document.querySelector("#coin");
const logEl = document.querySelector("#log");
const countsEl = document.querySelector("#counts");

const players = new Map();
const held = { left: false, right: false, up: false, down: false };

let socket = null;
let me = null;
let coin = null;
let arena = { width: 640, height: 480, speed: 220, radius: 18 };
let sent = 0;
let received = 0;
let loopOn = false;
let lastSentX = null;
let lastSentY = null;
let lastSendAt = 0;

const keyMap = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    a: "left",
    d: "right",
    w: "up",
    s: "down",
    A: "left",
    D: "right",
    W: "up",
    S: "down",
};

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", () => socket && socket.close());
window.addEventListener("keydown", onKey);
window.addEventListener("keyup", onKey);

drawIdle("Connect to step into the room.");

function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return;

    sent = 0;
    received = 0;
    logEl.textContent = "";
    updateCounts();

    // Same host and port as the page. The protocol changes from http to ws.
    socket = new WebSocket(`ws://${location.host}`);
    window.socket = socket;

    statusEl.textContent = "opening the socket…";
    connectBtn.disabled = true;
    nameInput.disabled = true;

    socket.addEventListener("open", () => {
        // The pipe is open. The server still does not know our name until
        // we send the first application message ourselves.
        statusEl.textContent = "socket open, waiting for welcome…";
        disconnectBtn.disabled = false;
        send({ type: "join", name: nameInput.value });
    });

    socket.addEventListener("message", (event) => {
        received += 1;
        updateCounts();
        writeLog("in", event.data);

        let data;
        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }

        apply(data);
    });

    socket.addEventListener("close", () => {
        loopOn = false;
        me = null;
        coin = null;
        held.left = held.right = held.up = held.down = false;
        players.clear();
        window.socket = null;
        statusEl.textContent = "disconnected";
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        nameInput.disabled = false;
        scoresEl.textContent = "no players";
        coinEl.textContent = "arrows or WASD";
        drawIdle("Disconnected. The server has told the other players you left.");
    });

    socket.addEventListener("error", () => {
        statusEl.textContent = "could not reach the server";
    });
}

function apply(data) {
    if (data.type === "welcome") {
        arena = data.arena;
        canvas.width = arena.width;
        canvas.height = arena.height;
        players.clear();

        for (const player of data.players) players.set(player.id, player);

        me = players.get(data.you.id);
        coin = data.coin;
        lastSentX = me.x;
        lastSentY = me.y;
        statusEl.textContent = `connected as ${me.name} (${me.id})`;
        refreshHud();
        startLoop();
    } else if (data.type === "joined") {
        players.set(data.player.id, data.player);
        refreshHud();
    } else if (data.type === "left") {
        players.delete(data.id);
        refreshHud();
    } else if (data.type === "moved") {
        // While a key is held, your own dot follows the keyboard so it does
        // not stutter. Everyone else, and your dot once you let go, follows
        // the position the server accepted.
        const player = players.get(data.id);
        const steering = me && data.id === me.id && (held.left || held.right || held.up || held.down);
        if (player && !steering) {
            player.x = data.x;
            player.y = data.y;
            if (me && data.id === me.id) {
                lastSentX = data.x;
                lastSentY = data.y;
            }
        }
    } else if (data.type === "scored") {
        const player = players.get(data.id);
        if (player) player.score = data.score;
        coin = data.coin;
        refreshHud();
    }

    if (me) draw();
}

function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify(message);
    socket.send(raw);
    sent += 1;
    updateCounts();
    writeLog("out", raw);
}

function flushMove() {
    if (!me) return;
    const x = Math.round(me.x * 10) / 10;
    const y = Math.round(me.y * 10) / 10;
    if (x === lastSentX && y === lastSentY) return;
    lastSentX = x;
    lastSentY = y;
    lastSendAt = performance.now();
    send({ type: "move", x, y });
}

function startLoop() {
    if (loopOn) return;
    loopOn = true;
    let previous = performance.now();
    draw();

    function frame(now) {
        if (!loopOn) return;

        const dt = Math.min(0.05, (now - previous) / 1000);
        previous = now;
        step(dt, now);
        draw();
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

function step(dt, now) {
    if (!me) return;

    let dx = 0;
    let dy = 0;
    if (held.left) dx -= 1;
    if (held.right) dx += 1;
    if (held.up) dy -= 1;
    if (held.down) dy += 1;
    if (!dx && !dy) return;

    const length = Math.hypot(dx, dy);
    const edge = arena.radius;
    me.x = clamp(me.x + (dx / length) * arena.speed * dt, edge, arena.width - edge);
    me.y = clamp(me.y + (dy / length) * arena.speed * dt, edge, arena.height - edge);

    // Moves are frequent. Send at most 20 per second, plus one when we stop.
    if (now - lastSendAt > 50) flushMove();
}

function onKey(event) {
    const control = keyMap[event.key];
    if (!control) return;
    if (event.target === nameInput) return;

    event.preventDefault();
    held[control] = event.type === "keydown";

    if (event.type === "keyup") flushMove();
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();

    if (coin) {
        ctx.fillStyle = "#ffd166";
        disc(coin.x, coin.y, coin.r || 11);
        ctx.fillStyle = "#8a6a12";
        disc(coin.x, coin.y, 3);
    }

    for (const player of players.values()) {
        const mine = me && player.id === me.id;
        ctx.fillStyle = player.color;
        disc(player.x, player.y, arena.radius);

        if (mine) {
            ctx.strokeStyle = "#f3efe6";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(player.x, player.y, arena.radius + 5, 0, Math.PI * 2);
            ctx.stroke();
        }

        const labelY = player.y < 36
            ? player.y + arena.radius + 16
            : player.y - arena.radius - 10;
        ctx.fillStyle = "#f3efe6";
        ctx.font = "13px Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(player.name, player.x, labelY);
    }
}

function drawIdle(text) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();
    ctx.fillStyle = "#d7efe4";
    ctx.font = "16px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function drawGrid() {
    ctx.strokeStyle = "rgba(243, 239, 230, 0.06)";
    ctx.lineWidth = 1;
    for (let x = 40; x < canvas.width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (let y = 40; y < canvas.height; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
}

function disc(x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
}

function refreshHud() {
    const bits = [...players.values()].map((player) => {
        const you = me && player.id === me.id ? " (you)" : "";
        return `${player.name}${you} ${player.score}`;
    });
    scoresEl.textContent = bits.join("   ·   ") || "no players";
    coinEl.textContent = coin
        ? `coin ${Math.round(coin.x)}, ${Math.round(coin.y)}`
        : "arrows or WASD";
}

function writeLog(direction, raw) {
    const line = document.createElement("div");
    line.className = direction === "out" ? "out" : "in";
    const stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const arrow = direction === "out" ? "↑" : "↓";
    line.textContent = `${stamp}  ${arrow}  ${raw}`;
    logEl.appendChild(line);
    while (logEl.childElementCount > 80) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
}

function updateCounts() {
    countsEl.textContent = `sent ${sent} · received ${received}`;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}
