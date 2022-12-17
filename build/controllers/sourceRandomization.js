"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paintSource = void 0;
const axios_1 = __importDefault(require("axios"));
async function randomParagraph() {
    const randomTextURL = [
        'https://story-shack-cdn-v2.glitch.me/generators/random-paragraph-generator',
        'https://story-shack-cdn-v2.glitch.me/generators/writing-prompt-generator',
        'https://story-shack-cdn-v2.glitch.me/generators/random-question-generator'
    ];
    const url = randomTextURL[Math.floor(Math.random() * randomTextURL.length)];
    try {
        const response = await axios_1.default.get(url);
        if (response.status === 200) {
            const name = response.data.data.name;
            return name;
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
async function randomList() {
    const size = Math.floor(Math.random() * (10 - 3 + 1)) + 3;
    const list = [];
    for (let i = 0; i < size; i++) {
        const paragraph = await randomParagraph();
        list.push(paragraph);
    }
    return list;
}
async function sourceInsert(str) {
    const list = await randomList();
    return str.replace(/<!--HUTAOWOA-->/g, `<span style="display: none;">${list.join('')}</span>`);
}
async function paintSource(str) {
    str = await sourceInsert(str);
    return str;
}
exports.paintSource = paintSource;
//# sourceMappingURL=sourceRandomization.js.map