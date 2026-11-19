const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/**
 * Single-user auth: credentials live in environment variables, never in the DB.
 */
async function verifyCredentials(username, password) {
  const expectedUser = process.env.ADMIN_USERNAME || '';
  const hash = process.env.ADMIN_PASSWORD_HASH || '';
  if (!expectedUser || !hash) return false;

  // Constant-time username comparison
  const a = Buffer.from(String(username || ''));
  const b = Buffer.from(expectedUser);
  const userOk = a.length === b.length && crypto.timingSafeEqual(a, b);

  // Always run bcrypt so timing doesn't reveal whether the username matched
  const passOk = await bcrypt.compare(String(password || ''), hash);
  return userOk && passOk;
}

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ error: 'Not logged in' });
  }
  req.session.returnTo = req.originalUrl;
  return res.redirect('/');
}

module.exports = { verifyCredentials, requireLogin };
