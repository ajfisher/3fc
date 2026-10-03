import { ACHIEVEMENT_DEFINITIONS, type AchievementId, type PlayerAchievements, type PlayerPerformance } from '@3fc/contracts';
import type { PlayerClient, PlayerContext, PlayerSession } from './player-client.js';
import { buildClubCardModel, renderClubCardSvg, type ClubCardModel, type ClubCardPeriod, type ClubCardSide } from './player-card-art.js';

export interface ClubCardSnapshot { context: PlayerContext; performance: PlayerPerformance; period: ClubCardPeriod; portraitDataUrl: string | null }
type Client = Pick<PlayerClient, 'session' | 'catalogue' | 'achievements' | 'performance' | 'portrait'>;
const accountKey = (value: PlayerSession): string | null => value.authenticated && value.session ? JSON.stringify([value.session.sessionId, value.session.subject ?? value.session.email]) : null;
const denied = (error: unknown) => [401, 403].includes((error as { status?: number })?.status ?? 0);

/** Data URLs comply with the application's img-src policy; no external assets or fonts. */
export async function rasterizeClubCard(svg: string, document: Document, signal?: AbortSignal): Promise<Blob> {
  const window = document.defaultView!;
  const image = new window.Image();
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error('Image preparation timed out')), 12_000);
    const abort = () => finish(new Error('Image preparation cancelled'));
    function finish(error?: Error) { window.clearTimeout(timer); signal?.removeEventListener('abort', abort); image.onload = null; image.onerror = null; if (error) { image.src = ''; reject(error); } else resolve(); }
    image.onload = () => finish(); image.onerror = () => finish(new Error('Image preparation failed'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  if (signal?.aborted) throw new Error('Image preparation cancelled');
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1560;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Image preparation is unavailable');
  context.drawImage(image, 0, 0, 1200, 1560);
  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => finish(null), 12_000), abort = () => finish(null);
    function finish(blob: Blob | null) {
      if (settled) return; settled = true; window.clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (blob && !signal?.aborted) resolve(blob); else reject(new Error('Image preparation failed'));
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { canvas.toBlob(finish, 'image/png'); } catch { finish(null); }
  });
}

export function mountClubCard(options: { dialog: HTMLDialogElement; client: Client; getSnapshot: () => ClubCardSnapshot | null;
  prepare?: (svg: string, signal: AbortSignal) => Promise<Blob>; now?: () => number }) {
  const { dialog, client } = options, document = dialog.ownerDocument, window = document.defaultView!;
  const el = <T extends HTMLElement>(id: string) => { const found = dialog.querySelector<T>(`#${id}`); if (!found) throw new Error(`Missing ${id}`); return found; };
  const art = el('club-card-art'), title = el('club-card-title'), status = el('club-card-status'), links = el('club-card-honours-links');
  const flip = el<HTMLButtonElement>('club-card-flip'), share = el<HTMLButtonElement>('club-card-share'), download = el<HTMLButtonElement>('club-card-download'), retry = el<HTMLButtonElement>('club-card-retry');
  const gallery = el<HTMLAnchorElement>('club-card-gallery'), closeButton = el<HTMLButtonElement>('club-card-close');
  const prepare = options.prepare ?? ((svg, signal) => rasterizeClubCard(svg, document, signal));
  const now = options.now ?? (() => window.performance.now());
  let generation = 0, disposed = false, frozen: ClubCardSnapshot | null = null, model: ClubCardModel | null = null, awards: PlayerAchievements | null = null;
  let side: ClubCardSide = 'front', signal = new AbortController(), file: File | null = null, identity: string | null = null, trigger: HTMLElement | null = null;
  let sharing = false, preparing = false, suspended = false, needsRefresh = false, recheckRequired = false, shareAttempt = 0;
  let authorizedUntil = 0, expiryTimer: number | null = null, artifactVersion = 0;
  const cleanups: Array<() => void> = [], urls = new Set<string>();
  const listen = (target: EventTarget, event: string, handler: EventListener) => { target.addEventListener(event, handler); cleanups.push(() => target.removeEventListener(event, handler)); };
  function say(message: string) { status.textContent = message; }
  function current(id: number) {
    const live = options.getSnapshot();
    return !disposed && !suspended && dialog.open && id === generation && frozen !== null && live !== null && live.period === frozen.period
      && live.context.leagueId === frozen.context.leagueId && live.context.playerId === frozen.context.playerId && live.context.viewerPlayerId === frozen.context.viewerPlayerId
      && live.performance.player.playerId === frozen.performance.player.playerId
      && live.performance.player.displayName === frozen.performance.player.displayName
      && live.performance.player.hasPortrait === frozen.performance.player.hasPortrait
      && live.performance.freshness.revision === frozen.performance.freshness.revision
      && live.performance.selectedSeasonId === frozen.performance.selectedSeasonId
      && live.performance.freshness.status === frozen.performance.freshness.status && live.performance.freshness.coverage === frozen.performance.freshness.coverage
      && (live.portraitDataUrl === frozen.portraitDataUrl || frozen.portraitDataUrl === null || live.portraitDataUrl === null);
  }
  function controls() { share.disabled = !file || preparing || sharing || suspended || needsRefresh || recheckRequired; download.disabled = share.disabled; flip.disabled = preparing || sharing || suspended || recheckRequired || needsRefresh; retry.disabled = preparing || sharing || suspended || needsRefresh; }
  function release() {
    artifactVersion++; if (expiryTimer !== null) window.clearTimeout(expiryTimer); expiryTimer = null;
    file = null; for (const url of urls) window.URL.revokeObjectURL(url); urls.clear(); controls();
  }
  function expireAuthorization() {
    release(); recheckRequired = true; retry.hidden = false; retry.textContent = 'Refresh card';
    say('Refresh this card to confirm your current access before sharing.'); controls();
  }
  function armExpiry() {
    const version = artifactVersion, prepared = file;
    const expire = () => {
      if (version !== artifactVersion || file !== prepared || !frozen || disposed) return;
      const remaining = authorizedUntil - now();
      if (remaining > 0) { expiryTimer = window.setTimeout(expire, remaining); return; }
      expireAuthorization();
    };
    expiryTimer = window.setTimeout(expire, Math.max(0, authorizedUntil - now()));
  }
  function invalidate() {
    signal.abort(); generation++; shareAttempt++; release(); authorizedUntil = 0; frozen = null; model = null; awards = null; identity = null; preparing = false; sharing = false; suspended = false; needsRefresh = false; recheckRequired = false;
    art.replaceChildren(); links.replaceChildren(); title.textContent = 'Club Card'; gallery.removeAttribute('href'); say(''); controls();
    if (dialog.open) dialog.close();
    if (trigger?.isConnected && !(trigger as HTMLButtonElement).disabled) trigger.focus(); trigger = null;
  }
  function href(achievementId?: AchievementId, scope = frozen?.period === 'season' ? 'season' : 'career', seasonId: string | null = frozen?.performance.selectedSeasonId ?? null) {
    const query = new URLSearchParams({ ...frozen!.context, scope });
    if (scope === 'season' && seasonId) query.set('seasonId', seasonId);
    if (achievementId) query.set('achievementId', achievementId);
    return `/achievements?${query}`;
  }
  function render() {
    if (!frozen) return;
    model = buildClubCardModel({ performance: frozen.performance, period: frozen.period, portraitDataUrl: frozen.portraitDataUrl, achievements: awards });
    art.innerHTML = renderClubCardSvg(model, side); title.textContent = `${model.name} · Club Card`;
    flip.textContent = side === 'front' ? 'View honours' : 'View performance'; flip.setAttribute('aria-pressed', String(side === 'honours'));
    gallery.href = href(); gallery.hidden = !frozen.performance.capabilities.achievements;
    links.replaceChildren(); links.hidden = side !== 'honours';
    for (const honour of model.honours) {
      const item = document.createElement('li'), link = document.createElement('a');
      link.href = href(honour.achievementId, honour.scopes.includes('career') ? 'career' : 'season', honour.seasonId);
      link.textContent = `${ACHIEVEMENT_DEFINITIONS.find(value => value.id === honour.achievementId)!.name} · ${honour.ordinal} ${honour.ordinal === 1 ? 'star' : 'stars'}${frozen.period === 'last' ? ` · ${honour.scopes.join(' + ')}` : ''}`;
      item.append(link); links.append(item);
    }
  }
  async function confirmAccount(id: number) {
    let session: PlayerSession;
    try { session = await client.session(signal.signal); }
    catch (error) { if (current(id) && denied(error)) { invalidate(); return false; } throw error; }
    const key = accountKey(session);
    if (!current(id)) return false;
    if (!key || identity && key !== identity) { invalidate(); return false; }
    identity = key; return true;
  }
  async function prepareSide(loadAwards: boolean) {
    if (now() >= authorizedUntil) { expireAuthorization(); return; }
    signal.abort(); signal = new AbortController(); const id = ++generation;
    release(); preparing = true; retry.hidden = true; retry.textContent = 'Retry'; controls(); say('Preparing your card…'); render();
    try {
      if (!frozen || !await confirmAccount(id)) return;
      // A portrait may have completed loading after the dialog opened. This is the
      // only field refreshed in a frozen record; periods and source revisions stay fixed.
      const live = options.getSnapshot(); if (frozen.portraitDataUrl === null && live?.portraitDataUrl) frozen.portraitDataUrl = live.portraitDataUrl;
      if (loadAwards && frozen.performance.capabilities.achievements) {
        const scope = frozen.period === 'season' && frozen.performance.selectedSeasonId ? { scope: 'season' as const, seasonId: frozen.performance.selectedSeasonId } : { scope: 'career' as const, seasonId: null };
        try {
          await client.catalogue(signal.signal);
          const result = await client.achievements(frozen.context, scope, signal.signal);
          if (!current(id)) return;
          awards = result;
        } catch (error) { if (!current(id)) return; if (denied(error)) { invalidate(); return; } awards = null; }
      }
      if (!current(id)) return; render();
      if (!model!.exportable || side === 'honours' && model!.honoursState !== 'ready') { say(!model!.exportable ? model!.unavailableReason : 'Honours are updating or unavailable. Retry to check this record again.'); retry.hidden = false; return; }
      const blob = await prepare(renderClubCardSvg(model!, side), signal.signal);
      if (!current(id) || !await confirmAccount(id)) return;
      if (now() >= authorizedUntil) { expireAuthorization(); return; }
      if (blob.type !== 'image/png' || !blob.size) throw new Error('Invalid image');
      const name = model!.name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || 'player';
      file = new window.File([blob], `${name}-${frozen.period}-${side}.png`, { type: 'image/png' });
      armExpiry();
      share.hidden = !canShare(file); say('Ready to share · 1200 × 1560 PNG');
      if (model!.honoursState === 'unavailable' && frozen.performance.capabilities.achievements) { retry.hidden = false; say('Performance ready to share. Honours are unavailable; retry to check them.'); }
    } catch { if (current(id)) { release(); retry.hidden = false; say('The card could not be prepared. Retry to keep this period and side.'); } }
    finally { if (id === generation) { preparing = false; controls(); } }
  }
  function canShare(value: File) { try { return typeof window.navigator.share === 'function' && typeof window.navigator.canShare === 'function' && window.navigator.canShare({ files: [value] }); } catch { return false; } }
  function readyFile() {
    if (!file || preparing || sharing || suspended || needsRefresh || recheckRequired) return null;
    // Timers can be throttled or delayed: this synchronous gate owns release.
    if (now() >= authorizedUntil) { expireAuthorization(); return null; }
    if (!current(generation)) { invalidate(); return null; } return file;
  }
  function downloadCard() {
    const value = readyFile(); if (!value) return;
    try {
      const url = window.URL.createObjectURL(value); urls.add(url);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = value.name; document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => { if (urls.delete(url)) window.URL.revokeObjectURL(url); }, 30_000);
      say('Card downloaded.');
    } catch { say('The download could not start. Try Download again.'); }
  }
  async function resumeVisible() {
    if (!frozen || disposed || document.hidden) return;
    signal.abort(); release(); authorizedUntil = 0;
    suspended = false; signal = new AbortController(); const id = ++generation, checkedAt = now(); preparing = true; controls(); say('Checking your current record…');
    try {
      if (!await confirmAccount(id) || !frozen) return;
      const record = await client.performance({ ...frozen.context, ...(frozen.performance.selectedSeasonId ? { seasonId: frozen.performance.selectedSeasonId } : {}) }, signal.signal);
      if (!current(id)) return;
      let same = JSON.stringify(record) === JSON.stringify(frozen.performance);
      if (same && record.player.hasPortrait) {
        const blob = await client.portrait(frozen.context, signal.signal);
        if (!current(id)) return;
        const portrait = blob ? await new Promise<string>((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Portrait unavailable')); reader.readAsDataURL(blob); }) : null;
        if (!current(id)) return;
        if (!portrait) throw new Error('Portrait unavailable');
        if (frozen.portraitDataUrl === null) frozen.portraitDataUrl = portrait;
        else same = portrait === frozen.portraitDataUrl;
      }
      if (!same) { needsRefresh = true; say('Your record has changed. Close this card and refresh the profile before sharing.'); return; }
      // Include network/preparation time in the bounded grant. Flipping or
      // re-rendering cannot extend it without another resource-authorized read.
      authorizedUntil = checkedAt + 30_000;
      recheckRequired = false; await prepareSide(true);
    } catch (error) { if (current(id)) { if (denied(error)) { invalidate(); return; } recheckRequired = true; retry.hidden = false; say('Your access could not be confirmed. Retry to check again without changing this card.'); } }
    finally { if (id === generation) { preparing = false; controls(); } }
  }
  function shareCard() {
    const value = readyFile(); if (!value) return;
    if (!canShare(value)) { downloadCard(); return; }
    const id = generation, attempt = ++shareAttempt; sharing = true; controls();
    // No awaited work before this call: keep the browser's user activation.
    let request: Promise<void>; try { request = window.navigator.share({ files: [value], title: `${model!.name} · 3FC Club Card` }); }
    catch { sharing = false; controls(); say('Sharing is unavailable. Download your card instead.'); return; }
    void request.then(() => { if (current(id) && !recheckRequired) say('Card shared.'); }, error => { if (current(id) && !recheckRequired) say(error?.name === 'AbortError' ? 'Sharing cancelled. Your card is ready.' : 'Sharing is unavailable. Download your card instead.'); }).finally(() => { if (attempt === shareAttempt) { sharing = false; controls(); } });
  }
  listen(closeButton, 'click', invalidate); listen(dialog, 'cancel', event => { event.preventDefault(); invalidate(); });
  listen(dialog, 'close', () => { if (frozen) invalidate(); });
  listen(flip, 'click', () => { if (!frozen || preparing || sharing || needsRefresh || recheckRequired) return; if (now() >= authorizedUntil) { expireAuthorization(); return; } side = side === 'front' ? 'honours' : 'front'; void prepareSide(false); });
  listen(retry, 'click', () => { if (frozen && !preparing && !sharing && !needsRefresh) void resumeVisible(); });
  listen(share, 'click', shareCard); listen(download, 'click', downloadCard);
  listen(document, 'visibilitychange', () => {
    if (!frozen) return;
    if (document.hidden) { suspended = true; recheckRequired = true; signal.abort(); generation++; release(); preparing = false; art.replaceChildren(); links.replaceChildren(); controls(); }
    else void resumeVisible();
  });
  for (const event of ['threefc:player-proof-cleared', 'threefc:player-proof-invalidated', 'pagehide']) listen(window, event, invalidate);
  return {
    async open(opener?: HTMLElement) {
      if (disposed) return; invalidate(); const snapshot = options.getSnapshot(); if (!snapshot) return;
      // A safe performance DTO is the only profile data ever copied into the card.
      frozen = structuredClone(snapshot); side = 'front'; trigger = opener ?? document.activeElement as HTMLElement | null;
      dialog.showModal(); closeButton.focus(); recheckRequired = true; await resumeVisible();
    },
    invalidate,
    isSharing: () => sharing,
    dispose() { if (disposed) return; invalidate(); disposed = true; cleanups.splice(0).forEach(cleanup => cleanup()); },
  };
}
