export type RoomPhase =
  | "lobby"
  | "round_setup"
  | "answering"
  | "grading"
  | "between_rounds"
  | "finished";

export type Role = "host" | "team";

export type Grade = "correct" | "incorrect";

export type AnswerRevealMode = "host_only" | "after_grading" | "status_only";

export type GameSettings = {
  questionCount: number;
  pointsPerCorrect: number;
  bonusByRank: number[];
  questions: Question[];
  answerRevealMode: AnswerRevealMode;
  hideLeaderboardDuringAnswering: boolean;
};

export type Question = {
  text: string;
  code?: string;
  codeLanguage?: string;
  minutes?: number;
  imageDataUrl?: string;
  imageName?: string;
  imageAlt?: string;
};

export type TeamRoundResult = {
  teamId: string;
  teamName: string;
  wager?: number;
  answer?: string;
  grade: Grade;
  scoreDelta: number;
  bonusDelta: number;
};

export type RoundHistoryEntry = {
  round: number;
  question?: Question;
  durationSeconds?: number;
  gradedAt: number;
  results: TeamRoundResult[];
};

export type ScoreAdjustment = {
  id: string;
  teamId: string;
  teamName: string;
  scoreDelta: number;
  bonusDelta: number;
  note: string;
  createdAt: number;
};

export type PublicTeam = {
  id: string;
  name: string;
  joinOrder: number;
  connected: boolean;
  usedWagers: number[];
  currentWager?: number;
  wagerLocked: boolean;
  hasSubmittedAnswer: boolean;
  currentAnswer?: string;
  currentGrade?: Grade;
  correctWagerTotal: number;
  answerPoints: number;
  scoreAdjustment: number;
  bonusAdjustment: number;
  rankBonus: number;
  bonusPoints: number;
};

export type LeaderboardEntry = {
  teamId: string;
  name: string;
  rank: number;
  correctWagerTotal: number;
  answerPoints: number;
  scoreAdjustment: number;
  bonusAdjustment: number;
  rankBonus: number;
  bonusPoints: number;
};

export type PublicRoomState = {
  code: string;
  role: Role;
  viewerTeamId?: string;
  phase: RoomPhase;
  settings: GameSettings;
  teams: PublicTeam[];
  leaderboard: LeaderboardEntry[];
  history: RoundHistoryEntry[];
  adjustments: ScoreAdjustment[];
  currentRound: number;
  roundDurationSeconds?: number;
  roundEndsAt?: number;
  now: number;
};

export type AckOk<T extends object = Record<string, never>> = { ok: true } & T;
export type AckError = { ok: false; message: string };
export type Ack<T extends object = Record<string, never>> = AckOk<T> | AckError;

export const DEFAULT_SETTINGS: GameSettings = {
  questionCount: 5,
  pointsPerCorrect: 10,
  bonusByRank: [10, 5, 2],
  questions: [],
  answerRevealMode: "host_only",
  hideLeaderboardDuringAnswering: false
};
