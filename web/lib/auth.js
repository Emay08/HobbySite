const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const users = require('./users');

/**
 * Sign-in. The owner's credentials live in environment variables (ADMIN_USERNAME /
 * ADMIN_PASSWORD_HASH), never in the DB; other users are in the `users` collection
 * (lib/users.js). Returns the username as stored, or null.
 */
// compared against when the username is unknown, so a wrong name takes as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

async function verifyCredentials(username, password) {
  const name = String(username || '');
  const pass = String(password || '');
  const expectedUser = process.env.ADMIN_USERNAME || '';
  const hash = process.env.ADMIN_PASSWORD_HASH || '';

  if (expectedUser && hash) {
    // Constant-time username comparison
    const a = Buffer.from(name);
    const b = Buffer.from(expectedUser);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return (await bcrypt.compare(pass, hash)) ? expectedUser : null;
  }

  const doc = users.isOwnerName(name) ? null : await users.findUser(name).catch(() => null);
  const ok = await bcrypt.compare(pass, (doc && doc.passwordHash) || DUMMY_HASH);
  return doc && ok ? doc.username : null;
}

/**
 * Runs on every request: turns the session's username into req.user (role, NFS, sub-sites),
 * read fresh so changes on the admin page apply at once. A deleted user is signed out.
 */
async function loadUser(req, res, next) {
  try {
    const name = req.session && req.session.user && req.session.user.username;
    let access = null;
    if (name) {
      if (name === (process.env.ADMIN_USERNAME || '')) access = users.ownerAccess();
      else access = users.accessFor(await users.findUser(name));
      if (!access) delete req.session.user;
    }
    req.user = access;
    res.locals.user = access;
    next();
  } catch (err) {
    next(err);
  }
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ error: 'Not logged in' });
  }
  req.session.returnTo = req.originalUrl;
  return res.redirect('/');
}

const forbidden = (req, res, message) =>
  req.accepts(['html', 'json']) === 'json' ? res.status(403).json({ error: message }) : res.status(403).render('error', { title: 'Not shared with you', message });

/** Only for users this sub-site is shared with (admins have them all). */
const requireSite = (site) => (req, res, next) => (req.user && req.user.sites.includes(site) ? next() : forbidden(req, res, 'This part of the site hasn’t been shared with you.'));

function requireAdmin(req, res, next) {
  return req.user && req.user.isAdmin ? next() : forbidden(req, res, 'Only admins can open this page.');
}

module.exports = { verifyCredentials, loadUser, requireLogin, requireSite, requireAdmin };
