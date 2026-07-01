"""Self-review prompt template for pre-PR diff critique."""

SELF_REVIEW_PROMPT = """\
You are reviewing your own work before it becomes a pull request. Below is the \
cumulative diff of all changes on this branch compared to the base branch.

<diff>
{diff}
</diff>

## Task context

{task_description}

## Review checklist

Examine the diff carefully for:

1. **Correctness** — Logic errors, off-by-one mistakes, missing edge cases, \
incorrect assumptions about data shapes or API contracts.
2. **Bugs** — Null/undefined dereferences, unhandled error paths, resource leaks, \
race conditions.
3. **Security** — Injection vulnerabilities (SQL, command, XSS), hardcoded secrets, \
insecure defaults, OWASP Top 10 issues.
4. **Style & consistency** — Naming conventions, code style violations relative to \
the surrounding codebase, unnecessary complexity.
5. **Test gaps** — Important behaviour that is untested, assertions that don't \
verify the right thing, missing edge-case coverage.

## Instructions

- If you find issues, fix them directly: edit the files, run the build/tests to \
verify your fixes, and commit the changes.
- If no issues are found, stop immediately — do not make changes for the sake of \
making changes.
- Do NOT refactor code that was not part of the original diff unless it has a \
concrete bug or security issue.
- Keep fixes minimal and focused. Each fix should be a separate commit with a \
clear message.

## Summary output

After completing your review (whether you made fixes or not), write a file \
`.self-review-summary.md` in the repository root with your findings in this format:

```markdown
### Self-Review Summary

**Findings:** <number of issues found>
**Fixes applied:** <number of fixes committed>

#### Issues found

- <category>: <brief description of issue> — <fixed | not fixed (reason)>
```

If no issues were found, write the file with: "No issues found — code looks good."

This file is a pipeline artifact and will be deleted automatically — it will NOT \
appear in the pull request.
"""
