/* ═══════════════════════════════════════════
   NEURODRIVE — Cyberpunk Scene
   Grid-based procedural city — drive in
   any direction with infinite generation
   ═══════════════════════════════════════════ */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* ── Retro shader ── */
const RetroShader = {
    uniforms: {
        tDiffuse: { value: null },
        time: { value: 0 },
        scanlineIntensity: { value: 0.06 },
        chromaticAberration: { value: 0.002 },
    },
    vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
    fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float scanlineIntensity;
    uniform float chromaticAberration;
    varying vec2 vUv;
    void main() {
      float ca = chromaticAberration;
      float r = texture2D(tDiffuse, vUv + vec2(ca, 0.0)).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - vec2(ca, 0.0)).b;
      vec3 color = vec3(r, g, b);
      float scanline = sin(vUv.y * 800.0 + time * 2.0) * scanlineIntensity;
      color -= scanline;
      float vignette = smoothstep(0.9, 0.4, length(vUv - 0.5));
      color *= vignette * 0.1 + 0.9;
      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

/* ── Neon palette ── */
const NEON = {
    pink: 0xff0080, cyan: 0x00ffff, purple: 0xaa00ff,
    yellow: 0xffff00, green: 0x00ff66, orange: 0xff6600, blue: 0x0066ff,
};
const NEON_COLORS = Object.values(NEON);
function randomNeon() { return NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)]; }

/* ── Grid constants ── */
const CHUNK_SIZE = 60;          // world units per chunk
const ROAD_WIDTH = 14;          // width of a road
const VIEW_RADIUS = 5;          // generate chunks in a 5-chunk radius
const CLEANUP_RADIUS = 7;       // remove chunks beyond this radius

/* ── Seeded random for deterministic chunks ── */
function hashChunk(cx, cz) {
    let h = cx * 374761393 + cz * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    h = h ^ (h >> 16);
    return h;
}
function seededRandom(cx, cz, idx) {
    const h = hashChunk(cx * 31 + idx, cz * 17 + idx);
    return (h & 0x7fffffff) / 0x7fffffff;
}

/* ── Chunk types ── */
const CHUNK_STRAIGHT_NS = 0;  // North-South road
const CHUNK_STRAIGHT_EW = 1;  // East-West road
const CHUNK_CROSS = 2;        // Intersection
const CHUNK_T_NORTH = 3;      // T from south, splits east-west
const CHUNK_EMPTY = 4;        // Building-only block (no road)

export class CyberpunkScene {
    constructor(canvas) {
        this.canvas = canvas;
        this.clock = new THREE.Clock();
        this.chunks = new Map();  // key "cx,cz" -> { group, meshes[], signs[], collidables[] }
        this.signs = [];
        this.trafficVehicles = [];  // oncoming traffic objects
        this.rainDrops = null;

        this._initRenderer();
        this._initScene();
        this._initCamera();
        this._initLights();
        this._initFog();
        this._buildRain();
        this._buildSkybox();
        this._initPostProcessing();

        // Generate initial chunks around origin
        this._updateChunks(0, 0);
    }

    _initRenderer() {
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas, antialias: false, powerPreference: 'high-performance',
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 2.8;
        this.renderer.shadowMap.enabled = false;
        window.addEventListener('resize', () => this._onResize());
    }

    _initScene() { this.scene = new THREE.Scene(); }

    _initCamera() {
        this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1200);
        this.camera.position.set(0, 5, 12);
    }

    _initLights() {
        this.scene.add(new THREE.AmbientLight(0x667799, 3.0));

        const dir = new THREE.DirectionalLight(0xaabbdd, 2.0);
        dir.position.set(10, 50, -20);
        this.scene.add(dir);

        this.scene.add(new THREE.HemisphereLight(0x8866cc, 0x445566, 2.0));

        // Vehicle-following lights
        this._vehicleLight = new THREE.PointLight(0x00ffff, 6, 80, 1.5);
        this.scene.add(this._vehicleLight);
        this._fillLight = new THREE.PointLight(0xff6633, 4, 100, 2);
        this.scene.add(this._fillLight);
    }

    _initFog() { this.scene.fog = new THREE.FogExp2(0x1a1a3a, 0.003); }

    /* ═══════════════════════════════════════
       CHUNK GENERATION — Grid-based
       ═══════════════════════════════════════ */

    _updateChunks(vx, vz) {
        const ccx = Math.round(vx / CHUNK_SIZE);
        const ccz = Math.round(vz / CHUNK_SIZE);

        // Generate missing chunks within radius
        for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
            for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
                if (dx * dx + dz * dz > VIEW_RADIUS * VIEW_RADIUS) continue;
                const cx = ccx + dx;
                const cz = ccz + dz;
                const key = `${cx},${cz}`;
                if (!this.chunks.has(key)) {
                    this._spawnChunk(cx, cz);
                }
            }
        }

        // Remove far chunks
        for (const [key, chunk] of this.chunks) {
            const [cx, cz] = key.split(',').map(Number);
            const dx = cx - ccx;
            const dz = cz - ccz;
            if (dx * dx + dz * dz > CLEANUP_RADIUS * CLEANUP_RADIUS) {
                this._removeChunk(key, chunk);
            }
        }
    }

    /** Walk outward from 0 with variable strides to decide if coord is a road line */
    _isRoadLine(coord, seed) {
        if (coord === 0) return true;
        let pos = 0;
        if (coord > 0) {
            while (pos < coord) {
                const stride = 2 + (((hashChunk(pos, seed) >>> 0) & 3));  // 2–5
                pos += stride;
                if (pos === coord) return true;
            }
        } else {
            while (pos > coord) {
                const stride = 2 + (((hashChunk(pos, seed) >>> 0) & 3));  // 2–5
                pos -= stride;
                if (pos === coord) return true;
            }
        }
        return false;
    }

    _isNSRoadLine(cx) { return this._isRoadLine(cx, 7777); }
    _isEWRoadLine(cz) { return this._isRoadLine(cz, 9999); }

    _getChunkType(cx, cz) {
        const r = seededRandom(cx, cz, 0);

        const onNSRoad = this._isNSRoadLine(cx);
        const onEWRoad = this._isEWRoadLine(cz);

        if (onNSRoad && onEWRoad) return CHUNK_CROSS;
        if (onNSRoad) return CHUNK_STRAIGHT_NS;
        if (onEWRoad) return CHUNK_STRAIGHT_EW;

        // Off-grid: small chance of surprise road, otherwise buildings
        if (r < 0.12) return CHUNK_CROSS;
        if (r < 0.2) return CHUNK_STRAIGHT_NS;
        if (r < 0.28) return CHUNK_STRAIGHT_EW;
        return CHUNK_EMPTY;
    }

    _spawnChunk(cx, cz) {
        const key = `${cx},${cz}`;
        const group = new THREE.Group();
        const meshes = [];
        const chunkSigns = [];
        const collidables = [];
        const worldX = cx * CHUNK_SIZE;
        const worldZ = cz * CHUNK_SIZE;
        const type = this._getChunkType(cx, cz);

        // Ground plane for every chunk
        const groundGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
        const groundMat = new THREE.MeshStandardMaterial({ color: 0x2a2a44, roughness: 0.85 });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(worldX, -0.01, worldZ);
        group.add(ground);

        if (type === CHUNK_STRAIGHT_NS) {
            this._buildRoadNS(group, worldX, worldZ, cx, cz, collidables);
            this._buildSideBuildings(group, meshes, chunkSigns, worldX, worldZ, 'ns', cx, cz, collidables);
            this._buildObstacles(group, meshes, worldX, worldZ, 'ns', cx, cz, collidables);
        } else if (type === CHUNK_STRAIGHT_EW) {
            this._buildRoadEW(group, worldX, worldZ, cx, cz, collidables);
            this._buildSideBuildings(group, meshes, chunkSigns, worldX, worldZ, 'ew', cx, cz, collidables);
            this._buildObstacles(group, meshes, worldX, worldZ, 'ew', cx, cz, collidables);
        } else if (type === CHUNK_CROSS) {
            this._buildIntersection(group, worldX, worldZ, cx, cz);
            this._buildCornerBuildings(group, meshes, chunkSigns, worldX, worldZ, cx, cz, collidables);
            this._buildTrafficLights(group, meshes, worldX, worldZ, cx, cz, collidables);
        } else {
            // Empty — fill with buildings
            this._buildBlockBuildings(group, meshes, chunkSigns, worldX, worldZ, cx, cz, collidables);
        }

        this.scene.add(group);
        this.chunks.set(key, { group, meshes, signs: chunkSigns, collidables, type, cx, cz });
    }

    _removeChunk(key, chunk) {
        this.scene.remove(chunk.group);
        chunk.group.traverse(c => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) {
                if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                else c.material.dispose();
            }
        });
        for (const m of chunk.meshes) {
            this.scene.remove(m);
            if (m.geometry) m.geometry.dispose();
            if (m.material) m.material.dispose();
        }
        // Remove signs
        this.signs = this.signs.filter(s => !chunk.signs.includes(s));
        // Remove traffic vehicles from this chunk
        this.trafficVehicles = this.trafficVehicles.filter(tv => {
            if (tv._chunkKey === key) {
                this.scene.remove(tv.mesh);
                return false;
            }
            return true;
        });
        this.chunks.delete(key);
    }

    /* ── Road builders ── */

    _buildRoadNS(group, wx, wz, cx, cz, collidables) {
        const roadGeo = new THREE.PlaneGeometry(ROAD_WIDTH, CHUNK_SIZE);
        const roadMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.15 });
        const road = new THREE.Mesh(roadGeo, roadMat);
        road.rotation.x = -Math.PI / 2;
        road.position.set(wx, 0.005, wz);
        group.add(road);

        // Center line
        for (let d = -CHUNK_SIZE / 2; d < CHUNK_SIZE / 2; d += 4) {
            const dGeo = new THREE.PlaneGeometry(0.15, 2);
            const dMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
            const dash = new THREE.Mesh(dGeo, dMat);
            dash.rotation.x = -Math.PI / 2;
            dash.position.set(wx, 0.02, wz + d);
            group.add(dash);
        }

        // Edge neon strips
        for (const s of [-1, 1]) {
            const eGeo = new THREE.BoxGeometry(0.12, 0.08, CHUNK_SIZE);
            const eMat = new THREE.MeshBasicMaterial({ color: s === -1 ? NEON.cyan : NEON.pink });
            const edge = new THREE.Mesh(eGeo, eMat);
            edge.position.set(wx + s * (ROAD_WIDTH / 2 + 0.1), 0.04, wz);
            group.add(edge);
        }

        // Street lamps
        this._addStreetLamps(group, wx, wz, 'ns', cx, cz, collidables);
    }

    _buildRoadEW(group, wx, wz, cx, cz, collidables) {
        const roadGeo = new THREE.PlaneGeometry(CHUNK_SIZE, ROAD_WIDTH);
        const roadMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.15 });
        const road = new THREE.Mesh(roadGeo, roadMat);
        road.rotation.x = -Math.PI / 2;
        road.position.set(wx, 0.005, wz);
        group.add(road);

        // Center line
        for (let d = -CHUNK_SIZE / 2; d < CHUNK_SIZE / 2; d += 4) {
            const dGeo = new THREE.PlaneGeometry(2, 0.15);
            const dMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
            const dash = new THREE.Mesh(dGeo, dMat);
            dash.rotation.x = -Math.PI / 2;
            dash.position.set(wx + d, 0.02, wz);
            group.add(dash);
        }

        for (const s of [-1, 1]) {
            const eGeo = new THREE.BoxGeometry(CHUNK_SIZE, 0.08, 0.12);
            const eMat = new THREE.MeshBasicMaterial({ color: s === -1 ? NEON.cyan : NEON.pink });
            const edge = new THREE.Mesh(eGeo, eMat);
            edge.position.set(wx, 0.04, wz + s * (ROAD_WIDTH / 2 + 0.1));
            group.add(edge);
        }

        this._addStreetLamps(group, wx, wz, 'ew', cx, cz, collidables);
    }

    _buildIntersection(group, wx, wz, cx, cz) {
        // Large square road surface
        const size = ROAD_WIDTH + 8;
        const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
        const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.15 });
        const road = new THREE.Mesh(geo, mat);
        road.rotation.x = -Math.PI / 2;
        road.position.set(wx, 0.005, wz);
        group.add(road);

        // Crosswalk stripes in 4 directions
        for (const dir of ['n', 's', 'e', 'w']) {
            for (let i = -3; i <= 3; i++) {
                const sGeo = new THREE.PlaneGeometry(dir === 'n' || dir === 's' ? 0.8 : 3, dir === 'n' || dir === 's' ? 3 : 0.8);
                const sMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
                const stripe = new THREE.Mesh(sGeo, sMat);
                stripe.rotation.x = -Math.PI / 2;
                const offset = ROAD_WIDTH / 2 + 2;
                if (dir === 'n') stripe.position.set(wx + i * 1.5, 0.02, wz - offset);
                else if (dir === 's') stripe.position.set(wx + i * 1.5, 0.02, wz + offset);
                else if (dir === 'e') stripe.position.set(wx + offset, 0.02, wz + i * 1.5);
                else stripe.position.set(wx - offset, 0.02, wz + i * 1.5);
                group.add(stripe);
            }
        }
    }

    _addStreetLamps(group, wx, wz, dir, cx, cz, collidables) {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.7, roughness: 0.3 });
        const positions = dir === 'ns'
            ? [{ x: wx - ROAD_WIDTH / 2 - 1, z: wz - 15 }, { x: wx + ROAD_WIDTH / 2 + 1, z: wz + 15 }]
            : [{ x: wx - 15, z: wz - ROAD_WIDTH / 2 - 1 }, { x: wx + 15, z: wz + ROAD_WIDTH / 2 + 1 }];

        positions.forEach((p, i) => {
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 7, 6), poleMat);
            pole.position.set(p.x, 3.5, p.z);
            group.add(pole);

            const poleBox = new THREE.Box3().setFromCenterAndSize(
                new THREE.Vector3(p.x, 3.5, p.z),
                new THREE.Vector3(0.5, 7, 0.5)
            );
            collidables.push({ box: poleBox, mesh: pole, type: 'pole' });

            const color = i === 0 ? 0x00ffff : 0xff0080;
            const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), new THREE.MeshBasicMaterial({ color }));
            lamp.position.set(p.x, 7.1, p.z);
            group.add(lamp);
        });
    }

    /* ── Building generators ── */

    _buildSideBuildings(group, meshes, chunkSigns, wx, wz, dir, cx, cz, collidables) {
        const numPerSide = 2 + Math.floor(seededRandom(cx, cz, 10) * 3);
        for (const side of [-1, 1]) {
            for (let i = 0; i < numPerSide; i++) {
                const r = seededRandom(cx, cz, 20 + side * 10 + i);
                const w = 5 + r * 10;
                const h = 12 + seededRandom(cx, cz, 30 + side * 10 + i) * 55;
                const d = 5 + seededRandom(cx, cz, 40 + side * 10 + i) * 8;

                const bGeo = new THREE.BoxGeometry(w, h, d);
                const bMat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color().setHSL(0.65 + seededRandom(cx, cz, 50 + i) * 0.2, 0.3, 0.18 + seededRandom(cx, cz, 60 + i) * 0.12),
                    roughness: 0.75, metalness: 0.2,
                });
                const b = new THREE.Mesh(bGeo, bMat);

                const offset = ROAD_WIDTH / 2 + 5 + seededRandom(cx, cz, 70 + i) * 12;
                if (dir === 'ns') {
                    b.position.set(wx + side * offset, h / 2, wz + (seededRandom(cx, cz, 80 + i) - 0.5) * CHUNK_SIZE * 0.7);
                } else {
                    b.position.set(wx + (seededRandom(cx, cz, 80 + i) - 0.5) * CHUNK_SIZE * 0.7, h / 2, wz + side * offset);
                }
                this.scene.add(b);
                meshes.push(b);

                // Track building as collidable
                const box = new THREE.Box3().setFromCenterAndSize(
                    b.position,
                    new THREE.Vector3(w, h, d)
                );
                collidables.push({ box, mesh: b, type: 'building' });

                // Neon edges & windows
                this._buildingDetails(b, w, h, d, meshes, chunkSigns, dir === 'ns' ? side : 0, cx, cz, i);
            }
        }
    }

    _buildCornerBuildings(group, meshes, chunkSigns, wx, wz, cx, cz, collidables) {
        for (let qi = 0; qi < 4; qi++) {
            const sx = qi < 2 ? -1 : 1;
            const sz = qi % 2 === 0 ? -1 : 1;
            const numB = 1 + Math.floor(seededRandom(cx, cz, 100 + qi) * 2);
            for (let i = 0; i < numB; i++) {
                const w = 5 + seededRandom(cx, cz, 110 + qi * 5 + i) * 8;
                const h = 15 + seededRandom(cx, cz, 120 + qi * 5 + i) * 50;
                const d = 5 + seededRandom(cx, cz, 130 + qi * 5 + i) * 8;

                const bGeo = new THREE.BoxGeometry(w, h, d);
                const bMat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color().setHSL(0.65 + seededRandom(cx, cz, 140 + qi) * 0.2, 0.3, 0.18 + seededRandom(cx, cz, 150 + qi) * 0.12),
                    roughness: 0.75, metalness: 0.2,
                });
                const b = new THREE.Mesh(bGeo, bMat);
                b.position.set(
                    wx + sx * (ROAD_WIDTH / 2 + 6 + i * 8),
                    h / 2,
                    wz + sz * (ROAD_WIDTH / 2 + 6 + seededRandom(cx, cz, 160 + qi + i) * 8)
                );
                this.scene.add(b);
                meshes.push(b);

                const box = new THREE.Box3().setFromCenterAndSize(
                    b.position,
                    new THREE.Vector3(w, h, d)
                );
                collidables.push({ box, mesh: b, type: 'building' });

                this._buildingDetails(b, w, h, d, meshes, chunkSigns, sx, cx, cz, qi * 3 + i);
            }
        }
    }

    _buildBlockBuildings(group, meshes, chunkSigns, wx, wz, cx, cz, collidables) {
        const num = 3 + Math.floor(seededRandom(cx, cz, 200) * 4);
        for (let i = 0; i < num; i++) {
            const w = 5 + seededRandom(cx, cz, 210 + i) * 12;
            const h = 10 + seededRandom(cx, cz, 220 + i) * 60;
            const d = 5 + seededRandom(cx, cz, 230 + i) * 12;

            const bGeo = new THREE.BoxGeometry(w, h, d);
            const bMat = new THREE.MeshStandardMaterial({
                color: new THREE.Color().setHSL(0.65 + seededRandom(cx, cz, 240 + i) * 0.2, 0.3, 0.18 + seededRandom(cx, cz, 250 + i) * 0.12),
                roughness: 0.75, metalness: 0.2,
            });
            const b = new THREE.Mesh(bGeo, bMat);
            b.position.set(
                wx + (seededRandom(cx, cz, 260 + i) - 0.5) * CHUNK_SIZE * 0.7,
                h / 2,
                wz + (seededRandom(cx, cz, 270 + i) - 0.5) * CHUNK_SIZE * 0.7
            );
            this.scene.add(b);
            meshes.push(b);

            const box = new THREE.Box3().setFromCenterAndSize(
                b.position,
                new THREE.Vector3(w, h, d)
            );
            collidables.push({ box, mesh: b, type: 'building' });

            this._buildingDetails(b, w, h, d, meshes, chunkSigns, 1, cx, cz, i);
        }
    }

    _buildingDetails(building, w, h, d, meshes, chunkSigns, faceSide, cx, cz, idx) {
        // Neon edge lines
        const color = randomNeon();
        for (const ey of [h / 2, -h / 2 + 0.5]) {
            if (seededRandom(cx, cz, 300 + idx + ey) < 0.4) continue;
            const geo = new THREE.BoxGeometry(w + 0.1, 0.06, 0.06);
            const mat = new THREE.MeshBasicMaterial({ color });
            const line = new THREE.Mesh(geo, mat);
            line.position.set(building.position.x, building.position.y + ey - h / 2, building.position.z);
            this.scene.add(line);
            meshes.push(line);
        }

        // Windows
        const winGeo = new THREE.PlaneGeometry(0.6, 0.8);
        const cols = Math.min(Math.floor(w / 1.5), 6);
        const rows = Math.min(Math.floor(h / 2), 12);
        const faceX = building.position.x + (faceSide < 0 ? 1 : -1) * (w / 2 + 0.01);

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (seededRandom(cx, cz, 400 + idx * 100 + r * 10 + c) < 0.35) continue;
                const lit = seededRandom(cx, cz, 500 + idx * 100 + r * 10 + c) < 0.65;
                const wc = lit
                    ? new THREE.Color().setHSL(seededRandom(cx, cz, 600 + idx * 100 + r * 10 + c) * 0.25, 0.6, 0.5)
                    : new THREE.Color(0x121225);
                const wMat = new THREE.MeshBasicMaterial({ color: wc });
                const win = new THREE.Mesh(winGeo, wMat);
                win.position.set(faceX, building.position.y - h / 2 + 2 + r * 2, building.position.z - w / 2 + 1.5 + c * 1.5);
                win.rotation.y = faceSide < 0 ? Math.PI / 2 : -Math.PI / 2;
                this.scene.add(win);
                meshes.push(win);
            }
        }

        // Billboard (occasional)
        if (seededRandom(cx, cz, 700 + idx) < 0.3) {
            const bbW = 3 + seededRandom(cx, cz, 710 + idx) * 4;
            const bbH = 2 + seededRandom(cx, cz, 720 + idx) * 3;
            const bbGeo = new THREE.PlaneGeometry(bbW, bbH);
            const bbMat = new THREE.MeshBasicMaterial({
                color: randomNeon(), transparent: true, opacity: 0.8,
            });
            const bb = new THREE.Mesh(bbGeo, bbMat);
            bb.position.set(faceX, building.position.y + seededRandom(cx, cz, 730 + idx) * h * 0.2, building.position.z);
            bb.rotation.y = faceSide < 0 ? Math.PI / 2 : -Math.PI / 2;
            this.scene.add(bb);
            meshes.push(bb);
            const signObj = { mesh: bb, baseOpacity: bbMat.opacity, phase: seededRandom(cx, cz, 740 + idx) * Math.PI * 2 };
            this.signs.push(signObj);
            chunkSigns.push(signObj);
        }
    }

    /* ── Obstacles ── */

    _buildObstacles(group, meshes, wx, wz, dir, cx, cz, collidables) {
        const r = seededRandom(cx, cz, 800);

        // Roadblock barrier (30% chance)
        if (r < 0.3) {
            this._addRoadblock(group, meshes, wx, wz, dir, cx, cz, collidables);
        }

        // Oncoming traffic (40% chance)
        if (seededRandom(cx, cz, 810) < 0.4) {
            this._addOncomingTraffic(wx, wz, dir, cx, cz);
        }
    }

    _addRoadblock(group, meshes, wx, wz, dir, cx, cz, collidables) {
        // Which lane to block
        const lane = seededRandom(cx, cz, 820) < 0.5 ? -1 : 1;
        const laneOffset = lane * 3.5;
        const alongOffset = (seededRandom(cx, cz, 830) - 0.5) * CHUNK_SIZE * 0.5;

        // Barrier — striped black/yellow box
        const bw = dir === 'ns' ? 4 : 0.5;
        const bh = 1.2;
        const bd = dir === 'ns' ? 0.5 : 4;
        const barrierGeo = new THREE.BoxGeometry(bw, bh, bd);
        const barrierMat = new THREE.MeshStandardMaterial({ color: 0xffaa00, roughness: 0.6 });
        const barrier = new THREE.Mesh(barrierGeo, barrierMat);
        if (dir === 'ns') {
            barrier.position.set(wx + laneOffset, 0.6, wz + alongOffset);
        } else {
            barrier.position.set(wx + alongOffset, 0.6, wz + laneOffset);
        }
        group.add(barrier);

        const barrierBox = new THREE.Box3().setFromCenterAndSize(
            barrier.position,
            new THREE.Vector3(bw, bh, bd)
        );
        collidables.push({ box: barrierBox, mesh: barrier, type: 'barrier' });

        // Warning stripes
        const stripeGeo = new THREE.BoxGeometry(dir === 'ns' ? 4.02 : 0.52, 0.3, dir === 'ns' ? 0.52 : 4.02);
        const stripeMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
        for (let i = 0; i < 3; i++) {
            const stripe = new THREE.Mesh(stripeGeo, stripeMat);
            stripe.position.copy(barrier.position);
            stripe.position.y = 0.3 + i * 0.4;
            group.add(stripe);
        }

        // Flashing warning light on top
        const lightGeo = new THREE.SphereGeometry(0.15, 8, 8);
        const lightMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const light = new THREE.Mesh(lightGeo, lightMat);
        light.position.copy(barrier.position);
        light.position.y = 1.4;
        group.add(light);

        // Cones on either side
        const coneGeo = new THREE.ConeGeometry(0.2, 0.6, 8);
        const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6600 });
        for (const cOffset of [-2.5, 2.5]) {
            const cone = new THREE.Mesh(coneGeo, coneMat);
            if (dir === 'ns') {
                cone.position.set(wx + laneOffset + cOffset, 0.3, wz + alongOffset);
            } else {
                cone.position.set(wx + alongOffset, 0.3, wz + laneOffset + cOffset);
            }
            group.add(cone);

            const coneBox = new THREE.Box3().setFromCenterAndSize(
                cone.position,
                new THREE.Vector3(0.4, 0.6, 0.4)
            );
            collidables.push({ box: coneBox, mesh: cone, type: 'cone' });
        }
    }

    _addOncomingTraffic(wx, wz, dir, cx, cz) {
        const key = `${cx},${cz}`;
        // Simple box car driving in opposite lane
        const carGeo = new THREE.BoxGeometry(1.8, 0.7, 3.5);
        const carColors = [0xcc0000, 0x0044cc, 0x008800, 0xcccc00, 0xff6600];
        const carMat = new THREE.MeshStandardMaterial({
            color: carColors[Math.floor(seededRandom(cx, cz, 850) * carColors.length)],
            roughness: 0.4, metalness: 0.5,
        });
        const car = new THREE.Mesh(carGeo, carMat);

        // Headlights
        for (const s of [-0.6, 0.6]) {
            const hlGeo = new THREE.BoxGeometry(0.2, 0.12, 0.05);
            const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffcc });
            const hl = new THREE.Mesh(hlGeo, hlMat);
            if (dir === 'ns') {
                hl.position.set(s, 0, 1.78);
            } else {
                hl.position.set(1.78, 0, s);
                hl.rotation.y = Math.PI / 2;
            }
            car.add(hl);
        }

        // Tail lights
        for (const s of [-0.7, 0.7]) {
            const tlGeo = new THREE.BoxGeometry(0.2, 0.1, 0.05);
            const tlMat = new THREE.MeshBasicMaterial({ color: 0xff0022 });
            const tl = new THREE.Mesh(tlGeo, tlMat);
            if (dir === 'ns') {
                tl.position.set(s, 0, -1.78);
            } else {
                tl.position.set(-1.78, 0, s);
                tl.rotation.y = Math.PI / 2;
            }
            car.add(tl);
        }

        // Neon underglow
        const ugGeo = new THREE.PlaneGeometry(2, 4);
        const ugMat = new THREE.MeshBasicMaterial({ color: randomNeon(), transparent: true, opacity: 0.2, side: THREE.DoubleSide });
        const ug = new THREE.Mesh(ugGeo, ugMat);
        ug.rotation.x = -Math.PI / 2;
        ug.position.y = -0.3;
        car.add(ug);

        const lane = 3.5; // oncoming lane
        const startZ = (seededRandom(cx, cz, 860) - 0.5) * CHUNK_SIZE * 0.8;

        if (dir === 'ns') {
            car.position.set(wx - lane, 0.55, wz + startZ);
            car.rotation.y = Math.PI; // facing opposite
        } else {
            car.position.set(wx + startZ, 0.55, wz - lane);
            car.rotation.y = Math.PI / 2;
        }

        this.scene.add(car);
        const speed = 8 + seededRandom(cx, cz, 870) * 12;
        this.trafficVehicles.push({
            mesh: car, dir, speed, _chunkKey: key,
            originX: wx, originZ: wz,
        });
    }

    _buildTrafficLights(group, meshes, wx, wz, cx, cz, collidables) {
        const positions = [
            { x: wx - ROAD_WIDTH / 2 - 1, z: wz - ROAD_WIDTH / 2 - 1, ry: 0 },
            { x: wx + ROAD_WIDTH / 2 + 1, z: wz + ROAD_WIDTH / 2 + 1, ry: Math.PI },
            { x: wx + ROAD_WIDTH / 2 + 1, z: wz - ROAD_WIDTH / 2 - 1, ry: -Math.PI / 2 },
            { x: wx - ROAD_WIDTH / 2 - 1, z: wz + ROAD_WIDTH / 2 + 1, ry: Math.PI / 2 },
        ];

        const poleMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.7, roughness: 0.3 });
        for (const p of positions) {
            // Pole
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 5, 6), poleMat);
            pole.position.set(p.x, 2.5, p.z);
            group.add(pole);

            const poleBox = new THREE.Box3().setFromCenterAndSize(
                new THREE.Vector3(p.x, 2.5, p.z),
                new THREE.Vector3(0.5, 5, 0.5)
            );
            collidables.push({ box: poleBox, mesh: pole, type: 'pole' });

            // Light housing
            const houseGeo = new THREE.BoxGeometry(0.5, 1.5, 0.3);
            const houseMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.5 });
            const house = new THREE.Mesh(houseGeo, houseMat);
            house.position.set(p.x, 5.3, p.z);
            house.rotation.y = p.ry;
            group.add(house);

            // Three lights: red, yellow, green
            const lightColors = [0xff0000, 0xffaa00, 0x00ff00];
            const phase = hashChunk(cx, cz) % 3;
            for (let i = 0; i < 3; i++) {
                const active = i === phase;
                const lg = new THREE.Mesh(
                    new THREE.SphereGeometry(0.12, 8, 8),
                    new THREE.MeshBasicMaterial({
                        color: lightColors[i],
                        transparent: !active,
                        opacity: active ? 1 : 0.15,
                    })
                );
                lg.position.set(p.x, 5.7 - i * 0.45, p.z);
                group.add(lg);
            }
        }
    }

    /* ── Rain ── */
    _buildRain() {
        const COUNT = 10000;
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(COUNT * 3);
        const vel = new Float32Array(COUNT);
        for (let i = 0; i < COUNT; i++) {
            pos[i * 3] = (Math.random() - 0.5) * 200;
            pos[i * 3 + 1] = Math.random() * 60;
            pos[i * 3 + 2] = (Math.random() - 0.5) * 200;
            vel[i] = 0.4 + Math.random() * 0.6;
        }
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({ color: 0x8888cc, size: 0.08, transparent: true, opacity: 0.5, depthWrite: false });
        this.rainDrops = new THREE.Points(geo, mat);
        this.rainVelocities = vel;
        this.scene.add(this.rainDrops);
    }

    /* ── Skybox ── */
    _buildSkybox() {
        const geo = new THREE.SphereGeometry(600, 32, 32);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide, uniforms: {},
            vertexShader: `varying vec3 vWP; void main(){ vWP=(modelMatrix*vec4(position,1.0)).xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
            fragmentShader: `varying vec3 vWP; void main(){
        float h=normalize(vWP).y;
        vec3 lo=vec3(0.08,0.03,0.14); vec3 hi=vec3(0.02,0.02,0.08);
        vec3 c=mix(lo,hi,smoothstep(-0.1,0.5,h));
        float g=exp(-abs(h)*8.0)*0.35; c+=vec3(0.6,0.1,0.35)*g;
        gl_FragColor=vec4(c,1.0);
      }`,
        });
        this.scene.add(new THREE.Mesh(geo, mat));
    }

    /* ── Post-processing ── */
    _initPostProcessing() {
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.8, 0.4, 0.85));
        this.retroPass = new ShaderPass(RetroShader);
        this.composer.addPass(this.retroPass);
    }

    _onResize() {
        const w = window.innerWidth, h = window.innerHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.composer.setSize(w, h);
    }

    /* ── Collision helpers ── */

    getCollidables(vehiclePos, radius) {
        const result = [];
        const rSq = radius * radius;

        // Static collidables from nearby chunks
        for (const [, chunk] of this.chunks) {
            const cx = chunk.cx * CHUNK_SIZE;
            const cz = chunk.cz * CHUNK_SIZE;
            const dx = vehiclePos.x - cx;
            const dz = vehiclePos.z - cz;
            if (dx * dx + dz * dz > (radius + CHUNK_SIZE) * (radius + CHUNK_SIZE)) continue;

            for (const c of chunk.collidables) {
                result.push(c);
            }
        }

        // Traffic vehicles (dynamic — recompute boxes from current position)
        for (const tv of this.trafficVehicles) {
            const pos = tv.mesh.position;
            const dx = vehiclePos.x - pos.x;
            const dz = vehiclePos.z - pos.z;
            if (dx * dx + dz * dz > rSq) continue;

            const box = new THREE.Box3().setFromCenterAndSize(
                pos,
                new THREE.Vector3(1.8, 0.7, 3.5)
            );
            result.push({ box, mesh: tv.mesh, type: 'traffic' });
        }

        return result;
    }

    /* ═══════════════════════════════════════
       UPDATE — called every frame
       ═══════════════════════════════════════ */

    update(vehiclePos, vehicleRot) {
        const dt = this.clock.getDelta();
        const elapsed = this.clock.getElapsedTime();

        // Chunk management
        this._updateChunks(vehiclePos.x, vehiclePos.z);

        // Shader time
        this.retroPass.uniforms.time.value = elapsed;

        // Vehicle lights follow
        this._vehicleLight.position.set(vehiclePos.x, 8, vehiclePos.z - 5);
        this._fillLight.position.set(vehiclePos.x + 5, 12, vehiclePos.z - 15);

        // Rain follows vehicle
        if (this.rainDrops) {
            const pos = this.rainDrops.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) {
                pos.array[i * 3 + 1] -= this.rainVelocities[i] * 60 * dt;
                if (pos.array[i * 3 + 1] < -1) {
                    pos.array[i * 3 + 1] = 50 + Math.random() * 10;
                    pos.array[i * 3] = vehiclePos.x + (Math.random() - 0.5) * 200;
                    pos.array[i * 3 + 2] = vehiclePos.z + (Math.random() - 0.5) * 200;
                }
            }
            pos.needsUpdate = true;
        }

        // Neon sign flicker
        for (const s of this.signs) {
            s.mesh.material.opacity = s.baseOpacity * (0.5 + 0.5 * Math.sin(elapsed * 3 + s.phase));
        }

        // Animate oncoming traffic
        for (const tv of this.trafficVehicles) {
            if (tv.dir === 'ns') {
                tv.mesh.position.z += tv.speed * dt;
                if (tv.mesh.position.z > tv.originZ + CHUNK_SIZE) tv.mesh.position.z = tv.originZ - CHUNK_SIZE;
            } else {
                tv.mesh.position.x += tv.speed * dt;
                if (tv.mesh.position.x > tv.originX + CHUNK_SIZE) tv.mesh.position.x = tv.originX - CHUNK_SIZE;
            }
        }

        // Camera — chase behind vehicle based on its rotation
        const camDist = 10;
        const camHeight = 5;
        const maxCamLag = 3; // max distance camera can fall behind target
        const behindX = vehiclePos.x + Math.sin(vehicleRot.y) * camDist;
        const behindZ = vehiclePos.z + Math.cos(vehicleRot.y) * camDist;
        const camTarget = new THREE.Vector3(behindX, camHeight, behindZ);

        // Smooth exponential follow (frame-rate independent)
        const smoothing = 1 - Math.exp(-8 * dt);
        this.camera.position.lerp(camTarget, smoothing);

        // Clamp camera distance so it never drifts too far from target
        const camOffset = this.camera.position.clone().sub(camTarget);
        if (camOffset.length() > maxCamLag) {
            camOffset.setLength(maxCamLag);
            this.camera.position.copy(camTarget).add(camOffset);
        }

        const lookTarget = new THREE.Vector3(
            vehiclePos.x - Math.sin(vehicleRot.y) * 12,
            1.0,
            vehiclePos.z - Math.cos(vehicleRot.y) * 12
        );
        this.camera.lookAt(lookTarget);

        this.composer.render();
    }

    renderClean() { this.renderer.render(this.scene, this.camera); }
    getRenderer() { return this.renderer; }
}
