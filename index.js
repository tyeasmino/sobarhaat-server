import cors from "cors";
import "dotenv/config";
import express from "express";
import { importJWK, jwtVerify } from "jose";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const PORT = process.env.PORT || 8000;

// The browser must be allowed to send the BetterAuth session cookie.
app.use(
  cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
  })
);
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
    throw err;
  }
}

const mongoClient = await connectToMongoDB();
const db = mongoClient.db("sobarhaat");
const eventCollection = db.collection("events");
const joinCollection = db.collection("joins");

/** Both old (string) and new (ObjectId) event ids are accepted. */
function idFilter(id) {
  const values = [id];
  if (typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id)) {
    values.push(new ObjectId(id));
  }
  return { $in: values };
}

function toPublicEvent(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { ...rest, id: String(_id) };
}

// ------------------------------------------------------------ auth helpers

/** Read `better-auth.session_token` from the cookie. */
function getSessionToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (
      rawName !== "better-auth.session_token" &&
      rawName !== "__Secure-better-auth.session_token"
    ) {
      continue;
    }
    const value = rawValue.join("=");
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * Authorization header first, session cookie second.
 *   Authorization: Bearer <better-auth-JWT>   (from auth.api.getToken)
 *   Authorization: Bearer <session-token>     (legacy / cookie clients)
 *
 * "" means a malformed Authorization header — it is rejected instead of
 * silently falling back to the cookie.
 */
function getBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : "";
}

/** BetterAuth writes `<session-token>.<hmac-signature>` (URL encoded). */
function tokenCandidates(token) {
  const values = [token];
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    // Keep the raw value if it was not URL encoded.
  }
  if (decoded !== token) values.push(decoded);

  const signatureAt = decoded.lastIndexOf(".");
  if (signatureAt > 0) values.push(decoded.slice(0, signatureAt));
  return [...new Set(values)];
}

const AUTH_ORIGIN = process.env.BETTER_AUTH_URL || "http://localhost:3000";

/**
 * Verify a JWT issued by BetterAuth's `jwt()` plugin. The plugin signs with a
 * key from Mongo's `jwks` collection (EdDSA by default), using BETTER_AUTH_URL
 * as both issuer and audience — not with a plain HMAC secret.
 */
async function verifyJwtToken(token) {
  try {
    const [headerPart] = token.split(".");
    const header = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8")
    );
    if (!header.kid) return null;

    const keyDoc = await db.collection("jwks").findOne({ _id: idFilter(header.kid) });
    if (!keyDoc?.publicKey) return null;

    const alg = keyDoc.alg || "EdDSA";
    const publicKey = await importJWK(JSON.parse(keyDoc.publicKey), alg);
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [alg],
      issuer: AUTH_ORIGIN,
      audience: AUTH_ORIGIN,
    });
    return payload.sub ? payload : null;
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return null;
  }
}

function toPublicUser(user) {
  return {
    id: String(user._id),
    email: String(user.email).toLowerCase(),
    name: user.name ?? String(user.email).split("@")[0],
  };
}

/** Resolve the signed-in user from a verified JWT, session token or cookie. */
async function getAuthenticatedUser(req) {
  const bearer = getBearerToken(req);
  if (bearer === "") return null;

  // A JWT has three dot-separated parts; anything else is a session token.
  const isJwt = Boolean(bearer) && bearer.split(".").length === 3;
  if (isJwt) {
    const payload = await verifyJwtToken(bearer);
    if (payload) {
      // Always read the email from the database, never trust token fields.
      const user = await db
        .collection("user")
        .findOne({ _id: idFilter(String(payload.sub)) });
      if (user?.email) return toPublicUser(user);
    }
    // Expired JWT (15m) on a long-open page — fall back to the session cookie.
  }

  const token = bearer && !isJwt ? bearer : getSessionToken(req);
  if (!token) return null;

  const session = await db
    .collection("session")
    .findOne({ token: { $in: tokenCandidates(token) } });
  if (!session?.expiresAt) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

  const user = await db
    .collection("user")
    .findOne({ _id: idFilter(String(session.userId)) });
  return user?.email ? toPublicUser(user) : null;
}

/**
 * Express middleware. Sets `req.user` when a valid BetterAuth session is
 * present and returns 401 otherwise.
 *
 *   app.get("/private", verifyApi(), handler)
 *   app.get("/public", verifyApi({ optional: true }), handler)
 */
function verifyApi({ optional = false, message = "Please sign in to continue." } = {}) {
  return async function verifyApiMiddleware(req, res, next) {
    try {
      const user = await getAuthenticatedUser(req);
      if (!user && !optional) {
        return res.status(401).send({ message });
      }
      req.user = user ?? null;
      return next();
    } catch (err) {
      console.error(err);
      return res.status(500).send({ message: "Authentication check failed." });
    }
  };
}

const requireSignIn = (action) =>
  verifyApi({ message: `Please sign in to ${action}.` });

app.get("/", (req, res) => {
  res.send({ message: "Server is running fine!!" });
});

// ---------------------------------------------------------------- create
async function createEventHandler(req, res) {
  try {
    const user = req.user;
    const body = req.body ?? {};
    const {
      _id,
      id,
      creatorEmail,
      creatorName,
      volunteers,
      createdAt,
      ...fields
    } = body;

    const event = {
      title: String(fields.title ?? "").trim(),
      type: String(fields.type ?? "Donation"),
      location: String(fields.location ?? "").trim(),
      date: String(fields.date ?? ""),
      time: String(fields.time ?? "10:00"),
      thumbnail: String(fields.thumbnail ?? "/events/winter-clothes.svg"),
      description: String(fields.description ?? ""),
      volunteers: Number.isFinite(Number(volunteers)) ? Number(volunteers) : 0,
      creatorEmail: user.email,
      creatorName: user.name,
      createdAt: createdAt || new Date().toISOString(),
    };

    const result = await eventCollection.insertOne(event);
    res.send({
      acknowledged: result.acknowledged,
      insertedId: String(result.insertedId),
      event: toPublicEvent({ ...event, _id: result.insertedId }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to create event" });
  }
}

app.post("/create-event", requireSignIn("create an event"), createEventHandler);
app.post("/events", requireSignIn("create an event"), createEventHandler);

// ------------------------------------------------------------------ list
app.get("/events", async (req, res) => {
  try {
    const events = await eventCollection.find({}).sort({ date: 1 }).toArray();
    res.send(events.map(toPublicEvent));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load events" });
  }
});

// Public home: only upcoming events, nearest first, capped at 6.
app.get("/events/recent", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 6);
    const today = new Date().toISOString().slice(0, 10);
    const events = await eventCollection
      .find({ date: { $gte: today } })
      .sort({ date: 1 })
      .limit(limit)
      .toArray();
    res.send(events.map(toPublicEvent));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load recent events" });
  }
});

// Event details stay public, but verifyApi still validates an Authorization
// header / session cookie when one is sent and exposes it as `req.user`.
app.get("/events/:id", verifyApi({ optional: true }), async (req, res) => {
  try {
    const event = await eventCollection.findOne({ _id: idFilter(req.params.id) });
    if (!event) return res.status(404).send({ message: "Event not found." });
    res.send(toPublicEvent(event));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load event" });
  }
});

// ------------------------------------------------------------------ join
app.post("/events/:id/join", requireSignIn("join an event"), async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const event = await eventCollection.findOne({ _id: idFilter(id) });
    if (!event) return res.status(404).send({ message: "Event not found." });

    if (String(event.creatorEmail ?? "").toLowerCase() === user.email) {
      return res.status(400).send({ message: "You created this event already." });
    }

    const existing = await joinCollection.findOne({
      eventId: id,
      userEmail: user.email,
    });
    if (existing) {
      return res.send({
        joined: false,
        alreadyJoined: true,
        volunteers: Number(event.volunteers ?? 0),
      });
    }

    await joinCollection.insertOne({
      eventId: id,
      userEmail: user.email,
      joinedAt: new Date().toISOString(),
    });

    const updated = await eventCollection.findOneAndUpdate(
      { _id: idFilter(id) },
      { $inc: { volunteers: 1 } },
      { returnDocument: "after" }
    );

    res.send({
      joined: true,
      alreadyJoined: false,
      volunteers: Number(updated?.volunteers ?? Number(event.volunteers ?? 0) + 1),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to join event" });
  }
});

app.get("/joined-events", requireSignIn("view joined events"), async (req, res) => {
  try {
    const joins = await joinCollection
      .find({ userEmail: req.user.email })
      .sort({ joinedAt: -1 })
      .toArray();
    const events = await Promise.all(
      joins.map((join) =>
        eventCollection.findOne({ _id: idFilter(String(join.eventId)) })
      )
    );
    res.send(events.filter(Boolean).map(toPublicEvent));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load joined events" });
  }
});

// ------------------------------------------------------------- my events
app.get("/manage-events/:email", requireSignIn("view your events"), async (req, res) => {
  try {
    const user = req.user;
    if (user.email !== String(req.params.email).toLowerCase()) {
      return res.status(403).send({ message: "You can only view your own events." });
    }

    const events = await eventCollection
      .find({ creatorEmail: user.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(events.map(toPublicEvent));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load events" });
  }
});

const EDITABLE_FIELDS = [
  "title",
  "type",
  "location",
  "date",
  "time",
  "thumbnail",
  "description",
];

app.put("/manage-events/:id", requireSignIn("edit an event"), async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const event = await eventCollection.findOne({ _id: idFilter(id) });
    if (!event) return res.status(404).send({ message: "Event not found." });

    if (String(event.creatorEmail ?? "").toLowerCase() !== user.email) {
      return res
        .status(403)
        .send({ message: "Only the event creator can edit this event." });
    }

    const changes = {};
    for (const field of EDITABLE_FIELDS) {
      if (field in (req.body ?? {})) changes[field] = req.body[field];
    }

    await eventCollection.updateOne(
      { _id: idFilter(id), creatorEmail: event.creatorEmail },
      { $set: changes }
    );
    const updated = await eventCollection.findOne({ _id: idFilter(id) });
    res.send({ event: toPublicEvent(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to update event" });
  }
});

app.delete("/manage-events/:id", requireSignIn("delete an event"), async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const event = await eventCollection.findOne({ _id: idFilter(id) });
    if (!event) return res.status(404).send({ message: "Event not found." });

    if (String(event.creatorEmail ?? "").toLowerCase() !== user.email) {
      return res
        .status(403)
        .send({ message: "Only the event creator can delete this event." });
    }

    const result = await eventCollection.deleteOne({
      _id: idFilter(id),
      creatorEmail: event.creatorEmail,
    });
    await joinCollection.deleteMany({ eventId: id });

    res.send({
      deletedCount: result.deletedCount,
      message: "Event deleted successfully.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to delete event" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running at ${PORT}`);
});
