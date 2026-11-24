# Sobar Haat API

Express + MongoDB REST API for the Sobar Haat community service platform. It
serves events, joins and organiser-only management, and verifies BetterAuth
JWTs with the `jose` library.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in your values
npm start
```

The server listens on `PORT` (default `8000`).

## Environment

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas connection string |
| `BETTER_AUTH_URL` | Next.js app origin; JWT issuer/audience and JWKS endpoint. **Must match the client exactly.** |
| `CORS_ORIGINS` | Comma-separated browser origins allowed with credentials |
| `PORT` | Express port (Render injects this) |

See `.env.example` for a complete template.

## Authentication

Private routes use Sir's `verifyToken` middleware:

```
Authorization: Bearer <better-auth-JWT>
```

The token comes from the client's `GET /api/auth/token` endpoint and is
verified against `GET /api/auth/jwks` through `createRemoteJWKSet`. The user's
email is always re-read from MongoDB — token claims are never trusted. Public
routes run `verifyToken({ optional: true })`: a valid token is verified, but
anonymous visitors still get data.

## Routes

| Method | Route | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/` | public | Health check |
| `POST` | `/create-event`, `/events` | JWT | Create an event (creator email from token) |
| `GET` | `/events` | public | Upcoming events, nearest date first |
| `GET` | `/events/recent?limit=6` | public | Six nearest upcoming events (`.limit()`) |
| `GET` | `/events/archived[?limit=6]` | public | Past events, newest first |
| `GET` | `/events/:id` | public | Event details |
| `POST` | `/events/:id/join` | JWT | Join an event (one join per user) |
| `GET` | `/joined-events` | JWT | Caller's joined events, sorted by event date |
| `GET` | `/manage-events` | JWT | Caller's created events |
| `PUT` | `/manage-events/:id` | JWT | Edit own event |
| `DELETE` | `/manage-events/:id` | JWT | Delete own event and its joins |

## Data notes

- `events` documents store the organiser's `creatorEmail`; edit/delete check it.
- `joins` documents hold `{ eventId, userEmail, joinedAt }`. The `volunteers`
  number is recomputed from this collection on every read, so no seeded or
  stale count is ever returned.
- Past events are excluded from `/events` and surfaced through `/events/archived`.

## Deployment (Render)

1. Create a Web Service pointing at this repo; build command `npm install`,
   start command `npm start`.
2. Set `MONGODB_URI`, `BETTER_AUTH_URL` (the deployed Vercel origin), and
   `CORS_ORIGINS` (the same Vercel origin).
3. In Vercel set `NEXT_PUBLIC_API_URL` to this Render URL and `BETTER_AUTH_URL`
   to the Vercel origin — both sides of JWT verification must agree.
