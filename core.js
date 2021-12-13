const path = require('path');
const propertiesFormatParser = require('properties-parser');
const { Octokit } = require("octokit");
const { JsonDiffer } = require('json-difference');
const jsondifference = new JsonDiffer();

const LANG_ISO_PLACEHOLDER = '%LANG_ISO%';

let _context;
let _lokalise;
let _fs;
let _octokitUrl;
let _octokit;


// TODO skip merge commits, but take newest version of files as a previous contents
module.exports = async (context, { LokaliseApi, fs }) => {
  _context = context;
  _lokalise = new LokaliseApi({ apiKey: context.apiKey });
  _fs = fs;
  _octokit = new Octokit({ auth: _context.repoToken });
  _octokitUrl = `/repos/${_context.repository}`

  const { data: compareResult } = await _octokit.request(_octokitUrl + '/compare/master...{ref}', { ref: context.ref });

  if (compareResult.ahead_by === 0) {
    return "No ahead commits";
  }

  const diffSequence = await composeDiffSequence(compareResult);

  if (!Object.keys(diffSequence).length) {
    return "No changes in i18n files found"; // should never appear and be prevented by workflow rules
  }

  const keysToCreate = {};
  const keysToUpdate = {};
  const keysToDelete = [];

  composeActionsFromDiffSequence(diffSequence, keysToCreate, keysToUpdate, keysToDelete);

  const createRequest = buildLokaliseCreateKeysRequest(keysToCreate);

  const failedToCreateKeys = [];
  if (createRequest.length > 0) {
    console.log(`Pushing ${createRequest.length} new keys to Lokalise`);
    const createResult = await _lokalise.keys.create(createRequest, { project_id: _context.projectId });
    createResult.items.forEach(keyObj => {
      delete keysToUpdate[keyObj.key_name[_context.platform]]
    });
    failedToCreateKeys.push(...createResult.errors.filter(e => e.message === 'This key name is already taken').map(e => e.key_name[_context.platform]));
    // TODO handle other errors? Are there any?
    console.log(`Push done! Success: ${createResult.items.length}; error: ${createResult.errors.length}.`);
  }

  const keysToUpdateList = [...new Set(Object.keys(keysToUpdate).concat(failedToCreateKeys))];
  if (keysToUpdateList.length) {
    const keysToUpdateData = await _lokalise.keys.list({
      project_id: _context.projectId,
      filter_platforms: _context.platform,
      include_translations: 1,
      limit: 5000,
      filter_keys: keysToUpdateList.toString()
    });

    const translationsIds = keysToUpdateData.items.reduce((memo, keyObj) => {
      const key = keyObj.key_name[_context.platform];
      memo[key] = keyObj.translations.reduce((memo1, translationObj) => {
        if (translationObj.translation === keysToUpdate[key][translationObj.language_iso]) {
          delete keysToUpdate[key][translationObj.language_iso];
        }
        memo1[translationObj.language_iso] = translationObj.translation_id;
        return memo1;
      }, {});
      return memo;
    }, {});

    Object.keys(keysToUpdate).filter(key => !Object.keys(keysToUpdate[key]).length).forEach(key => delete keysToUpdate[key]);

    if (Object.keys(keysToUpdate).length) {
      console.log(`Updating translations for following keys on Lokalise: ${Object.keys(keysToUpdate).toString()}`)
      for (const key in keysToUpdate) {
        for (const language in keysToUpdate[key]) {
          await _lokalise.translations.update(
              translationsIds[key][language],
              { translation: keysToUpdate[key][language] },
              { project_id: _context.projectId }
          );
        }
      }
      console.log('Update is done!');
    }
  }

  if (keysToDelete.length) {
    const keysToDeleteData = await _lokalise.keys.list({
      project_id: _context.projectId,
      filter_platforms: _context.platform,
      limit: 5000,
      filter_keys: keysToDelete.toString()
    });

    const keyIdsToDelete = keysToDeleteData.items.map(keyObj => keyObj.key_id);
    console.log(`Deleting ${keysToDelete.length} keys from Lokalise`);
    await _lokalise.keys.bulk_delete(keyIdsToDelete, { project_id: _context.projectId });
    console.log(`Delete request is done!`);
  }
}

async function composeDiffSequence(compareResult) {
  const filenamePattern = new RegExp(_context.filename.replace(LANG_ISO_PLACEHOLDER, '(\\w\\w)').substr(1));

  const diffSequence = {};
  // const filesContent = {};
  const previousContents = {};
  for (const commit of compareResult.commits) {
    const { data: commitResult } = await _octokit.request(_octokitUrl + '/commits/{sha}', {
      sha: commit.sha
    });
    const i18nFiles = commitResult.files.filter(file => filenamePattern.test(file.filename));

    for (const file of i18nFiles) {
      const language = file.filename.match(filenamePattern)[1];

      const jsonFileContent = await getFileContent(file.filename, commit.sha).catch((e) => {
        if (e.name === 'SyntaxError') {
          return null;
        }
        throw e;
      });
      if (!jsonFileContent) {
        continue;
      }

      // filesContent[commit.sha] ||= {};
      // filesContent[commit.sha][language] ||= jsonFileContent;

      const parentSha = commit.parents[0].sha;
      const jsonPreviousContent = previousContents[language] || await getFileContent(file.filename, parentSha);

      const jsonDifferenceResult = jsondifference.getDiff(jsonPreviousContent, jsonFileContent);
      if (Object.keys(jsonDifferenceResult.new).length ||
          Object.keys(jsonDifferenceResult.removed).length ||
          jsonDifferenceResult.edited.length) {
        if (!diffSequence[language]) {
          diffSequence[language] = [];
        }
        diffSequence[language].push(jsonDifferenceResult);
      }

      previousContents[language] = jsonFileContent;
    }
  }

  return diffSequence;
}

async function getFileContent(path, ref) {
  const { data: fileContent } = await _octokit.request(_octokitUrl + '/contents/{path}?ref={ref}', {
    path, ref, headers: { accept: 'application/vnd.github.VERSION.raw' }
  });

  if (_context.format === 'properties') {
    return propertiesFormatParser.parse(fileContent);
  } else {
    return JSON.parse(fileContent);
  }
}

function composeActionsFromDiffSequence (diffSequence, keysToCreate, keysToUpdate, keysToDelete) {
  Object.keys(diffSequence).forEach(language => {
    const fileDiffSequence = diffSequence[language];
    fileDiffSequence.forEach(change => {
      Object.keys(change.new).forEach(key => {
        const normalizedKey = normalizeKey(key);
        if (!keysToCreate[normalizedKey]) {
          keysToCreate[normalizedKey] = {};
        }
        keysToCreate[normalizedKey][language] = change.new[key];
        if (!keysToUpdate[normalizedKey]) {
          keysToUpdate[normalizedKey] = {};
        }
        keysToUpdate[normalizedKey][language] = change.new[key];
      });
      change.edited.forEach(edited => {
        const key = Object.keys(edited)[0];
        const normalizedKey = normalizeKey(key);
        if ((keysToCreate[normalizedKey] || {})[language]) {
          keysToCreate[normalizedKey][language] = edited[key].newvalue;
        } else {
          if (!keysToUpdate[normalizedKey]) {
            keysToUpdate[normalizedKey] = {};
          }
          keysToUpdate[normalizedKey][language] = edited[key].newvalue;
        }
      });
      Object.keys(change.removed).forEach(key => {
        key = normalizeKey(key);
        if ((keysToCreate[key] || {})[language] !== undefined) {
          delete keysToCreate[key][language];
          delete keysToUpdate[key][language];
        }
        keysToDelete.push(key);
      })
    });
  });
}

function buildLokaliseCreateKeysRequest (toCreate) {
  console.log('Keys to push:');
  const uploadKeys = [];
  const filename = _context.useFilepath === 'true' ? path.join(_context.rawDirectory, _context.filename) : _context.filename;
  Object.keys(toCreate).forEach(key => {
    console.log('    ' + key);
    const lokaliseKey = {
      key_name: key,
      platforms: [_context.platform],
      translations: [],
      filenames: {
        [_context.platform]: _context.debugFilename || filename
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

function normalizeKey (key) {
  return _context.format === 'json' ? key.split('/').join('::') : key;
}
