import { createPlayerClient } from './player-client.js';
import { initializeRestoringPlayerSettings } from './player-settings.js';
const root = document.getElementById('player-settings');
if (root) {
  const query = new URLSearchParams(location.search), playerId = query.get('playerId'), leagueId = query.get('leagueId');
  const allowed = ['playerId', 'leagueId', 'viewerPlayerId', 'seasonId'];
  const invalid = [...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1);
  const status = document.getElementById('owner-status');
  if (!playerId?.trim() || !leagueId?.trim() || invalid) { if (status) status.textContent = 'Open your player details from a player profile in your league.'; }
  else {
    const viewerPlayerId = query.get('viewerPlayerId'), seasonId = query.get('seasonId');
    const back = document.getElementById('owner-back');
    if (back) { const search = new URLSearchParams({ leagueId, playerId, ...(viewerPlayerId ? { viewerPlayerId } : {}), ...(seasonId ? { seasonId } : {}) }); back.setAttribute('href', `/player?${search}`); }
    initializeRestoringPlayerSettings({ root, playerId, client: createPlayerClient({ baseUrl: document.body.dataset.apiBaseUrl || location.origin }),
      context: { leagueId, playerId, ...(viewerPlayerId ? { viewerPlayerId } : {}) } });
  }
}
