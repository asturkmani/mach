---
name: connecting-integrations
description: "Connecting one of the company's systems as a data source from its API docs, so every agent can use it."
---

A data source lets agents call a company system's API without ever seeing its credentials. Set it up yourself, in the chat: never create an agent or a task to do it.

1. Read the API docs: fetch_page on the URL they gave, or a file they attached. If that comes back empty or as a sign-in page, the docs need a browser:
   - browse the URL: it opens it in the browser in your sandbox.
   - If it needs a sign-in: reuse the company's login for that site if there is one, else connect_login for it (the docs site, e.g. https://app.example.com/api/index.html as the sign-in page; leave agents out when only you need it). Ask them to enter their username and password in the card. When they say it's done, call browser_login, then browse again. If the site sends a sign-in code, they get a card to enter it; when they say it's entered, call browser_login again.
   - API docs pages (Swagger UI, Redoc) load their spec as JSON or YAML: browse lists it under "Data the page loaded". Browse that URL with save_as (e.g. inputs/openapi.json), then run_code to list its servers, security schemes and GET endpoints rather than reading it all.
   Find: the base URL, how requests are authenticated (header, query parameter, or a token exchanged first), a cheap GET that proves the credentials work (a "me", "accounts" or "ping" endpoint), and whether it's read-only.
2. Call connect_data_source with:
   - fields: what the person must enter, e.g. [{ name: "apiKey", label: "API key" }] or an API key and secret, or a client id and secret. Mark non-secret ones (a tenant id) secret: false.
   - headers (or query) as templates: "Authorization": "Bearer {{apiKey}}", "X-Api-Key": "{{apiKey}}", "Authorization": "Basic {{basic:username:password}}".
   - token, when the API swaps credentials for a short-lived token first (OAuth client credentials or a login endpoint): its url, format (form or json), body templates, path to the token in the response and expiresInPath; then sign requests with "Bearer {{token}}".
   - testPath: the cheap GET.
   - access: read unless they asked for agents to change data there.
   - agents: leave out to give every agent access; name agents to limit it.
   - guide: the first version of the system's skill, for agents: what data it holds, the main endpoints with their parameters, paging, rate limits, field meanings and gotchas. Write it by the writing-skills skill; it's named after the integration, and every agent loads it before using the system. After jobs that use it, Mach1 proposes what to add, and a person applies it.
3. Never ask for credentials in the chat. The tool shows them a secure card to enter them, which tests the connection. If they paste a key in the chat anyway, tell them to enter it in the card instead (Mach1 scrubs it from the chat when they do) and to consider rotating it.
4. When they say the credentials are in, check it with call_api on the test path and tell them what you can see. Then you can answer quick questions from it, and jobs can use it. For regular pulls (positions every morning), create a recurring task that saves them to the company drive.

Website logins for work: when the work needs a website with no API, or changes the API can't make (an API that's read-only, data entry), use connect_login: the sign-in page, and a page that only shows when signed in. Every agent in the company can use it (an admin can limit it to chosen people's work), so never create an agent just to read docs or set up a connection. The card asks for the username and password, and optionally an authenticator setup key so agents can answer sign-in codes themselves; without it, codes come to the people on the job as a question. A company can have both for one system: a read-only data source for reading, and a login for changes.
