/* Diamond DJ: the audio engine.
 *
 * Every sound is a Track: an <audio> element (or, if this browser stalls on those, a decoded
 * buffer) routed through its own gain node into one master gain. Gains do the fades and the
 * ducking, so they are smooth and exact.
 *
 * A walk-up is a small group of tracks: the announcement and the song. "Under" starts both
 * together with the song ducked, and lifts the song when the announcement ends. "After" starts
 * the song when the announcement ends.
 */
'use strict';

const Sound = (() => {
  let ctx = null, master = null;
  let useElements = true;          // switch to decoded buffers if <audio> playback stalls
  const tracks = [];               // everything audible or fading
  const urls = new Map();          // path -> object URL of the stored file
  let listener = () => {};
  let loader = async () => null;   // path -> Blob (set by the app: reads the device's storage)
  let groupSeq = 0;
  const settings = { fadeSeconds: 2.5, masterVolume: 1 };

  function audioCtx() {
    if (!ctx) {
      // iPhone/iPad: play even with the ring/silent switch on silent (Safari 16.4+)
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = settings.masterVolume;
      master.connect(ctx.destination);
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }

  function ramp(param, to, secs) {
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(to, t + Math.max(0.02, secs));
  }

  async function urlFor(path) {
    if (urls.has(path)) return urls.get(path);
    const blob = await loader(path);
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    urls.set(path, u);
    return u;
  }

  function forget(path) {
    const u = urls.get(path);
    if (u) { URL.revokeObjectURL(u); urls.delete(path); }
  }

  const changed = () => { try { listener(); } catch (e) { console.error(e); } };

  class Track {
    /* opts: { path, start=0, stop=null, fadeOut=0, level=1, label, kind, group } */
    constructor(opts) {
      Object.assign(this, { start: 0, stop: null, fadeOut: 0, level: 1, label: '', kind: 'sound', group: null }, opts);
      this.state = 'loading'; // loading | playing | fading | done
      this.onend = null;
    }
    get duration() {
      const d = this.el ? this.el.duration : this.buffer ? this.buffer.duration : NaN;
      return isFinite(d) ? d : 0;
    }
    get end() {
      const d = this.duration || Infinity;
      return this.stop != null && this.stop < d ? this.stop : d;
    }
    get time() {
      if (this.el) return this.el.currentTime;
      if (this.src) return this.offset + (ctx.currentTime - this.t0);
      return this.start;
    }
    async play(fadeIn = 0) {
      audioCtx();
      this.gain = ctx.createGain();
      this.gain.gain.value = fadeIn ? 0 : this.level;
      this.gain.connect(master);
      tracks.push(this);
      changed();
      try {
        if (useElements) {
          try { await this._element(); }
          catch (e) {
            if (this.state === 'done' || (e && e.message === 'missing')) throw e;
            console.warn('Element playback failed; using decoded playback', e);
            useElements = false;
            this._dropElement();
            await this._buffer();
          }
        } else {
          await this._buffer();
        }
      } catch (e) {
        this.stopNow();
        throw e;
      }
      if (this.state === 'done') { this._teardown(); return this; }
      this.state = 'playing';
      if (fadeIn) ramp(this.gain.gain, this.level, fadeIn);
      this._timer = setInterval(() => this._tick(), 100);
      changed();
      return this;
    }
    async _element() {
      const url = await urlFor(this.path);
      if (!url) throw new Error('missing');
      const a = new Audio();
      a.preload = 'auto';
      this.el = a;
      a.src = url;
      await new Promise((res, rej) => { a.onloadedmetadata = res; a.onerror = () => rej(a.error || new Error('load failed')); });
      if (this.state === 'done') return;
      this.node = ctx.createMediaElementSource(a);
      this.node.connect(this.gain);
      // always seek (Safari can stall otherwise); 10 ms is inaudible
      a.currentTime = Math.max(0.01, Math.min(this.start, Math.max(0, (a.duration || 1e9) - 0.25)));
      a.onended = () => this.stopNow();
      await a.play();
      const t0 = a.currentTime;
      setTimeout(async () => { // stalled? switch this browser to decoded playback
        if (this.state !== 'playing' || !this.el || this.el.currentTime > t0 + 0.05) return;
        console.warn('Playback stalled; using decoded playback');
        useElements = false;
        const at = this.el.currentTime;
        this._dropElement();
        try { this.start = at; await this._buffer(); } catch (e) { this.stopNow(); }
      }, 2500);
    }
    _dropElement() {
      try { this.el && this.el.pause(); } catch (e) {}
      try { this.node && this.node.disconnect(); } catch (e) {}
      this.el = null; this.node = null;
    }
    async _buffer() {
      const blob = await loader(this.path);
      if (!blob) throw new Error('missing');
      this.buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      if (this.state === 'done') return;
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.connect(this.gain);
      this.offset = Math.min(this.start, Math.max(0, this.buffer.duration - 0.25));
      this.t0 = ctx.currentTime;
      src.onended = () => this.stopNow();
      src.start(0, this.offset);
      this.src = src;
    }
    _tick() {
      if (this.state === 'playing') {
        const left = this.end - this.time;
        // a playlist moves on a little before the end so the songs overlap
        if (this.onnearend && this.nearEnd && isFinite(left) && left <= this.nearEnd) {
          const cb = this.onnearend; this.onnearend = null; cb(this);
        }
        if (this.state === 'playing' && this.stop != null && left <= Math.max(0.05, this.fadeOut)) this.fade(Math.max(0.05, left));
      }
      changed();
    }
    setLevel(level, secs = 0.1) {
      this.level = level;
      if (this.state === 'playing' && this.gain) ramp(this.gain.gain, level, secs);
    }
    fade(secs = settings.fadeSeconds) {
      if (this.state === 'done' || this.state === 'fading') return;
      if (this.state === 'loading' || !this.gain) { this.stopNow(); return; }
      this.state = 'fading';
      ramp(this.gain.gain, 0, secs);
      clearTimeout(this._fadeTimer);
      this._fadeTimer = setTimeout(() => this.stopNow(), secs * 1000 + 60);
      changed();
    }
    stopNow() {
      if (this.state === 'done') return;
      this.state = 'done';
      clearTimeout(this._fadeTimer);
      clearInterval(this._timer);
      this._teardown();
      const i = tracks.indexOf(this);
      if (i >= 0) tracks.splice(i, 1);
      const cb = this.onend; this.onend = null;
      if (cb) { try { cb(this); } catch (e) { console.error(e); } }
      changed();
    }
    seek(t) {
      if (this.el) this.el.currentTime = Math.max(0, t);
    }
    _teardown() {
      this._dropElement();
      try { this.src && this.src.stop(); } catch (e) {}
      try { this.src && this.src.disconnect(); } catch (e) {}
      try { this.gain && this.gain.disconnect(); } catch (e) {}
      this.src = null;
    }
  }

  /* ---------------------------------------------------------------- public */

  function fadeAll(secs = settings.fadeSeconds, except = null) {
    for (const t of [...tracks]) if (except == null || (t !== except && t.group !== except)) t.fade(secs);
    groupSeq++; // cancels anything still waiting to start (an "after" song)
  }

  function stopAll() {
    groupSeq++;
    for (const t of [...tracks]) t.stopNow();
  }

  /* Play one sound. It fades out whatever is playing, unless `layer` is set
     (short sound effects play over the music). */
  async function playOne(opts, { layer = false } = {}) {
    if (!layer) fadeAll();
    const t = new Track(opts);
    await t.play();
    return t;
  }

  /* A playlist that keeps going: `nextItem()` returns the next track's options (or null to end).
     Songs overlap by `xfade` seconds. skip() moves on now. Anything that fades everything
     (another moment, a walk-up, Fade out) ends the playlist. */
  async function playlist(nextItem, { xfade = 4, meta = {} } = {}) {
    fadeAll();
    const myGroup = ++groupSeq;
    const group = `playlist-${myGroup}`;
    const ctl = {
      group, current: null,
      get live() { return myGroup === groupSeq; },
      async playNext(fadeIn = 0) {
        if (!ctl.live) return null;
        const item = nextItem();
        if (!item) return null;
        const t = new Track({ ...item, ...meta, group, kind: 'playlist' });
        t.nearEnd = xfade;
        t.onnearend = () => { if (ctl.live) { ctl.playNext(Math.min(2, xfade)); t.fade(xfade); } };
        ctl.current = t;
        try { await t.play(fadeIn); ctl.misses = 0; }
        catch (e) { // a missing file: try the next song, but not forever
          ctl.misses = (ctl.misses || 0) + 1;
          if (ctl.live && ctl.misses < 25) return ctl.playNext(fadeIn);
          throw e;
        }
        return t;
      },
      skip() {
        const old = ctl.current;
        if (old) { old.onnearend = null; old.fade(1.5); }
        return ctl.playNext(0.5);
      },
    };
    await ctl.playNext();
    return ctl;
  }

  /* Play a walk-up from Model.walkupPlan(). Resolves when it has started. */
  async function walkup(plan, label, meta = {}) {
    fadeAll();
    const myGroup = ++groupSeq;
    const group = `walkup-${myGroup}`;
    const live = () => myGroup === groupSeq;
    const song = plan.song;
    const songTrack = song ? new Track({
      path: song.path, start: song.start, stop: song.stop, fadeOut: song.fadeOut,
      level: song.volume * plan.duckLevel, label, kind: 'walkup', group, ...meta,
    }) : null;
    const introTrack = plan.intro ? new Track({ path: plan.intro.path, level: 1, label, kind: 'intro', group, ...meta }) : null;

    if (plan.mode === 'song') { await songTrack.play(); return; }
    if (plan.mode === 'intro') { await introTrack.play(); return; }
    if (plan.mode === 'under') {
      introTrack.onend = () => { if (songTrack.state === 'playing') songTrack.setLevel(song.volume, plan.riseSeconds); };
      // start together; if the song is missing, the announcement still plays
      const [ir, sr] = await Promise.allSettled([introTrack.play(), songTrack.play()]);
      if (ir.status === 'rejected' && sr.status === 'fulfilled') songTrack.setLevel(song.volume, 0.3);
      if (ir.status === 'rejected' && sr.status === 'rejected') throw ir.reason;
      return;
    }
    // after: the song starts when the announcement ends
    introTrack.onend = () => { if (live()) songTrack.play().catch(e => console.warn(e)); };
    try { await introTrack.play(); }
    catch (e) { if (live()) await songTrack.play(); }
  }

  /* A preview for the clip editor: plays from `at`, no stop point, doesn't fade others. */
  async function preview(path, at = 0, opts = {}) {
    stopPreview();
    const t = new Track({ path, start: at, label: 'Preview', kind: 'preview', ...opts });
    await t.play();
    return t;
  }
  function stopPreview() { for (const t of [...tracks]) if (t.kind === 'preview') t.stopNow(); }

  /* Peaks for drawing a waveform: n values 0..1. */
  async function peaks(path, n = 600) {
    const blob = await loader(path);
    if (!blob) return null;
    audioCtx();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / n));
    const out = new Array(n).fill(0);
    let maxAll = 0;
    for (let i = 0; i < n; i++) {
      let m = 0;
      const from = i * step, to = Math.min(data.length, from + step);
      for (let j = from; j < to; j += 8) { const v = Math.abs(data[j]); if (v > m) m = v; }
      out[i] = m; if (m > maxAll) maxAll = m;
    }
    return { duration: buf.duration, values: out.map(v => maxAll ? +(v / maxAll).toFixed(3) : 0) };
  }

  /* Length of a file in seconds, without playing it. */
  function measure(blob) {
    return new Promise(resolve => {
      const a = new Audio();
      const u = URL.createObjectURL(blob);
      const done = d => { URL.revokeObjectURL(u); resolve(isFinite(d) ? d : 0); };
      a.preload = 'metadata';
      a.onloadedmetadata = () => done(a.duration);
      a.onerror = () => done(0);
      a.src = u;
      setTimeout(() => done(a.duration), 8000);
    });
  }

  function setMaster(v) {
    settings.masterVolume = v;
    if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
  }

  return {
    settings, tracks, Track,
    unlock: audioCtx,
    setLoader(fn) { loader = fn; },
    onChange(fn) { listener = fn; },
    forget, fadeAll, stopAll, playOne, playlist, walkup, preview, stopPreview, peaks, measure, setMaster,
    playing: () => tracks.filter(t => t.kind !== 'preview' && t.state !== 'done'),
  };
})();
