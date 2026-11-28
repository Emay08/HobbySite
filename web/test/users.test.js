const test = require('node:test');
const assert = require('node:assert');
const users = require('../lib/users');

test('what each role sees', () => {
  const u = users.accessFor({ username: 'sam', role: 'user', nfs: false, sites: ['swg', 'nope'] });
  assert.deepStrictEqual([u.isAdmin, u.nfs, u.sites], [false, false, ['swg']]);
  const a = users.accessFor({ username: 'kim', role: 'admin', nfs: false, sites: [] });
  assert.deepStrictEqual([a.isAdmin, a.nfs, a.sites], [true, true, users.SITE_IDS]);
  process.env.ADMIN_USERNAME = 'eric';
  const o = users.ownerAccess();
  assert.deepStrictEqual([o.username, o.owner, o.isAdmin], ['eric', true, true]);
  assert.ok(users.isOwnerName('ERIC'));
});

test('admin form values are cleaned', () => {
  assert.deepStrictEqual(users.cleanSettings({ role: 'root', nfs: 'on', sites: 'swg' }), { role: 'user', nfs: true, sites: ['swg'] });
  assert.deepStrictEqual(users.cleanSettings({ role: 'admin', sites: ['mtgo', 'x', 'showorder'] }), { role: 'admin', nfs: false, sites: ['mtgo', 'showorder'] });
  assert.strictEqual(users.cleanUsername(' ok.name-1 '), 'ok.name-1');
  assert.strictEqual(users.cleanUsername('no spaces'), null);
  assert.ok(users.passwordProblem('short'));
  assert.strictEqual(users.passwordProblem('long enough!'), null);
});
