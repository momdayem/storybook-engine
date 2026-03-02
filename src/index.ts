import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import { GoogleGenAI } from '@google/genai';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'agent' CHECK (role IN ('admin', 'agent'))
    );
    CREATE TABLE IF NOT EXISTS story_templates (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      master_script JSONB NOT NULL,
      visual_description TEXT
    );
    CREATE TABLE IF NOT EXISTS generated_books (
      id SERIAL PRIMARY KEY,
      agent_id INT REFERENCES users(id),
      kid_name TEXT NOT NULL,
      seed_number BIGINT,
      status TEXT DEFAULT 'pending',
      pdf_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[DB] Schema ready');
}

// ── Gemini ────────────────────────────────────────────────────────────────────
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'Storybook Engine online', timestamp: new Date() });
});

app.get('/api/stats/daily', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT count(*) AS total FROM generated_books WHERE created_at > now() - interval '1 day'`
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/api/stats/agents', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT u.username, count(gb.id) AS books_generated
      FROM users u
      LEFT JOIN generated_books gb ON gb.agent_id = u.id
      GROUP BY u.username
      ORDER BY books_generated DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/generate-story', async (req: Request, res: Response) => {
  const { kidName, kidAge, style, dedication, agentId, imageBase64 } = req.body;

  if (!kidName || !style) {
    res.status(400).json({ error: 'kidName and style are required' });
    return;
  }

  const seed = Math.floor(Math.random() * 900000) + 100000;

  let bookId: number | null = null;
  try {
    const insertResult = await pool.query(
      `INSERT INTO generated_books (agent_id, kid_name, seed_number, status)
       VALUES ($1, $2, $3, 'processing') RETURNING id`,
      [agentId ?? null, kidName, seed]
    );
    bookId = insertResult.rows[0].id;
  } catch (dbErr) {
    console.error('[DB] Insert error:', dbErr);
  }

  try {
    const systemPrompt = `You are a Storybook Architect Engine. Generate a 12-page personalised children's story for a child named ${kidName}${
      kidAge ? ` (age ${kidAge})` : ''
    }.
Rules:
- Art style: ${style}
- Seed number: ${seed} - embed this in every page's visual_prompt to lock the art style.
- Dedication (page 0): "${dedication || 'For ' + kidName}"
- Each page has: page_number (1-12), narration (2-4 warm sentences), visual_prompt (detailed Stable Diffusion / DALL-E prompt including seed_${seed} at the end).
- Keep language age-appropriate, joyful, and encouraging.
- Output ONLY valid JSON - no markdown, no comments.
JSON structure:
{
  "title": "",
  "dedication": "",
  "seed": ${seed},
  "pages": [
    { "page_number": 1, "narration": "...", "visual_prompt": "..." },
    ... (12 pages total)
  ]
}`;

    const contents: any[] = [{ role: 'user', parts: [{ text: systemPrompt }] }];

    if (imageBase64) {
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      contents[0].parts.push({
        inlineData: { mimeType: 'image/jpeg', data: base64Data },
      });
    }

    const result = await genAI.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      contents,
    });

    const rawText = (result.text ?? '').trim();
    const jsonText = rawText.replace(/^```json\n?|```$/g, '').trim();
    const storyJson = JSON.parse(jsonText);

    if (bookId) {
      await pool.query(
        `UPDATE generated_books SET status = 'completed' WHERE id = $1`,
        [bookId]
      );
    }

    res.json({ bookId, seed, story: storyJson });
  } catch (error: any) {
    console.error('[Gemini] Error:', error?.message || error);
    if (bookId) {
      await pool
        .query(`UPDATE generated_books SET status = 'failed' WHERE id = $1`, [bookId])
        .catch(() => {});
    }
    res.status(500).json({ error: 'Story generation failed', detail: error?.message });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Engine] Storybook Engine running on 0.0.0.0:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[Boot] Fatal error:', err);
    process.exit(1);
  });
