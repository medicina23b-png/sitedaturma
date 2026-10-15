#!/usr/bin/env python3
"""Gera o favicon (monograma "23B") e a imagem "Site da Turma 23B" pedida."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'public')
os.makedirs(OUT, exist_ok=True)

FONT_BOLD = "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf"
FONT_SEMI = "/usr/share/fonts/truetype/google-fonts/Poppins-Medium.ttf"
if not os.path.exists(FONT_SEMI):
    FONT_SEMI = FONT_BOLD

INK = (22, 24, 29, 255)        # #16181d — mesma cor do theme-color do site
ACCENT = (99, 142, 255, 255)   # azul de destaque
WHITE = (255, 255, 255, 255)


def rounded_bg(size, radius_ratio=0.22, bg=INK):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=bg)
    return img, d


def favicon_icon(size):
    img, d = rounded_bg(size)
    # barrinha de destaque no topo (lembra a "agenda" do site)
    bar_h = max(2, round(size * 0.07))
    pad = round(size * 0.14)
    d.rounded_rectangle([pad, pad * 0.9, size - pad, pad * 0.9 + bar_h], radius=bar_h / 2, fill=ACCENT)
    txt = "23B"
    fsize = round(size * 0.46)
    font = ImageFont.truetype(FONT_BOLD, fsize)
    bbox = d.textbbox((0, 0), txt, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text((size / 2 - w / 2 - bbox[0], size / 2 - h / 2 - bbox[1] + size * 0.04), txt, font=font, fill=WHITE)
    return img


sizes = [16, 32, 48, 180, 192, 512]
imgs = {}
for s in sizes:
    im = favicon_icon(s)
    imgs[s] = im
    im.save(os.path.join(OUT, f'icon-{s}.png'))

# favicon.ico multi-resolução
imgs[256 if 256 in imgs else 48].save  # noop, mantém referência
ico_sizes = [16, 32, 48]
imgs[16].save(os.path.join(OUT, 'favicon.ico'), sizes=[(s, s) for s in ico_sizes],
              append_images=[imgs[s] for s in ico_sizes[1:]])
imgs[180].save(os.path.join(OUT, 'apple-touch-icon.png'))
imgs[192].save(os.path.join(OUT, 'icon-192.png'))
imgs[512].save(os.path.join(OUT, 'icon-512.png'))

print('favicon.ico e icon-*.png gerados em', OUT)

# ---------------------------------------------------------------------------
# Imagem "Site da Turma 23B" — o texto literal pedido, maior que um favicon
# (um favicon de 16/32px não tem como mostrar essa frase com legibilidade).
# Serve como logo/capa (ex.: imagem de topo, compartilhamento em redes).
# ---------------------------------------------------------------------------
W, H = 1200, 630
banner = Image.new('RGB', (W, H), INK)
d = ImageDraw.Draw(banner)

# faixa de destaque
d.rounded_rectangle([80, 150, 1120, 166], radius=8, fill=ACCENT)

f_small = ImageFont.truetype(FONT_SEMI, 34)
f_big = ImageFont.truetype(FONT_BOLD, 92)

d.text((80, 190), "SITE DA TURMA", font=f_big, fill=WHITE)
d.text((80, 300), "23B", font=ImageFont.truetype(FONT_BOLD, 150), fill=ACCENT)
d.text((80, 470), "Cronograma Acadêmico", font=f_small, fill=(170, 176, 190, 255))

banner.save(os.path.join(OUT, 'site-da-turma-23b.png'))
print('site-da-turma-23b.png gerado em', OUT)
