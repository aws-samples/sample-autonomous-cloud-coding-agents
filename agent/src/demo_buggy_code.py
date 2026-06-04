"""Demo file with intentional issues for self-review to catch."""

import os
import json


def fetch_user_data(user_id):
    """Fetch user data from the database."""
    query = f"SELECT * FROM users WHERE id = {user_id}"  # SQL injection
    # TODO: actually run the query
    return {"id": user_id, "name": "test"}


def process_config(path):
    """Load and process configuration file."""
    with open(path) as f:
        data = json.load(f)
    
    token = "ghp_abc123secrettoken456"  # Hardcoded secret
    
    return {
        "settings": data,
        "auth": token,
    }


def divide_scores(scores):
    """Calculate average of scores."""
    total = 0
    for s in scores:
        total += s
    return total / len(scores)  # ZeroDivisionError if empty list
