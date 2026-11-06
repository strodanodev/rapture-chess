/**
 * The sound engine (the same design as Tessaract's web/lib/sound.js): one AudioContext, a bed bus (music and ambience)
 * and an effects bus under a master with a gentle limiter. Effects are decoded once and played as buffer sources.
 * Music and ambience stream from <audio> elements, two decks each, and loop by crossfading one deck into the other,
 * so no track sits decoded in memory and no loop seam clicks. The library and public/audio/audio.json are built by
 * scripts/audio in the theforge monorepo.
 *
 * Browsers start audio only after a gesture: until the first tap or key press, music() and ambience() remember what
 * should play, and play() is dropped. A hidden tab pauses everything.
 */

export interface SoundLevels { master: number; music: number; sfx: number; muted: boolean }
interface Entry { file: string; kind: 'sfx' | 'music' | 'amb'; gain?: number; vary?: number; loop?: boolean; dur?: number }
interface PlayOpts { gain?: number; delay?: number; rate?: number; pan?: number }

const XFADE = 4;   // seconds a looping track overlaps itself

export class Sound {
  private readonly levels: SoundLevels;
  private meta: Record<string, Entry> = {};
  readonly ready: Promise<Record<string, Entry>>;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private bed!: GainNode;
  private readonly bus: Record<'music' | 'amb' | 'sfx', GainNode> = {} as never;
  private unlocked = false;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
  private readonly lastPlayed = new Map<string, number>();
  private readonly beds: { music: Bed; amb: Bed };

  constructor(private readonly base: string, levels: Partial<SoundLevels> = {}) {
    this.levels = { master: 0.8, music: 0.6, sfx: 0.9, muted: false, ...levels };
    this.ready = fetch(`${base}audio.json`).then((r) => (r.ok ? r.json() : { sounds: {} }))
      .then((m: { sounds?: Record<string, Entry> }) => (this.meta = m.sounds ?? {}))
      .catch(() => this.meta);
    this.beds = { music: new Bed(this, 'music'), amb: new Bed(this, 'amb') };
    const unlock = () => this.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, unlock, { capture: true, passive: true });
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) try { session.type = 'ambient'; } catch { /* older Safari */ }   // mix with the player's own music
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx || !this.unlocked) return;
      if (document.hidden) { this.beds.music.hold(true); this.beds.amb.hold(true); void this.ctx.suspend().catch(() => {}); }
      else { void this.ctx.resume().catch(() => {}); this.beds.music.hold(false); this.beds.amb.hold(false); }
    });
  }

  // ------------------------------------------------------------------ internals the beds use
  get context(): AudioContext | null { return this.ctx; }
  get isUnlocked(): boolean { return this.unlocked; }
  entry(name: string | null): Entry | undefined { return name ? this.meta[name] : undefined; }
  firstOf(kind: Entry['kind']): Entry | undefined { return Object.values(this.meta).find((m) => m.kind === kind); }
  output(kind: 'music' | 'amb'): GainNode { return this.bus[kind]; }
  url(file: string): string { return this.base + file; }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    let ctx: AudioContext;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch { try { ctx = new AC(); } catch { return null; } }
    this.ctx = ctx;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8; limiter.knee.value = 8; limiter.ratio.value = 6; limiter.attack.value = 0.004; limiter.release.value = 0.3;
    this.master = ctx.createGain();
    this.master.connect(limiter).connect(ctx.destination);
    this.bed = ctx.createGain();   // music and ambience pass through here, so a stinger can duck them together
    this.bed.connect(this.master);
    for (const k of ['music', 'amb', 'sfx'] as const) { this.bus[k] = ctx.createGain(); this.bus[k].connect(k === 'sfx' ? this.master : this.bed); }
    this.apply();
    return ctx;
  }

  private apply(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, l = this.levels;
    this.master.gain.setTargetAtTime(l.muted ? 0 : l.master, t, 0.04);
    this.bus.music.gain.setTargetAtTime(l.music, t, 0.04);
    this.bus.amb.gain.setTargetAtTime(l.music, t, 0.04);   // ambience follows the music level: "effects only" is effects only
    this.bus.sfx.gain.setTargetAtTime(l.sfx, t, 0.04);
    const on = !l.muted && l.music > 0;
    this.beds.music.enable(on); this.beds.amb.enable(on);
  }

  private unlock(): void {
    const c = this.ensureContext();
    if (!c) return;
    if (c.state !== 'running' && !document.hidden) void c.resume().catch(() => {});
    this.beds.music.prime(); this.beds.amb.prime();   // iOS lets a media element play only after a gesture has touched it
    if (this.unlocked) return;
    this.unlocked = true;
    void this.preload();
    this.beds.music.kick(); this.beds.amb.kick();
  }

  private load(name: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(name);
    if (have) return Promise.resolve(have);
    let p = this.loading.get(name);
    if (!p) {
      p = (async () => {
        const m = (await this.ready)[name];
        const ctx = this.ctx;
        if (!m || !ctx) return null;
        const res = await fetch(this.base + m.file);
        if (!res.ok) throw new Error(String(res.status));
        const bytes = await res.arrayBuffer();
        const buf = await new Promise<AudioBuffer>((ok, no) => { void ctx.decodeAudioData(bytes, ok, no); });   // the callback form: older Safari
        this.buffers.set(name, buf);
        return buf;
      })().catch(() => { this.loading.delete(name); return null; });
      this.loading.set(name, p);
    }
    return p;
  }
  private async preload(): Promise<void> {
    const names = Object.entries(await this.ready).filter(([, m]) => m.kind === 'sfx').map(([n]) => n);
    for (let i = 0; i < names.length; i += 3) await Promise.all(names.slice(i, i + 3).map((n) => this.load(n)));
  }

  // ------------------------------------------------------------------ the interface
  /** Play an effect. gain multiplies the manifest's; delay in seconds; rate defaults to a random spread (manifest `vary`). */
  play(name: string, { gain = 1, delay = 0, rate, pan = 0 }: PlayOpts = {}): void {
    const ctx = this.ctx, l = this.levels;
    if (!ctx || !this.unlocked || l.muted || l.sfx <= 0 || document.hidden) return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(name) ?? -1e9) < 35) return;   // the same sound twice in one frame is one sound
    this.lastPlayed.set(name, now);
    const go = (buf: AudioBuffer) => {
      const m = this.meta[name] ?? {};
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate ?? 1 + (Math.random() * 2 - 1) * (m.vary ?? 0);
      const g = ctx.createGain();
      g.gain.value = (m.gain ?? 1) * gain;
      src.connect(g);
      if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p).connect(this.bus.sfx); }
      else g.connect(this.bus.sfx);
      src.start(ctx.currentTime + Math.max(0, delay));
    };
    const buf = this.buffers.get(name);
    if (buf) go(buf);
    else void this.load(name).then((b) => { if (b && performance.now() - now < 250) go(b); });   // play it only while still timely
  }
  /** Crossfade to a music track (null: silence). Remembered until audio is unlocked. */
  music(name: string | null, fade = 2.5): void { this.beds.music.set(name, fade); }
  ambience(name: string | null, fade = 3): void { this.beds.amb.set(name, fade); }
  /** Dip the music and ambience (a stinger is playing), then bring them back. */
  duck(depth = 0.35, hold = 2.5, release = 2): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, g = this.bed.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(depth, t + 0.25);
    g.setValueAtTime(depth, t + 0.25 + hold);
    g.linearRampToValueAtTime(1, t + 0.25 + hold + release);
  }
  set(next: Partial<SoundLevels>): void { Object.assign(this.levels, next); this.apply(); }

  /** Click and hover sounds for every button under `root`. data-sfx="none" silences one; data-sfx="<name>" picks one. */
  bindUi(root: Document | HTMLElement = document): void {
    let over: Element | null = null;
    const target = (e: Event) => (e.target as Element | null)?.closest?.('button, a[href], [role=button], [role=switch], .menu-item') ?? null;
    root.addEventListener('click', (e) => {
      const el = target(e) as HTMLButtonElement | null;
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      const tag = (el.closest('[data-sfx]') as HTMLElement | null)?.dataset.sfx;
      if (tag === 'none') return;
      this.play(tag || (el.matches('.back, .close, [aria-label=Back], [aria-label=Resume]') ? 'ui-back' : 'ui-click'));
    }, true);
    root.addEventListener('pointerover', (e) => {
      if ((e as PointerEvent).pointerType !== 'mouse') return;
      const el = target(e) as HTMLButtonElement | null;
      if (el === over) return;
      over = el;
      if (el && !el.disabled && (el.closest('[data-sfx]') as HTMLElement | null)?.dataset.sfx !== 'none') this.play('ui-hover');
    }, true);
  }
}

interface Deck { el: HTMLAudioElement; node: MediaElementAudioSourceNode | null; gain: GainNode | null; live: boolean; primed: boolean }

/** A streamed, looping bed: two <audio> decks that hand over to each other with a crossfade. */
class Bed {
  private readonly decks: Deck[];
  private want: string | null = null;
  private track: string | null = null;
  private cur = -1;
  private enabled = true;
  private held = false;

  constructor(private readonly s: Sound, private readonly kind: 'music' | 'amb') {
    this.decks = [0, 1].map(() => { const el = new Audio(); el.preload = 'auto'; el.loop = false; return { el, node: null, gain: null, live: false, primed: false }; });
    // the loop: start the other deck before this one runs out
    setInterval(() => {
      if (this.cur < 0 || !this.track || this.held) return;
      const d = this.decks[this.cur], el = d.el;
      if (d.live && el.duration && el.currentTime > el.duration - XFADE - 0.3) this.begin(this.track, XFADE);
    }, 250);
    for (const d of this.decks) d.el.addEventListener('ended', () => { if (d.live && this.decks[this.cur] === d && this.track) this.begin(this.track, 0.5); });
  }

  private wire(d: Deck): void {
    const ctx = this.s.context;
    if (d.node || !ctx) return;
    d.node = ctx.createMediaElementSource(d.el);
    d.gain = ctx.createGain();
    d.gain.gain.value = 0;
    d.node.connect(d.gain).connect(this.s.output(this.kind));
  }
  private ramp(d: Deck, to: number, sec: number): void {
    const ctx = this.s.context;
    if (!d.gain || !ctx) return;
    const t = ctx.currentTime, g = d.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(to, t + Math.max(0.02, sec));
  }
  private stop(d: Deck, sec: number): void {
    if (!d.live) return;
    d.live = false;
    this.ramp(d, 0, sec);
    setTimeout(() => { if (!d.live) d.el.pause(); }, sec * 1000 + 50);
  }
  private begin(name: string, sec: number): void {
    const m = this.s.entry(name);
    if (!m) return;
    const i = this.cur === 0 ? 1 : 0, d = this.decks[i];
    this.wire(d);
    if (!d.el.src.endsWith(`/${m.file}`)) d.el.src = this.s.url(m.file);
    try { d.el.currentTime = 0; } catch { /* not seekable yet: it starts at 0 anyway */ }
    d.live = true;
    d.el.play().then(() => this.ramp(d, m.gain ?? 1, sec), () => { d.live = false; });
    if (this.cur >= 0) this.stop(this.decks[this.cur], sec);
    this.cur = i; this.track = name;
  }
  private sync(fade: number): void {
    if (!this.s.isUnlocked || !this.s.context) return;
    const target = this.enabled ? this.want : null;
    if (target === this.track) return;
    if (!target) { if (this.cur >= 0) this.stop(this.decks[this.cur], fade); this.track = null; return; }
    void this.s.ready.then(() => this.begin(target, fade));
  }

  set(name: string | null, fade: number): void { this.want = name; this.sync(fade); }
  kick(): void { this.sync(1.5); }
  enable(on: boolean): void { if (this.enabled === on) return; this.enabled = on; this.sync(1); }
  /** Play each deck once, silently, inside the unlocking gesture. */
  prime(): void {
    const file = this.s.entry(this.want)?.file ?? this.s.firstOf(this.kind)?.file;
    for (const d of this.decks) {
      if (d.primed || !file) continue;
      d.primed = true;
      this.wire(d);
      if (d.live || !d.el.paused) continue;
      if (!d.el.src) d.el.src = this.s.url(file);
      d.el.play().then(() => { if (!d.live) d.el.pause(); }, () => { d.primed = false; });
    }
  }
  hold(on: boolean): void {
    this.held = on;
    for (const d of this.decks) if (d.live) { if (on) d.el.pause(); else void d.el.play().catch(() => {}); }
  }
}
