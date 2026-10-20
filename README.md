# Document Q&A

Ask questions about PDFs and get answers that cite the pages they came from. Built with Next.js, TypeScript, Postgres with pgvector, and Gemini.

**Live demo:** https://doc-qa-mu.vercel.app
Uploads are turned off in the public demo (see [Why uploads are off in the demo](#why-uploads-are-off-in-the-demo)). Two sample documents are preloaded: a short story by Mark Twain and the Bitcoin whitepaper.

## What it does

- Reads text-based PDFs (up to 10 MB) and detects duplicate uploads by content hash.
- Answers questions in plain language. Answers stream in with numbered citations, and clicking a number opens the exact passage and page it came from.
- Says so when the documents don't contain the answer, instead of guessing.
- Saves conversations, including which passages each answer used, and restores them after a refresh.
- Works on phones and with a keyboard.


## Design decisions

- **pgvector inside Postgres.** One database holds documents, vectors, conversations and rate limits, so there is no separate vector service to run.
- **Page-aware chunking.** Chunks never cross a page boundary, so every passage has exactly one page number to cite. A 300-character overlap keeps ideas from being cut at a boundary.
- **Hybrid retrieval.** Cosine-similarity vector search and Postgres full-text search each return 20 candidates, which are merged with reciprocal rank fusion. Vector search finds paraphrases, and keyword search catches exact names and terms.
- **A relevance gate, with honest limits.** If the best vector match scores below 0.54, the app answers "nothing relevant" without calling the chat model. I chose the cutoff from the score distribution of my test questions. The scores turned out not to separate on-topic unanswerable questions from answerable ones, so the model's refusal does most of that work (see Evaluation).
- **Citations the server can check.** The model is asked to cite `[S1]`, `[S2]`, and so on. That format can't be confused with reference numbers inside a PDF (for example "Hashcash [6]"). The server checks every id against the passages it actually provided, and the page lists only the sources an answer cited.
- **Streaming over newline-delimited JSON.** One request carries events for the sources, answer tokens, validated citations, and errors.
- **Resilience to model outages.** The chat call has a first-token timeout, retries on 503 and 429 responses, and falls back to other models. This was added after free-tier models were overloaded or retired during development.
- **Protection for a public demo.** A demo-mode switch disables uploads, and Postgres-backed rate limits cap questions per visitor per hour and per day for the whole demo.

## Evaluation

I wrote 41 test questions by hand from the two sample documents: 33 answerable, each with a phrase copied from the document as evidence, and 8 unanswerable. The scripts are in `evals/`.

**Retrieval** (33 answerable questions; a hit means a retrieved passage contains the evidence)

| Method | hit@1 | hit@3 | hit@6 | MRR |
|---|---|---|---|---|
| Vector only | 58% | 79% | 97% | 0.71 |
| Keyword only | 61% | 88% | 94% | 0.75 |
| Hybrid + gate | 64% | 94% | 100% | 0.79 |

**Full pipeline** (40 of 41 cases completed; one failed three times on provider overload)

| Measure | Result |
|---|---|
| Evidence in the retrieved passages | 33 of 33 |
| Answer cites a passage containing the evidence | 32 of 33 |
| Answers judged correct by a model judge | 30 yes, 1 partial, 2 no (of 33) |
| Claims judged supported by their cited passages | 32 of 33 (upper bound, see below) |
| Citations to sources that don't exist | 0 |
| Answerable questions answered with no citation | 0 |
| Unanswerable questions refused (of the 7 completed) | 7, with no invented answers |
| Median time per answer (search + model) | 3.5 s, measured on a laptop |

**How much to trust these numbers**

- The corpus is small (46 chunks from two documents), so retrieval scores are easier than they would be on a large collection.
- One question is worth about 3 points, so small differences are noise. I did not complete a repeat run to measure run-to-run variation.
- I picked the relevance cutoff using these same questions, which flatters the result.
- The judge is the same model family as the answerer, and it is lenient. Reading the answers by hand, I found a claim it marked as supported that the story contradicts: it called a character "the minister's daughter" when the text says she is the daughter's visiting friend. Treat the "supported" figure as an upper bound.
- Two answerable questions failed. One answered from the wrong passage even though the right one was retrieved, and one missed a relationship spread across two passages.
- I did not finish comparing prompt variants, and the held-out question set I wrote was never run.

## Limitations

- Scanned PDFs are rejected, because there is no OCR step.
- Each question is answered on its own. The model does not see earlier messages, so follow-ups like "and the other brother?" don't work yet.
- There are no user accounts. Conversations are identified by a random id kept in the browser.
- Citations are checked for validity (the source exists), not for whether the passage really supports the claim.
- The public demo uses free-tier Gemini models, which have rate limits and occasional overload.

## Why uploads are off in the demo

Free-tier Gemini requests may be used by Google to improve its products, so I don't want visitors' documents sent there. Uploads would also let anyone use up the model quota. To add your own PDFs, run the project locally with your own key.

## Running it yourself

**Prerequisites:** Node.js 20.16+ or 22.3+, a Postgres database with the `pgvector` extension (a free Neon project works), and a Gemini API key from Google AI Studio.

```bash
git clone https://github.com/naolumer/doc-qa.git
cd doc-qa
npm install
cp .env.example .env        # on Windows PowerShell: Copy-Item .env.example .env
# fill in DATABASE_URL and GEMINI_API_KEY in .env
npx prisma migrate deploy
npm run dev
```

Open http://localhost:3000 and upload a text-based PDF. The first migration enables the `vector` extension.

**Environment variables**

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. For migrations use the direct (non-pooled) URL. |
| `GEMINI_API_KEY` | yes | Used for embeddings and answers. Server-side only. |
| `GEMINI_CHAT_MODEL` | no | Answering model (default `gemini-3.1-flash-lite`). |
| `GEMINI_FALLBACK_MODEL` | no | Model to try when the main one is overloaded or unavailable. |
| `DEMO_MODE` | no | Set to `true` to disable uploads. |
| `CHAT_LIMIT_PER_HOUR` | no | Questions per visitor per hour (default 20). |
| `CHAT_LIMIT_PER_DAY` | no | Questions per day for the whole deployment (default 300). |
| `MIN_VECTOR_SCORE` | no | Relevance cutoff (default 0.54). |

Model names change often, and some become unavailable to new keys, so check which ones your key can use.

## Project structure

```
app/                  pages and API routes (upload, chat, documents, conversations)
lib/                  extraction, chunking, embeddings, search, prompt, citations, rate limiting
prisma/               schema and migrations
evals/                question set, retrieval and answer evals, comparison tools
scripts/              small command-line helpers
```

Run the evals (they use your Gemini quota):

```bash
npm run eval:retrieval -- --label my-run
npm run eval:answers -- --label my-run
```

## Things that broke along the way

- `prisma init` installed a Prisma 8 release candidate with a different setup, so I pinned Prisma 7.
- `pdf-parse` v2 changed its API, and on Next.js it needed its worker configured. On Vercel it fails to load without a canvas implementation, which is why the upload route loads it only after the demo-mode check.
- Prisma's 5-second transaction limit expired on 16 separate inserts, so chunks are now inserted in batches.
- Re-uploading the same PDF filled the top results with copies of one passage, which led to the content-hash duplicate check.
- Free-tier models returned 503 under load and 404 when retired, which led to the timeout and fallback logic.
- A model judging a model of the same family let a wrong claim through, which is why I read answers by hand.

## Roadmap

- Conversation memory through query rewriting
- OCR for scanned PDFs
- Accounts and per-user documents
- A larger evaluation set, a stronger and different judge model, and repeated runs to measure variation
- Deleting documents
