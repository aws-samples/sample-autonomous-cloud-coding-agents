# Jira Forge app actor

This Forge app is the outbound Jira identity for ABCA. Its web trigger verifies
an HMAC-signed request, allows only identity, comment, and transition operations,
then calls Jira with `api.asApp().requestJira(...)`. The identity response also
returns Jira's server URL so setup can bind the installation to the intended
tenant.

## Deploy

Install the [Forge CLI](https://developer.atlassian.com/platform/forge/getting-started/#install-the-forge-cli), then create a [Forge CLI scoped token](https://go.atlassian.com/forge-cli-api-token). Run login in an interactive terminal; a Jira OAuth token or Atlassian password is not a Forge CLI credential.

```bash
npm ci
forge login
forge register bgagent --accept-terms
```

The first registration may prompt you to create or select an Atlassian Developer Space. Registration replaces the placeholder `app.id` in `manifest.yml`. Keep that operator-owned ID for future Forge commands, but do not commit it to the sample repository or a contribution branch.

Use one random secret on both sides of the proxy. These commands deploy a stable production installation:

```bash
BGAGENT_PROXY_SECRET="$(openssl rand -hex 32)"
forge variables set --encrypt BGAGENT_PROXY_SECRET "$BGAGENT_PROXY_SECRET" \
  --environment production
forge deploy --environment production
forge install \
  --product Jira \
  --site <site>.atlassian.net \
  --environment production \
  --confirm-scopes
forge webtrigger create \
  --functionKey bgagent-outbound \
  --product Jira \
  --site <site>.atlassian.net \
  --environment production
```

Register the resulting v2 web-trigger URL and the same secret with ABCA:

```bash
bgagent jira app-setup <cloud-id> \
  --proxy-url https://<installation>.webtrigger.atlassian.app/public/<id> \
  --region <region> \
  --stack-name <stack-name>
```

Paste `BGAGENT_PROXY_SECRET` into the hidden prompt, then run `unset
BGAGENT_PROXY_SECRET`. The command accepts only a Forge v2 installation URL and
saves the configuration only after Jira reports `accountType=app` for the
expected tenant.

The web trigger has no Forge-managed caller authentication. ABCA signs
`timestamp + "." + rawBody` with HMAC-SHA256; the handler enforces a five-minute
clock window and allows only identity, comment, read-transition, and transition
operations. Jira calls use `api.asApp()`, so their actor is the installed
`bgagent` app rather than the 3LO setup user.

Verify the installation with:

```bash
forge install list --environment production
```

See [`docs/guides/JIRA_SETUP_GUIDE.md`](../../docs/guides/JIRA_SETUP_GUIDE.md)
for project permissions, secret rotation, migration behavior, custom-stack
flags, and troubleshooting.

## Test

```bash
npm test
```
