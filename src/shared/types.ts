export type RoomPhase =
  | "lobby"
  | "round_setup"
  | "answering"
  | "grading"
  | "between_rounds"
  | "finished";

export type Role = "host" | "team";

export type Grade = "correct" | "incorrect";

export type GameSettings = {
  questionCount: number;
  pointsPerCorrect: number;
  bonusByRank: number[];
};

export type PublicTeam = {
  id: string;
  name: string;
  joinOrder: number;
  usedWagers: number[];
  currentWager?: number;
  wagerLocked: boolean;
  hasSubmittedAnswer: boolean;
  currentAnswer?: string;
  currentGrade?: Grade;
  correctWagerTotal: number;
  answerPoints: number;
  rankBonus: number;
  finalScore: number;
};

export type LeaderboardEntry = {
  teamId: string;
  name: string;
  rank: number;
  correctWagerTotal: number;
  answerPoints: number;
  rankBonus: number;
  finalScore: number;
};

export type PublicRoomState = {
  code: string;
  role: Role;
  viewerTeamId?: string;
  phase: RoomPhase;
  settings: GameSettings;
  teams: PublicTeam[];
  leaderboard: LeaderboardEntry[];
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
  bonusByRank: [10, 5, 2]
};
