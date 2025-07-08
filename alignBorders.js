const fs = require('fs');
const cheerio = require('cheerio');
const SvgPath = require('svgpath');
const { kdTree } = require('kd-tree-javascript');

if (process.argv.length < 3) {
  console.error('Usage: node alignBorders.js <input.svg>');
  process.exit(1);
}

const inputFile = process.argv[2];
const svgContent = fs.readFileSync(inputFile, 'utf8');
const $ = cheerio.load(svgContent, { xmlMode: true });

const paths = $('path');
const points = [];
const pathObjs = [];
let id = 0;

paths.each((pIndex, elem) => {
  const d = $(elem).attr('d');
  const sp = new SvgPath(d).abs();
  pathObjs[pIndex] = { sp, elem };
  sp.iterate((seg, idx, startX, startY) => {
    let x = startX;
    let y = startY;
    let pxIdx = null;
    let pyIdx = null;
    switch (seg[0]) {
      case 'M':
      case 'L':
      case 'T':
        pxIdx = 1;
        pyIdx = 2;
        x = seg[1];
        y = seg[2];
        break;
      case 'H':
        pxIdx = 1;
        x = seg[1];
        y = startY;
        break;
      case 'V':
        pyIdx = 1;
        x = startX;
        y = seg[1];
        break;
      case 'C':
        pxIdx = 5;
        pyIdx = 6;
        x = seg[5];
        y = seg[6];
        break;
      case 'S':
        pxIdx = 3;
        pyIdx = 4;
        x = seg[3];
        y = seg[4];
        break;
      case 'Q':
        pxIdx = 3;
        pyIdx = 4;
        x = seg[3];
        y = seg[4];
        break;
      case 'A':
        pxIdx = 6;
        pyIdx = 7;
        x = seg[6];
        y = seg[7];
        break;
      default:
        return;
    }
    points.push({ x, y, pathIndex: pIndex, seg, pxIdx, pyIdx, id: id++ });
  });
});

const dist = (a, b) => Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2);
const tree = new kdTree(points, dist, ['x', 'y']);
const threshold = 0.3;

for (const p of points) {
  const neighbours = tree.nearest(p, 2);
  if (neighbours.length < 2) continue;
  const [other, d2] = neighbours[1];
  if (other.pathIndex === p.pathIndex) continue;
  const distance = Math.sqrt(d2);
  if (distance < threshold) {
    const mx = (p.x + other.x) / 2;
    const my = (p.y + other.y) / 2;
    if (p.pxIdx !== null) p.seg[p.pxIdx] = mx;
    if (p.pyIdx !== null) p.seg[p.pyIdx] = my;
    if (other.pxIdx !== null) other.seg[other.pxIdx] = mx;
    if (other.pyIdx !== null) other.seg[other.pyIdx] = my;
    p.x = mx; p.y = my;
    other.x = mx; other.y = my;
  }
}

paths.each((pIndex, elem) => {
  const sp = pathObjs[pIndex].sp;
  const newD = sp.toString();
  $(elem).attr('d', newD);
});

fs.writeFileSync('output.svg', $.xml());
console.log('Saved to output.svg');
