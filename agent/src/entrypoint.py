"""Batch entry point; the ECS boot command imports run_task_from_payload from it."""

from pipeline import main, run_task_from_payload  # noqa: F401

if __name__ == "__main__":
    main()
