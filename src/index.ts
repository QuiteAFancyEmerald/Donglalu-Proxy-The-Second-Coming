import express, { Request, Response  } from 'express';
import * as path from "path";
import * as fs from 'fs';
import SourceRoute from "./controllers/sourceRoute";
import { paintSource } from './controllers/sourceRandomization';

const app = express();
const dir_build = path.join(__dirname, 'static');

const pages: SourceRoute = {
    'index': 'index.html',
    'test': 'test.html'
};

app.get('/:page', async (req: Request, res: Response) => {
    const page = req.params.page;
    if (!pages[page]) {
      return res.redirect('/');
    }
    try {
      const filePath = path.join(dir_build, pages[page]);
      const fileContents = await fs.promises.readFile(filePath, 'utf8');
      const paintedContents = await paintSource(fileContents);
      res.send(paintedContents);
    } catch (error) {
      console.error(error);
      res.status(404).send('Where is the page?');
    }
});
  

app.use(express.static(dir_build));

app.listen(3000, () => console.log("Very much up!"));
