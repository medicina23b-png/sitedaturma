#!/usr/bin/env node
/**
 * Gera os ícones do app (PWA) e o favicon: "Medicina 23B", fundo branco,
 * com o cajado de Asclépio (bastão + uma serpente).
 *
 * Uso (só precisa rodar de novo se quiser mudar o desenho):
 *   npm install sharp opentype.js
 *   node scripts/make_icons.js caminho/para/Poppins-Bold.ttf caminho/para/Poppins-SemiBold.ttf
 *
 * Saída na raiz do repositório: favicon.svg, favicon.ico, icon-16/32/48/180/192/512.png,
 * icon-maskable-192/512.png, apple-touch-icon.png.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const opentype = require('opentype.js');

const OUT = path.join(__dirname, '..');
const [fontBoldPath, fontSemiPath] = process.argv.slice(2);
if (!fontBoldPath || !fontSemiPath) {
  console.error('Uso: node scripts/make_icons.js Poppins-Bold.ttf Poppins-SemiBold.ttf');
  process.exit(1);
}
const fontBold = opentype.loadSync(fontBoldPath);
const fontSemi = opentype.loadSync(fontSemiPath);

const INK = '#16181d';      // mesma cor de texto do site
const ACCENT = '#2547d0';   // azul de destaque do site
const WHITE = '#ffffff';

// Texto -> <path> centralizado em cx, com a linha de base em y (sem depender
// de fonte instalada em quem abrir o SVG). letterSpacing em unidades do SVG.
function textPath(font, text, size, cx, y, fill, letterSpacing = 0) {
  const glyphs = font.stringToGlyphs(text);
  const scale = size / font.unitsPerEm;
  let width = 0;
  glyphs.forEach((g, i) => { width += g.advanceWidth * scale + (i < glyphs.length - 1 ? letterSpacing : 0); });
  let x = cx - width / 2;
  let d = '';
  glyphs.forEach(g => {
    d += g.getPath(x, y, size).toPathData(2);
    x += g.advanceWidth * scale + letterSpacing;
  });
  return `<path d="${d}" fill="${fill}"/>`;
}

// Cajado de Asclépio desenhado numa caixa 0..100 (x) por 0..160 (y);
// "bold" engrossa os traços para tamanhos pequenos (favicon).
function rod(bold) {
  const staffW = bold ? 14 : 11;
  const snakeW = bold ? 12 : 9;
  const gap = bold ? 5 : 4;
  const sx = 50 - staffW / 2;
  const snake = 'M 50 146 C 22 140, 22 118, 50 112 C 78 106, 78 84, 50 78 C 22 72, 22 50, 50 44 C 72 40, 82 34, 76 26';
  return `
    <rect x="${sx}" y="8" width="${staffW}" height="150" rx="${staffW / 2}" fill="${INK}"/>
    <circle cx="50" cy="9" r="${staffW * 0.72}" fill="${INK}"/>
    <path d="${snake}" fill="none" stroke="${WHITE}" stroke-width="${snakeW + gap * 2}" stroke-linecap="round"/>
    <path d="${snake}" fill="none" stroke="${ACCENT}" stroke-width="${snakeW}" stroke-linecap="round"/>
    <!-- trecho do bastão "por cima" da serpente: dá a ideia de ela estar enrolada -->
    <rect x="${sx - gap}" y="70" width="${staffW + gap * 2}" height="16" fill="${WHITE}"/>
    <rect x="${sx}" y="68" width="${staffW}" height="20" fill="${INK}"/>
    <!-- cabeça -->
    <ellipse cx="75" cy="22" rx="${bold ? 10 : 9}" ry="${bold ? 7 : 6.2}" transform="rotate(-50 75 22)" fill="${ACCENT}" stroke="${WHITE}" stroke-width="${gap * 0.6}"/>
    ${bold ? '' : `<circle cx="77" cy="19" r="1.7" fill="${WHITE}"/>`}`;
}

// Ícone completo 512x512: cajado + "23B" + "MEDICINA". k = escala do
// conteúdo (1 = ícone normal; ~0.78 = versão "maskable", que o Android
// recorta em círculo/gota e precisa do desenho dentro da zona segura).
function fullIcon(k) {
  const inner = `
    <g transform="translate(256 0) scale(1.55) translate(-50 46)">${rod(false)}</g>
    ${textPath(fontBold, '23B', 118, 256, 432, INK, 2)}
    ${textPath(fontSemi, 'MEDICINA', 38, 256, 478, ACCENT, 7)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${WHITE}"/>
  <g transform="translate(256 256) scale(${k}) translate(-256 -272)">${inner}</g>
</svg>`;
}

// Favicon (16/32/48 e favicon.svg): só o cajado, traço grosso, fundo branco arredondado.
function smallIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" rx="22" fill="${WHITE}"/>
  <rect x="0.75" y="0.75" width="98.5" height="98.5" rx="21.5" fill="none" stroke="#d6dae2" stroke-width="1.5"/>
  <g transform="translate(50 50) scale(0.52) translate(-50 -82)">${rod(true)}</g>
</svg>`;
}

// Monta um .ico com PNGs embutidos (formato aceito por todos os navegadores atuais).
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(p => p.buf)]);
}

(async () => {
  const full = fullIcon(1);
  const maskable = fullIcon(0.78);
  const small = smallIcon();
  fs.writeFileSync(path.join(OUT, 'favicon.svg'), small);
  fs.writeFileSync(path.join(OUT, 'icon.svg'), full);

  const png = (svg, size) => sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  const write = (name, buf) => fs.writeFileSync(path.join(OUT, name), buf);

  const smallPngs = [];
  for (const s of [16, 32, 48]) {
    const buf = await png(small, s);
    write(`icon-${s}.png`, buf);
    smallPngs.push({ size: s, buf });
  }
  write('favicon.ico', buildIco(smallPngs));
  for (const s of [180, 192, 512]) write(`icon-${s}.png`, await png(full, s));
  write('apple-touch-icon.png', await png(full, 180));
  for (const s of [192, 512]) write(`icon-maskable-${s}.png`, await png(maskable, s));
  console.log('Ícones gerados em', OUT);
})();
