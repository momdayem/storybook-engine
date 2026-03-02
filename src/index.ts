import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';
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

// Run schema migrations on startup
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
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-1.5-pro',
});

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'Storybook Engine online', timestamp: new Date() });
});

// Admin: daily volume
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

// Admin: agent performance
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

// Core: Generate 12-page storybook
app.post('/api/generate-story', async (req: Request, res: Response) => {
  const { kidName, kidAge, style, dedication, agentId, imageBase64 } = req.body;

  if (!kidName || !style) {
    res.status(400).json({ error: 'kidName and style are required' });
    return;
  }

  // Generate 6-digit seed for visual consistency across all 12 pages
  const seed = Math.floor(Math.random() * 900000) + 100000;

  // Insert a pending record immediately so the agent has a bookId
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
    // Non-fatal: continue without a bookId if DB write fails
  }

  try {
    // ── Build Gemini prompt ──────────────────────────────────────────────────
    const systemPrompt = `You are a Storybook Architect Engine. 
Generate a 12-page personalised children's story for a child named ${kidName}${
  kidAge ? ` (age ${kidAge})` : ''
}.

Rules:
- Art style: ${style}
- Seed number: ${seed} — embed this in every page's visual_prompt to lock the art style.
- Dedication (page 0): "${dedication || 'For ' + kidName}"
- Each page has: page_number (1-12), narration (2-4 warm sentences), visual_prompt (detailed Stable Diffusion / DALL-E prompt including seed_${seed} at the end).
- Keep language age-appropriate, joyful, and encouraging.
- Output ONLY valid JSON — no markdown, no comments.

JSON structure:
{
  "title": "<story title>",
  "dedication": "<dedication text>",
  "seed": ${seed},
  "pages": [
    { "page_number": 1, "narration": "...", "visual_prompt": "..." },
    ... (12 pages total)
  ]
}`;

    const parts: any[] = [{ text: systemPrompt }];

    // Optionally attach a reference image (Base64)
    if (imageBase64) {
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      parts.push({
        inlineData: { mimeType: 'image/jpeg', data: base64Data },
      });
    }

    const result = await geminiModel.generateContent(parts);
    const rawText = result.response.text().trim();

    // Strip markdown fences if Gemini wraps JSON in ```json ... ```
    const jsonText = rawText.replace(/^```json\n?|```$/g, '').trim();
    const storyJson = JSON.parse(jsonText);

    // ── Update DB record to 'completed' ──────────────────────────────────────
    if (bookId) {
      await pool.query(
        `UPDATE generated_books SET status = 'completed' WHERE id = $1`,
        [bookId]
      );
    }

    res.json({ bookId, seed, story: storyJson });
  } catch (error: any) {
    console.error('[Gemini] Error:', error?.message || error);
    // Mark as failed in DB
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
