# Question Upload Format

Upload either a single `questions.json` file or one folder containing `questions.json` plus optional images.

```json
{
  "questions": [
    {
      "text": "Read the snippet and identify the bug.",
      "codeLanguage": "python",
      "code": "def add_one(x):\n    return x + 2",
      "image": "q1.png"
    },
    {
      "text": "Explain what this output means.",
      "code": "console.log([1, 2, 3].map(x => x * x));"
    }
  ]
}
```

Rules:

- `text` is required.
- `code` is optional.
- `codeLanguage` is optional and displayed as a small label above the code block.
- `image` is optional.
- If using images, upload a folder that contains `questions.json` and the image files.
- Images can be referenced by filename in `image`, or auto-matched by question number with names like `q1.png`, `1.jpg`, `question1.webp`, or `question-1.png`.
- Supported image types: PNG, JPG, GIF, WebP.

