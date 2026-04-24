# TA Game Plan

## Goal

Build a hosted multiplayer classroom/team game where a host creates a room code, players join from their own devices, teams wager unique point values across rounds, submit timed answers, and the host grades answers before moving to the next round.

The app should feel like a Jackbox/BuzzIn-style room: one host screen controls the game and everyone else uses a lightweight player/team screen.

## Proposed Stack

- **Frontend:** React + Vite + TypeScript
- **Backend:** Node.js + Express + Socket.IO
- **Deployment:** Render web service
- **State storage:** In-memory room state for the first version
- **Future scaling option:** Redis adapter/session store if rooms need to survive restarts or multiple Render instances

Render note: a single Node service can serve the built Vite frontend and handle Socket.IO WebSocket traffic. For the first launch, run one Render instance so in-memory game rooms remain consistent.

## Core Roles

- **Host**
  - Creates a room.
  - Sees the room code and lobby.
  - Edits game settings before the game starts.
  - Starts rounds.
  - Sets the answer timer for each round.
  - Watches wagers and submissions arrive.
  - Marks answers correct or incorrect.
  - Advances to the next round.

- **Team**
  - Joins by room code.
  - Enters a team name.
  - Chooses one unused wager value each round.
  - Submits an answer before time expires.
  - Sees score/leaderboard state after grading.

## Game Settings

Editable in the lobby before the game starts:

- **Number of questions (`N`)**
  - Also defines the available wager values: `1` through `N`.

- **Points per correct answer**
  - Flat amount awarded whenever a team answer is marked correct.

- **Top-team wager bonus list**
  - Comma-separated values, e.g. `10,5,2`.
  - Means rank 1 by total successful wager gets `+10`, rank 2 gets `+5`, rank 3 gets `+2`.
  - If there are fewer teams than bonus entries, unused entries are ignored.
  - If there are more teams than bonus entries, lower-ranked teams get `+0`.

## Scoring Interpretation

Confirmed rule:

- Each round, a team chooses an unused wager value from `1..N`.
- If the team answers correctly:
  - Add the wager value to `correctWagerTotal`.
  - Add the flat correct-answer points to `answerPoints`.
- If the team answers incorrectly:
  - The wager value is still spent and cannot be reused.
  - It does not increase `correctWagerTotal`.
  - It does not add flat answer points.
  - The team effectively loses that wager opportunity for `+0`.
- Leaderboard ranking is based on `correctWagerTotal`.
- Display score as:
  - `correctWagerTotal (+bonus)`, with answer points available as a secondary stat if useful.
- Final/overall score can be computed as:
  - `correctWagerTotal + rankingBonus + answerPoints`

## Room Lifecycle

1. **Create Room**
   - Host creates a room.
   - Server generates a short unique room code.
   - Host receives a private host token.

2. **Lobby**
   - Teams join using the room code.
   - Host sees joined teams live.
   - Host edits settings.
   - Host starts the game.

3. **Round Setup**
   - Host enters minutes for the upcoming question.
   - Teams select one unused wager value.
   - Host can see which teams have locked wagers.
   - When all wagers are submitted, or the host manually starts, the answer phase begins.

4. **Answer Phase**
   - Timer starts.
   - Teams enter answers.
   - Answers lock when submitted or when time expires.
   - Host sees submitted answers live.

5. **Grading Phase**
   - Host marks each answer correct/incorrect.
   - Host submits grades.
   - Server updates scores and used wagers.

6. **Next Round**
   - If rounds remain, return to round setup.
   - If all `N` questions are complete, show final standings.

## Main Screens

### Host View

After game start, keep everything on one screen:

- Left/main area:
  - Current round number.
  - Round timer input during setup.
  - Team wager status.
  - Submitted answers.
  - Correct/incorrect grading controls.
  - Primary submit/advance button.

- Right persistent sidebar:
  - Running leaderboard.
  - Each team row shows rank, team name, wager score, bonus in parentheses, and total if needed.

### Team View

- Room/team identity header.
- Current phase-specific panel:
  - Lobby waiting state.
  - Wager selection grid/buttons from remaining values.
  - Answer input with timer.
  - Waiting-for-host state after submission.
- Compact leaderboard once the game has started.

## Realtime Events

Client-to-server:

- `room:create`
- `room:join`
- `settings:update`
- `game:start`
- `round:configure`
- `wager:submit`
- `answer:submit`
- `answer:grade`
- `round:advance`
- `room:leave`

Server-to-client:

- `room:created`
- `room:state`
- `room:error`
- `player:joined`
- `settings:updated`
- `phase:changed`
- `timer:started`
- `timer:expired`
- `wager:updated`
- `answer:updated`
- `scores:updated`

Most UI updates can be driven by a full `room:state` broadcast after every accepted mutation. That keeps the first version easier to reason about.

## Data Model Sketch

```ts
type RoomPhase =
  | "lobby"
  | "round_setup"
  | "answering"
  | "grading"
  | "between_rounds"
  | "finished";

type GameSettings = {
  questionCount: number;
  pointsPerCorrect: number;
  bonusByRank: number[];
};

type Team = {
  id: string;
  name: string;
  socketIds: string[];
  usedWagers: number[];
  currentWager?: number;
  currentAnswer?: string;
  currentGrade?: "correct" | "incorrect";
  correctWagerTotal: number;
  answerPoints: number;
};

type Room = {
  code: string;
  hostToken: string;
  hostSocketId?: string;
  phase: RoomPhase;
  settings: GameSettings;
  teams: Team[];
  currentRound: number;
  roundDurationSeconds?: number;
  roundEndsAt?: number;
  createdAt: number;
  updatedAt: number;
};
```

## Validation Rules

- Room code must exist to join.
- Team names must be non-empty and unique per room.
- Settings can only change in lobby.
- `questionCount` must be a positive integer.
- Wagers must be integers from `1..N`.
- A team cannot reuse a wager.
- A team cannot submit/change wager after answer phase starts.
- A team cannot submit/change answer after timer expires.
- Host-only actions require the host token.
- Round can only be graded when each team is graded or explicitly skipped.

## Implementation Milestones

1. **Project scaffold**
   - Create Vite React client.
   - Create Express + Socket.IO server.
   - Add shared TypeScript types.
   - Add Render-compatible build/start scripts.

2. **Room and lobby**
   - Host room creation.
   - Team join flow.
   - Live lobby list.
   - Editable settings.

3. **Round flow**
   - Round setup phase.
   - Wager selection and locking.
   - Answer timer.
   - Answer submission/lockout.

4. **Host grading**
   - Host answer review UI.
   - Correct/incorrect controls.
   - Submit grades.
   - Score calculation.

5. **Leaderboard**
   - Rank by wager score.
   - Compute rank bonuses.
   - Show bonus in parentheses.
   - Handle ties deterministically.

6. **Polish and deploy readiness**
   - Rejoin handling for refresh/disconnect.
   - Empty room cleanup.
   - Basic responsive styling.
   - Render deployment docs.

## Tie Handling

Recommended first version:

- Sort by `correctWagerTotal` descending.
- Tie-break by `answerPoints` descending.
- Tie-break by earlier team join order.

Bonus assignment follows the resulting sorted order. If true shared-rank tie bonuses are preferred, we can update the ranking function before implementation.

## Render Deployment Shape

Expected scripts:

```json
{
  "scripts": {
    "dev": "concurrently \"npm:dev:server\" \"npm:dev:client\"",
    "build": "npm run build:client && npm run build:server",
    "start": "node dist/server/index.js"
  }
}
```

Server behavior in production:

- Serve static files from `client/dist`.
- Fall back to `index.html` for frontend routes.
- Listen on `process.env.PORT`.
- Use Socket.IO with CORS configured for local dev and same-origin production.

## Questions To Confirm Before Building

- Should final winner be based on wager leaderboard plus bonuses, or include the flat correct-answer points too?
- Should players join individually and then form teams, or should each device represent one team?
