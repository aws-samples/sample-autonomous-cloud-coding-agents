# Jira Forge app actor

This Forge app is the outbound Jira identity for ABCA. Its web trigger verifies
an HMAC-signed request, allows only identity, comment, and transition operations,
then calls Jira with `api.asApp().requestJira(...)`. The identity response also
returns Jira's server URL so setup can bind the installation to the intended
tenant.

## Deploy

```bash
npm install
forge login
forge register bgagent
BGAGENT_PROXY_SECRET="$(openssl rand -hex 32)"
forge variables set --encrypt BGAGENT_PROXY_SECRET "$BGAGENT_PROXY_SECRET"
forge deploy
forge install --product jira --site <site>.atlassian.net
forge webtrigger create        # select bgagent-outbound
```

Use a random secret of at least 32 characters. Register the resulting v2 web
trigger URL and the same secret with ABCA:

```bash
bgagent jira app-setup <cloud-id> \
  --proxy-url https://<installation>.webtrigger.atlassian.app/public/<id>
```

Paste `BGAGENT_PROXY_SECRET` into the hidden prompt.

See [`docs/guides/JIRA_SETUP_GUIDE.md`](../../docs/guides/JIRA_SETUP_GUIDE.md)
for project permissions, migration behavior, and troubleshooting.

## Test

```bash
npm test
```
