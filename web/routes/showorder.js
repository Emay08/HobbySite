const express = require('express');
const { getDb } = require('../lib/db');

/**
 * Show Order — recital running-order planner.
 *
 * All solving happens in the browser (public/showorder-*.js). The server only renders the
 * page and keeps one saved project: the data lists, the rules, the schedules found (each
 * with its locked dances), so work survives between visits and devices.
 */
const router = express.Router();

const COLLECTION = 'showorder';
const PROJECT_ID = 'project';
const MAX_BYTES = 2 * 1024 * 1024;

router.get('/', (req, res) => res.render('showorder/index', { title: 'Show order', section: 'showorder' }));

router.get('/api/project', async (req, res, next) => {
  try {
    const doc = await getDb().collection(COLLECTION).findOne({ _id: PROJECT_ID });
    if (!doc) return res.json({ project: null });
    const { _id, ...project } = doc;
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const isRows = (x) => Array.isArray(x) && x.length <= 20000 && x.every(isObj);

router.put('/api/project', express.json({ limit: MAX_BYTES }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const raw = b.raw || {};
    if (!isObj(raw) || !isRows(raw.dancers || []) || !isRows(raw.enrollments || []) || !isRows(raw.dances || [])) {
      return res.status(400).json({ error: 'raw must hold dancers, enrollments and dances lists' });
    }
    if (b.settings != null && !isObj(b.settings)) return res.status(400).json({ error: 'settings must be an object' });
    if (b.results != null && !(Array.isArray(b.results) && b.results.length <= 50 && b.results.every(isObj))) {
      return res.status(400).json({ error: 'results must be a list of schedules' });
    }
    const doc = {
      raw: { dancers: raw.dancers || [], enrollments: raw.enrollments || [], dances: raw.dances || [] },
      source: String(b.source || '').slice(0, 200),
      settings: b.settings || {},
      results: b.results || [],
      active: Number.isInteger(b.active) ? b.active : 0,
      updatedAt: new Date(),
    };
    await getDb().collection(COLLECTION).replaceOne({ _id: PROJECT_ID }, doc, { upsert: true });
    res.json({ ok: true, updatedAt: doc.updatedAt });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
