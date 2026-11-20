// Same structure as https://www.mtgo.com/player-rewards (captured Nov 2026).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function prpHtml(rows, lastUpdated = 'November 2, 2026') {
  return `<!DOCTYPE html><html><body class="news mtgo"><div class="site-content"><article class="basic-article container-page-fluid">
<h1 class="basic-article-title"><span>Player Rewards</span></h1>
<p>Player Reward Packs contain the following cards.</p>
<p>Last Updated: ${esc(lastUpdated)}<br>Effective Date: ${esc(lastUpdated)}</p>
<table><tbody><tr><td><strong>Card Name</strong></td><td><strong>Set</strong></td><td><strong>Treatment</strong></td><td><strong>Slots</strong></td></tr>
${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('\n')}
</tbody></table></article></div></body></html>`;
}
module.exports = { prpHtml };
