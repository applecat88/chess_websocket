// Browser half of the chess table.
//
// new WebSocket opens the pipe. socket.send asks for a move.
// The "message" event brings back a state frame, and that frame is the board.
// Nothing on the canvas moves ahead of the server.

const FILES = "abcdefgh";
const GLYPH = {
    K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟",
    k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟",
};
const PROMO_NAME = { q: "queen", r: "rook", b: "bishop", n: "knight" };

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
const leaveBtn = document.querySelector("#leave");
const resignBtn = document.querySelector("#resign");
const restartBtn = document.querySelector("#restart");

let socket = null;
let state = emptyState();
let selected = null;
let pending = null;
let banner = "";
let sent = 0;
let received = 0;

connectBtn.addEventListener("click", connect);
leaveBtn.addEventListener("click", () => socket && socket.close());
resignBtn.addEventListener("click", () => send({ type: "resign" }));
restartBtn.addEventListener("click", () => send({ type: "restart" }));
render();

function emptyState() {
    return {
        you: null,
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
        notice: null,
    };
}

function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return;

    sent = 0;
    received = 0;
    selected = null;
    pending = null;
    logEl.textContent = "";
    updateCounts();

    socket = new WebSocket(`ws://${location.host}`);
    window.socket = socket;
    connectBtn.disabled = true;
    nameInput.disabled = true;
    connEl.textContent = "opening the socket…";

    socket.addEventListener("open", () => {
        leaveBtn.disabled = false;
        connEl.textContent = "socket open, waiting for a seat…";
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
        socket = null;
        window.socket = null;
        selected = null;
        pending = null;
        banner = "";
        state = emptyState();
        connEl.textContent = "disconnected";
        connectBtn.disabled = false;
        leaveBtn.disabled = true;
        nameInput.disabled = false;
        render();
    });

    socket.addEventListener("error", () => {
        connEl.textContent = "could not reach the server";
    });
}

function apply(data) {
    if (data.type === "error") {
        banner = data.text;
        noticeEl.textContent = banner;
        return;
    }
    if (data.type !== "state") return;

    state = data;
    banner = data.notice || "";
    if (selected && !state.moves.some((move) => move.from === selected)) selected = null;
    pending = null;
    const seat = state.you === "w" ? "white" : state.you === "b" ? "black" : "watching";
    const name = state.you ? state.seats[state.you] : "";
    connEl.textContent = state.you ? `connected as ${name}, ${seat}` : "connected, watching";
    render();
}

function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify(message);
    socket.send(raw);
    sent += 1;
    updateCounts();
    writeLog("out", raw);
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
    renderSeats();
    renderHistory();
    renderPromote();

    const seated = state.you === "w" || state.you === "b";
    resignBtn.disabled = !(seated && state.status === "playing");
    restartBtn.disabled = !seated;
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
    if (state.status === "offline") return "Connect to sit down.";
    if (state.status === "waiting") return "Waiting for the second player.";
    if (state.status === "paused") return "A player left. The board stays until someone sits down.";
    if (state.status === "checkmate") return `Checkmate. ${sideName(state.winner)} wins.`;
    if (state.status === "stalemate") return "Stalemate. The game is a draw.";
    if (state.status === "draw") return `Draw by ${state.reason}.`;
    if (state.status === "resigned") return `${sideName(other(state.winner))} resigned. ${sideName(state.winner)} wins.`;
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
