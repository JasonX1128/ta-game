import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Server, type Socket } from "socket.io";
import {
  DEFAULT_SETTINGS,
  type Ack,
  type GameSettings,
  type Grade,
  type LeaderboardEntry,
  type PublicRoomState,
  type PublicTeam,
  type Role
} from "../shared/types.js";

type AckCallback<T extends object = Record<string, never>> = (response: Ack<T>) => void;

type SocketContext = {
  code: string;
  role: Role;
  teamId?: string;
};

type TeamRecord = {
  id: string;
  token: string;
  name: string;
  socketIds: Set<string>;
  joinOrder: number;
  usedWagers: Set<number>;
  currentWager?: number;
  currentAnswer?: string;
  currentGrade?: Grade;
  correctWagerTotal: number;
  answerPoints: number;
};

type RoomRecord = {
  code: string;
  hostToken: string;
  hostSocketIds: Set<string>;
  phase: PublicRoomState["phase"];
  settings: GameSettings;
  teams: TeamRecord[];
  currentRound: number;
  roundDurationSeconds?: number;
  roundEndsAt?: number;
  roundTimer?: NodeJS.Timeout;
  createdAt: number;
  updatedAt: number;
};

const PORT = Number(process.env.PORT ?? 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, "../client");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
});

const rooms = new Map<string, RoomRecord>();
const connections = new Map<string, SocketContext>();

function cloneSettings(settings: GameSettings = DEFAULT_SETTINGS): GameSettings {
  return {
    questionCount: settings.questionCount,
    pointsPerCorrect: settings.pointsPerCorrect,
    bonusByRank: [...settings.bonusByRank]
  };
}

function makeToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let i = 0; i < 5; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    if (!rooms.has(code)) {
      return code;
    }
  }

  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function normalizeCode(code: unknown): string {
  return String(code ?? "")
    .trim()
    .toUpperCase();
}

function fail<T extends object>(
  socket: Socket,
  ack: AckCallback<T> | undefined,
  message: string
): void {
  ack?.({ ok: false, message });
  socket.emit("room:error", { message });
}

function ok<T extends object>(ack: AckCallback<T> | undefined, payload: T): void {
  ack?.({ ok: true, ...payload });
}

function touch(room: RoomRecord): void {
  room.updatedAt = Date.now();
}

function calculateLeaderboard(room: RoomRecord): LeaderboardEntry[] {
  return [...room.teams]
    .sort((a, b) => {
      if (b.correctWagerTotal !== a.correctWagerTotal) {
        return b.correctWagerTotal - a.correctWagerTotal;
      }

      if (b.answerPoints !== a.answerPoints) {
        return b.answerPoints - a.answerPoints;
      }

      return a.joinOrder - b.joinOrder;
    })
    .map((team, index) => {
      const rankBonus = room.settings.bonusByRank[index] ?? 0;
      return {
        teamId: team.id,
        name: team.name,
        rank: index + 1,
        correctWagerTotal: team.correctWagerTotal,
        answerPoints: team.answerPoints,
        rankBonus,
        bonusPoints: team.answerPoints + rankBonus
      };
    });
}

function publicState(room: RoomRecord, context: SocketContext): PublicRoomState {
  const leaderboard = calculateLeaderboard(room);
  const leaderboardByTeam = new Map(leaderboard.map((entry) => [entry.teamId, entry]));

  const teams: PublicTeam[] = room.teams.map((team) => {
    const entry = leaderboardByTeam.get(team.id);
    const canSeeAnswer = context.role === "host" || context.teamId === team.id;

    return {
      id: team.id,
      name: team.name,
      joinOrder: team.joinOrder,
      usedWagers: [...team.usedWagers].sort((a, b) => a - b),
      currentWager: team.currentWager,
      wagerLocked: team.currentWager !== undefined,
      hasSubmittedAnswer: team.currentAnswer !== undefined,
      currentAnswer: canSeeAnswer ? team.currentAnswer : undefined,
      currentGrade: canSeeAnswer ? team.currentGrade : undefined,
      correctWagerTotal: team.correctWagerTotal,
      answerPoints: team.answerPoints,
      rankBonus: entry?.rankBonus ?? 0,
      bonusPoints: entry?.bonusPoints ?? team.answerPoints
    };
  });

  return {
    code: room.code,
    role: context.role,
    viewerTeamId: context.teamId,
    phase: room.phase,
    settings: cloneSettings(room.settings),
    teams,
    leaderboard,
    currentRound: room.currentRound,
    roundDurationSeconds: room.roundDurationSeconds,
    roundEndsAt: room.roundEndsAt,
    now: Date.now()
  };
}

function broadcastState(room: RoomRecord): void {
  const socketIds = io.sockets.adapter.rooms.get(room.code);
  if (!socketIds) {
    return;
  }

  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    const context = connections.get(socketId);

    if (socket && context) {
      socket.emit("room:state", publicState(room, context));
    }
  }
}

function removeSocketFromPreviousRoom(socket: Socket): void {
  const previous = connections.get(socket.id);
  if (!previous) {
    return;
  }

  const room = rooms.get(previous.code);
  if (room) {
    if (previous.role === "host") {
      room.hostSocketIds.delete(socket.id);
    } else if (previous.teamId) {
      const team = room.teams.find((candidate) => candidate.id === previous.teamId);
      team?.socketIds.delete(socket.id);
    }
  }

  socket.leave(previous.code);
  connections.delete(socket.id);
}

function bindSocket(socket: Socket, room: RoomRecord, context: SocketContext): void {
  removeSocketFromPreviousRoom(socket);

  connections.set(socket.id, context);
  socket.join(room.code);

  if (context.role === "host") {
    room.hostSocketIds.add(socket.id);
    return;
  }

  if (context.teamId) {
    const team = room.teams.find((candidate) => candidate.id === context.teamId);
    team?.socketIds.add(socket.id);
  }
}

function requireRoom<T extends object>(
  socket: Socket,
  ack: AckCallback<T> | undefined,
  code: unknown
): RoomRecord | undefined {
  const room = rooms.get(normalizeCode(code));
  if (!room) {
    fail(socket, ack, "Room not found.");
    return undefined;
  }

  return room;
}

function requireHost<T extends object>(
  socket: Socket,
  ack: AckCallback<T> | undefined,
  payload: { code?: unknown; hostToken?: unknown }
): RoomRecord | undefined {
  const room = requireRoom(socket, ack, payload.code);
  if (!room) {
    return undefined;
  }

  if (payload.hostToken !== room.hostToken) {
    fail(socket, ack, "Host credentials are invalid.");
    return undefined;
  }

  bindSocket(socket, room, { code: room.code, role: "host" });
  return room;
}

function requireTeam<T extends object>(
  socket: Socket,
  ack: AckCallback<T> | undefined,
  payload: { code?: unknown; teamToken?: unknown }
): { room: RoomRecord; team: TeamRecord } | undefined {
  const room = requireRoom(socket, ack, payload.code);
  if (!room) {
    return undefined;
  }

  const team = room.teams.find((candidate) => candidate.token === payload.teamToken);
  if (!team) {
    fail(socket, ack, "Team credentials are invalid.");
    return undefined;
  }

  bindSocket(socket, room, { code: room.code, role: "team", teamId: team.id });
  return { room, team };
}

function validateSettings(settings: Partial<GameSettings>): GameSettings | string {
  const questionCount = Number(settings.questionCount);
  const pointsPerCorrect = Number(settings.pointsPerCorrect);
  const bonusByRank = Array.isArray(settings.bonusByRank) ? settings.bonusByRank : [];

  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 30) {
    return "Number of questions must be a whole number from 1 to 30.";
  }

  if (!Number.isFinite(pointsPerCorrect) || pointsPerCorrect < 0 || pointsPerCorrect > 100000) {
    return "Points per correct answer must be a number from 0 to 100000.";
  }

  if (bonusByRank.length > 30) {
    return "Bonus list cannot contain more than 30 entries.";
  }

  const parsedBonuses = bonusByRank.map((value) => Number(value));
  if (parsedBonuses.some((value) => !Number.isInteger(value) || value < 0 || value > 100000)) {
    return "Bonus values must be whole numbers from 0 to 100000.";
  }

  return {
    questionCount,
    pointsPerCorrect,
    bonusByRank: parsedBonuses
  };
}

function clearRoundTimer(room: RoomRecord): void {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = undefined;
  }
}

function moveToGrading(room: RoomRecord): void {
  clearRoundTimer(room);
  room.phase = "grading";
  room.roundEndsAt = Date.now();
  touch(room);
}

function startRoundTimer(room: RoomRecord): void {
  clearRoundTimer(room);
  const delay = Math.max(0, (room.roundEndsAt ?? Date.now()) - Date.now());

  room.roundTimer = setTimeout(() => {
    if (room.phase !== "answering") {
      return;
    }

    moveToGrading(room);
    broadcastState(room);
  }, delay);

  room.roundTimer.unref?.();
}

function resetCurrentRoundFields(room: RoomRecord): void {
  room.roundDurationSeconds = undefined;
  room.roundEndsAt = undefined;
  clearRoundTimer(room);

  for (const team of room.teams) {
    team.currentWager = undefined;
    team.currentAnswer = undefined;
    team.currentGrade = undefined;
  }
}

function resetGame(room: RoomRecord): void {
  clearRoundTimer(room);
  room.phase = "lobby";
  room.currentRound = 0;
  room.roundDurationSeconds = undefined;
  room.roundEndsAt = undefined;

  for (const team of room.teams) {
    team.usedWagers.clear();
    team.currentWager = undefined;
    team.currentAnswer = undefined;
    team.currentGrade = undefined;
    team.correctWagerTotal = 0;
    team.answerPoints = 0;
  }

  touch(room);
}

io.on("connection", (socket) => {
  socket.on("room:create", (_payload: unknown, ack?: AckCallback<{ code: string; hostToken: string }>) => {
    const code = makeRoomCode();
    const room: RoomRecord = {
      code,
      hostToken: makeToken(),
      hostSocketIds: new Set(),
      phase: "lobby",
      settings: cloneSettings(),
      teams: [],
      currentRound: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    rooms.set(code, room);
    bindSocket(socket, room, { code, role: "host" });
    ok(ack, { code, hostToken: room.hostToken });
    broadcastState(room);
  });

  socket.on(
    "room:join",
    (
      payload: { code?: unknown; name?: unknown },
      ack?: AckCallback<{ code: string; teamId: string; teamToken: string }>
    ) => {
      const room = requireRoom(socket, ack, payload.code);
      if (!room) {
        return;
      }

      if (room.phase !== "lobby") {
        fail(socket, ack, "This room is already in a game.");
        return;
      }

      const name = String(payload.name ?? "").trim().slice(0, 32);
      if (!name) {
        fail(socket, ack, "Team name is required.");
        return;
      }

      if (room.teams.some((team) => team.name.toLowerCase() === name.toLowerCase())) {
        fail(socket, ack, "That team name is already taken.");
        return;
      }

      const team: TeamRecord = {
        id: crypto.randomUUID(),
        token: makeToken(),
        name,
        socketIds: new Set(),
        joinOrder: room.teams.length,
        usedWagers: new Set(),
        correctWagerTotal: 0,
        answerPoints: 0
      };

      room.teams.push(team);
      touch(room);
      bindSocket(socket, room, { code: room.code, role: "team", teamId: team.id });
      ok(ack, { code: room.code, teamId: team.id, teamToken: team.token });
      broadcastState(room);
    }
  );

  socket.on(
    "room:rejoin",
    (
      payload: { code?: unknown; role?: Role; hostToken?: unknown; teamToken?: unknown },
      ack?: AckCallback<{ code: string; role: Role; teamId?: string }>
    ) => {
      const room = requireRoom(socket, ack, payload.code);
      if (!room) {
        return;
      }

      if (payload.role === "host" && payload.hostToken === room.hostToken) {
        bindSocket(socket, room, { code: room.code, role: "host" });
        ok(ack, { code: room.code, role: "host" });
        socket.emit("room:state", publicState(room, { code: room.code, role: "host" }));
        return;
      }

      if (payload.role === "team") {
        const team = room.teams.find((candidate) => candidate.token === payload.teamToken);
        if (team) {
          bindSocket(socket, room, { code: room.code, role: "team", teamId: team.id });
          ok(ack, { code: room.code, role: "team", teamId: team.id });
          socket.emit("room:state", publicState(room, { code: room.code, role: "team", teamId: team.id }));
          return;
        }
      }

      fail(socket, ack, "Saved room credentials are no longer valid.");
    }
  );

  socket.on(
    "settings:update",
    (payload: { code?: unknown; hostToken?: unknown; settings?: Partial<GameSettings> }, ack?: AckCallback) => {
      const room = requireHost(socket, ack, payload);
      if (!room) {
        return;
      }

      if (room.phase !== "lobby") {
        fail(socket, ack, "Settings can only be changed in the lobby.");
        return;
      }

      const validated = validateSettings(payload.settings ?? {});
      if (typeof validated === "string") {
        fail(socket, ack, validated);
        return;
      }

      room.settings = validated;
      touch(room);
      ok(ack, {});
      broadcastState(room);
    }
  );

  socket.on("game:start", (payload: { code?: unknown; hostToken?: unknown }, ack?: AckCallback) => {
    const room = requireHost(socket, ack, payload);
    if (!room) {
      return;
    }

    if (room.phase !== "lobby") {
      fail(socket, ack, "The game has already started.");
      return;
    }

    if (room.teams.length === 0) {
      fail(socket, ack, "At least one team must join before starting.");
      return;
    }

    for (const team of room.teams) {
      team.usedWagers.clear();
      team.currentWager = undefined;
      team.currentAnswer = undefined;
      team.currentGrade = undefined;
      team.correctWagerTotal = 0;
      team.answerPoints = 0;
    }

    room.currentRound = 1;
    room.phase = "round_setup";
    room.roundDurationSeconds = undefined;
    room.roundEndsAt = undefined;
    touch(room);
    ok(ack, {});
    broadcastState(room);
  });

  socket.on(
    "wager:submit",
    (payload: { code?: unknown; teamToken?: unknown; wager?: unknown }, ack?: AckCallback) => {
      const result = requireTeam(socket, ack, payload);
      if (!result) {
        return;
      }

      const { room, team } = result;
      if (room.phase !== "round_setup") {
        fail(socket, ack, "Wagers are closed right now.");
        return;
      }

      if (team.currentWager !== undefined) {
        fail(socket, ack, "Your wager is already locked for this round.");
        return;
      }

      const wager = Number(payload.wager);
      if (!Number.isInteger(wager) || wager < 1 || wager > room.settings.questionCount) {
        fail(socket, ack, `Choose a wager from 1 to ${room.settings.questionCount}.`);
        return;
      }

      if (team.usedWagers.has(wager)) {
        fail(socket, ack, "That wager has already been used.");
        return;
      }

      team.currentWager = wager;
      touch(room);
      ok(ack, {});
      broadcastState(room);
    }
  );

  socket.on(
    "round:startAnswering",
    (
      payload: { code?: unknown; hostToken?: unknown; durationMinutes?: unknown },
      ack?: AckCallback
    ) => {
      const room = requireHost(socket, ack, payload);
      if (!room) {
        return;
      }

      if (room.phase !== "round_setup") {
        fail(socket, ack, "This round is not ready for answers.");
        return;
      }

      if (room.teams.some((team) => team.currentWager === undefined)) {
        fail(socket, ack, "Every team must lock a wager first.");
        return;
      }

      const durationMinutes = Number(payload.durationMinutes);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 180) {
        fail(socket, ack, "Timer must be greater than 0 and no more than 180 minutes.");
        return;
      }

      const durationSeconds = Math.max(1, Math.round(durationMinutes * 60));
      room.phase = "answering";
      room.roundDurationSeconds = durationSeconds;
      room.roundEndsAt = Date.now() + durationSeconds * 1000;

      for (const team of room.teams) {
        team.currentAnswer = undefined;
        team.currentGrade = undefined;
      }

      startRoundTimer(room);
      touch(room);
      ok(ack, {});
      broadcastState(room);
    }
  );

  socket.on(
    "answer:submit",
    (payload: { code?: unknown; teamToken?: unknown; answer?: unknown }, ack?: AckCallback) => {
      const result = requireTeam(socket, ack, payload);
      if (!result) {
        return;
      }

      const { room, team } = result;
      if (room.phase !== "answering") {
        fail(socket, ack, "Answers are closed right now.");
        return;
      }

      if ((room.roundEndsAt ?? 0) <= Date.now()) {
        moveToGrading(room);
        fail(socket, ack, "Time is up.");
        broadcastState(room);
        return;
      }

      if (team.currentAnswer !== undefined) {
        fail(socket, ack, "Your answer is already locked.");
        return;
      }

      const answer = String(payload.answer ?? "").trim();
      if (!answer) {
        fail(socket, ack, "Answer cannot be empty.");
        return;
      }

      if (answer.length > 1000) {
        fail(socket, ack, "Answer must be 1000 characters or fewer.");
        return;
      }

      team.currentAnswer = answer;

      if (room.teams.every((candidate) => candidate.currentAnswer !== undefined)) {
        moveToGrading(room);
      } else {
        touch(room);
      }

      ok(ack, {});
      broadcastState(room);
    }
  );

  socket.on(
    "answer:grade",
    (
      payload: { code?: unknown; hostToken?: unknown; grades?: Record<string, Grade> },
      ack?: AckCallback
    ) => {
      const room = requireHost(socket, ack, payload);
      if (!room) {
        return;
      }

      if (room.phase !== "grading") {
        fail(socket, ack, "There are no answers ready to grade.");
        return;
      }

      const grades = payload.grades ?? {};
      for (const team of room.teams) {
        const grade = grades[team.id];
        if (grade !== "correct" && grade !== "incorrect") {
          fail(socket, ack, `Grade ${team.name} before submitting.`);
          return;
        }
      }

      for (const team of room.teams) {
        const grade = grades[team.id];
        const wager = team.currentWager;
        team.currentGrade = grade;

        if (wager !== undefined) {
          team.usedWagers.add(wager);
          if (grade === "correct") {
            team.correctWagerTotal += wager;
            team.answerPoints += room.settings.pointsPerCorrect;
          }
        }

        team.currentWager = undefined;
        team.currentAnswer = undefined;
        team.currentGrade = undefined;
      }

      resetCurrentRoundFields(room);

      if (room.currentRound >= room.settings.questionCount) {
        room.phase = "finished";
      } else {
        room.phase = "between_rounds";
      }

      touch(room);
      ok(ack, {});
      broadcastState(room);
    }
  );

  socket.on("round:advance", (payload: { code?: unknown; hostToken?: unknown }, ack?: AckCallback) => {
    const room = requireHost(socket, ack, payload);
    if (!room) {
      return;
    }

    if (room.phase !== "between_rounds") {
      fail(socket, ack, "The next round is not available yet.");
      return;
    }

    room.currentRound += 1;
    room.phase = "round_setup";
    resetCurrentRoundFields(room);
    touch(room);
    ok(ack, {});
    broadcastState(room);
  });

  socket.on("game:reset", (payload: { code?: unknown; hostToken?: unknown }, ack?: AckCallback) => {
    const room = requireHost(socket, ack, payload);
    if (!room) {
      return;
    }

    resetGame(room);
    ok(ack, {});
    broadcastState(room);
  });

  socket.on("disconnect", () => {
    const previous = connections.get(socket.id);
    removeSocketFromPreviousRoom(socket);

    if (previous) {
      const room = rooms.get(previous.code);
      if (room) {
        broadcastState(room);
      }
    }
  });
});

app.get("/healthz", (_request, response) => {
  response.json({ ok: true });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientDist));
  app.use((request, response, next) => {
    if (request.method === "GET" && !request.path.startsWith("/socket.io")) {
      response.sendFile(path.join(clientDist, "index.html"));
      return;
    }

    next();
  });
}

httpServer.listen(PORT, () => {
  console.log(`TA Game server listening on ${PORT}`);
});
