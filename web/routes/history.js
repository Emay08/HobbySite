const express = require('express');
const { getDb } = require('../lib/db');
const tc = require('../lib/tcHistory');
const chest = require('../lib/chest');

const router = express.Router();

/**
 * Rebuilds the full chest contents when a newer page snapshot exists than the one last
 * used (or contents are missing). Cheap: a few dozen documents.
 */
async function rebuildIfStale(db) {
  const [snap, meta, missing] = await Promise.all([
    db.collection('tc_snapshots').find({}, { projection: { _id: 1 } }).sort({ takenAt: -1 }).limit(1).next(),
    db.collection('meta').findOne({ _id: 'tcHistoryRebuild' }),
    db.collection('tc_history').countDocuments({ 'contents.0': { $exists: false } }),
  ]);
  if (!snap || !missing) return null;
  if (meta && String(meta.snapshotId) === String(snap._id) && meta.at > new Date(Date.now() - 60000)) return null;
  return tc.rebuildContents(db);
}

router.get('/tc', async (req, res, next) => {
  try {
    const db = getDb();
    await rebuildIfStale(db);
    const [updates, meta, snapshots] = await Promise.all([
      tc.listUpdates(db),
      db.collection('meta').findOne({ _id: 'tcHistoryRebuild' }),
      db.collection('tc_snapshots').countDocuments(),
    ]);
    const flash = req.session.flash || null;
    delete req.session.flash;
    res.render('mtgo/tchistory', { title: 'Treasure Chest history', updates, meta, snapshots, flash });
  } catch (err) {
    next(err);
  }
});

router.get('/chest', async (req, res, next) => {
  try {
    const db = getDb();
    const c = await chest.currentChest(db);
    const flash = req.session.flash || null;
    delete req.session.flash;
    res.render('mtgo/chest', { title: 'Treasure Chest', c, officialUrl: chest.OFFICIAL_URL, flash });
  } catch (err) {
    next(err);
  }
});

router.post('/tc/rebuild', async (req, res, next) => {
  try {
    const r = await tc.rebuildContents(getDb());
    req.session.flash = r.ok
      ? { type: 'ok', message: `Rebuilt the contents of ${r.rebuilt} updates from the ${r.snapshotDate} page snapshot (${r.issues} changelist rows disagree).` }
      : { type: 'error', message: r.reason };
    res.redirect(303, '/mtgo/tc');
  } catch (err) {
    next(err);
  }
});

router.get('/tc/:date', async (req, res, next) => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(404).render('error', { title: 'Not found', message: 'No such update.' });
    const db = getDb();
    const u = await tc.getUpdate(db, req.params.date);
    if (!u) return res.status(404).render('error', { title: 'Not found', message: `No Treasure Chest update recorded for ${req.params.date}.` });
    const owned = new Map(
      (await db.collection('collection').aggregate([{ $group: { _id: { $toLower: '$name' }, qty: { $sum: '$qty' } } }]).toArray()).map((o) => [o._id, o.qty])
    );
    res.render('mtgo/tcupdate', { title: `Treasure Chest ${u.date}`, u, owned, isProduct: tc.isProduct });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, rebuildIfStale };
