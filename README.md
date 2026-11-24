# Sobar Haat API

Express + MongoDB REST API behind the Sobar Haat Social Development Events
Platform. It owns the event and join data, enforces organiser-only edits, and
verifies BetterAuth JWTs with `jose` before any private operation.

The client app lives in the sibling `sobarhat-client` repository.

## Stack

- Express 5, `cors`, `dotenv`
- MongoDB driver 7 (Atlas cluster, database `sobarhaat`)
- `jose` 6 — `createRemoteJWKSet` + `jwtVerify`
- Node.js ES modules (`import` syntax)

## Run locally

```bash
npm install
cp .env.example .env   # then fill in your values
npm start
```

Default port is `8000`; override with `PORT`.

## Environment

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas connection string |
| `BETTER_AUTH_URL` | Client origin. JWT issuer **and** audience; JWKS URL is `${BETTER_AUTH_URL}/api/auth/jwks`. Must match the client exactly. |
| `CORS_ORIGINS` | Comma-separated origins allowed to send credentials (defaults to localhost) |
| `PORT` | Express port (Render injects this) |

See `.env.example` for a template.

## Authentication — `verifyToken`

Sir's middleware pattern is used on every protected route:

```js
const token = authHeader.split(" ")[1];          // Authorization: Bearer <jwt>
const payload = await verifyJwt(token);           // remote JWKS + jwtVerify
const user = await db.collection("user").findOne({ _id: idFilter(payload.sub) });
req.user = toPublicUser(user);
```

- Public reads use `verifyToken({ optional: true })`: a valid token is verified
  but anonymous visitors still get data.
- Mutations and private reads use strict `verifyToken()`: missing or invalid
  tokens return `401` with a specific message.
- Email is always re-read from MongoDB; token claims are never trusted.

The JWT is short-lived and acquired client-side from `GET /api/auth/token`.

## Routes

| Method | Route | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/` | Public | Health check |
| `POST` | `/create-event`, `/events` | JWT | Create event; `creatorEmail` comes from the verified user, client-supplied counts are ignored |
| `GET` | `/events` | Public | Upcoming only (`date >= today`), nearest date first |
| `GET` | `/events/recent?limit=6` | Public | Six nearest upcoming events using MongoDB `.limit(6)` |
| `GET` | `/events/archived[?limit=6]` | Public | Past events (`date < today`), newest first; no limit returns all |
| `GET` | `/events/:id` | Public | Event details, including real volunteer count |
| `POST` | `/events/:id/join` | JWT | One join per user; past events cannot be joined; organisers may join too |
| `GET` | `/joined-events` | JWT | Caller's joins, sorted by **event date** |
| `GET` | `/manage-events` | JWT | Caller's created events |
| `GET` | `/manage-events/:email` | JWT | Legacy path; still rejects another user's email with `403` |
| `PUT` | `/manage-events/:id` | JWT | Only editable fields; owner check with `403` otherwise |
| `DELETE` | `/manage-events/:id` | JWT | Owner check, then removes the event and its join records |

## Data model

**`events`** — `title`, `type`, `location`, `date` (`YYYY-MM-DD`), `time`
(`HH:MM`), `thumbnail`, `description`, `volunteers`, `creatorEmail`,
`creatorName`, `createdAt`.

**`joins`** — `eventId`, `userEmail`, `joinedAt`. One document per
user/event pair.

BetterAuth owns `user`, `session` and `jwks` collections in the same database.

### Volunteer counts

`volunteers` is never trusted from the event document. Every read path maps
events through `publicEvents()`, which aggregates the `joins` collection by
`eventId` and returns the real count. A join insertion re-counts the collection
and stores that value back onto the event, so numbers stay exact and no seed
data leaks into the UI.

### Safety rules

- Create ignores any `volunteers` value from the request and starts at `0`.
- Edit/delete compare the stored `creatorEmail` with the verified user.
- Joining a past event returns `400`; duplicate joins return `alreadyJoined`.
- Deleting an event also deletes its joins so counts cannot go stale.

## Deployment (Render)

1. Create a Web Service for this repo. Build: `npm install`; start: `npm start`.
2. Set `MONGODB_URI`, `BETTER_AUTH_URL` to the deployed Vercel origin, and
   `CORS_ORIGINS` to that same origin.
3. In Vercel set `NEXT_PUBLIC_API_URL` to this Render URL and `BETTER_AUTH_URL`
   to the Vercel origin — both sides must agree or JWT verification fails.

## Verification

```bash
node --check index.js
curl http://localhost:8000/events                 # upcoming only
curl "http://localhost:8000/events/archived?limit=6"
curl -X POST http://localhost:8000/events         # 401 without a Bearer token
```
