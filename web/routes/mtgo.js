const express = require('express');
const multer = require('multer');
const { getDb } = require('../lib/db');
const { parseCollectionCsv } = require('../lib/csv');
const col = require('../lib/collection');
const search = require('../lib/search');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.csv$/i.test(file.originalname) || /csv|text\/plain|excel/.test(file.mimetype);
    cb(ok ? null : Object.assign(new Error('Please upload a .csv file.'), { status: 400, expose: true }), ok);
  },
});

const CATEGORY_LABELS = {
  reprint: 'Reprints',
  'treasure-chest': 'Treasure Chest',
  news: 'News',
};

// ---- Highlights front page -------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const category = CATEGORY_LABELS[req.query.category] ? req.query.category : null;
    const filter = category ? { category } : {};
    const db = getDb();
    const [highlights, monitors, summary, targetsHit, swapsReady] = await Promise.all([
      db.collection('highlights').find(filter).sort({ detectedAt: -1 }).limit(60).toArray(),
      db.collection('monitor_state').find({}, { projection: { seen: 0 } }).sort({ _id: 1 }).toArray(),
      col.getSummary(),
      db.collection('targets').countDocuments({ hit: true }),
      db.collection('swaps').countDocuments({ good: true }),
    ]);
    res.render('mtgo/index', {
      targetsHit,
      swapsReady,
      title: 'MTGO',
      highlights,
      monitors,
      summary,
      category,
      categories: CATEGORY_LABELS,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Collection browser ----------------------------------------------------
router.get('/collection', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').slice(0, 100);
    const set = String(req.query.set || '').slice(0, 10);
    const sort = ['value', 'price', 'name', 'qty'].includes(req.query.sort) ? req.query.sort : 'value';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 50;

    const [summary, topByPrice, bySet, byRarity, history, list] = await Promise.all([
      col.getSummary(),
      col.getTopCards({ limit: 15, by: 'price' }),
      col.getBreakdown('set'),
      col.getBreakdown('rarity'),
      col.getValueHistory(180),
      col.searchCards({ q, set, sort, page, pageSize }),
    ]);

    res.render('mtgo/collection', {
      title: 'Collection',
      summary,
      topByPrice,
      bySet: bySet.slice(0, 12),
      byRarity,
      history,
      list,
      query: { q, set, sort, page },
      pages: Math.max(1, Math.ceil(list.total / pageSize)),
    });
  } catch (err) {
    next(err);
  }
});

// ---- CSV upload --------------------------------------------------------------
router.get('/upload', async (req, res, next) => {
  try {
    const uploads = await getDb().collection('uploads').find().sort({ uploadedAt: -1 }).limit(10).toArray();
    res.render('mtgo/upload', { title: 'Update collection', uploads });
  } catch (err) {
    next(err);
  }
});

router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 10 MB.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    try {
      const { cards, warnings, rowCount } = parseCollectionCsv(req.file.buffer);
      if (cards.length === 0) return res.status(400).json({ error: 'No cards found in that file.' });
      const diff = await col.replaceCollection(cards, { filename: req.file.originalname });
      search.invalidate();
      const summary = await col.getSummary();
      res.json({
        ok: true,
        rowCount,
        uniqueCards: cards.length,
        totalCards: cards.reduce((s, c) => s + c.qty, 0),
        totalValue: summary.totalValue,
        unpriced: summary.unpriced,
        warnings: warnings.slice(0, 20),
        diff: {
          added: diff.added.length,
          removed: diff.removed.length,
          changed: diff.changed.length,
          sampleAdded: diff.added.slice(0, 10),
          sampleRemoved: diff.removed.slice(0, 10),
        },
        pending: diff.pending,
      });
    } catch (e) {
      if (e.expose) return res.status(e.status || 400).json({ error: e.message });
      console.error('Upload failed:', e);
      res.status(500).json({ error: `Upload failed: ${e.message}` });
    }
  });
});

module.exports = router;
