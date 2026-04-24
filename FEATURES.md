# Feature Roadmap

The ideas below are now implemented in the main app. Keep this file as a reference for what each feature is meant to do and as a checklist for future polish.

## High-Value Next

### Export Results CSV

After the game ends, let the host download a CSV with:

- Team name
- Rank
- Score
- Bonus points
- Correct-answer points
- Rank bonus
- Used wagers
- Correct count
- Incorrect count
- Per-round wager, answer, and grade if available

Status: implemented on the final standings screen.

### Question Preview In Lobby

After upload, show the host a compact preview of all uploaded questions before starting:

- Question number
- Text preview
- Code block preview
- Image thumbnail
- Validation status

This should make it easy to catch bad formatting, missing images, or wrong question order.

Status: implemented in the host lobby.

## Game Flow Improvements

### Question-By-Question History

Keep and display a round history after each graded round:

- Question
- Team wagers
- Team answers
- Correct/incorrect marks
- Score and bonus changes

Useful for resolving disputes and reviewing the session after play.

Status: implemented after each graded round and on the final screen.

### Grade Review Before Advancing

After marking answers correct/incorrect, show a confirmation/review state before scores are finalized.

This reduces accidental mis-clicks and gives the host one last chance to adjust grades.

Status: implemented as a review step before finalizing grades.

### Gemma Grade Suggestions

While the host is grading, send the question, official answer, and each student answer to Gemma for structured correct/incorrect suggestions.

The suggestions prefill only untouched grade buttons, never finalize grades, and never overwrite a host choice made before the AI response returns.

Gemma also returns concise student-facing feedback for each team. Feedback is stored with the finalized round and shown to that team after grades are released.

Hosts must enable this per room with the server-side `LLM_GRADING_PASSWORD` so public rooms cannot spend the configured Gemma API key by default.

Status: implemented as a host-only grading aid.

### Answer Reveal Mode

Add a setting for whether teams can see other teams' answers after grading:

- Host-only answers
- Reveal all answers after grading
- Reveal only correct/incorrect status

Status: implemented as a lobby setting.

### Final Podium Screen

Add a polished final standings screen for projecting:

- Top teams highlighted
- Score and bonus points shown separately
- Clean final rank order

Status: implemented on the final standings screen.

## Host Controls

### Protest Grading

After teams submit protests, let the host accept or reject each protest from round history.

Accepting a protest marks that round result correct and updates the team's score/bonus totals immediately. Rejecting leaves the grade as-is. Hosts can add a short response that the team sees.

Status: implemented after grades are finalized.

### Post-Round Point Change

Allow the host to add or subtract score/bonus points with a short note.

Examples:

- Award partial credit
- Correct a grading mistake after advancing
- Apply classroom-specific exceptions

Adjustments should appear in round history and CSV export.

Status: implemented as a host control after the game starts.

### Hide Leaderboard During Answering

Add a lobby setting that hides the leaderboard from teams during the answering phase.

Host should still see it. Teams would see standings again after grading.

Status: implemented as a lobby setting.

### Per-Question Timer

Allow uploaded questions to include a timer:

```json
{
  "text": "Explain this snippet.",
  "minutes": 3,
  "code": "console.log('hello');"
}
```

When present, auto-fill the host's timer input for that round.

Status: implemented for uploaded questions.

## Reliability

### Team Reconnect Cleanup

Improve refresh/rejoin behavior:

- Show connected/disconnected status per team
- Let teams rejoin with saved local credentials
- Let host remove stale teams from lobby
- Avoid duplicate team entries after refresh

Status: implemented for rejoin, connected status, and host lobby removal.
