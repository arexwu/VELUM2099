/* ═══════════════════════════════════════════
   NEURODRIVE — Lo-Fi Synthwave Radio
   Procedural Web Audio API synthesizer
   No external audio files needed
   ═══════════════════════════════════════════ */

// Lo-fi chord progressions (MIDI note numbers)
const PROGRESSIONS = [
    // Am7 → Fmaj7 → Cmaj7 → G
    [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 66]],
    // Dm7 → G7 → Cmaj7 → Am7
    [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59], [57, 60, 64, 67]],
    // Em7 → Am7 → Dm7 → G
    [[52, 55, 59, 62], [57, 60, 64, 67], [50, 53, 57, 60], [55, 59, 62, 66]],
];

function midiToFreq(n) { return 440 * Math.pow(2, (n - 69) / 12); }

export class LofiRadio {
    constructor() {
        this.ctx = null;
        this.playing = false;
        this._masterGain = null;
        this._compressor = null;
        this._lopassMaster = null;

        // Timing
        this._bpm = 75 + Math.random() * 10;
        this._beatDur = 60 / this._bpm;
        this._nextBeatTime = 0;
        this._beatIndex = 0;
        this._chordIndex = 0;
        this._progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];

        // Active nodes for cleanup
        this._padOscs = [];
        this._bassOsc = null;
        this._bassGain = null;
        this._crackleSource = null;
        this._lfoOsc = null;
        this._padFilter = null;
        this._noiseBuffer = null;
        this._popTimer = 0;
    }

    toggle() {
        if (this.playing) {
            this._stop();
            return false;
        }
        this._start();
        return true;
    }

    _start() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();

        this.playing = true;
        this._beatIndex = 0;
        this._chordIndex = 0;
        this._nextBeatTime = this.ctx.currentTime + 0.1;

        this._buildGraph();
        this._startCrackle();
        this._startPad();
        this._startBass();
    }

    _stop() {
        this.playing = false;
        // Fade out
        if (this._masterGain) {
            const now = this.ctx.currentTime;
            this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
            this._masterGain.gain.linearRampToValueAtTime(0, now + 0.5);
        }
        // Clean up after fade
        setTimeout(() => {
            this._cleanupNodes();
        }, 600);
    }

    _buildGraph() {
        const ctx = this.ctx;

        // Master chain: compressor → lowpass → bitcrusher → gain → destination
        this._compressor = ctx.createDynamicsCompressor();
        this._compressor.threshold.value = -20;
        this._compressor.knee.value = 20;
        this._compressor.ratio.value = 4;

        this._lopassMaster = ctx.createBiquadFilter();
        this._lopassMaster.type = 'lowpass';
        this._lopassMaster.frequency.value = 11000;

        // Staircase waveshaper for subtle bitcrush
        const steps = 64;
        const curve = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            const x = (i / 255) * 2 - 1;
            curve[i] = Math.round(x * steps) / steps;
        }
        this._bitcrusher = ctx.createWaveShaper();
        this._bitcrusher.curve = curve;
        this._bitcrusher.oversample = 'none';

        this._masterGain = ctx.createGain();
        this._masterGain.gain.value = 0.15;

        this._compressor.connect(this._lopassMaster);
        this._lopassMaster.connect(this._bitcrusher);
        this._bitcrusher.connect(this._masterGain);
        this._masterGain.connect(ctx.destination);

        // Create noise buffer for hi-hats and crackle
        const bufLen = ctx.sampleRate * 2;
        this._noiseBuffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = this._noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            data[i] = Math.random() * 2 - 1;
        }
    }

    _startPad() {
        const ctx = this.ctx;
        const chord = this._progression[this._chordIndex % this._progression.length];

        // Pad filter with LFO
        this._padFilter = ctx.createBiquadFilter();
        this._padFilter.type = 'lowpass';
        this._padFilter.frequency.value = 800;
        this._padFilter.Q.value = 2;

        this._lfoOsc = ctx.createOscillator();
        this._lfoOsc.frequency.value = 0.12;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 400;
        this._lfoOsc.connect(lfoGain);
        lfoGain.connect(this._padFilter.frequency);
        this._lfoOsc.start();

        const padGain = ctx.createGain();
        padGain.gain.value = 0.12;
        this._padGain = padGain;

        this._padFilter.connect(padGain);
        padGain.connect(this._compressor);

        // Create detuned oscillator pairs for each chord note
        this._padOscs = [];
        for (const note of chord) {
            const freq = midiToFreq(note);
            for (const detune of [-7, 7]) {
                const osc = ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.value = freq;
                osc.detune.value = detune;
                osc.connect(this._padFilter);
                osc.start();
                this._padOscs.push(osc);
            }
        }
    }

    _changePadChord() {
        if (!this.playing || !this.ctx) return;
        const ctx = this.ctx;
        const chord = this._progression[this._chordIndex % this._progression.length];
        const now = ctx.currentTime;

        // Crossfade: ramp existing oscillators to new frequencies
        let oscIdx = 0;
        for (const note of chord) {
            const freq = midiToFreq(note);
            for (const detune of [-7, 7]) {
                if (oscIdx < this._padOscs.length) {
                    const osc = this._padOscs[oscIdx];
                    osc.frequency.setValueAtTime(osc.frequency.value, now);
                    osc.frequency.exponentialRampToValueAtTime(freq, now + 0.3);
                    osc.detune.value = detune;
                }
                oscIdx++;
            }
        }
    }

    _startBass() {
        const ctx = this.ctx;
        this._bassOsc = ctx.createOscillator();
        this._bassOsc.type = 'sine';
        this._bassOsc.frequency.value = midiToFreq(this._progression[0][0] - 12);

        this._bassGain = ctx.createGain();
        this._bassGain.gain.value = 0.18;

        const bassFilter = ctx.createBiquadFilter();
        bassFilter.type = 'lowpass';
        bassFilter.frequency.value = 300;

        this._bassOsc.connect(bassFilter);
        bassFilter.connect(this._bassGain);
        this._bassGain.connect(this._compressor);
        this._bassOsc.start();
    }

    _startCrackle() {
        const ctx = this.ctx;
        // Continuous low-volume vinyl crackle
        this._crackleSource = ctx.createBufferSource();
        this._crackleSource.buffer = this._noiseBuffer;
        this._crackleSource.loop = true;

        const crackleFilter = ctx.createBiquadFilter();
        crackleFilter.type = 'bandpass';
        crackleFilter.frequency.value = 2000;
        crackleFilter.Q.value = 3;

        const crackleGain = ctx.createGain();
        crackleGain.gain.value = 0.015;

        this._crackleSource.connect(crackleFilter);
        crackleFilter.connect(crackleGain);
        crackleGain.connect(this._masterGain);
        this._crackleSource.start();
    }

    _scheduleHiHat(time) {
        if (!this.ctx || !this._noiseBuffer) return;
        const ctx = this.ctx;

        // 10% chance to skip for human feel
        if (Math.random() < 0.1) return;

        const source = ctx.createBufferSource();
        source.buffer = this._noiseBuffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 8000;

        const env = ctx.createGain();
        const vel = 0.02 + Math.random() * 0.04;
        env.gain.setValueAtTime(vel, time);
        env.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

        source.connect(filter);
        filter.connect(env);
        env.connect(this._compressor);
        source.start(time);
        source.stop(time + 0.06);
    }

    _schedulePop() {
        if (!this.ctx || !this._noiseBuffer) return;
        const ctx = this.ctx;
        const source = ctx.createBufferSource();
        source.buffer = this._noiseBuffer;

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.06, ctx.currentTime);
        env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.012);

        source.connect(env);
        env.connect(this._masterGain);
        source.start();
        source.stop(ctx.currentTime + 0.015);
    }

    update(dt) {
        if (!this.playing || !this.ctx) return;

        const now = this.ctx.currentTime;

        // Schedule beats ahead
        while (this._nextBeatTime < now + 0.2) {
            const beatInBar = this._beatIndex % 16; // 16 eighth-notes per 4 bars

            // Hi-hat on every 8th note
            this._scheduleHiHat(this._nextBeatTime);

            // Bass on beats 1 and 3 (every 4 eighth-notes)
            if (beatInBar % 4 === 0 && this._bassOsc) {
                const chord = this._progression[this._chordIndex % this._progression.length];
                const root = chord[0] - 12;
                const isOctaveUp = (beatInBar % 8 === 4);
                const freq = midiToFreq(isOctaveUp ? root + 12 : root);
                this._bassOsc.frequency.setValueAtTime(this._bassOsc.frequency.value, this._nextBeatTime);
                this._bassOsc.frequency.exponentialRampToValueAtTime(freq, this._nextBeatTime + 0.05);
            }

            // Chord change every 8 eighth-notes (= 4 beats at 2 eighth-notes per beat... but we count per 8th)
            // Actually: 4 beats = 8 eighth notes
            if (beatInBar === 0 && this._beatIndex > 0) {
                this._chordIndex++;
                this._changePadChord();
            }

            this._nextBeatTime += this._beatDur / 2; // 8th note duration
            this._beatIndex++;
        }

        // Random vinyl pops
        this._popTimer += dt;
        if (this._popTimer > 0.5 + Math.random() * 1.5) {
            this._popTimer = 0;
            this._schedulePop();
        }
    }

    _cleanupNodes() {
        try {
            for (const osc of this._padOscs) { try { osc.stop(); } catch(e) {} }
            this._padOscs = [];
            if (this._bassOsc) { try { this._bassOsc.stop(); } catch(e) {} this._bassOsc = null; }
            if (this._lfoOsc) { try { this._lfoOsc.stop(); } catch(e) {} this._lfoOsc = null; }
            if (this._crackleSource) { try { this._crackleSource.stop(); } catch(e) {} this._crackleSource = null; }
        } catch(e) {}
    }

    dispose() {
        this._stop();
        if (this.ctx && this.ctx.state !== 'closed') {
            this.ctx.close().catch(() => {});
        }
        this.ctx = null;
    }
}
