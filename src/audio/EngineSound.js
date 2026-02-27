/* ═══════════════════════════════════════════
   NEURODRIVE — Engine Sound Synthesizer
   4-cylinder engine idle/rev + turbo spool + BOV
   All Web Audio API — no external files
   ═══════════════════════════════════════════ */

export class EngineSound {
    constructor() {
        this.ctx = null;
        this._masterGain = null;
        this._running = false;

        // Engine state
        this._rpm = 0;            // 0-1 normalized
        this._turboSpool = 0;     // 0-1 pressure buildup
        this._wasThrustOn = false;

        // Nodes
        this._engineOsc1 = null;
        this._engineOsc2 = null;
        this._harmonicOsc = null;
        this._engineGain = null;
        this._turboOsc = null;
        this._turboGain = null;
        this._compressor = null;
        this._noiseBuffer = null;
    }

    start() {
        if (this._running) return;

        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();

        this._buildGraph();
        this._running = true;
    }

    _buildGraph() {
        const ctx = this.ctx;

        // Master chain: compressor → master gain → destination
        this._compressor = ctx.createDynamicsCompressor();
        this._compressor.threshold.value = -15;
        this._compressor.knee.value = 10;
        this._compressor.ratio.value = 3;

        this._masterGain = ctx.createGain();
        this._masterGain.gain.value = 0.07;

        this._compressor.connect(this._masterGain);
        this._masterGain.connect(ctx.destination);

        // ── A) Engine core — 2 detuned sawtooth oscillators ──
        const engineFilter = ctx.createBiquadFilter();
        engineFilter.type = 'bandpass';
        engineFilter.frequency.value = 200;
        engineFilter.Q.value = 1.5;

        this._engineGain = ctx.createGain();
        this._engineGain.gain.value = 0.3;

        engineFilter.connect(this._engineGain);
        this._engineGain.connect(this._compressor);

        this._engineOsc1 = ctx.createOscillator();
        this._engineOsc1.type = 'sawtooth';
        this._engineOsc1.frequency.value = 45;
        this._engineOsc1.connect(engineFilter);
        this._engineOsc1.start();

        this._engineOsc2 = ctx.createOscillator();
        this._engineOsc2.type = 'sawtooth';
        this._engineOsc2.frequency.value = 45;
        this._engineOsc2.detune.value = 5;
        this._engineOsc2.connect(engineFilter);
        this._engineOsc2.start();

        // ── B) Second harmonic — square wave at 2× for 4-cyl buzz ──
        this._harmonicOsc = ctx.createOscillator();
        this._harmonicOsc.type = 'square';
        this._harmonicOsc.frequency.value = 90;

        const harmonicGain = ctx.createGain();
        harmonicGain.gain.value = 0.15;
        this._harmonicOsc.connect(harmonicGain);
        harmonicGain.connect(engineFilter);
        this._harmonicOsc.start();

        // ── C) Turbo spool whistle — sine through narrow bandpass ──
        this._turboOsc = ctx.createOscillator();
        this._turboOsc.type = 'sine';
        this._turboOsc.frequency.value = 2000;

        const turboFilter = ctx.createBiquadFilter();
        turboFilter.type = 'bandpass';
        turboFilter.frequency.value = 3000;
        turboFilter.Q.value = 5;

        this._turboGain = ctx.createGain();
        this._turboGain.gain.value = 0;

        this._turboOsc.connect(turboFilter);
        turboFilter.connect(this._turboGain);
        this._turboGain.connect(this._compressor);
        this._turboOsc.start();

        // ── Noise buffer for BOV ──
        const bufLen = ctx.sampleRate * 2;
        this._noiseBuffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = this._noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            data[i] = Math.random() * 2 - 1;
        }
    }

    update(dt, vehicle) {
        if (!this._running || !this.ctx) return;

        const now = this.ctx.currentTime;

        // 1. Compute target RPM from speed
        const targetRPM = Math.abs(vehicle.velocity) / vehicle.maxSpeed;
        this._rpm += (targetRPM - this._rpm) * (1 - Math.exp(-6 * dt));

        // 2. Update engine oscillator frequencies
        const baseFreq = 45 + this._rpm * 120;
        this._engineOsc1.frequency.setTargetAtTime(baseFreq, now, 0.05);
        this._engineOsc2.frequency.setTargetAtTime(baseFreq, now, 0.05);
        this._harmonicOsc.frequency.setTargetAtTime(baseFreq * 2, now, 0.05);

        // 3. Engine volume — louder at higher RPM
        const engVol = 0.3 + this._rpm * 0.7;
        this._engineGain.gain.setTargetAtTime(engVol, now, 0.05);

        // 4. Turbo spool
        const thrusting = vehicle.throttle > 0 && Math.abs(vehicle.velocity) > 8;
        if (thrusting) {
            this._turboSpool = Math.min(1, this._turboSpool + dt * 0.5);
        } else {
            this._turboSpool = Math.max(0, this._turboSpool - dt * 0.8);
        }
        this._turboOsc.frequency.setTargetAtTime(
            2000 + this._turboSpool * 4000, now, 0.05
        );
        this._turboGain.gain.setTargetAtTime(
            this._turboSpool * 0.08, now, 0.05
        );

        // 5. BOV trigger — throttle released after sustained spool
        if (this._wasThrustOn && vehicle.throttle === 0 && this._turboSpool > 0.3) {
            this._triggerBOV();
        }
        this._wasThrustOn = thrusting;
    }

    _triggerBOV() {
        const ctx = this.ctx;
        const now = ctx.currentTime;

        const source = ctx.createBufferSource();
        source.buffer = this._noiseBuffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 3000;
        filter.Q.value = 2;

        const env = ctx.createGain();
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(0.06, now + 0.01);
        env.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

        source.connect(filter);
        filter.connect(env);
        env.connect(this._masterGain);
        source.start(now);
        source.stop(now + 0.2);

        this._turboSpool = 0;
    }

    stop() {
        if (!this._running) return;
        this._running = false;

        if (this._masterGain) {
            const now = this.ctx.currentTime;
            this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
            this._masterGain.gain.linearRampToValueAtTime(0, now + 0.3);
        }

        setTimeout(() => this._cleanup(), 400);
    }

    _cleanup() {
        try {
            if (this._engineOsc1) { this._engineOsc1.stop(); this._engineOsc1 = null; }
            if (this._engineOsc2) { this._engineOsc2.stop(); this._engineOsc2 = null; }
            if (this._harmonicOsc) { this._harmonicOsc.stop(); this._harmonicOsc = null; }
            if (this._turboOsc) { this._turboOsc.stop(); this._turboOsc = null; }
        } catch (e) {}
    }

    dispose() {
        this.stop();
        if (this.ctx && this.ctx.state !== 'closed') {
            this.ctx.close().catch(() => {});
        }
        this.ctx = null;
    }
}
