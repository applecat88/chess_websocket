// Chess rules. No sockets live here.
//
// The board is 8 ranks of 8 files. Rank 0 is rank 1, so White's king starts
// on board[0][4]. Pieces are the usual letters: uppercase white, lowercase black.
// A move is { from: "e2", to: "e4", promotion: null | "q" | "r" | "b" | "n" }.

const FILES = "abcdefgh";
const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const KING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function createGame() {
    const empty = () => Array(8).fill("");
    const state = {
        board: [
            "RNBQKBNR".split(""),
            Array(8).fill("P"),
            empty(),
            empty(),
            empty(),
            empty(),
            Array(8).fill("p"),
            "rnbqkbnr".split(""),
        ],
        turn: "w",
        castling: { K: true, Q: true, k: true, q: true },
        enPassant: null,
        halfmove: 0,
        fullmove: 1,
        historyKeys: [],
        sans: [],
        last: null,
        status: "playing",
        winner: null,
        reason: null,
        check: false,
    };
    state.historyKeys.push(positionKey(state));
    evaluate(state);
    return state;
}

function fromFen(fen) {
    const [placement, turn, castling, ep, half, full] = fen.split(/\s+/);
    const board = Array.from({ length: 8 }, () => Array(8).fill(""));
    placement.split("/").forEach((row, index) => {
        let file = 0;
        const rank = 7 - index;
        for (const char of row) {
            if (/\d/.test(char)) {
                file += Number(char);
            } else {
                board[rank][file] = char;
                file += 1;
            }
        }
    });
    const state = {
        board,
        turn,
        castling: {
            K: castling.includes("K"),
            Q: castling.includes("Q"),
            k: castling.includes("k"),
            q: castling.includes("q"),
        },
        enPassant: !ep || ep === "-" ? null : ep,
        halfmove: Number(half || 0),
        fullmove: Number(full || 1),
        historyKeys: [],
        sans: [],
        last: null,
        status: "playing",
        winner: null,
        reason: null,
        check: false,
    };
    state.historyKeys.push(positionKey(state));
    evaluate(state);
    return state;
}

function applyMove(state, from, to, promotion) {
    const chosen = promotion ? String(promotion).toLowerCase() : null;
    if (chosen && !"qrbn".includes(chosen)) return null;
    const move = legalMoves(state).find((candidate) => {
        return candidate.from === from && candidate.to === to && (candidate.promotion || null) === chosen;
    });
    if (!move) return null;

    const next = applyUnchecked(clone(state), move);
    next.historyKeys.push(positionKey(next));
    evaluate(next);
    const text = san(state, move, next);
    next.last = { from, to, promotion: move.promotion, san: text };
    next.sans = state.sans.concat(text);
    return next;
}

function legalMoves(state) {
    return pseudoMoves(state).filter((move) => {
        const next = applyUnchecked(clone(state), move);
        return !kingAttacked(next, state.turn);
    });
}

function fen(state) {
    const rows = [];
    for (let rank = 7; rank >= 0; rank -= 1) {
        let row = "";
        let empty = 0;
        for (let file = 0; file < 8; file += 1) {
            const piece = state.board[rank][file];
            if (!piece) {
                empty += 1;
            } else {
                if (empty) row += empty;
                empty = 0;
                row += piece;
            }
        }
        if (empty) row += empty;
        rows.push(row);
    }
    return [
        rows.join("/"),
        state.turn,
        castleString(state),
        state.enPassant || "-",
        state.halfmove,
        state.fullmove,
    ].join(" ");
}

function rows(state) {
    const list = [];
    for (let rank = 7; rank >= 0; rank -= 1) {
        list.push(state.board[rank].map((piece) => piece || ".").join(""));
    }
    return list;
}

function pseudoMoves(state) {
    const moves = [];
    for (let rank = 0; rank < 8; rank += 1) {
        for (let file = 0; file < 8; file += 1) {
            const piece = state.board[rank][file];
            if (piece && colorOf(piece) === state.turn) {
                pieceMoves(state, file, rank, piece, moves);
            }
        }
    }
    return moves;
}

function pieceMoves(state, file, rank, piece, moves) {
    const kind = piece.toLowerCase();
    const from = square(file, rank);

    if (kind === "p") {
        const dir = piece === "P" ? 1 : -1;
        const start = piece === "P" ? 1 : 6;
        const one = rank + dir;
        if (onBoard(file, one) && !state.board[one][file]) {
            addPawn(moves, from, square(file, one), one);
            const two = rank + dir * 2;
            if (rank === start && !state.board[two][file]) {
                addPawn(moves, from, square(file, two), two);
            }
        }
        for (const df of [-1, 1]) {
            const targetFile = file + df;
            if (!onBoard(targetFile, one)) continue;
            const occupant = state.board[one][targetFile];
            const ep = square(targetFile, one) === state.enPassant;
            if ((occupant && colorOf(occupant) !== state.turn) || ep) {
                addPawn(moves, from, square(targetFile, one), one);
            }
        }
        return;
    }

    if (kind === "n") {
        for (const [df, dr] of KNIGHT) addStep(state, moves, file, rank, file + df, rank + dr);
        return;
    }

    if (kind === "k") {
        for (const [df, dr] of KING) addStep(state, moves, file, rank, file + df, rank + dr);
        castleMoves(state, file, rank, piece, moves);
        return;
    }

    const dirs = kind === "b" ? BISHOP : kind === "r" ? ROOK : BISHOP.concat(ROOK);
    for (const [df, dr] of dirs) {
        let f = file + df;
        let r = rank + dr;
        while (onBoard(f, r)) {
            const occupant = state.board[r][f];
            if (!occupant) {
                moves.push(move(from, square(f, r)));
            } else {
                if (colorOf(occupant) !== state.turn) moves.push(move(from, square(f, r)));
                break;
            }
            f += df;
            r += dr;
        }
    }
}

function castleMoves(state, file, rank, piece, moves) {
    const board = state.board;
    const enemy = piece === "K" ? "b" : "w";
    if (squareAttacked(board, file, rank, enemy)) return;

    if (piece === "K" && file === 4 && rank === 0) {
        if (state.castling.K && board[0][7] === "R" && !board[0][5] && !board[0][6]
            && !squareAttacked(board, 5, 0, enemy) && !squareAttacked(board, 6, 0, enemy)) {
            moves.push(move("e1", "g1"));
        }
        if (state.castling.Q && board[0][0] === "R" && !board[0][1] && !board[0][2] && !board[0][3]
            && !squareAttacked(board, 3, 0, enemy) && !squareAttacked(board, 2, 0, enemy)) {
            moves.push(move("e1", "c1"));
        }
    }

    if (piece === "k" && file === 4 && rank === 7) {
        if (state.castling.k && board[7][7] === "r" && !board[7][5] && !board[7][6]
            && !squareAttacked(board, 5, 7, enemy) && !squareAttacked(board, 6, 7, enemy)) {
            moves.push(move("e8", "g8"));
        }
        if (state.castling.q && board[7][0] === "r" && !board[7][1] && !board[7][2] && !board[7][3]
            && !squareAttacked(board, 3, 7, enemy) && !squareAttacked(board, 2, 7, enemy)) {
            moves.push(move("e8", "c8"));
        }
    }
}

function addStep(state, moves, file, rank, targetFile, targetRank) {
    if (!onBoard(targetFile, targetRank)) return;
    const occupant = state.board[targetRank][targetFile];
    if (occupant && colorOf(occupant) === state.turn) return;
    moves.push(move(square(file, rank), square(targetFile, targetRank)));
}

function addPawn(moves, from, to, rank) {
    if (rank === 0 || rank === 7) {
        for (const promotion of ["q", "r", "b", "n"]) moves.push({ from, to, promotion });
    } else {
        moves.push(move(from, to));
    }
}

function applyUnchecked(state, move) {
    const from = coords(move.from);
    const to = coords(move.to);
    const piece = state.board[from.rank][from.file];
    const captured = state.board[to.rank][to.file];
    const ep = piece.toLowerCase() === "p" && move.to === state.enPassant;

    state.board[from.rank][from.file] = "";
    if (ep) {
        const capturedRank = to.rank + (piece === "P" ? -1 : 1);
        state.board[capturedRank][to.file] = "";
    }

    if (piece.toLowerCase() === "k" && Math.abs(to.file - from.file) === 2) {
        const rookFrom = to.file === 6 ? 7 : 0;
        const rookTo = to.file === 6 ? 5 : 3;
        state.board[to.rank][rookTo] = state.board[to.rank][rookFrom];
        state.board[to.rank][rookFrom] = "";
    }

    if (captured) clearCastle(state, to.file, to.rank);
    clearCastle(state, from.file, from.rank);

    let placed = piece;
    if (move.promotion) placed = piece === "P" ? move.promotion.toUpperCase() : move.promotion;
    state.board[to.rank][to.file] = placed;

    const doublePush = piece.toLowerCase() === "p" && Math.abs(to.rank - from.rank) === 2;
    state.enPassant = doublePush ? square(from.file, (from.rank + to.rank) / 2) : null;

    state.halfmove = piece.toLowerCase() === "p" || captured || ep ? 0 : state.halfmove + 1;
    if (state.turn === "b") state.fullmove += 1;
    state.turn = state.turn === "w" ? "b" : "w";
    return state;
}

function clearCastle(state, file, rank) {
    if (rank === 0 && file === 4) {
        state.castling.K = false;
        state.castling.Q = false;
    }
    if (rank === 7 && file === 4) {
        state.castling.k = false;
        state.castling.q = false;
    }
    if (rank === 0 && file === 0) state.castling.Q = false;
    if (rank === 0 && file === 7) state.castling.K = false;
    if (rank === 7 && file === 0) state.castling.q = false;
    if (rank === 7 && file === 7) state.castling.k = false;
}

function evaluate(state) {
    const check = kingAttacked(state, state.turn);
    state.check = check;
    if (legalMoves(state).length === 0) {
        state.status = check ? "checkmate" : "stalemate";
        state.winner = check ? other(state.turn) : null;
        state.reason = state.status;
        return;
    }
    if (state.halfmove >= 100) return draw(state, "fifty-move rule");
    const key = positionKey(state);
    if (state.historyKeys.filter((item) => item === key).length >= 3) return draw(state, "repetition");
    if (insufficient(state)) return draw(state, "insufficient material");
    state.status = "playing";
    state.winner = null;
    state.reason = null;
}

function draw(state, reason) {
    state.status = "draw";
    state.winner = null;
    state.reason = reason;
}

function insufficient(state) {
    const minors = [];
    for (let rank = 0; rank < 8; rank += 1) {
        for (let file = 0; file < 8; file += 1) {
            const piece = state.board[rank][file];
            if (piece && piece.toLowerCase() !== "k") minors.push({ piece, file, rank });
        }
    }
    if (minors.length === 0) return true;
    if (minors.length === 1 && "bn".includes(minors[0].piece.toLowerCase())) return true;
    if (minors.length === 2 && minors.every((item) => item.piece.toLowerCase() === "b")) {
        const shade = (item) => (item.file + item.rank) % 2;
        return shade(minors[0]) === shade(minors[1]);
    }
    return false;
}

function kingAttacked(state, color) {
    const king = color === "w" ? "K" : "k";
    for (let rank = 0; rank < 8; rank += 1) {
        for (let file = 0; file < 8; file += 1) {
            if (state.board[rank][file] === king) {
                return squareAttacked(state.board, file, rank, other(color));
            }
        }
    }
    return false;
}

function squareAttacked(board, file, rank, by) {
    const pawn = by === "w" ? "P" : "p";
    const pawnFrom = by === "w" ? -1 : 1;
    for (const df of [-1, 1]) {
        const f = file + df;
        const r = rank + pawnFrom;
        if (onBoard(f, r) && board[r][f] === pawn) return true;
    }

    const knight = by === "w" ? "N" : "n";
    for (const [df, dr] of KNIGHT) {
        const f = file + df;
        const r = rank + dr;
        if (onBoard(f, r) && board[r][f] === knight) return true;
    }

    const king = by === "w" ? "K" : "k";
    for (const [df, dr] of KING) {
        const f = file + df;
        const r = rank + dr;
        if (onBoard(f, r) && board[r][f] === king) return true;
    }

    const bishop = by === "w" ? "B" : "b";
    const rook = by === "w" ? "R" : "r";
    const queen = by === "w" ? "Q" : "q";
    for (const [df, dr] of BISHOP) {
        if (rayHits(board, file, rank, df, dr, [bishop, queen])) return true;
    }
    for (const [df, dr] of ROOK) {
        if (rayHits(board, file, rank, df, dr, [rook, queen])) return true;
    }
    return false;
}

function rayHits(board, file, rank, df, dr, kinds) {
    let f = file + df;
    let r = rank + dr;
    while (onBoard(f, r)) {
        const piece = board[r][f];
        if (piece) return kinds.includes(piece);
        f += df;
        r += dr;
    }
    return false;
}

function san(before, move, after) {
    const from = coords(move.from);
    const to = coords(move.to);
    const piece = before.board[from.rank][from.file];
    const kind = piece.toLowerCase();
    const capture = !!before.board[to.rank][to.file] || (kind === "p" && move.to === before.enPassant);
    let text = "";

    if (kind === "k" && Math.abs(to.file - from.file) === 2) {
        text = to.file === 6 ? "O-O" : "O-O-O";
    } else if (kind === "p") {
        text = capture ? `${move.from[0]}x${move.to}` : move.to;
        if (move.promotion) text += `=${move.promotion.toUpperCase()}`;
    } else {
        text = kind.toUpperCase();
        text += disambiguate(before, move, kind);
        if (capture) text += "x";
        text += move.to;
    }

    if (after.status === "checkmate") text += "#";
    else if (after.check) text += "+";
    return text;
}

function disambiguate(state, move, kind) {
    const rivals = legalMoves(state).filter((candidate) => {
        if (candidate.to !== move.to || candidate.from === move.from) return false;
        const from = coords(candidate.from);
        return state.board[from.rank][from.file].toLowerCase() === kind;
    });
    if (!rivals.length) return "";
    const fileClash = rivals.some((candidate) => candidate.from[0] === move.from[0]);
    const rankClash = rivals.some((candidate) => candidate.from[1] === move.from[1]);
    if (!fileClash) return move.from[0];
    if (!rankClash) return move.from[1];
    return move.from;
}

function positionKey(state) {
    const board = state.board.map((row) => row.map((piece) => piece || ".").join("")).join("/");
    return `${board} ${state.turn} ${castleString(state)} ${state.enPassant || "-"}`;
}

function castleString(state) {
    return `${state.castling.K ? "K" : ""}${state.castling.Q ? "Q" : ""}${state.castling.k ? "k" : ""}${state.castling.q ? "q" : ""}` || "-";
}

function clone(state) {
    return {
        board: state.board.map((row) => row.slice()),
        turn: state.turn,
        castling: { ...state.castling },
        enPassant: state.enPassant,
        halfmove: state.halfmove,
        fullmove: state.fullmove,
        historyKeys: state.historyKeys.slice(),
        sans: state.sans.slice(),
        last: state.last,
        status: state.status,
        winner: state.winner,
        reason: state.reason,
        check: state.check,
    };
}

function move(from, to) {
    return { from, to, promotion: null };
}

function square(file, rank) {
    return FILES[file] + (rank + 1);
}

function coords(name) {
    return { file: FILES.indexOf(name[0]), rank: Number(name[1]) - 1 };
}

function colorOf(piece) {
    return piece.toUpperCase() === piece ? "w" : "b";
}

function other(color) {
    return color === "w" ? "b" : "w";
}

function onBoard(file, rank) {
    return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

module.exports = {
    createGame,
    fromFen,
    applyMove,
    legalMoves,
    fen,
    rows,
};
