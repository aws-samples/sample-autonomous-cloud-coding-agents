# Vulture allowlist (issue #282, cairn MVG gate #6).
#
# Names here are reported by vulture as unused but are intentionally kept.
# vulture "uses" every attribute access in this file, so listing a name
# suppresses its finding. Only entries that fire at `--min-confidence 80`
# (the CI threshold) belong here — lower-confidence noise (Pydantic
# `model_config`, FastAPI route handlers, dynamically-dispatched methods)
# is below the threshold and must NOT be blanket-allowlisted, so that real
# dead code in those forms still surfaces.
#
# Regenerate/extend (then hand-review the diff):
#   cd agent && uvx vulture src --make-whitelist
#
# Keep this list MINIMAL. Prefer deleting dead code over allowlisting it.

# claude-agent-sdk invokes hooks positionally as
# (hook_input, tool_use_id, hook_context). The dispatcher in hooks.py passes
# its own `ctx`, so the `hook_context` positional is part of the required
# signature but unread in these three hook bodies. Cannot be removed without
# breaking the SDK calling convention.
hook_context  # unused variable (src/hooks.py:132)
hook_context  # unused variable (src/hooks.py:918)
hook_context  # unused variable (src/hooks.py:1258)
