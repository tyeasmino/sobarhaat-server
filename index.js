import cors from "cors";
import "dotenv/config";
import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const PORT = process.env.PORT || 8000;

// The browser must be allowed to send the BetterAuth session cookie. In
// production set CORS_ORIGINS to the deployed client URL (comma-separated for
// Vercel preview aliases); localhost remains the default for local development.
const allowedOrigins = (process.env.CORS_ORIGINS ||
  "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
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

/**
 * `volunteers` is never trusted from the event document. The real number of
 * joined users lives in the `joins` collection, so count those records instead.
 */
async function joinCountsByEvent(events) {
  const ids = events.map((event) => String(event._id));
  if (!ids.length) return new Map();

  const matchIds = ids.flatMap((id) =>
    /^[0-9a-fA-F]{24}$/.test(id) ? [id, new ObjectId(id)] : [id]
  );
  const rows = await joinCollection
    .aggregate([
      { $match: { eventId: { $in: matchIds } } },
      { $group: { _id: { $toString: "$eventId" }, count: { $sum: 1 } } },
    ])
    .toArray();

  return new Map(rows.map((row) => [String(row._id), row.count]));
}

async function publicEvents(events) {
  const counts = await joinCountsByEvent(events);
  return events.map((event) => ({
    ...toPublicEvent(event),
    volunteers: counts.get(String(event._id)) ?? 0,
  }));
}

async function publicEvent(event) {
  const [result] = await publicEvents(event ? [event] : []);
  return result ?? null;
}

async function realJoinCount(id) {
  const value = String(id);
  const values = /^[0-9a-fA-F]{24}$/.test(value)
    ? [value, new ObjectId(value)]
    : [value];
  return joinCollection.countDocuments({ eventId: { $in: values } });
}

// -------------------------------------------------- auth (sir-er verifyToken)

const AUTH_ORIGIN = process.env.BETTER_AUTH_URL || "http://localhost:3000";

/**
 * Sir-er pattern: fetch the public keys from BetterAuth's JWKS endpoint and
 * let `jose` pick the right key from the token header (`kid`).
 */
const JWKS = createRemoteJWKSet(new URL(`${AUTH_ORIGIN}/api/auth/jwks`));

async function verifyJwt(token) {
  try {
    const { payload } = await jwtVerify(token, JWKS);
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

/**
 * Sir-er verifyToken middleware — `Authorization: Bearer <jwt>` header theke
 * token niye remote JWKS diye verify kore and `req.user` set kore.
 *
 *   app.post("/add-event", verifyToken(), handler)              // required
 *   app.get("/events", verifyToken({ optional: true }), handler) // public
 */
function verifyToken({
  optional = false,
  message = "Please sign in to continue.",
} = {}) {
  return async function verifyTokenMiddleware(req, res, next) {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader ? authHeader.split(" ")[1] : undefined;

      if (!token) {
        if (optional) {
          req.user = null;
          return next();
        }
        return res.status(401).send({ message });
      }

      const payload = await verifyJwt(token);
      if (!payload) {
        if (optional) {
          req.user = null;
          return next();
        }
        return res.status(401).send({ message: "Invalid or expired token." });
      }

      // Email is always read from the database, never trusted from the token.
      const user = await db
        .collection("user")
        .findOne({ _id: idFilter(String(payload.sub)) });
      if (!user?.email) {
        if (optional) {
          req.user = null;
          return next();
        }
        return res.status(401).send({ message });
      }

      req.user = toPublicUser(user);
      return next();
    } catch (err) {
      console.error(err);
      return res.status(500).send({ message: "Authentication check failed." });
    }
  };
}

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
      // Fake/seed numbers are never accepted — joins decide the count.
      volunteers: 0,
      creatorEmail: user.email,
      creatorName: user.name,
      createdAt: createdAt || new Date().toISOString(),
    };

    const result = await eventCollection.insertOne(event);
    res.send({
      acknowledged: result.acknowledged,
      insertedId: String(result.insertedId),
      event: await publicEvent({ ...event, _id: result.insertedId }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to create event" });
  }
}

// Sir-er /add-destination equivalent.
app.post(
  "/create-event",
  verifyToken({ message: "Please sign in to create an event." }),
  createEventHandler
);
app.post(
  "/events",
  verifyToken({ message: "Please sign in to create an event." }),
  createEventHandler
);

// ------------------------------------------------------------------ list
// Sir-er GET /destinations equivalent — verifyToken token thakle verify kore,
// anonymous visitor-er jonno optional.
app.get("/events", verifyToken({ optional: true }), async (req, res) => {
  try {
    // Upcoming only — passed drives live in the public /events/archived route.
    const today = new Date().toISOString().slice(0, 10);
    const events = await eventCollection
      .find({ date: { $gte: today } })
      .sort({ date: 1 })
      .toArray();
    res.send(await publicEvents(events));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load events" });
  }
});

// Public home: only upcoming events, nearest first, capped at 6.
app.get("/events/recent", verifyToken({ optional: true }), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 6);
    const today = new Date().toISOString().slice(0, 10);
    const events = await eventCollection
      .find({ date: { $gte: today } })
      .sort({ date: 1 })
      .limit(limit)
      .toArray();
    res.send(await publicEvents(events));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load recent events" });
  }
});

// Public archive: past drives, most recent first. `limit` is optional — the
// homepage asks for 6, the archive page leaves it off to get every event.
app.get("/events/archived", verifyToken({ optional: true }), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let query = eventCollection.find({ date: { $lt: today } }).sort({ date: -1 });
    if (req.query.limit !== undefined) {
      const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 24);
      query = query.limit(limit);
    }
    const events = await query.toArray();
    res.send(await publicEvents(events));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load archived events" });
  }
});

// Sir-er GET /destination/:id equivalent. Details are public, so verifyToken
// runs in optional mode: valid JWT thakle req.user set hoy, na hole-o data dey.
app.get("/events/:id", verifyToken({ optional: true }), async (req, res) => {
  try {
    const event = await eventCollection.findOne({ _id: idFilter(req.params.id) });
    if (!event) return res.status(404).send({ message: "Event not found." });
    res.send(await publicEvent(event));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load event" });
  }
});

// ------------------------------------------------------------------ join
app.post(
  "/events/:id/join",
  verifyToken({ message: "Please sign in to join an event." }),
  async (req, res) => {
    try {
      const user = req.user;
      const { id } = req.params;
      const event = await eventCollection.findOne({ _id: idFilter(id) });
      if (!event) return res.status(404).send({ message: "Event not found." });

      const today = new Date().toISOString().slice(0, 10);
      if (String(event.date ?? "") < today) {
        return res.status(400).send({ message: "This event has already ended." });
      }

      // The organiser may also take part as a volunteer — no block here.

      const existing = await joinCollection.findOne({
        eventId: id,
        userEmail: user.email,
      });
      if (existing) {
        return res.send({
          joined: false,
          alreadyJoined: true,
          volunteers: await realJoinCount(id),
        });
      }

      await joinCollection.insertOne({
        eventId: id,
        userEmail: user.email,
        joinedAt: new Date().toISOString(),
      });

      const count = await realJoinCount(id);
      await eventCollection.updateOne(
        { _id: idFilter(id) },
        { $set: { volunteers: count } }
      );

      res.send({
        joined: true,
        alreadyJoined: false,
        volunteers: count,
      });
    } catch (err) {
      console.error(err);
      res.status(500).send({ message: "Failed to join event" });
    }
  }
);

app.get("/joined-events", verifyToken({ message: "Please sign in to view joined events." }), async (req, res) => {
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
    res.send(await publicEvents(events.filter(Boolean)));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load joined events" });
  }
});

// ------------------------------------------------------------- my events
// Token-first route: the owner comes from the verified Bearer JWT / session,
// not from a URL parameter. Client sends `Authorization: Bearer <jwt>`.
app.get("/manage-events", verifyToken({ message: "Please sign in to view your events." }), async (req, res) => {
  try {
    const events = await eventCollection
      .find({ creatorEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(await publicEvents(events));
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load events" });
  }
});

// Kept for older clients that still pass the email in the path.
app.get("/manage-events/:email", verifyToken({ message: "Please sign in to view your events." }), async (req, res) => {
  try {
    const user = req.user;
    if (user.email !== String(req.params.email).toLowerCase()) {
      return res.status(403).send({ message: "You can only view your own events." });
    }

    const events = await eventCollection
      .find({ creatorEmail: user.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(await publicEvents(events));
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

app.put("/manage-events/:id", verifyToken({ message: "Please sign in to edit an event." }), async (req, res) => {
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
    res.send({ event: await publicEvent(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to update event" });
  }
});

app.delete("/manage-events/:id", verifyToken({ message: "Please sign in to delete an event." }), async (req, res) => {
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
