var path = require('path');
var packagePathTrimLength = '/package.json'.length;

function packagePathForPackageFile(packageFilepath) {
  packageFilepath.slice(0, packageFilepath.length - packagePathTrimLength);
}

function packageFileForPackagePath(packagePath) {
  return path.join(packagePath, 'package.json');
}

module.exports = {
  packageFileForPackagePath,
  packagePathForPackageFile,
};
