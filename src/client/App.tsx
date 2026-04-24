import {
  Check,
  Clipboard,
  Download,
  DoorOpen,
  Eye,
  EyeOff,
  History,
  Info,
  LogIn,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings as SettingsIcon,
  Sparkles,
  Timer,
  Trash2,
  Trophy,
  Users,
  X
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { questionParts, questionTopic } from "../shared/types";
import type {
  Ack,
  AnswerRevealMode,
  GemmaDebugBatch,
  GameSettings,
  Grade,
  GradeSuggestion,
  ProtestStatus,
  PublicRoomState,
  PublicTeam,
  Question,
  QuestionPart,
  Role,
  RoundHistoryEntry
} from "../shared/types";

type SavedSession = {
  code: string;
  role: Role;
  hostToken?: string;
  teamToken?: string;
  teamId?: string;
  teamName?: string;
};

type RequestFn = <T extends object = Record<string, never>>(
  event: string,
  payload: unknown,
  timeoutMs?: number
) => Promise<Ack<T>>;

const SESSION_KEY = "ta-game-session";
const STATE_SYNC_INTERVAL_MS = 4000;
const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ?? (import.meta.env.DEV ? "http://localhost:3000" : window.location.origin);

function loadSession(): SavedSession | null {
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SavedSession;
  } catch {
    window.localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function saveSession(session: SavedSession | null): void {
  if (session) {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return;
  }

  window.localStorage.removeItem(SESSION_KEY);
}

function isInvalidSessionMessage(message: string): boolean {
  return message === "Room not found." || message.includes("credentials") || message.includes("Team not found");
}

function phaseLabel(phase: PublicRoomState["phase"]): string {
  const labels: Record<PublicRoomState["phase"], string> = {
    lobby: "Lobby",
    round_setup: "Wagers",
    answering: "Answering",
    grading: "Grading",
    between_rounds: "Scores",
    finished: "Final"
  };

  return labels[phase];
}

function parseBonusText(value: string): number[] | null {
  if (!value.trim()) {
    return [];
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item));

  return parsed.every((item) => Number.isInteger(item) && item >= 0) ? parsed : null;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function normalizeUploadPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function basename(path: string): string {
  return normalizeUploadPath(path).split("/").pop() ?? path.toLowerCase();
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
}

function makeFileLookup(files: File[]): Map<string, File> {
  const lookup = new Map<string, File>();

  for (const file of files) {
    const relativePath = normalizeUploadPath(file.webkitRelativePath || file.name);
    lookup.set(relativePath, file);
    lookup.set(basename(relativePath), file);
  }

  return lookup;
}

function findQuestionJson(files: File[]): File | undefined {
  return (
    files.find((file) => basename(file.webkitRelativePath || file.name) === "questions.json") ??
    files.find((file) => /\.json$/i.test(file.name))
  );
}

function imageCandidates(index: number): string[] {
  const questionNumber = index + 1;
  const stems = [`q${questionNumber}`, `${questionNumber}`, `question${questionNumber}`, `question-${questionNumber}`];
  const extensions = ["png", "jpg", "jpeg", "webp", "gif", "svg"];

  return stems.flatMap((stem) => extensions.map((extension) => `${stem}.${extension}`));
}

function resolveUploadedImage(
  lookup: Map<string, File>,
  index: number,
  reference: string | undefined,
  errorLabel: string
): File | undefined {
  if (reference) {
    const explicit = lookup.get(normalizeUploadPath(reference)) ?? lookup.get(basename(reference));
    if (!explicit) {
      throw new Error(`Question ${index + 1} references ${reference} for ${errorLabel}, but that image was not uploaded.`);
    }

    return explicit;
  }

  return imageCandidates(index)
    .map((candidateName) => lookup.get(candidateName))
    .find((file): file is File => Boolean(file));
}

function normalizeFractions(values: Array<number | undefined>, itemLabel: string): number[] {
  const providedSum = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const missingCount = values.filter((value) => value === undefined).length;

  if (values.some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 1))) {
    throw new Error(`${itemLabel} fractions must be greater than 0 and no more than 1.`);
  }

  if (missingCount === values.length) {
    return values.map(() => 1 / values.length);
  }

  if (providedSum > 1.0001) {
    throw new Error(`${itemLabel} fractions cannot add up to more than 1.`);
  }

  if (missingCount === 0) {
    if (Math.abs(providedSum - 1) > 0.001) {
      throw new Error(`${itemLabel} fractions must add up to 1.`);
    }

    return values.map((value) => value ?? 0);
  }

  const remaining = 1 - providedSum;
  if (remaining <= 0) {
    throw new Error(`${itemLabel} has no remaining value for unweighted parts.`);
  }

  return values.map((value) => value ?? remaining / missingCount);
}

function parseUploadPart(rawPart: unknown, questionIndex: number, partIndex: number): Omit<QuestionPart, "fraction"> & {
  fraction?: number;
} {
  if (!rawPart || typeof rawPart !== "object") {
    throw new Error(`Question ${questionIndex + 1} part ${partIndex + 1} must be an object.`);
  }

  const candidate = rawPart as {
    id?: unknown;
    label?: unknown;
    text?: unknown;
    code?: unknown;
    codeLanguage?: unknown;
    language?: unknown;
    answer?: unknown;
    fraction?: unknown;
  };
  const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const codeLanguage =
    typeof candidate.codeLanguage === "string"
      ? candidate.codeLanguage
      : typeof candidate.language === "string"
        ? candidate.language
        : undefined;
  const answer = typeof candidate.answer === "string" ? candidate.answer.trim() : undefined;
  const fraction = candidate.fraction === undefined ? undefined : Number(candidate.fraction);
  const label =
    typeof candidate.label === "string" && candidate.label.trim()
      ? candidate.label.trim()
      : `Part ${partIndex + 1}`;
  const id =
    typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id.trim().slice(0, 48)
      : `part-${partIndex + 1}`;

  if (!text) {
    throw new Error(`Question ${questionIndex + 1} part ${partIndex + 1} needs text.`);
  }

  if (answer && answer.length > 10000) {
    throw new Error(`Question ${questionIndex + 1} part ${partIndex + 1} answer must be 10000 characters or fewer.`);
  }

  return {
    id,
    label,
    text,
    code,
    codeLanguage: codeLanguage?.trim() || undefined,
    answer: answer || undefined,
    fraction
  };
}

async function parseQuestionUpload(fileList: FileList | null): Promise<Question[]> {
  const files = Array.from(fileList ?? []);
  if (files.length === 0) {
    throw new Error("Choose a questions.json file or a question folder.");
  }

  const jsonFile = findQuestionJson(files);
  if (!jsonFile) {
    throw new Error("Upload needs a questions.json file.");
  }

  const parsed = JSON.parse(await readFileAsText(jsonFile)) as unknown;
  const rawQuestions = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { questions?: unknown }).questions)
      ? (parsed as { questions: unknown[] }).questions
      : null;

  if (!rawQuestions || rawQuestions.length === 0) {
    throw new Error("questions.json needs a non-empty questions array.");
  }

  const lookup = makeFileLookup(files.filter((file) => file !== jsonFile));
  const questions: Question[] = [];

  for (const [index, rawQuestion] of rawQuestions.entries()) {
    if (!rawQuestion || typeof rawQuestion !== "object") {
      throw new Error(`Question ${index + 1} must be an object.`);
    }

    const candidate = rawQuestion as {
      topic?: unknown;
      text?: unknown;
      code?: unknown;
      codeLanguage?: unknown;
      language?: unknown;
      minutes?: unknown;
      answer?: unknown;
      parts?: unknown;
      image?: unknown;
      imageName?: unknown;
      imageAlt?: unknown;
      answerImage?: unknown;
      answerImageName?: unknown;
      answerImageAlt?: unknown;
    };
    const topic = typeof candidate.topic === "string" ? candidate.topic.trim() : "";
    const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
    const code = typeof candidate.code === "string" ? candidate.code : undefined;
    const codeLanguage =
      typeof candidate.codeLanguage === "string"
        ? candidate.codeLanguage
        : typeof candidate.language === "string"
          ? candidate.language
          : undefined;
    const imageReference =
      typeof candidate.image === "string"
        ? candidate.image
        : typeof candidate.imageName === "string"
          ? candidate.imageName
          : undefined;
    const answerImageReference =
      typeof candidate.answerImage === "string"
        ? candidate.answerImage
        : typeof candidate.answerImageName === "string"
          ? candidate.answerImageName
          : undefined;
    const minutes = candidate.minutes === undefined ? undefined : Number(candidate.minutes);
    const answer = typeof candidate.answer === "string" ? candidate.answer.trim() : undefined;

    if (!text) {
      throw new Error(`Question ${index + 1} needs text.`);
    }

    if (topic.length > 120) {
      throw new Error(`Question ${index + 1} topic must be 120 characters or fewer.`);
    }

    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 180)) {
      throw new Error(`Question ${index + 1} minutes must be greater than 0 and no more than 180.`);
    }

    if (answer && answer.length > 10000) {
      throw new Error(`Question ${index + 1} answer must be 10000 characters or fewer.`);
    }

    let parts: QuestionPart[] | undefined;
    if (candidate.parts !== undefined) {
      if (!Array.isArray(candidate.parts) || candidate.parts.length === 0) {
        throw new Error(`Question ${index + 1} parts must be a non-empty array.`);
      }

      const parsedParts = candidate.parts.map((part, partIndex) => parseUploadPart(part, index, partIndex));
      const fractions = normalizeFractions(
        parsedParts.map((part) => part.fraction),
        `Question ${index + 1} part`
      );
      const seenIds = new Set<string>();
      parts = parsedParts.map((part, partIndex) => {
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

    const imageFile = resolveUploadedImage(lookup, index, imageReference, "image");
    const answerImageFile = resolveUploadedImage(lookup, index, answerImageReference, "answer image");

    if (imageFile && !isImageFile(imageFile)) {
      throw new Error(`${imageFile.name} is not a supported image file.`);
    }

    if (imageFile && imageFile.size > 2_500_000) {
      throw new Error(`${imageFile.name} is too large. Keep question images under 2.5 MB.`);
    }

    if (answerImageFile && !isImageFile(answerImageFile)) {
      throw new Error(`${answerImageFile.name} is not a supported image file.`);
    }

    if (answerImageFile && answerImageFile.size > 2_500_000) {
      throw new Error(`${answerImageFile.name} is too large. Keep question images under 2.5 MB.`);
    }

    questions.push({
      topic: topic || undefined,
      text,
      code,
      codeLanguage: codeLanguage?.trim() || undefined,
      minutes,
      answer: answer || undefined,
      parts,
      imageDataUrl: imageFile ? await readFileAsDataUrl(imageFile) : undefined,
      imageName: imageFile?.name,
      imageAlt: typeof candidate.imageAlt === "string" ? candidate.imageAlt : undefined,
      answerImageDataUrl: answerImageFile ? await readFileAsDataUrl(answerImageFile) : undefined,
      answerImageName: answerImageFile?.name,
      answerImageAlt: typeof candidate.answerImageAlt === "string" ? candidate.answerImageAlt : undefined
    });
  }

  return questions;
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatPoints(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 3
  }).format(value);
}

function roundPoints(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1
  }).format(value * 100)}%`;
}

function clampCredit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function partGradeKey(teamId: string, partId: string): string {
  return `${teamId}:${partId}`;
}

function partDisplayLabel(part: QuestionPart, index: number): string {
  return part.label || `Part ${index + 1}`;
}

function teamCredit(parts: QuestionPart[], credits: Partial<Record<string, number>> = {}): number {
  return roundPoints(parts.reduce((sum, part) => sum + part.fraction * clampCredit(credits[part.id] ?? 0), 0));
}

function gradeFromCredit(credit: number): Grade {
  return credit >= 0.999 ? "correct" : "incorrect";
}

function creditLabel(credit: number): string {
  if (credit >= 0.999) {
    return "Correct";
  }

  if (credit <= 0.001) {
    return "Incorrect";
  }

  return "Partial";
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTextFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildResultsCsv(room: PublicRoomState): string {
  const maxRound = Math.max(room.settings.questionCount, room.history.length);
  const roundHeaders = Array.from({ length: maxRound }, (_item, index) => [
    `R${index + 1} Wager`,
    `R${index + 1} Grade`,
    `R${index + 1} Credit`,
    `R${index + 1} Score Delta`,
    `R${index + 1} Bonus Delta`,
    `R${index + 1} Part Credits`,
    `R${index + 1} Answer`,
    `R${index + 1} Feedback`,
    `R${index + 1} Protest`,
    `R${index + 1} Protest Status`,
    `R${index + 1} Host Response`
  ]).flat();
  const headers = [
    "Team",
    "Rank",
    "Score",
    "Bonus Points",
    "Correct Answer Points",
    "Rank Bonus",
    "Score Adjustments",
    "Bonus Adjustments",
    "Used Wagers",
    "Correct Count",
    "Incorrect Count",
    "Adjustment Notes",
    ...roundHeaders
  ];

  const historyByTeam = new Map<string, RoundHistoryEntry["results"]>();
  for (const entry of room.history) {
    for (const result of entry.results) {
      const teamResults = historyByTeam.get(result.teamId) ?? [];
      teamResults[entry.round - 1] = result;
      historyByTeam.set(result.teamId, teamResults);
    }
  }

  const rows = room.leaderboard.map((entry) => {
    const team = room.teams.find((candidate) => candidate.id === entry.teamId);
    const results = historyByTeam.get(entry.teamId) ?? [];
    const correctCount = results.filter((result) => result?.grade === "correct").length;
    const incorrectCount = results.filter((result) => result?.grade === "incorrect").length;
    const notes = room.adjustments
      .filter((adjustment) => adjustment.teamId === entry.teamId)
      .map((adjustment) => {
        const parts = [];
        if (adjustment.scoreDelta) parts.push(`score ${adjustment.scoreDelta}`);
        if (adjustment.bonusDelta) parts.push(`bonus ${adjustment.bonusDelta}`);
        return `${parts.join(", ")}${adjustment.note ? `: ${adjustment.note}` : ""}`;
      })
      .join(" | ");

    const roundCells = Array.from({ length: maxRound }, (_item, index) => {
      const result = results[index];
      const partCredits = result?.partResults
        ?.map((part) => `${part.label || part.partId}: ${formatPercent(part.credit)}`)
        .join(" | ");
      return [
        result?.wager ?? "",
        result?.grade ?? "",
        result?.credit ?? "",
        result?.scoreDelta ?? "",
        result?.bonusDelta ?? "",
        partCredits ?? "",
        result?.answer ?? "",
        result?.aiFeedback ?? "",
        result?.protest?.text ?? "",
        result?.protest?.status ?? "",
        result?.protest?.response ?? ""
      ];
    }).flat();

    return [
      entry.name,
      entry.rank,
      entry.correctWagerTotal,
      entry.bonusPoints,
      entry.answerPoints,
      entry.rankBonus,
      entry.scoreAdjustment,
      entry.bonusAdjustment,
      team?.usedWagers.join(" ") ?? "",
      correctCount,
      incorrectCount,
      notes,
      ...roundCells
    ];
  });

  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function wagerValues(count: number): number[] {
  return Array.from({ length: count }, (_item, index) => index + 1);
}

export default function App() {
  const [socket] = useState<Socket>(() => io(SOCKET_URL, { autoConnect: true }));
  const [connected, setConnected] = useState(socket.connected);
  const [session, setSessionState] = useState<SavedSession | null>(() => loadSession());
  const [room, setRoom] = useState<PublicRoomState | null>(null);
  const [error, setError] = useState("");
  const syncInFlight = useRef(false);

  function setSession(next: SavedSession | null): void {
    saveSession(next);
    setSessionState(next);
  }

  const request: RequestFn = (event, payload, timeoutMs = 5000) =>
    new Promise((resolve) => {
      socket.timeout(timeoutMs).emit(event, payload, (err: Error | null, response: Ack) => {
        if (err) {
          resolve({ ok: false, message: `The server did not respond to ${event}.` });
          return;
        }

        resolve(response);
      });
    });

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onState = (next: PublicRoomState) => {
      setError("");
      setRoom(next);
    };
    const onError = (payload: { message?: string }) => setError(payload.message ?? "Something went wrong.");

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room:state", onState);
    socket.on("room:error", onError);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:state", onState);
      socket.off("room:error", onError);
    };
  }, [socket]);

  useEffect(() => {
    if (!session || !socket.connected) {
      return;
    }

    let cancelled = false;

    async function syncSavedSession(showRecoverableError: boolean): Promise<void> {
      if (syncInFlight.current) {
        return;
      }

      syncInFlight.current = true;
      const response = await request<{ code: string; role: Role; teamId?: string }>("room:rejoin", session, 5000);
      syncInFlight.current = false;
      if (cancelled || response.ok) {
        return;
      }

      if (isInvalidSessionMessage(response.message)) {
        setSession(null);
        setRoom(null);
        setError(response.message);
        return;
      }

      if (showRecoverableError) {
        setError(response.message);
      }
    }

    void syncSavedSession(true);
    const interval = window.setInterval(() => {
      void syncSavedSession(false);
    }, STATE_SYNC_INTERVAL_MS);
    const syncOnFocus = () => {
      void syncSavedSession(false);
    };
    const syncOnVisibility = () => {
      if (!document.hidden) {
        void syncSavedSession(false);
      }
    };

    window.addEventListener("focus", syncOnFocus);
    document.addEventListener("visibilitychange", syncOnVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", syncOnFocus);
      document.removeEventListener("visibilitychange", syncOnVisibility);
    };
  }, [socket.connected, session?.code, session?.role, session?.hostToken, session?.teamToken]);

  useEffect(() => {
    if (!session || !socket.connected || !room || room.code === session.code) {
      return;
    }

    request<{ code: string; role: Role; teamId?: string }>("room:rejoin", session, 5000).then((response) => {
      if (!response.ok) {
        if (isInvalidSessionMessage(response.message)) {
          setSession(null);
          setRoom(null);
        }
        setError(response.message);
      }
    });
  }, [room?.code, socket.connected, session?.code, session?.role, session?.hostToken, session?.teamToken]);

  async function createRoom(): Promise<void> {
    const response = await request<{ code: string; hostToken: string }>("room:create", {});
    if (!response.ok) {
      setError(response.message);
      return;
    }

    setSession({ code: response.code, role: "host", hostToken: response.hostToken });
  }

  async function joinRoom(code: string, name: string): Promise<void> {
    const response = await request<{ code: string; teamId: string; teamToken: string }>("room:join", {
      code,
      name
    });

    if (!response.ok) {
      setError(response.message);
      return;
    }

    setSession({
      code: response.code,
      role: "team",
      teamId: response.teamId,
      teamToken: response.teamToken,
      teamName: name.trim()
    });
  }

  function leaveRoom(): void {
    setSession(null);
    setRoom(null);
    setError("");
    socket.disconnect();
    socket.connect();
  }

  const activeRoom = room && session && room.code === session.code ? room : null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand">TA Game</div>
          <div className="connection">{connected ? "Connected" : "Reconnecting"}</div>
        </div>
        {activeRoom ? (
          <button className="icon-text secondary" onClick={leaveRoom}>
            <DoorOpen size={18} />
            Leave
          </button>
        ) : null}
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {!activeRoom || !session ? (
        <Home connected={connected} onCreate={createRoom} onJoin={joinRoom} />
      ) : session.role === "host" ? (
        <HostApp room={activeRoom} request={request} session={session} />
      ) : (
        <TeamApp room={activeRoom} request={request} session={session} />
      )}
    </main>
  );
}

function Home({
  connected,
  onCreate,
  onJoin
}: {
  connected: boolean;
  onCreate: () => Promise<void>;
  onJoin: (code: string, name: string) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitJoin(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    await onJoin(code, name);
    setBusy(false);
  }

  async function submitCreate(): Promise<void> {
    setBusy(true);
    await onCreate();
    setBusy(false);
  }

  return (
    <section className="home-grid">
      <div className="entry-panel">
        <div className="panel-title">
          <Plus size={20} />
          Host
        </div>
        <button className="primary wide" disabled={!connected || busy} onClick={submitCreate}>
          <Plus size={18} />
          Create Room
        </button>
      </div>

      <form className="entry-panel" onSubmit={submitJoin}>
        <div className="panel-title">
          <LogIn size={20} />
          Join
        </div>
        <label>
          Room code
          <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={8} />
        </label>
        <label>
          Team name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={32} />
        </label>
        <button className="primary wide" disabled={!connected || busy || !code.trim() || !name.trim()}>
          <LogIn size={18} />
          Join Room
        </button>
      </form>
    </section>
  );
}

function HostApp({ room, request, session }: { room: PublicRoomState; request: RequestFn; session: SavedSession }) {
  if (!session.hostToken) {
    return <div className="empty-state">Host session missing.</div>;
  }

  const payload = { code: room.code, hostToken: session.hostToken };

  if (room.phase === "lobby") {
    return <HostLobby room={room} request={request} hostPayload={payload} />;
  }

  return (
    <GameFrame room={room}>
      <HostGame room={room} request={request} hostPayload={payload} />
    </GameFrame>
  );
}

function TeamApp({ room, request, session }: { room: PublicRoomState; request: RequestFn; session: SavedSession }) {
  if (!session.teamToken) {
    return <div className="empty-state">Team session missing.</div>;
  }

  const team = room.teams.find((candidate) => candidate.id === room.viewerTeamId);
  if (!team) {
    return <div className="empty-state">Team not found in this room.</div>;
  }

  if (room.phase === "lobby") {
    return <TeamLobby room={room} team={team} />;
  }

  return (
    <GameFrame room={room}>
      <TeamGame room={room} request={request} team={team} teamToken={session.teamToken} />
    </GameFrame>
  );
}

function HostLobby({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  const [questionCount, setQuestionCount] = useState(String(room.settings.questionCount));
  const [pointsPerCorrect, setPointsPerCorrect] = useState(String(room.settings.pointsPerCorrect));
  const [bonusText, setBonusText] = useState(room.settings.bonusByRank.join(","));
  const [answerRevealMode, setAnswerRevealMode] = useState<AnswerRevealMode>(room.settings.answerRevealMode);
  const [scrambleQuestionOrder, setScrambleQuestionOrder] = useState(room.settings.scrambleQuestionOrder);
  const [hideLeaderboardDuringAnswering, setHideLeaderboardDuringAnswering] = useState(
    room.settings.hideLeaderboardDuringAnswering
  );
  const [llmGradingEnabled, setLlmGradingEnabled] = useState(room.settings.llmGradingEnabled);
  const [showFullGemmaResponse, setShowFullGemmaResponse] = useState(room.settings.showFullGemmaResponse);
  const [llmGradingPassword, setLlmGradingPassword] = useState("");
  const [status, setStatus] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const uploadedQuestionCount = room.settings.questions.length;

  useEffect(() => {
    setQuestionCount(String(room.settings.questionCount));
    setPointsPerCorrect(String(room.settings.pointsPerCorrect));
    setBonusText(room.settings.bonusByRank.join(","));
    setAnswerRevealMode(room.settings.answerRevealMode);
    setScrambleQuestionOrder(room.settings.scrambleQuestionOrder);
    setHideLeaderboardDuringAnswering(room.settings.hideLeaderboardDuringAnswering);
    setLlmGradingEnabled(room.settings.llmGradingEnabled);
    setShowFullGemmaResponse(room.settings.showFullGemmaResponse);
    if (room.settings.llmGradingEnabled) {
      setLlmGradingPassword("");
    }
  }, [
    room.settings.questionCount,
    room.settings.pointsPerCorrect,
    room.settings.bonusByRank.join(","),
    room.settings.answerRevealMode,
    room.settings.scrambleQuestionOrder,
    room.settings.hideLeaderboardDuringAnswering,
    room.settings.llmGradingEnabled,
    room.settings.showFullGemmaResponse
  ]);

  function settingsPayload(settings: GameSettings): unknown {
    return {
      ...hostPayload,
      settings,
      llmGradingPassword:
        settings.llmGradingEnabled && !room.settings.llmGradingEnabled ? llmGradingPassword : undefined
    };
  }

  async function saveSettings(event: FormEvent): Promise<void> {
    event.preventDefault();
    const bonusByRank = parseBonusText(bonusText);
    if (!bonusByRank) {
      setStatus("Bonus list needs comma-separated whole numbers.");
      return;
    }

    const settings: GameSettings = {
      questionCount: uploadedQuestionCount || Number(questionCount),
      pointsPerCorrect: Number(pointsPerCorrect),
      bonusByRank,
      questions: room.settings.questions,
      scrambleQuestionOrder,
      answerRevealMode,
      hideLeaderboardDuringAnswering,
      llmGradingEnabled,
      showFullGemmaResponse
    };

    const response = await request("settings:update", settingsPayload(settings));
    setStatus(response.ok ? "Settings saved." : response.message);
  }

  async function uploadQuestions(fileList: FileList | null): Promise<void> {
    setUploadStatus("Reading upload...");

    try {
      const questions = await parseQuestionUpload(fileList);
      const bonusByRank = parseBonusText(bonusText);
      if (!bonusByRank) {
        setUploadStatus("Bonus list needs comma-separated whole numbers.");
        return;
      }

      const settings: GameSettings = {
        questionCount: questions.length,
        pointsPerCorrect: Number(pointsPerCorrect),
        bonusByRank,
        questions,
        scrambleQuestionOrder,
        answerRevealMode,
        hideLeaderboardDuringAnswering,
        llmGradingEnabled,
        showFullGemmaResponse
      };

      const response = await request("settings:update", settingsPayload(settings));

      setUploadStatus(response.ok ? `Loaded ${questions.length} questions.` : response.message);
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : "Could not read question upload.");
    }
  }

  async function clearQuestions(): Promise<void> {
    const bonusByRank = parseBonusText(bonusText);
    if (!bonusByRank) {
      setUploadStatus("Bonus list needs comma-separated whole numbers.");
      return;
    }

    const settings: GameSettings = {
      questionCount: Math.max(1, Number(questionCount) || room.settings.questionCount),
      pointsPerCorrect: Number(pointsPerCorrect),
      bonusByRank,
      questions: [],
      scrambleQuestionOrder,
      answerRevealMode,
      hideLeaderboardDuringAnswering,
      llmGradingEnabled,
      showFullGemmaResponse
    };

    const response = await request("settings:update", settingsPayload(settings));

    setUploadStatus(response.ok ? "Questions cleared." : response.message);
  }

  async function startGame(): Promise<void> {
    const response = await request("game:start", hostPayload);
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  return (
    <section className="lobby-layout">
      <div className="lobby-main">
        <div className="room-code-row">
          <div>
            <span className="eyebrow">Room</span>
            <strong>{room.code}</strong>
          </div>
          <button
            className="icon-only"
            title="Copy room code"
            onClick={() => navigator.clipboard?.writeText(room.code)}
          >
            <Clipboard size={18} />
          </button>
        </div>

        <form className="settings-panel" onSubmit={saveSettings}>
          <div className="panel-title">
            <SettingsIcon size={20} />
            Settings
          </div>
          <div className="settings-grid">
            <label>
              Questions
              <input
                type="number"
                min={1}
                max={30}
                value={questionCount}
                disabled={uploadedQuestionCount > 0}
                onChange={(event) => setQuestionCount(event.target.value)}
              />
            </label>
            <label>
              Points per correct
              <input
                type="number"
                min={0}
                step="any"
                value={pointsPerCorrect}
                onChange={(event) => setPointsPerCorrect(event.target.value)}
              />
            </label>
            <label className="span-2">
              Rank bonuses
              <input value={bonusText} onChange={(event) => setBonusText(event.target.value)} />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={scrambleQuestionOrder}
                onChange={(event) => setScrambleQuestionOrder(event.target.checked)}
              />
              Scramble question order at start
            </label>
            <label>
              Answer reveal
              <select
                value={answerRevealMode}
                onChange={(event) => setAnswerRevealMode(event.target.value as AnswerRevealMode)}
              >
                <option value="host_only">Host only</option>
                <option value="after_grading">Show answers after grading</option>
                <option value="status_only">Show status only</option>
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={hideLeaderboardDuringAnswering}
                onChange={(event) => setHideLeaderboardDuringAnswering(event.target.checked)}
              />
              Hide team leaderboard while answering
            </label>
            <label className="checkbox-label span-2">
              <input
                type="checkbox"
                checked={llmGradingEnabled}
                onChange={(event) => setLlmGradingEnabled(event.target.checked)}
              />
              Enable LLM grading suggestions
            </label>
            <label className="checkbox-label span-2">
              <input
                type="checkbox"
                checked={showFullGemmaResponse}
                onChange={(event) => setShowFullGemmaResponse(event.target.checked)}
              />
              Show full Gemma response while grading (host-only debug)
            </label>
            {llmGradingEnabled && !room.settings.llmGradingEnabled ? (
              <label className="span-2">
                LLM grading password
                <input
                  type="password"
                  value={llmGradingPassword}
                  autoComplete="off"
                  onChange={(event) => setLlmGradingPassword(event.target.value)}
                />
              </label>
            ) : null}
            {room.settings.llmGradingEnabled ? (
              <div className="settings-note span-2">LLM grading suggestions are enabled for this room.</div>
            ) : null}
          </div>
          <div className="upload-panel">
            <div>
              <div className="upload-title">Questions</div>
              <div className="upload-count">
                {uploadedQuestionCount > 0 ? `${uploadedQuestionCount} loaded` : "No uploaded questions"}
              </div>
            </div>
            <div className="upload-actions">
              <label className="file-button">
                File
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => {
                    void uploadQuestions(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <label className="file-button">
                Folder
                <input
                  type="file"
                  multiple
                  accept=".json,application/json,image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                  onChange={(event) => {
                    void uploadQuestions(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  {...{ webkitdirectory: "", directory: "" }}
                />
              </label>
              <button className="secondary" type="button" disabled={uploadedQuestionCount === 0} onClick={clearQuestions}>
                <RotateCcw size={18} />
                Clear
              </button>
            </div>
            {uploadStatus ? <div className="status-line span-2">{uploadStatus}</div> : null}
          </div>
          <div className="action-row">
            <button className="secondary" type="submit">
              <SettingsIcon size={18} />
              Save
            </button>
            <button className="primary" type="button" disabled={room.teams.length === 0} onClick={startGame}>
              <Play size={18} />
              Start Game
            </button>
          </div>
          {status ? <div className="status-line">{status}</div> : null}
        </form>
        <QuestionPreviewList questions={room.settings.questions} />
      </div>

      <aside className="lobby-side">
        <div className="panel-title">
          <Users size={20} />
          Teams
        </div>
        <TeamList teams={room.teams} request={request} hostPayload={hostPayload} removable />
        <RulesPanel />
      </aside>
    </section>
  );
}

function TeamLobby({ room, team }: { room: PublicRoomState; team: PublicTeam }) {
  return (
    <section className="waiting-panel">
      <div className="room-code-row">
        <div>
          <span className="eyebrow">Room</span>
          <strong>{room.code}</strong>
        </div>
        <div className="team-pill">{team.name}</div>
      </div>
      <div className="panel-title">
        <Users size={20} />
        Teams
      </div>
      <TeamList teams={room.teams} />
      <RulesPanel />
    </section>
  );
}

function GameFrame({ room, children }: { room: PublicRoomState; children: React.ReactNode }) {
  const hideLeaderboard =
    room.role === "team" && room.phase === "answering" && room.settings.hideLeaderboardDuringAnswering;

  return (
    <section className="game-grid">
      <div className="game-main">
        <div className="game-header">
          <div>
            <span className="eyebrow">Room {room.code}</span>
            <h1>
              Round {room.currentRound || room.settings.questionCount} of {room.settings.questionCount}
            </h1>
          </div>
          <PhaseBadge phase={room.phase} />
        </div>
        {children}
      </div>
      <aside className="side-stack">
        {hideLeaderboard ? <HiddenLeaderboardNotice /> : <Leaderboard room={room} />}
        <RulesPanel />
      </aside>
    </section>
  );
}

function currentQuestion(room: PublicRoomState): Question | undefined {
  return room.settings.questions[room.currentRound - 1];
}

function RoundTopicCard({ question, round }: { question?: Question; round: number }) {
  if (!question) {
    return null;
  }

  return (
    <article className="round-topic-card">
      <div className="question-label">Round {round} topic</div>
      <div className="question-topic prominent">{questionTopic(question)}</div>
    </article>
  );
}

function QuestionCard({
  question,
  round,
  compact = false,
  showAnswer = false
}: {
  question?: Question;
  round: number;
  compact?: boolean;
  showAnswer?: boolean;
}) {
  if (!question) {
    return null;
  }

  const hasExplicitParts = Boolean(question.parts?.length);

  return (
    <article className={compact ? "question-card compact" : "question-card"}>
      {question.topic ? (
        <>
          <div className="question-label">Topic</div>
          <div className="question-topic">{question.topic}</div>
        </>
      ) : null}
      <div className="question-label">Question {round}</div>
      <div className="question-text">{question.text}</div>
      {question.imageDataUrl ? (
        <img className="question-image" src={question.imageDataUrl} alt={question.imageAlt || question.imageName || ""} />
      ) : null}
      {question.code ? (
        <div className="question-code-wrap">
          {question.codeLanguage ? <div className="code-label">{question.codeLanguage}</div> : null}
          <pre className="question-code">
            <code>{question.code}</code>
          </pre>
        </div>
      ) : null}
      {showAnswer && question.answer ? <OfficialAnswer answer={question.answer} /> : null}
      {hasExplicitParts ? (
        <div className="question-parts">
          {question.parts?.map((part, index) => (
            <section className="question-part" key={part.id}>
              <div className="question-part-head">
                <strong>{partDisplayLabel(part, index)}</strong>
                <span>{formatPercent(part.fraction)}</span>
              </div>
              <div className="question-text">{part.text}</div>
              {part.code ? (
                <div className="question-code-wrap">
                  {part.codeLanguage ? <div className="code-label">{part.codeLanguage}</div> : null}
                  <pre className="question-code">
                    <code>{part.code}</code>
                  </pre>
                </div>
              ) : null}
              {showAnswer && part.answer ? <OfficialAnswer answer={part.answer} /> : null}
            </section>
          ))}
        </div>
      ) : null}
      {showAnswer && question.answerImageDataUrl ? (
        <div className="answer-image-wrap">
          <div className="question-label">Answer Diagram</div>
          <img
            className="question-image"
            src={question.answerImageDataUrl}
            alt={question.answerImageAlt || question.answerImageName || ""}
          />
        </div>
      ) : null}
    </article>
  );
}

function OfficialAnswer({ answer }: { answer: string }) {
  return (
    <div className="official-answer">
      <div className="question-label">Official Answer</div>
      <div className="answer-text">{answer}</div>
    </div>
  );
}

function QuestionPreviewList({ questions }: { questions: Question[] }) {
  if (questions.length === 0) {
    return null;
  }

  return (
    <section className="settings-panel">
      <div className="panel-title">
        <Eye size={20} />
        Question Preview
      </div>
      <div className="preview-list">
        {questions.map((question, index) => (
          <details className="preview-item" key={`${index}-${question.text.slice(0, 20)}`}>
            <summary>
              <span>
                Question {index + 1}
                {question.topic ? ` · ${question.topic}` : ""}
              </span>
              <span>
                {question.minutes ? `${question.minutes} min` : "Timer manual"}
                {question.imageDataUrl ? " · image" : ""}
                {question.answerImageDataUrl ? " · reveal image" : ""}
                {question.code ? " · code" : ""}
                {question.parts?.length ? ` · ${question.parts.length} parts` : ""}
                {question.answer ? " · answer" : ""}
              </span>
            </summary>
            <QuestionCard question={question} round={index + 1} compact showAnswer />
          </details>
        ))}
      </div>
    </section>
  );
}

function HostGame({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  function gamePanel(): React.ReactNode {
    if (room.phase === "round_setup") {
      return <HostRoundSetup room={room} request={request} hostPayload={hostPayload} />;
    }

    if (room.phase === "answering") {
      return <HostAnswering room={room} request={request} hostPayload={hostPayload} />;
    }

    if (room.phase === "grading") {
      return <HostGrading room={room} request={request} hostPayload={hostPayload} />;
    }

    if (room.phase === "between_rounds") {
      return <HostBetweenRounds room={room} request={request} hostPayload={hostPayload} />;
    }

    return <HostFinished room={room} request={request} hostPayload={hostPayload} />;
  }

  if (room.phase === "finished") {
    return gamePanel();
  }

  return (
    <div className="stack-panels">
      <HostGameActions request={request} hostPayload={hostPayload} />
      {gamePanel()}
    </div>
  );
}

function HostGameActions({
  request,
  hostPayload
}: {
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  const [status, setStatus] = useState("");

  async function endGameEarly(): Promise<void> {
    const confirmed = window.confirm("End the game now? The current unfinished round will not be scored.");
    if (!confirmed) {
      return;
    }

    const response = await request("game:endEarly", hostPayload);
    setStatus(response.ok ? "" : response.message);
  }

  return (
    <div className="host-game-actions">
      <button className="secondary danger-text" onClick={endGameEarly}>
        <X size={18} />
        End Game Early
      </button>
      {status ? <div className="status-line">{status}</div> : null}
    </div>
  );
}

function HostRoundSetup({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  const questionMinutes = currentQuestion(room)?.minutes;
  const [minutes, setMinutes] = useState(String(questionMinutes ?? 2));
  const [status, setStatus] = useState("");
  const missingWagerTeams = room.teams.filter((team) => !team.wagerLocked);
  const allLocked = room.teams.length > 0 && missingWagerTeams.length === 0;

  useEffect(() => {
    setMinutes(String(questionMinutes ?? 2));
  }, [room.currentRound, questionMinutes]);

  async function startAnswers(forceMissingWagers = false): Promise<void> {
    const response = await request("round:startAnswering", {
      ...hostPayload,
      durationMinutes: Number(minutes),
      forceMissingWagers
    });
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  async function handleStartTimer(): Promise<void> {
    if (missingWagerTeams.length === 0) {
      await startAnswers();
      return;
    }

    const names = missingWagerTeams.map((team) => team.name).join(", ");
    const confirmed = window.confirm(
      `Start anyway? ${names} ${missingWagerTeams.length === 1 ? "has" : "have"} not submitted a wager. ` +
        "They will be assigned their lowest available wager."
    );

    if (confirmed) {
      await startAnswers(true);
    }
  }

  return (
    <div className="flow-panel">
      <RoundTopicCard question={currentQuestion(room)} round={room.currentRound} />
      <div className="round-toolbar">
        <label>
          Minutes {questionMinutes ? "(from question)" : ""}
          <input
            type="number"
            min={0.1}
            max={180}
            step={0.25}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
        <button className="primary" disabled={room.teams.length === 0} onClick={handleStartTimer}>
          <Timer size={18} />
          {allLocked ? "Start Timer" : "Start Timer Anyway"}
        </button>
      </div>
      {!allLocked ? (
        <div className="status-line info">
          Missing wagers will be auto-filled with each team's lowest available wager if you confirm.
        </div>
      ) : null}
      <TeamRoundTable teams={room.teams} />
      {status ? <div className="status-line">{status}</div> : null}
    </div>
  );
}

function HostAnswering({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  const [status, setStatus] = useState("");

  async function addMinute(): Promise<void> {
    const response = await request("round:addMinute", hostPayload);
    setStatus(response.ok ? "" : response.message);
  }

  async function stopTimer(): Promise<void> {
    const response = await request("round:stopAnswering", hostPayload);
    setStatus(response.ok ? "" : response.message);
  }

  return (
    <div className="flow-panel">
      <QuestionCard question={currentQuestion(room)} round={room.currentRound} />
      <div className="round-toolbar">
        <TimerDisplay endsAt={room.roundEndsAt} />
        <div className="timer-toolbar-actions">
          <button className="secondary" onClick={addMinute}>
            <Plus size={18} />
            Add 1 Minute
          </button>
          <button className="secondary" onClick={stopTimer}>
            <Timer size={18} />
            Stop Timer
          </button>
        </div>
      </div>
      <AnswerTable teams={room.teams} />
      {status ? <div className="status-line">{status}</div> : null}
    </div>
  );
}

function HostGrading({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  const question = currentQuestion(room);
  const parts = questionParts(question);
  const partSignature = parts.map((part) => part.id).join("|");
  const [partCredits, setPartCredits] = useState<Record<string, Partial<Record<string, number>>>>({});
  const [reviewing, setReviewing] = useState(false);
  const [status, setStatus] = useState("");
  const [suggestions, setSuggestions] = useState<GradeSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionStatus, setSuggestionStatus] = useState("");
  const [suggestionTone, setSuggestionTone] = useState<"info" | "error">("info");
  const [gemmaDebugBatches, setGemmaDebugBatches] = useState<GemmaDebugBatch[]>([]);
  const [copiedDebugKey, setCopiedDebugKey] = useState("");
  const touchedPartKeys = useRef<Set<string>>(new Set());
  const suggestionRequestId = useRef(0);

  function suggestedCreditForPart(suggestion: GradeSuggestion, part: QuestionPart): number | undefined {
    const partSuggestion = suggestion.partSuggestions?.find((item) => item.partId === part.id);
    if (partSuggestion) {
      return partSuggestion.credit;
    }

    if (parts.length > 1) {
      return undefined;
    }

    if (typeof suggestion.credit === "number") {
      return suggestion.credit;
    }

    return suggestion.grade === "correct" ? 1 : 0;
  }

  function suggestionCreditForTeam(suggestion: GradeSuggestion): number {
    if (suggestion.partSuggestions?.length) {
      const suggestedCredits = Object.fromEntries(
        suggestion.partSuggestions.map((part) => [part.partId, part.credit])
      );
      return teamCredit(parts, suggestedCredits);
    }

    if (typeof suggestion.credit === "number") {
      return suggestion.credit;
    }

    return suggestion.grade === "correct" ? 1 : 0;
  }

  function normalizedPartCredits(): Record<string, Record<string, number>> {
    return Object.fromEntries(
      room.teams.map((team) => [
        team.id,
        Object.fromEntries(
          parts.map((part) => [part.id, clampCredit(partCredits[team.id]?.[part.id] ?? 0)])
        )
      ])
    );
  }

  function gradesFromPartCredits(nextPartCredits: Record<string, Record<string, number>>): Record<string, Grade> {
    return Object.fromEntries(
      room.teams.map((team) => [team.id, gradeFromCredit(teamCredit(parts, nextPartCredits[team.id]))])
    );
  }

  function applySuggestionCredits(nextSuggestions: GradeSuggestion[]): void {
    setPartCredits((current) => {
      let changed = false;
      const next = { ...current };

      for (const suggestion of nextSuggestions) {
        if (!room.teams.some((team) => team.id === suggestion.teamId)) {
          continue;
        }

        const teamCredits = { ...(next[suggestion.teamId] ?? {}) };
        let teamChanged = false;

        for (const part of parts) {
          const key = partGradeKey(suggestion.teamId, part.id);
          if (touchedPartKeys.current.has(key)) {
            continue;
          }

          const credit = suggestedCreditForPart(suggestion, part);
          if (credit === undefined) {
            continue;
          }

          teamCredits[part.id] = clampCredit(credit);
          teamChanged = true;
        }

        if (teamChanged) {
          next[suggestion.teamId] = teamCredits;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }

  async function requestSuggestions(): Promise<void> {
    const requestId = suggestionRequestId.current + 1;
    suggestionRequestId.current = requestId;
    setSuggesting(true);
    setSuggestionTone("info");
    setSuggestionStatus("Asking Gemma for suggestions...");

    const round = room.currentRound;
    const suggestionTimeoutMs = Math.max(60000, 15000 + room.teams.length * 15000);
    const response = await request<{ suggestions: GradeSuggestion[]; debugBatches?: GemmaDebugBatch[] }>(
      "grading:suggest",
      hostPayload,
      suggestionTimeoutMs
    );
    if (suggestionRequestId.current !== requestId || room.currentRound !== round) {
      return;
    }

    setSuggesting(false);
    if (!response.ok) {
      setSuggestionTone("error");
      setSuggestionStatus(response.message);
      return;
    }

    setSuggestions(response.suggestions);
    setGemmaDebugBatches(response.debugBatches ?? []);
    applySuggestionCredits(response.suggestions);
    setSuggestionTone("info");
    setSuggestionStatus(
      response.suggestions.length > 0
        ? "Gemma suggestions loaded for untouched credit boxes."
        : "Gemma did not return grade suggestions."
    );
  }

  function markPartCredit(teamId: string, partId: string, credit: number | undefined): void {
    touchedPartKeys.current.add(partGradeKey(teamId, partId));
    setPartCredits((current) => {
      const nextTeamCredits = { ...(current[teamId] ?? {}) };
      if (credit === undefined) {
        delete nextTeamCredits[partId];
      } else {
        nextTeamCredits[partId] = clampCredit(credit);
      }

      return {
        ...current,
        [teamId]: nextTeamCredits
      };
    });
  }

  function markTeamCredit(teamId: string, credit: number): void {
    for (const part of parts) {
      touchedPartKeys.current.add(partGradeKey(teamId, part.id));
    }

    setPartCredits((current) => ({
      ...current,
      [teamId]: Object.fromEntries(parts.map((part) => [part.id, clampCredit(credit)]))
    }));
  }

  async function copyDebugText(key: string, text: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedDebugKey(key);
      window.setTimeout(() => {
        setCopiedDebugKey((current) => (current === key ? "" : current));
      }, 1500);
    } catch {
      setSuggestionTone("error");
      setSuggestionStatus("Could not copy the Gemma debug block.");
    }
  }

  useEffect(() => {
    const defaults: Record<string, Partial<Record<string, number>>> = {};
    const touched = new Set<string>();
    for (const team of room.teams) {
      if (!team.hasSubmittedAnswer) {
        defaults[team.id] = Object.fromEntries(parts.map((part) => [part.id, 0]));
        for (const part of parts) {
          touched.add(partGradeKey(team.id, part.id));
        }
      }
    }
    touchedPartKeys.current = touched;
    suggestionRequestId.current += 1;
    setPartCredits(defaults);
    setSuggestions([]);
    setSuggestionStatus("");
    setSuggestionTone("info");
    setSuggesting(false);
    setGemmaDebugBatches([]);
    setCopiedDebugKey("");
    setReviewing(false);
  }, [room.currentRound, partSignature]);

  const ready =
    parts.length > 0 &&
    room.teams.every((team) =>
      parts.every((part) => typeof partCredits[team.id]?.[part.id] === "number")
    );
  const suggestionByTeam = new Map(suggestions.map((suggestion) => [suggestion.teamId, suggestion]));

  async function submitGrades(): Promise<void> {
    const nextPartCredits = normalizedPartCredits();
    const grades = gradesFromPartCredits(nextPartCredits);
    const response = await request(
      "answer:grade",
      { ...hostPayload, grades, partCredits: nextPartCredits },
      room.settings.llmGradingEnabled ? 30000 : undefined
    );
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  return (
    <div className="flow-panel">
      <QuestionCard question={question} round={room.currentRound} showAnswer />
      {reviewing ? (
        <GradeReview
          room={room}
          parts={parts}
          partCredits={normalizedPartCredits()}
          onEdit={() => setReviewing(false)}
          onSubmit={submitGrades}
        />
      ) : (
        <>
          <div className="grading-toolbar">
            <div className="eyebrow">Host Grading</div>
            {room.settings.llmGradingEnabled ? (
              <button className="secondary" disabled={suggesting} onClick={() => requestSuggestions()}>
                <Sparkles size={18} />
                {suggesting ? "Suggesting" : "Suggest Grades"}
              </button>
            ) : null}
          </div>
          <div className="answer-list">
            {room.teams.map((team) => {
              const suggestion = suggestionByTeam.get(team.id);
              const credits = partCredits[team.id] ?? {};
              const totalCredit = teamCredit(parts, credits);
              const suggestionCredit = suggestion ? suggestionCreditForTeam(suggestion) : undefined;
              const partSuggestionById = new Map((suggestion?.partSuggestions ?? []).map((part) => [part.partId, part]));
              return (
                <div className="grade-row" key={team.id}>
                  <div>
                    <div className="team-name">{team.name}</div>
                    <div className="answer-text">{team.currentAnswer || "No answer submitted"}</div>
                    {suggestion ? (
                      <div className="suggestion-note">
                        <Sparkles size={14} />
                        <span>
                          Gemma: <strong>{creditLabel(suggestionCredit ?? 0)}</strong>
                          {suggestionCredit !== undefined ? ` (${formatPercent(suggestionCredit)})` : ""}
                          {typeof suggestion.confidence === "number"
                            ? ` (${Math.round(suggestion.confidence * 100)}%)`
                            : ""}
                          {suggestion.rationale ? ` - ${suggestion.rationale}` : ""}
                        </span>
                      </div>
                    ) : null}
                    {suggestion?.feedback ? (
                      <div className="suggestion-feedback">
                        Student feedback: {suggestion.feedback}
                      </div>
                    ) : null}
                    <div className="part-grade-list">
                      {parts.map((part, index) => {
                        const credit = credits[part.id];
                        const partSuggestion = partSuggestionById.get(part.id);
                        return (
                          <div className="part-grade-row" key={part.id}>
                            <label className="part-check">
                              <input
                                type="checkbox"
                                checked={credit !== undefined && credit >= 0.999}
                                onChange={(event) => markPartCredit(team.id, part.id, event.target.checked ? 1 : 0)}
                              />
                              <span>{partDisplayLabel(part, index)}</span>
                            </label>
                            <input
                              aria-label={`${team.name} ${partDisplayLabel(part, index)} partial credit`}
                              className="credit-input"
                              type="number"
                              min={0}
                              max={1}
                              step={0.05}
                              inputMode="decimal"
                              value={credit ?? ""}
                              onChange={(event) =>
                                markPartCredit(
                                  team.id,
                                  part.id,
                                  event.target.value === "" ? undefined : Number(event.target.value)
                                )
                              }
                            />
                            <span className="part-fraction">{formatPercent(part.fraction)} value</span>
                            {partSuggestion ? (
                              <div className="part-suggestion">
                                <Sparkles size={12} />
                                <span>
                                  Gemma {formatPercent(partSuggestion.credit)}
                                  {partSuggestion.rationale ? ` - ${partSuggestion.rationale}` : ""}
                                </span>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="grade-summary">
                    <strong>{formatPercent(totalCredit)}</strong>
                    <span>{creditLabel(totalCredit)}</span>
                    <div className="grade-actions compact">
                      <button className="secondary" type="button" onClick={() => markTeamCredit(team.id, 1)}>
                        Full
                      </button>
                      <button className="secondary" type="button" onClick={() => markTeamCredit(team.id, 0)}>
                        Zero
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {suggestionStatus ? <div className={`status-line ${suggestionTone}`}>{suggestionStatus}</div> : null}
          {room.settings.showFullGemmaResponse && gemmaDebugBatches.length > 0 ? (
            <details className="debug-panel">
              <summary>Gemma Debug Response</summary>
              <div className="debug-batch-list">
                {gemmaDebugBatches.map((batch) => (
                  <section className="debug-batch" key={`${batch.batchIndex}-${batch.teamIds.join(",")}`}>
                    <div className="question-label">
                      Batch {batch.batchIndex} of {batch.batchCount} · teams {batch.teamIds.join(", ")}
                    </div>
                    <DebugTextBlock
                      label="Prompt"
                      value={batch.prompt}
                      copied={copiedDebugKey === `prompt-${batch.batchIndex}`}
                      onCopy={() => copyDebugText(`prompt-${batch.batchIndex}`, batch.prompt)}
                    />
                    {batch.modelText ? (
                      <DebugTextBlock
                        label="Model Text"
                        value={batch.modelText}
                        copied={copiedDebugKey === `model-${batch.batchIndex}`}
                        onCopy={() => copyDebugText(`model-${batch.batchIndex}`, batch.modelText ?? "")}
                      />
                    ) : null}
                    {batch.rawResponse ? (
                      <DebugTextBlock
                        label="Raw Response"
                        value={batch.rawResponse}
                        copied={copiedDebugKey === `raw-${batch.batchIndex}`}
                        onCopy={() => copyDebugText(`raw-${batch.batchIndex}`, batch.rawResponse ?? "")}
                      />
                    ) : null}
                  </section>
                ))}
              </div>
            </details>
          ) : null}
          <button className="primary submit-row" disabled={!ready} onClick={() => setReviewing(true)}>
            <Check size={18} />
            Review Grades
          </button>
        </>
      )}
      {status ? <div className="status-line">{status}</div> : null}
    </div>
  );
}

function DebugTextBlock({
  label,
  value,
  copied,
  onCopy
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="debug-text-block">
      <div className="question-label">{label}</div>
      <div className="debug-code-wrap">
        <button className="debug-copy-button" type="button" onClick={onCopy}>
          <Clipboard size={14} />
          {copied ? "Copied" : "Copy"}
        </button>
        <pre className="question-code debug-code">
          <code>{value}</code>
        </pre>
      </div>
    </div>
  );
}

function GradeReview({
  room,
  parts,
  partCredits,
  onEdit,
  onSubmit
}: {
  room: PublicRoomState;
  parts: QuestionPart[];
  partCredits: Record<string, Record<string, number>>;
  onEdit: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="review-panel">
      <div className="panel-title">
        <Check size={20} />
        Review Grades
      </div>
      <div className="data-table">
        <div className="review-row review-head">
          <span>Team</span>
          <span>Grade</span>
          <span>Score</span>
          <span>Bonus</span>
        </div>
        {room.teams.map((team) => {
          const credits = partCredits[team.id] ?? {};
          const credit = teamCredit(parts, credits);
          const scoreDelta = roundPoints((team.currentWager ?? 0) * credit);
          const bonusDelta = roundPoints(room.settings.pointsPerCorrect * credit);
          return (
            <div className="review-row" key={team.id}>
              <span className="team-name">
                {team.name}
                <small>
                  {parts.map((part, index) => (
                    <span key={part.id}>
                      {partDisplayLabel(part, index)} {formatPercent(credits[part.id] ?? 0)}
                    </span>
                  ))}
                </small>
              </span>
              <span>
                {creditLabel(credit)} ({formatPercent(credit)})
              </span>
              <span>+{formatPoints(scoreDelta)}</span>
              <span>+{formatPoints(bonusDelta)}</span>
            </div>
          );
        })}
      </div>
      <div className="action-row">
        <button className="secondary" onClick={onEdit}>
          <X size={18} />
          Edit
        </button>
        <button className="primary" onClick={onSubmit}>
          <Check size={18} />
          Finalize Grades
        </button>
      </div>
    </div>
  );
}

function HostBetweenRounds({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  const [status, setStatus] = useState("");

  async function nextRound(): Promise<void> {
    const response = await request("round:advance", hostPayload);
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  return (
    <div className="stack-panels">
      <div className="flow-panel centered">
        <Trophy size={36} />
        <h2>Round {room.currentRound} scored</h2>
        <button className="primary" onClick={nextRound}>
          <Play size={18} />
          Next Round
        </button>
        {status ? <div className="status-line">{status}</div> : null}
      </div>
      <RoundHistoryPanel room={room} request={request} hostPayload={hostPayload} />
      <ManualAdjustmentPanel room={room} request={request} hostPayload={hostPayload} />
    </div>
  );
}

function HostFinished({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  const [status, setStatus] = useState("");

  async function resetGame(): Promise<void> {
    const response = await request("game:reset", hostPayload);
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  function exportCsv(): void {
    downloadTextFile(`ta-game-${room.code}-results.csv`, buildResultsCsv(room), "text/csv;charset=utf-8");
  }

  return (
    <div className="stack-panels">
      <div className="flow-panel centered">
        <Trophy size={42} />
        <h2>Final standings</h2>
        <Podium leaderboard={room.leaderboard} />
        <div className="action-row">
          <button className="secondary" onClick={exportCsv}>
            <Download size={18} />
            Export CSV
          </button>
          <button className="secondary" onClick={resetGame}>
            <RotateCcw size={18} />
            Back to Lobby
          </button>
        </div>
        {status ? <div className="status-line">{status}</div> : null}
      </div>
      <RoundHistoryPanel room={room} request={request} hostPayload={hostPayload} />
      <ManualAdjustmentPanel room={room} request={request} hostPayload={hostPayload} />
    </div>
  );
}

function Podium({ leaderboard }: { leaderboard: PublicRoomState["leaderboard"] }) {
  const topTeams = leaderboard.slice(0, 3);
  if (topTeams.length === 0) {
    return null;
  }

  return (
    <div className="podium">
      {topTeams.map((entry) => (
        <div className={`podium-place place-${entry.rank}`} key={entry.teamId}>
          <span>{entry.rank}</span>
          <strong>{entry.name}</strong>
          <small>
            Score {formatPoints(entry.correctWagerTotal)} · Bonus {formatPoints(entry.bonusPoints)}
          </small>
        </div>
      ))}
    </div>
  );
}

function ManualAdjustmentPanel({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  const [teamId, setTeamId] = useState(room.teams[0]?.id ?? "");
  const [scoreDelta, setScoreDelta] = useState("");
  const [bonusDelta, setBonusDelta] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!room.teams.some((team) => team.id === teamId)) {
      setTeamId(room.teams[0]?.id ?? "");
    }
  }, [room.teams, teamId]);

  async function submitAdjustment(event: FormEvent): Promise<void> {
    event.preventDefault();
    const response = await request("score:adjust", {
      ...hostPayload,
      teamId,
      scoreDelta: Number(scoreDelta || 0),
      bonusDelta: Number(bonusDelta || 0),
      note
    });

    if (!response.ok) {
      setStatus(response.message);
      return;
    }

    setScoreDelta("");
    setBonusDelta("");
    setNote("");
    setStatus("Adjustment applied.");
  }

  if (room.teams.length === 0) {
    return null;
  }

  return (
    <form className="flow-panel" onSubmit={submitAdjustment}>
      <div className="panel-title">
        <SettingsIcon size={20} />
        Post-Round Point Change
      </div>
      <div className="settings-grid">
        <label>
          Team
          <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
            {room.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Score delta
          <input type="number" step="any" value={scoreDelta} onChange={(event) => setScoreDelta(event.target.value)} />
        </label>
        <label>
          Bonus delta
          <input type="number" step="any" value={bonusDelta} onChange={(event) => setBonusDelta(event.target.value)} />
        </label>
        <label>
          Note
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={180} />
        </label>
      </div>
      <button className="secondary submit-row" disabled={!teamId}>
        <Plus size={18} />
        Apply Adjustment
      </button>
      {status ? <div className="status-line">{status}</div> : null}
    </form>
  );
}

function protestStatusLabel(status?: ProtestStatus): string {
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  return "Pending";
}

function resultCredit(result: RoundHistoryEntry["results"][number]): number {
  return result.credit ?? (result.grade === "correct" ? 1 : 0);
}

function PartResultList({ result }: { result: RoundHistoryEntry["results"][number] }) {
  const parts = result.partResults ?? [];
  const shouldShow =
    parts.length > 1 ||
    parts.some((part) => (part.credit > 0.001 && part.credit < 0.999) || Boolean(part.aiFeedback));

  if (!shouldShow) {
    return null;
  }

  return (
    <div className="part-result-list">
      {parts.map((part, index) => (
        <div className="part-result-row" key={part.partId}>
          <div>
            <strong>{part.label || `Part ${index + 1}`}</strong>
            <span>{formatPercent(part.fraction)} of question value</span>
          </div>
          <div>
            <strong>{formatPercent(part.credit)}</strong>
            <span>
              Score +{formatPoints(part.scoreDelta)} · Bonus +{formatPoints(part.bonusDelta)}
            </span>
          </div>
          {part.aiFeedback ? <p>{part.aiFeedback}</p> : null}
        </div>
      ))}
    </div>
  );
}

function RoundHistoryPanel({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request?: RequestFn;
  hostPayload?: { code: string; hostToken: string };
}) {
  if (room.history.length === 0) {
    return null;
  }

  return (
    <section className="flow-panel">
      <div className="panel-title">
        <History size={20} />
        Round History
      </div>
      <div className="history-list">
        {[...room.history].reverse().map((entry) => (
          <details className="history-item" key={entry.round} open={entry.round === room.history.length}>
            <summary>
              <span>Round {entry.round}</span>
              <span>{entry.results.length} results</span>
            </summary>
            {entry.question ? <QuestionCard question={entry.question} round={entry.round} compact showAnswer /> : null}
            <div className="history-results">
              {entry.results.map((result) => (
                <div className="history-result" key={result.teamId}>
                  <div>
                    <strong>{result.teamName}</strong>
                    <span>Wager {result.wager ?? "-"}</span>
                  </div>
                  <div className={result.grade === "correct" ? "answer-chip done" : "answer-chip"}>
                    {creditLabel(resultCredit(result))} · {formatPercent(resultCredit(result))}
                  </div>
                  {result.answer !== undefined ? <div className="answer-text span-history">{result.answer}</div> : null}
                  <div className="history-delta">
                    Score +{formatPoints(result.scoreDelta)} · Bonus +{formatPoints(result.bonusDelta)}
                  </div>
                  <PartResultList result={result} />
                  {result.aiFeedback ? (
                    <div className="feedback-note">
                      <strong>Feedback</strong>
                      <span>{result.aiFeedback}</span>
                    </div>
                  ) : null}
                  {result.protest ? (
                    <div className="protest-note">
                      <strong>Protest · {protestStatusLabel(result.protest.status)}</strong>
                      <span>{result.protest.text}</span>
                      {result.protest.response ? <span>Host response: {result.protest.response}</span> : null}
                    </div>
                  ) : null}
                  {room.role === "host" && request && hostPayload && result.protest ? (
                    <HostProtestControls
                      request={request}
                      hostPayload={hostPayload}
                      result={result}
                      round={entry.round}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function HostProtestControls({
  request,
  hostPayload,
  result,
  round
}: {
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
  result: RoundHistoryEntry["results"][number];
  round: number;
}) {
  const [response, setResponse] = useState(result.protest?.response ?? "");
  const [status, setStatus] = useState("");
  const protestStatus = result.protest?.status ?? "pending";

  useEffect(() => {
    setResponse(result.protest?.response ?? "");
    setStatus("");
  }, [result.protest?.response, result.protest?.status]);

  async function resolve(status: "accepted" | "rejected"): Promise<void> {
    const resolution = await request("protest:resolve", {
      ...hostPayload,
      round,
      teamId: result.teamId,
      status,
      response
    });

    setStatus(resolution.ok ? "Protest resolved." : resolution.message);
  }

  if (protestStatus !== "pending") {
    return null;
  }

  return (
    <div className="protest-controls">
      <label>
        Host response
        <textarea
          value={response}
          maxLength={500}
          onChange={(event) => setResponse(event.target.value)}
          placeholder="Optional note for the team."
        />
      </label>
      <div className="action-row">
        <button className="secondary" type="button" onClick={() => resolve("rejected")}>
          <X size={18} />
          Reject
        </button>
        <button className="primary" type="button" onClick={() => resolve("accepted")}>
          <Check size={18} />
          Accept
        </button>
      </div>
      {status ? <div className="status-line">{status}</div> : null}
    </div>
  );
}

function TeamGame({
  room,
  request,
  team,
  teamToken
}: {
  room: PublicRoomState;
  request: RequestFn;
  team: PublicTeam;
  teamToken: string;
}) {
  const teamPayload = { code: room.code, teamToken };

  if (room.phase === "round_setup") {
    return <TeamWager room={room} request={request} team={team} teamPayload={teamPayload} />;
  }

  if (room.phase === "answering") {
    return <TeamAnswer room={room} request={request} team={team} teamPayload={teamPayload} />;
  }

  if (room.phase === "grading") {
    return (
      <div className="flow-panel">
        <div className="centered compact-center">
          <Timer size={36} />
          <h2>Answer locked</h2>
          <p className="muted">{team.currentAnswer || "No answer submitted"}</p>
        </div>
      </div>
    );
  }

  if (room.phase === "finished") {
    const hasCurrentRoundResult = room.history.some((entry) => entry.round === room.currentRound);
    return (
      <div className="stack-panels">
        {hasCurrentRoundResult ? (
          <TeamFinalizedGrade room={room} request={request} team={team} teamPayload={teamPayload} />
        ) : null}
        <div className="flow-panel centered">
          <Trophy size={42} />
          <h2>Final standings</h2>
          <Podium leaderboard={room.leaderboard} />
        </div>
        <RoundHistoryPanel room={room} />
      </div>
    );
  }

  return (
    <div className="stack-panels">
      <TeamFinalizedGrade room={room} request={request} team={team} teamPayload={teamPayload} />
      <RoundHistoryPanel room={room} />
    </div>
  );
}

function TeamFinalizedGrade({
  room,
  request,
  team,
  teamPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  team: PublicTeam;
  teamPayload: { code: string; teamToken: string };
}) {
  const [protestText, setProtestText] = useState("");
  const [status, setStatus] = useState("");
  const historyEntry = room.history.find((entry) => entry.round === room.currentRound);
  const result = historyEntry?.results.find((entry) => entry.teamId === team.id);

  useEffect(() => {
    setProtestText(result?.protest?.text ?? "");
  }, [room.currentRound, result?.protest?.text]);

  if (!historyEntry || !result) {
    return (
      <div className="flow-panel centered">
        <Trophy size={36} />
        <h2>Round {room.currentRound} scored</h2>
      </div>
    );
  }

  async function submitProtest(event: FormEvent): Promise<void> {
    event.preventDefault();
    const response = await request("protest:submit", { ...teamPayload, text: protestText });
    setStatus(response.ok ? "Protest sent." : response.message);
  }

  const protestStatus = result.protest?.status ?? "pending";
  const credit = resultCredit(result);

  return (
    <section className="flow-panel">
      <QuestionCard question={historyEntry.question} round={historyEntry.round} showAnswer />
      <div className="finalized-grade">
        <div>
          <span className="eyebrow">Your Grade</span>
          <h2>{creditLabel(credit)}</h2>
          <span className="muted">Credit {formatPercent(credit)}</span>
        </div>
        <div className="history-delta">
          Score +{formatPoints(result.scoreDelta)} · Bonus +{formatPoints(result.bonusDelta)}
        </div>
      </div>
      <PartResultList result={result} />
      {result.aiFeedback ? (
        <div className="feedback-note">
          <strong>Feedback</strong>
          <span>{result.aiFeedback}</span>
        </div>
      ) : null}
      {result.protest ? (
        <div className="protest-note">
          <strong>Protest · {protestStatusLabel(result.protest.status)}</strong>
          <span>{result.protest.text}</span>
          {result.protest.response ? <span>Host response: {result.protest.response}</span> : null}
        </div>
      ) : null}
      {!result.protest || protestStatus === "pending" ? (
        <form className="protest-form" onSubmit={submitProtest}>
          <label>
            Protest
            <textarea
              value={protestText}
              onChange={(event) => setProtestText(event.target.value)}
              maxLength={1000}
              placeholder="Explain what you want the host to reconsider."
            />
          </label>
          <button className="secondary submit-row" disabled={!protestText.trim()}>
            <Send size={18} />
            {result.protest ? "Update Protest" : "Submit Protest"}
          </button>
        </form>
      ) : null}
      {status ? <div className="status-line">{status}</div> : null}
    </section>
  );
}

function TeamWager({
  room,
  request,
  team,
  teamPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  team: PublicTeam;
  teamPayload: { code: string; teamToken: string };
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const values = wagerValues(room.settings.questionCount);
  const question = currentQuestion(room);

  async function submitWager(): Promise<void> {
    const response = await request("wager:submit", { ...teamPayload, wager: selected });
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  return (
    <div className="flow-panel">
      <div className="team-round-head">
        <div>
          <span className="eyebrow">Team</span>
          <h2>{team.name}</h2>
        </div>
        {team.currentWager ? <div className="locked-wager">Locked: {team.currentWager}</div> : null}
      </div>
      <RoundTopicCard question={question} round={room.currentRound} />
      <div className="wager-grid">
        {values.map((value) => {
          const used = team.usedWagers.includes(value);
          const locked = team.currentWager === value;
          return (
            <button
              className={selected === value || locked ? "wager-tile selected" : "wager-tile"}
              disabled={team.wagerLocked || used}
              key={value}
              onClick={() => setSelected(value)}
            >
              {value}
            </button>
          );
        })}
      </div>
      <button className="primary submit-row" disabled={team.wagerLocked || selected === null} onClick={submitWager}>
        <Send size={18} />
        Submit Wager
      </button>
      {status ? <div className="status-line">{status}</div> : null}
    </div>
  );
}

function TeamAnswer({
  room,
  request,
  team,
  teamPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  team: PublicTeam;
  teamPayload: { code: string; teamToken: string };
}) {
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    setAnswer(team.currentAnswerDraft ?? team.currentAnswer ?? "");
    setStatus("");
  }, [room.currentRound, team.currentAnswer, team.currentAnswerDraft]);

  function updateAnswer(nextAnswer: string): void {
    setAnswer(nextAnswer);
    void request("answer:draft", { ...teamPayload, answer: nextAnswer }, 3000);
  }

  async function submitAnswer(): Promise<void> {
    const response = await request("answer:submit", { ...teamPayload, answer });
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  return (
    <div className="flow-panel">
      <div className="team-round-head">
        <div>
          <span className="eyebrow">Wager</span>
          <h2>{team.currentWager}</h2>
        </div>
        <TimerDisplay endsAt={room.roundEndsAt} />
      </div>
      <QuestionCard question={currentQuestion(room)} round={room.currentRound} />
      {team.hasSubmittedAnswer ? (
        <div className="locked-answer">{team.currentAnswer}</div>
      ) : (
        <>
          <textarea value={answer} onChange={(event) => updateAnswer(event.target.value)} maxLength={1000} />
          <button className="primary submit-row" disabled={!answer.trim()} onClick={submitAnswer}>
            <Send size={18} />
            Submit Answer
          </button>
        </>
      )}
      {status ? <div className="status-line">{status}</div> : null}
    </div>
  );
}

function TeamRoundTable({ teams }: { teams: PublicTeam[] }) {
  return (
    <div className="data-table">
      <div className="table-row table-head">
        <span>Team</span>
        <span>Wager</span>
        <span>Status</span>
      </div>
      {teams.map((team) => (
        <div className="table-row" key={team.id}>
          <span className="team-name">{team.name}</span>
          <span>{team.currentWager ?? "-"}</span>
          <span>{team.wagerLocked ? "Locked" : "Pending"}</span>
        </div>
      ))}
    </div>
  );
}

function AnswerTable({ teams }: { teams: PublicTeam[] }) {
  return (
    <div className="answer-list">
      {teams.map((team) => (
        <div className="answer-row" key={team.id}>
          <div>
            <div className="team-name">{team.name}</div>
            <div className="muted">Wager {team.currentWager ?? "-"}</div>
          </div>
          <div className={team.hasSubmittedAnswer ? "answer-chip done" : "answer-chip"}>
            {team.hasSubmittedAnswer ? "Submitted" : "Pending"}
          </div>
        </div>
      ))}
    </div>
  );
}

function Leaderboard({ room }: { room: PublicRoomState }) {
  return (
    <section className="leaderboard">
      <div className="panel-title">
        <Trophy size={20} />
        Leaderboard
      </div>
      <div className="leader-list">
        {room.leaderboard.length === 0 ? (
          <div className="empty-state">No teams yet.</div>
        ) : (
          room.leaderboard.map((entry) => (
            <div className="leader-row" key={entry.teamId}>
              <span className="rank">{entry.rank}</span>
              <span className="leader-name">{entry.name}</span>
              <span className="leader-stat">
                <small>Score</small>
                <strong>{formatPoints(entry.correctWagerTotal)}</strong>
              </span>
              <span className="leader-stat bonus">
                <small>Bonus</small>
                <strong>{formatPoints(entry.bonusPoints)}</strong>
                <em>
                  {formatPoints(entry.answerPoints)} + {formatPoints(entry.rankBonus)}
                </em>
              </span>
            </div>
          ))
        )}
      </div>
      <div className="score-key">
        <span>Score is the sum of correct wagers.</span>
        <span>Bonus points are correct-answer points plus rank bonus.</span>
      </div>
    </section>
  );
}

function HiddenLeaderboardNotice() {
  return (
    <section className="leaderboard hidden-leaderboard">
      <div className="panel-title">
        <EyeOff size={20} />
        Leaderboard Hidden
      </div>
      <p className="muted">Standings will return after grading.</p>
    </section>
  );
}

function RulesPanel() {
  return (
    <section className="rules-panel">
      <div className="rules-title">
        <Info size={17} />
        Rules
      </div>
      <div className="rule-grid">
        <div>
          <strong>Wager</strong>
          <span>Pick one unused value from 1-N.</span>
        </div>
        <div>
          <strong>Correct</strong>
          <span>Adds wager to score.</span>
        </div>
        <div>
          <strong>Incorrect</strong>
          <span>Scores 0 and spends the wager.</span>
        </div>
        <div>
          <strong>Bonus</strong>
          <span>Correct-answer points plus rank bonus.</span>
        </div>
      </div>
    </section>
  );
}

function TeamList({
  teams,
  request,
  hostPayload,
  removable = false
}: {
  teams: PublicTeam[];
  request?: RequestFn;
  hostPayload?: { code: string; hostToken: string };
  removable?: boolean;
}) {
  if (teams.length === 0) {
    return <div className="empty-state">No teams yet.</div>;
  }

  async function removeTeam(teamId: string): Promise<void> {
    if (!request || !hostPayload) {
      return;
    }

    await request("team:remove", { ...hostPayload, teamId });
  }

  return (
    <div className="team-list">
      {teams.map((team) => (
        <div className="team-row" key={team.id}>
          <span>
            {team.name}
            <small>{team.connected ? "Connected" : "Disconnected"}</small>
          </span>
          {removable ? (
            <button className="icon-only danger" title="Remove team" onClick={() => void removeTeam(team.id)}>
              <Trash2 size={17} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TimerDisplay({ endsAt }: { endsAt?: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  if (!endsAt) {
    return null;
  }

  const remaining = endsAt - now;
  return (
    <div className={remaining <= 10000 ? "timer urgent" : "timer"}>
      <Timer size={18} />
      {formatClock(remaining)}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: PublicRoomState["phase"] }) {
  return <div className={`phase phase-${phase}`}>{phaseLabel(phase)}</div>;
}
