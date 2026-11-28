const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

/**
 * Users and what each one can see.
 *
 * The owner (ADMIN_USERNAME / ADMIN_PASSWORD_HASH in the environment) is always an admin with
 * every sub-site and NFS content, and can't be edited or locked out from the admin page.
 * Everyone else lives in the `users` collection, one doc per user:
 *   { _id: lower-case username, username, passwordHash, role: 'admin' | 'user',
 *     nfs: true | false, sites: ['mtgo', 'showorder', 'swg'], createdAt, updatedAt }
 * Admins (role 'admin') see every sub-site and NFS content and can open the admin page.
 */
const COLLECTION = 'users';
const ROLES = ['admin', 'user'];
const SITES = [
  { id: 'mtgo', label: 'MTGO Collection Manager', href: '/mtgo' },
  { id: 'showorder', label: 'Dance Recital Scheduler', href: '/showorder' },
  { id: 'swg', label: 'SWG tools (Ship Builder, Loot, Crafting)', href: '/swg' },
];
const SITE_IDS = SITES.map((s) => s.id);

const ownerName = () => process.env.ADMIN_USERNAME || '';
const isOwnerName = (name) => !!ownerName() && String(name || '').toLowerCase() === ownerName().toLowerCase();
const userKey = (name) => String(name || '').trim().toLowerCase();

/** 3–40 characters: letters, digits, . _ - */
function cleanUsername(s) {
  const v = String(s || '').trim();
  return /^[A-Za-z0-9._-]{3,40}$/.test(v) ? v : null;
}
const passwordProblem = (p) => (typeof p !== 'string' || p.length < 10 ? 'Passwords need at least 10 characters.' : p.length > 200 ? 'That password is too long.' : null);

/** What the rest of the site needs to know about the signed-in person. */
function accessFor(doc) {
  if (!doc) return null;
  const admin = doc.role === 'admin';
  return {
    username: doc.username,
    role: admin ? 'admin' : 'user',
    isAdmin: admin,
    owner: !!doc.owner,
    nfs: admin || doc.nfs !== false,
    sites: admin ? SITE_IDS.slice() : SITE_IDS.filter((s) => (doc.sites || []).includes(s)),
  };
}
const ownerAccess = () => accessFor({ username: ownerName(), role: 'admin', owner: true });

async function findUser(username) {
  if (!username) return null;
  return getDb().collection(COLLECTION).findOne({ _id: userKey(username) });
}

async function listUsers() {
  const docs = await getDb().collection(COLLECTION).find({}, { projection: { passwordHash: 0 } }).sort({ _id: 1 }).toArray();
  return docs;
}

/** settings: { role, nfs, sites } from a form or JSON; anything unknown is dropped. */
function cleanSettings(b) {
  const role = ROLES.includes(b.role) ? b.role : 'user';
  const raw = Array.isArray(b.sites) ? b.sites : b.sites == null ? [] : [b.sites];
  return {
    role,
    nfs: b.nfs === true || b.nfs === 'on' || b.nfs === '1' || b.nfs === 'true',
    sites: SITE_IDS.filter((s) => raw.includes(s)),
  };
}

async function createUser({ username, password, ...settings }) {
  const name = cleanUsername(username);
  if (!name) throw new UserError('Usernames are 3–40 letters, digits, dots, dashes or underscores.');
  if (isOwnerName(name)) throw new UserError('That name belongs to the owner account.');
  const bad = passwordProblem(password);
  if (bad) throw new UserError(bad);
  const now = new Date();
  const doc = { _id: userKey(name), username: name, passwordHash: await bcrypt.hash(password, 12), ...cleanSettings(settings), createdAt: now, updatedAt: now };
  try {
    await getDb().collection(COLLECTION).insertOne(doc);
  } catch (err) {
    if (err && err.code === 11000) throw new UserError('There is already a user called ' + name + '.');
    throw err;
  }
  return doc;
}

async function updateUser(username, settings) {
  if (isOwnerName(username)) throw new UserError('The owner account can’t be changed here.');
  const r = await getDb()
    .collection(COLLECTION)
    .updateOne({ _id: userKey(username) }, { $set: { ...cleanSettings(settings), updatedAt: new Date() } });
  if (!r.matchedCount) throw new UserError('No user called ' + username + '.');
}

async function setPassword(username, password) {
  if (isOwnerName(username)) throw new UserError('The owner’s password is set in the app settings (ADMIN_PASSWORD_HASH).');
  const bad = passwordProblem(password);
  if (bad) throw new UserError(bad);
  const r = await getDb()
    .collection(COLLECTION)
    .updateOne({ _id: userKey(username) }, { $set: { passwordHash: await bcrypt.hash(password, 12), updatedAt: new Date() } });
  if (!r.matchedCount) throw new UserError('No user called ' + username + '.');
}

async function deleteUser(username) {
  if (isOwnerName(username)) throw new UserError('The owner account can’t be deleted.');
  const r = await getDb().collection(COLLECTION).deleteOne({ _id: userKey(username) });
  if (!r.deletedCount) throw new UserError('No user called ' + username + '.');
}

class UserError extends Error {}

module.exports = { ROLES, SITES, SITE_IDS, ownerName, isOwnerName, cleanUsername, cleanSettings, passwordProblem, accessFor, ownerAccess, findUser, listUsers, createUser, updateUser, setPassword, deleteUser, UserError, COLLECTION };
