import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Server, type Socket } from "socket.io";
import {
  DEFAULT_SETTINGS,
  questionParts,
  type Ack,
  type AnswerRevealMode,
  type GemmaDebugBatch,
  type GameSettings,
  type Grade,
  type GradeSuggestion,
  type LeaderboardEntry,
  type PartGradeSuggestion,
  type Question,
  type QuestionPart,
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
  currentAnswerDraft?: string;
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
  baseQuestions: Question[];
  teams: TeamRecord[];
  currentRound: number;
  roundDurationSeconds?: number;
  roundEndsAt?: number;
  roundTimer?: NodeJS.Timeout;
  gradeSuggestionCache?: {
    round: number;
    promise?: Promise<{ suggestions: GradeSuggestion[]; debugBatches: GemmaDebugBatch[] }>;
    suggestions?: GradeSuggestion[];
    debugBatches?: GemmaDebugBatch[];
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
const DRAFT_GRACE_MS = 500;

function cloneQuestions(questions: Question[]): Question[] {
  return questions.map((question) => ({
    ...question,
    parts: question.parts?.map((part) => ({ ...part }))
  }));
}

function cloneSettings(settings: GameSettings = DEFAULT_SETTINGS): GameSettings {
  return {
    questionCount: settings.questionCount,
    pointsPerCorrect: settings.pointsPerCorrect,
    bonusByRank: [...settings.bonusByRank],
    questions: cloneQuestions(settings.questions),
    scrambleQuestionOrder: settings.scrambleQuestionOrder,
    answerRevealMode: settings.answerRevealMode,
    hideLeaderboardDuringAnswering: settings.hideLeaderboardDuringAnswering,
    llmGradingEnabled: settings.llmGradingEnabled,
    showFullGemmaResponse: settings.showFullGemmaResponse
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

    const {
      answer: _answer,
      answerImageDataUrl: _answerImageDataUrl,
      answerImageName: _answerImageName,
      answerImageAlt: _answerImageAlt,
      ...questionWithoutAnswer
    } = question;
    return {
      ...questionWithoutAnswer,
      parts: question.parts?.map((part) => {
        const { answer: _partAnswer, ...partWithoutAnswer } = part;
        return partWithoutAnswer;
      })
    };
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

  const withoutAiFeedback = (result: RoundHistoryEntry["results"][number]): RoundHistoryEntry["results"][number] => ({
    ...result,
    aiFeedback: undefined,
    partResults: result.partResults?.map((part) => ({ ...part, aiFeedback: undefined }))
  });

  return room.history.map((entry) => ({
    ...entry,
    results: entry.results.flatMap((result) => {
      const isOwnTeam = result.teamId === context.teamId;

      if (room.settings.answerRevealMode === "after_grading" || isOwnTeam) {
        return [isOwnTeam ? result : withoutAiFeedback(result)];
      }

      if (room.settings.answerRevealMode === "status_only") {
        return [withoutAiFeedback({
          ...result,
          answer: undefined,
        })];
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
    const canSeeDraft = context.teamId === team.id;

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
      currentAnswerDraft: canSeeDraft ? team.currentAnswerDraft : undefined,
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

function normalizeFractions(values: Array<number | undefined>, itemLabel: string): number[] | string {
  const providedSum = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const missingCount = values.filter((value) => value === undefined).length;

  if (values.some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 1))) {
    return `${itemLabel} fractions must be greater than 0 and no more than 1.`;
  }

  if (missingCount === values.length) {
    return values.map(() => 1 / values.length);
  }

  if (providedSum > 1.0001) {
    return `${itemLabel} fractions cannot add up to more than 1.`;
  }

  if (missingCount === 0) {
    if (Math.abs(providedSum - 1) > 0.001) {
      return `${itemLabel} fractions must add up to 1.`;
    }

    return values.map((value) => value ?? 0);
  }

  const remaining = 1 - providedSum;
  if (remaining <= 0) {
    return `${itemLabel} has no remaining value for unweighted parts.`;
  }

  return values.map((value) => value ?? remaining / missingCount);
}

function validateQuestionPart(rawPart: unknown, questionIndex: number, partIndex: number): (Omit<QuestionPart, "fraction"> & {
  fraction?: number;
}) | string {
  if (!rawPart || typeof rawPart !== "object") {
    return `Question ${questionIndex + 1} part ${partIndex + 1} must be an object.`;
  }

  const candidate = rawPart as Partial<QuestionPart>;
  const text = String(candidate.text ?? "").trim();
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const codeLanguage =
    typeof candidate.codeLanguage === "string" ? candidate.codeLanguage.trim().slice(0, 32) : undefined;
  const answer = typeof candidate.answer === "string" ? candidate.answer.trim() : undefined;
  const id = typeof candidate.id === "string" && candidate.id.trim()
    ? candidate.id.trim().slice(0, 48)
    : `part-${partIndex + 1}`;
  const label = typeof candidate.label === "string" && candidate.label.trim()
    ? candidate.label.trim().slice(0, 80)
    : `Part ${partIndex + 1}`;
  const fraction = candidate.fraction === undefined ? undefined : Number(candidate.fraction);

  if (!text) {
    return `Question ${questionIndex + 1} part ${partIndex + 1} needs text.`;
  }

  if (text.length > 5000) {
    return `Question ${questionIndex + 1} part ${partIndex + 1} text must be 5000 characters or fewer.`;
  }

  if (code && code.length > 20000) {
    return `Question ${questionIndex + 1} part ${partIndex + 1} code must be 20000 characters or fewer.`;
  }

  if (answer && answer.length > 10000) {
    return `Question ${questionIndex + 1} part ${partIndex + 1} answer must be 10000 characters or fewer.`;
  }

  return {
    id,
    label,
    text,
    code: code || undefined,
    codeLanguage: codeLanguage || undefined,
    answer: answer || undefined,
    fraction
  };
}

function validateQuestion(rawQuestion: unknown, index: number): Question | string {
  if (!rawQuestion || typeof rawQuestion !== "object") {
    return `Question ${index + 1} must be an object.`;
  }

  const candidate = rawQuestion as Partial<Question>;
  const topic = typeof candidate.topic === "string" ? candidate.topic.trim() : undefined;
  const text = String(candidate.text ?? "").trim();
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const codeLanguage =
    typeof candidate.codeLanguage === "string" ? candidate.codeLanguage.trim().slice(0, 32) : undefined;
  const minutes = candidate.minutes === undefined ? undefined : Number(candidate.minutes);
  const answer = typeof candidate.answer === "string" ? candidate.answer.trim() : undefined;
  const imageDataUrl = typeof candidate.imageDataUrl === "string" ? candidate.imageDataUrl : undefined;
  const imageName = typeof candidate.imageName === "string" ? candidate.imageName.trim().slice(0, 140) : undefined;
  const imageAlt = typeof candidate.imageAlt === "string" ? candidate.imageAlt.trim().slice(0, 180) : undefined;
  const answerImageDataUrl = typeof candidate.answerImageDataUrl === "string" ? candidate.answerImageDataUrl : undefined;
  const answerImageName =
    typeof candidate.answerImageName === "string" ? candidate.answerImageName.trim().slice(0, 140) : undefined;
  const answerImageAlt =
    typeof candidate.answerImageAlt === "string" ? candidate.answerImageAlt.trim().slice(0, 180) : undefined;
  const rawParts = Array.isArray(candidate.parts) ? candidate.parts : undefined;

  if (!text) {
    return `Question ${index + 1} needs text.`;
  }

  if (topic && topic.length > 120) {
    return `Question ${index + 1} topic must be 120 characters or fewer.`;
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

  if (answerImageDataUrl) {
    if (!/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(answerImageDataUrl)) {
      return `Question ${index + 1} answer image must be a PNG, JPG, GIF, WebP, or SVG data URL.`;
    }

    if (answerImageDataUrl.length > 4_000_000) {
      return `Question ${index + 1} answer image is too large.`;
    }
  }

  let parts: QuestionPart[] | undefined;
  if (candidate.parts !== undefined) {
    if (!rawParts || rawParts.length === 0) {
      return `Question ${index + 1} parts must be a non-empty array.`;
    }

    if (rawParts.length > 12) {
      return `Question ${index + 1} cannot have more than 12 parts.`;
    }

    const parsedParts = rawParts.map((part, partIndex) => validateQuestionPart(part, index, partIndex));
    const firstError = parsedParts.find((part): part is string => typeof part === "string");
    if (firstError) {
      return firstError;
    }

    const typedParts = parsedParts as Array<Omit<QuestionPart, "fraction"> & { fraction?: number }>;
    const fractions = normalizeFractions(
      typedParts.map((part) => part.fraction),
      `Question ${index + 1} part`
    );
    if (typeof fractions === "string") {
      return fractions;
    }

    const seenIds = new Set<string>();
    parts = typedParts.map((part, partIndex) => {
      const baseId = part.id || `part-${partIndex + 1}`;
      const id = seenIds.has(baseId) ? `${baseId}-${partIndex + 1}` : baseId;
      seenIds.add(id);
      return {
        ...part,
        id,
        fraction: fractions[partIndex]
      };
    });
  }

  return {
    topic: topic || undefined,
    text,
    code: code || undefined,
    codeLanguage: codeLanguage || undefined,
    minutes,
    answer: answer || undefined,
    parts,
    imageDataUrl,
    imageName,
    imageAlt,
    answerImageDataUrl,
    answerImageName,
    answerImageAlt
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
    totalImageBytes += question.answerImageDataUrl?.length ?? 0;
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
  const showFullGemmaResponse = Boolean(settings.showFullGemmaResponse);
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
    llmGradingEnabled,
    showFullGemmaResponse
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

function cleanCredit(value: unknown): number | undefined {
  const credit = Number(value);
  if (!Number.isFinite(credit)) {
    return undefined;
  }

  return Math.max(0, Math.min(1, credit));
}

function normalizePartKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractBalancedJson(text: string, start: number): string | undefined {
  const closingByOpening: Record<string, string> = {
    "{": "}",
    "[": "]"
  };
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(closingByOpening[char]);
      continue;
    }

    if (char === "}" || char === "]") {
      if (stack.at(-1) !== char) {
        return undefined;
      }

      stack.pop();
      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function parseJsonFromModelText(rawText: string): unknown {
  const trimmed = rawText.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim()
    : trimmed;

  for (const candidate of [trimmed, unfenced]) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Fall through to balanced extraction below.
    }
  }

  for (let index = 0; index < rawText.length; index += 1) {
    if (rawText[index] !== "{" && rawText[index] !== "[") {
      continue;
    }

    const jsonText = extractBalancedJson(rawText, index);
    if (!jsonText) {
      continue;
    }

    try {
      return JSON.parse(jsonText) as unknown;
    } catch {
      // Keep scanning in case this was an example or malformed preamble.
    }
  }

  throw new Error("AI response did not include parseable JSON.");
}

function parseGemmaPartSuggestions(rawParts: unknown, parts: QuestionPart[]): PartGradeSuggestion[] {
  if (!Array.isArray(rawParts)) {
    return [];
  }

  const partById = new Map(parts.map((part) => [part.id, part]));
  const normalizedPartLookup = new Map<string, QuestionPart>();
  for (const [index, part] of parts.entries()) {
    const label = part.label || `Part ${index + 1}`;
    for (const candidate of [
      part.id,
      label,
      `part ${index + 1}`,
      `part${index + 1}`,
      String(index + 1)
    ]) {
      normalizedPartLookup.set(normalizePartKey(candidate), part);
    }
  }

  type CandidateSuggestion = Omit<PartGradeSuggestion, "partId"> & {
    exactPart?: QuestionPart;
    numberedPart?: QuestionPart;
    normalizedPart?: QuestionPart;
  };

  const candidates = rawParts.flatMap((item): CandidateSuggestion[] => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as {
      partId?: unknown;
      partNumber?: unknown;
      credit?: unknown;
      confidence?: unknown;
      rationale?: unknown;
      feedback?: unknown;
    };
    const rawPartId = typeof candidate.partId === "string" ? candidate.partId : "";
    const partNumber = Number(candidate.partNumber);
    const numberedPart = Number.isInteger(partNumber) && partNumber >= 1 ? parts[partNumber - 1] : undefined;
    const credit = cleanCredit(candidate.credit);
    if (credit === undefined) {
      return [];
    }

    const confidence = Number(candidate.confidence);
    return [{
      credit,
      exactPart: partById.get(rawPartId),
      numberedPart,
      normalizedPart: rawPartId ? normalizedPartLookup.get(normalizePartKey(rawPartId)) : undefined,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined,
      rationale: typeof candidate.rationale === "string" ? candidate.rationale.slice(0, 300) : undefined,
      feedback: typeof candidate.feedback === "string" ? candidate.feedback.slice(0, 800) : undefined
    }];
  });

  const suggestionsByPartId = new Map<string, PartGradeSuggestion>();

  for (const candidate of candidates) {
    const orderedCandidates = [candidate.exactPart, candidate.numberedPart, candidate.normalizedPart]
      .filter((part): part is QuestionPart => Boolean(part))
      .filter((part, index, items) => items.findIndex((item) => item.id === part.id) === index);
    const nextUnusedPart = parts.find((part) => !suggestionsByPartId.has(part.id));

    if (orderedCandidates.length === 0) {
      if (!nextUnusedPart) {
        continue;
      }

      const nextSuggestion: PartGradeSuggestion = {
        partId: nextUnusedPart.id,
        credit: candidate.credit,
        confidence: candidate.confidence,
        rationale: candidate.rationale,
        feedback: candidate.feedback
      };
      suggestionsByPartId.set(nextUnusedPart.id, nextSuggestion);
      continue;
    }

    let chosenPart = orderedCandidates[0];

    if (candidate.exactPart && candidate.numberedPart && candidate.exactPart.id !== candidate.numberedPart.id) {
      const exactUsed = suggestionsByPartId.has(candidate.exactPart.id);
      const numberedUsed = suggestionsByPartId.has(candidate.numberedPart.id);
      if (exactUsed && !numberedUsed) {
        chosenPart = candidate.numberedPart;
      } else if (!exactUsed && numberedUsed) {
        chosenPart = candidate.exactPart;
      }
    } else {
      chosenPart = orderedCandidates.find((part) => !suggestionsByPartId.has(part.id)) ?? orderedCandidates[0];
    }

    if (suggestionsByPartId.has(chosenPart.id) && nextUnusedPart) {
      chosenPart = nextUnusedPart;
    }

    const nextSuggestion: PartGradeSuggestion = {
      partId: chosenPart.id,
      credit: candidate.credit,
      confidence: candidate.confidence,
      rationale: candidate.rationale,
      feedback: candidate.feedback
    };
    const existing = suggestionsByPartId.get(chosenPart.id);
    if (!existing) {
      suggestionsByPartId.set(chosenPart.id, nextSuggestion);
      continue;
    }

    const existingConfidence = existing.confidence ?? -1;
    const nextConfidence = nextSuggestion.confidence ?? -1;
    if (nextConfidence >= existingConfidence) {
      suggestionsByPartId.set(chosenPart.id, nextSuggestion);
    }
  }

  return parts.flatMap((part) => {
    const suggestion = suggestionsByPartId.get(part.id);
    return suggestion ? [suggestion] : [];
  });
}

function buildFallbackGemmaText(
  prefix: string,
  overallText: string | undefined,
  maxLength: number
): string | undefined {
  const trimmedOverall = overallText?.trim();
  if (!trimmedOverall) {
    return prefix.slice(0, maxLength);
  }

  const separator = " Overall note: ";
  const available = maxLength - prefix.length - separator.length;
  if (available <= 0) {
    return prefix.slice(0, maxLength);
  }

  return `${prefix}${separator}${trimmedOverall.slice(0, available).trimEnd()}`;
}

function fillMissingGemmaPartSuggestions(
  partSuggestions: PartGradeSuggestion[],
  parts: QuestionPart[],
  confidence: number | undefined,
  overallRationale: string | undefined,
  overallFeedback: string | undefined
): PartGradeSuggestion[] {
  if (parts.length <= 1 || partSuggestions.length >= parts.length) {
    return partSuggestions;
  }

  const suggestionByPartId = new Map(partSuggestions.map((suggestion) => [suggestion.partId, suggestion]));

  return parts.map((part, index) => {
    const existing = suggestionByPartId.get(part.id);
    if (existing) {
      return existing;
    }

    const label = part.label?.trim() || `Part ${index + 1}`;
    return {
      partId: part.id,
      credit: 0,
      confidence,
      rationale: buildFallbackGemmaText(
        `Gemma did not return a part-level suggestion for ${label}, so it was defaulted to 0% credit.`,
        overallRationale,
        300
      ),
      feedback: buildFallbackGemmaText(
        `No part-specific Gemma feedback was returned for ${label}, so this part was left at 0% credit for review.`,
        overallFeedback,
        800
      )
    };
  });
}

function dedupeGradeSuggestions(suggestions: GradeSuggestion[]): GradeSuggestion[] {
  const byTeamId = new Map<string, GradeSuggestion>();

  for (const suggestion of suggestions) {
    const existing = byTeamId.get(suggestion.teamId);
    const existingConfidence = existing?.confidence ?? -1;
    const nextConfidence = suggestion.confidence ?? -1;
    if (!existing || nextConfidence >= existingConfidence) {
      byTeamId.set(suggestion.teamId, suggestion);
    }
  }

  return [...byTeamId.values()];
}

function parseGemmaSuggestions(rawText: string, validTeamIds: Set<string>, parts: QuestionPart[]): GradeSuggestion[] {
  const parsed = parseJsonFromModelText(rawText);
  const suggestions = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { suggestions?: unknown }).suggestions)
      ? (parsed as { suggestions: unknown[] }).suggestions
      : undefined;

  if (!suggestions) {
    throw new Error("AI response did not include a suggestions array.");
  }

  const parsedSuggestions = suggestions.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as {
      teamId?: unknown;
      grade?: unknown;
      credit?: unknown;
      confidence?: unknown;
      rationale?: unknown;
      feedback?: unknown;
      partSuggestions?: unknown;
    };
    const teamId = typeof candidate.teamId === "string" ? candidate.teamId : "";
    const grade = candidate.grade;
    const confidence = Number(candidate.confidence);
    const normalizedConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined;
    const rationale = typeof candidate.rationale === "string" ? candidate.rationale.slice(0, 300) : undefined;
    const feedback = typeof candidate.feedback === "string"
      ? candidate.feedback
      : typeof candidate.rationale === "string"
        ? candidate.rationale
        : undefined;
    const rawCredit = cleanCredit(candidate.credit);
    const parsedPartSuggestions = parseGemmaPartSuggestions(candidate.partSuggestions, parts);
    const shouldFillMissingParts = parts.length > 1
      && parsedPartSuggestions.length < parts.length
      && (parsedPartSuggestions.length > 0 || rawCredit === 0);
    const partSuggestions = shouldFillMissingParts
      ? fillMissingGemmaPartSuggestions(
        parsedPartSuggestions,
        parts,
        normalizedConfidence,
        rationale,
        feedback?.slice(0, 800)
      )
      : parsedPartSuggestions;
    const credit = partSuggestions.length > 0
      ? roundPoints(parts.reduce((sum, part) => {
        const suggestion = partSuggestions.find((candidate) => candidate.partId === part.id);
        return sum + part.fraction * (suggestion?.credit ?? 0);
      }, 0))
      : rawCredit;
    const finalGrade: Grade = grade === "correct" || grade === "incorrect"
      ? grade
      : credit !== undefined && credit >= 0.999
        ? "correct"
        : "incorrect";
    if (!validTeamIds.has(teamId)) {
      return [];
    }

    return [{
      teamId,
      grade: finalGrade,
      credit,
      confidence: normalizedConfidence,
      rationale,
      feedback: feedback?.slice(0, 800),
      partSuggestions
    }];
  });

  if (suggestions.length > 0 && parsedSuggestions.length === 0) {
    throw new Error("AI response did not include suggestions for the current teams.");
  }

  return dedupeGradeSuggestions(parsedSuggestions);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function stringifyForDebug(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function requestGemmaGradeSuggestions(
  room: RoomRecord
): Promise<{ suggestions: GradeSuggestion[]; debugBatches: GemmaDebugBatch[] }> {
  const apiKey = process.env.GEMMA_API_KEY;
  if (!apiKey) {
    throw new Error("GEMMA_API_KEY is not configured.");
  }

  const gemmaApiKey = apiKey;
  const model = process.env.GEMMA_MODEL || "gemma-4-31b-it";
  const fallbackModel = process.env.GEMMA_FALLBACK_MODEL || "gemma-3-27b-it";
  const apiBase = process.env.GEMMA_API_BASE || "https://generativelanguage.googleapis.com/v1beta";
  const requestTimeoutMs = Math.max(1000, Number(process.env.GEMMA_REQUEST_TIMEOUT_MS ?? 30000) || 30000);
  const question = room.settings.questions[room.currentRound - 1];
  const parts = questionParts(question);
  const teams = room.teams.map((team) => ({
    teamId: team.id,
    teamName: team.name,
    wager: team.currentWager ?? null,
    studentAnswer: team.currentAnswer ?? ""
  }));
  const batchSize = Math.max(1, Math.ceil(teams.length / 15));
  const teamBatches = chunkArray(teams, batchSize);
  const batchConcurrency = Math.max(1, Number(process.env.GEMMA_BATCH_CONCURRENCY ?? teamBatches.length) || teamBatches.length);
  const includeDebug = room.settings.showFullGemmaResponse;

  function modelPathFor(modelName: string): string {
    return modelName.startsWith("models/") ? modelName : `models/${modelName}`;
  }

  function urlForModel(modelName: string): string {
    return `${apiBase.replace(/\/$/, "")}/${modelPathFor(modelName)}:generateContent?key=${encodeURIComponent(gemmaApiKey)}`;
  }

  const primaryUrl = urlForModel(model);
  const fallbackUrl = fallbackModel && fallbackModel !== model ? urlForModel(fallbackModel) : undefined;
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
            credit: { type: "number" },
            confidence: { type: "number" },
            rationale: { type: "string" },
            feedback: { type: "string" },
            partSuggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  partId: { type: "string" },
                  partNumber: { type: "number" },
                  credit: { type: "number" },
                  confidence: { type: "number" },
                  rationale: { type: "string" },
                  feedback: { type: "string" }
                },
                required: ["partId", "credit"]
              }
            }
          },
          required: ["teamId", "grade", "feedback", "partSuggestions"]
        }
      }
    },
    required: ["suggestions"]
  };

  function buildPrompt(batchTeams: typeof teams, batchIndex: number, batchCount: number): string {
    return [
      "You are helping a human host grade a classroom game.",
      "Use the question, official answers, optional code blocks, and each team's student answer.",
      "Grade every question part with a decimal credit from 0 to 1.",
      "Use 1 for full credit, 0 for no credit, and a decimal for partial credit.",
      "The question.parts array is authoritative. Return exactly one partSuggestion for every object in question.parts.",
      "Copy each partSuggestion.partId exactly from the matching question part. Do not infer part order from labels alone.",
      "Each partSuggestion rationale and feedback must discuss only that specific part's text and official answer.",
      "If the student answer has multiple lines, map content to parts by meaning, not by line position alone.",
      "Set top-level credit to the weighted sum of each part credit times that part's fraction.",
      "Set the overall grade to correct only when all parts receive full credit.",
      "Also write feedback for each team that will be shown directly to that team after grades are finalized.",
      "Student-facing feedback should be concise, constructive, and explain what was right or missing without mentioning internal confidence.",
      "Return only JSON matching this schema:",
      '{"suggestions":[{"teamId":"string","grade":"correct|incorrect","credit":0.0,"confidence":0.0,"rationale":"short host-only explanation","feedback":"student-facing feedback","partSuggestions":[{"partId":"exact partId from question.parts","partNumber":1,"credit":0.0,"confidence":0.0,"rationale":"short explanation for only this part","feedback":"student-facing feedback for only this part"}]}]}',
      "Do not include markdown or commentary outside JSON.",
      "",
      JSON.stringify({
        round: room.currentRound,
        batch: {
          index: batchIndex + 1,
          total: batchCount
        },
        question: {
          text: question?.text ?? "",
          codeLanguage: question?.codeLanguage ?? "",
          code: question?.code ?? "",
          officialAnswer: question?.answer ?? "",
          parts: parts.map((part, index) => ({
            partNumber: index + 1,
            partId: part.id,
            label: part.label ?? part.id,
            fraction: part.fraction,
            text: part.text,
            codeLanguage: part.codeLanguage ?? "",
            code: part.code ?? "",
            officialAnswer: part.answer ?? ""
          }))
        },
        teams: batchTeams
      })
    ].join("\n");
  }

  async function postGemma(
    prompt: string,
    includeSchema: boolean,
    url: string,
    useJsonMode: boolean
  ): Promise<{ ok: true; data: unknown; rawText: string } | { ok: false; status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
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
          ...(useJsonMode
            ? {
              responseMimeType: "application/json",
              ...(includeSchema ? { responseJsonSchema: responseSchema } : {})
            }
            : {})
        }
      })
    }).finally(() => clearTimeout(timer));

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, text };
    }

    try {
      return { ok: true, data: JSON.parse(text) as unknown, rawText: text };
    } catch {
      throw new Error(`Gemma response was not valid JSON.\n\nFull Gemma response:\n${text}`);
    }
  }

  function retryDelayFromGemmaError(result: { status: number; text: string }, fallbackDelayMs: number): number {
    if (result.status !== 429) {
      return fallbackDelayMs;
    }

    try {
      const parsed = JSON.parse(result.text) as {
        error?: {
          details?: Array<{
            "@type"?: string;
            retryDelay?: string;
          }>;
        };
      };
      const retryDelay = parsed.error?.details?.find((detail) => typeof detail.retryDelay === "string")?.retryDelay;
      const retrySeconds = Number(retryDelay?.replace(/s$/, ""));
      if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
        return Math.min(30000, Math.ceil(retrySeconds * 1000) + 500);
      }
    } catch {
      // Fall back to parsing the human-readable message below.
    }

    const match = result.text.match(/retry in ([\d.]+)s/i);
    const retrySeconds = Number(match?.[1]);
    if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
      return Math.min(30000, Math.ceil(retrySeconds * 1000) + 500);
    }

    return Math.max(fallbackDelayMs, 5000);
  }

  async function postGemmaWithRetryForPrompt(
    prompt: string,
    includeSchema: boolean,
    url: string,
    useJsonMode: boolean
  ): Promise<{ ok: true; data: unknown; rawText: string } | { ok: false; status: number; text: string }> {
    const delays = [700, 1600];

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const result = await postGemma(prompt, includeSchema, url, useJsonMode).catch((error) => ({
        ok: false as const,
        status: 0,
        text: error instanceof Error ? error.message : "Gemma request failed before a response was received."
      }));
      if (result.ok || ![0, 429, 500, 502, 503, 504].includes(result.status) || attempt === delays.length) {
        return result;
      }

      await wait(retryDelayFromGemmaError(result, delays[attempt]));
    }

    return postGemma(prompt, includeSchema, url, useJsonMode);
  }

  async function postGemmaWithSchemaFallback(
    prompt: string,
    url: string
  ): Promise<{ ok: true; data: unknown; rawText: string } | { ok: false; status: number; text: string }> {
    let result = await postGemmaWithRetryForPrompt(prompt, true, url, true);
    if (
      !result.ok &&
      result.status === 400 &&
      /schema|responseJsonSchema|unsupported|unknown field|invalid/i.test(result.text)
    ) {
      result = await postGemmaWithRetryForPrompt(prompt, false, url, true);
    }

    if (
      !result.ok &&
      result.status === 400 &&
      /json mode|responseMimeType|mime/i.test(result.text)
    ) {
      return postGemmaWithRetryForPrompt(prompt, false, url, false);
    }

    return result;
  }

  async function requestBatch(
    batchTeams: typeof teams,
    batchIndex: number
  ): Promise<
    | { ok: true; suggestions: GradeSuggestion[]; debugBatch?: GemmaDebugBatch }
    | { ok: false; message: string }
  > {
    const validTeamIds = new Set(batchTeams.map((team) => team.teamId));
    const prompt = buildPrompt(batchTeams, batchIndex, teamBatches.length);

    let result = await postGemmaWithSchemaFallback(prompt, primaryUrl);
    let resultModel = model;
    if (!result.ok && result.status === 429 && fallbackUrl) {
      console.warn(
        `Gemma primary model ${model} hit rate limit for batch ${batchIndex + 1}/${teamBatches.length}; retrying with ${fallbackModel}.`
      );
      result = await postGemmaWithSchemaFallback(prompt, fallbackUrl);
      resultModel = fallbackModel;
    }

    if (!result.ok) {
      return {
        ok: false,
        message: `Gemma request failed for batch ${batchIndex + 1}/${teamBatches.length} using ${resultModel} (${result.status}).\n\nFull Gemma response:\n${result.text}`
      };
    }

    const text = extractGemmaText(result.data);
    if (!text) {
      return {
        ok: false,
        message: `Gemma response did not contain text for batch ${batchIndex + 1}/${teamBatches.length}.\n\nFull Gemma response:\n${stringifyForDebug(result.data)}`
      };
    }

    try {
      const parsedSuggestions = parseGemmaSuggestions(text, validTeamIds, parts);
      return {
        ok: true,
        suggestions: parsedSuggestions,
        debugBatch: includeDebug
          ? {
          batchIndex: batchIndex + 1,
          batchCount: teamBatches.length,
          teamIds: batchTeams.map((team) => team.teamId),
          prompt,
          modelText: text,
          rawResponse: result.rawText
          }
          : undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse Gemma suggestions.";
      return {
        ok: false,
        message: `${message}\n\nGemma batch ${batchIndex + 1}/${teamBatches.length}\n\nFull Gemma model text:\n${text}\n\nFull Gemma response:\n${stringifyForDebug(result.data)}`
      };
    }
  }

  const batchResults = await mapWithConcurrency(teamBatches, batchConcurrency, requestBatch);
  const allSuggestions = batchResults.flatMap((result) => result.ok ? result.suggestions : []);
  const debugBatches = batchResults.flatMap((result) => result.ok && result.debugBatch ? [result.debugBatch] : []);
  const failedBatches = batchResults.flatMap((result) => result.ok ? [] : [result.message]);

  if (failedBatches.length > 0) {
    console.warn(failedBatches.join("\n\n"));
  }

  if (allSuggestions.length === 0 && failedBatches.length > 0) {
    throw new Error(failedBatches.join("\n\n"));
  }

  return {
    suggestions: allSuggestions,
    debugBatches
  };
}

async function cachedGemmaGradeSuggestions(
  room: RoomRecord
): Promise<{ suggestions: GradeSuggestion[]; debugBatches: GemmaDebugBatch[] }> {
  const cached = room.gradeSuggestionCache;
  if (cached?.round === room.currentRound) {
    if (cached.suggestions) {
      return {
        suggestions: cached.suggestions,
        debugBatches: cached.debugBatches ?? []
      };
    }

    if (cached.promise) {
      return cached.promise;
    }
  }

  const round = room.currentRound;
  const promise = requestGemmaGradeSuggestions(room);
  room.gradeSuggestionCache = { round, promise };

  try {
    const result = await promise;
    if (room.gradeSuggestionCache?.round === round && room.currentRound === round) {
      room.gradeSuggestionCache = {
        round,
        suggestions: result.suggestions,
        debugBatches: result.debugBatches
      };
    }
    return result;
  } catch (error) {
    if (room.gradeSuggestionCache?.round === round && room.gradeSuggestionCache.promise === promise) {
      room.gradeSuggestionCache = undefined;
    }
    throw error;
  }
}

function gradeSuggestionsForFinalResults(room: RoomRecord): Map<string, GradeSuggestion> {
  if (!room.settings.llmGradingEnabled) {
    return new Map();
  }

  const cached = room.gradeSuggestionCache;
  if (cached?.round === room.currentRound && cached.suggestions) {
    return new Map(cached.suggestions.map((suggestion) => [suggestion.teamId, suggestion]));
  }

  return new Map();
}

function updateRoundResultGrade(room: RoomRecord, team: TeamRecord, result: RoundHistoryEntry["results"][number], grade: Grade): void {
  const previousScoreDelta = result.scoreDelta;
  const previousBonusDelta = result.bonusDelta;
  const credit = grade === "correct" ? 1 : 0;
  const nextScoreDelta = roundPoints((result.wager ?? 0) * credit);
  const nextBonusDelta = roundPoints(room.settings.pointsPerCorrect * credit);

  result.grade = grade;
  result.credit = credit;
  result.scoreDelta = nextScoreDelta;
  result.bonusDelta = nextBonusDelta;
  if (result.partResults?.length) {
    result.partResults = result.partResults.map((part) => ({
      ...part,
      credit,
      scoreDelta: roundPoints((result.wager ?? 0) * part.fraction * credit),
      bonusDelta: roundPoints(room.settings.pointsPerCorrect * part.fraction * credit)
    }));
  }
  team.correctWagerTotal += nextScoreDelta - previousScoreDelta;
  team.answerPoints += nextBonusDelta - previousBonusDelta;
}

function roundPoints(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function weightedCredit(parts: QuestionPart[], credits: Map<string, number>): number {
  return roundPoints(parts.reduce((sum, part) => sum + part.fraction * (credits.get(part.id) ?? 0), 0));
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
  const next = cloneQuestions(questions);
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
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

function promoteAnswerDrafts(room: RoomRecord): void {
  for (const team of room.teams) {
    if (team.currentAnswer !== undefined) {
      continue;
    }

    const draft = team.currentAnswerDraft;
    if (draft?.trim()) {
      team.currentAnswer = draft;
    }
  }
}

function moveToGrading(room: RoomRecord): void {
  clearRoundTimer(room);
  promoteAnswerDrafts(room);
  room.phase = "grading";
  room.roundEndsAt = Date.now();
  room.gradeSuggestionCache = undefined;
  if (room.settings.llmGradingEnabled) {
    const round = room.currentRound;
    const timer = setTimeout(() => {
      if (room.phase === "grading" && room.currentRound === round && room.settings.llmGradingEnabled) {
        void cachedGemmaGradeSuggestions(room).catch(() => undefined);
      }
    }, DRAFT_GRACE_MS);
    timer.unref?.();
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
    team.currentAnswerDraft = undefined;
    team.currentGrade = undefined;
  }
}

function resetGame(room: RoomRecord): void {
  clearRoundTimer(room);
  room.phase = "lobby";
  room.currentRound = 0;
  room.roundDurationSeconds = undefined;
  room.roundEndsAt = undefined;
  room.settings = {
    ...room.settings,
    questions: cloneQuestions(room.baseQuestions)
  };

  for (const team of room.teams) {
    team.usedWagers.clear();
    team.currentWager = undefined;
    team.currentAnswer = undefined;
    team.currentAnswerDraft = undefined;
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
      baseQuestions: cloneQuestions(DEFAULT_SETTINGS.questions),
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

      room.baseQuestions = cloneQuestions(validated.questions);
      room.settings = {
        ...validated,
        questions: cloneQuestions(validated.questions)
      };
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
      team.currentAnswerDraft = undefined;
      team.currentGrade = undefined;
      team.correctWagerTotal = 0;
      team.answerPoints = 0;
      team.scoreAdjustment = 0;
      team.bonusAdjustment = 0;
    }

    room.history = [];
    room.adjustments = [];
    room.gradeSuggestionCache = undefined;
    room.settings = {
      ...room.settings,
      questions:
        room.settings.scrambleQuestionOrder && room.baseQuestions.length > 1
          ? shuffledQuestions(room.baseQuestions)
          : cloneQuestions(room.baseQuestions)
    };
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
        team.currentAnswerDraft = undefined;
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

  socket.on("round:addMinute", (payload: { code?: unknown; hostToken?: unknown }, ack?: AckCallback) => {
    const room = requireHost(socket, ack, payload);
    if (!room) {
      return;
    }

    if (room.phase !== "answering") {
      fail(socket, ack, "The answer timer is not running.");
      return;
    }

    const nextEndsAt = Math.max(room.roundEndsAt ?? Date.now(), Date.now()) + 60_000;
    room.roundDurationSeconds = (room.roundDurationSeconds ?? 0) + 60;
    room.roundEndsAt = nextEndsAt;
    startRoundTimer(room);
    touch(room);
    ok(ack, {});
    broadcastState(room);
  });

  socket.on(
    "answer:draft",
    (payload: { code?: unknown; teamToken?: unknown; answer?: unknown }, ack?: AckCallback) => {
      const result = requireTeam(socket, ack, payload);
      if (!result) {
        return;
      }

      const { room, team } = result;
      const answer = String(payload.answer ?? "");
      if (answer.length > 1000) {
        fail(socket, ack, "Answer must be 1000 characters or fewer.");
        return;
      }

      if (team.currentAnswer !== undefined) {
        ok(ack, {});
        return;
      }

      if (room.phase === "answering") {
        team.currentAnswerDraft = answer;
        touch(room);
        ok(ack, {});
        return;
      }

      const justStopped = room.phase === "grading" && Date.now() - (room.roundEndsAt ?? 0) <= 1500;
      if (justStopped) {
        team.currentAnswerDraft = answer;
        if (answer.trim()) {
          team.currentAnswer = answer;
          room.gradeSuggestionCache = undefined;
          if (room.settings.llmGradingEnabled) {
            void cachedGemmaGradeSuggestions(room).catch(() => undefined);
          }
          touch(room);
          ok(ack, {});
          broadcastState(room);
          return;
        }
      }

      ok(ack, {});
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
      team.currentAnswerDraft = answer;

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
    async (
      payload: { code?: unknown; hostToken?: unknown },
      ack?: AckCallback<{ suggestions: GradeSuggestion[]; debugBatches?: GemmaDebugBatch[] }>
    ) => {
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
        const graceRemaining = DRAFT_GRACE_MS - (Date.now() - (room.roundEndsAt ?? 0));
        if (graceRemaining > 0) {
          await wait(graceRemaining);
        }

        const result = await cachedGemmaGradeSuggestions(room);
        ok(ack, {
          suggestions: result.suggestions,
          debugBatches: room.settings.showFullGemmaResponse ? result.debugBatches : undefined
        });
      } catch (error) {
        fail(socket, ack, error instanceof Error ? error.message : "Could not get AI grade suggestions.");
      }
    }
  );

  socket.on(
    "answer:grade",
    async (
      payload: {
        code?: unknown;
        hostToken?: unknown;
        grades?: Record<string, Grade>;
        partCredits?: Record<string, Record<string, number>>;
      },
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
      const question = room.settings.questions[room.currentRound - 1];
      const parts = questionParts(question);
      const partCredits = payload.partCredits ?? {};
      for (const team of room.teams) {
        const teamPartCredits = partCredits[team.id];
        if (teamPartCredits) {
          for (const part of parts) {
            const credit = Number(teamPartCredits[part.id]);
            if (!Number.isFinite(credit) || credit < 0 || credit > 1) {
              fail(socket, ack, `Grade ${team.name} ${part.label ?? part.id} with a partial credit from 0 to 1.`);
              return;
            }
          }
        } else {
          const grade = grades[team.id];
          if (grade !== "correct" && grade !== "incorrect") {
            fail(socket, ack, `Grade ${team.name} before submitting.`);
            return;
          }
        }
      }

      const results: RoundHistoryEntry["results"] = [];
      const gemmaSuggestions = gradeSuggestionsForFinalResults(room);

      for (const team of room.teams) {
        const wager = team.currentWager;
        const teamPartCredits = partCredits[team.id];
        const legacyGrade = grades[team.id];
        const credits = new Map(parts.map((part) => [
          part.id,
          teamPartCredits ? Number(teamPartCredits[part.id]) : legacyGrade === "correct" ? 1 : 0
        ]));
        const credit = weightedCredit(parts, credits);
        const grade: Grade = credit >= 0.999 ? "correct" : "incorrect";
        const scoreDelta = roundPoints((wager ?? 0) * credit);
        const bonusDelta = roundPoints(room.settings.pointsPerCorrect * credit);
        const suggestion = gemmaSuggestions.get(team.id);
        const suggestionParts = new Map((suggestion?.partSuggestions ?? []).map((part) => [part.partId, part]));
        const partResults = parts.map((part) => {
          const partCredit = credits.get(part.id) ?? 0;
          return {
            partId: part.id,
            label: part.label,
            fraction: part.fraction,
            credit: partCredit,
            scoreDelta: roundPoints((wager ?? 0) * part.fraction * partCredit),
            bonusDelta: roundPoints(room.settings.pointsPerCorrect * part.fraction * partCredit),
            aiFeedback: suggestionParts.get(part.id)?.feedback
          };
        });
        const aiFeedback = suggestion?.feedback?.trim();

        results.push({
          teamId: team.id,
          teamName: team.name,
          wager,
          answer: team.currentAnswer,
          grade,
          credit,
          scoreDelta,
          bonusDelta,
          partResults,
          aiFeedback: aiFeedback || undefined
        });

        if (wager !== undefined) {
          team.usedWagers.add(wager);
          team.correctWagerTotal += scoreDelta;
          team.answerPoints += bonusDelta;
        }
      }

      room.history.push({
        round: room.currentRound,
        question,
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
