const fs = require('fs');
const zlib = require('zlib');

// 1. Декодируем текстуру Part3_diff.png (капелька меда)
const pngBuf = fs.readFileSync('resources/Part3_diff.png');
let idats = [];
let offset = 8, width, height;
while (offset < pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
        width = pngBuf.readUInt32BE(offset + 8);
        height = pngBuf.readUInt32BE(offset + 12);
    } else if (type === 'IDAT') {
        idats.push(pngBuf.slice(offset + 8, offset + 8 + len));
    }
    offset += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idats));
const stride = 1 + width * 4;
const img = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
            let val = raw[y * stride + 1 + x * 4 + c];
            let a = x > 0 ? img[(y * width + x - 1) * 4 + c] : 0;
            let b = y > 0 ? img[((y - 1) * width + x) * 4 + c] : 0;
            let c_diag = (x > 0 && y > 0) ? img[((y - 1) * width + x - 1) * 4 + c] : 0;
            if (filter === 1) val = (val + a) & 0xff;
            else if (filter === 2) val = (val + b) & 0xff;
            else if (filter === 3) val = (val + Math.floor((a + b) / 2)) & 0xff;
            else if (filter === 4) {
                const p = a + b - c_diag;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c_diag);
                const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c_diag);
                val = (val + pr) & 0xff;
            }
            img[(y * width + x) * 4 + c] = val;
        }
    }
}

// 2. Читаем ticket.obj
const obj = fs.readFileSync('resources/ticket.obj', 'utf8').split('\n');

const mtlColors = {
  Top1Mtl: [0.08, 0.72, 0.15],          // Яркая зеленая верхушка
  Pole1Mtl: [0.65, 0.65, 0.68],
  Part1Mtl: [0.94, 0.94, 0.96],         // Белый корпус
  Part2Mtl: [0.94, 0.94, 0.96],         // Белый корпус
  Window1Mtl: [0.25, 0.45, 0.75],       // Синее стекло окна
  Part3Mtl: [0.94, 0.94, 0.96],         // Подложка под эмблему
  Spamstop1Mtl: [0.15, 0.15, 0.18],     // Черная полоса / защитная рамка
  Conveyorbelt1Mtl: [0.22, 0.22, 0.25]  // Темный конвейер
};

const excludedGroups = new Set(['Platform1', 'Circle1', 'Pole1']);

const positions = [];
const normals = [];
for (let rawLine of obj) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') positions.push([+parts[1], +parts[2], +parts[3]]);
    else if (parts[0] === 'vn') normals.push([+parts[1], +parts[2], +parts[3]]);
}

let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
let curGroup = 'default';

for (let rawLine of obj) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'g' || parts[0] === 'o') curGroup = parts[1];
    else if (parts[0] === 'f') {
        if (excludedGroups.has(curGroup)) continue;
        for (let i = 1; i < parts.length; i++) {
            const vI = parseInt(parts[i].split('/')[0], 10) - 1;
            const p = positions[vI];
            if (p) {
                for (let j = 0; j < 3; j++) {
                    if (p[j] < min[j]) min[j] = p[j];
                    if (p[j] > max[j]) max[j] = p[j];
                }
            }
        }
    }
}

const dispCenterX = (min[0] + max[0]) / 2;
const dispBaseY = min[1];
const dispCenterZ = (min[2] + max[2]) / 2;

const origHeight = max[1] - dispBaseY;
const targetHeight = 3.6;
const scale = targetHeight / origHeight;

const vertexMap = new Map();
const uniqueVerts = [];
const indices = [];

curGroup = 'default';
let curMtl = 'default';

for (let rawLine of obj) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'g' || parts[0] === 'o') {
        curGroup = parts[1];
    } else if (parts[0] === 'usemtl') {
        curMtl = parts[1];
    } else if (parts[0] === 'f') {
        if (excludedGroups.has(curGroup)) continue;
        const fv = parts.slice(1);
        for (let i = 1; i < fv.length - 1; i++) {
            addVert(fv[0], curMtl);
            addVert(fv[i], curMtl);
            addVert(fv[i+1], curMtl);
        }
    }
}

function addVert(tok, mtlName) {
    const [vI, , vnI] = tok.split('/').map(Number);
    const p = positions[vI - 1] || [0, 0, 0];
    const n = (vnI && normals[vnI - 1]) || [0, 1, 0];
    const col = mtlColors[mtlName] || [0.85, 0.85, 0.85];

    const x = +((p[0] - dispCenterX) * scale).toFixed(3);
    const y = +((p[1] - dispBaseY) * scale).toFixed(3);
    const z = +((p[2] - dispCenterZ) * scale).toFixed(3);
    const nx = +(n[0]).toFixed(3);
    const ny = +(n[1]).toFixed(3);
    const nz = +(n[2]).toFixed(3);
    const r = +(col[0]).toFixed(3);
    const g = +(col[1]).toFixed(3);
    const b = +(col[2]).toFixed(3);

    const key = [x, y, z, r, g, b, nx, ny, nz].join(',');
    let idx = vertexMap.get(key);
    if (idx === undefined) {
        idx = uniqueVerts.length / 9;
        vertexMap.set(key, idx);
        uniqueVerts.push(x, y, z, r, g, b, nx, ny, nz);
    }
    indices.push(idx);
}

// 3. Выпекаем капельку меда на грань Part3
// Координаты Part3 из ticket.obj:
// v -145.377 16.4973 204.564 (TopLeft)
// v -138.256 16.4973 204.59  (TopRight)
// v -145.377 9.66097 204.564 (BotLeft)
// v -138.256 9.66097 204.59  (BotRight)
// Нормаль: (0, 0, -1)
const pTopLeft  = [ -145.377, 16.4973, 204.564 ];
const pTopRight = [ -138.256, 16.4973, 204.59 ];
const pBotLeft  = [ -145.377, 9.66097, 204.564 ];
const pBotRight = [ -138.256, 9.66097, 204.59 ];

const offsetOut = -0.04; // Вдоль нормали (0, 0, -1), т.е. z уменьшается
const N = 44;

function getPart3Point(u, v) {
    const x = (1 - u) * ((1 - v) * pBotLeft[0] + v * pTopLeft[0]) + u * ((1 - v) * pBotRight[0] + v * pTopRight[0]);
    const y = (1 - u) * ((1 - v) * pBotLeft[1] + v * pTopLeft[1]) + u * ((1 - v) * pBotRight[1] + v * pTopRight[1]);
    const z = (1 - u) * ((1 - v) * pBotLeft[2] + v * pTopLeft[2]) + u * ((1 - v) * pBotRight[2] + v * pTopRight[2]);

    const scaledX = (x - dispCenterX) * scale;
    const scaledY = (y - dispBaseY) * scale;
    const scaledZ = (z - dispCenterZ) * scale + offsetOut;
    return [scaledX, scaledY, scaledZ];
}

for (let j = 0; j < N; j++) {
    const v0 = j / N;
    const v1 = (j + 1) / N;
    const py = Math.floor((1 - (j + 0.5) / N) * 88);

    let curKey = null;
    let curCol = null;
    let startI = 0;

    for (let i = 0; i <= N; i++) {
        let key = null;
        let col = null;
        if (i < N) {
            const px = Math.floor(((i + 0.5) / N) * 88);
            const idx = (py * 88 + px) * 4;
            const r = img[idx], g = img[idx + 1], b = img[idx + 2], a = img[idx + 3];

            if (a >= 50) {
                if (r > 160 && g > 110 && b < 60) {
                    key = 'H';
                    col = [1.0, 0.72, 0.05]; // Медовый золотистый
                } else if (r > 200 && g > 170) {
                    key = 'HL';
                    col = [1.0, 0.88, 0.35]; // Блик меда
                } else {
                    key = 'O';
                    col = [0.12, 0.12, 0.15]; // Черный контур
                }
            }
        }

        if (key !== curKey) {
            if (curKey !== null && curCol !== null) {
                const u0 = startI / N;
                const u1 = i / N;

                const p0 = getPart3Point(u0, v0); // bot-left
                const p1 = getPart3Point(u1, v0); // bot-right
                const p2 = getPart3Point(u1, v1); // top-right
                const p3 = getPart3Point(u0, v1); // top-left

                const qStart = uniqueVerts.length / 9;
                uniqueVerts.push(
                    +p0[0].toFixed(3), +p0[1].toFixed(3), +p0[2].toFixed(3), curCol[0], curCol[1], curCol[2], 0, 0, -1,
                    +p1[0].toFixed(3), +p1[1].toFixed(3), +p1[2].toFixed(3), curCol[0], curCol[1], curCol[2], 0, 0, -1,
                    +p2[0].toFixed(3), +p2[1].toFixed(3), +p2[2].toFixed(3), curCol[0], curCol[1], curCol[2], 0, 0, -1,
                    +p3[0].toFixed(3), +p3[1].toFixed(3), +p3[2].toFixed(3), curCol[0], curCol[1], curCol[2], 0, 0, -1
                );
                // Нормаль смотрит на -Z, так что CCW обход со стороны наблюдателя: p0->p1->p2->p3
                indices.push(qStart, qStart + 2, qStart + 1, qStart, qStart + 3, qStart + 2);
            }
            curKey = key;
            curCol = col;
            startI = i;
        }
    }
}

const vertFloat = new Float32Array(uniqueVerts);
const indexUint16 = new Uint16Array(indices);

const headerBuffer = Buffer.alloc(8);
headerBuffer.writeUInt32LE(uniqueVerts.length / 9, 0);
headerBuffer.writeUInt32LE(indices.length, 4);

const vertBuffer = Buffer.from(vertFloat.buffer);
const indexBuffer = Buffer.from(indexUint16.buffer);

const totalBinary = Buffer.concat([headerBuffer, vertBuffer, indexBuffer]);
fs.writeFileSync('resources/ticket_dispenser.bin', totalBinary);

const b64 = totalBinary.toString('base64');
fs.writeFileSync('resources/model_ticket_dispenser.js', 'window.TICKET_DISPENSER_BIN = "' + b64 + '";\n');
console.log('Ticket dispenser model generated! Verts:', uniqueVerts.length / 9, 'indices:', indices.length);
