import { guessMime } from './mime.js';

export async function collectLocalFolder(fileList, onProgress = () => {}) {
  const files = Array.from(fileList);
  if (files.length === 0) throw new Error('No files selected');

  const rootName = files[0].webkitRelativePath.split('/')[0];
  if (!rootName) throw new Error('Could not determine folder name');

  const nappId = `local-${slug(rootName)}`;
  const out = [];
  let i = 0;
  for (const file of files) {
    i++;
    const relative = file.webkitRelativePath.slice(rootName.length);
    const path = relative.startsWith('/') ? relative : `/${relative}`;
    onProgress(`Reading ${i}/${files.length}: ${path}`);
    const mime = file.type || guessMime(path);
    out.push({ path, body: file, mime });
  }

  return { nappId, files: out };
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
