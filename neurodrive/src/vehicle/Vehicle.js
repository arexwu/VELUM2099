/* ═══════════════════════════════════════════
   NEURODRIVE — Vehicle Controller
   Low-poly cyberpunk car with keyboard controls
   ═══════════════════════════════════════════ */

import * as THREE from 'three';

const NEON_UNDERGLOW = 0x00ffff;

export class Vehicle {
    constructor(scene) {
        this.scene = scene;

        // Physics state
        this.position = new THREE.Vector3(0, 0, 0);
        this.rotation = new THREE.Euler(0, 0, 0);
        this.velocity = 0;        // m/s forward
        this.steerAngle = 0;      // radians
        this.throttle = 0;        // 0..1
        this.brake = 0;           // 0..1
        this.handbrake = false;

        // Constants
        this.maxSpeed = 60;       // m/s (~216 km/h)
        this.acceleration = 20;   // m/s²
        this.brakeForce = 35;     // m/s²
        this.friction = 5;        // m/s²
        this.maxSteer = 0.6;      // radians
        this.steerSpeed = 2.5;    // rad/s
        this.steerReturn = 4.0;   // rad/s return to center

        // Input state
        this.keys = {
            forward: false,
            backward: false,
            left: false,
            right: false,
            handbrake: false,
        };

        this._buildMesh();
        this._bindInput();
    }

    _buildMesh() {
        this.group = new THREE.Group();

        // Main body — low-poly wedge shape
        const bodyGeo = new THREE.BoxGeometry(2.0, 0.6, 4.5);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0x111111,
            roughness: 0.3,
            metalness: 0.8,
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.5;
        this.group.add(body);

        // Cabin — smaller box on top
        const cabinGeo = new THREE.BoxGeometry(1.6, 0.5, 2.0);
        const cabinMat = new THREE.MeshStandardMaterial({
            color: 0x0a0a1a,
            roughness: 0.2,
            metalness: 0.6,
            transparent: true,
            opacity: 0.7,
        });
        const cabin = new THREE.Mesh(cabinGeo, cabinMat);
        cabin.position.y = 1.05;
        cabin.position.z = -0.3;
        this.group.add(cabin);

        // Underglow
        const glowGeo = new THREE.PlaneGeometry(2.4, 5.0);
        const glowMat = new THREE.MeshBasicMaterial({
            color: NEON_UNDERGLOW,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
        });
        const glow = new THREE.Mesh(glowGeo, glowMat);
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = 0.05;
        this.group.add(glow);
        this._underglow = glow;

        // Headlights (two small bright boxes)
        for (const side of [-0.7, 0.7]) {
            const hlGeo = new THREE.BoxGeometry(0.3, 0.15, 0.05);
            const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
            const hl = new THREE.Mesh(hlGeo, hlMat);
            hl.position.set(side, 0.55, -2.28);
            this.group.add(hl);
        }

        // Tail lights (red)
        for (const side of [-0.8, 0.8]) {
            const tlGeo = new THREE.BoxGeometry(0.25, 0.1, 0.05);
            const tlMat = new THREE.MeshBasicMaterial({ color: 0xff0022 });
            const tl = new THREE.Mesh(tlGeo, tlMat);
            tl.position.set(side, 0.55, 2.28);
            this.group.add(tl);
        }

        // Neon trim on sides
        for (const side of [-1, 1]) {
            const trimGeo = new THREE.BoxGeometry(0.04, 0.04, 4.5);
            const trimMat = new THREE.MeshBasicMaterial({ color: 0xff0080 });
            const trim = new THREE.Mesh(trimGeo, trimMat);
            trim.position.set(side * 1.02, 0.3, 0);
            this.group.add(trim);
        }

        // Wheels (simple cylinders)
        const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 8);
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
        this.wheels = [];
        const wheelPositions = [
            [-0.9, 0.3, -1.5],
            [0.9, 0.3, -1.5],
            [-0.9, 0.3, 1.5],
            [0.9, 0.3, 1.5],
        ];
        for (const [x, y, z] of wheelPositions) {
            const wheel = new THREE.Mesh(wheelGeo, wheelMat);
            wheel.rotation.z = Math.PI / 2;
            wheel.position.set(x, y, z);
            this.group.add(wheel);
            this.wheels.push(wheel);
        }

        this.group.position.copy(this.position);
        this.scene.add(this.group);
    }

    _bindInput() {
        this._onKeyDown = (e) => {
            switch (e.code) {
                case 'KeyW': case 'ArrowUp': this.keys.forward = true; break;
                case 'KeyS': case 'ArrowDown': this.keys.backward = true; break;
                case 'KeyA': case 'ArrowLeft': this.keys.left = true; break;
                case 'KeyD': case 'ArrowRight': this.keys.right = true; break;
                case 'Space': this.keys.handbrake = true; break;
            }
        };
        this._onKeyUp = (e) => {
            switch (e.code) {
                case 'KeyW': case 'ArrowUp': this.keys.forward = false; break;
                case 'KeyS': case 'ArrowDown': this.keys.backward = false; break;
                case 'KeyA': case 'ArrowLeft': this.keys.left = false; break;
                case 'KeyD': case 'ArrowRight': this.keys.right = false; break;
                case 'Space': this.keys.handbrake = false; break;
            }
        };
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
    }

    unbindInput() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
    }

    update(dt) {
        // Throttle / brake from keys
        this.throttle = this.keys.forward ? 1 : 0;
        this.brake = this.keys.backward ? 1 : 0;
        this.handbrake = this.keys.handbrake;

        // Steering
        if (this.keys.left) {
            this.steerAngle = Math.min(this.steerAngle + this.steerSpeed * dt, this.maxSteer);
        } else if (this.keys.right) {
            this.steerAngle = Math.max(this.steerAngle - this.steerSpeed * dt, -this.maxSteer);
        } else {
            // Return to center
            if (this.steerAngle > 0) {
                this.steerAngle = Math.max(0, this.steerAngle - this.steerReturn * dt);
            } else if (this.steerAngle < 0) {
                this.steerAngle = Math.min(0, this.steerAngle + this.steerReturn * dt);
            }
        }

        // Acceleration
        if (this.throttle > 0) {
            this.velocity += this.acceleration * this.throttle * dt;
        }

        // Braking
        if (this.brake > 0) {
            this.velocity -= this.brakeForce * this.brake * dt;
        }

        // Handbrake
        if (this.handbrake) {
            this.velocity *= Math.pow(0.2, dt);
        }

        // Friction
        if (this.throttle === 0 && this.brake === 0 && !this.handbrake) {
            if (this.velocity > 0) {
                this.velocity = Math.max(0, this.velocity - this.friction * dt);
            } else if (this.velocity < 0) {
                this.velocity = Math.min(0, this.velocity + this.friction * dt);
            }
        }

        // Clamp speed
        this.velocity = Math.max(-this.maxSpeed * 0.3, Math.min(this.velocity, this.maxSpeed));

        // Turning (only at speed)
        const turnFactor = Math.min(1, Math.abs(this.velocity) / 5);
        this.rotation.y += this.steerAngle * turnFactor * dt * 1.5;

        // Position update
        const forward = new THREE.Vector3(0, 0, -1);
        forward.applyEuler(this.rotation);
        this.position.addScaledVector(forward, this.velocity * dt);

        // Update mesh
        this.group.position.copy(this.position);
        this.group.rotation.copy(this.rotation);

        // Spin wheels
        const wheelSpin = this.velocity * dt * 3;
        for (const w of this.wheels) {
            w.rotation.x += wheelSpin;
        }

        // Underglow pulse
        if (this._underglow) {
            this._underglow.material.opacity = 0.2 + 0.15 * Math.sin(Date.now() * 0.003);
        }
    }

    /* Getters for data collection */
    getSpeed() {
        return Math.abs(this.velocity) * 3.6; // km/h
    }

    getSteeringNormalized() {
        return this.steerAngle / this.maxSteer; // -1..1
    }

    getThrottle() {
        return this.throttle;
    }

    getBrake() {
        return this.brake;
    }

    getPosition() {
        return { x: this.position.x, y: this.position.y, z: this.position.z };
    }

    getRotation() {
        return { x: this.rotation.x, y: this.rotation.y, z: this.rotation.z };
    }
}
