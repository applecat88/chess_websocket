// Two-seat chess.
//
// The page arrives over HTTP. Each browser then keeps one WebSocket open.
// Frames are JSON:
//
//   client → server         join, move, resign, restart
//   server → that socket    state     (the whole position, plus which seat you are)
//   server → that socket    error     (the frame was refused)
//
// The board on the screen changes when a state frame arrives. The browser
// can ask to move. Only this file, using chess.js, can accept the move.

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const chess = require("./chess");

const PORT = 8081;

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
    res.writeHead(200, {
        "Content-Type": entry[1],
        "Cache-Control": "no-cache",
    });
    res.end(fs.readFileSync(path.join(__dirname, "public", entry[0])));
});

const wss = new WebSocket.Server({ server: httpServer });

let game = chess.createGame();
let phase = "waiting";
let seats = { w: null, b: null };
let resignedWinner = null;
const clients = new Map();

function cleanName(value) {
    const name = String(value ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, 16);
    return name || "Player";
}

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function fail(socket, text) {
    send(socket, { type: "error", text });
}

function decorate(move) {
    const from = square(move.from);
    const to = square(move.to);
    const mover = game.board[from.rank][from.file];
    const captured = game.board[to.rank][to.file];
    const enPassant = mover.toLowerCase() === "p" && move.to === game.enPassant;
    return { from: move.from, to: move.to, promotion: move.promotion, capture: !!captured || enPassant };
}

function square(name) {
    return { file: "abcdefgh".indexOf(name[0]), rank: Number(name[1]) - 1 };
}

function snapshot() {
    return {
        rows: chess.rows(game),
        fen: chess.fen(game),
        turn: game.turn,
        status: phase,
        winner: phase === "resigned" ? resignedWinner : game.winner,
        reason: phase === "resigned" ? "resignation" : game.reason,
        check: !!game.check && (phase === "playing" || phase === "checkmate"),
        seats: { w: seats.w, b: seats.b },
        last: game.last,
        history: game.sans,
        moves: phase === "playing" ? chess.legalMoves(game).map(decorate) : [],
    };
}

function publish(notice) {
    const view = snapshot();
    for (const [socket, seat] of clients) {
        send(socket, { type: "state", you: seat, notice, ...view });
    }
}

function bothSeated() {
    return !!(seats.w && seats.b);
}

function refreshPhase() {
    if (!seats.w && !seats.b) {
        game = chess.createGame();
        phase = "waiting";
        resignedWinner = null;
        return;
    }
    if (!bothSeated() && phase === "playing") {
        phase = "paused";
        return;
    }
    if (bothSeated() && (phase === "waiting" || phase === "paused")) phase = "playing";
}

wss.on("connection", (socket) => {
    clients.set(socket, null);
    console.log("WebSocket open —", wss.clients.size, "connection(s)");

    socket.on("message", (incoming) => {
        let data;
        try {
            data = JSON.parse(incoming.toString());
        } catch {
            fail(socket, "that was not JSON");
            return;
        }

        if (data.type === "join") {
            if (clients.get(socket)) {
                fail(socket, "you already have a seat");
                return;
            }
            const name = cleanName(data.name);
            let notice;
            if (!seats.w) {
                seats.w = name;
                clients.set(socket, "w");
                notice = `${name} sat down as white`;
            } else if (!seats.b) {
                seats.b = name;
                clients.set(socket, "b");
                notice = `${name} sat down as black`;
            } else {
                clients.set(socket, null);
                notice = `${name} is watching. Both seats are taken`;
            }
            refreshPhase();
            console.log(notice);
            publish(notice);
            return;
        }

        if (data.type === "move") {
            const seat = clients.get(socket);
            if (phase !== "playing") {
                fail(socket, "the game is not in play");
                return;
            }
            if (seat !== game.turn) {
                fail(socket, "it is not your turn");
                return;
            }
            const next = chess.applyMove(game, data.from, data.to, data.promotion || null);
            if (!next) {
                fail(socket, "illegal move");
                return;
            }
            game = next;
            if (game.status !== "playing") phase = game.status;
            console.log(game.last.san, phase === "playing" ? "" : phase);
            publish(null);
            return;
        }

        if (data.type === "resign") {
            const seat = clients.get(socket);
            if (phase !== "playing" || (seat !== "w" && seat !== "b")) {
                fail(socket, "you cannot resign right now");
                return;
            }
            phase = "resigned";
            resignedWinner = seat === "w" ? "b" : "w";
            console.log(`${seats[seat]} resigned`);
            publish(`${seats[seat]} resigned`);
            return;
        }

        if (data.type === "restart") {
            const seat = clients.get(socket);
            if (seat !== "w" && seat !== "b") {
                fail(socket, "only a seated player can start a new game");
                return;
            }
            const name = seats[seat];
            game = chess.createGame();
            resignedWinner = null;
            phase = bothSeated() ? "playing" : "waiting";
            console.log(`${name} started a new game`);
            publish(`${name} started a new game`);
            return;
        }

        fail(socket, "ignored. the server accepts join, move, resign, and restart");
    });

    socket.on("close", () => {
        const seat = clients.get(socket);
        clients.delete(socket);
        if (seat !== "w" && seat !== "b") {
            console.log("spectator left");
            return;
        }
        const name = seats[seat];
        seats[seat] = null;
        refreshPhase();
        console.log(`${name} left`);
        publish(`${name} left`);
    });

    socket.on("error", (err) => {
        console.log("socket error:", err.message);
    });
});

httpServer.listen(PORT, () => {
    console.log(`Chess running at http://localhost:${PORT}`);
    console.log("Open that address in two browser windows.");
});
