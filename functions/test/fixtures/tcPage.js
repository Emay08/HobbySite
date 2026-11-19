// Builds HTML in the same structure as the real Treasure Chest page (captured Nov 2026).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const cell = (v) => `<td>${v === '' || v == null ? '&nbsp;' : esc(v)}</td>`;

function tcHtml({
  lastUpdated = '11/9/2026 1 p.m. PT',
  effective = '11/10/2026 10 a.m. PT - check our Twitter, BlueSky, and Discord for exact timing',
  nextUpdate = 'December 9, 10 a.m.',
  date = 'November 10',
  slots = {},
  changelist = [],
  rdrOverride = {},
} = {}) {
  const slotHtml = Object.entries(slots)
    .map(([name, rows]) => {
      const total = rdrOverride[name] ?? rows.reduce((n, r) => n + r[3], 0);
      return `<h2>${esc(name)}</h2><p>This slot contains things.</p><p><em>Total RDR in this list – ${total}</em></p>
<table><tbody><tr><td><strong>Card Name</strong></td><td><strong>Set</strong></td><td><strong>Treatment</strong></td><td><strong>Slots</strong></td></tr>
${rows.map((r) => `<tr>${cell(r[0])}${cell(r[1])}${cell(r[2])}${cell(r[3])}</tr>`).join('\n')}
</tbody></table><p class="accordion"><a>Return to Top</a></p>`;
    })
    .join('\n');

  const body = `<article class="basic-article container-page-fluid">
<h1 class="basic-article-title "><span>Magic Online Treasure Chest Information</span><button></button></h1>
<p class="posted-on">Posted on Nov 11, 2024</p>
<p>Treasure Chests are a type of prize on <em>Magic Online</em>!</p>
<p>Last Updated: ${esc(lastUpdated)}<br>Effective Date: ${esc(effective)}</p>
<p>Next Update: ${esc(nextUpdate)}</p>
<h1 class="accordion">TREASURE CHEST CONTENTS - ${esc(date)}</h1>
<div class="scroll-container"><table class="table scroll"><thead><tr><th>&nbsp;</th><th>CURATED <br>LIST</th><th>MODERN <br>RARE/MYTHIC</th></tr></thead>
<tbody><tr><td>SLOT #1</td><td><strong>5%</strong></td><td>60%</td></tr></tbody></table></div>
<h1 class="accordion">VARIABLE PLAY POINTS</h1>
<table class="sticky"><thead><tr><th>Play Point Count</th><th>Relative Drop Rate</th></tr></thead><tbody><tr><td>10 Play Points</td><td>450</td></tr></tbody></table>
<h1 class="accordion">CURATED CARD LISTS - ${esc(date)}</h1>
<p>See above for a description of Relative Drop Rates.</p>
${slotHtml}
<h1 class="accordion">CHANGELIST - ${esc(date)}</h1>
<table><tbody><tr><td><strong>Card Name</strong></td><td><strong>Set</strong></td><td><strong>Treatment</strong></td><td><strong>Slots</strong></td><td><strong>Change&nbsp;</strong></td></tr>
${changelist.map((r) => `<tr>${cell(r[0])}${cell(r[1])}${cell(r[2])}${cell(r[3])}${cell(r[4])}</tr>`).join('\n')}
</tbody></table>
</article>`;

  // The real page also carries an escaped copy of the article in JSON-LD; it must be ignored.
  return `<!DOCTYPE html><html><head><script type="application/ld+json">{"articleBody":"${esc(body).replace(/\n/g, ' ')}"}</script></head>
<body class="news mtgo"><div class="site-content">${body}</div></body></html>`;
}

module.exports = { tcHtml };
