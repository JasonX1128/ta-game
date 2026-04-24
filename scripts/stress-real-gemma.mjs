import "dotenv/config";
import { spawn } from "node:child_process";
import net from "node:net";
import { io } from "socket.io-client";

const teamCount = Number(process.env.STRESS_TEAM_COUNT ?? 8);
const suggestTimeoutMs = Number(process.env.STRESS_SUGGEST_TIMEOUT_MS ?? 180000);
const finalizeTimeoutMs = Number(process.env.STRESS_FINALIZE_TIMEOUT_MS ?? 10000);
const llmPassword = process.env.LLM_GRADING_PASSWORD || "stress-test-password";

if (!process.env.GEMMA_API_KEY) {
  throw new Error("Set GEMMA_API_KEY in .env before running this stress test.");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function request(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, response) => {
      if (err) {
        resolve({ ok: false, message: `timeout:${event}` });
        return;
      }

      resolve(response);
    });
  });
}

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Game server did not start.")), 15000);
    proc.stdout.on("data", (chunk) => {
      const text = String(chunk);
      process.stdout.write(text);
      if (text.includes("TA Game server listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
    proc.once("exit", (code) => reject(new Error(`Game server exited with ${code}.`)));
  });
}

async function connectSocket(gameUrl) {
  const socket = io(gameUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket did not connect.")), 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", reject);
  });
  return socket;
}

const port = await getFreePort();
const gameUrl = `http://127.0.0.1:${port}`;
const game = spawn("./node_modules/.bin/tsx", ["src/server/index.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    LLM_GRADING_PASSWORD: llmPassword
  },
  stdio: ["ignore", "pipe", "pipe"]
});

const sockets = [];

try {
  await waitForServer(game);

  const host = await connectSocket(gameUrl);
  sockets.push(host);

  const created = await request(host, "room:create", {});
  if (!created.ok) throw new Error(created.message);
  const hostPayload = { code: created.code, hostToken: created.hostToken };

  const questions = [{
    topic: "Stress test",
    text: "For the cache access sequence A, B, A, C, A, B, identify which accesses hit and briefly justify.",
    minutes: 0.1,
    parts: [
      { id: "hits", label: "Part A", text: "Which accesses hit?", answer: "The third and fifth accesses hit.", fraction: 0.5 },
      { id: "why", label: "Part B", text: "Why?", answer: "A remains resident after the first access and is reused before eviction.", fraction: 0.5 }
    ]
  }];
  const settings = {
    questionCount: 1,
    pointsPerCorrect: 10,
    bonusByRank: [10, 5, 2],
    questions,
    scrambleQuestionOrder: false,
    answerRevealMode: "host_only",
    hideLeaderboardDuringAnswering: false,
    llmGradingEnabled: true,
    showFullGemmaResponse: false
  };

  const updated = await request(host, "settings:update", {
    ...hostPayload,
    settings,
    llmGradingPassword: llmPassword
  });
  if (!updated.ok) throw new Error(updated.message);

  const teams = [];
  for (let index = 0; index < teamCount; index += 1) {
    const teamSocket = await connectSocket(gameUrl);
    sockets.push(teamSocket);
    const joined = await request(teamSocket, "room:join", { code: created.code, name: `Team ${index + 1}` });
    if (!joined.ok) throw new Error(joined.message);
    teams.push({ socket: teamSocket, token: joined.teamToken, id: joined.teamId });
  }

  const started = await request(host, "game:start", hostPayload);
  if (!started.ok) throw new Error(started.message);

  for (const team of teams) {
    const wagered = await request(team.socket, "wager:submit", {
      code: created.code,
      teamToken: team.token,
      wager: 1
    });
    if (!wagered.ok) throw new Error(wagered.message);
  }

  const answering = await request(host, "round:startAnswering", { ...hostPayload, durationMinutes: 0.1 });
  if (!answering.ok) throw new Error(answering.message);

  for (const [index, team] of teams.entries()) {
    const answer = index % 3 === 0
      ? "third and fifth hit because A is reused before eviction"
      : index % 3 === 1
        ? "all miss"
        : "A maybe hits later but not sure";
    const submitted = await request(team.socket, "answer:submit", {
      code: created.code,
      teamToken: team.token,
      answer
    });
    if (!submitted.ok) throw new Error(submitted.message);
  }

  await wait(100);

  const suggestionStartedAt = Date.now();
  const suggestionResult = await request(host, "grading:suggest", hostPayload, suggestTimeoutMs);
  const suggestionElapsedMs = Date.now() - suggestionStartedAt;

  const partCredits = Object.fromEntries(teams.map((team) => [team.id, { hits: 1, why: 1 }]));
  const grades = Object.fromEntries(teams.map((team) => [team.id, "correct"]));
  const finalizeStartedAt = Date.now();
  const finalized = await request(host, "answer:grade", { ...hostPayload, grades, partCredits }, finalizeTimeoutMs);
  const finalizeElapsedMs = Date.now() - finalizeStartedAt;

  console.log(JSON.stringify({
    teamCount,
    suggestionOk: suggestionResult.ok,
    suggestionElapsedMs,
    suggestionCount: suggestionResult.ok ? suggestionResult.suggestions.length : undefined,
    suggestionMessage: suggestionResult.ok ? undefined : suggestionResult.message,
    finalizeOk: finalized.ok,
    finalizeElapsedMs,
    finalizeMessage: finalized.ok ? undefined : finalized.message
  }, null, 2));

  if (!finalized.ok) {
    throw new Error(`Finalize failed: ${finalized.message}`);
  }
} finally {
  for (const socket of sockets) {
    socket.close();
  }
  game.kill("SIGTERM");
}
