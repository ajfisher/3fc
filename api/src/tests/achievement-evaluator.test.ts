import assert from 'node:assert/strict';
import test from 'node:test';
import { compareMatchOrder, matchOrderKey } from '../achievements/facts.js';
import { ACHIEVEMENT_DEFINITIONS, type AchievementId, type TeamId } from '@3fc/contracts';
import {
  applyAppearance, emptyAccumulator, leaders, progressFor, publicUnlock, stableUnlockId,
  type AchievementAccumulator, type MatchFacts, type MatchGoal
} from '../achievements/evaluate.js';

const player = 'canonical/player';
function goal(eventId: string, extra: Partial<MatchGoal> = {}): MatchGoal {
  return { eventId, scorerPlayerId: player, assistPlayerIds: [], scoringTeamId: 'red',
    concedingTeamId: 'blue', ownGoal: false, third: 1, elapsedSeconds: 300,
    createdAt: '2026-01-01T10:10:00.000Z', timing: 'live', ...extra };
}
function match(goals: MatchGoal[] = [], extra: Partial<MatchFacts> = {}): MatchFacts {
  return { gameId: 'game-001', leagueId: 'league', seasonId: 'winter',
    kickoffAt: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T11:10:00.000Z',
    sourceRevision: 'revision-1', thirdLengthMinutes: 20, thirdEndsSeconds: [1260, 1260, 1260],
    roster: [{ playerId: player, teamId: 'red' }, { playerId: 'red-mate', teamId: 'red' },
      { playerId: 'blue-player', teamId: 'blue' }, { playerId: 'yellow-player', teamId: 'yellow' }],
    goals, ...extra };
}
function evaluate(facts: MatchFacts) { return applyAppearance(emptyAccumulator(), facts, player, 'career'); }
function count(state: AchievementAccumulator, id: AchievementId) { return state.counts[id]; }
function numbered(number: number, goals: MatchGoal[] = [], extra: Partial<MatchFacts> = {}): MatchFacts {
  const date = `2026-01-${String(number).padStart(2, '0')}`;
  return match(goals.map(value => ({ ...value, createdAt: `${date}T10:10:00.000Z` })), {
    gameId: `game-${String(number).padStart(3, '0')}`, kickoffAt: `${date}T10:00:00.000Z`,
    finishedAt: `${date}T11:10:00.000Z`, ...extra
  });
}
function own(eventId: string, concedingTeamId: TeamId, extra: Partial<MatchGoal> = {}) {
  return goal(eventId, { ownGoal: true, scoringTeamId: null, concedingTeamId,
    scorerPlayerId: concedingTeamId === 'red' ? player : `${concedingTeamId}-player`, ...extra });
}

test('empty history exposes all 23 known zero counts and no invented earned milestones', () => {
  const state = emptyAccumulator();
  assert.equal(state.totals.goalsPerGame, 0);
  assert.deepEqual(progressFor(state).map(value => value.achievementId), ACHIEVEMENT_DEFINITIONS.map(value => value.id));
  assert.equal(progressFor(state).length, 23);
  for (const progress of progressFor(state)) {
    assert.equal(progress.count, 0); assert.equal(progress.ordinal, 0);
    assert.equal(progress.nextThreshold, 1); assert.equal(progress.highest, null);
    assert.equal(progress.assessability, 'complete');
  }
});

test('credited goals, cross-team and own-goal assists preserve aggregate semantics', () => {
  const facts = match([
    goal('normal'), goal('cross-team', { scorerPlayerId: 'blue-player', scoringTeamId: 'blue',
      concedingTeamId: 'yellow', assistPlayerIds: [player] }),
    own('their-og', 'yellow', { assistPlayerIds: [player] }), own('our-og', 'red')
  ]);
  const { state, appearance } = evaluate(facts);
  assert.deepEqual(state.totals, { played: 1, goals: 1, assists: 2, ownGoals: 1,
    wins: 0, draws: 1, losses: 0, goalsPerGame: 1 });
  assert.equal(appearance?.scored, 1); assert.equal(appearance?.conceded, 1);
  assert.equal(count(state, 'goal'), 1); assert.equal(count(state, 'assist'), 2);
  assert.equal(count(state, 'own-goal'), 1); assert.equal(count(state, 'played'), 1);
  assert.equal(count(state, 'double-threat'), 1); assert.equal(count(state, 'draw'), 1);
});

test('winner comparator uses conceded then scored; only joint first receive a draw', () => {
  assert.deepEqual(leaders({ red: { scored: 4, conceded: 2 }, blue: { scored: 0, conceded: 1 },
    yellow: { scored: 4, conceded: 2 } }), ['blue']);
  const tied = evaluate(match());
  assert.equal(tied.appearance?.outcome, 'draw'); assert.equal(count(tied.state, 'draw'), 1);
  const won = evaluate(match([goal('winner')]));
  assert.equal(won.appearance?.outcome, 'win'); assert.equal(count(won.state, 'wins'), 1);
  const lost = evaluate(match([own('conceded', 'red')]));
  assert.equal(lost.appearance?.outcome, 'loss'); assert.equal(count(lost.state, 'draw'), 0);
});

test('only eligible final roster membership counts, including a late zero-contribution assignment', () => {
  const absent = evaluate(match([], { roster: [{ playerId: 'blue-player', teamId: 'blue' }] }));
  assert.equal(absent.appearance, null); assert.equal(absent.state.totals.played, 0);
  assert.deepEqual(absent.unlocks, []);
  const late = evaluate(match());
  assert.equal(late.state.totals.played, 1);
  assert.equal(count(late.state, 'lockdown'), 1); assert.equal(count(late.state, 'defence'), 3);
});

test('large event totals preserve every crossed milestone while match feats count once', () => {
  const goals = Array.from({ length: 12 }, (_, index) => goal(`goal-${index}`));
  goals.push(...Array.from({ length: 6 }, (_, index) => goal(`assist-${index}`, {
    scorerPlayerId: 'red-mate', assistPlayerIds: [player] })));
  const { state, unlocks } = evaluate(match(goals));
  assert.equal(count(state, 'goal'), 12); assert.equal(count(state, 'assist'), 6);
  assert.deepEqual(unlocks.filter(value => value.achievementId === 'goal').map(value => value.threshold), [1, 5, 10]);
  assert.deepEqual(unlocks.filter(value => value.achievementId === 'assist').map(value => value.threshold), [1, 5]);
  for (const id of ['hat-trick', 'master-provider', 'double-threat', 'lockdown'] as const) assert.equal(count(state, id), 1, id);
});

test('triple threat and team engine require credited goals and assists in every third', () => {
  const goals = ([1, 2, 3] as const).flatMap(third => [
    goal(`goal-${third}`, { third }), goal(`assist-${third}`, { third, scorerPlayerId: 'red-mate', assistPlayerIds: [player] }),
    goal(`second-${third}`, { third })
  ]);
  const complete = evaluate(match(goals));
  assert.equal(count(complete.state, 'triple-threat'), 1); assert.equal(count(complete.state, 'team-engine'), 1);
  const missingAssist = evaluate(match(goals.filter(value => value.eventId !== 'assist-2')));
  assert.equal(count(missingAssist.state, 'triple-threat'), 1); assert.equal(count(missingAssist.state, 'team-engine'), 0);
  const missingGoal = evaluate(match(goals.filter(value => value.third !== 2 || value.scorerPlayerId !== player)));
  assert.equal(count(missingGoal.state, 'triple-threat'), 0); assert.equal(count(missingGoal.state, 'team-engine'), 0);
});

test('opening badges include zero and 119 seconds but exclude 120, counted per goal', () => {
  const goals = ([1, 2, 3] as const).flatMap(third => [0, 119, 120].map(elapsedSeconds =>
    goal(`${third}-${elapsedSeconds}`, { third, elapsedSeconds })));
  const { state } = evaluate(match(goals));
  assert.equal(count(state, 'message-sent'), 2); assert.equal(count(state, 'speedy'), 4);
  assert.equal(count(state, 'momentum-play'), 0); assert.equal(count(state, 'clutch'), 0);
});

test('closing badges start exactly one minute before regulation and include stoppage and the third end', () => {
  for (const thirdLengthMinutes of [20, 25, 30] as const) {
    const regulation = thirdLengthMinutes * 60, end = regulation + 90;
    const goals = ([1, 2, 3] as const).flatMap(third =>
      [regulation - 61, regulation - 60, regulation, end].map(elapsedSeconds => goal(`${third}-${elapsedSeconds}`, { third, elapsedSeconds })));
    const facts = match(goals, { thirdLengthMinutes, thirdEndsSeconds: [end, end, end] });
    const { state } = evaluate(facts);
    assert.equal(count(state, 'momentum-play'), 6, `regulation ${thirdLengthMinutes}`);
    assert.equal(count(state, 'clutch'), 3, `regulation ${thirdLengthMinutes}`);
    assert.throws(() => evaluate(match([goal('after-end', { third: 3, elapsedSeconds: end + 1 })],
      { thirdLengthMinutes, thirdEndsSeconds: [end, end, end] })), /Live timing/);
  }
});

test('Defence excludes exactly two behind either opponent, but permits one behind', () => {
  for (const [redConceded, blueConceded, yellowConceded, expected] of [[2, 1, 1, 2], [3, 1, 1, 0], [3, 1, 2, 0], [0, 2, 3, 3]]) {
    const goals = ([['red', redConceded], ['blue', blueConceded], ['yellow', yellowConceded]] as [TeamId, number][])
      .flatMap(([team, total]) => Array.from({ length: total }, (_, index) => own(`${team}-${index}`, team)));
    assert.equal(count(evaluate(match(goals)).state, 'defence'), expected, `${redConceded}/${blueConceded}/${yellowConceded}`);
  }
  const redBehind = match([own('r1', 'red'), own('r2', 'red'), own('r3', 'red'), own('b1', 'blue'), own('y1', 'yellow')]);
  const blue = applyAppearance(emptyAccumulator(), redBehind, 'blue-player', 'career');
  assert.equal(count(blue.state, 'defence'), 2, 'the eligible rival earns its two clean thirds');
});

test('Desperate Defence requires an outright entering lead, clean final third and outright final win', () => {
  const lead = goal('early-lead');
  assert.equal(count(evaluate(match([lead])).state, 'desperate-defence'), 1);
  assert.equal(count(evaluate(match()).state, 'desperate-defence'), 0, 'shared first is insufficient');
  const conceded = evaluate(match([lead, own('concede', 'red', { third: 3 })]));
  assert.equal(count(conceded.state, 'desperate-defence'), 0);
  const lostOnScored = evaluate(match([lead,
    goal('yellow-1', { scorerPlayerId: 'yellow-player', scoringTeamId: 'yellow', concedingTeamId: 'blue', third: 3 }),
    goal('yellow-2', { scorerPlayerId: 'yellow-player', scoringTeamId: 'yellow', concedingTeamId: 'blue', third: 3 })]));
  assert.equal(lostOnScored.appearance?.outcome, 'loss');
  assert.equal(count(lostOnScored.state, 'desperate-defence'), 0, 'a clean final third cannot replace the final win');
});

test('Hail Mary needs a closing lead transition and final win; Comeback Crew excludes an entering shared first', () => {
  const closing = goal('late', { third: 3, elapsedSeconds: 1140 });
  const fromDraw = evaluate(match([closing]));
  assert.equal(count(fromDraw.state, 'hail-mary'), 1); assert.equal(count(fromDraw.state, 'comeback-crew'), 0);
  const alreadyAhead = evaluate(match([goal('already-leading'), closing]));
  assert.equal(count(alreadyAhead.state, 'hail-mary'), 0);
  const early = evaluate(match([{ ...closing, elapsedSeconds: 1139 }]));
  assert.equal(count(early.state, 'hail-mary'), 0);
  const comebackGoals = [goal('behind', { scorerPlayerId: 'blue-player', scoringTeamId: 'blue', concedingTeamId: 'red' }),
    goal('equalise-blue', { third: 3, elapsedSeconds: 1100 }),
    goal('overtake', { third: 3, elapsedSeconds: 1140, concedingTeamId: 'yellow' })];
  const comeback = evaluate(match(comebackGoals));
  assert.equal(count(comeback.state, 'hail-mary'), 1); assert.equal(count(comeback.state, 'comeback-crew'), 1);
  const finalLoss = evaluate(match([...comebackGoals, own('lose', 'red', { third: 3, elapsedSeconds: 1200 })]));
  assert.equal(count(finalLoss.state, 'hail-mary'), 0); assert.equal(count(finalLoss.state, 'comeback-crew'), 0);
  const teammate = applyAppearance(emptyAccumulator(), match(comebackGoals), 'red-mate', 'career');
  assert.equal(count(teammate.state, 'comeback-crew'), 1, 'whole eligible roster earns the team feat');
});

test('Hail Mary uses event scoring team after the scorer is reassigned on the final roster', () => {
  const facts = match([goal('late', { third: 3, elapsedSeconds: 1140 })]);
  facts.roster[0].teamId = 'blue';
  const { state, appearance } = evaluate(facts);
  assert.equal(appearance?.outcome, 'loss'); assert.equal(count(state, 'hail-mary'), 1);
  assert.equal(count(state, 'comeback-crew'), 0);
});

test('unknown timing keeps aggregate credit but marks potentially affected progress partial', () => {
  const facts = match([goal('uncertain', { timing: 'unknown', third: 2, elapsedSeconds: 500 })]);
  const { state } = evaluate(facts);
  assert.equal(count(state, 'goal'), 1); assert.equal(count(state, 'wins'), 1); assert.equal(count(state, 'lockdown'), 1);
  const progress = progressFor(state);
  for (const id of ['message-sent', 'speedy', 'clutch', 'momentum-play', 'hail-mary',
    'desperate-defence', 'comeback-crew', 'triple-threat', 'team-engine'] as const) {
    assert.equal(count(state, id), 0, id);
    assert.equal(progress.find(value => value.achievementId === id)?.assessability, 'partial', id);
  }
  assert.equal(progress.find(value => value.achievementId === 'goal')?.assessability, 'complete');
  assert.equal(count(state, 'defence'), 3, 'no team concessions proves all three clean thirds');
  assert.equal(progress.find(value => value.achievementId === 'defence')?.assessability, 'complete');
});

test('post-completion additions cannot earn timed badges or lead transitions; provable clean thirds remain', () => {
  const { state } = evaluate(match([goal('added-after', { timing: 'post_completion', third: 3, elapsedSeconds: 1200,
    createdAt: '2026-01-02T10:00:00.000Z' })]));
  assert.equal(count(state, 'goal'), 1); assert.equal(count(state, 'wins'), 1);
  for (const id of ['clutch', 'hail-mary', 'speedy', 'message-sent', 'momentum-play', 'desperate-defence', 'comeback-crew'] as const)
    assert.equal(count(state, id), 0, id);
  assert.equal(count(state, 'defence'), 3, 'opponent timing cannot spoil the team’s provable clean thirds');
  assert.equal(progressFor(state).find(value => value.achievementId === 'clutch')?.assessability, 'complete', 'known ineligible additions are not invented live events');
});

test('ambiguous same-time event order never invents Hail Mary, while reliable individual timing still earns Clutch', () => {
  const { state } = evaluate(match([
    goal('late-a', { third: 3, elapsedSeconds: 1140 }),
    goal('late-b', { third: 3, elapsedSeconds: 1140, concedingTeamId: 'yellow' })
  ]));
  assert.equal(count(state, 'clutch'), 2); assert.equal(count(state, 'hail-mary'), 0);
  assert.ok(state.uncertain.includes('hail-mary'));
});

test('ten scoring appearances earn two On Fire and Unbeaten milestones, and assisting runs reset every three', () => {
  let state = emptyAccumulator();
  const awards: ReturnType<typeof applyAppearance>['unlocks'] = [];
  for (let number = 1; number <= 10; number++) {
    const result = applyAppearance(state, numbered(number, [goal('goal'),
      goal('assist', { scorerPlayerId: 'red-mate', assistPlayerIds: [player] })],
    { seasonId: number <= 4 ? 'winter' : 'summer' }), player, 'career');
    state = result.state; awards.push(...result.unlocks);
    if (number === 4) { assert.equal(count(state, 'on-fire'), 0); assert.equal(state.runs['on-fire'], 4); }
    if (number === 5) { assert.equal(count(state, 'on-fire'), 1); assert.equal(state.runs['on-fire'], 0); }
  }
  assert.equal(count(state, 'on-fire'), 2); assert.equal(count(state, 'helping-hand'), 3); assert.equal(count(state, 'unbeaten-run'), 2);
  assert.equal(state.runs['on-fire'], 0); assert.equal(state.runs['helping-hand'], 1); assert.equal(state.runs['unbeaten-run'], 0);
  assert.equal(awards.filter(value => value.achievementId === 'unbeaten-run').length, 2);
  assert.equal(awards.filter(value => value.achievementId === 'on-fire').length, 1, 'Rare count two has only crossed its first milestone');
});

test('missed fixtures do not break appearance streaks but a goalless losing appearance resets them', () => {
  let state = emptyAccumulator();
  for (const number of [1, 2]) state = applyAppearance(state, numbered(number, [goal('goal'),
    goal('assist', { scorerPlayerId: 'red-mate', assistPlayerIds: [player] })]), player, 'career').state;
  state = applyAppearance(state, numbered(3, [], { roster: [] }), player, 'career').state;
  assert.deepEqual(state.runs, { 'on-fire': 2, 'helping-hand': 2, 'unbeaten-run': 2 });
  state = applyAppearance(state, numbered(4, [own('loss', 'red')]), player, 'career').state;
  assert.deepEqual(state.runs, { 'on-fire': 0, 'helping-hand': 0, 'unbeaten-run': 0 });
  assert.equal(state.totals.played, 3);
  state = applyAppearance(state, numbered(5), player, 'career').state;
  assert.equal(state.runs['unbeaten-run'], 1, 'a draw qualifies for the new unbeaten run');
});

test('season accumulators cannot carry a streak into a different season', () => {
  const winter = applyAppearance(emptyAccumulator(), numbered(1, [goal('goal')]), player, 'season').state;
  assert.throws(() => applyAppearance(winter, numbered(2, [goal('goal')], { seasonId: 'summer' }), player, 'season'), /context mismatch/);
  const summer = applyAppearance(emptyAccumulator(), numbered(2, [goal('goal')], { seasonId: 'summer' }), player, 'season').state;
  assert.equal(summer.runs['on-fire'], 1); assert.equal(summer.totals.played, 1);
});

test('canonical context and chronological cursor reject duplicates, revisions, earlier matches and mixed identities', () => {
  const facts = numbered(2, [goal('goal')]);
  const state = evaluate(facts).state;
  for (const changed of [facts, { ...facts, sourceRevision: 'corrected' }, numbered(1),
    { ...facts, kickoffAt: '2026-01-02T10:05:00.000Z' }])
    assert.throws(() => applyAppearance(state, changed, player, 'career'), /out-of-order/);
  assert.throws(() => applyAppearance(state, numbered(3), 'alias/not-canonical', 'career'), /context mismatch/);
  assert.throws(() => applyAppearance(state, numbered(3, [], { leagueId: 'other-league' }), player, 'career'), /context mismatch/);
  assert.throws(() => applyAppearance(state, numbered(3), player, 'season'), /context mismatch/);
  const sameKickoffNextId = applyAppearance(state, { ...facts, gameId: 'game-003' }, player, 'career');
  assert.equal(sameKickoffNextId.state.totals.played, 2);
  assert.throws(() => applyAppearance(sameKickoffNextId.state, facts, player, 'career'), /out-of-order/);
});

test('persisted history and evaluator use bounded UTC kickoff and stable game digest ordering', () => {
  const facts = numbered(2);
  assert.equal(matchOrderKey(facts), '2026-01-02T10:00:00.000Z#20ed8d343cf7e6642340fad992e0b246183d148b8dd67669e863a6d16e3d2607');
  assert.equal(matchOrderKey({ ...facts, kickoffAt: '2026-01-02T21:00:00+11:00' }), matchOrderKey(facts));
  assert.equal(compareMatchOrder(facts, { ...facts, gameId: 'game-003' }), -1);
  assert.equal(compareMatchOrder(facts, facts), 0);
  assert.equal(compareMatchOrder(numbered(3), facts), 1);
  assert.equal(Buffer.byteLength(matchOrderKey({ ...facts, gameId: '試合/#'.repeat(1000) })), 89);
});

test('invalid canonical facts fail before awarding or mutating the checkpoint', () => {
  const baseline = emptyAccumulator(), snapshot = structuredClone(baseline);
  const invalid = [
    match([], { roster: [{ playerId: player, teamId: 'red' }, { playerId: player, teamId: 'blue' }] }),
    match([goal('duplicate'), goal('duplicate')]), match([goal('missing-time', { elapsedSeconds: null })]),
    match([goal('missing-end')], { thirdEndsSeconds: [null, 1260, 1260] }),
    match([goal('late-live', { createdAt: '2026-01-02T10:00:00.000Z' })]),
    match([goal('missing-live-creation', { createdAt: null })]),
    match([goal('self-assist', { assistPlayerIds: [player] })]),
    match([goal('same-team', { concedingTeamId: 'red' })]), match([goal('bad-og', { ownGoal: true })]),
    match([], { finishedAt: '2026-01-01T09:00:00.000Z' })
  ];
  for (const facts of invalid) assert.throws(() => applyAppearance(baseline, facts, player, 'career'));
  assert.deepEqual(baseline, snapshot);
});

test('rebuilds preserve milestone identity across corrected earning dates and invalidate missing milestones', () => {
  const originalFacts = numbered(1, [goal('goal')]);
  const original = evaluate(originalFacts), replay = evaluate(structuredClone(originalFacts));
  assert.deepEqual(replay, original, 'same canonical facts are deterministic');
  const removed = evaluate({ ...originalFacts, goals: [], sourceRevision: 'revision-2' });
  assert.equal(removed.state.highest.goal, undefined);
  assert.equal(removed.unlocks.filter(value => value.achievementId === 'goal').length, 0);
  const earnedLater = applyAppearance(removed.state, numbered(2, [goal('replacement')]), player, 'career');
  const before = original.unlocks.find(value => value.achievementId === 'goal')!;
  const after = earnedLater.unlocks.find(value => value.achievementId === 'goal')!;
  assert.equal(before.id, after.id); assert.notEqual(before.earnedAt, after.earnedAt);
  assert.equal(after.earnedAt, '2026-01-02T11:10:00.000Z');
  assert.equal(after.gameId, 'game-002'); assert.equal(after.sourceRevision, 'revision-1');
  const restored = evaluate({ ...originalFacts, sourceRevision: 'revision-3' });
  assert.equal(restored.state.highest.goal?.id, before.id);
  assert.notEqual(stableUnlockId(player, 'league', { scope: 'career', seasonId: null }, 'goal', 1),
    stableUnlockId(player, 'league', { scope: 'season', seasonId: 'winter' }, 'goal', 1));
  assert.notEqual(before.id, stableUnlockId(player, 'another-league', { scope: 'career', seasonId: null }, 'goal', 1));
});

test('evaluation and safe progress projection do not mutate caller facts, prior state or expose evidence revisions', () => {
  const facts = match([goal('z', { elapsedSeconds: 600 }), goal('a', { elapsedSeconds: 300 })]);
  const prior = emptyAccumulator(), factsCopy = structuredClone(facts), priorCopy = structuredClone(prior);
  const result = applyAppearance(prior, facts, player, 'season');
  assert.deepEqual(facts, factsCopy); assert.deepEqual(prior, priorCopy);
  const award = result.unlocks.find(value => value.achievementId === 'goal')!;
  assert.equal(award.ruleVersion, 1); assert.equal(award.sourceRevision, 'revision-1');
  const safe = publicUnlock(award);
  assert.equal('sourceRevision' in safe, false); assert.equal('ruleVersion' in safe, false);
  assert.equal(safe.scope, 'season'); assert.equal(safe.seasonId, 'winter');
  const progress = progressFor(result.state).find(value => value.achievementId === 'goal')!;
  assert.equal(progress.count, 2); assert.equal(progress.ordinal, 1); assert.equal(progress.nextThreshold, 5);
  assert.deepEqual(progress.highest, safe);
});


test('unknown timing for a team concession cannot prove which thirds were clean', () => {
  for (const timing of ['unknown', 'post_completion'] as const) {
    const { state } = evaluate(match([own('unplaced-concession', 'red', { timing, third: 2, elapsedSeconds: 600 })]));
    assert.equal(state.totals.ownGoals, 1);
    assert.equal(count(state, 'defence'), 0);
    assert.equal(count(state, 'lockdown'), 0);
    assert.equal(progressFor(state).find(value => value.achievementId === 'defence')?.assessability, 'partial');
  }
});

test('match feat thresholds do not award early and each own goal earns its own collectible', () => {
  const { state, unlocks } = evaluate(match([goal('one'), goal('two'),
    goal('assist-one', { scorerPlayerId: 'red-mate', assistPlayerIds: [player] }),
    goal('assist-two', { scorerPlayerId: 'red-mate', assistPlayerIds: [player] }),
    own('og-one', 'red'), own('og-two', 'red')]));
  assert.equal(count(state, 'hat-trick'), 0); assert.equal(count(state, 'master-provider'), 0);
  assert.equal(count(state, 'own-goal'), 2); assert.equal(state.totals.goals, 2);
  assert.deepEqual(unlocks.filter(value => value.achievementId === 'own-goal').map(value => value.ordinal), [1, 2]);
});


test('equivalent timestamp offsets and reordered checkpoint fields retain canonical ordering and context', () => {
  const first = evaluate(match([goal('goal')])).state;
  const checkpoint = { ...first, context: { ruleVersion: 1, leagueId: 'league', playerId: player,
    seasonId: null, scope: 'career' as const } };
  const second = numbered(2, [goal('goal')], {
    kickoffAt: '2026-01-02T21:00:00+11:00', finishedAt: '2026-01-02T22:10:00+11:00'
  });
  const { state } = applyAppearance(checkpoint, second, player, 'career');
  assert.equal(state.cursor?.kickoffAt, '2026-01-02T10:00:00.000Z');
  assert.equal(state.totals.played, 2);
});

test('proven once-per-match third feats stay certain despite an extra unknown personal event', () => {
  const goals = ([1, 2, 3] as const).flatMap(third => [
    goal(`score-${third}`, { third }),
    goal(`assist-${third}`, { third, scorerPlayerId: 'red-mate', assistPlayerIds: [player] })
  ]);
  goals.push(goal('extra-unknown', { timing: 'unknown', third: null, elapsedSeconds: null }));
  const result = evaluate(match(goals));
  for (const id of ['triple-threat', 'team-engine'] as const) {
    assert.equal(count(result.state, id), 1);
    assert.equal(progressFor(result.state).find(value => value.achievementId === id)?.assessability, 'complete');
  }
});
