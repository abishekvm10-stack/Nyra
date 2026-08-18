# Nyra Backend

A tiny server that holds one API key privately (yours) so anyone using
Nyra doesn't need their own. Deploy this once, then point the desktop
app's "Nyra Cloud" provider at wherever it ends up.

## Deploy it (free, ~5 minutes, using Render)

1. Push this whole project (including this `backend/` folder) to a
   GitHub repo, same as you did for the Mac build pipeline.
2. Go to [render.com](https://render.com), sign up free, connect your
   GitHub account.
3. **New +** \u2192 **Web Service** \u2192 pick your repo.
4. Set:
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Under **Environment Variables**, add:
   - Key: `GROQ_API_KEY`
   - Value: your actual Groq key (the same one from console.groq.com)
6. Click **Create Web Service**. Render builds and deploys it \u2014 takes
   a couple of minutes.
7. Once live, Render gives you a URL like
   `https://nyra-backend-xxxx.onrender.com`. That's the URL you'll
   enter into the desktop app's Settings.

## A real limitation of the free tier, worth knowing
Render's free instances "spin down" after 15 minutes of no traffic,
and take ~30-50 seconds to wake back up on the next request. This
means the very first compile after a period of inactivity will feel
slow, then it's fast again until it goes idle once more. Fine for
sharing with a friend; not something you'd want for a product with
real daily active users without upgrading off the free tier.

## Testing it directly (optional, useful for debugging)

The current desktop app builds its own system prompt and sends it as
`systemPrompt` — this is the request shape it actually sends:
```
curl -X POST https://your-backend-url.onrender.com/compile \
  -H "Content-Type: application/json" \
  -d '{"text": "write email about delayed package", "tier": "fast", "systemPrompt": "You are a prompt compiler..."}'
```

Without `systemPrompt`, the server falls back to its own older built-in
prompt (kept only for app versions older than this split) — useful for
a quick smoke test without needing a real prompt string:
```
curl -X POST https://your-backend-url.onrender.com/compile \
  -H "Content-Type: application/json" \
  -d '{"text": "write email about delayed package", "tier": "fast"}'
```
Either way, should return JSON like `{"compiledText": "Role: ...`.

## Local testing before deploying
```
cd backend
npm install
GROQ_API_KEY=your_key_here npm start
```
(On Windows PowerShell: `$env:GROQ_API_KEY="your_key_here"; npm start`)
