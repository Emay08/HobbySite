/**
 * One-time spreadsheet import (Treasure Chest history + hand-kept trades).
 * Upload vault-import.json → review → confirm. Can be undone.
 */
const express = require('express');
const multer = require('multer');
const { getDb } = require('../lib/db');
const tc = require('../lib/tcHistory');
const sheet = require('../lib/sheetTrades');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
// the review form carries a field per entry that needs attention
const bigForm = express.urlencoded({ extended: false, limit: '2mb', parameterLimit: 10000 });

router.get('/import', async (req, res, next) => {
  try {
    const db = getDb();
    const [staged, done, meta, tcCount, snapshots] = await Promise.all([
      db.collection('import_staging').findOne({ _id: 'sheet' }),
      sheet.summary(db),
      db.collection('meta').findOne({ _id: 'tcHistoryRebuild' }),
      db.collection('tc_history').countDocuments({ sheetImportedAt: { $exists: true } }),
      db.collection('tc_snapshots').countDocuments(),
    ]);
    const preview = staged ? await sheet.preview(db, staged) : null;
    const flash = req.session.flash || null;
    delete req.session.flash;
    res.render('mtgo/import', {
      title: 'Spreadsheet import',
      staged,
      preview,
      showAll: req.query.all === '1',
      done,
      meta,
      tcCount,
      snapshots,
      flash,
      columns: sheet.COLUMN_LABELS,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/import/upload', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    try {
      let payload;
      try {
        payload = JSON.parse(req.file.buffer.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'That file is not valid JSON.' });
      }
      await sheet.stage(getDb(), payload, { filename: req.file.originalname });
      res.json({ ok: true, redirect: '/mtgo/import' });
    } catch (e) {
      if (e.expose) return res.status(400).json({ error: e.message });
      console.error('Import staging failed:', e);
      res.status(500).json({ error: `Import failed: ${e.message}` });
    }
  });
});

router.post('/import/confirm', bigForm, async (req, res, next) => {
  try {
    const db = getDb();
    const staged = await db.collection('import_staging').findOne({ _id: 'sheet' });
    if (!staged) {
      req.session.flash = { type: 'error', message: 'Nothing to import — upload the file again.' };
      return res.redirect(303, '/mtgo/import');
    }
    const fixes = {};
    const skips = new Set();
    for (const [k, v] of Object.entries(req.body || {})) {
      if (k.startsWith('fix:')) fixes[k.slice(4)] = String(v).slice(0, 150);
      if (k.startsWith('skip:')) skips.add(k.slice(5));
    }
    const prepared = staged.tc || [];
    const updates = await tc.storeSheetUpdates(db, prepared, { includeExcluded: req.body.includeCopied === '1' });
    const { problems } = await sheet.confirmTrades(db, staged, { fixes, skips });
    const stats = await sheet.syncSheetTrades(db);
    const rebuilt = await tc.rebuildContents(db);
    await db.collection('import_staging').deleteOne({ _id: 'sheet' });
    const parts = [
      `Imported ${updates} Treasure Chest updates`,
      rebuilt.ok ? `full contents rebuilt from the ${rebuilt.snapshotDate} page snapshot` : `contents not rebuilt yet: ${rebuilt.reason}`,
      `${stats.imported} spreadsheet trades added, ${stats.duplicates} skipped as GoatBots duplicates, ${stats.unresolved} still need a card name`,
    ];
    req.session.flash = { type: problems.length ? 'error' : 'ok', message: `${parts.join(' · ')}.${problems.length ? ' ' + problems.slice(0, 5).join(' ') : ''}` };
    res.redirect(303, '/mtgo/import');
  } catch (err) {
    next(err);
  }
});

router.post('/import/cancel', async (req, res, next) => {
  try {
    await getDb().collection('import_staging').deleteOne({ _id: 'sheet' });
    res.redirect(303, '/mtgo/import');
  } catch (err) {
    next(err);
  }
});

router.post('/import/fix', async (req, res, next) => {
  try {
    const r = await sheet.fixEntry(getDb(), String(req.body.id || ''), String(req.body.name || '').slice(0, 150), { skip: req.body.skip === '1' });
    if (!r.ok) req.session.flash = { type: 'error', message: r.message };
    const back = String(req.body.back || '');
    res.redirect(303, back.startsWith('/mtgo/') ? back : '/mtgo/import#unresolved');
  } catch (err) {
    next(err);
  }
});

router.post('/import/undo', async (req, res, next) => {
  try {
    if (req.body.confirm !== 'yes') {
      req.session.flash = { type: 'error', message: 'Tick the box to confirm the undo.' };
      return res.redirect(303, '/mtgo/import');
    }
    const r = await sheet.undo(getDb());
    req.session.flash = { type: 'ok', message: `Removed ${r.updates} spreadsheet Treasure Chest updates and ${r.trades} spreadsheet trades.` };
    res.redirect(303, '/mtgo/import');
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
