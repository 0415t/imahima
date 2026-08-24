import 'dotenv/config';
import express from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
