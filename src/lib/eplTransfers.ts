/**
 * lib/eplTransfers.ts
 *
 * Premier League transfer detection via RapidAPI's "Free API Live Football Data" product
 * (free-api-live-football-data.p.rapidapi.com), a FotMob-backed feed.
 *
 * Reuses the CRICBUZZ_API_KEYS rotation pool + fetchCricbuzzWithDeps (cricbuzzClient.ts) against
 * this different host, with its own rotation state -- of the 4 pooled keys, only one is actually
 * subscribed to this product (confirmed empirically: the other 3 return 403 "not subscribed"), but
 * fetchCricbuzzWithDeps already treats any 403 as a rotate-to-next-key signal (it was written for
 * Cricbuzz's quota errors, which share the same status code), so it transparently skips the
 * unsubscribed keys and lands on the working one. A separate rotation state (not the Cricbuzz
 * singleton) keeps this product's exhaustion tracking from cross-contaminating Cricbuzz's -- a key
 * marked "exhausted" here for not being subscribed to this product says nothing about its Cricbuzz
 * quota, and vice versa. Exhaustion is tracked per calendar month (see fetchCricbuzzWithDeps); this
 * product's real quota is per-day, but at a couple of admin-triggered calls a year that mismatch
 * never matters in practice.
 *
 * leagueid=47 was confirmed empirically (not documented) by inspecting a real response: every
 * `fromClub` returned for that id was a current Premier League club (Arsenal, Chelsea, Liverpool,
 * Man City, Man Utd, Spurs, Newcastle, Wolves, etc.) -- there is no reliable "get all leagues"
 * lookup that surfaces this same domestic-league id scheme to confirm it any other way.
 *
 * Free-tier quota for this product is 100 requests/day -- this file's fetchEplTransfers is meant
 * to be called from an admin-triggered "check for transfers" action a couple of times a year (once
 * per transfer window close), not a recurring job, though structuring it as a plain service
 * function here (rather than inline in the route) leaves room to wire it into Agenda later if that
 * changes.
 */

import { fetchCricbuzzWithDeps, parseKeys, type CricbuzzRotationState } from "./cricbuzzClient";

const EPL_LEAGUE_ID = 47;
const EPL_TRANSFERS_HOST = "free-api-live-football-data.p.rapidapi.com";
const rotationState: CricbuzzRotationState = { cursor: 0, exhausted: new Map() };

export interface EplTransfer {
  playerName: string;
  fromClub: string;
  toClub: string;
  transferDate: string;
  feeText: string;
}

interface RawTransfer {
  name?: string;
  fromClubFullName?: string;
  fromClub?: string;
  toClubFullName?: string;
  toClub?: string;
  transferDate?: string;
  fee?: { feeText?: string };
}

export async function fetchEplTransfers(): Promise<EplTransfer[]> {
  const data = (await fetchCricbuzzWithDeps(
    `/football-get-league-transfers?leagueid=${EPL_LEAGUE_ID}`,
    { fetchImpl: fetch, keys: parseKeys(), host: EPL_TRANSFERS_HOST, now: () => new Date() },
    rotationState
  )) as { response?: { transfers?: RawTransfer[] } };
  const transfers = data.response?.transfers ?? [];

  return transfers
    .map((t) => ({
      playerName: String(t.name ?? "").trim(),
      fromClub: String(t.fromClubFullName ?? t.fromClub ?? "").trim(),
      toClub: String(t.toClubFullName ?? t.toClub ?? "").trim(),
      transferDate: String(t.transferDate ?? ""),
      feeText: String(t.fee?.feeText ?? ""),
    }))
    .filter((t) => t.playerName && t.fromClub);
}

// ---------------------------------------------------------------------------
// Club-name reconciliation
// ---------------------------------------------------------------------------

// This provider (FotMob) and this app's own squad data (admin-entered, following ESPN's naming)
// don't always spell a club the same way. Only ~20 clubs exist in a season, so a small hardcoded
// alias table is more reliable than fuzzy string matching -- update when a club is promoted,
// relegated, or renamed. Canonical form is whatever this app's admins actually type into squad
// data (left side); list every other spelling seen from FotMob/ESPN on the right.
const EPL_CLUB_ALIASES: Record<string, string[]> = {
  Arsenal: ["arsenal"],
  "Aston Villa": ["aston villa"],
  Bournemouth: ["bournemouth", "afc bournemouth"],
  Brentford: ["brentford"],
  Brighton: ["brighton", "brighton & hove albion", "brighton and hove albion", "brighton hove albion"],
  Burnley: ["burnley"],
  Chelsea: ["chelsea"],
  "Crystal Palace": ["crystal palace"],
  Everton: ["everton"],
  Fulham: ["fulham"],
  Leeds: ["leeds", "leeds united"],
  Liverpool: ["liverpool"],
  "Manchester City": ["manchester city", "man city"],
  "Manchester United": ["manchester united", "man united", "man utd"],
  "Newcastle United": ["newcastle united", "newcastle"],
  "Nottingham Forest": ["nottingham forest", "notts forest"],
  Sunderland: ["sunderland"],
  Tottenham: ["tottenham", "tottenham hotspur", "spurs"],
  "West Ham United": ["west ham united", "west ham"],
  "Wolverhampton Wanderers": ["wolverhampton wanderers", "wolves"],
};

const CLUB_ALIAS_LOOKUP = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(EPL_CLUB_ALIASES)) {
  for (const alias of aliases) CLUB_ALIAS_LOOKUP.set(alias, canonical);
}

// Resolves any known spelling of an EPL club to this app's canonical name, or null if the club
// isn't one of the ~20 in the alias table (e.g. a transfer's destination club in a different
// league entirely -- expected and not an error).
export function resolveEplClub(name: string): string | null {
  const key = name.trim().toLowerCase();
  return CLUB_ALIAS_LOOKUP.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// Player-name matching
// ---------------------------------------------------------------------------
// Same normalise + surname-anchored scoring approach as lib/cricbuzz.ts's nameMatchScore --
// two independent providers describing the same real person rarely spell it identically
// (diacritics, short vs. full first name), so an exact string compare would silently miss most
// real transfers.

function normalisePlayerName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parts(normalised: string): string[] {
  return normalised.split(" ").filter(Boolean);
}

// 100 = exact normalised match. 90 = every token of the shorter name found in the longer one
// (handles a middle name or an initial difference). 0 = no confident match -- surnames must
// always agree; a surname-only match is never enough (too many false positives).
export function playerNameMatchScore(squadName: string, transferName: string): number {
  const a = normalisePlayerName(squadName);
  const b = normalisePlayerName(transferName);
  if (a === b) return 100;

  const aParts = parts(a);
  const bParts = parts(b);
  if (aParts.length === 0 || bParts.length === 0) return 0;
  if (aParts[aParts.length - 1] !== bParts[bParts.length - 1]) return 0;
  if (aParts.length === 1 || bParts.length === 1) return 0;

  const shorter = aParts.length <= bParts.length ? aParts : bParts;
  const longer = aParts.length <= bParts.length ? bParts : aParts;
  if (shorter.every((tok) => longer.includes(tok))) return 90;

  return 0;
}

// >=90: confident enough to auto-apply. 1-89 (i.e. only reachable state today is exactly 0 or
// >=90 per the scorer above, but the threshold is kept separate from the scorer's own tiers in
// case a middle-confidence tier is added later): surfaced to the admin for manual review instead.
export const TRANSFER_MATCH_CONFIDENT_THRESHOLD = 90;
