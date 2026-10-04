import { ACHIEVEMENT_DEFINITIONS, selectCardHonours, type AchievementUnlock, type CardHonour, type PlayerAchievements, type PlayerPerformance } from '@3fc/contracts';
import { playerInitial } from './player-presentation.js';
import { renderBadge } from './achievement-art.js';
export type ClubCardPeriod = 'last' | 'season' | 'career';
export type ClubCardSide = 'front' | 'honours';
export interface ClubCardModel {
  name: string; league: string; period: ClubCardPeriod; periodLabel: string;
  portraitDataUrl: string | null; initials: string;
  stats: Array<{ label: string; value: string }>; rate: string | null;
  honours: CardHonour[]; additionalHonours: number; honoursNote: string;
  honoursState: 'ready' | 'unavailable'; exportable: boolean; unavailableReason: string;
}
const definitions = new Map(ACHIEVEMENT_DEFINITIONS.map(value => [value.id, value]));
const esc = (value: string) => Array.from(value).map(character => {
  const point = character.codePointAt(0)!;
  return point < 32 && ![9, 10, 13].includes(point) || point >= 0xd800 && point <= 0xdfff ? '\ufffd' : character;
}).join('').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** User-authored SVG and external image URLs never enter a shared card. */
export function validCardPortrait(value: string): boolean {
  const prefix = 'data:image/png;base64,';
  if (!value.startsWith(prefix)) return false;
  const encoded = value.slice(prefix.length);
  if (!encoded.length || encoded.length > 2_796_204 || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
  try {
    const binary = atob(encoded);
    return binary.length <= 2 * 1024 * 1024 && btoa(binary) === encoded && binary.startsWith('\x89PNG\r\n\x1a\n');
  } catch { return false; }
}
export function buildClubCardModel(input: { performance: PlayerPerformance; period: ClubCardPeriod; portraitDataUrl: string | null; achievements: PlayerAchievements | null }): ClubCardModel {
  const { performance: p, period } = input;
  const latest = p.latest;
  const periodLabel = period === 'career' ? 'LEAGUE CAREER' : period === 'last' ? latest ? new Date(latest.kickoffAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : 'LAST GAME'
    : p.seasons.find(value => value.seasonId === p.selectedSeasonId)?.name ?? 'SEASON';
  const stats: ClubCardModel['stats'] = [];
  let rate: string | null = null;
  if (period === 'last' && latest) stats.push({ label: 'GOALS', value: String(latest.goals) }, { label: 'ASSISTS', value: String(latest.assists) }, { label: 'RESULT', value: latest.outcome.toUpperCase() }, { label: 'OWN GOALS', value: String(latest.ownGoals) });
  if (period !== 'last') {
    const totals = period === 'career' ? p.career : p.season;
    if (totals) {
      for (const [label, key] of [['PLAYED', 'played'], ['GOALS', 'goals'], ['ASSISTS', 'assists'], ['WINS', 'wins'], ['DRAWS', 'draws'], ['OWN GOALS', 'ownGoals']] as const) stats.push({ label, value: String(totals[key]) });
      rate = `${totals.goalsPerGame.toLocaleString('en-AU', { maximumFractionDigits: 2 })} GOALS / GAME`;
    }
  }
  const portrait = input.portraitDataUrl && validCardPortrait(input.portraitDataUrl) ? input.portraitDataUrl : null;
  const exportable = p.freshness.status === 'ready' && p.freshness.coverage === 'complete' && p.freshness.revision !== null
    && stats.length > 0 && (!p.player.hasPortrait || portrait !== null);
  const unavailableReason = p.player.hasPortrait && !portrait ? 'Your portrait could not be loaded. Refresh the profile before sharing.'
    : !stats.length ? 'This period has no completed record to share yet.' : 'This record is still updating. Refresh the profile before sharing.';
  const a = input.achievements;
  const matched = a !== null && a.playerId === p.player.playerId && a.leagueId === p.league.leagueId
    && a.freshness.status === 'ready' && a.freshness.coverage === 'complete' && a.freshness.revision === p.freshness.revision
    && (period !== 'season' || a.scope === 'season' && a.seasonId === p.selectedSeasonId)
    && (period !== 'career' || a.scope === 'career');
  const awards: AchievementUnlock[] | null = matched ? period === 'last' ? a!.latestUnlocks : a!.honours : null;
  const relevant = awards?.filter(award => period !== 'last' || award.gameId === latest?.gameId) ?? [];
  const honours = selectCardHonours(relevant);
  const uncertain = a?.progress?.some(progress => progress.assessability === 'partial') ?? false;
  return {
    name: p.player.displayName, league: p.league.name, period, periodLabel,
    portraitDataUrl: portrait, initials: playerInitial(p.player.displayName), stats, rate,
    honours, additionalHonours: Math.max(0, new Set(relevant.map(value => value.achievementId)).size - honours.length),
    honoursState: awards === null ? 'unavailable' : 'ready',
    honoursNote: awards === null ? 'Honours are temporarily unavailable.' : uncertain ? 'Confirmed honours · some history cannot be assessed' : period === 'last' ? 'MILESTONES EARNED THIS GAME' : 'HIGHEST MILESTONE IN EACH CLASS',
    exportable, unavailableReason,
  };
}
function lines(value: string, maximum: number, count = 2): string[] {
  const letters = Array.from(value.trim()), result: string[] = [];
  while (letters.length && result.length < count) {
    const take = letters.splice(0, maximum).join(''); result.push(take);
  }
  if (letters.length) result[result.length - 1] = result[result.length - 1].slice(0, -1) + '…';
  return result.length ? result : [''];
}
/** Self-contained vector; every variable text/URL is escaped, badge paths are bundled artwork. */
export function renderClubCardSvg(model: ClubCardModel, side: ClubCardSide): string {
  const ivory = '#f3efdd', mint = '#b9d9bd', gold = '#d9b769';
  const text = (x: number, y: number, value: string, size = 12, colour = ivory, weight = 600, anchor = 'middle', fit?: number) => `<text x="${x}" y="${y}" text-anchor="${anchor}"${fit ? ` textLength="${fit}" lengthAdjust="spacingAndGlyphs"` : ''} font-size="${size}" fill="${colour}" font-weight="${weight}">${esc(value)}</text>`;
  const centre = (y: number, value: string, size = 12, colour = ivory, weight = 600) => text(200, y, value, size, colour, weight);
  let art = '<path d="M14 10H386V414Q386 470 200 517Q14 470 14 414Z" fill="#14291f"/><path d="M25 21H375V411Q375 459 200 505Q25 459 25 411Z" fill="none" stroke="#d9b769" stroke-width="1.2"/>';
  art += text(36, 50, '3FC', 22, ivory, 900, 'start') + text(364, 47, side === 'honours' ? 'TOP ACHIEVEMENTS' : `${model.period === 'last' ? 'MATCH' : model.period.toUpperCase()} EDITION`, 10, gold, 750, 'end');
  if (side === 'front') {
    art += '<circle cx="200" cy="151" r="78" fill="#233c2d" stroke="#b9d9bd" stroke-width="1.2"/>';
    if (model.portraitDataUrl && validCardPortrait(model.portraitDataUrl)) art += `<defs><clipPath id="club-portrait"><circle cx="200" cy="151" r="75"/></clipPath></defs><image href="${esc(model.portraitDataUrl)}" x="125" y="76" width="150" height="150" clip-path="url(#club-portrait)"/>`;
    else art += '<path d="M200 76V226M135 189L265 113M135 113L265 189" stroke="#b9d9bd" opacity=".25"/>' + centre(187, model.initials, 104, ivory, 850);
    const names = lines(model.name, 23); names.forEach((line, index) => { art += centre(names.length === 1 ? 276 : 258 + index * 25, line, names.length === 1 && line.length < 16 ? 31 : 22, ivory, 800); });
    art += centre(307, lines(model.league.toUpperCase(), 40, 1)[0], 9, gold, 700) + '<path d="M48 320H352" stroke="#b9d9bd" opacity=".45"/>' + centre(342, lines(model.periodLabel, 38, 1)[0], 11, mint, 650);
    const positions = model.period === 'last' ? [[112, 382], [288, 382], [112, 437], [288, 437]] : [[94, 382], [200, 382], [306, 382], [94, 434], [200, 434], [306, 434]];
    model.stats.forEach((stat, index) => { const [x, y] = positions[index]; art += text(x, y, stat.value, stat.value.length > 5 ? 20 : index < (model.period === 'last' ? 2 : 3) ? 30 : 24, ivory, 800, 'middle', stat.value.length > 6 ? (model.period === 'last' ? 125 : 85) : undefined) + text(x, y + 18, stat.label, 9, mint, 650); });
    if (!model.stats.length) art += centre(401, 'YOUR STORY STARTS HERE', 17, ivory, 750);
    if (model.rate) art += centre(474, model.rate, 10, mint);
  } else {
    const names = lines(model.name, 26); names.forEach((line, index) => { art += centre(names.length === 1 ? 86 : 77 + index * 21, line, 21, ivory, 800); });
    art += centre(116, lines(model.periodLabel, 40, 1)[0], 10, mint);
    if (model.honoursState !== 'ready') art += centre(258, 'HONOURS ARE UPDATING', 18, gold, 750) + centre(287, 'Check back when your record is ready.', 11, mint);
    else if (!model.honours.length) art += centre(255, model.period === 'last' ? 'NO NEW MILESTONES' : 'YOUR NEXT STORY AWAITS', 19, gold, 750) + centre(284, model.period === 'last' ? 'Your other honours stay with you.' : 'Play, score and make your mark.', 11, mint);
    else {
      const placements: Record<number, Array<[number, number, number]>> = {
        1: [[200, 263, 1]], 2: [[111, 268, .84], [289, 268, .84]],
        3: [[200, 202, .72], [108, 350, .72], [292, 350, .72]],
        4: [[108, 211, .72], [292, 211, .72], [108, 358, .72], [292, 358, .72]],
        5: [[200, 288, .62], [106, 194, .62], [294, 194, .62], [106, 382, .62], [294, 382, .62]],
      };
      model.honours.forEach((award, index) => {
        const [x, y, scale] = placements[model.honours.length][index];
        art += `<g transform="translate(${x - 80 * scale} ${y - 92 * scale}) scale(${scale})">${renderBadge(award.achievementId, award.ordinal)}</g>`;
        const label = definitions.get(award.achievementId)!.name;
        art += text(x, y + 104 * scale, label, model.honours.length === 5 ? 10 : 11, ivory, 700);
        if (model.period === 'last') art += text(x, y + 119 * scale, award.scopes.join(' + ').toUpperCase(), 7, mint, 600);
      });
    }
    if (model.additionalHonours && model.honoursNote.startsWith('Confirmed')) art += centre(479, 'Some history cannot be assessed', 7, mint);
    art += centre(467, model.additionalHonours ? `+${model.additionalHonours} OTHER ACHIEVEMENTS` : lines(model.honoursNote, 51, 1)[0], 8, mint);
  }
  if (!model.exportable) art += centre(side === 'front' ? 490 : 485, 'RECORD NOT READY TO SHARE', 8, gold);
  else art += centre(side === 'front' ? 491 : 488, '3FC.FOOTBALL', 8, mint);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1560" viewBox="0 0 400 520" role="img" aria-label="${esc(`${model.name} · ${model.periodLabel} · ${side === 'front' ? 'Club Card' : 'Honours'}`)}" font-family="Arial,Helvetica,sans-serif"><title>${esc(model.name)} · ${side === 'front' ? 'Club Card' : 'Honours'}</title>${art}</svg>`;
}
