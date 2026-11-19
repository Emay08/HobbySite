require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function assetVersion(dir) {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(dir).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 10);
}
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const helmet = require('helmet');

const db = require('./lib/db');
const { requireLogin } = require('./lib/auth');
const authRoutes = require('./routes/auth');
const mtgoRoutes = require('./routes/mtgo');
const { router: listRoutes } = require('./routes/lists');
const { router: cardRoutes } = require('./routes/card');
const { router: tradeRoutes } = require('./routes/trades');
const { router: historyRoutes } = require('./routes/history');
const { router: importRoutes } = require('./routes/import');

const isProd = process.env.NODE_ENV === 'production';

async function main() {
  for (const v of ['MONGODB_URI', 'SESSION_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH']) {
    if (!process.env[v]) {
      console.error(`Missing required environment variable ${v}. See .env.example.`);
      process.exit(1);
    }
  }

  await db.connect();

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  if (isProd) app.set('trust proxy', 1); // Azure App Service terminates TLS
  app.locals.fmt = require('./lib/format');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https://api.scryfall.com', 'https://cards.scryfall.io'], // card art
          formAction: ["'self'"],
          upgradeInsecureRequests: isProd ? [] : null,
        },
      },
    })
  );
  // Small form bodies everywhere; the spreadsheet import's review form parses its own
  // (larger) body after the login check.
  const smallForms = express.urlencoded({ extended: false, limit: '20kb' });
  app.use((req, res, next) => (req.path === '/mtgo/import/confirm' ? next() : smallForms(req, res, next)));
  app.use(express.json({ limit: '20kb' }));
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '7d' : 0 }));
  // Links to /static files carry ?v=<hash of their contents>, so browsers fetch new copies
  // after each deploy instead of reusing week-old cached ones.
  app.locals.assetV = assetVersion(path.join(__dirname, 'public'));

  app.use(
    session({
      name: 'sid',
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: MongoStore.create({
        client: db.getClient(),
        dbName: process.env.MONGODB_DB || 'mtgo_manager',
        collectionName: 'sessions',
        ttl: 60 * 60 * 24 * 14,
      }),
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: isProd,
        maxAge: 1000 * 60 * 60 * 24 * 14,
      },
    })
  );

  // Save the session before redirecting. express-session otherwise sends the redirect's
  // headers first and saves afterwards, so the browser's next request can arrive before
  // the save and miss a flash message.
  app.use((req, res, next) => {
    const redirect = res.redirect.bind(res);
    res.redirect = (...args) => (req.session ? req.session.save(() => redirect(...args)) : redirect(...args));
    next();
  });

  // Make the logged-in user and current path available to every view
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.path = req.path;
    next();
  });

  app.get('/healthz', (req, res) => res.send('ok'));
  app.use('/', authRoutes);
  app.get('/home', requireLogin, (req, res) => res.render('home', { title: 'Home' }));
  app.use('/mtgo', requireLogin, mtgoRoutes);
  app.use('/mtgo', requireLogin, listRoutes);
  app.use('/mtgo', requireLogin, cardRoutes);
  app.use('/mtgo', requireLogin, tradeRoutes);
  app.use('/mtgo', requireLogin, historyRoutes);
  app.use('/mtgo', requireLogin, importRoutes);

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
  app.use((err, req, res, _next) => {
    console.error(err);
    const message = err.expose ? err.message : 'Something went wrong.';
    if (req.accepts(['html', 'json']) === 'json') return res.status(err.status || 500).json({ error: message });
    res.status(err.status || 500).render('error', { title: 'Error', message });
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
