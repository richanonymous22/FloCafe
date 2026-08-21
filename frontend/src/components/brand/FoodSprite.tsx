/**
 * Serva food illustrations — the exact SVG sprite from the reference design,
 * used as a brand flourish on auth/onboarding and (later) the hospitality till.
 * Render <FoodSprite /> once near the root of a page, then use <FoodTile art …/>.
 */

export const FOOD_ARTS = [
  'f-burger', 'f-bowl', 'f-bao', 'f-fries', 'f-shake',
  'f-coffee', 'f-lemon', 'f-sweet', 'f-bites', 'f-salad', 'f-water',
] as const;
export type FoodArt = typeof FOOD_ARTS[number];

export const FOOD_TINTS: { bg: string; fg: string }[] = [
  { bg: '#FFF1E9', fg: '#FF5E00' }, { bg: '#ECF8E7', fg: '#2E8412' },
  { bg: '#FFF6E5', fg: '#8A5B00' }, { bg: '#EEF3FF', fg: '#2A5BD7' },
  { bg: '#F9EFFF', fg: '#8A3FCB' }, { bg: '#FDF0E4', fg: '#C2410C' },
];

export function FoodSprite() {
  return (
    <svg style={{ display: 'none' }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: SPRITE }} />
  );
}

export function FoodTile({ art, bg, className, size = 96 }: { art: FoodArt; bg: string; className?: string; size?: number }) {
  return (
    <span
      className={className}
      style={{ background: bg, width: size, height: size, borderRadius: 18, position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
    >
      <span style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 38%, rgba(255,255,255,.75), transparent 62%)' }} />
      <svg viewBox="0 0 100 100" style={{ position: 'relative', width: '68%', height: '68%', filter: 'drop-shadow(0 6px 10px rgba(26,26,26,.16))' }}>
        <use href={`#${art}`} />
      </svg>
    </span>
  );
}

const SPRITE = `
<symbol id="f-burger" viewBox="0 0 100 100">
 <ellipse cx="50" cy="86" rx="34" ry="5" fill="#1A1A1A" opacity=".1"/>
 <path d="M16 44c0-16 15-27 34-27s34 11 34 27H16Z" fill="#E8A33D"/>
 <path d="M16 44c0-16 15-27 34-27s34 11 34 27H16Z" fill="#F2B857" opacity=".55"/>
 <circle cx="38" cy="31" r="1.9" fill="#FFF1D6"/><circle cx="52" cy="26" r="1.9" fill="#FFF1D6"/>
 <circle cx="63" cy="33" r="1.9" fill="#FFF1D6"/><circle cx="46" cy="37" r="1.9" fill="#FFF1D6"/>
 <path d="M14 45h72c1.6 0 3 1.3 3 3s-1.4 3-3 3H14c-1.6 0-3-1.3-3-3s1.4-3 3-3Z" fill="#7BC043"/>
 <path d="M17 51h66c2 0 3.5 1.6 3.5 3.5S85 58 83 58H17c-2 0-3.5-1.6-3.5-3.5S15 51 17 51Z" fill="#E5484D"/>
 <path d="M18 57h64c2.2 0 4 1.8 4 4s-1.8 4-4 4H18c-2.2 0-4-1.8-4-4s1.8-4 4-4Z" fill="#6B4226"/>
 <path d="M24 56l10 6h12l-6-6h-16Z" fill="#FFC94D"/><path d="M56 56l10 6h10l-8-6H56Z" fill="#FFC94D"/>
 <path d="M18 66h64c0 8-5 12-13 12H31c-8 0-13-4-13-12Z" fill="#D99133"/>
</symbol>
<symbol id="f-bowl" viewBox="0 0 100 100">
 <ellipse cx="50" cy="88" rx="32" ry="5" fill="#1A1A1A" opacity=".1"/>
 <path d="M14 44h72c0 22-16 38-36 38S14 66 14 44Z" fill="#2E2A38"/>
 <path d="M20 47h60c-1 8-4 14-8 18H28c-4-4-7-10-8-18Z" fill="#3D3849"/>
 <path d="M22 44c0-10 12-17 28-17s28 7 28 17H22Z" fill="#F5EFE0"/>
 <path d="M30 40c2-6 9-10 16-10" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".7"/>
 <circle cx="38" cy="36" r="6.5" fill="#FFB833"/><circle cx="38" cy="36" r="3" fill="#FFE9B0"/>
 <path d="M52 30c6 0 11 3 12 8H50c0-4 1-8 2-8Z" fill="#C2410C"/>
 <path d="M66 34c4 1 7 4 8 8h-12c0-4 2-7 4-8Z" fill="#7BC043"/>
</symbol>
<symbol id="f-bao" viewBox="0 0 100 100">
 <ellipse cx="50" cy="86" rx="33" ry="5" fill="#1A1A1A" opacity=".1"/>
 <path d="M8 62c0-14 8-24 20-24s20 10 20 24c0 5-3 8-8 8H16c-5 0-8-3-8-8Z" fill="#F7F1E6"/>
 <path d="M12 58c1-9 7-15 16-15" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round"/>
 <path d="M14 54c3-3 8-4 12-2s9 2 12-1" stroke="#C9B79A" stroke-width="2.4" fill="none" stroke-linecap="round"/>
 <path d="M18 62h20c-1 4-4 6-10 6s-9-2-10-6Z" fill="#C2410C"/>
 <path d="M52 62c0-14 8-24 20-24s20 10 20 24c0 5-3 8-8 8H60c-5 0-8-3-8-8Z" fill="#F7F1E6"/>
 <path d="M56 58c1-9 7-15 16-15" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round"/>
 <path d="M58 54c3-3 8-4 12-2s9 2 12-1" stroke="#C9B79A" stroke-width="2.4" fill="none" stroke-linecap="round"/>
 <path d="M62 62h20c-1 4-4 6-10 6s-9-2-10-6Z" fill="#C2410C"/>
 <path d="M6 70h88c0 6-4 9-10 9H16c-6 0-10-3-10-9Z" fill="#D9CDBB"/>
</symbol>
<symbol id="f-fries" viewBox="0 0 100 100">
 <ellipse cx="50" cy="90" rx="28" ry="4" fill="#1A1A1A" opacity=".1"/>
 <rect x="34" y="14" width="7" height="34" rx="3.5" fill="#F2C14E"/>
 <rect x="44" y="8" width="7" height="40" rx="3.5" fill="#FFD76E"/>
 <rect x="54" y="16" width="7" height="32" rx="3.5" fill="#F2C14E"/>
 <rect x="26" y="22" width="7" height="26" rx="3.5" fill="#FFD76E" transform="rotate(-11 29 35)"/>
 <rect x="63" y="20" width="7" height="28" rx="3.5" fill="#F2C14E" transform="rotate(12 66 34)"/>
 <path d="M28 44h44l-5 40c-.3 3-2.8 5-5.8 5H38.8c-3 0-5.5-2-5.8-5L28 44Z" fill="#FF5E00"/>
 <path d="M31 52h38l-1.2 10H32.2L31 52Z" fill="#fff" opacity=".9"/>
 <path d="M36 55h6M45 55h9" stroke="#FF5E00" stroke-width="2.4" stroke-linecap="round"/>
</symbol>
<symbol id="f-shake" viewBox="0 0 100 100">
 <ellipse cx="50" cy="91" rx="24" ry="4" fill="#1A1A1A" opacity=".1"/>
 <rect x="53" y="6" width="6" height="26" rx="3" fill="#E5484D" transform="rotate(13 56 19)"/>
 <path d="M31 30h38c0 6-8 9-19 9s-19-3-19-9Z" fill="#F7E4D0"/>
 <path d="M34 22c2-8 8-12 16-12s14 4 16 12c-4-4-9-6-16-6s-12 2-16 6Z" fill="#FFF0E0"/>
 <path d="M33 33h34l-4 50c-.2 3-2.6 5-5.6 5H42.6c-3 0-5.4-2-5.6-5l-4-50Z" fill="#F2E3D3"/>
 <path d="M35 40h30l-3.4 42H38.4L35 40Z" fill="#C98A5E"/>
 <path d="M38 46h24l-.8 10H38.8L38 46Z" fill="#E0A97B" opacity=".7"/>
 <circle cx="44" cy="26" r="4" fill="#fff" opacity=".85"/>
</symbol>
<symbol id="f-coffee" viewBox="0 0 100 100">
 <ellipse cx="50" cy="90" rx="30" ry="5" fill="#1A1A1A" opacity=".1"/>
 <path d="M22 30h48l-5 48c-.4 4-3.6 7-7.6 7H34.6c-4 0-7.2-3-7.6-7L22 30Z" fill="#F4F1EC"/>
 <path d="M25 38h42l-3.6 36H28.6L25 38Z" fill="#6B4226"/>
 <path d="M28 42h36l-1 8H29l-1-8Z" fill="#C99B6E"/>
 <path d="M46 44c3-3 8-3 10 0s-2 6-5 6-8-3-5-6Z" fill="#F6E7D4"/>
 <path d="M70 40c8 0 12 5 12 11s-5 11-13 11" stroke="#DDD8D0" stroke-width="6" fill="none" stroke-linecap="round"/>
 <path d="M18 26h56c2 0 3.5 1.6 3.5 3.5S76 33 74 33H18c-2 0-3.5-1.6-3.5-3.5S16 26 18 26Z" fill="#E0DBD2"/>
</symbol>
<symbol id="f-lemon" viewBox="0 0 100 100">
 <ellipse cx="50" cy="92" rx="24" ry="4" fill="#1A1A1A" opacity=".1"/>
 <path d="M30 24h40l-4 60c-.2 4-3.4 7-7.4 7H41.4c-4 0-7.2-3-7.4-7L30 24Z" fill="#EAF4FA" opacity=".85"/>
 <path d="M32 38h36l-3 44c-.2 3-2.6 5-5.6 5H40.6c-3 0-5.4-2-5.6-5L32 38Z" fill="#FFD84D"/>
 <path d="M34 44h32l-1 10H35l-1-10Z" fill="#FFE785"/>
 <circle cx="50" cy="62" r="9" fill="#FFF6C9"/><circle cx="50" cy="62" r="9" fill="none" stroke="#F2B900" stroke-width="2"/>
 <path d="M50 53v18M41 62h18M44 56l12 12M56 56 44 68" stroke="#F2B900" stroke-width="1.6"/>
 <rect x="56" y="10" width="5" height="26" rx="2.5" fill="#40B119" transform="rotate(12 58 23)"/>
</symbol>
<symbol id="f-sweet" viewBox="0 0 100 100">
 <ellipse cx="50" cy="88" rx="30" ry="5" fill="#1A1A1A" opacity=".1"/>
 <path d="M18 50c0-16 14-28 32-28s32 12 32 28v6H18v-6Z" fill="#D9A05B"/>
 <path d="M24 46c2-11 12-18 26-18s24 7 26 18c-6-6-15-9-26-9s-20 3-26 9Z" fill="#E8B776"/>
 <path d="M26 40c4-5 12-8 24-8s20 3 24 8" stroke="#F5D9AE" stroke-width="4" fill="none" stroke-linecap="round"/>
 <path d="M16 56h68c3 0 5 2.2 5 5v8c0 5-4 9-9 9H20c-5 0-9-4-9-9v-8c0-2.8 2-5 5-5Z" fill="#C2410C"/>
 <path d="M20 60h60c1.6 0 3 1.3 3 3s-1.4 3-3 3H20c-1.6 0-3-1.3-3-3s1.4-3 3-3Z" fill="#E06A2B" opacity=".8"/>
</symbol>
<symbol id="f-bites" viewBox="0 0 100 100">
 <ellipse cx="50" cy="88" rx="30" ry="5" fill="#1A1A1A" opacity=".1"/>
 <path d="M20 50h60c0 18-12 30-30 30S20 68 20 50Z" fill="#F1EBE0"/>
 <path d="M24 53h52c-1 6-3 11-6 15H30c-3-4-5-9-6-15Z" fill="#E4DCCD"/>
 <circle cx="36" cy="42" r="11" fill="#E8A33D"/><circle cx="36" cy="42" r="11" fill="#F2B857" opacity=".5"/>
 <circle cx="58" cy="38" r="12" fill="#DE9430"/><circle cx="58" cy="38" r="12" fill="#F2B857" opacity=".4"/>
 <circle cx="48" cy="52" r="10" fill="#E8A33D"/>
</symbol>
<symbol id="f-salad" viewBox="0 0 100 100">
 <ellipse cx="50" cy="88" rx="30" ry="5" fill="#1A1A1A" opacity=".1"/>
 <path d="M18 48h64c0 20-14 34-32 34S18 68 18 48Z" fill="#F1EBE0"/>
 <path d="M24 51h52c-1 7-4 13-8 17H32c-4-4-7-10-8-17Z" fill="#E4DCCD"/>
 <path d="M28 46c2-8 8-13 16-13 4 0 7 1 10 4-6 1-11 4-14 9H28Z" fill="#7BC043"/>
 <path d="M50 46c1-7 7-12 14-12 5 0 9 2 11 6-5 0-10 2-13 6H50Z" fill="#5FA832"/>
 <circle cx="38" cy="42" r="5" fill="#E5484D"/><circle cx="62" cy="43" r="4.5" fill="#E5484D"/>
</symbol>
<symbol id="f-water" viewBox="0 0 100 100">
 <ellipse cx="50" cy="92" rx="20" ry="4" fill="#1A1A1A" opacity=".1"/>
 <rect x="42" y="8" width="16" height="12" rx="3" fill="#3B82F6"/>
 <path d="M40 20h20l4 12v50c0 5-4 8-9 8H45c-5 0-9-3-9-8V32l4-12Z" fill="#DCEBFA"/>
 <path d="M39 38h22v42c0 3-2 5-5 5H44c-3 0-5-2-5-5V38Z" fill="#A9D2F5"/>
 <rect x="38" y="44" width="24" height="18" rx="3" fill="#3B82F6"/>
 <path d="M44 50h12M44 55h8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
</symbol>
`;
