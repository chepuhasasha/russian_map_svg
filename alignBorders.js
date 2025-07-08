const fs = require('fs');
const cheerio = require('cheerio');
const { kdTree } = require('kd-tree-javascript');

if (process.argv.length < 3) {
  console.error('Usage: node alignBorders.js <input.svg>');
  process.exit(1);
}

const inputFile = process.argv[2];
const svgContent = fs.readFileSync(inputFile, 'utf8');
const $ = cheerio.load(svgContent, { xmlMode: true });

const paths = $('path');
const allPoints = [];
const pathTokens = [];
let pointId = 0;

const tokenRegex = /([AaCcHhLlMmQqSsTtVvZz]|-?\d*\.?\d+(?:e[-+]?\d+)?)/g;
const commandRegex = /^[AaCcHhLlMmQqSsTtVvZz]$/;

paths.each((pIndex, elem) => {
  const d = $(elem).attr('d');
  const tokens = d.match(tokenRegex) || [];
  pathTokens[pIndex] = tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!commandRegex.test(tokens[i]) && !commandRegex.test(tokens[i + 1])) {
      const x = parseFloat(tokens[i]);
      const y = parseFloat(tokens[i + 1]);
      if (!isNaN(x) && !isNaN(y)) {
        allPoints.push({ x, y, pathIndex: pIndex, i1: i, i2: i + 1, id: pointId++ });
        i++; // move to next pair
      }
    }
  }
});

// build kd-tree
const dist = (a, b) => Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2);
const tree = new kdTree(allPoints, dist, ['x', 'y']);
const threshold = 0.5; // distance threshold to merge

for (const point of allPoints) {
  const neighbours = tree.nearest(point, 2);
  for (const [other, d2] of neighbours) {
    if (other.id === point.id) continue;
    if (point.pathIndex === other.pathIndex) continue;
    if (other.id < point.id) continue; // avoid double processing
    const distance = Math.sqrt(d2);
    if (distance < threshold) {
      const mx = (point.x + other.x) / 2;
      const my = (point.y + other.y) / 2;
      // update tokens
      pathTokens[point.pathIndex][point.i1] = mx.toFixed(2);
      pathTokens[point.pathIndex][point.i2] = my.toFixed(2);
      pathTokens[other.pathIndex][other.i1] = mx.toFixed(2);
      pathTokens[other.pathIndex][other.i2] = my.toFixed(2);
    }
  }
}

// write new svg
paths.each((i, elem) => {
  const newD = pathTokens[i].join(' ');
  $(elem).attr('d', newD);
});

fs.writeFileSync('output.svg', $.xml());
console.log('Saved to output.svg');

