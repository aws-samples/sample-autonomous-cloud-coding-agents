---
title: "Slack integration setup guide"
---

This guide shows how to set up the ABCA Slack integration. After setup, your team can submit tasks by mentioning `@Shoof` in any channel and receive real-time notifications as tasks progress.

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction)) with the `slack` feature enabled in its [deployment profile](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#deployment-profiles) (`bgagent setup --features slack,…`)
- A Cognito user account configured (see [User guide](/sample-autonomous-cloud-coding-agents/using/overview))
- A Slack workspace where you are authorized to install apps. If your workspace requires admin approval for app installs, request it through your Slack administrator.
- AWS CLI configured with credentials for your ABCA account

## Quick start

```bash
bgagent slack setup
```

This one command deploys the stack (if needed), generates the Slack App manifest URL, prompts for credentials, and shows the install link. Follow the on-screen instructions.

## How it works

- **@Shoof mentions.** `@Shoof fix the bug in org/repo#42` submits a task. Reactions on your message show progress: :eyes: (received), then :hourglass_flowing_sand: (working), then :white_check_mark: (done).
- **DMs.** Message Shoof directly for private task submissions.
- **Notifications.** Threaded messages show the task from task_created to completed (with PR link, duration, cost). The Cancel button lets you stop a running task.
- **Multi-workspace.** Each workspace installs through OAuth and gets its own bot token.

## Step-by-step setup

### Step 1: Run the setup wizard

```bash
bgagent slack setup
```

If the stack isn't deployed yet, the wizard offers to deploy it for you.

### Step 2: Create the Slack App

The wizard prints a URL that opens Slack's "Create New App" page with the scopes, events, commands, and URLs pre-filled. Click the link, select your workspace, and create the app.

### Step 3: Enter credentials

The wizard prompts for three values. Find them in your new app under **Basic Information**, then **App Credentials**:

| Field | Format |
|-------|--------|
| Signing Secret | 32 hex characters |
| Client Secret | 32 hex characters |
| Client ID | Numeric (for example 12345.67890) |

![App Credentials location](/sample-autonomous-cloud-coding-agents/imgs/find-credentials.png)

Format validation catches obvious typos (wrong length, non-hex characters). If the format is wrong, the wizard asks you to enter the value again. The wizard cannot verify the actual values until the app is installed. If you paste the wrong secret by mistake, you get an error at install time.

### Step 4: Verify Event Subscriptions

In the Slack App dashboard, go to **Event Subscriptions**:

![Finding Event Subscriptions](/sample-autonomous-cloud-coding-agents/imgs/find-even-subscriptions.png)

1. The Request URL may show "Your URL didn't respond". If it does, click **Retry**.
2. Wait for the green "Verified" checkmark.
3. Click **Save Changes**.

![Event Subscriptions before](/sample-autonomous-cloud-coding-agents/imgs/enable-events-before.png)

Click **Retry** and wait for the green checkmark:

![Event Subscriptions after](/sample-autonomous-cloud-coding-agents/imgs/enable-events-after.png)

The first attempt may time out because of a Lambda cold start. The retry always succeeds.

### Step 5: Install the app

The wizard prints an OAuth install URL. Open it in your browser. Do **not** use the "Install App" button in the Slack dashboard, because it won't connect to your backend.

After you click **Allow**, you see a success page. The bot token is now stored, and Shoof can respond to messages.

### Step 6: Link your account

In Slack:
```
/bgagent link
```

In your terminal:
```bash
bgagent slack link <CODE>
```

This one-time step connects your Slack identity to your ABCA (Cognito) account. The code expires in 10 minutes.

### Step 7: Test it

In any channel where Shoof is added:
```
@Shoof fix the README typo in org/repo#1
```

You should see:
- :eyes: reaction on your message immediately
- A "Task submitted" message in the thread
- :hourglass_flowing_sand: reaction when the agent starts
- :white_check_mark: reaction and "Task completed" with a View PR button when done

## Usage

### Submit a task

Mention Shoof with a repo and description:
```
@Shoof fix the login bug in org/repo#42
@Shoof update the README in org/repo
@Shoof fix https://github.com/org/repo/issues/42
```

A pasted GitHub link to a repo, an issue or a pull request names the repo, as `org/repo` or `org/repo#42` does. The link that names the repo is taken out of the task description, together with any words you turned into the link. The agent gets the repo, the issue or pull request number, and the rest of your message, so say in words what a linked comment asks for.

For private submissions, DM Shoof directly:
```
fix the login bug in org/repo#42
```

### Cancel a task

Click the **Cancel Task** button in the thread while the agent is working.

### Get help

```
/bgagent help
```

### Slash commands

| Command | Purpose |
|---------|---------|
| `/bgagent link` | Link your Slack account (one-time) |
| `/bgagent help` | Show usage instructions |

## Troubleshooting

### @Shoof doesn't respond

1. Is Shoof added to the channel? Use `/invite @Shoof` or add it through the channel settings.
2. Were credentials entered correctly? Delete the app and re-run `bgagent slack setup`.
3. Check the CloudWatch logs of the `SlackEventsFn` Lambda. Look for "Invalid Slack event signature", which means a wrong signing secret.

### "Your Slack account is not linked"

Run `/bgagent link` in Slack, then `bgagent slack link <code>` in your terminal.

### "Repository not onboarded"

The repo must be registered with a Blueprint before you submit tasks. See the [User guide](/sample-autonomous-cloud-coding-agents/using/overview).

In a channel that has a default repo (`bgagent slack onboard-channel`) you get this answer only for a repo that is given as a GitHub link, that is written with an issue number (`org/repo#42`), or that has the same owner as the repo the task would otherwise run on: the channel's default, or an onboarded repo named in the same message. Any other `word/word`, a repo of another owner included, is read as part of the description.

A GitHub link to a repo, an issue or a pull request names its repo wherever it stands in the message, also in pasted output, so a link to an issue of a repo that is not onboarded gets this answer too. To refer to such an issue in a task for another repo, write the onboarded repo the task is for before the link. A link to anything else (another site, or a file, a branch or a workflow run on GitHub) names no repo and stays in the description.

The "Task submitted" message names the repo that the task runs on. If that is not the repo you meant, click **Cancel Task** on the "Agent started working" message.

### OAuth install fails (bad_client_secret)

The stored credentials don't match your app. Delete the app, re-run `bgagent slack setup`, and paste the correct values.

### Event Subscriptions URL doesn't verify

Click **Retry**. The first attempt times out because of a Lambda cold start. The retry succeeds.

## Multi-workspace support

The integration supports multiple Slack workspaces. Each workspace admin opens the OAuth install URL from the `bgagent slack setup` output. The integration stores each workspace's bot token separately. Users in each workspace link their accounts independently.

## Removing the integration

To uninstall from a workspace, open Slack and go to **Settings**, then **Manage Apps**, then **Shoof**, and click **Remove App**. The bot token is automatically scheduled for deletion.

To remove the Slack integration from your ABCA deployment entirely, delete the Slack App, then run `bgagent setup` and disable Slack. Disabling Slack deletes the installation, user and channel mapping tables (see [What disabling a feature removes](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#what-disabling-a-feature-removes)).
