export const ROSTER_SIZE = 14;
export const BENCH_SIZE = 6;
export const IR_SIZE = 2;
export const DRAFT_ROUNDS = 14;
export const DRAFT_PICKS = 12 * DRAFT_ROUNDS;
export const NFL_CLUBS = [
  ['Phoenix', 'ARI'],
  ['Atlanta', 'ATL'],
  ['Baltimore', 'BAL'],
  ['Buffalo', 'BUF'],
  ['Charlotte', 'CAR'],
  ['Chicago', 'CHI'],
  ['Cincinnati', 'CIN'],
  ['Cleveland', 'CLE'],
  ['Dallas', 'DAL'],
  ['Denver', 'DEN'],
  ['Detroit', 'DET'],
  ['Green Bay', 'GB'],
  ['Houston', 'HOU'],
  ['Indianapolis', 'IND'],
  ['Jacksonville', 'JAX'],
  ['Kansas City', 'KC'],
  ['Las Vegas', 'LV'],
  ['Los Angeles', 'LAC'],
  ['Los Angeles', 'LAR'],
  ['Miami', 'MIA'],
  ['Minneapolis', 'MIN'],
  ['Boston', 'NE'],
  ['New Orleans', 'NO'],
  ['New York', 'NYG'],
  ['New York', 'NYJ'],
  ['Philadelphia', 'PHI'],
  ['Pittsburgh', 'PIT'],
  ['San Francisco', 'SF'],
  ['Seattle', 'SEA'],
  ['Tampa', 'TB'],
  ['Nashville', 'TEN'],
  ['Washington', 'WAS'],
].map(([city, abbreviation], i) => ({ id: i + 1, city, abbreviation }));
export function clubInfo(id) {
  return (
    NFL_CLUBS.find((c) => c.id === Number(id)) ??
    NFL_CLUBS.find((c) => c.abbreviation === id) ??
    NFL_CLUBS[10]
  );
}
export function hashText(text) {
  let h = 2166136261;
  for (const c of String(text)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled(values, random) {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
