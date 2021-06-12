const path = require('path');
const fs = require('fs');
const core = require('./core');
const ghCore = require('@actions/core');
const { LokaliseApi } = require('@lokalise/node-api');

const apiKey = ghCore.getInput('api-token');
const projectId = ghCore.getInput('project-id');
const directory = ghCore.getInput('directory');
const format = ghCore.getInput('format');
const platform = ghCore.getInput('platform');
const filename = ghCore.getInput('filename');
const ref = ghCore.getInput('ref');

core({
  apiKey,
  projectId,
  directory: path.join(process.env.GITHUB_WORKSPACE, directory),
  format,
  platform,
  filename,
  ref
}, {
  LokaliseApi,
  fs
})
.then((result) => {
  ghCore.setOutput('result', JSON.stringify(result));
})
.then(() => console.log('Finished'))
.catch(error => ghCore.setFailed(error ? error.message : 'Unknown error'))
