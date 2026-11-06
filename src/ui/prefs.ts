/** Player preferences and the local practice record, kept in localStorage (best effort: private mode keeps defaults). */
export type Difficulty = 'squire' | 'knight' | 'warlord';
export type RealmChoice = 'auto' | 'valhalla' | 'underworld';
export type SoundMode = 'on' | 'fx' | 'off';

export interface Prefs {
  quality: string;
  showFps: boolean;
  still: boolean;      // reduce motion: no banners sweeping, no camera shake, no embers
  realm: RealmChoice;
  difficulty: Difficulty;
  side: 0 | 1;
  sound: SoundMode;    // everything, effects only, or off (S toggles)
  musicVolume: number; // 0..1, music and ambience
  sfxVolume: number;   // 0..1, effects
}

export const SOUND_MODES: Record<SoundMode, string> = { on: 'On', fx: 'Effects only', off: 'Off' };

export interface Record_ {
  wins: number; losses: number; draws: number; streak: number; best: number;
  by: Record<Difficulty, { wins: number; losses: number; draws: number }>;
  history: Array<{ at: number; result: 'win' | 'loss' | 'draw'; difficulty: Difficulty; moves: number; side: 0 | 1 }>;
}

export const DIFFICULTY: Record<Difficulty, { name: string; blurb: string; budgetMs: number; maxDepth: number }> = {
  squire: { name: 'Squire', blurb: 'Learns the board with you', budgetMs: 350, maxDepth: 2 },
  knight: { name: 'Knight', blurb: 'A fair and steady duel', budgetMs: 1000, maxDepth: 4 },
  warlord: { name: 'Warlord', blurb: 'Thinks deep, forgives nothing', budgetMs: 2200, maxDepth: 6 },
};

const KEY = 'rapture-chess.prefs.v1';
const REC = 'rapture-chess.record.v1';
const read = <T>(k: string): Partial<T> => { try { return JSON.parse(localStorage.getItem(k) ?? '{}') as Partial<T>; } catch { return {}; } };
const write = (k: string, v: unknown): void => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const stored = read<Prefs>(KEY);
export const prefs: Prefs = {
  quality: (() => { try { return localStorage.getItem('rapture-chess.quality') ?? 'auto'; } catch { return 'auto'; } })(),
  showFps: stored.showFps ?? false,
  still: stored.still ?? matchMedia('(prefers-reduced-motion: reduce)').matches,
  realm: stored.realm ?? 'auto',
  difficulty: stored.difficulty ?? 'knight',
  side: stored.side ?? 0,
  sound: stored.sound && stored.sound in SOUND_MODES ? stored.sound : 'on',
  musicVolume: typeof stored.musicVolume === 'number' ? Math.min(1, Math.max(0, stored.musicVolume)) : 0.6,
  sfxVolume: typeof stored.sfxVolume === 'number' ? Math.min(1, Math.max(0, stored.sfxVolume)) : 0.9,
};
const listeners: Array<(p: Prefs) => void> = [];
export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
  prefs[k] = v;
  const { quality: _q, ...rest } = prefs;
  write(KEY, rest);
  for (const fn of listeners) fn(prefs);
}
export const onPrefs = (fn: (p: Prefs) => void): void => { listeners.push(fn); };

const blankBy = () => ({ wins: 0, losses: 0, draws: 0 });
export function record(): Record_ {
  const r = read<Record_>(REC);
  return {
    wins: r.wins ?? 0, losses: r.losses ?? 0, draws: r.draws ?? 0, streak: r.streak ?? 0, best: r.best ?? 0,
    by: { squire: r.by?.squire ?? blankBy(), knight: r.by?.knight ?? blankBy(), warlord: r.by?.warlord ?? blankBy() },
    history: r.history ?? [],
  };
}
/** Count a finished practice game against the bot. */
export function recordResult(result: 'win' | 'loss' | 'draw', difficulty: Difficulty, moves: number, side: 0 | 1): Record_ {
  const r = record();
  if (result === 'win') { r.wins++; r.by[difficulty].wins++; r.streak++; r.best = Math.max(r.best, r.streak); }
  else if (result === 'loss') { r.losses++; r.by[difficulty].losses++; r.streak = 0; }
  else { r.draws++; r.by[difficulty].draws++; }
  r.history = [{ at: Date.now(), result, difficulty, moves, side }, ...r.history].slice(0, 20);
  write(REC, r);
  return r;
}
