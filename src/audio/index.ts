/** The game's one sound engine, kept in step with the sound settings (src/ui/prefs.ts). */
import { Sound, type SoundLevels } from './sound';
import { onPrefs, prefs, type Prefs } from '../ui/prefs';

const levels = (p: Prefs): Partial<SoundLevels> => ({ muted: p.sound === 'off', music: p.sound === 'fx' ? 0 : p.musicVolume, sfx: p.sfxVolume });

export const sound = new Sound(`${import.meta.env.BASE_URL}audio/`, levels(prefs));
onPrefs((p) => sound.set(levels(p)));
