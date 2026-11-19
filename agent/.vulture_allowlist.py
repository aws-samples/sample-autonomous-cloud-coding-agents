# Vulture allowlist (issue #282, cairn MVG gate #6).
#
# Names here are reported by vulture as unused but are intentionally kept.
# vulture "uses" every attribute access in this file, so listing a name
# suppresses its finding. Only entries that fire at `--min-confidence 80`
# (the threshold in pyproject.toml) belong here. Lower-confidence findings
# (Pydantic `model_config`, FastAPI route handlers, dynamically-dispatched
# methods, and unused functions and classes in general) are below the
# threshold and are not reported, so an entry for one does nothing today.
# Do not add one: it would hide real dead code in those forms if the
# threshold is lowered.
#
# Regenerate/extend (then hand-review the diff):
#   cd agent && uv run vulture src --make-whitelist
#
# Keep this list MINIMAL. Prefer deleting dead code over allowlisting it.
