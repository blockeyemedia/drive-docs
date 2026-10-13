const { google } = require('googleapis');
const config = require('./config');

let clients;
function getClients() {
  if (clients) return clients;
  if (!config.serviceAccountJson || !config.outputFolderId) throw new Error('Google Drive credentials or output folder are not configured');
  let key;
  try { key = JSON.parse(config.serviceAccountJson); }
  catch { key = JSON.parse(Buffer.from(config.serviceAccountJson, 'base64').toString('utf8')); }
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
  clients = {
    drive: google.drive({ version: 'v3', auth }),
    docs: google.docs({ version: 'v1', auth }),
    slides: google.slides({ version: 'v1', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
  };
  return clients;
}

async function listChildren(drive, parentId) {
  const files = [];
  let pageToken;
  do {
    const result = await drive.files.list({
      q: `'${parentId.replaceAll("'", "\\'")}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,webViewLink)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(result.data.files || []));
    pageToken = result.data.nextPageToken;
  } while (pageToken);
  return files;
}

function flattenFields(fields, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(fields || {})) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenFields(value, fullKey, out);
    else if (value !== null && value !== undefined) out[fullKey] = String(value);
  }
  return out;
}

function officeMime(mime) {
  return new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]).has(mime);
}

function textMime(mime) {
  return ['text/plain', 'text/csv', 'text/html', 'application/json', 'application/xml'].includes(mime);
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function replaceTokens(text, values) {
  let output = text;
  for (const [key, value] of Object.entries(values)) {
    const names = new Set([key, key.split('.').at(-1)]);
    for (const name of names) {
      for (const marker of [`{{${name}}}`, `[[${name}]]`]) {
        output = output.replaceAll(marker, value);
      }
    }
  }
  return output;
}

async function readResponseStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function replaceOfficeFile(clients, file, payload) {
  if (!officeMime(file.mimeType) && !textMime(file.mimeType)) return;
  const values = flattenFields({
    ...payload.customFields,
    ...payload.brand,
    ...Object.fromEntries(Object.entries(payload.images || {}).map(([k, v]) => [`image.${k}`, v])),
  });
  const response = await clients.drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
  const original = await readResponseStream(response.data);
  let output;
  if (textMime(file.mimeType)) {
    output = Buffer.from(replaceTokens(original.toString('utf8'), values), 'utf8');
    if (output.equals(original)) return;
  } else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const PizZip = require('pizzip');
    const Docxtemplater = require('docxtemplater');
    const doc = new Docxtemplater(new PizZip(original), {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{{', end: '}}' },
      nullGetter: () => '',
    });
    doc.render(values);
    output = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  } else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const XlsxPopulate = require('xlsx-populate');
    const workbook = await XlsxPopulate.fromDataAsync(original);
    let changed = false;
    for (const sheet of workbook.sheets()) {
      const used = sheet.usedRange();
      if (!used) continue;
      used.forEach(cell => {
        const value = cell.value();
        if (typeof value === 'string') {
          const replaced = replaceTokens(value, values);
          if (replaced !== value) {
            cell.value(replaced);
            changed = true;
          }
        }
      });
    }
    if (!changed) return;
    output = await workbook.outputAsync();
  } else {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(original);
    const xmlFiles = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    let changed = false;
    for (const name of xmlFiles) {
      let xml = await zip.file(name).async('string');
      const replaced = xml.replace(/(<a:t(?:\s[^>]*)?>)([\s\S]*?)(<\/a:t>)/g, (_m, open, text, close) => `${open}${escapeXml(replaceTokens(text, values))}${close}`);
      if (replaced !== xml) {
        zip.file(name, replaced);
        changed = true;
      }
    }
    if (!changed) return;
    output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
  const { Readable } = require('node:stream');
  await clients.drive.files.update({
    fileId: file.id,
    media: { mimeType: file.mimeType, body: Readable.from(output) },
    supportsAllDrives: true,
  });
}

async function replacePlaceholders(clients, copiedFile, payload) {
  const values = flattenFields({
    ...payload.customFields,
    ...payload.brand,
    ...Object.fromEntries(Object.entries(payload.images || {}).map(([k, v]) => [`image.${k}`, v])),
  });
  const requests = Object.entries(values).flatMap(([key, value]) => {
    const names = new Set([`{{${key}}}`, `[[${key}]]`]);
    const shortName = key.split('.').at(-1);
    names.add(`{{${shortName}}}`);
    return [...names].map(find => ({ replaceAllText: { containsText: { text: find, matchCase: true }, replaceText: value } }));
  });
  const mime = copiedFile.mimeType;
  if (mime === 'application/vnd.google-apps.document') {
    if (requests.length) await clients.docs.documents.batchUpdate({ documentId: copiedFile.id, requestBody: { requests } });
    await replaceDocImages(clients, copiedFile.id, payload.images);
    await replaceDocColors(clients, copiedFile.id, payload.brand);
  } else if (mime === 'application/vnd.google-apps.presentation') {
    if (requests.length) await clients.slides.presentations.batchUpdate({ presentationId: copiedFile.id, requestBody: { requests } });
  } else if (mime === 'application/vnd.google-apps.spreadsheet') {
    if (!requests.length) return;
    const findReplaceRequests = Object.entries(values).flatMap(([key, value]) => {
      const names = new Set([`{{${key}}}`, `[[${key}]]`, `{{${key.split('.').at(-1)}}}`]);
      return [...names].map(find => ({ findReplace: { find, replacement: value, allSheets: true, matchCase: true } }));
    });
    await clients.sheets.spreadsheets.batchUpdate({ spreadsheetId: copiedFile.id, requestBody: { requests: findReplaceRequests } });
  }
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`Invalid brand color: ${hex}`);
  return { red: parseInt(clean.slice(0, 2), 16) / 255, green: parseInt(clean.slice(2, 4), 16) / 255, blue: parseInt(clean.slice(4, 6), 16) / 255 };
}

function rgbMatches(color, hex) {
  if (!color?.rgbColor) return false;
  const expected = hexToRgb(hex);
  return ['red', 'green', 'blue'].every(key => Math.abs((color.rgbColor[key] ?? 0) - expected[key]) < 0.008);
}

const COLOR_MARKERS = {
  primary: '#EFEFEF', secondary: '#E9E9E9', accent: '#F0F0F0',
  primaryForeground: '#333333', secondaryForeground: '#404040', accentForeground: '#2E2E2E',
};

async function replaceDocColors(clients, docId, brand) {
  const doc = (await clients.docs.documents.get({ documentId: docId, includeTabsContent: true })).data;
  const dynamic = Object.fromEntries(Object.entries(brand || {}).filter(([key]) => COLOR_MARKERS[key]).map(([key, value]) => [key, hexToRgb(value)]));
  if (!Object.keys(dynamic).length) return;
  const requests = [];
  const visit = (content, tabId) => {
    for (const structural of content || []) {
      for (const item of structural.paragraph?.elements || []) {
        if (!item.textRun || item.startIndex == null || item.endIndex == null) continue;
        for (const [name, marker] of Object.entries(COLOR_MARKERS)) {
          if (dynamic[name] && rgbMatches(item.textRun.textStyle?.foregroundColor?.color, marker)) {
            requests.push({ updateTextStyle: { range: { startIndex: item.startIndex, endIndex: item.endIndex, ...(tabId ? { tabId } : {}) }, textStyle: { foregroundColor: { color: { rgbColor: dynamic[name] } } }, fields: 'foregroundColor' } });
            break;
          }
        }
      }
      if (structural.table) {
        structural.table.tableRows?.forEach((row, rowIndex) => row.tableCells?.forEach((cell, columnIndex) => {
          for (const [name, marker] of Object.entries(COLOR_MARKERS)) {
            if (dynamic[name] && rgbMatches(cell.tableCellStyle?.backgroundColor?.color, marker)) {
              requests.push({ updateTableCellStyle: {
                tableRange: { tableCellLocation: { tableStartLocation: { index: structural.startIndex, ...(tabId ? { tabId } : {}) }, rowIndex, columnIndex }, rowSpan: 1, columnSpan: 1 },
                tableCellStyle: { backgroundColor: { color: { rgbColor: dynamic[name] } } }, fields: 'backgroundColor',
              } });
              break;
            }
          }
          visit(cell.content, tabId);
        }));
      }
    }
  };
  if (doc.tabs?.length) doc.tabs.forEach(tab => visit(tab.documentTab?.body?.content, tab.tabProperties?.tabId));
  else visit(doc.body?.content, undefined);
  for (let i = 0; i < requests.length; i += 100) {
    await clients.docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: requests.slice(i, i + 100) } });
  }
}

async function replaceDocImages(clients, docId, images) {
  if (!images || !Object.keys(images).length) return;
  const doc = (await clients.docs.documents.get({ documentId: docId, includeTabsContent: true })).data;
  const requests = [];
  const visit = (content, inlineObjects, tabId) => {
    for (const structural of content || []) {
      for (const element of structural.paragraph?.elements || []) {
        const objectId = element.inlineObjectElement?.inlineObjectId;
        const embedded = objectId && inlineObjects?.[objectId]?.inlineObjectProperties?.embeddedObject;
        if (!embedded) continue;
        const candidates = [embedded.title, embedded.description].filter(Boolean).map(value => value.trim());
        const url = candidates.map(tag => images[tag]).find(value => typeof value === 'string' && /^https?:\/\//i.test(value));
        if (url) requests.push({ replaceImage: { imageObjectId: objectId, uri: url, imageReplaceMethod: 'CENTER_CROP', ...(tabId ? { tabId } : {}) } });
      }
      for (const row of structural.table?.tableRows || []) for (const cell of row.tableCells || []) visit(cell.content, inlineObjects, tabId);
    }
  };
  if (doc.tabs?.length) {
    for (const tab of doc.tabs) visit(tab.documentTab?.body?.content, tab.documentTab?.inlineObjects, tab.tabProperties?.tabId);
  } else visit(doc.body?.content, doc.inlineObjects, undefined);
  for (let i = 0; i < requests.length; i += 100) {
    await clients.docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: requests.slice(i, i + 100) } });
  }
}

async function copyTree(clients, jobId, sourceId, destinationParent, payload, filesOut, relative = '') {
  const children = await listChildren(clients.drive, sourceId);
  for (const source of children) {
    const name = source.name || source.id;
    if (source.mimeType === 'application/vnd.google-apps.folder') {
      const folder = await clients.drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [destinationParent] },
        fields: 'id,name,mimeType,webViewLink', supportsAllDrives: true,
      });
      await copyTree(clients, jobId, source.id, folder.data.id, payload, filesOut, pathJoin(relative, name));
      continue;
    }
    const existing = await clients.drive.files.list({
      q: `'${destinationParent}' in parents and appProperties has { key='driveDocJobId' and value='${jobId}' } and appProperties has { key='driveDocSourceId' and value='${source.id}' } and trashed = false`,
      fields: 'files(id,name,mimeType,webViewLink)', pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const copied = existing.data.files?.length ? { data: existing.data.files[0] } : await clients.drive.files.copy({
      fileId: source.id,
      requestBody: { name, parents: [destinationParent], appProperties: { driveDocJobId: jobId, driveDocSourceId: source.id } },
      fields: 'id,name,mimeType,webViewLink', supportsAllDrives: true,
    });
    await replaceOfficeFile(clients, copied.data, payload);
    await replacePlaceholders(clients, copied.data, payload);
    filesOut.push({ id: copied.data.id, name: copied.data.name, path: relative, mimeType: copied.data.mimeType, webViewLink: copied.data.webViewLink || '' });
  }
}

function pathJoin(a, b) { return a ? `${a}/${b}` : b; }

function safeFolderSegments(folderPath, fallbackName) {
  const raw = String(folderPath || fallbackName || 'product').replaceAll('\\', '/');
  const parts = raw.split('/').map(part => part.trim()).filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..')) throw new Error('Invalid zipMapping folder path');
  return parts.map(part => part.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120) || 'product');
}

async function getOrCreateFolder(drive, parentId, name) {
  const escapedName = name.replaceAll("'", "\\'");
  const result = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name,webViewLink)', pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  if (result.data.files?.length) return result.data.files[0];
  return (await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id,name,webViewLink', supportsAllDrives: true,
  })).data;
}

async function generateDriveFiles(jobId, payload, onProgress) {
  const clients = getClients();
  const escapedId = jobId.replaceAll("'", "\\'");
  const prior = await clients.drive.files.list({
    q: `'${config.outputFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='driveDocJobId' and value='${escapedId}' } and trashed = false`,
    fields: 'files(id,name,webViewLink)', pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  const folder = prior.data.files?.length
    ? { data: prior.data.files[0] }
    : await clients.drive.files.create({
      requestBody: { name: `job-${jobId}`, mimeType: 'application/vnd.google-apps.folder', parents: [config.outputFolderId], appProperties: { driveDocJobId: jobId } },
      fields: 'id,name,webViewLink', supportsAllDrives: true,
    });
  const filesOut = [];
  for (let i = 0; i < payload.templateIds.length; i++) {
    const templateId = payload.templateIds[i];
    const template = (await clients.drive.files.get({ fileId: templateId, fields: 'id,name,mimeType', supportsAllDrives: true })).data;
    if (template.mimeType !== 'application/vnd.google-apps.folder') throw new Error(`Template ID ${templateId} is not a Drive folder`);
    const segments = safeFolderSegments(payload.zipMapping?.[templateId], template.name);
    let productFolder = folder.data;
    for (const segment of segments) productFolder = await getOrCreateFolder(clients.drive, productFolder.id, segment);
    await copyTree(clients, jobId, templateId, productFolder.id, payload, filesOut, segments.join('/'));
    await onProgress({ total: payload.templateIds.length, completed: i + 1, currentTemplate: templateId, folderId: folder.data.id });
  }
  return { folder: folder.data, files: filesOut, clients };
}

module.exports = { getClients, generateDriveFiles, replaceOfficeFile };
