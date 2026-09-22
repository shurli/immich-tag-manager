import { repairLegacyTaxonomy } from './legacy-taxonomy.mjs';
import fs from 'node:fs';
import path from 'node:path';

export function normalizeTagPath(value) {
  return String(value || '').split('/').map((part) => part.trim()).filter(Boolean).join('/');
}

export function validateTagTaxonomy(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Tag-JSON muss ein Objekt sein.');
  if (!Array.isArray(document.concepts)) throw new Error('Tag-JSON benötigt ein concepts-Array.');
  const ids = new Set();
  const tags = new Set();
  for (const [index, concept] of document.concepts.entries()) {
    if (!concept || typeof concept !== 'object') throw new Error(`concepts[${index}] ist ungültig.`);
    const id = String(concept.id || '').trim();
    const tag = normalizeTagPath(concept.tag);
    if (!id) throw new Error(`concepts[${index}] hat keine id.`);
    if (!tag) throw new Error(`concepts[${index}] hat keinen tag-Pfad.`);
    if (ids.has(id)) throw new Error(`Doppelte Tag-ID: ${id}`);
    if (tags.has(tag.toLocaleLowerCase('de'))) throw new Error(`Doppelter Tag-Pfad: ${tag}`);
    ids.add(id);
    tags.add(tag.toLocaleLowerCase('de'));
    if (concept.prompts_en != null && !Array.isArray(concept.prompts_en)) throw new Error(`${id}: prompts_en muss ein Array sein.`);
  }
  if (document.folders != null) {
    if (!Array.isArray(document.folders)) throw new Error('folders muss ein Array sein.');
    const folders = new Set();
    for (const raw of document.folders) {
      const folder = normalizeTagPath(typeof raw === 'string' ? raw : raw?.path);
      if (!folder) throw new Error('Leerer Ordnerpfad in folders.');
      const key = folder.toLocaleLowerCase('de');
      if (folders.has(key)) throw new Error(`Doppelter Ordnerpfad: ${folder}`);
      folders.add(key);
    }
  }
  return true;
}


export function createTaxonomyStore(tagTaxonomyPath, tagTaxonomyDefaultPath) {
  const tagTaxonomyBackupPath = `${tagTaxonomyPath}.bak`;
  let legacyWarnings = [];
function ensureTagTaxonomyFile() {
  if (fs.existsSync(tagTaxonomyPath)) return;
  fs.mkdirSync(path.dirname(tagTaxonomyPath), { recursive: true });
  if (fs.existsSync(tagTaxonomyDefaultPath)) {
    fs.copyFileSync(tagTaxonomyDefaultPath, tagTaxonomyPath);
    console.log(`Initialized tag taxonomy from ${tagTaxonomyDefaultPath} -> ${tagTaxonomyPath}`);
    return;
  }
  const empty = { schema_version: 2, taxonomy_version: 'custom-v1', tag_language: 'de', prompt_language: 'en', folders: ['KI'], concepts: [] };
  fs.writeFileSync(tagTaxonomyPath, `${JSON.stringify(empty, null, 2)}\n`, 'utf8');
  console.warn(`No default tag taxonomy found at ${tagTaxonomyDefaultPath}; created empty taxonomy at ${tagTaxonomyPath}`);
}

function readTagTaxonomy() {
  ensureTagTaxonomyFile();
  const document = JSON.parse(fs.readFileSync(tagTaxonomyPath, 'utf8'));
  legacyWarnings = repairLegacyTaxonomy(document);
  validateTagTaxonomy(document);
  return document;
}

function writeTagTaxonomy(document) {
  validateTagTaxonomy(document);
  document.concept_count = document.concepts.length;
  document.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(tagTaxonomyPath), { recursive: true });
  if (fs.existsSync(tagTaxonomyPath)) fs.copyFileSync(tagTaxonomyPath, tagTaxonomyBackupPath);
  const tmp = `${tagTaxonomyPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, tagTaxonomyPath);
  return document;
}



  return { read: readTagTaxonomy, write: writeTagTaxonomy, warnings: () => [...legacyWarnings] };
}
