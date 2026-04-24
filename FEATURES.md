# Feature Ideas

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

### Question Preview In Lobby

After upload, show the host a compact preview of all uploaded questions before starting:

- Question number
- Text preview
- Code block preview
- Image thumbnail
- Validation status

This should make it easy to catch bad formatting, missing images, or wrong question order.

## Game Flow Improvements

### Question-By-Question History

Keep and display a round history after each graded round:

- Question
- Team wagers
- Team answers
- Correct/incorrect marks
- Score and bonus changes

Useful for resolving disputes and reviewing the session after play.

### Grade Review Before Advancing

After marking answers correct/incorrect, show a confirmation/review state before scores are finalized.

This reduces accidental mis-clicks and gives the host one last chance to adjust grades.

### Answer Reveal Mode

Add a setting for whether teams can see other teams' answers after grading:

- Host-only answers
- Reveal all answers after grading
- Reveal only correct/incorrect status

### Final Podium Screen

Add a polished final standings screen for projecting:

- Top teams highlighted
- Score and bonus points shown separately
- Clean final rank order

## Host Controls

### Manual Score Adjustment

Allow the host to add or subtract score/bonus points with a short note.

Examples:

- Award partial credit
- Correct a grading mistake after advancing
- Apply classroom-specific exceptions

Adjustments should appear in round history and CSV export.

### Hide Leaderboard During Answering

Add a lobby setting that hides the leaderboard from teams during the answering phase.

Host should still see it. Teams would see standings again after grading.

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

## Reliability

### Team Reconnect Cleanup

Improve refresh/rejoin behavior:

- Show connected/disconnected status per team
- Let teams rejoin with saved local credentials
- Let host remove stale teams from lobby
- Avoid duplicate team entries after refresh

