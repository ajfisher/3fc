import { ACHIEVEMENT_CONDITIONS, ACHIEVEMENT_DEFINITIONS, COMMON_MILESTONES, RARE_MILESTONES, milestoneThreshold, type AchievementId, type AchievementProgress, type AchievementScopeContext, type AchievementUnlock, type PlayerAchievements, type PlayerPerformance } from '@3fc/contracts';
import { bindPlayerAccount, PlayerClientError, playerHref, type PlayerClient, type PlayerContext } from './player-client.js';
import { renderBadge } from './achievement-art.js';

const definitions = new Map<AchievementId, typeof ACHIEVEMENT_DEFINITIONS[number]>(ACHIEVEMENT_DEFINITIONS.map(d => [d.id, d]));
export function achievementNotes(id: AchievementId): string[] {
  const notes = ['Completed matches and eligible recorded appearances count. More than one achievement can be earned from the same action.'];
  if (['goal', 'assist', 'own-goal'].includes(id)) notes.push('Each credited event counts. Own goals never count as scored goals.');
  if (['played', 'wins', 'draw', 'defence', 'desperate-defence', 'lockdown', 'comeback-crew', 'unbeaten-run'].includes(id)) notes.push('Team membership on the eligible final roster determines participation, including eligible late assignments. Minutes played are not inferred.');
  if (['wins', 'draw', 'played'].includes(id)) notes.push('Count one qualifying occurrence per completed match.');
  if (id === 'defence') notes.push(`Each qualifying third counts. Concede no goals in that third and start less than ${ACHIEVEMENT_CONDITIONS.defenceDeficitExclusive} conceded goals behind either opponent. For example, Red 3 / Blue 1 / Yellow 1 excludes Red.`);
  if (id === 'desperate-defence') notes.push('Your team must lead outright when the final third starts, concede no goals in that third, and finish as outright winners. Count once per match.');
  if (['momentum-play', 'clutch', 'hail-mary'].includes(id)) notes.push(`The closing window starts ${ACHIEVEMENT_CONDITIONS.closingSecondsBeforeRegulationEnd} seconds before regulation ends and includes stoppage until that third finishes.`);
  if (['speedy', 'message-sent'].includes(id)) notes.push(`The opening window is 00:00 up to, but not including, 02:00 (${ACHIEVEMENT_CONDITIONS.openingSecondsExclusive} seconds).`);
  if (['momentum-play', 'clutch', 'hail-mary', 'speedy', 'message-sent'].includes(id)) notes.push('Each qualifying goal counts. Goals entered after match completion do not qualify; reliable recorded timing is required.');
  if (id === 'hail-mary') notes.push('The goal must change losing or drawing into an outright lead, and the team must still win outright at the end of the match.');
  if (['defence', 'desperate-defence', 'comeback-crew', 'hail-mary'].includes(id)) notes.push('The recorded timeline must establish the relevant score and lead changes. Unknown timing can leave this achievement unassessable.');
  if (['hat-trick', 'master-provider', 'double-threat', 'triple-threat', 'lockdown', 'comeback-crew', 'team-engine'].includes(id)) notes.push('Earn at most one qualifying occurrence per match, even when you exceed the requirement.');
  if (['triple-threat', 'team-engine'].includes(id)) notes.push('Reliable third attribution is required. Goals entered after match completion cannot establish a qualifying third.');
  if (id === 'comeback-crew') notes.push('Start the final third outside first place, including outside a shared first, then finish as outright winners. The whole eligible team earns it.');
  const streak = ACHIEVEMENT_CONDITIONS.streakAppearances[id as keyof typeof ACHIEVEMENT_CONDITIONS.streakAppearances];
  if (streak) notes.push(`Build ${streak} consecutive qualifying personal appearances. Missed fixtures do not break a run. Reset after earning it or breaking the condition; career runs cross seasons, while season runs start afresh.`);
  return notes;
}
export function achievementProgressLabel(progress: AchievementProgress | null | undefined): string {
  if (!progress) return 'Progress unavailable';
  const count = progress.assessability === 'partial' ? `At least ${progress.count} confirmed` : `${progress.count} confirmed`;
  return `${count} · Next milestone ${progress.nextThreshold}${progress.assessability === 'partial' ? ' · History incomplete' : ''}`;
}
export function parseGalleryLocation(url: URL): { context: PlayerContext | null; seasonId?: string; career: boolean; achievementId?: AchievementId } {
  const allowed = ['leagueId', 'playerId', 'seasonId', 'viewerPlayerId', 'scope', 'achievementId'];
  if (url.hash) throw new PlayerClientError(400, 'invalid_link', 'Open achievements from a player profile or the collection.');
  for (const [key, value] of url.searchParams) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1 || !value.trim() || /[\\\u0000-\u001f\u007f]/u.test(value)) throw new PlayerClientError(400, 'invalid_link', 'Check the achievement link and try again.');
  const leagueId = url.searchParams.get('leagueId'), playerId = url.searchParams.get('playerId'), seasonId = url.searchParams.get('seasonId'), scope = url.searchParams.get('scope'), viewerPlayerId = url.searchParams.get('viewerPlayerId'), id = url.searchParams.get('achievementId');
  if (Boolean(leagueId) !== Boolean(playerId) || !leagueId && (scope || seasonId || viewerPlayerId) || scope && !['season', 'career'].includes(scope) || scope === 'career' && seasonId || id && !definitions.has(id as AchievementId)) throw new PlayerClientError(400, 'invalid_link', 'Check the achievement link and try again.');
  return { context: leagueId && playerId ? { leagueId, playerId, ...(viewerPlayerId ? { viewerPlayerId } : {}) } : null, ...(seasonId ? { seasonId } : {}), career: scope === 'career', ...(id ? { achievementId: id as AchievementId } : {}) };
}
export function mountAchievementGallery(root: HTMLElement, client: PlayerClient) {
  const document = root.ownerDocument, window = document.defaultView!;
  const get = <T extends HTMLElement>(id: string) => { const found = root.querySelector<T>(`#${id}`); if (!found) throw new Error(`Missing gallery control: ${id}`); return found; };
  const status = get('achievements-status'), retry = get<HTMLButtonElement>('achievements-retry'), signin = get<HTMLAnchorElement>('achievements-signin'), content = get('achievements-content'), access = get('achievements-access');
  const search = get<HTMLInputElement>('achievement-search'), rarity = get<HTMLSelectElement>('achievement-rarity'), earned = get<HTMLSelectElement>('achievement-earned'), season = get<HTMLSelectElement>('achievements-season');
  const grid = get('achievement-grid'), empty = get('achievement-empty'), count = get('achievement-count'), scopeControl = get('achievements-scope');
  const dialog = get<HTMLDialogElement>('achievement-detail'), detailMore = get<HTMLButtonElement>('achievement-detail-more'), detailStatus = get('achievement-detail-status');
  let parsed: ReturnType<typeof parseGalleryLocation> | null = null, parseError: unknown;
  try { parsed = parseGalleryLocation(new URL(window.location.href)); } catch (error) { parseError = error; }
  const context = parsed?.context ?? null;
  let selectedSeason = parsed?.seasonId, career = parsed?.career ?? false, selected: AchievementId | null = null;
  let performance: PlayerPerformance | null = null, achievements: PlayerAchievements | null = null, loaded = false;
  let generation = 0, abort = new AbortController(), disposed = false, suspended = false, locked = false, sessionKey: string | null = null;
  let awards: AchievementUnlock[] = [], awardsStarted = false, awardsComplete = false, awardsCursor: string | null = null, awardsBusy = false, accessCursor: string | null = null;
  let trigger: HTMLElement | null = null, restoreFocus = true;
  const cleanup: Array<() => void> = [];
  const account = bindPlayerAccount(document, client, () => retire('Sign in to explore achievements.'));
  function listen(target: EventTarget, event: string, handler: EventListener) { target.addEventListener(event, handler); cleanup.push(() => target.removeEventListener(event, handler)); }
  function node(tag: string, text?: string) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; }
  function say(message: string, error = false) { status.textContent = message; status.hidden = !message; status.setAttribute('role', error ? 'alert' : 'status'); }
  function active(id: number) { return !disposed && !locked && !suspended && generation === id; }
  function scope(): AchievementScopeContext | null { return career ? { scope: 'career', seasonId: null } : selectedSeason ? { scope: 'season', seasonId: selectedSeason } : null; }
  function syncUrl() {
    const url = new URL(window.location.href);
    if (context) {
      url.searchParams.set('playerId', context.playerId); if (context.viewerPlayerId) url.searchParams.set('viewerPlayerId', context.viewerPlayerId); else url.searchParams.delete('viewerPlayerId');
      url.searchParams.set('scope', career ? 'career' : 'season'); if (!career && selectedSeason) url.searchParams.set('seasonId', selectedSeason); else url.searchParams.delete('seasonId');
    }
    if (selected) url.searchParams.set('achievementId', selected); else url.searchParams.delete('achievementId');
    window.history.replaceState(null, '', url);
  }
  function closeDetail(focus = true) {
    restoreFocus = focus; selected = null;
    if (dialog.open) dialog.close();
    get('achievement-detail-personal').hidden = true; get('achievement-detail-unlocks').replaceChildren();
  }
  function clear() {
    abort.abort(); generation++; loaded = false; performance = null; achievements = null; awards = []; awardsCursor = null; awardsStarted = false; awardsComplete = false; awardsBusy = false;
    closeDetail(false); grid.replaceChildren(); content.hidden = true; access.replaceChildren(); get('achievements-player').textContent = ''; get('achievements-context').textContent = '';
    for (const id of ['achievement-detail-progress', 'achievement-detail-first', 'achievement-detail-highest', 'achievement-detail-status']) get(id).textContent = '';
  }
  function retire(message = 'Your sign-in changed. Sign in again to continue.') { clear(); locked = true; retry.hidden = true; signin.hidden = false; say(message, true); }
  async function verify(id: number) {
    const result = await client.session(abort.signal); if (!active(id)) return false;
    if (!result.authenticated || !result.session) { retire('Sign in to explore achievements.'); return false; }
    const key = JSON.stringify([result.session.sessionId, result.session.subject ?? result.session.email]);
    if (sessionKey && key !== sessionKey) { retire(); return false; }
    sessionKey = key; account.setAuthenticated(true); return true;
  }
  function personalAvailable() { return Boolean(achievements?.progress && achievements.freshness.status !== 'unavailable' && achievements.freshness.coverage !== 'unknown'); }
  function state(id: AchievementId): AchievementProgress | undefined {
    if (!personalAvailable()) return undefined;
    const progress = achievements?.progress?.find(p => p.achievementId === id);
    return progress && (achievements!.freshness.status !== 'ready' || achievements!.freshness.coverage !== 'complete')
      ? { ...progress, assessability: 'partial' } : progress;
  }
  function renderGrid() {
    const query = search.value.trim().toLocaleLowerCase();
    const shown = ACHIEVEMENT_DEFINITIONS.filter(d => (rarity.value === 'All' || rarity.value === d.rarity)
      && (!query || `${d.name} ${d.rule}`.toLocaleLowerCase().includes(query))
      && (!context || earned.value === 'all' || (earned.value === 'earned' ? Boolean(state(d.id)?.highest) : state(d.id)?.assessability === 'complete' && !state(d.id)?.highest)));
    grid.replaceChildren();
    shown.forEach(def => {
      const progress = state(def.id), tile = node('article'); tile.className = 'achievement-tile'; tile.dataset.badge = def.id;
      const button = node('button') as HTMLButtonElement; button.type = 'button'; button.id = `achievement-open-${def.id}`; button.className = 'achievement-art-button'; button.setAttribute('aria-label', `How to unlock ${def.name}`);
      button.innerHTML = renderBadge(def.id, progress?.highest?.ordinal ?? 0); button.addEventListener('click', () => openDetail(def.id, button));
      const copy = node('div'); copy.className = 'achievement-tile-copy'; const rank = node('span', def.rarity); rank.className = `achievement-rarity ${def.rarity.toLowerCase()}`;
      copy.append(rank, node('h2', def.name), node('p', def.rule));
      if (context) { const note = node('p', progress?.highest ? `Earned · ${progress.highest.ordinal} ${progress.highest.ordinal === 1 ? 'star' : 'stars'}` : progress?.assessability === 'complete' ? 'To unlock' : 'Unlock not confirmed'); note.className = 'achievement-tile-progress'; copy.append(note, node('p', achievementProgressLabel(progress))); }
      tile.append(button, copy); grid.append(tile);
    });
    const uncertain = context && (!personalAvailable() || achievements!.freshness.status !== 'ready' || achievements!.freshness.coverage !== 'complete' || achievements!.progress!.some(p => p.assessability === 'partial'));
    count.textContent = `${shown.length} ${shown.length === 1 ? 'achievement' : 'achievements'}${earned.value === 'to-unlock' && uncertain ? ' · Unconfirmed achievements remain in All' : ''}`; empty.hidden = shown.length > 0;
  }
  function renderHeader() {
    get('achievements-player').textContent = performance?.player.displayName ?? 'Achievement collection';
    get('achievements-context').textContent = performance ? `${performance.league.name} · ${career ? 'League career' : performance.seasons.find(s => s.seasonId === selectedSeason)?.name ?? 'Season'}` : 'Explore all 23 achievements and how to unlock them.';
    get('achievements-personal-controls').hidden = !context; get('achievement-earned-field').hidden = !context; get('achievements-season-field').hidden = !context || career;
    const back = get<HTMLAnchorElement>('achievements-back'); back.hidden = !context; if (context) back.href = playerHref(context, selectedSeason);
    season.replaceChildren(); performance?.seasons.forEach(s => { const option = node('option', s.name) as HTMLOptionElement; option.value = s.seasonId; season.append(option); }); season.value = selectedSeason ?? ''; season.disabled = !performance?.seasons.length;
    scopeControl.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.checked = input.value === (career ? 'career' : 'season'); });
  }
  function date(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)); }
  function renderAwards() {
    if (!selected) return;
    const list = get('achievement-detail-unlocks'); list.replaceChildren();
    const matches = awards.filter(a => a.achievementId === selected);
    matches.forEach(a => { const row = node('li'), link = node('a', date(a.earnedAt)) as HTMLAnchorElement; link.href = `/games/${encodeURIComponent(a.gameId)}`; row.append(node('span', `★ ${a.ordinal} · ${a.threshold} qualifying ${a.threshold === 1 ? 'occurrence' : 'occurrences'} · `), link); list.append(row); });
    detailMore.hidden = !context || !scope() || !personalAvailable() || awardsStarted && !awardsCursor;
    detailMore.disabled = awardsBusy; detailMore.textContent = awardsStarted ? 'Load earlier unlocks' : 'Load unlock history';
    detailStatus.textContent = !personalAvailable() ? 'Unlock history is unavailable.' : !awardsStarted ? 'Load history to see every milestone unlock.' : awardsCursor ? `Checked ${awards.length} unlocks across all achievements. More history is available.` : !awardsComplete ? 'Confirmed unlocks are shown; history is incomplete.' : matches.length ? 'All recorded milestone unlocks are shown.' : 'No recorded milestone unlocks for this achievement.';
  }
  function renderDetail() {
    if (!selected) return;
    const def = definitions.get(selected)!, progress = state(selected);
    get('achievement-detail-art').innerHTML = renderBadge(selected, progress?.highest?.ordinal ?? 0);
    get('achievement-detail-title').textContent = def.name; get('achievement-detail-rarity').textContent = def.rarity; get('achievement-detail-rule').textContent = def.rule;
    const notes = get('achievement-detail-conditions'); notes.replaceChildren(...achievementNotes(selected).map(note => node('li', note)));
    const progression = get('achievement-detail-progression'); progression.replaceChildren();
    const thresholds = def.rarity === 'Common' ? COMMON_MILESTONES : def.rarity === 'Rare' ? RARE_MILESTONES : null;
    progression.append(node('h3', 'Milestones to collect'));
    if (thresholds) {
      const list = node('ol'); list.className = 'milestones'; thresholds.forEach((threshold, index) => list.append(node('li', `★ ${index + 1} · ${threshold} qualifying ${threshold === 1 ? 'occurrence' : 'occurrences'}`))); progression.append(list, node('p', `Then one more star every ${def.rarity === 'Common' ? 100 : 10} qualifying occurrences.`));
    } else progression.append(node('p', 'Every qualifying occurrence earns another milestone and star.'));
    progression.append(node('p', `First unlock: ${milestoneThreshold(def.rarity, 1)} qualifying occurrence. The first milestone earns the badge and first star. Individual stars are shown through five, then a compact star count.`));
    get('achievement-detail-personal').hidden = !context;
    if (context) {
      const streak = ACHIEVEMENT_CONDITIONS.streakAppearances[selected as keyof typeof ACHIEVEMENT_CONDITIONS.streakAppearances];
      get('achievement-detail-progress').textContent = achievementProgressLabel(progress) + (streak && progress?.currentRun !== null && progress?.currentRun !== undefined ? ` · Current run ${progress.currentRun}/${streak} appearances` : '');
      const first = personalAvailable() ? achievements?.firstUnlocks?.find(a => a.achievementId === selected) : undefined;
      get('achievement-detail-first').textContent = first ? `First unlock · ${date(first.earnedAt)}` : achievements?.firstUnlocks === null || !personalAvailable() || progress?.assessability === 'partial' ? 'First unlock date unavailable.' : 'No first unlock recorded.';
      get('achievement-detail-highest').textContent = progress?.highest ? `Highest confirmed milestone · ★ ${progress.highest.ordinal} · ${date(progress.highest.earnedAt)}` : progress?.assessability === 'complete' ? 'No milestone earned yet.' : 'Highest milestone is not confirmed.';
    }
    renderAwards();
  }
  function openDetail(id: AchievementId, from?: HTMLElement) {
    if (!loaded || locked || disposed) return;
    selected = id; trigger = from ?? root.querySelector<HTMLElement>(`#achievement-open-${id}`) ?? search; restoreFocus = true; renderDetail(); syncUrl();
    if (!dialog.open) dialog.showModal(); get<HTMLButtonElement>('achievement-detail-close').focus({ preventScroll: true });
  }
  function failed(error: unknown, id: number) {
    if (!active(id)) return;
    if (error instanceof PlayerClientError && error.status === 401) { retire('Sign in to explore achievements.'); return; }
    if (error instanceof PlayerClientError && [403, 409].includes(error.status)) clear();
    say(error instanceof PlayerClientError ? error.message : 'Achievements could not be loaded. Try again.', true); retry.hidden = false;
  }
  async function loadAwards() {
    const currentScope = scope(); if (!context || !currentScope || awardsBusy || !personalAvailable() || awardsStarted && !awardsCursor) return;
    const id = generation; awardsBusy = true; renderAwards();
    try {
      if (!await verify(id)) return;
      const page = await client.unlocks(context, currentScope, awardsCursor ? { cursor: awardsCursor } : {}, abort.signal);
      if (!active(id)) return;
      if (page.freshness.revision !== achievements?.freshness.revision || page.unlocks?.some(a => awards.some(existing => existing.id === a.id))) throw new PlayerClientError(409, 'history_changed', 'Achievement history changed. Refresh to load a consistent view.');
      if (!await verify(id)) return;
      awardsComplete = page.freshness.status === 'ready' && page.freshness.coverage === 'complete';
      if (page.unlocks === null) { awardsComplete = false; detailStatus.textContent = 'Unlock history is updating. Try again shortly.'; return; }
      awards.push(...page.unlocks); awardsCursor = page.cursor; awardsStarted = true; renderAwards();
    } catch (error) {
      if (error instanceof PlayerClientError && [401, 403, 409].includes(error.status)) failed(error, id);
      else if (active(id)) detailStatus.textContent = 'Unlock history could not be loaded. Retry to continue.';
    } finally { if (active(id)) { awardsBusy = false; detailMore.disabled = false; } }
  }
  async function discover(id: number, next = false) {
    if (!context) return;
    const page = await client.access(context.leagueId, next && accessCursor ? { cursor: accessCursor } : {}, abort.signal);
    if (!active(id) || !await verify(id)) return; accessCursor = page.cursor;
    if (page.players.length || page.hasLeagueAcl) { if (page.players.length) context.viewerPlayerId = page.players[0].playerId; else delete context.viewerPlayerId; await load(false); return; }
    access.replaceChildren(); say(page.cursor ? 'Checking your league access.' : 'No verified league access was found for this account.', !page.cursor);
    if (page.cursor) { const button = node('button', 'Check more linked players') as HTMLButtonElement; button.type = 'button'; button.dataset.ui = 'button-secondary'; button.addEventListener('click', () => { button.disabled = true; void discover(id, true).catch(error => failed(error, id)); }); access.append(button); }
  }
  async function load(allowDiscovery = true) {
    if (disposed || suspended || locked) return;
    const deepLink = selected ?? parsed?.achievementId;
    clear(); abort = new AbortController(); const id = generation; retry.hidden = true; signin.hidden = true; say('Loading achievement collection…');
    try {
      if (parseError) throw parseError;
      if (!await verify(id)) return;
      await client.catalogue(abort.signal); if (!active(id)) return;
      if (context) {
        try { const value = await client.performance({ ...context, ...(selectedSeason ? { seasonId: selectedSeason } : {}) }, abort.signal); if (!active(id)) return; performance = value; }
        catch (error) { if (allowDiscovery && error instanceof PlayerClientError && error.status === 403) { await discover(id); return; } throw error; }
        if (!active(id)) return; context.playerId = performance.player.playerId; selectedSeason = performance.selectedSeasonId ?? undefined;
        const currentScope = scope();
        if (currentScope) { const value = await client.achievements(context, currentScope, abort.signal); if (!active(id)) return; achievements = value; }
        if (!active(id)) return;
        if (achievements && achievements.freshness.revision !== performance.freshness.revision) throw new PlayerClientError(409, 'history_changed', 'Achievement history changed. Refresh to load a consistent view.');
      }
      if (!await verify(id)) return;
      loaded = true; content.hidden = false; renderHeader(); renderGrid(); syncUrl();
      say(context && (!achievements?.progress || achievements.freshness.status !== 'ready') ? 'Personal achievement history is updating or unavailable. Explore the collection while it catches up.' : context && (achievements?.freshness.coverage !== 'complete' || achievements?.progress?.some(p => p.assessability === 'partial')) ? 'Some historical achievements cannot be fully assessed. Progress shows confirmed events only.' : '');
      if (deepLink && definitions.has(deepLink)) openDetail(deepLink);
    } catch (error) { failed(error, id); }
  }
  signin.href = `/sign-in?${new URLSearchParams({ returnTo: window.location.pathname + window.location.search })}`;
  listen(search, 'input', () => { if (loaded) renderGrid(); }); listen(rarity, 'change', () => { if (loaded) renderGrid(); }); listen(earned, 'change', () => { if (loaded) renderGrid(); });
  listen(get('achievement-reset'), 'click', () => { search.value = ''; rarity.value = 'All'; earned.value = 'all'; if (loaded) renderGrid(); search.focus(); });
  listen(season, 'change', () => { selectedSeason = season.value || undefined; void load(); });
  listen(scopeControl, 'change', event => { const value = (event.target as HTMLInputElement).value; if (value !== 'season' && value !== 'career') return; career = value === 'career'; void load(); });
  listen(retry, 'click', () => { void load(); }); listen(detailMore, 'click', () => { void loadAwards(); });
  listen(get('achievement-detail-close'), 'click', () => closeDetail());
  listen(dialog, 'close', () => { selected = null; if (parsed) delete parsed.achievementId; syncUrl(); if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  listen(dialog, 'cancel', () => { restoreFocus = true; });
  listen(window, 'threefc:player-proof-cleared', () => retire()); listen(window, 'threefc:player-proof-invalidated', () => retire());
  listen(window, 'pagehide', () => { clear(); suspended = true; });
  listen(window, 'pageshow', event => { if ((event as PageTransitionEvent).persisted && !disposed && !locked) { suspended = false; void load(); } });
  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'visible' && !disposed && !locked && !suspended && loaded) void load(); });
  const ready = load();
  function destroy() { disposed = true; clear(); account.destroy(); cleanup.forEach(fn => fn()); }
  return { ready, destroy, dispose: destroy };
}
export const mount = mountAchievementGallery;
