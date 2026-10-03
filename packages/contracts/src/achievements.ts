/** Approved 3FC collection. Artwork is trusted, authored SVG; never accept user SVG. */
export const ACHIEVEMENT_RULE_VERSION = 1;
export const ACHIEVEMENT_DEFINITIONS = [
  {
    "id": "goal",
    "name": "Goal",
    "rarity": "Common",
    "rule": "Score a credited goal. Own goals do not count.",
    "icon": "<path d=\"M-25-16H25V18H-25ZM-13-16V18M0-16V18M13-16V18M-25-5H25M-25 6H25M-31-22L-25-16M31-22L25-16M-31 25L-25 18M31 25L25 18\" stroke-width=\"1.4\" opacity=\".5\"/><path d=\"M-31 25V-22H31V25M-35 25H35\"/><g transform=\"translate(5 12) scale(1.05)\"><circle r=\"9\" fill=\"#233c2d\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g>"
  },
  {
    "id": "played",
    "name": "Played",
    "rarity": "Common",
    "rule": "Be rostered on a team in a completed match.",
    "icon": "<path d=\"M-16-28H16L32 0L16 28H-16L-32 0Z\"/><path d=\"M0-28V0L24 14M0 0L-24 14\"/><circle r=\"6\"/><g transform=\"rotate(0)\"><path d=\"M-5 28V23H5V28M-10 28A10 10 0 0 1 10 28\"/></g><g transform=\"rotate(120)\"><path d=\"M-5 28V23H5V28M-10 28A10 10 0 0 1 10 28\"/></g><g transform=\"rotate(240)\"><path d=\"M-5 28V23H5V28M-10 28A10 10 0 0 1 10 28\"/></g>"
  },
  {
    "id": "assist",
    "name": "Assist",
    "rarity": "Common",
    "rule": "Receive a credited assist on another player’s goal.",
    "icon": "<circle cx=\"-24\" cy=\"17\" r=\"6\"/><circle cx=\"17\" cy=\"-20\" r=\"6\"/><path d=\"M-24 5V-4Q-24-20-8-20H4M17-8V11\"/><path d=\"M-2.00 -14.00L4 -20L-2.00 -26.00\"/><path d=\"M11.00 5.00L17 11L23.00 5.00\"/><g transform=\"translate(17 27) scale(0.8)\"><circle r=\"9\" fill=\"#233c2d\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g>"
  },
  {
    "id": "wins",
    "name": "Wins",
    "rarity": "Rare",
    "rule": "Be on the team that wins a completed match.",
    "icon": "<path d=\"M-16-27H16V-9Q16 9 0 12Q-16 9-16-9ZM-16-20H-27V-10Q-27 1-14 1M16-20H27V-10Q27 1 14 1M0 12V26M-14 28H14\"/>"
  },
  {
    "id": "draw",
    "name": "Draw",
    "rarity": "Rare",
    "rule": "Be on a team awarded a draw at the end of a completed match.",
    "icon": "<path d=\"M0-23V29M-12 29H12M-26-13H26M-24-13L-34 8H-14L-24-13M24-13L14 8H34L24-13M-34 8Q-24 23-14 8M14 8Q24 23 34 8\"/><circle cy=\"-25\" r=\"3\" fill=\"#233c2d\"/>"
  },
  {
    "id": "own-goal",
    "name": "Own Goal",
    "rarity": "Legendary",
    "rule": "Score an own goal. A humorous collectible.",
    "icon": "<text x=\"0\" y=\"12\" text-anchor=\"middle\" fill=\"currentColor\" stroke=\"none\" font-size=\"36\" font-weight=\"900\" letter-spacing=\"-3\">OG</text><path d=\"M26-23C17-37-8-37-24-23M-15 25Q3 34 20 23\"/><path d=\"M-22.02 -31.37L-24 -23L-15.44 -23.85\"/>"
  },
  {
    "id": "defence",
    "name": "Defence",
    "rarity": "Rare",
    "rule": "Concede zero in a completed third. At its start, be less than two conceded goals behind each opponent.",
    "icon": "<path d=\"M-33-24Q0-35 33-24V7Q32 27 0 35Q-32 27-33 7Z\" opacity=\".45\"/><path d=\"M-29-11H29V24H-29ZM-29 1H29M-29 13H29M-10-11V1M10-11V1M-20 1V13M0 1V13M20 1V13M-10 13V24M10 13V24\"/>"
  },
  {
    "id": "desperate-defence",
    "name": "Desperate Defence",
    "rarity": "Legendary",
    "rule": "Lead outright entering the final third, concede zero in that third, and finish as outright winners.",
    "icon": "<path d=\"M-29-25H27V29H-29ZM-29-25L-23-31H33V23L27 29M27-25L33-31\"/><path d=\"M-29 -16H27\" stroke-width=\"1.5\"/><path d=\"M-29 -7H27\" stroke-width=\"1.5\"/><path d=\"M-29 2H27\" stroke-width=\"1.5\"/><path d=\"M-29 11H27\" stroke-width=\"1.5\"/><path d=\"M-29 20H27\" stroke-width=\"1.5\"/><path d=\"M-10 -25V-16\" stroke-width=\"1.5\"/><path d=\"M9 -25V-16\" stroke-width=\"1.5\"/><path d=\"M-20 -16V-7\" stroke-width=\"1.5\"/><path d=\"M-1 -16V-7\" stroke-width=\"1.5\"/><path d=\"M18 -16V-7\" stroke-width=\"1.5\"/><path d=\"M-10 -7V2\" stroke-width=\"1.5\"/><path d=\"M9 -7V2\" stroke-width=\"1.5\"/><path d=\"M-20 2V11\" stroke-width=\"1.5\"/><path d=\"M-1 2V11\" stroke-width=\"1.5\"/><path d=\"M18 2V11\" stroke-width=\"1.5\"/><path d=\"M-10 11V20\" stroke-width=\"1.5\"/><path d=\"M9 11V20\" stroke-width=\"1.5\"/><path d=\"M-20 20V29\" stroke-width=\"1.5\"/><path d=\"M-1 20V29\" stroke-width=\"1.5\"/><path d=\"M18 20V29\" stroke-width=\"1.5\"/>"
  },
  {
    "id": "momentum-play",
    "name": "Momentum Play",
    "rarity": "Rare",
    "rule": "Score in third one or two from the final minute of regulation through stoppage time.",
    "icon": "<path d=\"M-31-14L31 16M-12 28L0 1L12 28ZM-27 28H27\"/><g transform=\"translate(24.12 2.17) scale(1.05)\"><circle r=\"9\" fill=\"#233c2d\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g>"
  },
  {
    "id": "clutch",
    "name": "Clutch",
    "rarity": "Rare",
    "rule": "Score in the final third from the final minute of regulation through stoppage time.",
    "icon": "<circle cy=\"4\" r=\"28\"/><path d=\"M-7-37H7M0-37V-24M21-15L26-20M23-23L29-17M0-20V-16M24 4H20M0 28V24M-24 4H-20\"/><path d=\"M0-17A21 21 0 1 0 5.44-16.29\" stroke-width=\"1.3\" opacity=\".45\"/><path d=\"M0 4L6-18\" stroke-width=\"2.8\"/><circle cy=\"4\" r=\"2.5\" fill=\"currentColor\"/>"
  },
  {
    "id": "hail-mary",
    "name": "Hail Mary",
    "rarity": "Legendary",
    "rule": "Score in the final-minute window to move your team from losing or drawing to outright first, and finish the match as outright winners.",
    "icon": "<g transform=\"translate(15 16) scale(.55)\"><path d=\"M-25-16H25V18H-25ZM-13-16V18M0-16V18M13-16V18M-25-5H25M-25 6H25M-31-22L-25-16M31-22L25-16M-31 25L-25 18M31 25L25 18\" stroke-width=\"1.4\" opacity=\".5\"/><path d=\"M-31 25V-22H31V25M-35 25H35\"/></g><path d=\"M-29 2C-25-37 17-39 17 13\" stroke=\"#233c2d\" stroke-width=\"6\"/><path d=\"M-29 2C-25-37 17-39 17 13\"/><path d=\"M12.00 6.00L17 13L22.00 6.00\"/><g transform=\"translate(-29 15) scale(0.85)\"><circle r=\"9\" fill=\"#233c2d\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g>"
  },
  {
    "id": "speedy",
    "name": "Speedy",
    "rarity": "Rare",
    "rule": "Score before 02:00 in the second or third third.",
    "icon": "<g data-motion-lines=\"3\"><path d=\"M-27 -10H-12\"/><path d=\"M-35 0H-12\"/><path d=\"M-27 10H-12\"/></g><path d=\"M17-25H32V25H17\"/><g transform=\"translate(4 0) scale(1.25)\" ><circle r=\"9\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g>"
  },
  {
    "id": "message-sent",
    "name": "Message Sent",
    "rarity": "Rare",
    "rule": "Score before 02:00 in the first third.",
    "icon": "<g data-motion-lines=\"5\" fill=\"currentColor\" stroke=\"none\"><path d=\"M-31-17Q-20-14-5-10L-6-7Q-21-11-31-17Z\"/><path d=\"M-43-10Q-23-9-9-5L-10-2Q-26-6-43-10Z\"/><path d=\"M-46 0L-11-1.8V1.8Z\"/><path d=\"M-40 10Q-24 8-9 5L-10 2Q-25 6-40 10Z\"/><path d=\"M-31 17Q-20 14-5 10L-6 7Q-21 11-31 17Z\"/></g><path d=\"M17-25H32V25H17\"/><g transform=\"translate(4 0) scale(1.25)\" ><circle r=\"9\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g>"
  },
  {
    "id": "hat-trick",
    "name": "Hat-trick",
    "rarity": "Rare",
    "rule": "Score at least three goals in one completed match. One occurrence per match.",
    "icon": "<g transform=\"translate(0 -17) scale(1.05)\"><circle r=\"9\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g><g transform=\"translate(-18 16) scale(1.05)\"><circle r=\"9\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g><g transform=\"translate(18 16) scale(1.05)\"><circle r=\"9\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g>"
  },
  {
    "id": "master-provider",
    "name": "Master Provider",
    "rarity": "Rare",
    "rule": "Record at least three assists in one completed match. One occurrence per match.",
    "icon": "<circle r=\"7\"/><path d=\"M0-12V-29M-6-23L0-29L6-23M-11 7L-28 20M-27 12L-28 20L-20 21M11 7L28 20M20 21L28 20L27 12\"/><circle cx=\"0\" cy=\"-35\" r=\"3\"/><circle cx=\"-33\" cy=\"25\" r=\"3\"/><circle cx=\"33\" cy=\"25\" r=\"3\"/>"
  },
  {
    "id": "double-threat",
    "name": "Double Threat",
    "rarity": "Rare",
    "rule": "Record a goal and an assist in one completed match. One occurrence per match.",
    "icon": "<path d=\"M0-32V32\" opacity=\".5\"/><path d=\"M-29-13H-5M-29-13V18H-5M-17-13V18M-29-3H-5M-29 8H-5M-34-18L-29-13M-34 24L-29 18\" opacity=\".5\" stroke-width=\"1.4\"/><path d=\"M-34 24V-18H-5M-37 24H-5\"/><g transform=\"translate(-17 12) scale(0.8)\"><circle r=\"9\" fill=\"#233c2d\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g><g transform=\"translate(23 0) scale(.62)\" stroke-width=\"3.3\"><circle cx=\"-24\" cy=\"17\" r=\"6\"/><circle cx=\"17\" cy=\"-20\" r=\"6\"/><path d=\"M-24 5V-4Q-24-20-8-20H4M17-8V11\"/><path d=\"M-2.00 -14.00L4 -20L-2.00 -26.00\"/><path d=\"M11.00 5.00L17 11L23.00 5.00\"/><g transform=\"translate(17 27) scale(0.8)\"><circle r=\"9\" fill=\"#233c2d\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g></g>"
  },
  {
    "id": "triple-threat",
    "name": "Triple Threat",
    "rarity": "Legendary",
    "rule": "Score in all three thirds of one completed match. One occurrence per match.",
    "icon": "<path d=\"M-17-30H17L35 0L17 30H-17L-35 0ZM0-30V0L26 15M0 0L-26 15\"/><g transform=\"translate(-16 -9) scale(0.75)\"><circle r=\"9\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g><g transform=\"translate(16 -9) scale(0.75)\"><circle r=\"9\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g><g transform=\"translate(0 19) scale(0.75)\"><circle r=\"9\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g>"
  },
  {
    "id": "lockdown",
    "name": "Lockdown",
    "rarity": "Epic",
    "rule": "Be on a team that concedes zero across the entire completed match. One occurrence per match.",
    "icon": "<path d=\"M-17-30H17L35 0L17 30H-17L-35 0Z\" opacity=\".55\"/><path d=\"M-14-4V-16A14 14 0 0 1 14-16V-4M-22-4H22V27H-22Z\"/><circle cy=\"9\" r=\"4\"/><path d=\"M0 13V19\"/>"
  },
  {
    "id": "comeback-crew",
    "name": "Comeback Crew",
    "rarity": "Legendary",
    "rule": "Enter the final third outside the lead, then win the match outright. Award to the eligible team once per match.",
    "icon": "<path d=\"M-4-16Q-8-25 0-28Q6-28 7-23L14-20L6-17L5-8L34-27L27-6L17 8L7 13L12 29L0 22L-12 29L-7 13L-17 8L-27-6L-34-27L-5-8ZM-27-6L-12-2M27-6L12-2M-17 8L-7 5M17 8L7 5M0 22V4\"/>"
  },
  {
    "id": "team-engine",
    "name": "Team Engine",
    "rarity": "Legendary",
    "rule": "Record at least one goal and one assist in each third of a match. One occurrence per match.",
    "icon": "<g transform=\"translate(0 -17)\"><path d=\"M11.09,-4.59L11.69,-2.70L16.54,-2.92L16.54,2.92L11.69,2.70L11.09,4.59L11.09,4.59L10.18,6.36L13.76,9.64L9.64,13.76L6.36,10.18L4.59,11.09L4.59,11.09L2.70,11.69L2.92,16.54L-2.92,16.54L-2.70,11.69L-4.59,11.09L-4.59,11.09L-6.36,10.18L-9.64,13.76L-13.76,9.64L-10.18,6.36L-11.09,4.59L-11.09,4.59L-11.69,2.70L-16.54,2.92L-16.54,-2.92L-11.69,-2.70L-11.09,-4.59L-11.09,-4.59L-10.18,-6.36L-13.76,-9.64L-9.64,-13.76L-6.36,-10.18L-4.59,-11.09L-4.59,-11.09L-2.70,-11.69L-2.92,-16.54L2.92,-16.54L2.70,-11.69L4.59,-11.09L4.59,-11.09L6.36,-10.18L9.64,-13.76L13.76,-9.64L10.18,-6.36L11.09,-4.59Z\" stroke-width=\"1.9\"/><circle r=\"4.5\" stroke-width=\"1.9\"/></g><g transform=\"translate(-17 12)\"><path d=\"M12.00,0.00L11.84,1.98L16.40,3.64L14.17,9.03L9.77,6.97L8.49,8.49L8.49,8.49L6.97,9.77L9.03,14.17L3.64,16.40L1.98,11.84L0.00,12.00L0.00,12.00L-1.98,11.84L-3.64,16.40L-9.03,14.17L-6.97,9.77L-8.49,8.49L-8.49,8.49L-9.77,6.97L-14.17,9.03L-16.40,3.64L-11.84,1.98L-12.00,0.00L-12.00,0.00L-11.84,-1.98L-16.40,-3.64L-14.17,-9.03L-9.77,-6.97L-8.49,-8.49L-8.49,-8.49L-6.97,-9.77L-9.03,-14.17L-3.64,-16.40L-1.98,-11.84L-0.00,-12.00L-0.00,-12.00L1.98,-11.84L3.64,-16.40L9.03,-14.17L6.97,-9.77L8.49,-8.49L8.49,-8.49L9.77,-6.97L14.17,-9.03L16.40,-3.64L11.84,-1.98L12.00,-0.00Z\" stroke-width=\"1.9\"/><circle r=\"4.5\" stroke-width=\"1.9\"/></g><g transform=\"translate(17 12)\"><path d=\"M8.49,-8.49L9.77,-6.97L14.17,-9.03L16.40,-3.64L11.84,-1.98L12.00,0.00L12.00,0.00L11.84,1.98L16.40,3.64L14.17,9.03L9.77,6.97L8.49,8.49L8.49,8.49L6.97,9.77L9.03,14.17L3.64,16.40L1.98,11.84L0.00,12.00L0.00,12.00L-1.98,11.84L-3.64,16.40L-9.03,14.17L-6.97,9.77L-8.49,8.49L-8.49,8.49L-9.77,6.97L-14.17,9.03L-16.40,3.64L-11.84,1.98L-12.00,0.00L-12.00,0.00L-11.84,-1.98L-16.40,-3.64L-14.17,-9.03L-9.77,-6.97L-8.49,-8.49L-8.49,-8.49L-6.97,-9.77L-9.03,-14.17L-3.64,-16.40L-1.98,-11.84L-0.00,-12.00L-0.00,-12.00L1.98,-11.84L3.64,-16.40L9.03,-14.17L6.97,-9.77L8.49,-8.49Z\" stroke-width=\"1.9\"/><circle r=\"4.5\" stroke-width=\"1.9\"/></g>"
  },
  {
    "id": "on-fire",
    "name": "On Fire",
    "rarity": "Rare",
    "rule": "Score in five consecutive personal appearances. Award once, reset, and build a fresh run.",
    "icon": "<path d=\"M-5 21C-30 10-23-6-9-13C-12-1-1-6 0-30C23-14 30 5 15 21C19 7 10 3 8-5C7 9-9 7-5 21Z\"/><g transform=\"translate(5 18) scale(1.05)\"><circle r=\"9\" fill=\"#233c2d\"/><path d=\"M0-4L4-1L3 4H-3L-4-1ZM0-4V-9M4-1L9-3M3 4L5 7M-3 4L-5 7M-4-1L-9-3\"/></g>"
  },
  {
    "id": "helping-hand",
    "name": "Helping Hand",
    "rarity": "Rare",
    "rule": "Assist in three consecutive personal appearances. Award once, reset, and build a fresh run.",
    "icon": "<path d=\"M-35 5L-25 9V21L-35 25ZM-25 9L-16 2H-4L4 9H14Q19 9 19 14L29 4Q32 1 35 4Q37 7 33 11L15 28H-9L-25 21M19 14Q18 19 13 19H0M-18-17H23\"/><path d=\"M15.00 -9.00L23 -17L15.00 -25.00\"/>"
  },
  {
    "id": "unbeaten-run",
    "name": "Unbeaten Run",
    "rarity": "Legendary",
    "rule": "Win or draw in five consecutive personal appearances. Award once, reset, and build a fresh run.",
    "icon": "<g transform=\"rotate(-35)\"><rect x=\"-34\" y=\"-10\" width=\"28\" height=\"20\" rx=\"10\"/><rect x=\"6\" y=\"-10\" width=\"28\" height=\"20\" rx=\"10\"/><rect x=\"-14\" y=\"-10\" width=\"28\" height=\"20\" rx=\"10\" stroke=\"#233c2d\" stroke-width=\"6\"/><rect x=\"-14\" y=\"-10\" width=\"28\" height=\"20\" rx=\"10\"/></g>"
  }
] as const;
export type AchievementId = typeof ACHIEVEMENT_DEFINITIONS[number]["id"];
export type AchievementRarity = typeof ACHIEVEMENT_DEFINITIONS[number]["rarity"];
export type AchievementScope = "season" | "career";
export const COMMON_MILESTONES = [1, 5, 10, 25, 50, 100, 150, 200] as const;
export const RARE_MILESTONES = [1, 3, 5, 10, 15, 20, 30] as const;
export function milestoneThreshold(rarity: AchievementRarity, ordinal: number): number {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("Invalid milestone ordinal");
  const scale = rarity === "Common" ? COMMON_MILESTONES : rarity === "Rare" ? RARE_MILESTONES : null;
  const value = scale ? scale[ordinal - 1] ?? scale[scale.length - 1] + (ordinal - scale.length) * (rarity === "Common" ? 100 : 10) : ordinal;
  if (!Number.isSafeInteger(value)) throw new Error("Milestone exceeds safe range");
  return value;
}
export function milestoneOrdinal(rarity: AchievementRarity, count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid achievement count");
  const scale = rarity === "Common" ? COMMON_MILESTONES : rarity === "Rare" ? RARE_MILESTONES : null;
  if (!scale) return count;
  return count <= scale[scale.length - 1] ? scale.filter(value => value <= count).length
    : scale.length + Math.floor((count - scale[scale.length - 1]) / (rarity === "Common" ? 100 : 10));
}
export type AchievementScopeContext =
  | { scope: "season"; seasonId: string }
  | { scope: "career"; seasonId: null };
export type AchievementUnlock = AchievementScopeContext & {
  id: string;
  achievementId: AchievementId;
  ordinal: number;
  threshold: number;
  earnedAt: string;
  gameId: string;
}
export interface AchievementProgress {
  achievementId: AchievementId;
  count: number;
  ordinal: number;
  nextThreshold: number;
  assessability: "complete" | "partial";
  currentRun: number | null;
  highest: AchievementUnlock | null;
}
const rarityRank: Record<AchievementRarity, number> = { Epic: 4, Legendary: 3, Rare: 2, Common: 1 };
/** A card groups matching unlocks without discarding their original scope records. */
export type CardHonour = AchievementUnlock & {
  scopes: AchievementScope[];
}
/** One highest milestone per class. Callers supply active awards for the selected period. */
export function selectCardHonours(unlocks: readonly AchievementUnlock[]): CardHonour[] {
  const definitions = new Map(ACHIEVEMENT_DEFINITIONS.map(value => [value.id, value]));
  const byClass = new Map<AchievementId, AchievementUnlock>();
  const compare = (a: AchievementUnlock, b: AchievementUnlock) => b.ordinal - a.ordinal
    || b.earnedAt.localeCompare(a.earnedAt) || a.id.localeCompare(b.id);
  for (const award of unlocks) {
    const prior = byClass.get(award.achievementId);
    if (!prior || compare(award, prior) < 0) byClass.set(award.achievementId, award);
  }
  return [...byClass.values()].sort((a, b) => rarityRank[definitions.get(b.achievementId)!.rarity] - rarityRank[definitions.get(a.achievementId)!.rarity]
    || b.ordinal - a.ordinal || b.earnedAt.localeCompare(a.earnedAt) || a.achievementId.localeCompare(b.achievementId))
    .slice(0, 5).map(award => ({
      ...award,
      scopes: (["season", "career"] as const).filter(scope => unlocks.some(other =>
        other.achievementId === award.achievementId && other.ordinal === award.ordinal
        && other.threshold === award.threshold && other.earnedAt === award.earnedAt
        && other.gameId === award.gameId && other.scope === scope))
    }));
}
