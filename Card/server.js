// Many chess tables on one server.
//
// The page arrives over HTTP. Each browser then keeps one WebSocket open.
// Frames are JSON:
//
//   client → server         hello, play, create, join, watch, leave,
//                           move, resign, restart
//   server → that socket    lobby     (tables you can join or watch)
//   server → that socket    state     (one table, plus which seat you are)
//   server → that socket    error     (the frame was refused)
//
// "play" sits you at the oldest open table that needs an opponent, or
// opens a new one. "create" opens a private table that only a code can
// find. Two people in different places share one table. The board on the
// screen changes when a state frame arrives. Only this file, using
// chess.js, can accept a move.

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const chess = require("./chess");

const PORT = Number(process.env.PORT) || 8081;
const MAX_ROOMS = 200;
const MAX_PEOPLE = 500;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const pages = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/game.js": ["game.js", "text/javascript; charset=utf-8"],
};

const httpServer = http.createServer((req, res) => {
    let pathname = "/";
    try {
        pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
        pathname = "/";
    }

    if (pathname === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
    }

    const entry = pages[pathname];
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

const rooms = new Map();
const people = new Map();

function cleanName(value) {
    const name = String(value ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, 16);
    return name || "Player";
}

function cleanRoom(value) {
    const id = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return id.length === 4 ? id : "";
}

function randomId() {
    let id = "";
    for (let i = 0; i < 4; i += 1) {
        id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return id;
}

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function fail(socket, text) {
    send(socket, { type: "error", text });
}

function nameOf(socket) {
    const person = socket && people.get(socket);
    return person ? person.name : null;
}

function seatOf(room, socket) {
    if (room.seats.w === socket) return "w";
    if (room.seats.b === socket) return "b";
    return null;
}

function other(color) {
    return color === "w" ? "b" : "w";
}

function square(name) {
    return { file: "abcdefgh".indexOf(name[0]), rank: Number(name[1]) - 1 };
}

function decorate(room, move) {
    const from = square(move.from);
    const to = square(move.to);
    const mover = room.game.board[from.rank][from.file];
    const captured = room.game.board[to.rank][to.file];
    const enPassant = mover.toLowerCase() === "p" && move.to === room.game.enPassant;
    return { from: move.from, to: move.to, promotion: move.promotion, capture: !!captured || enPassant };
}

function members(room) {
    const list = [];
    if (room.seats.w) list.push(room.seats.w);
    if (room.seats.b) list.push(room.seats.b);
    for (const socket of room.watchers) list.push(socket);
    return list;
}

function snapshot(room, moves) {
    const closed = room.phase === "resigned" || room.phase === "abandoned";
    return {
        room: room.id,
        open: room.open,
        rows: chess.rows(room.game),
        fen: chess.fen(room.game),
        turn: room.game.turn,
        status: room.phase,
        winner: closed ? room.resultWinner : room.game.winner,
        reason: room.phase === "resigned"
            ? "resignation"
            : room.phase === "abandoned"
                ? "opponent left"
                : room.game.reason,
        check: !!room.game.check && (room.phase === "playing" || room.phase === "checkmate"),
        seats: { w: nameOf(room.seats.w), b: nameOf(room.seats.b) },
        last: room.game.last,
        history: room.game.sans,
        watchers: room.watchers.size,
        moves,
    };
}

function publishRoom(room, notice) {
    const moves = room.phase === "playing"
        ? chess.legalMoves(room.game).map((move) => decorate(room, move))
        : [];
    const view = snapshot(room, moves);
    for (const socket of members(room)) {
        const seat = seatOf(room, socket);
        send(socket, {
            type: "state",
            you: seat,
            notice: notice || null,
            ...view,
            moves: seat && seat === room.game.turn ? moves : [],
        });
    }
}

function lobbyPayload(socket, notice) {
    const list = [];
    for (const room of rooms.values()) {
        if (!room.open) continue;
        list.push({
            id: room.id,
            status: room.phase,
            white: nameOf(room.seats.w),
            black: nameOf(room.seats.b),
            watchers: room.watchers.size,
            moves: room.game.sans.length,
            created: room.created,
        });
    }
    list.sort((a, b) => {
        const aw = a.status === "waiting" ? 0 : 1;
        const bw = b.status === "waiting" ? 0 : 1;
        if (aw !== bw) return aw - bw;
        return a.created - b.created;
    });
    return {
        type: "lobby",
        you: nameOf(socket) || "Player",
        online: people.size,
        notice: notice || null,
        rooms: list.map((room) => ({
            id: room.id,
            status: room.status,
            white: room.white,
            black: room.black,
            watchers: room.watchers,
            moves: room.moves,
        })),
    };
}

function publishLobby(except) {
    for (const [socket, person] of people) {
        if (socket === except || person.roomId) continue;
        send(socket, lobbyPayload(socket));
    }
}

function makeRoom(open) {
    let id = randomId();
    while (rooms.has(id)) id = randomId();
    const room = {
        id,
        open,
        created: Date.now(),
        game: chess.createGame(),
        phase: "waiting",
        seats: { w: null, b: null },
        watchers: new Set(),
        resultWinner: null,
    };
    rooms.set(id, room);
    return room;
}

function oldestOpenWaiting() {
    let best = null;
    for (const room of rooms.values()) {
        if (!room.open || room.phase !== "waiting") continue;
        const oneSeat = Boolean(room.seats.w) !== Boolean(room.seats.b);
        if (!oneSeat) continue;
        if (!best || room.created < best.created) best = room;
    }
    return best;
}

function drop(socket, name) {
    const person = people.get(socket);
    if (!person?.roomId) return [];
    const room = rooms.get(person.roomId);
    person.roomId = null;
    if (!room) return [];

    const wasWatcher = room.watchers.delete(socket);
    const seat = seatOf(room, socket);
    if (seat) room.seats[seat] = null;

    if (!room.seats.w && !room.seats.b) {
        const evicted = [...room.watchers];
        for (const watcher of evicted) {
            const otherPerson = people.get(watcher);
            if (otherPerson) otherPerson.roomId = null;
        }
        rooms.delete(room.id);
        console.log(`table ${room.id} closed`);
        return evicted;
    }

    if (seat && room.phase === "playing") {
        room.phase = "abandoned";
        room.resultWinner = other(seat);
        console.log(`${name} left ${room.id}`);
        publishRoom(room, `${name} left`);
        return [];
    }

    if (seat || wasWatcher) publishRoom(room, seat ? `${name} left` : null);
    return [];
}

function enter(socket, id, how) {
    const person = people.get(socket);
    if (person.roomId) return true;
    const room = rooms.get(id);
    if (!room) return false;

    if (how === "watch") {
        room.watchers.add(socket);
        person.roomId = room.id;
        publishRoom(room, `${person.name} is watching`);
        publishLobby();
        return true;
    }

    let color = null;
    if (room.phase !== "playing" && !room.seats.w) color = "w";
    else if (room.phase !== "playing" && !room.seats.b) color = "b";

    if (!color) {
        room.watchers.add(socket);
        person.roomId = room.id;
        publishRoom(room, `${person.name} is watching. Both seats are taken`);
        publishLobby();
        return true;
    }

    room.seats[color] = socket;
    person.roomId = room.id;
    if (room.seats.w && room.seats.b && room.phase === "waiting") room.phase = "playing";
    const side = color === "w" ? "white" : "black";
    console.log(`${person.name} sat as ${side} at ${room.id} (${room.phase})`);
    publishRoom(room, `${person.name} sat down as ${side}`);
    publishLobby();
    return true;
}

function requirePerson(socket) {
    if (people.has(socket)) return people.get(socket);
    fail(socket, "send hello first");
    return null;
}

function roomOf(socket) {
    const person = people.get(socket);
    const room = person && rooms.get(person.roomId);
    return room || null;
}

wss.on("connection", (socket) => {
    console.log("WebSocket open —", wss.clients.size, "connection(s)");

    socket.on("message", (incoming) => {
        const text = incoming.toString();
        if (text.length > 1000) {
            fail(socket, "that frame was too long");
            return;
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            fail(socket, "that was not JSON");
            return;
        }

        if (data.type === "hello") {
            const name = cleanName(data.name);
            if (!people.has(socket)) {
                if (people.size >= MAX_PEOPLE) {
                    fail(socket, "the server is full");
                    return;
                }
                people.set(socket, { name, roomId: null });
            } else if (!people.get(socket).roomId) {
                people.get(socket).name = name;
            }
            const person = people.get(socket);
            console.log(`${person.name} connected — ${people.size} online`);
            const code = cleanRoom(data.room);
            if (code && !person.roomId) {
                if (!enter(socket, code, "join")) {
                    send(socket, lobbyPayload(socket, "no table with that code"));
                    publishLobby(socket);
                }
                return;
            }
            if (person.roomId) {
                const room = rooms.get(person.roomId);
                if (room) publishRoom(room, null);
                return;
            }
            publishLobby();
            return;
        }

        const person = requirePerson(socket);
        if (!person) return;

        if (data.type === "play") {
            if (person.roomId) return;
            const waiting = oldestOpenWaiting();
            if (waiting) {
                enter(socket, waiting.id, "join");
                return;
            }
            if (rooms.size >= MAX_ROOMS) {
                fail(socket, "too many tables right now");
                return;
            }
            const room = makeRoom(true);
            room.seats.w = socket;
            person.roomId = room.id;
            console.log(`${person.name} waiting at ${room.id}`);
            publishRoom(room, `${person.name} is waiting for an opponent`);
            publishLobby();
            return;
        }

        if (data.type === "create") {
            if (person.roomId) return;
            if (rooms.size >= MAX_ROOMS) {
                fail(socket, "too many tables right now");
                return;
            }
            const room = makeRoom(false);
            room.seats.w = socket;
            person.roomId = room.id;
            console.log(`${person.name} opened private table ${room.id}`);
            publishRoom(room, `${person.name} opened a table`);
            publishLobby();
            return;
        }

        if (data.type === "join" || data.type === "watch") {
            if (person.roomId) {
                fail(socket, "leave the table first");
                return;
            }
            const code = cleanRoom(data.room);
            if (!code) {
                fail(socket, "a table code is 4 letters or numbers");
                return;
            }
            if (!enter(socket, code, data.type === "watch" ? "watch" : "join")) {
                fail(socket, "no table with that code");
            }
            return;
        }

        if (data.type === "leave") {
            const evicted = drop(socket, person.name);
            send(socket, lobbyPayload(socket));
            for (const watcher of evicted) send(watcher, lobbyPayload(watcher));
            publishLobby(socket);
            return;
        }

        if (data.type === "move") {
            const room = roomOf(socket);
            const seat = room && seatOf(room, socket);
            if (!room || room.phase !== "playing") {
                fail(socket, "the game is not in play");
                return;
            }
            if (seat !== room.game.turn) {
                fail(socket, "it is not your turn");
                return;
            }
            const next = chess.applyMove(room.game, data.from, data.to, data.promotion || null);
            if (!next) {
                fail(socket, "illegal move");
                return;
            }
            room.game = next;
            if (room.game.status !== "playing") room.phase = room.game.status;
            console.log(`${room.id} ${room.game.last.san} ${room.phase === "playing" ? "" : room.phase}`.trim());
            publishRoom(room, null);
            return;
        }

        if (data.type === "resign") {
            const room = roomOf(socket);
            const seat = room && seatOf(room, socket);
            if (!room || room.phase !== "playing" || (seat !== "w" && seat !== "b")) {
                fail(socket, "you cannot resign right now");
                return;
            }
            room.phase = "resigned";
            room.resultWinner = other(seat);
            console.log(`${person.name} resigned at ${room.id}`);
            publishRoom(room, `${person.name} resigned`);
            return;
        }

        if (data.type === "restart") {
            const room = roomOf(socket);
            const seat = room && seatOf(room, socket);
            if (!room || (seat !== "w" && seat !== "b")) {
                fail(socket, "only a seated player can start a new game");
                return;
            }
            if (room.phase === "playing") {
                fail(socket, "finish the game, or resign, before starting another");
                return;
            }
            room.game = chess.createGame();
            room.resultWinner = null;
            room.phase = room.seats.w && room.seats.b ? "playing" : "waiting";
            console.log(`${person.name} started a new game at ${room.id}`);
            publishRoom(room, `${person.name} started a new game`);
            publishLobby();
            return;
        }

        fail(socket, "ignored. the server accepts hello, play, create, join, watch, leave, move, resign, and restart");
    });

    socket.on("close", () => {
        const person = people.get(socket);
        if (!person) {
            console.log("WebSocket closed");
            return;
        }
        const evicted = drop(socket, person.name);
        people.delete(socket);
        for (const watcher of evicted) {
            if (people.has(watcher)) send(watcher, lobbyPayload(watcher));
        }
        console.log(`${person.name} disconnected — ${people.size} online`);
        publishLobby();
    });

    socket.on("error", (err) => {
        console.log("socket error:", err.message);
    });
});

const pulse = setInterval(() => {
    for (const socket of wss.clients) {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
}, 25000);
pulse.unref();

httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Chess running at http://localhost:${PORT}`);
    console.log("Press Play in two browsers, anywhere that can reach this server.");
});
