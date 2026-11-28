const express = require('express');
const users = require('../lib/users');

/**
 * Admin page (/admin, admins only): the users, their role, whether they see NFS content and
 * which sub-sites are shared with them. Plain forms; each change redirects back with a message.
 */
const router = express.Router();

const back = (req, res, type, message) => {
  req.session.flash = { type, message };
  res.redirect('/admin');
};
const handle = (fn, ok) => async (req, res, next) => {
  try {
    await fn(req);
    back(req, res, 'ok', typeof ok === 'function' ? ok(req) : ok);
  } catch (err) {
    if (err instanceof users.UserError) return back(req, res, 'error', err.message);
    next(err);
  }
};

router.get('/', async (req, res, next) => {
  try {
    const flash = req.session.flash || null;
    delete req.session.flash;
    res.render('admin', { title: 'Admin', list: await users.listUsers(), sites: users.SITES, roles: users.ROLES, owner: users.ownerName(), flash });
  } catch (err) {
    next(err);
  }
});

router.post('/users', handle((req) => users.createUser(req.body || {}), (req) => `Added ${req.body.username}.`));

router.post('/users/:name', handle((req) => users.updateUser(req.params.name, req.body || {}), (req) => `Saved ${req.params.name}.`));

router.post('/users/:name/password', handle((req) => users.setPassword(req.params.name, (req.body || {}).password), (req) => `New password set for ${req.params.name}.`));

router.post(
  '/users/:name/delete',
  handle(async (req) => {
    if (req.user && req.params.name.toLowerCase() === req.user.username.toLowerCase()) throw new users.UserError('You can’t delete yourself.');
    await users.deleteUser(req.params.name);
  }, (req) => `Deleted ${req.params.name}.`),
);

module.exports = { router };
