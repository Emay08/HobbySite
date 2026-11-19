const { MongoClient } = require('mongodb');

// Reused across invocations while the Functions host instance stays warm.
let clientPromise;

async function getDb() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 }).connect();
  }
  try {
    const client = await clientPromise;
    return client.db(process.env.MONGODB_DB || 'mtgo_manager');
  } catch (err) {
    clientPromise = undefined; // allow a retry on the next invocation
    throw err;
  }
}

async function close() {
  if (clientPromise) {
    const c = await clientPromise.catch(() => null);
    clientPromise = undefined;
    if (c) await c.close();
  }
}

module.exports = { getDb, close };
