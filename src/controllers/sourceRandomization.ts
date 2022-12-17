import express, { Request, Response  } from 'express';
import { randomFill } from 'crypto';
import seedrandom from 'seedrandom';
import axios from 'axios';


const app = express();

async function generateSeed(): Promise<string> {
    const seedBuffer = Buffer.alloc(32);
    randomFill(seedBuffer, (error, buf) => {
    if (error) {
        console.error(error);
    } else {
        console.log(buf);
    }
    });

    let seedString = seedBuffer.toString('hex');
    seedString = seedString.replace(/[^a-zA-Z]/g, '');
    return seedString;
}

async function randomParagraph(seed: string): Promise<string> {
    const rng = seedrandom(seed);
    const randomTextURL = `https://api.deepai.org/api/text-generator`;

    try {
      // Make the API request
      const response = await axios.post(randomTextURL,  {
          'text': rng,
      },
      {headers: {'api-key': 'quickstart-QUdJIGlzIGNvbWluZy4uLi4K'}});

      // Check the response status code
      if (response.status === 200) {
        // Return the text if the request was successful
        console.log(response.data.text)
        return response.data.text;
      } else {
        // Throw an error if the request was not successful
        throw new Error(`API request failed with status code ${response.status}`);
      }
    } catch (error) {
      // Catch and handle any errors that occurred during the request
      console.error(error);
      throw error;
    }
}

async function randomList(seed: string, size: number): Promise<string[]> {
  const list: string[] = [];
  for (let i = 0; i < size; i++) {
    const paragraph = await randomParagraph(seed);
    list.push(paragraph);
  }
  return list;
}

async function randomListItem(seed: string): Promise<string> {
  const list = await randomList(seed, 10);
  return list[Math.floor(Math.random() * list.length)];
}

app.post('/random', async (req: Request, res: Response) => {
    const seed = req.body.seed;
    if (typeof seed !== 'number') {
      res.status(400).send({ error: 'Seed must be an integer' });
      return;
    }
    try {
      const item = await randomListItem(seed.toString());
      res.send({ item });
    } catch (error) {
      console.error(error);
      res.status(500).send({ error: 'Something went wrong' });
    }
});
  
async function sourceInsert(str: string) {
    const listItem = await randomListItem(str);
    return str.replace(/<!--HUTAOWOA-->/g, function() { return listItem; });
}

export async function paintSource(str: string) {
    str = await sourceInsert(str);
    return str;
}
  
  
  
  
  


