const fs = require('fs');
const zlib = require('zlib');

// 1. Декодируем текстуру Backglass2_diff.png
const pngBuf = fs.readFileSync('resources/Backglass2_diff.png');
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

// 2. Читаем egg.obj
const obj = fs.readFileSync('resources/egg.obj', 'utf8').split('\n');

const mtlColors = {
  Pole1Mtl: [0.85, 0.85, 0.87],          // Верхний металлический шест
  RoundPeace1Mtl: [0.82, 0.82, 0.85],
  RoundPeace2Mtl: [0.88, 0.12, 0.14],
  Backglass1Mtl: [0.92, 0.12, 0.15],     // Яркая красная рамка дисплея
  Backglass2Mtl: [0.88, 0.12, 0.14],     // Красный фон экрана (как в оригинале BSS)
  EggRing1Mtl: [0.1, 0.1, 0.1],          // Черная полоса яйца
  Part16Mtl: [0.4, 0.4, 0.42],           // Серые педали/дверка
  EggMesh1Mtl: [1.0, 0.84, 0.08]         // Ярко-желтое яйцо на тумбе
};

const excludedGroups = new Set(['RoundPeace1', 'RoundPeace2', 'Part3', 'Part6']);

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

const standCenterX = (min[0] + max[0]) / 2;
const standBaseY = min[1];
const standCenterZ = (min[2] + max[2]) / 2;

const origHeight = max[1] - standBaseY;
const targetHeight = 5.8;
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
    const col = mtlColors[mtlName] || [0.8, 0.8, 0.8];

    const x = +((p[0] - standCenterX) * scale).toFixed(3);
    const y = +((p[1] - standBaseY) * scale).toFixed(3);
    const z = +((p[2] - standCenterZ) * scale).toFixed(3);
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

// 3. Выпекаем точную текстуру яйца из Backglass2_diff.png на каждый из 4 экранов
const glassScreens = [
    { name: 'Front', f: [1489, 1490, 1491, 1492] },
    { name: 'Right', f: [671, 672, 673, 674] },
    { name: 'Back',  f: [643, 644, 645, 646] },
    { name: 'Left',  f: [837, 838, 839, 840] }
];

const N = 44; // Сетка 44x44 дает четкий контур яйца
const offsetOut = 0.05; // Смещение наружу от экрана для избежания z-fighting

for (let g of glassScreens) {
    const pTopRight = positions[g.f[0] - 1];
    const pTopLeft  = positions[g.f[1] - 1];
    const pBotRight = positions[g.f[2] - 1];
    const pBotLeft  = positions[g.f[3] - 1];

    // Нормаль экрана наружу
    const tx = pTopRight[0] - pTopLeft[0];
    const tz = pTopRight[2] - pTopLeft[2];
    const uy = pTopLeft[1] - pBotLeft[1];
    const nx = -tz * uy;
    const nz = tx * uy;
    const nlen = Math.hypot(nx, nz);
    const normX = nx / nlen;
    const normZ = nz / nlen;

    // Функция интерполяции точки на экране (u: 0..1 слева направо, v: 0..1 снизу вверх)
    function getPoint(u, v) {
        const x = (1 - u) * ((1 - v) * pBotLeft[0] + v * pTopLeft[0]) + u * ((1 - v) * pBotRight[0] + v * pTopRight[0]);
        const y = (1 - u) * ((1 - v) * pBotLeft[1] + v * pTopLeft[1]) + u * ((1 - v) * pBotRight[1] + v * pTopRight[1]);
        const z = (1 - u) * ((1 - v) * pBotLeft[2] + v * pTopLeft[2]) + u * ((1 - v) * pBotRight[2] + v * pTopRight[2]);

        const scaledX = (x - standCenterX) * scale + normX * offsetOut;
        const scaledY = (y - standBaseY) * scale;
        const scaledZ = (z - standCenterZ) * scale + normZ * offsetOut;
        return [scaledX, scaledY, scaledZ];
    }

    // Сканируем строки текстуры снизу вверх (v от 0 до 1, py от height-1 до 0)
    for (let j = 0; j < N; j++) {
        const v0 = j / N;
        const v1 = (j + 1) / N;
        const py = Math.floor((1 - (j + 0.5) / N) * 88);

        let curKey = null;
        let startI = 0;

        for (let i = 0; i <= N; i++) {
            let key = null;
            let col = null;
            if (i < N) {
                const px = Math.floor(((i + 0.5) / N) * 88);
                const idx = (py * 88 + px) * 4;
                const r = img[idx], g = img[idx + 1], b = img[idx + 2], a = img[idx + 3];

                if (a >= 50) {
                    if (r > 150 && g > 150) {
                        key = 'Y';
                        col = [1.0, 0.85, 0.05]; // Желтый цвет яйца
                    } else {
                        key = 'B';
                        col = [0.10, 0.10, 0.12]; // Черный контур и полоса яйца
                    }
                }
            }

            if (key !== curKey) {
                if (curKey !== null && curCol !== null) {
                    const u0 = startI / N;
                    const u1 = i / N;

                    const p0 = getPoint(u0, v0); // bot-left
                    const p1 = getPoint(u1, v0); // bot-right
                    const p2 = getPoint(u1, v1); // top-right
                    const p3 = getPoint(u0, v1); // top-left

                    const qStart = uniqueVerts.length / 9;
                    uniqueVerts.push(
                        +p0[0].toFixed(3), +p0[1].toFixed(3), +p0[2].toFixed(3), curCol[0], curCol[1], curCol[2], +normX.toFixed(3), 0, +normZ.toFixed(3),
                        +p1[0].toFixed(3), +p1[1].toFixed(3), +p1[2].toFixed(3), curCol[0], curCol[1], curCol[2], +normX.toFixed(3), 0, +normZ.toFixed(3),
                        +p2[0].toFixed(3), +p2[1].toFixed(3), +p2[2].toFixed(3), curCol[0], curCol[1], curCol[2], +normX.toFixed(3), 0, +normZ.toFixed(3),
                        +p3[0].toFixed(3), +p3[1].toFixed(3), +p3[2].toFixed(3), curCol[0], curCol[1], curCol[2], +normX.toFixed(3), 0, +normZ.toFixed(3)
                    );
                    indices.push(qStart, qStart + 1, qStart + 2, qStart, qStart + 2, qStart + 3);
                }
                curKey = key;
                curCol = col;
                startI = i;
            }
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
fs.writeFileSync('resources/egg_shop.bin', totalBinary);

const b64 = totalBinary.toString('base64');
fs.writeFileSync('resources/model_egg_shop.js', 'window.EGG_SHOP_BIN = "' + b64 + '";\n');
console.log('Successfully baked exact Backglass2_diff.png egg emblems onto red screen! Verts:', uniqueVerts.length / 9, 'indices:', indices.length);
