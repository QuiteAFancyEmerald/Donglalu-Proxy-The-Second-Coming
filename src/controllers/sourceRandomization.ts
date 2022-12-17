import axios from 'axios';

async function randomParagraph() {
  const randomTextURL = `https://story-shack-cdn-v2.glitch.me/generators/random-paragraph-generator`

  try {
    const response = await axios.get(randomTextURL)
    if (response.status === 200) {
      const name: string = response.data.data.name;
      return name
    } else {
      throw new Error(`API request failed with status code ${response.status}`)
    }
  } catch (error) {
    console.error(error)
    throw error
  }
}

async function randomList(): Promise<string[]> {
  const size = Math.floor(Math.random() * (10 - 5 + 1)) + 5;
  const list: string[] = [];
  for (let i = 0; i < size; i++) {
    const paragraph = await randomParagraph();
    list.push(paragraph);
  }
  return list;
}

async function sourceInsert(str: string) {
  const list = await randomList();
  return str.replace(/<!--HUTAOWOA-->/g, `<span style="display: none;">${list.join('')}</span>`);
}

export async function paintSource(str: string) {
  str = await sourceInsert(str);
  return str;
}