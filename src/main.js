/* ═══════════════════════════════════════════
   NEURODRIVE — Main Entry Point
   Orchestrates terminal → simulation → 
   data collection flow
   ═══════════════════════════════════════════ */

import { Terminal } from './terminal/Terminal.js';
import { CyberpunkScene } from './scene/CyberpunkScene.js';
import { Vehicle } from './vehicle/Vehicle.js';
import { Segmenter } from './segmentation/Segmenter.js';
import { DataCollector } from './data/DataCollector.js';
import { Exporter } from './data/Exporter.js';

class App {
    constructor() {
        this.terminalEl = document.getElementById('terminal-screen');
        this.canvasEl = document.getElementById('game-canvas');

        this.terminal = new Terminal(this.terminalEl);
        this.scene = null;
        this.vehicle = null;
        this.segmenter = new Segmenter();
        this.collector = new DataCollector();

        this.running = false;
        this._animFrameId = null;
        this._captureRequested = false;

        this._init();
    }

    async _init() {
        // Set up terminal menu actions
        this.terminal.onAction = (action) => this._handleAction(action);

        // Start the terminal boot sequence
        await this.terminal.show();

        // Pre-init segmenter in background
        this.segmenter.init().catch(err => {
            console.warn('[Segmenter] 初始化警告:', err);
        });
    }

    _handleAction(action) {
        switch (action) {
            case 'start':
                this._startSimulation();
                break;
            case 'export':
                this._exportData();
                break;
            case 'settings':
                this._showSettings();
                break;
        }
    }

    _startSimulation() {
        // Hide terminal, show canvas
        this.terminal.hide();
        this.canvasEl.style.display = 'block';

        // Initialize Three.js scene and vehicle
        if (!this.scene) {
            this.scene = new CyberpunkScene(this.canvasEl);
        }
        if (!this.vehicle) {
            this.vehicle = new Vehicle(this.scene.scene);
        }

        // Start data collection session
        this.collector.startSession();

        // Bind capture key (C)
        this._captureKeyHandler = (e) => {
            if (e.code === 'KeyC') {
                this._captureRequested = true;
                console.log(`[采集] 帧 #${this.collector.getFrameCount() + 1} 已捕获`);
            }
            // ESC returns to menu
            if (e.code === 'Escape') {
                this._stopSimulation();
            }
            // Toggle continuous mode with T
            if (e.code === 'KeyT') {
                const newMode = this.collector.mode === 'manual' ? 'continuous' : 'manual';
                this.collector.setMode(newMode);
            }
        };
        window.addEventListener('keydown', this._captureKeyHandler);

        // Start game loop
        this.running = true;
        this._lastTime = performance.now();
        this._gameLoop();

        console.log('[系统] 模拟启动 — WASD/方向键驾驶 | C=采集帧 | T=切换连续采集 | ESC=返回菜单');
    }

    _gameLoop() {
        if (!this.running) return;

        const now = performance.now();
        const dt = Math.min((now - this._lastTime) / 1000, 0.05); // cap at 50ms
        this._lastTime = now;

        // Update vehicle physics
        this.vehicle.update(dt);

        // Update scene (camera, rain, neon flicker, post-processing render)
        this.scene.update(this.vehicle.position, this.vehicle.rotation);

        // Segmentation
        const mask = this.segmenter.processFrame(this.canvasEl);

        // Data collection
        this.collector.tick(
            this.canvasEl,
            this.vehicle,
            mask,
            this._captureRequested
        );
        this._captureRequested = false;

        this._animFrameId = requestAnimationFrame(() => this._gameLoop());
    }

    _stopSimulation() {
        this.running = false;
        if (this._animFrameId) {
            cancelAnimationFrame(this._animFrameId);
            this._animFrameId = null;
        }

        // Unbind capture key
        if (this._captureKeyHandler) {
            window.removeEventListener('keydown', this._captureKeyHandler);
            this._captureKeyHandler = null;
        }

        // Stop recording
        this.collector.stopSession();

        // Hide canvas, show terminal
        this.canvasEl.style.display = 'none';
        this.terminal.show();
    }

    async _exportData() {
        const data = this.collector.getData();
        await Exporter.exportZip(data);
    }

    _showSettings() {
        // For now, toggle between manual and continuous mode via terminal feedback
        const currentMode = this.collector.mode;
        const newMode = currentMode === 'manual' ? 'continuous' : 'manual';
        this.collector.setMode(newMode);

        // Add feedback line to terminal
        const modeName = newMode === 'continuous' ? '连续采集' : '手动采集';
        const feedbackEl = document.createElement('div');
        feedbackEl.className = 'term-line yellow';
        feedbackEl.textContent = `  ► 数据采集模式已切换为: ${modeName}`;
        this.terminalEl.appendChild(feedbackEl);
    }
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
    new App();
});
