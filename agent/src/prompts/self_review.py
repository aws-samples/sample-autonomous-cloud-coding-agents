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
"""
