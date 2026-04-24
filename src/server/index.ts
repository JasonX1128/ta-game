import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Server, type Socket } from "socket.io";
import {
  DEFAULT_SETTINGS,
  type Ack,
  type AnswerRevealMode,
  type GameSettings,
  type Grade,
  type GradeSuggestion,
  type LeaderboardEntry,
  type Question,
  type PublicRoomState,
  type PublicTeam,
  type RoundHistoryEntry,
  type Role,
  type ScoreAdjustment
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
  scoreAdjustment: number;
  bonusAdjustment: number;
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
  gradeSuggestionCache?: {
    round: number;
    promise?: Promise<GradeSuggestion[]>;
    suggestions?: GradeSuggestion[];
  };
  history: RoundHistoryEntry[];
  adjustments: ScoreAdjustment[];
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
  maxHttpBufferSize: 15_000_000,
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
    bonusByRank: [...settings.bonusByRank],
    questions: settings.questions.map((question) => ({ ...question })),
    scrambleQuestionOrder: settings.scrambleQuestionOrder,
    answerRevealMode: settings.answerRevealMode,
    hideLeaderboardDuringAnswering: settings.hideLeaderboardDuringAnswering,
    llmGradingEnabled: settings.llmGradingEnabled
  };
}

function publicSettings(room: RoomRecord, context: SocketContext): GameSettings {
  const settings = cloneSettings(room.settings);
  if (context.role === "host") {
    return settings;
  }

  settings.questions = settings.questions.map((question, index) => {
    const roundNumber = index + 1;
    const answerIsReleased =
      roundNumber < room.currentRound ||
      (roundNumber === room.currentRound && ["between_rounds", "finished"].includes(room.phase));

    if (answerIsReleased) {
      return question;
    }

    const { answer: _answer, ...questionWithoutAnswer } = question;
    return questionWithoutAnswer;
  });

  return settings;
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

function adjustedScore(team: TeamRecord): number {
  return team.correctWagerTotal + team.scoreAdjustment;
}

function adjustedBonusBase(team: TeamRecord): number {
  return team.answerPoints + team.bonusAdjustment;
}

function calculateLeaderboard(room: RoomRecord): LeaderboardEntry[] {
  return [...room.teams]
    .sort((a, b) => {
      if (adjustedScore(b) !== adjustedScore(a)) {
        return adjustedScore(b) - adjustedScore(a);
      }

      if (adjustedBonusBase(b) !== adjustedBonusBase(a)) {
        return adjustedBonusBase(b) - adjustedBonusBase(a);
      }

      return a.joinOrder - b.joinOrder;
    })
    .map((team, index) => {
      const rankBonus = room.settings.bonusByRank[index] ?? 0;
      return {
        teamId: team.id,
        name: team.name,
        rank: index + 1,
        correctWagerTotal: adjustedScore(team),
        answerPoints: team.answerPoints,
        scoreAdjustment: team.scoreAdjustment,
        bonusAdjustment: team.bonusAdjustment,
        rankBonus,
        bonusPoints: adjustedBonusBase(team) + rankBonus
      };
    });
}

function publicHistory(room: RoomRecord, context: SocketContext): RoundHistoryEntry[] {
  if (context.role === "host") {
    return room.history;
  }

  return room.history.map((entry) => ({
    ...entry,
    results: entry.results.flatMap((result) => {
      const isOwnTeam = result.teamId === context.teamId;

      if (room.settings.answerRevealMode === "after_grading" || isOwnTeam) {
        return [isOwnTeam ? result : { ...result, aiFeedback: undefined }];
      }

      if (room.settings.answerRevealMode === "status_only") {
        return [{
          ...result,
          answer: undefined,
          aiFeedback: undefined
        }];
      }

      return [];
    })
  }));
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
      connected: team.socketIds.size > 0,
      usedWagers: [...team.usedWagers].sort((a, b) => a - b),
      currentWager: team.currentWager,
      wagerLocked: team.currentWager !== undefined,
      hasSubmittedAnswer: team.currentAnswer !== undefined,
      currentAnswer: canSeeAnswer ? team.currentAnswer : undefined,
      currentGrade: canSeeAnswer ? team.currentGrade : undefined,
      correctWagerTotal: adjustedScore(team),
      answerPoints: team.answerPoints,
      scoreAdjustment: team.scoreAdjustment,
      bonusAdjustment: team.bonusAdjustment,
      rankBonus: entry?.rankBonus ?? 0,
      bonusPoints: entry?.bonusPoints ?? adjustedBonusBase(team)
    };
  });

  return {
    code: room.code,
    role: context.role,
    viewerTeamId: context.teamId,
    phase: room.phase,
    settings: publicSettings(room, context),
    teams,
    leaderboard,
    history: publicHistory(room, context),
    adjustments: context.role === "host" ? room.adjustments : room.adjustments.filter((item) => item.teamId === context.teamId),
    currentRound: room.currentRound,
    roundDurationSeconds: room.roundDurationSeconds,
    roundEndsAt: room.roundEndsAt,
    now: Date.now()
  };
}

function broadcastState(room: RoomRecord): void {
  const socketIds = new Set([
    ...(io.sockets.adapter.rooms.get(room.code) ?? []),
    ...room.hostSocketIds,
    ...room.teams.flatMap((team) => [...team.socketIds])
  ]);

  if (socketIds.size === 0) {
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
  const previous = connections.get(socket.id);
  if (previous?.code === context.code && previous.role === context.role && previous.teamId === context.teamId) {
    socket.join(room.code);
    if (context.role === "host") {
      room.hostSocketIds.add(socket.id);
    } else if (context.teamId) {
      const team = room.teams.find((candidate) => candidate.id === context.teamId);
      team?.socketIds.add(socket.id);
    }
    return;
  }

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

function validateQuestion(rawQuestion: unknown, index: number): Question | string {
  if (!rawQuestion || typeof rawQuestion !== "object") {
    return `Question ${index + 1} must be an object.`;
  }

  const candidate = rawQuestion as Partial<Question>;
  const text = String(candidate.text ?? "").trim();
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const codeLanguage =
    typeof candidate.codeLanguage === "string" ? candidate.codeLanguage.trim().slice(0, 32) : undefined;
  const minutes = candidate.minutes === undefined ? undefined : Number(candidate.minutes);
  const answer = typeof candidate.answer === "string" ? candidate.answer.trim() : undefined;
  const imageDataUrl = typeof candidate.imageDataUrl === "string" ? candidate.imageDataUrl : undefined;
  const imageName = typeof candidate.imageName === "string" ? candidate.imageName.trim().slice(0, 140) : undefined;
  const imageAlt = typeof candidate.imageAlt === "string" ? candidate.imageAlt.trim().slice(0, 180) : undefined;

  if (!text) {
    return `Question ${index + 1} needs text.`;
  }

  if (text.length > 5000) {
    return `Question ${index + 1} text must be 5000 characters or fewer.`;
  }

  if (code && code.length > 20000) {
    return `Question ${index + 1} code must be 20000 characters or fewer.`;
  }

  if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 180)) {
    return `Question ${index + 1} minutes must be greater than 0 and no more than 180.`;
  }

  if (answer && answer.length > 10000) {
    return `Question ${index + 1} answer must be 10000 characters or fewer.`;
  }

  if (imageDataUrl) {
    if (!/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(imageDataUrl)) {
      return `Question ${index + 1} image must be a PNG, JPG, GIF, WebP, or SVG data URL.`;
    }

    if (imageDataUrl.length > 4_000_000) {
      return `Question ${index + 1} image is too large.`;
    }
  }

  return {
    text,
    code: code || undefined,
    codeLanguage: codeLanguage || undefined,
    minutes,
    answer: answer || undefined,
    imageDataUrl,
    imageName,
    imageAlt
  };
}

function validateQuestions(rawQuestions: unknown): Question[] | string {
  if (rawQuestions === undefined) {
    return [];
  }

  if (!Array.isArray(rawQuestions)) {
    return "Questions must be an array.";
  }

  if (rawQuestions.length > 30) {
    return "Question uploads cannot contain more than 30 questions.";
  }

  const questions: Question[] = [];
  let totalImageBytes = 0;

  for (const [index, rawQuestion] of rawQuestions.entries()) {
    const question = validateQuestion(rawQuestion, index);
    if (typeof question === "string") {
      return question;
    }

    totalImageBytes += question.imageDataUrl?.length ?? 0;
    questions.push(question);
  }

  if (totalImageBytes > 12_000_000) {
    return "Uploaded question images are too large in total.";
  }

  return questions;
}

function validateSettings(settings: Partial<GameSettings>): GameSettings | string {
  const questionCount = Number(settings.questionCount);
  const pointsPerCorrect = Number(settings.pointsPerCorrect);
  const bonusByRank = Array.isArray(settings.bonusByRank) ? settings.bonusByRank : [];
  const answerRevealMode = String(settings.answerRevealMode ?? DEFAULT_SETTINGS.answerRevealMode);
  const scrambleQuestionOrder = Boolean(settings.scrambleQuestionOrder);
  const hideLeaderboardDuringAnswering = Boolean(settings.hideLeaderboardDuringAnswering);
  const llmGradingEnabled = Boolean(settings.llmGradingEnabled);
  const questions = validateQuestions(settings.questions);

  if (typeof questions === "string") {
    return questions;
  }

  const nextQuestionCount = questions.length > 0 ? questions.length : questionCount;

  if (!Number.isInteger(nextQuestionCount) || nextQuestionCount < 1 || nextQuestionCount > 30) {
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

  if (!["host_only", "after_grading", "status_only"].includes(answerRevealMode)) {
    return "Answer reveal mode is invalid.";
  }

  return {
    questionCount: nextQuestionCount,
    pointsPerCorrect,
    bonusByRank: parsedBonuses,
    questions,
    scrambleQuestionOrder,
    answerRevealMode: answerRevealMode as AnswerRevealMode,
    hideLeaderboardDuringAnswering,
    llmGradingEnabled
  };
}

function validateLlmGradingUnlock(room: RoomRecord, enabled: boolean, password: unknown): string | undefined {
  if (!enabled || room.settings.llmGradingEnabled) {
    return undefined;
  }

  const configuredPassword = process.env.LLM_GRADING_PASSWORD;
  if (!configuredPassword) {
    return "LLM_GRADING_PASSWORD is not configured on the server.";
  }

  if (String(password ?? "") !== configuredPassword) {
    return "LLM grading password is incorrect.";
  }

  return undefined;
}

function extractGemmaText(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const candidates = (response as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return undefined;
  }

  return candidates
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return [];
      }

      const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
      if (!Array.isArray(parts)) {
        return [];
      }

      return parts
        .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : undefined))
        .filter((text): text is string => typeof text === "string");
    })
    .join("\n");
}

function parseGemmaSuggestions(rawText: string, validTeamIds: Set<string>): GradeSuggestion[] {
  const trimmed = rawText.trim();
  const jsonText = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const parsed = JSON.parse(jsonText) as unknown;

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { suggestions?: unknown }).suggestions)) {
    throw new Error("AI response did not include a suggestions array.");
  }

  return (parsed as { suggestions: unknown[] }).suggestions.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as {
      teamId?: unknown;
      grade?: unknown;
      confidence?: unknown;
      rationale?: unknown;
      feedback?: unknown;
    };
    const teamId = typeof candidate.teamId === "string" ? candidate.teamId : "";
    const grade = candidate.grade;
    if (!validTeamIds.has(teamId) || (grade !== "correct" && grade !== "incorrect")) {
      return [];
    }

    const confidence = Number(candidate.confidence);
    const feedback = typeof candidate.feedback === "string"
      ? candidate.feedback
      : typeof candidate.rationale === "string"
        ? candidate.rationale
        : undefined;

    return [{
      teamId,
      grade,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined,
      rationale: typeof candidate.rationale === "string" ? candidate.rationale.slice(0, 300) : undefined,
      feedback: feedback?.slice(0, 800)
    }];
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestGemmaGradeSuggestions(room: RoomRecord): Promise<GradeSuggestion[]> {
  const apiKey = process.env.GEMMA_API_KEY;
  if (!apiKey) {
    throw new Error("GEMMA_API_KEY is not configured.");
  }

  const model = process.env.GEMMA_MODEL || "gemma-4-31b-it";
  const apiBase = process.env.GEMMA_API_BASE || "https://generativelanguage.googleapis.com/v1beta";
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const question = room.settings.questions[room.currentRound - 1];
  const teams = room.teams.map((team) => ({
    teamId: team.id,
    teamName: team.name,
    wager: team.currentWager ?? null,
    studentAnswer: team.currentAnswer ?? ""
  }));
  const validTeamIds = new Set(teams.map((team) => team.teamId));
  const prompt = [
    "You are helping a human host grade a classroom game.",
    "Use the question, official answer, optional code block, and each team's student answer.",
    "Suggest whether each answer should be marked correct or incorrect.",
    "Be conservative: mark correct only when the student answer substantially matches the official answer.",
    "Also write feedback for each team that will be shown directly to that team after grades are finalized.",
    "Student-facing feedback should be concise, constructive, and explain what was right or missing without mentioning internal confidence.",
    "Return only JSON matching this schema:",
    '{"suggestions":[{"teamId":"string","grade":"correct|incorrect","confidence":0.0,"rationale":"short host-only explanation","feedback":"student-facing feedback"}]}',
    "Do not include markdown or commentary outside JSON.",
    "",
    JSON.stringify({
      round: room.currentRound,
      question: {
        text: question?.text ?? "",
        codeLanguage: question?.codeLanguage ?? "",
        code: question?.code ?? "",
        officialAnswer: question?.answer ?? ""
      },
      teams
    })
  ].join("\n");

  const url = `${apiBase.replace(/\/$/, "")}/${modelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const responseSchema = {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            teamId: { type: "string" },
            grade: { type: "string", enum: ["correct", "incorrect"] },
            confidence: { type: "number" },
            rationale: { type: "string" },
            feedback: { type: "string" }
          },
          required: ["teamId", "grade", "feedback"]
        }
      }
    },
    required: ["suggestions"]
  };

  async function postGemma(includeSchema: boolean): Promise<{ ok: true; data: unknown } | { ok: false; status: number; text: string }> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          ...(includeSchema ? { responseJsonSchema: responseSchema } : {})
        }
      })
    });

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, text };
    }

    try {
      return { ok: true, data: JSON.parse(text) as unknown };
    } catch {
      throw new Error("Gemma response was not valid JSON.");
    }
  }

  async function postGemmaWithRetry(includeSchema: boolean): Promise<
    { ok: true; data: unknown } | { ok: false; status: number; text: string }
  > {
    const delays = [700, 1600];

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const result = await postGemma(includeSchema);
      if (result.ok || ![429, 500, 502, 503, 504].includes(result.status) || attempt === delays.length) {
        return result;
      }

      await wait(delays[attempt]);
    }

    return postGemma(includeSchema);
  }

  let result = await postGemmaWithRetry(true);
  if (
    !result.ok &&
    result.status === 400 &&
    /schema|responseJsonSchema|unsupported|unknown field|invalid/i.test(result.text)
  ) {
    result = await postGemmaWithRetry(false);
  }

  if (!result.ok) {
    throw new Error(`Gemma request failed (${result.status}): ${result.text.slice(0, 300)}`);
  }

  const text = extractGemmaText(result.data);
  if (!text) {
    throw new Error("Gemma response did not contain text.");
  }

  return parseGemmaSuggestions(text, validTeamIds);
}

async function cachedGemmaGradeSuggestions(room: RoomRecord): Promise<GradeSuggestion[]> {
  const cached = room.gradeSuggestionCache;
  if (cached?.round === room.currentRound) {
    if (cached.suggestions) {
      return cached.suggestions;
    }

    if (cached.promise) {
      return cached.promise;
    }
  }

  const round = room.currentRound;
  const promise = requestGemmaGradeSuggestions(room);
  room.gradeSuggestionCache = { round, promise };

  try {
    const suggestions = await promise;
    if (room.gradeSuggestionCache?.round === round && room.currentRound === round) {
      room.gradeSuggestionCache = { round, suggestions };
    }
    return suggestions;
  } catch (error) {
    if (room.gradeSuggestionCache?.round === round && room.gradeSuggestionCache.promise === promise) {
      room.gradeSuggestionCache = undefined;
    }
    throw error;
  }
}

async function gradeSuggestionsForFinalResults(room: RoomRecord): Promise<Map<string, GradeSuggestion>> {
  if (!room.settings.llmGradingEnabled) {
    return new Map();
  }

  try {
    const suggestions = await cachedGemmaGradeSuggestions(room);
    return new Map(suggestions.map((suggestion) => [suggestion.teamId, suggestion]));
  } catch {
    return new Map();
  }
}

function updateRoundResultGrade(room: RoomRecord, team: TeamRecord, result: RoundHistoryEntry["results"][number], grade: Grade): void {
  const previousScoreDelta = result.scoreDelta;
  const previousBonusDelta = result.bonusDelta;
  const nextScoreDelta = grade === "correct" ? result.wager ?? 0 : 0;
  const nextBonusDelta = grade === "correct" ? room.settings.pointsPerCorrect : 0;

  result.grade = grade;
  result.scoreDelta = nextScoreDelta;
  result.bonusDelta = nextBonusDelta;
  team.correctWagerTotal += nextScoreDelta - previousScoreDelta;
  team.answerPoints += nextBonusDelta - previousBonusDelta;
}

function lowestAvailableWager(room: RoomRecord, team: TeamRecord): number | undefined {
  for (let value = 1; value <= room.settings.questionCount; value += 1) {
    if (!team.usedWagers.has(value)) {
      return value;
    }
  }

  return undefined;
}

function shuffledQuestions(questions: Question[]): Question[] {
  const next = questions.map((question) => ({ ...question }));
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }

  return next;
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
  room.gradeSuggestionCache = undefined;
  if (room.settings.llmGradingEnabled) {
    void cachedGemmaGradeSuggestions(room).catch(() => undefined);
  }
  touch(room);
}

function finishGameEarly(room: RoomRecord): void {
  resetCurrentRoundFields(room);
  room.phase = "finished";
  room.roundDurationSeconds = undefined;
  room.roundEndsAt = undefined;
  room.gradeSuggestionCache = undefined;
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
    team.scoreAdjustment = 0;
    team.bonusAdjustment = 0;
  }

  room.history = [];
  room.adjustments = [];
  room.gradeSuggestionCache = undefined;

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
      history: [],
      adjustments: [],
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
        answerPoints: 0,
        scoreAdjustment: 0,
        bonusAdjustment: 0
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
    (
      payload: {
        code?: unknown;
        hostToken?: unknown;
        settings?: Partial<GameSettings>;
        llmGradingPassword?: unknown;
      },
      ack?: AckCallback
    ) => {
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

      const llmUnlockError = validateLlmGradingUnlock(room, validated.llmGradingEnabled, payload.llmGradingPassword);
      if (llmUnlockError) {
        fail(socket, ack, llmUnlockError);
        return;
      }

      room.settings = validated;
      touch(room);
      ok(ack, {});
      broadcastState(room);
    }
  );

  socket.on(
    "team:remove",
    (payload: { code?: unknown; hostToken?: unknown; teamId?: unknown }, ack?: AckCallback) => {
      const room = requireHost(socket, ack, payload);
      if (!room) {
        return;
      }

      if (room.phase !== "lobby") {
        fail(socket, ack, "Teams can only be removed in the lobby.");
        return;
      }

      const teamIndex = room.teams.findIndex((team) => team.id === payload.teamId);
      if (teamIndex === -1) {
        fail(socket, ack, "Team not found.");
        return;
      }

      const [team] = room.teams.splice(teamIndex, 1);
      for (const socketId of team.socketIds) {
        const teamSocket = io.sockets.sockets.get(socketId);
        connections.delete(socketId);
        teamSocket?.leave(room.code);
        teamSocket?.emit("room:error", { message: "Your team was removed by the host." });
      }

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
      team.scoreAdjustment = 0;
      team.bonusAdjustment = 0;
    }

    room.history = [];
    room.adjustments = [];
    room.gradeSuggestionCache = undefined;
    if (room.settings.scrambleQuestionOrder && room.settings.questions.length > 1) {
      room.settings = {
        ...room.settings,
        questions: shuffledQuestions(room.settings.questions)
      };
    }
    room.currentRound = 1;
    room.phase = "round_setup";
    room.roundDurationSeconds = undefined;
    room.roundEndsAt = undefined;
    touch(room);
    ok(ack, {});
    broadcastState(room);
  });

  socket.on("game:endEarly", (payload: { code?: unknown; hostToken?: unknown }, ack?: AckCallback) => {
    const room = requireHost(socket, ack, payload);
    if (!room) {
      return;
    }

    if (room.phase === "lobby") {
      fail(socket, ack, "Start the game before ending it.");
      return;
    }

    if (room.phase === "finished") {
      ok(ack, {});
      socket.emit("room:state", publicState(room, { code: room.code, role: "host" }));
      return;
    }

    finishGameEarly(room);
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
    "score:adjust",
    (
      payload: {
        code?: unknown;
        hostToken?: unknown;
        teamId?: unknown;
        scoreDelta?: unknown;
        bonusDelta?: unknown;
        note?: unknown;
      },
      ack?: AckCallback
    ) => {
      const room = requireHost(socket, ack, payload);
      if (!room) {
        return;
      }

      if (room.phase === "lobby") {
        fail(socket, ack, "Start the game before adjusting scores.");
        return;
      }

      const team = room.teams.find((candidate) => candidate.id === payload.teamId);
      if (!team) {
        fail(socket, ack, "Team not found.");
        return;
      }

      const scoreDelta = Number(payload.scoreDelta ?? 0);
      const bonusDelta = Number(payload.bonusDelta ?? 0);
      const note = String(payload.note ?? "").trim().slice(0, 180);

      if (!Number.isFinite(scoreDelta) || !Number.isFinite(bonusDelta)) {
        fail(socket, ack, "Adjustments must be numbers.");
        return;
      }

      if (scoreDelta === 0 && bonusDelta === 0) {
        fail(socket, ack, "Enter a score or bonus adjustment.");
        return;
      }

      team.scoreAdjustment += scoreDelta;
      team.bonusAdjustment += bonusDelta;
      room.adjustments.push({
        id: crypto.randomUUID(),
        teamId: team.id,
        teamName: team.name,
        scoreDelta,
        bonusDelta,
        note,
        createdAt: Date.now()
      });

      touch(room);
      ok(ack, {});
      broadcastState(room);
    }
  );

  socket.on(
    "round:startAnswering",
    (
      payload: { code?: unknown; hostToken?: unknown; durationMinutes?: unknown; forceMissingWagers?: unknown },
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

      const missingWagerTeams = room.teams.filter((team) => team.currentWager === undefined);
      if (missingWagerTeams.length > 0 && payload.forceMissingWagers !== true) {
        fail(socket, ack, "Every team must lock a wager first.");
        return;
      }

      const durationMinutes = Number(payload.durationMinutes);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 180) {
        fail(socket, ack, "Timer must be greater than 0 and no more than 180 minutes.");
        return;
      }

      for (const team of missingWagerTeams) {
        const forcedWager = lowestAvailableWager(room, team);
        if (forcedWager === undefined) {
          fail(socket, ack, `${team.name} has no available wagers left.`);
          return;
        }

        team.currentWager = forcedWager;
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

  socket.on("round:stopAnswering", (payload: { code?: unknown; hostToken?: unknown }, ack?: AckCallback) => {
    const room = requireHost(socket, ack, payload);
    if (!room) {
      return;
    }

    if (room.phase !== "answering") {
      fail(socket, ack, "The answer timer is not running.");
      return;
    }

    moveToGrading(room);
    ok(ack, {});
    broadcastState(room);
  });

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

      const answer = String(payload.answer ?? "");
      if (!answer.trim()) {
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
    "grading:suggest",
    async (payload: { code?: unknown; hostToken?: unknown }, ack?: AckCallback<{ suggestions: GradeSuggestion[] }>) => {
      const room = requireHost(socket, ack, payload);
      if (!room) {
        return;
      }

      if (room.phase !== "grading") {
        fail(socket, ack, "AI suggestions are available while grading answers.");
        return;
      }

      if (!room.settings.llmGradingEnabled) {
        fail(socket, ack, "LLM grading suggestions are disabled for this room.");
        return;
      }

      try {
        const suggestions = await cachedGemmaGradeSuggestions(room);
        ok(ack, { suggestions });
      } catch (error) {
        fail(socket, ack, error instanceof Error ? error.message : "Could not get AI grade suggestions.");
      }
    }
  );

  socket.on(
    "answer:grade",
    async (
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

      const results: RoundHistoryEntry["results"] = [];
      const gemmaSuggestions = await gradeSuggestionsForFinalResults(room);

      for (const team of room.teams) {
        const grade = grades[team.id];
        const wager = team.currentWager;
        const scoreDelta = grade === "correct" && wager !== undefined ? wager : 0;
        const bonusDelta = grade === "correct" ? room.settings.pointsPerCorrect : 0;
        const aiFeedback = gemmaSuggestions.get(team.id)?.feedback?.trim();

        results.push({
          teamId: team.id,
          teamName: team.name,
          wager,
          answer: team.currentAnswer,
          grade,
          scoreDelta,
          bonusDelta,
          aiFeedback: aiFeedback || undefined
        });

        if (wager !== undefined) {
          team.usedWagers.add(wager);
          if (grade === "correct") {
            team.correctWagerTotal += scoreDelta;
            team.answerPoints += bonusDelta;
          }
        }
      }

      room.history.push({
        round: room.currentRound,
        question: room.settings.questions[room.currentRound - 1],
        durationSeconds: room.roundDurationSeconds,
        gradedAt: Date.now(),
        results
      });

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

  socket.on(
    "protest:submit",
    (payload: { code?: unknown; teamToken?: unknown; text?: unknown }, ack?: AckCallback) => {
      const result = requireTeam(socket, ack, payload);
      if (!result) {
        return;
      }

      const { room, team } = result;
      if (room.phase !== "between_rounds" && room.phase !== "finished") {
        fail(socket, ack, "Protests open after grades are finalized.");
        return;
      }

      const text = String(payload.text ?? "").trim();
      if (!text) {
        fail(socket, ack, "Protest text is required.");
        return;
      }

      if (text.length > 1000) {
        fail(socket, ack, "Protest must be 1000 characters or fewer.");
        return;
      }

      const historyEntry = room.history.find((entry) => entry.round === room.currentRound);
      const teamResult = historyEntry?.results.find((entry) => entry.teamId === team.id);
      if (!historyEntry || !teamResult) {
        fail(socket, ack, "No finalized grade is available to protest.");
        return;
      }

      if (teamResult.protest?.status && teamResult.protest.status !== "pending") {
        fail(socket, ack, "This protest has already been resolved.");
        return;
      }

      teamResult.protest = {
        text,
        createdAt: Date.now(),
        status: "pending"
      };

      touch(room);
      ok(ack, {});
      broadcastState(room);
    }
  );

  socket.on(
    "protest:resolve",
    (
      payload: {
        code?: unknown;
        hostToken?: unknown;
        round?: unknown;
        teamId?: unknown;
        status?: unknown;
        response?: unknown;
      },
      ack?: AckCallback
    ) => {
      const room = requireHost(socket, ack, payload);
      if (!room) {
        return;
      }

      if (room.phase !== "between_rounds" && room.phase !== "finished") {
        fail(socket, ack, "Protests can be resolved after grades are finalized.");
        return;
      }

      const round = Number(payload.round);
      if (!Number.isInteger(round)) {
        fail(socket, ack, "Round is required.");
        return;
      }

      const status = payload.status;
      if (status !== "accepted" && status !== "rejected") {
        fail(socket, ack, "Choose whether to accept or reject the protest.");
        return;
      }

      const response = String(payload.response ?? "").trim();
      if (response.length > 500) {
        fail(socket, ack, "Host response must be 500 characters or fewer.");
        return;
      }

      const historyEntry = room.history.find((entry) => entry.round === round);
      const teamResult = historyEntry?.results.find((entry) => entry.teamId === payload.teamId);
      if (!historyEntry || !teamResult?.protest) {
        fail(socket, ack, "Protest not found.");
        return;
      }

      if (teamResult.protest.status && teamResult.protest.status !== "pending") {
        fail(socket, ack, "This protest has already been resolved.");
        return;
      }

      const team = room.teams.find((candidate) => candidate.id === teamResult.teamId);
      if (!team) {
        fail(socket, ack, "Team not found.");
        return;
      }

      if (status === "accepted") {
        updateRoundResultGrade(room, team, teamResult, "correct");
      }

      teamResult.protest = {
        ...teamResult.protest,
        status,
        response: response || undefined,
        resolvedAt: Date.now()
      };

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
    room.gradeSuggestionCache = undefined;
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
