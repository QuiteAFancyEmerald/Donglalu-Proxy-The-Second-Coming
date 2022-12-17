import express from 'express';
import * as path from "path";
import * as fs from 'fs';
import SourceRoute from "./controllers/sourceRoute";

const app = express();
const dir_build = path.join(__dirname, 'static');

const pages: SourceRoute = {
    'index': 'index.html',
    'test': 'test.html'
};

app.get('/:page', async (req: express.Request, res: express.Response) => {
  const page = req.params.page;
  if (!pages[page]) {
    return res.redirect('/');
  }
  try {
    const fileContents = await fs.promises.readFile(path.join(dir_build, pages[page]), 'utf8');
    res.send(fileContents);
  } catch (error) {
    console.error(error);
    res.status(404).send('Where is the page?');
  }
});

app.use(express.static(dir_build));

app.listen(3000, () => console.log("Very much up!"));
