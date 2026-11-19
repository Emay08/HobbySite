const { MongoClient } = require('mongodb');

let client;
let db;

async function connect() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'mtgo_manager');
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(d) {
  await Promise.all([
    d.collection('highlights').createIndex({ detectedAt: -1 }),
    d.collection('highlights').createIndex({ category: 1, detectedAt: -1 }),
    d.collection('collection').createIndex({ name: 1 }),
    d.collection('collection').createIndex({ set: 1 }),
    d.collection('value_history').createIndex({ date: 1 }, { unique: true }),
    d.collection('uploads').createIndex({ uploadedAt: -1 }),
  ]);
}

function getDb() {
  if (!db) throw new Error('Database not connected yet');
  return db;
}

function getClient() {
  return client;
}

module.exports = { connect, getDb, getClient };
