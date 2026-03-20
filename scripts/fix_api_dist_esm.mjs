#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const targetDir = process.argv[2];

if (!targetDir) {
  console.error('usage: node scripts/fix_api_dist_esm.mjs <dist-dir>');
  process.exit(1);
}

const root = path.resolve(targetDir);

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`dist dir not found: ${root}`);
  process.exit(1);
}

const shouldRewrite = (specifier) => {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return false;
  }
  if (specifier.endsWith('.js') || specifier.endsWith('.mjs') || specifier.endsWith('.cjs') || specifier.endsWith('.json')) {
    return false;
  }
  if (specifier.includes('?') || specifier.includes('#')) {
    return false;
  }
  return true;
};

const rewriteSpecifiers = (source) => {
  let changed = false;
  const patterns = [
    /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
    /(import\s+['"])(\.\.?\/[^'"]+)(['"])/g,
  ];

  let next = source;
  for (const pattern of patterns) {
    next = next.replace(pattern, (full, prefix, specifier, suffix) => {
      if (!shouldRewrite(specifier)) {
        return full;
      }
      changed = true;
      return `${prefix}${specifier}.js${suffix}`;
    });
  }
  return { changed, content: next };
};

const walk = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }
    const original = fs.readFileSync(fullPath, 'utf8');
    const rewritten = rewriteSpecifiers(original);
    if (rewritten.changed) {
      fs.writeFileSync(fullPath, rewritten.content, 'utf8');
    }
  }
};

walk(root);
console.log(`fixed esm specifiers in ${root}`);
