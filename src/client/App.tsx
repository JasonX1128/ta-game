import {
  Check,
  Clipboard,
  DoorOpen,
  LogIn,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings as SettingsIcon,
  Timer,
  Trophy,
  Users,
  X
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";
import type { Ack, GameSettings, Grade, PublicRoomState, PublicTeam, Question, Role } from "../shared/types";

type SavedSession = {
  code: string;
  role: Role;
  hostToken?: string;
  teamToken?: string;
  teamId?: string;
  teamName?: string;
};

type RequestFn = <T extends object = Record<string, never>>(event: string, payload: unknown) => Promise<Ack<T>>;

const SESSION_KEY = "ta-game-session";
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
  return file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
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
  const extensions = ["png", "jpg", "jpeg", "webp", "gif"];

  return stems.flatMap((stem) => extensions.map((extension) => `${stem}.${extension}`));
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
      text?: unknown;
      code?: unknown;
      codeLanguage?: unknown;
      language?: unknown;
      image?: unknown;
      imageName?: unknown;
      imageAlt?: unknown;
    };
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

    if (!text) {
      throw new Error(`Question ${index + 1} needs text.`);
    }

    let imageFile: File | undefined;
    if (imageReference) {
      imageFile = lookup.get(normalizeUploadPath(imageReference)) ?? lookup.get(basename(imageReference));
      if (!imageFile) {
        throw new Error(`Question ${index + 1} references ${imageReference}, but that image was not uploaded.`);
      }
    } else {
      imageFile = imageCandidates(index)
        .map((candidateName) => lookup.get(candidateName))
        .find((file): file is File => Boolean(file));
    }

    if (imageFile && !isImageFile(imageFile)) {
      throw new Error(`${imageFile.name} is not a supported image file.`);
    }

    if (imageFile && imageFile.size > 2_500_000) {
      throw new Error(`${imageFile.name} is too large. Keep question images under 2.5 MB.`);
    }

    questions.push({
      text,
      code,
      codeLanguage: codeLanguage?.trim() || undefined,
      imageDataUrl: imageFile ? await readFileAsDataUrl(imageFile) : undefined,
      imageName: imageFile?.name,
      imageAlt: typeof candidate.imageAlt === "string" ? candidate.imageAlt : undefined
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

function wagerValues(count: number): number[] {
  return Array.from({ length: count }, (_item, index) => index + 1);
}

export default function App() {
  const [socket] = useState<Socket>(() => io(SOCKET_URL, { autoConnect: true }));
  const [connected, setConnected] = useState(socket.connected);
  const [session, setSessionState] = useState<SavedSession | null>(() => loadSession());
  const [room, setRoom] = useState<PublicRoomState | null>(null);
  const [error, setError] = useState("");

  function setSession(next: SavedSession | null): void {
    saveSession(next);
    setSessionState(next);
  }

  const request: RequestFn = (event, payload) =>
    new Promise((resolve) => {
      socket.timeout(5000).emit(event, payload, (err: Error | null, response: Ack) => {
        if (err) {
          resolve({ ok: false, message: "The server did not respond." });
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

    request<{ code: string; role: Role; teamId?: string }>("room:rejoin", session).then((response) => {
      if (!response.ok) {
        setSession(null);
        setRoom(null);
        setError(response.message);
      }
    });
  }, [socket.connected, session?.code, session?.role]);

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
  const [status, setStatus] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const uploadedQuestionCount = room.settings.questions.length;

  useEffect(() => {
    setQuestionCount(String(room.settings.questionCount));
    setPointsPerCorrect(String(room.settings.pointsPerCorrect));
    setBonusText(room.settings.bonusByRank.join(","));
  }, [room.settings.questionCount, room.settings.pointsPerCorrect, room.settings.bonusByRank.join(",")]);

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
      questions: room.settings.questions
    };

    const response = await request("settings:update", { ...hostPayload, settings });
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

      const response = await request("settings:update", {
        ...hostPayload,
        settings: {
          questionCount: questions.length,
          pointsPerCorrect: Number(pointsPerCorrect),
          bonusByRank,
          questions
        } satisfies GameSettings
      });

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

    const response = await request("settings:update", {
      ...hostPayload,
      settings: {
        questionCount: Math.max(1, Number(questionCount) || room.settings.questionCount),
        pointsPerCorrect: Number(pointsPerCorrect),
        bonusByRank,
        questions: []
      } satisfies GameSettings
    });

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
                  accept=".json,application/json,image/png,image/jpeg,image/gif,image/webp"
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
      </div>

      <aside className="lobby-side">
        <div className="panel-title">
          <Users size={20} />
          Teams
        </div>
        <TeamList teams={room.teams} />
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
    </section>
  );
}

function GameFrame({ room, children }: { room: PublicRoomState; children: React.ReactNode }) {
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
      <Leaderboard room={room} />
    </section>
  );
}

function currentQuestion(room: PublicRoomState): Question | undefined {
  return room.settings.questions[room.currentRound - 1];
}

function QuestionCard({ question, round }: { question?: Question; round: number }) {
  if (!question) {
    return null;
  }

  return (
    <article className="question-card">
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
    </article>
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

function HostRoundSetup({
  room,
  request,
  hostPayload
}: {
  room: PublicRoomState;
  request: RequestFn;
  hostPayload: { code: string; hostToken: string };
}) {
  const [minutes, setMinutes] = useState("2");
  const [status, setStatus] = useState("");
  const allLocked = room.teams.length > 0 && room.teams.every((team) => team.wagerLocked);

  async function startAnswers(): Promise<void> {
    const response = await request("round:startAnswering", {
      ...hostPayload,
      durationMinutes: Number(minutes)
    });
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  return (
    <div className="flow-panel">
      <div className="round-toolbar">
        <label>
          Minutes
          <input
            type="number"
            min={0.1}
            max={180}
            step={0.25}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
        <button className="primary" disabled={!allLocked} onClick={startAnswers}>
          <Timer size={18} />
          Start Timer
        </button>
      </div>
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

  async function stopTimer(): Promise<void> {
    const response = await request("round:stopAnswering", hostPayload);
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  return (
    <div className="flow-panel">
      <QuestionCard question={currentQuestion(room)} round={room.currentRound} />
      <div className="round-toolbar">
        <TimerDisplay endsAt={room.roundEndsAt} />
        <button className="secondary" onClick={stopTimer}>
          <Timer size={18} />
          Stop Timer
        </button>
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
  const [grades, setGrades] = useState<Record<string, Grade>>({});
  const [status, setStatus] = useState("");

  useEffect(() => {
    const defaults: Record<string, Grade> = {};
    for (const team of room.teams) {
      if (!team.hasSubmittedAnswer) {
        defaults[team.id] = "incorrect";
      }
    }
    setGrades(defaults);
  }, [room.currentRound]);

  const ready = room.teams.every((team) => grades[team.id] === "correct" || grades[team.id] === "incorrect");

  async function submitGrades(): Promise<void> {
    const response = await request("answer:grade", { ...hostPayload, grades });
    if (!response.ok) {
      setStatus(response.message);
    }
  }

  return (
    <div className="flow-panel">
      <QuestionCard question={currentQuestion(room)} round={room.currentRound} />
      <div className="answer-list">
        {room.teams.map((team) => (
          <div className="grade-row" key={team.id}>
            <div>
              <div className="team-name">{team.name}</div>
              <div className="answer-text">{team.currentAnswer || "No answer submitted"}</div>
            </div>
            <div className="grade-actions">
              <button
                className={grades[team.id] === "correct" ? "grade correct selected" : "grade correct"}
                title="Mark correct"
                onClick={() => setGrades((current) => ({ ...current, [team.id]: "correct" }))}
              >
                <Check size={18} />
              </button>
              <button
                className={grades[team.id] === "incorrect" ? "grade incorrect selected" : "grade incorrect"}
                title="Mark incorrect"
                onClick={() => setGrades((current) => ({ ...current, [team.id]: "incorrect" }))}
              >
                <X size={18} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button className="primary submit-row" disabled={!ready} onClick={submitGrades}>
        <Check size={18} />
        Submit Grades
      </button>
      {status ? <div className="status-line">{status}</div> : null}
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
    <div className="flow-panel centered">
      <Trophy size={36} />
      <h2>Round {room.currentRound} scored</h2>
      <button className="primary" onClick={nextRound}>
        <Play size={18} />
        Next Round
      </button>
      {status ? <div className="status-line">{status}</div> : null}
    </div>
  );
}

function HostFinished({
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

  return (
    <div className="flow-panel centered">
      <Trophy size={42} />
      <h2>Final standings</h2>
      <button className="secondary" onClick={resetGame}>
        <RotateCcw size={18} />
        Back to Lobby
      </button>
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
      <div className="flow-panel centered">
        <Timer size={36} />
        <h2>Answer locked</h2>
        <p className="muted">{team.currentAnswer || "No answer submitted"}</p>
      </div>
    );
  }

  if (room.phase === "finished") {
    return (
      <div className="flow-panel centered">
        <Trophy size={42} />
        <h2>Final standings</h2>
      </div>
    );
  }

  return (
    <div className="flow-panel centered">
      <Trophy size={36} />
      <h2>Round {room.currentRound} scored</h2>
    </div>
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
          <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={1000} />
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
    <aside className="leaderboard">
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
    </aside>
  );
}

function TeamList({ teams }: { teams: PublicTeam[] }) {
  if (teams.length === 0) {
    return <div className="empty-state">No teams yet.</div>;
  }

  return (
    <div className="team-list">
      {teams.map((team) => (
        <div className="team-row" key={team.id}>
          <span>{team.name}</span>
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
