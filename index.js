import cors from "cors";
import "dotenv/config";
import express from "express";
import { MongoClient } from "mongodb";

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const mongoClient = await connectToMongoDB();
const db = mongoClient.db("sobarhaat");
const eventCollection = db.collection("events");

app.post("/create-event", async (req, res) => {
  const data = req.body;
  const result = await eventCollection.insertOne(data);
  res.send(result);
});

app.get("/", (req, res) => {
  res.send({ message: "Server is running fine!!" });
});

// EVENTS
app.post("/events", async (req, res) => {
  const data = req.body;
  const result = await eventCollection.insertOne(data);
  res.send(result);
});

// All events, nearest first — used by the public /events page.
app.get("/events", async (req, res) => {
  try {
    const events = await eventCollection.find({}).sort({ date: 1 }).toArray();
    res.send(events);
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
    res.send(events);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load recent events" });
  }
});

app.get("/manage-events/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const result = await eventCollection
      .find({ creatorEmail: email })
      .toArray();
    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to load events" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running at ${PORT}`);
});
