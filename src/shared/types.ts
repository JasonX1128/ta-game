export type RoomPhase =
  | "lobby"
  | "round_setup"
  | "answering"
  | "grading"
  | "between_rounds"
  | "finished";

export type Role = "host" | "team";

export type Grade = "correct" | "incorrect";

export type ProtestStatus = "pending" | "accepted" | "rejected";

export type GradeSuggestion = {
  teamId: string;
  grade: Grade;
  credit?: number;
  confidence?: number;
  rationale?: string;
  feedback?: string;
  partSuggestions?: PartGradeSuggestion[];
};

export type AnswerRevealMode = "host_only" | "after_grading" | "status_only";

export type GameSettings = {
  questionCount: number;
  pointsPerCorrect: number;
  bonusByRank: number[];
  questions: Question[];
  scrambleQuestionOrder: boolean;
  answerRevealMode: AnswerRevealMode;
  hideLeaderboardDuringAnswering: boolean;
  llmGradingEnabled: boolean;
};

export type Question = {
  topic?: string;
  text: string;
  code?: string;
  codeLanguage?: string;
  minutes?: number;
  answer?: string;
  parts?: QuestionPart[];
  imageDataUrl?: string;
  imageName?: string;
  imageAlt?: string;
};

export type QuestionPart = {
  id: string;
  label?: string;
  text: string;
  code?: string;
  codeLanguage?: string;
  answer?: string;
  fraction: number;
};

export type PartGradeSuggestion = {
  partId: string;
  credit: number;
  confidence?: number;
  rationale?: string;
  feedback?: string;
};

export type TeamPartResult = {
  partId: string;
  label?: string;
  fraction: number;
  credit: number;
  scoreDelta: number;
  bonusDelta: number;
  aiFeedback?: string;
};

export type TeamRoundResult = {
  teamId: string;
  teamName: string;
  wager?: number;
  answer?: string;
  grade: Grade;
  credit?: number;
  scoreDelta: number;
  bonusDelta: number;
  partResults?: TeamPartResult[];
  aiFeedback?: string;
  protest?: {
    text: string;
    createdAt: number;
    status?: ProtestStatus;
    response?: string;
    resolvedAt?: number;
  };
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
  currentAnswerDraft?: string;
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
  scrambleQuestionOrder: false,
  answerRevealMode: "host_only",
  hideLeaderboardDuringAnswering: false,
  llmGradingEnabled: false
};

export const SINGLE_PART_ID = "main";
export const DEFAULT_QUESTION_TOPIC = "General question";

export function questionTopic(question?: Question): string {
  const topic = question?.topic?.trim();
  return topic || DEFAULT_QUESTION_TOPIC;
}

export function questionParts(question?: Question): QuestionPart[] {
  if (!question) {
    return [];
  }

  if (question.parts?.length) {
    return question.parts;
  }

  return [{
    id: SINGLE_PART_ID,
    label: "Question",
    text: question.text,
    code: question.code,
    codeLanguage: question.codeLanguage,
    answer: question.answer,
    fraction: 1
  }];
}
