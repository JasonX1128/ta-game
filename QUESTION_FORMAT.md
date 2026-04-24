# Question Upload Format

Upload either a single `questions.json` file or one folder containing `questions.json` plus optional images.

```json
{
  "questions": [
    {
      "topic": "Debugging",
      "text": "Read the snippet and identify the bug.",
      "minutes": 3,
      "codeLanguage": "python",
      "code": "def add_one(x):\n    return x + 2",
      "answer": "The function adds 2 instead of 1.",
      "image": "q1.png"
    },
    {
      "topic": "Async JavaScript",
      "text": "Explain what this output means.",
      "code": "console.log([1, 2, 3].map(x => x * x));"
    },
    {
      "topic": "Multipart",
      "text": "This is a multipart question. Answer each part in the same response box.",
      "minutes": 4,
      "parts": [
        {
          "id": "bug",
          "label": "Part A",
          "text": "Identify the bug in the snippet.",
          "codeLanguage": "python",
          "code": "def add_one(x):\n    return x + 2",
          "answer": "It returns x + 2 instead of x + 1.",
          "fraction": 0.4
        },
        {
          "id": "fix",
          "label": "Part B",
          "text": "Write the corrected line.",
          "answer": "return x + 1",
          "fraction": 0.6
        }
      ]
    }
  ]
}
```

Rules:

- `topic` is optional and shown to teams while they choose a wager. If omitted, the app shows `General question`.
- `text` is required.
- `code` is optional.
- `codeLanguage` is optional and displayed as a small label above the code block.
- `minutes` is optional and auto-fills the host timer for that question.
- `answer` is optional and is shown to participants only after grades are finalized. When present, it is also sent to Gemma with the question and student answers for host-only grade suggestions.
- `image` is optional.
- If using images, upload a folder that contains `questions.json` and the image files.
- Images can be referenced by filename in `image`, or auto-matched by question number with names like `q1.png`, `1.jpg`, `question1.webp`, or `question-1.png`.
- Supported image types: PNG, JPG, GIF, WebP, SVG.
- `parts` is optional and lets one question contain multiple graded subparts.
- Each part needs `text`; part-level `code`, `codeLanguage`, `answer`, `id`, and `label` are optional.
- Part `fraction` is optional. If every part omits it, the question value is split uniformly. If some parts include it, the remaining value is split uniformly across the unweighted parts. If every part includes it, the fractions must add to `1`.
- Hosts and Gemma grade each part with partial credit from `0` to `1`. The score is `wager * part fraction * partial credit`, summed across parts.
