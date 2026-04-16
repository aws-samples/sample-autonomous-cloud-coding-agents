"""Browser screenshot functions for AgentCore BrowserCustom.

Best-effort (fail-open): all operations are wrapped in try/except
so a Browser API outage never blocks the agent pipeline.
"""

import json
import os

_lambda_client = None


def _get_lambda_client():
    """Lazy-init and cache the Lambda client."""
    global _lambda_client
    if _lambda_client is not None:
        return _lambda_client
    import boto3

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        raise ValueError("AWS_REGION or AWS_DEFAULT_REGION must be set")
    _lambda_client = boto3.client("lambda", region_name=region)
    return _lambda_client


def capture_screenshot(url: str, task_id: str = "") -> str | None:
    """Invoke browser-tool Lambda to capture a screenshot. Returns pre-signed URL or None."""
    function_name = os.environ.get("BROWSER_TOOL_FUNCTION_NAME")
    if not function_name:
        return None
    try:
        client = _get_lambda_client()
        payload = json.dumps({"action": "screenshot", "url": url, "taskId": task_id})
        response = client.invoke(
            FunctionName=function_name,
            InvocationType="RequestResponse",
            Payload=payload,
        )
        result = json.loads(response["Payload"].read())
        if result.get("status") == "success":
            print(f"[browser] Screenshot captured: {result.get('screenshotS3Key')}", flush=True)
            return result.get("presignedUrl")
        print(f"[browser] Screenshot failed: {result.get('error', 'unknown')}", flush=True)
        return None
    except Exception as e:
        print(f"[browser] [WARN] capture_screenshot failed: {type(e).__name__}: {e}", flush=True)
        return None
