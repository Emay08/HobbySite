const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyCredentials } = require('../lib/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // behind the Cloudflare Worker every request comes from Cloudflare; count per real visitor
  keyGenerator: (req) => req.clientIp || req.ip,
  handler: (req, res) =>
    res.status(429).render('login', {
      title: 'Sign in',
      error: 'Too many attempts. Try again in 15 minutes.',
      username: '',
    }),
});

router.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/home');
  res.render('login', { title: 'Sign in', error: null, username: '' });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const ok = await verifyCredentials(username, password);
    if (!ok) {
      return res.status(401).render('login', {
        title: 'Sign in',
        error: 'Wrong username or password.',
        username: username || '',
      });
    }
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { username };
      const dest = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/home';
      req.session.save(() => res.redirect(dest));
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.redirect('/');
  });
});

module.exports = router;
