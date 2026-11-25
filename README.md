# mail-turnstile

A small Cloudflare Worker for my site's contact form. It sends mail through Microsoft Graph using a personal Outlook account.

## Setup

Set `ALLOWED_ORIGINS` and `CONTACT_RECIPIENT` in `wrangler.jsonc`. The first is a comma-separated list of site origins; requests from other origins are rejected.

The Microsoft app needs delegated Graph `Mail.Send` permission. Sign in to the account that will send mail and get a refresh token with `Mail.Send` and `offline_access` scopes. Add the credentials locally in `.dev.vars`:

```dotenv
MICROSOFT_CLIENT_ID=...
MICROSOFT_REFRESH_TOKEN=...
```

For deployment, set them as Worker secrets instead:

```sh
npx wrangler secret put MICROSOFT_CLIENT_ID
npx wrangler secret put MICROSOFT_REFRESH_TOKEN
```

Install dependencies and run locally with Wrangler:

```sh
npm install
npx wrangler dev
```

Deploy with `npx wrangler deploy`.

## Contact form

Send a JSON `POST` to `/send` with these fields:

```json
{
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "subject": "Hello",
  "message": "I would like to get in touch."
}
```

Include an `Origin` header matching `ALLOWED_ORIGINS`. The message goes to `CONTACT_RECIPIENT`; replies go to the submitted email address. `GET /` is a basic health check.

The `MAIL_STATE` Durable Object keeps the per-site daily send count and the current refresh token. Limits are 50 successful sends per site per day and 5 attempts per IP per site per hour.
