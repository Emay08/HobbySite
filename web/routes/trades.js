const express = require('express');
const multer = require('multer');
const { getDb } = require('../lib/db');
const { parseGoatbotsHistory, importGoatbotsHistory } = require('../lib/goatbotsTrades');
const { reconcile, resolveManually, dismiss, localDate } = require('../lib/reconcile');
const sheet = require('../lib/sheetTrades');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PAGE_SIZE = 25;

router.get('/trades', async (req, res, next) => {
  try {
    const db = getDb();
    const q = String(req.query.q || '').trim().slice(0, 80);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = q ? { 'items.name': { $regex: escapeRegex(q), $options: 'i' } } : {};
    const coll = db.collection('gb_trades');
    const pendingFilter = { status: 'open', ...(q ? { nameLower: { $regex: escapeRegex(q.toLowerCase()) } } : {}) };
    const [trades, total, totals, imports, manual, sheetCount, pending, pendingCount] = await Promise.all([
      coll.find(filter).sort({ at: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).toArray(),
      coll.countDocuments(filter),
      coll
        .aggregate([
          { $group: { _id: null, n: { $sum: 1 }, got: { $sum: '$getValue' }, gave: { $sum: '$giveValue' }, first: { $min: '$at' }, last: { $max: '$at' } } },
        ])
        .toArray(),
      db.collection('trade_imports').find().sort({ importedAt: -1 }).limit(8).toArray(),
      db.collection('trades').countDocuments({ source: { $nin: ['goatbots', 'sheet'] } }),
      db.collection('trades').countDocuments({ source: 'sheet' }),
      db.collection('pending_changes').find(pendingFilter).sort({ windowEnd: -1, name: 1 }).limit(300).toArray(),
      db.collection('pending_changes').countDocuments(pendingFilter),
    ]);
    const prices = new Map(
      (await db.collection('prices').find({ _id: { $in: pending.map((p) => p.mtgoId) } }, { projection: { price: 1 } }).toArray()).map((x) => [x._id, x.price])
    );
    for (const p of pending) {
      p.price = prices.get(p.mtgoId) ?? null;
      p.minDate = p.windowStart ? localDate(p.windowStart) : '';
      p.maxDate = localDate(p.windowEnd);
    }
    const flash = req.session.flash || null;
    delete req.session.flash;
    res.render('mtgo/trades', {
      title: 'Trades',
      trades,
      total,
      totals: totals[0] || null,
      imports,
      manual,
      sheetCount,
      pending,
      pendingCount,
      flash,
      query: { q, page },
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/trades/upload', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    try {
      const parsed = parseGoatbotsHistory(req.file.buffer);
      const summary = await importGoatbotsHistory(getDb(), parsed, { filename: req.file.originalname });
      const rec = await reconcile(getDb());
      const stillOpen = await getDb().collection('pending_changes').countDocuments({ status: 'open' });
      // older GoatBots histories can reveal more spreadsheet duplicates and narrow their dates
      const before = await getDb().collection('trades').countDocuments({ source: 'sheet' });
      const sheetStats = await sheet.syncSheetTrades(getDb());
      const sheetRemoved = sheetStats ? Math.max(0, before - sheetStats.imported) : 0;
      res.json({ ok: true, ...summary, pendingResolved: rec.resolved, pendingOpen: stillOpen, sheetRemoved });
    } catch (e) {
      if (e.expose) return res.status(e.status || 400).json({ error: e.message });
      console.error('Trade import failed:', e);
      res.status(500).json({ error: `Import failed: ${e.message}` });
    }
  });
});

// ---------------------------------------------------------------- unconfirmed changes

const back = (req) => (typeof req.body.back === 'string' && req.body.back.startsWith('/mtgo/') ? req.body.back : '/mtgo/trades#unconfirmed');

router.post('/trades/pending/:id/resolve', async (req, res, next) => {
  try {
    const n = (v, max) => {
      if (String(v ?? '').trim() === '') return null;
      const x = Number(String(v).replace(',', '.'));
      return Number.isFinite(x) && x >= 0 && x <= max ? x : null;
    };
    const r = await resolveManually(getDb(), req.params.id, {
      qty: n(req.body.qty, 10000),
      price: n(req.body.price, 100000),
      date: req.body.date,
      counterparty: String(req.body.counterparty || '').trim().slice(0, 80),
      note: String(req.body.note || '').trim().slice(0, 200),
    });
    req.session.flash = r
      ? { type: 'ok', message: r.remaining ? `Saved; ${r.remaining} still unconfirmed.` : 'Saved to your trade history.' }
      : { type: 'error', message: 'That entry was already resolved.' };
    res.redirect(303, back(req));
  } catch (err) {
    next(err);
  }
});

router.post('/trades/pending/dismiss', async (req, res, next) => {
  try {
    const ids = [].concat(req.body.ids || req.body.id || []);
    const n = await dismiss(getDb(), ids, String(req.body.reason || '').slice(0, 80));
    req.session.flash = { type: 'ok', message: `Dismissed ${n} unconfirmed ${n === 1 ? 'change' : 'changes'}.` };
    res.redirect(303, back(req));
  } catch (err) {
    next(err);
  }
});

/** Dismisses every open entry (optionally only those from one collection upload). */
router.post('/trades/pending/dismiss-all', async (req, res, next) => {
  try {
    if (req.body.confirm !== 'yes') {
      req.session.flash = { type: 'error', message: 'Tick the box to confirm dismissing everything.' };
      return res.redirect(303, '/mtgo/trades#unconfirmed');
    }
    const r = await getDb()
      .collection('pending_changes')
      .updateMany({ status: 'open' }, { $set: { status: 'dismissed', reason: 'dismissed all', resolvedAt: new Date() } });
    req.session.flash = { type: 'ok', message: `Dismissed all ${r.modifiedCount} unconfirmed changes.` };
    res.redirect(303, '/mtgo/trades#unconfirmed');
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
