import { parseVector, cosineSimilarity, aggregatePromptScores } from './tag-calibration.mjs';

export function createTagPreview({ getPool, getOwnerId, readTagTaxonomy, immichMachineLearningUrl, fetch = globalThis.fetch }) {
  const tagTextEmbeddingCache = new Map();
async function encodeTagPrompt(text, modelName, language = 'en-US') {
  const key = `${modelName}\0${language}\0${text}`;
  if (tagTextEmbeddingCache.has(key)) return tagTextEmbeddingCache.get(key);
  const form = new FormData();
  form.append('entries', JSON.stringify({ clip: { textual: { modelName, options: { language } } } }));
  form.append('text', text);
  let response;
  try {
    response = await fetch(new URL('predict', immichMachineLearningUrl), { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  } catch (error) {
    const wrapped = new Error(`Immich Machine Learning ist nicht erreichbar (${immichMachineLearningUrl}): ${error.message}`);
    wrapped.status = 503;
    throw wrapped;
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    const error = new Error(`Text-Embedding fehlgeschlagen: HTTP ${response.status} ${detail}`);
    error.status = 502;
    throw error;
  }
  const data = await response.json();
  if (!data?.clip) throw new Error('Immich ML hat kein clip-Embedding zurückgegeben.');
  const embedding = parseVector(data.clip);
  if (tagTextEmbeddingCache.size >= 512) tagTextEmbeddingCache.delete(tagTextEmbeddingCache.keys().next().value);
  tagTextEmbeddingCache.set(key, embedding);
  return embedding;
}

async function getTagCalibrationPreview(concept, { sampleSize = 48, candidatePerPrompt = 80 } = {}) {
  const pool = getPool();
  const ownerId = await getOwnerId();
  const prompts = (concept.prompts_en || []).map((item) => String(item).trim()).filter(Boolean);
  if (!prompts.length) { const error = new Error('Der Tag hat keine Prompts.'); error.status = 400; throw error; }
  const taxonomy = readTagTaxonomy();
  const modelName = taxonomy.target_model || 'ViT-SO400M-16-SigLIP2-384__webli';
  const promptVectors = [];
  for (const prompt of prompts) promptVectors.push({ prompt, vector: await encodeTagPrompt(prompt, modelName, 'en-US') });
  const dimension = promptVectors[0].vector.length;
  if (promptVectors.some((item) => item.vector.length !== dimension)) throw new Error('Prompt-Vektoren haben unterschiedliche Dimensionen.');

  const candidates = new Map();
  const limit = Math.max(10, Math.min(250, Math.floor(Number(candidatePerPrompt)) || 80));
  for (const { vector } of promptVectors) {
    const vectorText = `[${vector.join(',')}]`;
    const result = await pool.query(
      `SELECT ss."assetId", ss.embedding::text AS embedding,
              a."originalFileName", a."fileCreatedAt", a."localDateTime", a."createdAt"
         FROM smart_search ss
         JOIN asset a ON a.id = ss."assetId"
        WHERE a."deletedAt" IS NULL
          AND a."ownerId" = $3::uuid
          AND a.visibility IN ('timeline', 'archive')
        ORDER BY ss.embedding <=> $1::vector
        LIMIT $2`,
      [vectorText, limit, ownerId],
    );
    for (const row of result.rows) candidates.set(row.assetId, row);
  }

  const mode = concept.prompt_aggregation || 'top2_mean';
  const rows = [];
  for (const row of candidates.values()) {
    const imageVector = parseVector(row.embedding);
    if (imageVector.length !== dimension) {
      const error = new Error(`Embedding-Dimension passt nicht: smart_search=${imageVector.length}, Text=${dimension}. Ist Immich bereits vollständig mit ${modelName} neu indiziert?`);
      error.status = 409;
      throw error;
    }
    const promptScores = promptVectors.map(({ prompt, vector }) => ({ prompt, score: cosineSimilarity(imageVector, vector) }));
    const score = aggregatePromptScores(promptScores.map((item) => item.score), mode);
    rows.push({
      assetId: row.assetId,
      originalFileName: row.originalFileName || '',
      fileCreatedAt: row.fileCreatedAt || row.localDateTime || row.createdAt || null,
      score,
      promptScores,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  const size = Math.max(12, Math.min(120, Math.floor(Number(sampleSize)) || 48));
  return { modelName, dimension, aggregation: mode, prompts, totalCandidates: rows.length, items: rows.slice(0, size) };
}


  return getTagCalibrationPreview;
}
