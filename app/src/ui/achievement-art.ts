import { ACHIEVEMENT_DEFINITIONS, type AchievementId } from '@3fc/contracts';

/** Only repository-authored vectors enter this renderer; API/user SVG is never used. */
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const star='<path d="M0-5L1.5-1.6L5.2-1.6L2.3.7L3.3 4.6L0 2.3L-3.3 4.6L-2.3.7L-5.2-1.6L-1.5-1.6Z" fill="currentColor" stroke="none"/>';
export function renderBadge(id: AchievementId, n = 0): string {
 const b = ACHIEVEMENT_DEFINITIONS.find(value => value.id === id);
 if (!b || !Number.isSafeInteger(n) || n < 0) throw new Error("Invalid badge artwork request");
 const rank=['Common','Rare','Legendary','Epic'].indexOf(b.rarity);
 let rim='<path d="M80 31L124 49L142 93L124 137L80 155L36 137L18 93L36 49Z" fill="#233c2d" stroke="currentColor" stroke-width="1.6"/><circle cx="80" cy="93" r="55" fill="none" stroke="currentColor" opacity=".28"/>';
 if(rank>=1)rim+='<path d="M80 36L120 53L137 93L120 133L80 150L40 133L23 93L40 53Z" fill="none" stroke="currentColor" stroke-width=".7" opacity=".6"/>';
 if(rank>=2)rim+='<path d="M80 27L85 31L80 35L75 31ZM146 93L142 98L138 93L142 88ZM80 159L75 155L80 151L85 155ZM14 93L18 88L22 93L18 98Z" fill="currentColor"/><path d="M29 39L38 43M122 43L131 39M29 147L38 143M122 143L131 147" stroke="currentColor" opacity=".7"/>';
 if(rank===3)rim+='<path d="M80 21L148 93L80 165L12 93Z" fill="none" stroke="#f2ead1" stroke-width=".8" opacity=".7"/><path d="M29 63L22 59M23 73L13 70M29 123L22 127M23 113L13 116M131 63L138 59M137 73L147 70M131 123L138 127M137 113L147 116" stroke="#f2ead1" stroke-width="1.5"/>';
 let earned='';
 if(n<=5){for(let i=0;i<n;i++){const x=80+(i-(n-1)/2)*16,y=12+Math.abs(i-(n-1)/2)*1.4;earned+=`<g transform="translate(${x} ${y})">${star}</g>`;}}
 else earned=`<g transform="translate(68 12)">${star}</g><text x="79" y="16" fill="currentColor" font-size="12" font-weight="750" font-family="system-ui,sans-serif"${String(n).length > 7 ? ' textLength="68" lengthAdjust="spacingAndGlyphs"' : ''}>${n}</text>`;
 return `<svg class="badge-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 184" width="160" height="184" role="img" aria-label="${esc(b.name)}, ${esc(b.rarity)}, ${n?`${n} milestone${n===1?'':'s'}`:'badge artwork'}" color="#d9b769"><title>${esc(b.name)} · ${n?`${n} milestone${n===1?'':'s'}`:'badge artwork'}</title>${earned}${rim}<g transform="translate(80 93)" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${b.icon}</g><path d="M61 172H99" stroke="currentColor" opacity=".35"/><circle cx="80" cy="172" r="2" fill="currentColor"/></svg>`;
}
