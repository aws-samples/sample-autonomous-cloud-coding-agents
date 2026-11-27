"""Registry assets in the agent (#246).

The orchestrator resolves ``registry://`` refs and sends the resolved assets in
the task payload; ``loader`` applies them. The agent makes no registry call.

See ``docs/design/REGISTRY.md``.
"""
