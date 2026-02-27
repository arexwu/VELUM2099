#!/usr/bin/env python3
"""
NEURODRIVE — Offline Texture Generation with StreamDiffusion
Generates cyberpunk-styled textures from geometric base patterns using SD Turbo.
All textures are grayscale/desaturated (except billboards) for runtime palette tinting.

Usage:
    pip install -r requirements.txt
    python generate_textures.py          # Generate all textures
    python generate_textures.py --dry    # Preview base patterns only (no GPU needed)
"""

import json
import os
import sys
import argparse
from pathlib import Path
from PIL import Image, ImageDraw

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
OUTPUT_DIR = PROJECT_ROOT / "public" / "textures"
PROMPTS_FILE = SCRIPT_DIR / "prompts.json"


def load_prompts():
    with open(PROMPTS_FILE) as f:
        return json.load(f)


# ─── Base pattern generators ───────────────────────────────────────

def make_window_grid(width, height, seed=0):
    """Generate a geometric window grid pattern for building facades."""
    img = Image.new("L", (width, height), 160)
    draw = ImageDraw.Draw(img)
    win_w, win_h = 14, 20
    gap_x, gap_y = 24, 32
    offset_x = (seed * 3) % 8

    for y in range(4, height - win_h, gap_y):
        for x in range(4 + offset_x, width - win_w, gap_x):
            # Window frame
            draw.rectangle([x, y, x + win_w, y + win_h], fill=50)
            # Inner glow (some windows lit)
            if (x * 7 + y * 13 + seed) % 5 < 3:
                draw.rectangle([x + 2, y + 2, x + win_w - 2, y + win_h - 2], fill=90)

    # Horizontal floor lines
    for y in range(0, height, gap_y):
        draw.line([(0, y), (width, y)], fill=130, width=2)

    return img


def make_road_surface(width, height, wet=False):
    """Generate a road surface with lane markings and tire tracks."""
    base = 80 if wet else 100
    img = Image.new("L", (width, height), base)
    draw = ImageDraw.Draw(img)

    # Tire tracks
    for offset in [width // 4, 3 * width // 4]:
        for y in range(0, height):
            x = offset + (y % 7 - 3)
            if 0 <= x < width:
                draw.point((x, y), fill=base - 20)

    # Subtle horizontal texture
    for y in range(0, height, 3):
        draw.line([(0, y), (width, y)], fill=base - 5)

    if wet:
        # Puddle patches
        import random
        random.seed(42)
        for _ in range(8):
            cx, cy = random.randint(0, width), random.randint(0, height)
            rx, ry = random.randint(20, 60), random.randint(10, 30)
            draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=base + 30)

    return img


def make_billboard_base(width, height, cols, rows):
    """Generate a grid of colored billboard cells."""
    img = Image.new("RGB", (width, height), (10, 5, 20))
    draw = ImageDraw.Draw(img)
    cell_w = width // cols
    cell_h = height // rows

    colors = [
        (255, 0, 100), (0, 255, 200), (255, 200, 0), (100, 0, 255),
        (0, 200, 255), (255, 100, 0), (200, 0, 255), (0, 255, 100),
    ]

    for i, color in enumerate(colors):
        col = i % cols
        row = i // cols
        x0 = col * cell_w + 4
        y0 = row * cell_h + 4
        x1 = (col + 1) * cell_w - 4
        y1 = (row + 1) * cell_h - 4
        draw.rectangle([x0, y0, x1, y1], fill=color)
        # Inner glow border
        draw.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], outline=(255, 255, 255))

    return img


def make_ground_tile(width, height):
    """Generate a cracked concrete ground tile."""
    img = Image.new("L", (width, height), 120)
    draw = ImageDraw.Draw(img)

    import random
    random.seed(42)

    # Concrete texture variation
    for y in range(height):
        for x in range(0, width, 2):
            v = 115 + random.randint(-8, 8)
            draw.point((x, y), fill=v)

    # Crack lines
    for _ in range(15):
        points = []
        sx, sy = random.randint(0, width), random.randint(0, height)
        for _ in range(40):
            sx += random.randint(-2, 2)
            sy += random.randint(-2, 2)
            sx = max(0, min(width - 1, sx))
            sy = max(0, min(height - 1, sy))
            points.append((sx, sy))
        if len(points) > 1:
            draw.line(points, fill=80, width=1)

    return img


def make_window_atlas(width, height, cols, rows):
    """Generate a grid of window variants with different lighting."""
    img = Image.new("L", (width, height), 20)
    draw = ImageDraw.Draw(img)
    cell_w = width // cols
    cell_h = height // rows

    import random
    random.seed(123)

    for row in range(rows):
        for col in range(cols):
            x0 = col * cell_w
            y0 = row * cell_h
            brightness = random.randint(30, 230)
            # Window pane
            draw.rectangle(
                [x0 + 3, y0 + 3, x0 + cell_w - 3, y0 + cell_h - 3],
                fill=brightness,
            )
            # Blinds effect on some
            if random.random() < 0.4:
                for ly in range(y0 + 5, y0 + cell_h - 5, 4):
                    draw.line([(x0 + 4, ly), (x0 + cell_w - 4, ly)], fill=brightness - 40)
            # Silhouette on some lit windows
            if brightness > 150 and random.random() < 0.3:
                cx = x0 + cell_w // 2
                cy = y0 + cell_h // 2
                draw.ellipse([cx - 4, cy - 8, cx + 4, cy + 2], fill=brightness - 80)

    return img


# ─── StreamDiffusion integration ───────────────────────────────────

def stylize_with_streamdiffusion(base_image, prompt, negative_prompt, strength, steps, guidance, is_color=False):
    """Run img2img stylization using StreamDiffusion."""
    try:
        from streamdiffusion import StreamDiffusion
        from streamdiffusion.image_utils import postprocess_image
        import torch
    except ImportError:
        print("  [WARN] StreamDiffusion not available — saving base pattern only")
        return base_image

    # Convert grayscale to RGB for the model
    if base_image.mode == "L":
        input_img = base_image.convert("RGB")
    else:
        input_img = base_image

    # Initialize StreamDiffusion pipeline
    stream = StreamDiffusion(
        "stabilityai/sd-turbo",
        t_index_list=[0, 1] if steps >= 2 else [0],
        torch_dtype=torch.float16,
        cfg_type="none",
    )
    stream.load_lcm_lora()
    stream.fuse_lora()
    stream.vae_decode_chunk_size = 1

    # Prepare
    stream.prepare(
        prompt=prompt,
        negative_prompt=negative_prompt,
        guidance_scale=guidance,
        strength=strength,
        width=input_img.width,
        height=input_img.height,
    )

    # Warmup
    for _ in range(2):
        stream(input_img)

    # Generate
    output = stream(input_img)
    result = postprocess_image(output, output_type="pil")[0]

    # Convert back to grayscale if needed
    if not is_color and base_image.mode == "L":
        result = result.convert("L")

    return result


# ─── Main generation pipeline ──────────────────────────────────────

def generate_all(dry_run=False):
    prompts = load_prompts()
    common = prompts["common"]
    textures = prompts["textures"]

    print("NEURODRIVE Texture Generator")
    print(f"Output: {OUTPUT_DIR}")
    print(f"Mode: {'DRY RUN (base patterns only)' if dry_run else 'StreamDiffusion img2img'}\n")

    # Buildings
    bldg = textures["buildings"]
    for i in range(bldg["count"]):
        name = f"facade_{chr(ord('a') + i)}"
        print(f"  Generating buildings/{name}.png ...", end=" ", flush=True)
        base = make_window_grid(bldg["size"][0], bldg["size"][1], seed=i)
        if dry_run:
            result = base
        else:
            result = stylize_with_streamdiffusion(
                base, bldg["prompt"], common["negative_prompt"],
                bldg["strength"], common["num_inference_steps"], common["guidance_scale"],
            )
        result.save(OUTPUT_DIR / "buildings" / f"{name}.png")
        print("OK")

    # Roads
    for road_name, road_cfg in textures["roads"].items():
        print(f"  Generating roads/{road_name}.png ...", end=" ", flush=True)
        wet = "wet" in road_name
        base = make_road_surface(road_cfg["size"][0], road_cfg["size"][1], wet=wet)
        if dry_run:
            result = base
        else:
            result = stylize_with_streamdiffusion(
                base, road_cfg["prompt"], common["negative_prompt"],
                road_cfg["strength"], common["num_inference_steps"], common["guidance_scale"],
            )
        result.save(OUTPUT_DIR / "roads" / f"{road_name}.png")
        print("OK")

    # Billboards
    bb = textures["billboards"]
    print("  Generating billboards/billboard_atlas.png ...", end=" ", flush=True)
    base = make_billboard_base(bb["size"][0], bb["size"][1], bb["grid"][0], bb["grid"][1])
    if dry_run:
        result = base
    else:
        result = stylize_with_streamdiffusion(
            base, bb["prompt"], common["negative_prompt"],
            bb["strength"], common["num_inference_steps"], common["guidance_scale"],
            is_color=True,
        )
    result.save(OUTPUT_DIR / "billboards" / "billboard_atlas.png")
    print("OK")

    # Ground
    gnd = textures["ground"]
    print("  Generating ground/ground_tile.png ...", end=" ", flush=True)
    base = make_ground_tile(gnd["size"][0], gnd["size"][1])
    if dry_run:
        result = base
    else:
        result = stylize_with_streamdiffusion(
            base, gnd["prompt"], common["negative_prompt"],
            gnd["strength"], common["num_inference_steps"], common["guidance_scale"],
        )
    result.save(OUTPUT_DIR / "ground" / "ground_tile.png")
    print("OK")

    # Windows
    win = textures["windows"]
    print("  Generating windows/window_atlas.png ...", end=" ", flush=True)
    base = make_window_atlas(win["size"][0], win["size"][1], win["grid"][0], win["grid"][1])
    if dry_run:
        result = base
    else:
        result = stylize_with_streamdiffusion(
            base, win["prompt"], common["negative_prompt"],
            win["strength"], common["num_inference_steps"], common["guidance_scale"],
        )
    result.save(OUTPUT_DIR / "windows" / "window_atlas.png")
    print("OK")

    print(f"\nDone! {9 if not dry_run else 9} textures written to {OUTPUT_DIR}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate NEURODRIVE textures with StreamDiffusion")
    parser.add_argument("--dry", action="store_true", help="Generate base patterns only (no GPU needed)")
    args = parser.parse_args()
    generate_all(dry_run=args.dry)
