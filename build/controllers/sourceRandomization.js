"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paintSource = void 0;
const axios_1 = __importDefault(require("axios"));
async function randomParagraph() {
    const randomTextURL = `https://story-shack-cdn-v2.glitch.me/generators/random-paragraph-generator`;
    try {
        const response = await axios_1.default.get(randomTextURL);
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
    const size = Math.floor(Math.random() * (10 - 5 + 1)) + 5;
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