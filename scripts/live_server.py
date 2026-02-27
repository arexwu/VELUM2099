#!/usr/bin/env python3
"""
NEURODRIVE — Live StreamDiffusion Server
FastAPI WebSocket server for real-time screen-space stylization.
Receives JPEG frames from the game, returns AI-stylized frames.

Usage:
    pip install -r requirements.txt
    python live_server.py                    # Default port 8765
    python live_server.py --port 9000        # Custom port
    python live_server.py --strength 0.3     # Lower stylization

Requires NVIDIA GPU with CUDA support.
"""

import argparse
import asyncio
import io
import logging
import time

import numpy as np
from PIL import Image

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("neurodrive-live")

# Lazy imports for GPU-dependent modules
stream_pipeline = None


def init_pipeline(prompt: str, strength: float, width: int = 512, height: int = 512):
    """Initialize StreamDiffusion pipeline (called once on first frame)."""
    global stream_pipeline

    log.info("Initializing StreamDiffusion pipeline...")
    try:
        import torch
        from streamdiffusion import StreamDiffusion
        from streamdiffusion.image_utils import postprocess_image

        stream = StreamDiffusion(
            "stabilityai/sd-turbo",
            t_index_list=[0, 1],
            torch_dtype=torch.float16,
            cfg_type="none",
        )
        stream.load_lcm_lora()
        stream.fuse_lora()
        stream.vae_decode_chunk_size = 1

        stream.prepare(
            prompt=prompt,
            negative_prompt="blurry, low quality",
            guidance_scale=1.0,
            strength=strength,
            width=width,
            height=height,
        )

        # Warmup with a blank image
        blank = Image.new("RGB", (width, height), (0, 0, 0))
        for _ in range(3):
            stream(blank)

        stream_pipeline = stream
        log.info("Pipeline ready!")
        return True

    except Exception as e:
        log.error(f"Failed to initialize pipeline: {e}")
        return False


def stylize_frame(image: Image.Image) -> Image.Image:
    """Run a single frame through the StreamDiffusion pipeline."""
    from streamdiffusion.image_utils import postprocess_image

    output = stream_pipeline(image)
    result = postprocess_image(output, output_type="pil")[0]
    return result


def create_app(prompt: str, strength: float):
    """Create FastAPI application with WebSocket endpoint."""
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="NEURODRIVE Live Stream")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health():
        return {
            "status": "ready" if stream_pipeline else "initializing",
            "prompt": prompt,
            "strength": strength,
        }

    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        await ws.accept()
        log.info("Client connected")

        frame_count = 0
        fps_timer = time.time()

        try:
            while True:
                # Receive JPEG bytes
                data = await ws.receive_bytes()

                # Decode
                image = Image.open(io.BytesIO(data)).convert("RGB")

                # Initialize pipeline on first frame (uses actual frame dimensions)
                if stream_pipeline is None:
                    if not init_pipeline(prompt, strength, image.width, image.height):
                        await ws.send_json({"error": "Pipeline init failed"})
                        break

                # Stylize
                result = stylize_frame(image)

                # Encode response as JPEG
                buf = io.BytesIO()
                result.save(buf, format="JPEG", quality=80)
                await ws.send_bytes(buf.getvalue())

                # FPS tracking
                frame_count += 1
                elapsed = time.time() - fps_timer
                if elapsed >= 5.0:
                    fps = frame_count / elapsed
                    log.info(f"Throughput: {fps:.1f} fps")
                    frame_count = 0
                    fps_timer = time.time()

        except WebSocketDisconnect:
            log.info("Client disconnected")
        except Exception as e:
            log.error(f"Error: {e}")
            try:
                await ws.close()
            except Exception:
                pass

    return app


def main():
    parser = argparse.ArgumentParser(description="NEURODRIVE Live StreamDiffusion Server")
    parser.add_argument("--port", type=int, default=8765, help="WebSocket server port")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address")
    parser.add_argument("--prompt", default="cyberpunk neon city, rain reflections, cinematic, dark atmosphere")
    parser.add_argument("--strength", type=float, default=0.4, help="Stylization strength (0.0-1.0)")
    args = parser.parse_args()

    log.info(f"Starting NEURODRIVE Live Server on {args.host}:{args.port}")
    log.info(f"Prompt: {args.prompt}")
    log.info(f"Strength: {args.strength}")

    app = create_app(args.prompt, args.strength)

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
