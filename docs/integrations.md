# Integrations: data sources and website logins

Agents work with the company's other systems in two ways:

- **Data sources** (kind `api`): an HTTP API, such as a portfolio system's read-only API. Agents call it with the `call_api` tool, or straight from code in their job's sandbox.
- **Website logins** (kind `login`): an account on a website with no usable API, used by chosen agents through a headless Chromium in the job's sandbox. Example: an agent that enters data in Masttro's web app.

Both are company-wide, and each can be limited to chosen people (admins choose, in Settings → Integrations → Whose work): then only their assistant, and the work it does for them, can use it. An agent on a task uses it only if both the agent and the person the run is for are allowed. A person's own accounts (their GitHub) are not integrations: each person connects theirs, and it's used only for their own work; see [github.md](github.md). Each can be limited to chosen agents, so the company can connect Masttro's API as a data source every analyst reads from, and give Masttro's web login only to the one data-entry agent.

Everything is in **Settings → Integrations**: status, who can use it, access, credentials, the guide agents keep, and recent `call_api` activity.

## Connecting one

Tell the Chief of Staff, e.g. "Connect Masttro as a data source, the API docs are at …" or "Set up a login for app.masttro.com for the data entry agent". It sets the integration up itself, in the chat: it never creates an agent or a task for this.

It reads the docs first. When `fetch_page` can't read them (a JavaScript page, or docs behind a sign-in), it uses the browser in its own sandbox:

- **Docs behind a sign-in:** it connects a login for the docs site, for itself only. You enter your username and password in the card, which tells the Chief of Staff when it's saved, so it carries on. It signs in with `browser_login`; if the site sends a code, a code card in the chat hands it straight to the waiting browser.
- **Swagger or Redoc pages:** `browse` lists the data a page loaded, which is where these pages fetch their spec. It saves the spec and reads it with code.

Then it saves the integration:

- **For a data source:**
  - the base URL and the hosts requests may go to;
  - the credential fields people will fill in;
  - how requests are signed. Header and query values are templates: `{{apiKey}}` is a credential field, `{{token}}` is an access token from a token step (OAuth client credentials or a login endpoint), and `{{basic:user:pass}}` is HTTP Basic.
  - a test path.
- **For a login:** the sign-in page, the fields (username, password, and optionally an authenticator setup key), a page that only shows when you're signed in, and form selectors if the defaults don't find the form.

It then shows a credentials card in the chat. What people type in that card, or later in Settings → Integrations, goes straight to the server and is sealed. It never passes through a model, the chat or a task thread.

## Keeping credentials out of models

- **Sealed at rest.** Credentials and saved browser sessions are encrypted with AES-256-GCM using `MACH_SECRETS_KEY` (32 random bytes, base64). Without the key, nothing can be connected.
- **Data sources in a sandbox.** The job's sandbox gets a network policy for the run. Requests to a data source's hosts have its auth headers added on the way out, by Vercel Sandbox's network proxy, so the key never enters the sandbox. When the run ends, the policy goes back to allow-all.
  - A read-only source refuses anything but GET, so agents can't write by accident.
  - Sources signed with query parameters work through `call_api` only, because the proxy can only add headers.
- **`call_api`** checks the agent may use the source and that the host is allowed, signs the request, logs it, and returns the response with secret values replaced by `[secret]`.
- **Scrubbing.** Command output, file notes, chat and thread text are scrubbed of known secret values as well, in case an API echoes a key. Usernames aren't treated as secrets.
- **Asking.** Agents are told never to ask for passwords or keys in a thread. If someone pastes one in a chat anyway, saving the credentials scrubs it from the chats and threads.

## Website logins and sign-in codes

The `browser_login` tool signs the job's browser in:

- A helper in the sandbox (`login.py`, Playwright) reads the credentials from a file it deletes straight away. It fills the form, handling two-step forms and same-page code prompts, and saves the browser's session. The password never reaches the model.
- With an authenticator setup key saved, the helper makes the 6-digit code itself.
- Otherwise, if the site asks for a code, the job asks the people on it and waits:
  - it moves to **Waiting** and shows up in their **Needs you**;
  - the helper and browser stay running in the sandbox;
  - a reply that is a code (e.g. "123 456") is sealed and handed to the helper on the agent's next run. The thread shows only "Sent the … sign-in code."
- The signed-in session is saved, so later runs and other jobs skip the login until the site signs it out. "Forget" in Settings → Integrations drops it.
- The sandbox template (`data-v3`) has Chromium. It also has `trust-network-proxy`, which lets the browser trust the network proxy that signs data source requests.

Agents are told to show exactly what they'll enter, as a table, and get approval before changing anything in a system of record. They take screenshots before and after and attach them.

## Guides

Each integration has a guide: what agents learned about using it, such as endpoints, quirks and the steps through a web app. Agents read it with `read_integration_guide` and add what they learn with `save_integration_guide`, so the next job starts from it.

## Where the code is

| Path | What it is |
|---|---|
| `lib/integrations.ts` | Storage, sealing, `callIntegration`, tokens, the sandbox network policy, sessions |
| `lib/secrets.ts` | `seal`, `unseal`, `redact` |
| `lib/agents/integration-steps.ts` | `call_api` and the guide tools |
| `lib/agents/browser-steps.ts` | `browser_login`, the sign-in helper, codes and saved sessions |
| `lib/agents/chief-of-staff.ts` | `connect_data_source`, `connect_login` |
| `components/integrations.tsx`, `components/credentials-form.tsx` | Settings → Integrations and the credentials card |
