// Loads settings for local scripts: local.settings.json "Values" first, then .env.
const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  const { Values = {} } = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const [k, v] of Object.entries(Values)) if (process.env[k] === undefined) process.env[k] = String(v);
}
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {
  /* dotenv optional */
}
