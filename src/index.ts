import express, { Request, Response  } from 'express';
import * as path from "path";
import * as fs from 'fs';
import SourceRoute from "./controllers/sourceRoute";
import { paintSource } from './controllers/sourceRandomization';

const app = express();
const port = process.env.PORT || 3000;
const dir_build = path.join(__dirname, 'static');

const pages: SourceRoute = {
    'index': 'index.html',
    'test': 'test.html'
};

app.get('/:page?', async (req: Request, res: Response) => {
  const page = req.params.page || 'index';
  try {
    if (typeof dir_build === 'string' && typeof pages[page] === 'string') {
      const filePath = path.join(dir_build, pages[page]);
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const paintedContents = await paintSource(fileContents);
      res.send(paintedContents);
    } else {
      res.status(500).send('Something went wrong');
    }
  } catch (error) {
    console.error(error);
    res.status(500).send('Something went wrong');
  }
});

app.use(express.static(dir_build));

app.listen(port, () => console.log("DLPCC is now up on " + port + ". Be sure to join our Discord at discord.gg/unblock!"));
