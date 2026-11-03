// Browser half of the chess tables.
//
// new WebSocket opens the pipe. socket.send asks to sit, watch, or move.
// The "message" event brings back a lobby frame or a state frame.
// Nothing on the board moves ahead of the server.

const FILES = "abcdefgh";
const GLYPH = {
    K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟",
    k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟",
};
const PROMO_NAME = { q: "queen", r: "rook", b: "bishop", n: "knight" };
const ROOM_LABEL = {
    waiting: "waiting",
    playing: "playing",
    checkmate: "checkmate",
    stalemate: "draw",
    draw: "draw",
    resigned: "resigned",
    abandoned: "player left",
};

const boardEl = document.querySelector("#board");
const promoteEl = document.querySelector("#promote");
const statusEl = document.querySelector("#status");
const noticeEl = document.querySelector("#notice");
const fenEl = document.querySelector("#fen");
const seatsEl = document.querySelector("#seats");
const historyEl = document.querySelector("#history");
const connEl = document.querySelector("#conn");
const logEl = document.querySelector("#log");
const countsEl = document.querySelector("#counts");
const nameInput = document.querySelector("#name");
const connectBtn = document.querySelector("#connect");
const disconnectBtn = document.querySelector("#disconnect");
const resignBtn = document.querySelector("#resign");
const restartBtn = document.querySelector("#restart");
const exitBtn = document.querySelector("#exit");
const lobbyEl = document.querySelector("#lobby");
const tableEl = document.querySelector("#table");
const playBtn = document.querySelector("#play");
const hostBtn = document.querySelector("#host");
const joinBtn = document.querySelector("#join");
const codeInput = document.querySelector("#code");
const onlineEl = document.querySelector("#online");
const lobbyStatusEl = document.querySelector("#lobby-status");
const roomsEl = document.querySelector("#rooms");
const linkInput = document.querySelector("#link");
const copyBtn = document.querySelector("#copy");
const tableLabelEl = document.querySelector("#table-label");
const watchersEl = document.querySelector("#watchers");

let socket = null;
let state = emptyState();
let lobby = null;
let selected = null;
let pending = null;
let banner = "";
let sent = 0;
let received = 0;
let linkedRoom = cleanCode(new URLSearchParams(location.search).get("room"));

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", () => socket && socket.close());
resignBtn.addEventListener("click", () => send({ type: "resign" }));
restartBtn.addEventListener("click", () => send({ type: "restart" }));
exitBtn.addEventListener("click", () => send({ type: "leave" }));
playBtn.addEventListener("click", () => {
    setLobbyBusy(true);
    send({ type: "play" });
});
hostBtn.addEventListener("click", () => {
    setLobbyBusy(true);
    send({ type: "create" });
});
joinBtn.addEventListener("click", joinByCode);
copyBtn.addEventListener("click", copyLink);
nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") connect();
});
codeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinByCode();
});
render();

function emptyState() {
    return {
        you: null,
        room: null,
        open: false,
        rows: [
            "rnbqkbnr",
            "pppppppp",
            "........",
            "........",
            "........",
            "........",
            "PPPPPPPP",
            "RNBQKBNR",
        ],
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        turn: "w",
        status: "offline",
        winner: null,
        reason: null,
        check: false,
        seats: { w: null, b: null },
        last: null,
        history: [],
        moves: [],
        watchers: 0,
        notice: null,
    };
}

function cleanCode(value) {
    const code = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return /^[a-z0-9]{4}$/.test(code) ? code : "";
}

function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    sent = 0;
    received = 0;
    selected = null;
    pending = null;
    logEl.textContent = "";
    updateCounts();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${proto}//${location.host}`);
    window.socket = socket;
    connectBtn.disabled = true;
    nameInput.disabled = true;
    connEl.textContent = "opening the socket…";

    socket.addEventListener("open", () => {
        disconnectBtn.disabled = false;
        connEl.textContent = "socket open…";
        const hello = { type: "hello", name: nameInput.value };
        if (linkedRoom) hello.room = linkedRoom;
        send(hello);
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
        socket = null;
        window.socket = null;
        selected = null;
        pending = null;
        banner = "";
        lobby = null;
        state = emptyState();
        connEl.textContent = "disconnected";
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        nameInput.disabled = false;
        showOffline();
    });

    socket.addEventListener("error", () => {
        connEl.textContent = "could not reach the server";
    });
}

function apply(data) {
    if (data.type === "error") {
        banner = data.text;
        noticeEl.textContent = banner;
        lobbyStatusEl.textContent = banner;
        setLobbyBusy(false);
        return;
    }

    if (data.type === "lobby") {
        lobby = data;
        state = emptyState();
        selected = null;
        pending = null;
        banner = "";
        linkedRoom = null;
        if (location.search) history.replaceState(null, "", location.pathname);
        connEl.textContent = `connected as ${data.you} · ${data.online} online`;
        showLobby();
        return;
    }

    if (data.type !== "state") return;

    state = data;
    banner = data.notice || "";
    if (selected && !state.moves.some((move) => move.from === selected)) selected = null;
    pending = null;
    const seat = state.you === "w" ? "white" : state.you === "b" ? "black" : "watching";
    const name = state.you ? state.seats[state.you] : data.you;
    connEl.textContent = state.you
        ? `connected as ${name}, ${seat}`
        : `connected, watching table ${state.room}`;
    showTable();
}

function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify(message);
    socket.send(raw);
    sent += 1;
    updateCounts();
    writeLog("out", raw);
}

function joinByCode() {
    const code = cleanCode(codeInput.value);
    if (!code) {
        lobbyStatusEl.textContent = "A table code is 4 letters or numbers.";
        return;
    }
    setLobbyBusy(true);
    send({ type: "join", room: code });
}

function setLobbyBusy(busy) {
    playBtn.disabled = busy;
    hostBtn.disabled = busy;
    joinBtn.disabled = busy;
}

function showOffline() {
    lobbyEl.hidden = true;
    tableEl.hidden = false;
    render();
}

function showLobby() {
    lobbyEl.hidden = false;
    tableEl.hidden = true;
    setLobbyBusy(false);
    renderLobby();
}

function showTable() {
    lobbyEl.hidden = true;
    tableEl.hidden = false;
    if (state.room) history.replaceState(null, "", `/?room=${state.room}`);
    render();
}

function copyLink() {
    if (!linkInput.value) return;
    linkInput.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(linkInput.value).then(() => {
            noticeEl.textContent = "Link copied.";
        }).catch(() => {
            noticeEl.textContent = "The link is selected. Copy it from the box.";
        });
        return;
    }
    noticeEl.textContent = "The link is selected. Copy it from the box.";
}

function onSquare(name) {
    if (state.status !== "playing" || state.you !== state.turn) return;

    if (selected) {
        const options = state.moves.filter((move) => move.from === selected && move.to === name);
        if (options.length === 1 && !options[0].promotion) {
            send({ type: "move", from: selected, to: name });
            selected = null;
            pending = null;
            render();
            return;
        }
        if (options.some((move) => move.promotion)) {
            pending = { from: selected, to: name, options };
            render();
            return;
        }
    }

    selected = state.moves.some((move) => move.from === name) ? name : null;
    pending = null;
    render();
}

function choosePromotion(promotion) {
    send({ type: "move", from: pending.from, to: pending.to, promotion });
    selected = null;
    pending = null;
}

function render() {
    const black = state.you === "b";
    boardEl.replaceChildren();

    for (let row = 0; row < 8; row += 1) {
        for (let col = 0; col < 8; col += 1) {
            const file = black ? 7 - col : col;
            const rank = black ? row : 7 - row;
            const name = FILES[file] + (rank + 1);
            const piece = pieceAt(name);
            const button = document.createElement("button");
            button.type = "button";
            button.className = `sq ${(file + rank) % 2 === 0 ? "dark" : "light"}`;
            button.dataset.square = name;
            button.setAttribute("aria-label", squareLabel(name, piece));

            if (state.last && (state.last.from === name || state.last.to === name)) button.classList.add("last");
            if (selected === name) button.classList.add("selected");
            if (isTarget(name)) button.classList.add("target");
            if (isCapture(name)) button.classList.add("capture");
            if (state.check && piece && piece.toLowerCase() === "k" && colorOf(piece) === state.turn) {
                button.classList.add("check");
            }

            if (piece) {
                const span = document.createElement("span");
                span.className = `piece ${piece === piece.toUpperCase() ? "white" : "black"}`;
                span.textContent = GLYPH[piece];
                button.append(span);
            }
            if (col === 0) button.append(mark("rank", String(rank + 1)));
            if (row === 7) button.append(mark("file", FILES[file]));

            button.addEventListener("click", () => onSquare(name));
            boardEl.append(button);
        }
    }

    statusEl.textContent = statusText();
    noticeEl.textContent = banner;
    fenEl.textContent = state.fen || "";
    tableLabelEl.textContent = state.room ? `table ${state.room}` : "table";
    watchersEl.textContent = state.room ? `${state.watchers || 0} watching` : "";
    linkInput.value = state.room ? `${location.origin}/?room=${state.room}` : "";
    copyBtn.disabled = !state.room;
    renderSeats();
    renderHistory();
    renderPromote();

    const seated = state.you === "w" || state.you === "b";
    const finished = ["checkmate", "stalemate", "draw", "resigned", "abandoned", "waiting"].includes(state.status);
    resignBtn.disabled = !(seated && state.status === "playing");
    restartBtn.disabled = !(seated && finished);
    exitBtn.disabled = !state.room;
}

function renderLobby() {
    const count = lobby.online === 1 ? "1 person online" : `${lobby.online} people online`;
    onlineEl.textContent = count;
    if (lobby.notice) {
        lobbyStatusEl.textContent = lobby.notice;
    } else if (!lobby.rooms.length) {
        lobbyStatusEl.textContent = "No open tables yet. Play seats you with the next person online.";
    } else {
        const word = lobby.rooms.length === 1 ? "table" : "tables";
        lobbyStatusEl.textContent = `${lobby.rooms.length} open ${word}.`;
    }

    roomsEl.replaceChildren();
    for (const room of lobby.rooms) {
        const row = document.createElement("div");
        row.className = "room";
        const text = document.createElement("span");
        const white = room.white || "empty";
        const black = room.black || "empty";
        const label = ROOM_LABEL[room.status] || room.status;
        const extra = room.watchers ? ` · ${room.watchers} watching` : "";
        text.textContent = `${room.id} · ${label} · ${white} vs ${black} · ${room.moves} moves${extra}`;
        const seatOpen = (!room.white || !room.black) && room.status !== "playing";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = seatOpen ? "Join" : "Watch";
        button.addEventListener("click", () => {
            setLobbyBusy(true);
            send({ type: seatOpen ? "join" : "watch", room: room.id });
        });
        row.append(text, button);
        roomsEl.append(row);
    }
}

function renderPromote() {
    promoteEl.replaceChildren();
    if (!pending) {
        promoteEl.hidden = true;
        return;
    }
    promoteEl.hidden = false;
    const label = document.createElement("span");
    label.textContent = `Promote the pawn on ${pending.to} to`;
    promoteEl.append(label);
    const seen = new Set();
    for (const option of pending.options) {
        if (!option.promotion || seen.has(option.promotion)) continue;
        seen.add(option.promotion);
        const button = document.createElement("button");
        button.type = "button";
        const piece = state.you === "b" ? option.promotion : option.promotion.toUpperCase();
        button.textContent = GLYPH[piece];
        button.setAttribute("aria-label", PROMO_NAME[option.promotion]);
        button.addEventListener("click", () => choosePromotion(option.promotion));
        promoteEl.append(button);
    }
}

function renderSeats() {
    seatsEl.replaceChildren();
    for (const color of ["w", "b"]) {
        const row = document.createElement("div");
        row.className = "seat";
        const name = document.createElement("strong");
        const who = state.seats[color] || "empty seat";
        const mine = state.you === color ? " (you)" : "";
        name.textContent = `${color === "w" ? "White" : "Black"}: ${who}${mine}`;
        const turn = document.createElement("span");
        turn.className = "who";
        turn.textContent = state.status === "playing" && state.turn === color ? "to move" : "";
        row.append(name, turn);
        seatsEl.append(row);
    }
}

function renderHistory() {
    historyEl.replaceChildren();
    if (!state.history.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "No moves yet.";
        historyEl.append(li);
        return;
    }
    for (let i = 0; i < state.history.length; i += 2) {
        const li = document.createElement("li");
        li.textContent = state.history[i + 1] ? `${state.history[i]}  ${state.history[i + 1]}` : state.history[i];
        historyEl.append(li);
    }
}

function statusText() {
    if (state.status === "offline") return "Connect, then press Play.";
    if (state.status === "waiting") {
        return state.open
            ? "Waiting for an opponent. Anyone who presses Play can sit here."
            : "Waiting for your friend. Share the table link.";
    }
    if (state.status === "checkmate") return `Checkmate. ${sideName(state.winner)} wins.`;
    if (state.status === "stalemate") return "Stalemate. The game is a draw.";
    if (state.status === "draw") return `Draw by ${state.reason}.`;
    if (state.status === "resigned") return `${sideName(other(state.winner))} resigned. ${sideName(state.winner)} wins.`;
    if (state.status === "abandoned") return `${sideName(state.winner)} wins. The other player left.`;
    const check = state.check ? "Check. " : "";
    if (state.you === state.turn) return `${check}Your move.`;
    return `${check}${sideName(state.turn)} to move.`;
}

function sideName(color) {
    const name = color === "w" ? state.seats.w : state.seats.b;
    const side = color === "w" ? "White" : "Black";
    return name ? `${side}, ${name}` : side;
}

function other(color) {
    return color === "w" ? "b" : "w";
}

function pieceAt(name) {
    const file = FILES.indexOf(name[0]);
    const rank = Number(name[1]);
    const row = state.rows[8 - rank] || "........";
    const piece = row[file];
    return piece && piece !== "." ? piece : "";
}

function colorOf(piece) {
    return piece === piece.toUpperCase() ? "w" : "b";
}

function isTarget(name) {
    return !!selected && state.moves.some((move) => move.from === selected && move.to === name && !move.capture);
}

function isCapture(name) {
    return !!selected && state.moves.some((move) => move.from === selected && move.to === name && move.capture);
}

function squareLabel(name, piece) {
    if (!piece) return name;
    const color = piece === piece.toUpperCase() ? "white" : "black";
    const kind = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" }[piece.toLowerCase()];
    return `${name}, ${color} ${kind}`;
}

function mark(className, text) {
    const node = document.createElement("i");
    node.className = className;
    node.textContent = text;
    return node;
}

function writeLog(direction, raw) {
    const line = document.createElement("div");
    line.className = direction === "out" ? "out" : "in";
    const stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    line.textContent = `${stamp}  ${direction === "out" ? "↑" : "↓"}  ${raw}`;
    logEl.append(line);
    while (logEl.childElementCount > 40) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
}

function updateCounts() {
    countsEl.textContent = `sent ${sent} · received ${received}`;
}
