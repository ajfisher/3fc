import type { PlayerAppearance, PlayerPerformance, ProjectionFreshness } from '@3fc/contracts';
import { bindPlayerAccount, PlayerClientError, type PlayerClient, type PlayerContext } from './player-client.js';
import { playerInitial } from './player-presentation.js';
import { mountClubCard } from './club-card.js';

type Period = 'last' | 'season' | 'career';
/** This controller retains only safe profile DTOs. Account details belong to the
 * separate settings page, and are never copied into profile/card state. */
export function mountPlayerProfile(root: HTMLElement, client: PlayerClient) {
  const document = root.ownerDocument, window = document.defaultView!;
  const required = <T extends HTMLElement>(id: string) => { const element = root.querySelector<T>(`#${id}`); if (!element) throw new Error(`Missing profile control: ${id}`); return element; };
  const status = required('player-status'), retry = required<HTMLButtonElement>('player-retry'), content = required('player-content');
  const name = required('player-name'), avatar = required('player-avatar'), season = required<HTMLSelectElement>('player-season');
  const stats = required('player-stats'), latest = required('player-latest'), log = required('player-history-list'), more = required<HTMLButtonElement>('player-history-more');
  const historyStatus = required('player-history-status'), access = required('player-access'), edit = required<HTMLAnchorElement>('player-edit');
  const signIn = root.querySelector<HTMLAnchorElement>('#player-signin');
  if (signIn) signIn.href = `/sign-in?${new URLSearchParams({ returnTo: window.location.pathname + window.location.search })}`;
  const query = new URLSearchParams(window.location.search);
  const context: PlayerContext = { leagueId: query.get('leagueId') ?? '', playerId: query.get('playerId') ?? '', ...(query.get('viewerPlayerId') ? { viewerPlayerId: query.get('viewerPlayerId')! } : {}) };
  let selectedSeason = query.get('seasonId') ?? undefined, period: Period = 'season', performance: PlayerPerformance | null = null;
  let generation = 0, controller = new AbortController(), disposed = false, suspended = false, locked = false, busy = false;
  let historyFreshness: ProjectionFreshness | null = null, portraitDataUrl: string | null = null;
  let sessionKey: string | null = null, cursor: string | null = null, accessCursor: string | null = null, matches: PlayerAppearance[] = [];
  const cleanup: Array<() => void> = [];
  const cardTrigger = root.querySelector<HTMLButtonElement>('#player-card');
  const gallery = root.querySelector<HTMLAnchorElement>('#player-achievements');
  const cardDialog = root.querySelector<HTMLDialogElement>('#club-card-dialog');
  const card = cardDialog ? mountClubCard({ dialog: cardDialog, client, getSnapshot: () => performance && !locked && !suspended && !disposed
    ? { context: { ...context }, performance, period, portraitDataUrl } : null }) : null;
  const account = bindPlayerAccount(document, client, () => retire('Sign in to view player profiles.'));
  function listen(target: EventTarget, event: string, handler: EventListener) { target.addEventListener(event, handler); cleanup.push(() => target.removeEventListener(event, handler)); }
  function node(tag: string, text?: string) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; }
  function say(message: string, error = false) { status.textContent = message; status.hidden = !message; status.setAttribute('role', error ? 'alert' : 'status'); }
  function active(id: number) { return id === generation && !disposed && !suspended && !locked; }
  function clear() {
    controller.abort(); generation++; card?.invalidate(); portraitDataUrl = null; performance = null;
    if (cardTrigger) cardTrigger.hidden = true; if (gallery) gallery.hidden = true; cursor = null; matches = []; historyFreshness = null; content.hidden = true;
    name.textContent = ''; avatar.replaceChildren(); stats.replaceChildren(); latest.replaceChildren(); log.replaceChildren(); access.replaceChildren(); edit.hidden = true; more.hidden = true;
  }
  function retire(message = 'Your sign-in changed. Reload this page before continuing.') { clear(); locked = true; retry.hidden = true; if (signIn) signIn.hidden = false; say(message, true); }
  async function verify(id: number) {
    const session = await client.session(controller.signal); if (!active(id)) return false;
    if (!session.authenticated || !session.session) { retire('Sign in to view player profiles.'); return false; }
    const key = JSON.stringify([session.session.sessionId, session.session.subject ?? session.session.email]);
    if (sessionKey && key !== sessionKey) { retire(); return false; }
    sessionKey = key; account.setAuthenticated(true); return true;
  }
  function updateUrl() {
    const url = new URL(window.location.href);
    if (selectedSeason) url.searchParams.set('seasonId', selectedSeason); else url.searchParams.delete('seasonId');
    if (context.viewerPlayerId) url.searchParams.set('viewerPlayerId', context.viewerPlayerId);
    window.history.replaceState(null, '', url);
  }
  function freshness(value: ProjectionFreshness): string {
    if (value.status === 'unavailable' || value.coverage === 'unknown') return 'Player history is temporarily unavailable. Totals will appear when it is ready.';
    if (value.status !== 'ready' || value.coverage !== 'complete') return 'History is updating. Any figures shown are confirmed so far and may change.';
    return '';
  }
  function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  function gameLink(value: PlayerAppearance) { const link = node('a', formatDate(value.kickoffAt)) as HTMLAnchorElement; link.href = `/games/${encodeURIComponent(value.gameId)}`; return link; }
  function appendMatch(parent: HTMLElement, value: PlayerAppearance, prominent = false) {
    const item = node(parent.tagName === 'OL' ? 'li' : 'div'); item.dataset.ui = 'player-match';
    const header = node('div'); header.append(gameLink(value), node('span', `${value.outcome === 'win' ? 'Win' : value.outcome === 'draw' ? 'Draw' : 'Loss'} · ${value.teamId[0].toUpperCase()}${value.teamId.slice(1)} team`));
    const contributions = node('p', `${value.goals} goals · ${value.assists} assists · ${value.ownGoals} own goals`);
    const team = prominent ? node('div') : node('p', `Team: ${value.scored} scored · ${value.conceded} conceded`);
    if (prominent) { team.className = 'player-team-totals'; for (const [label, total] of [['Scored', value.scored], ['Conceded', value.conceded]] as const) { const part = node('div'); part.append(node('strong', String(total)), node('span', label)); team.append(part); } }
    item.append(header, contributions, team); parent.append(item);
  }
  function renderLog() {
    log.replaceChildren(); matches.forEach(value => appendMatch(log, value));
    more.hidden = !cursor; more.disabled = busy;
    if (!matches.length && historyFreshness?.status === 'ready' && historyFreshness.coverage === 'complete') historyStatus.textContent = 'No completed matches in this view yet.';
    else if (!matches.length) historyStatus.textContent = historyFreshness ? freshness(historyFreshness) : 'Loading match history…';
    else if (matches.length) historyStatus.textContent = `${matches.length} completed ${matches.length === 1 ? 'match' : 'matches'} shown.`;
  }
  function render() {
    if (!performance) return;
    content.hidden = false; name.textContent = performance.player.displayName;
    root.querySelector('#player-league')!.textContent = performance.league.name;
    const title = period === 'last' ? 'Last game' : period === 'career' ? 'League career' : performance.seasons.find(s => s.seasonId === selectedSeason)?.name ?? 'Season';
    const heading = root.querySelector('#player-period-title'); if (heading) heading.textContent = title;
    season.replaceChildren();
    performance.seasons.forEach(value => { const option = node('option', value.name) as HTMLOptionElement; option.value = value.seasonId; season.append(option); });
    const seasonField = season.closest<HTMLElement>('.player-season-field'); if (seasonField) seasonField.hidden = period !== 'season';
    season.value = selectedSeason ?? ''; season.disabled = !performance.seasons.length || busy;
    avatar.replaceChildren(node('span', playerInitial(performance.player.displayName)));
    const values: Array<[string, string | number]> = [];
    if (period === 'last' && performance.latest) {
      const value = performance.latest; values.push(['Goals', value.goals], ['Assists', value.assists], ['Result', value.outcome === 'win' ? 'Win' : value.outcome === 'draw' ? 'Draw' : 'Loss'], ['Own goals', value.ownGoals]);
    } else if (period !== 'last') {
      const value = period === 'career' ? performance.career : performance.season;
      if (value) values.push(['Played', value.played], ['Goals', value.goals], ['Assists', value.assists], ['Wins', value.wins], ['Draws', value.draws], ['Own goals', value.ownGoals], ['Goals / game', value.goalsPerGame.toLocaleString(undefined, { maximumFractionDigits: 2 })]);
    }
    stats.replaceChildren();
    values.forEach(([label, value]) => { const cell = node('div'); cell.dataset.ui = 'player-stat'; cell.append(node('dt', label), node('dd', String(value))); stats.append(cell); });
    if (!values.length) stats.append(node('p', performance.freshness.status === 'ready' && performance.freshness.coverage === 'complete' ? 'No completed appearances yet.' : 'Statistics are not available yet.'));
    latest.replaceChildren(); if (performance.latest) appendMatch(latest, performance.latest, true); else latest.append(node('p', performance.freshness.status === 'ready' && performance.freshness.coverage === 'complete' ? 'Your story starts with the next match.' : 'Latest match is not available yet.'));
    edit.hidden = !performance.capabilities.editProfile;
    edit.href = `/player-settings?${new URLSearchParams({ playerId: performance.player.playerId, leagueId: context.leagueId, ...(selectedSeason ? { seasonId: selectedSeason } : {}), ...(context.viewerPlayerId ? { viewerPlayerId: context.viewerPlayerId } : {}) })}`;
    if (cardTrigger) { cardTrigger.hidden = !card; cardTrigger.disabled = false; }
    if (gallery) {
      gallery.hidden = !performance.capabilities.achievements;
      const scope = period === 'career' || !selectedSeason ? 'career' : 'season';
      gallery.href = `/achievements?${new URLSearchParams({ ...context, scope, ...(scope === 'season' && selectedSeason ? { seasonId: selectedSeason } : {}) })}`;
    }
    say(freshness(performance.freshness)); renderLog();
  }
  async function portrait(id: number) {
    if (!performance?.player.hasPortrait) return;
    try {
      const blob = await client.portrait(context, controller.signal); if (!blob || !active(id)) return;
      const data = await new Promise<string>((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('photo')); reader.readAsDataURL(blob); });
      if (!active(id) || !await verify(id)) return;
      portraitDataUrl = data;
      const image = document.createElement('img'); image.src = data; image.alt = `${performance!.player.displayName}'s portrait`; image.width = 128; image.height = 128; avatar.replaceChildren(image);
    } catch { /* Safe initials remain; the statistics stay available. */ }
  }
  async function loadHistory(id: number, append = false) {
    if (!performance || !active(id)) return;
    if (period === 'last') { historyFreshness = performance.freshness; matches = performance.latest ? [performance.latest] : []; cursor = null; renderLog(); return; }
    if (period === 'season' && !selectedSeason) { historyFreshness = performance.freshness; matches = []; cursor = null; renderLog(); return; }
    const page = await client.history(context, { ...(period === 'season' ? { seasonId: selectedSeason } : {}), ...(append && cursor ? { cursor } : {}) }, controller.signal);
    if (!active(id)) return;
    if (page.freshness.revision !== performance.freshness.revision || append && page.matches?.some(value => matches.some(existing => existing.gameId === value.gameId))) throw new PlayerClientError(409, 'history_changed', 'Player history changed. Refresh to see the latest statistics.');
    if (!await verify(id)) return;
    historyFreshness = page.freshness;
    if (page.matches === null) { cursor = null; matches = []; historyStatus.textContent = freshness(page.freshness); renderLog(); return; }
    matches = append ? [...matches, ...page.matches] : page.matches; cursor = page.cursor; renderLog();
  }
  async function discover(id: number, append = false) {
    const page = await client.access(context.leagueId, append && accessCursor ? { cursor: accessCursor } : {}, controller.signal);
    if (!active(id) || !await verify(id)) return;
    accessCursor = page.cursor;
    if (page.players.length || page.hasLeagueAcl) {
      if (page.players.length) context.viewerPlayerId = page.players[0].playerId; else delete context.viewerPlayerId;
      updateUrl(); await load(false); return;
    }
    access.replaceChildren(); say('Checking your league access.');
    if (page.cursor) {
      const button = node('button', 'Check more linked players') as HTMLButtonElement; button.type = 'button'; button.dataset.ui = 'button-secondary';
      button.addEventListener('click', () => { button.disabled = true; void discover(id, true).catch(error => fail(error, id)); }); access.append(button);
    } else say('No verified player membership or league access was found for this account.', true);
  }
  function fail(error: unknown, id: number) {
    if (!active(id)) return;
    if (error instanceof PlayerClientError && error.status === 401) { retire('Sign in to view player profiles.'); return; }
    if (error instanceof PlayerClientError && error.status === 403) { clear(); say(error.message, true); retry.hidden = false; return; }
    if (error instanceof PlayerClientError && error.status === 409) { clear(); say('Player history changed. Refresh to load a consistent view.', true); retry.hidden = false; return; }
    say(error instanceof PlayerClientError ? error.message : 'Player details could not be loaded. Try again.', true); retry.hidden = false;
  }
  async function load(allowDiscovery = true) {
    if (disposed || suspended || locked) return;
    clear(); controller = new AbortController(); const id = generation; busy = true; retry.hidden = true; if (signIn) signIn.hidden = true; say('Loading player profile…');
    try {
      if (!context.leagueId.trim() || !context.playerId.trim()) throw new PlayerClientError(400, 'invalid_link', 'Open a player from their league or match.');
      if (!await verify(id)) return;
      let result: PlayerPerformance;
      try { result = await client.performance({ ...context, ...(selectedSeason ? { seasonId: selectedSeason } : {}) }, controller.signal); }
      catch (error) { if (allowDiscovery && error instanceof PlayerClientError && error.status === 403) { await discover(id); return; } throw error; }
      if (!active(id) || !await verify(id)) return;
      performance = result; context.playerId = result.player.playerId; selectedSeason = result.selectedSeasonId ?? undefined; updateUrl(); render();
      await loadHistory(id); if (!active(id)) return; void portrait(id);
    } catch (error) { fail(error, id); }
    finally { if (active(id)) { busy = false; more.disabled = false; season.disabled = !performance?.seasons.length; } }
  }
  if (cardTrigger && card) listen(cardTrigger, 'click', () => { void card.open(cardTrigger); });
  listen(retry, 'click', () => { void load(); });
  listen(season, 'change', () => { selectedSeason = season.value || undefined; updateUrl(); void load(); });
  listen(required('player-period'), 'change', event => {
    const input = event.target as HTMLInputElement; if (!['last', 'season', 'career'].includes(input.value)) return;
    period = input.value as Period; void load();
  });
  listen(more, 'click', () => {
    if (busy || !cursor || !performance || locked) return; busy = true; more.disabled = true; const id = generation;
    void verify(id).then(async ok => { if (ok) await loadHistory(id, true); }).catch(error => fail(error, id)).finally(() => { if (active(id)) { busy = false; more.disabled = false; } });
  });
  listen(window, 'threefc:player-proof-cleared', () => retire());
  listen(window, 'threefc:player-proof-invalidated', () => retire());
  listen(window, 'pagehide', () => { clear(); suspended = true; });
  listen(window, 'pageshow', event => { if ((event as PageTransitionEvent).persisted && !disposed && !locked) { suspended = false; void load(); } });
  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'visible' && !cardDialog?.open && !busy && !locked && !disposed && !suspended) void load(); });
  const ready = load();
  function destroy() { disposed = true; clear(); card?.dispose(); account.destroy(); cleanup.forEach(fn => fn()); }
  return { ready, destroy, dispose: destroy };
}
export const mount = mountPlayerProfile;
