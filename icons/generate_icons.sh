#!/bin/bash
# Genera los íconos PNG usando Python (incluido en macOS)
# Ejecutar una sola vez: bash generate_icons.sh

python3 - <<'EOF'
import struct, zlib, math

def make_png(size, color=(0, 48, 135)):
    """Genera un PNG sólido con un cuadrado de color."""
    def chunk(name, data):
        c = zlib.crc32(name + data) & 0xffffffff
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", c)

    raw = b""
    r, g, b = color
    for y in range(size):
        raw += b"\x00"
        for x in range(size):
            # Dibujar un círculo redondeado simple
            cx, cy = size / 2, size / 2
            rx, ry = size * 0.42, size * 0.42
            in_ellipse = ((x - cx) ** 2 / rx ** 2 + (y - cy) ** 2 / ry ** 2) <= 1
            if in_ellipse:
                raw += bytes([r, g, b, 255])
            else:
                raw += bytes([0, 0, 0, 0])

    compressed = zlib.compress(raw)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")
    return png

for size in [16, 48, 128]:
    with open(f"icon{size}.png", "wb") as f:
        f.write(make_png(size))
    print(f"Generado icon{size}.png")
EOF
