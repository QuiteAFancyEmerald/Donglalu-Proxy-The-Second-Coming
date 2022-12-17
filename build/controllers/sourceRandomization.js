"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paintSource = void 0;
const express_1 = __importDefault(require("express"));
const crypto_1 = require("crypto");
const seedrandom_1 = __importDefault(require("seedrandom"));
const axios_1 = __importDefault(require("axios"));
const app = (0, express_1.default)();
async function generateSeed() {
    const seedBuffer = Buffer.alloc(32);
    (0, crypto_1.randomFill)(seedBuffer, (error, buf) => {
        if (error) {
            console.error(error);
        }
        else {
            console.log(buf);
        }
    });
    let seedString = seedBuffer.toString('hex');
    seedString = seedString.replace(/[^a-zA-Z]/g, '');
    return seedString;
}
async function main() {
    const seed = await generateSeed();
    const item = await randomParagraph(seed);
    console.log(item);
}
main();
async function randomParagraph(seed) {
    const rng = (0, seedrandom_1.default)(seed);
    const randomTextURL = `https://api.deepai.org/api/text-generator`;
    try {
        const response = await axios_1.default.post(randomTextURL, {
            'text': rng,
        }, { headers: { 'api-key': 'quickstart-QUdJIGlzIGNvbWluZy4uLi4K' } });
        if (response.status === 200) {
            console.log(response.data.text);
            return response.data.text;
        }
        else {
            throw new Error(`API request failed with status code ${response.status}`);
        }
    }
    catch (error) {
        console.error(error);
        throw error;
    }
}
async function randomList(seed, size) {
    const list = [];
    for (let i = 0; i < size; i++) {
        const paragraph = await randomParagraph(seed);
        list.push(paragraph);
    }
    return list;
}
async function randomListItem(seed) {
    const list = await randomList(seed, 10);
    return list[Math.floor(Math.random() * list.length)];
}
app.post('/random', async (req, res) => {
    const seed = req.body.seed;
    if (typeof seed !== 'number') {
        res.status(400).send({ error: 'Seed must be an integer' });
        return;
    }
    try {
        const item = await randomListItem(seed.toString());
        res.send({ item });
    }
    catch (error) {
        console.error(error);
        res.status(500).send({ error: 'Something went wrong' });
    }
});
async function sourceInsert(str) {
    const listItem = await randomListItem(str);
    return str.replace(/<!--HUTAOWOA-->/g, function () { return listItem; });
}
async function paintSource(str) {
    str = await sourceInsert(str);
    return str;
}
exports.paintSource = paintSource;
//# sourceMappingURL=sourceRandomization.js.map