const Ftp = require('jsftp');
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const deployConfig = require('./deploy-config.json');

const [
  _nodePath,
  _scriptPath,
  targetEnvironment
] = process.argv;

const validTargetEnvironments = ['uat', 'prod'];

deploy()
  .catch(e => {
    console.error(e);
    process.exit(1);
  });

async function deploy() {
  if (!validTargetEnvironments.includes(targetEnvironment)) {
    console.error(`Usage:\n   npm run deploy {${validTargetEnvironments.join('|')}}`);
    return;
  }

  const deployConfigForEnvironment = deployConfig[targetEnvironment];

  if (!deployConfigForEnvironment) {
    console.error(`Deploy config for environment "${targetEnvironment}" not found`);
    return;
  }

  const {
    ftpPath,
    ftpOptions
  } = deployConfigForEnvironment;

  const ftp = new Ftp(ftpOptions);

  const deployIgnore = new Set(
    fs.readFileSync('./public/.deploy-ignore', 'utf8')
      .split(/\r?\n/g)
      .map(f => path.resolve('./public/', f)));

  const publicFiles = await findFiles('./public/*.*');
  const filesToDeploy = publicFiles.filter(f => !deployIgnore.has(f));

  for (const f of filesToDeploy) {
    const relativePath = path.relative('./public', f);
    const sourcePath = path.join('./public', relativePath);
    const targetPath = path.join(ftpPath, relativePath).replace(/\\/g, '/');
    console.log(`Uploading "${sourcePath}" to "${targetPath}"`);
    await put(ftp, sourcePath, targetPath);
  }

  console.log('Done');
  process.exit(0);
}

function put(ftp, sourceFilename, targetFilename) {
  return new Promise((resolve, reject) => fs.readFile(sourceFilename, (err, data) => err
    ? reject(err)
    : ftp.put(data, targetFilename, err => err
      ? reject(err)
      : resolve())))
}

function findFiles(dir) {
  return new Promise((resolve, reject) =>
    glob(dir, (err, matches) => err
      ? reject(err)
      : resolve(matches.map(m => path.resolve(m)))));
}