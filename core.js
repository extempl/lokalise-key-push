const path = require('path');
const jsonFormatParser = require('./json-format-parser');
const propertiesFormatParser = require('./properties-format-parser');

const LANG_ISO_PLACEHOLDER = '%LANG_ISO%';

let _context;
let _lokalise;
let _fs;

module.exports = async (context, { LokaliseApi, fs }) => {
  _context = context;
  _lokalise = new LokaliseApi({ apiKey: context.apiKey });
  _fs = fs;
  
  const remoteKeys = await getRemoteKeys();
  console.log(`${remoteKeys.length} remote keys.`);

  const localKeys = await getLocalKeys();

  const keysToCreate = getKeysToCreate(localKeys, remoteKeys);

  const createRequest = buildLokaliseCreateKeysRequest(keysToCreate);
  
  if (createRequest.length > 0) {
    console.log(`Pushing ${createRequest.length} new keys to Lokalise`);
    await _lokalise.keys.create(createRequest, { project_id: _context.projectId });
    console.log('Push done!');
    return keysToCreate;
  }
}

function buildLokaliseCreateKeysRequest (toCreate) {
  console.log('Keys to push:');
  const uploadKeys = [];
  Object.keys(toCreate).forEach(key => {
    console.log('    ' + key);
    const lokaliseKey = {
      key_name: key,
      platforms: [_context.platform],
      translations: [],
      filenames: {
        [_context.platform]: _context.filename
      }
    };
    if (_context.ref) {
      lokaliseKey.tags = [_context.ref];
    }
    Object.keys(toCreate[key]).forEach(lang => {
      console.log(`        ${lang}: ${toCreate[key][lang]}`);
      lokaliseKey.translations.push({
        language_iso: lang,
        translation: toCreate[key][lang]
      });
    });
    uploadKeys.push(lokaliseKey);
  });
  return uploadKeys;
}

function getKeysToCreate (localKeys, remoteKeys) {
  const toCreate = {};
  Object.keys(localKeys).forEach(lang => {
    localKeys[lang].forEach(({ key, value }) => {
      const keyExists = remoteKeys.some(x => x.key_name[_context.platform] === key);
      if (!keyExists) {
        if (!(key in toCreate)) {
          toCreate[key] = {};
        }
        toCreate[key][lang] = value;
      }
    })
  })
  return toCreate;
}

async function getLocalKeys () {
  const languageCodes = await getLanguageISOCodes();
  console.log('Project language codes', languageCodes);

  const languageKeys = {};

  const readFilePromises = languageCodes.map(async (lang) => {
    try {
      const data = await readLanguageFile(lang);
      let pairs;
      switch (_context.format) {
        case 'json':
          pairs = jsonFormatParser(data);
          break;
        case 'properties':
          pairs = propertiesFormatParser(data);
          break;
        default:
          throw new Error('No parser found for format');
      }
      console.log(`Found ${pairs.length} keys in language file for '${lang}'`);
      languageKeys[lang] = pairs;
    } catch (error) {
      console.error(`Error reading language file ${lang}: ${error.message}`)
    }
  })

  await Promise.all(readFilePromises);
  return languageKeys;
}

async function getRemoteKeys () {
  const {
    projectId,
    platform,
  } = _context;

  const loadMore = async (page = 1) => await _lokalise.keys.list({
    project_id: projectId,
    filter_platforms: platform,
    page,
    limit: 5000
  });

  let keys = [];

  let newKeys;

  for (let page = 1; !newKeys || newKeys.hasNextPage(); page++) {
    newKeys = await loadMore(page);
    keys = keys.concat(newKeys.items);
  }

  return keys;
}

function buildLanguageFilePath (languageCode) {
  return path.join(_context.directory, _context.filename.replace(LANG_ISO_PLACEHOLDER, languageCode))
}

async function getLanguageISOCodes () {
  const languages = await _lokalise.languages.list({
    project_id: _context.projectId
  });
  return languages.items.map(x => x.lang_iso);
}

function readLanguageFile (lang) {
  const path = buildLanguageFilePath(lang);
  return new Promise((resolve, reject) => {
    _fs.readFile(path, 'utf-8', (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      console.log('Read language file ' + path);
      resolve(data);
    });
  })
}
