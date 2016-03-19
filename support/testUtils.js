var path = require('path');
var execFile = require('child_process').execFile;
var xtend = require('xtend');
var rimraf = require('rimraf');

var projectRoot = path.resolve(__dirname, '../');

// TODO: move this somewhere better
var testOutputDir = path.join(projectRoot, 'example/output/test/build');

// mtime resolution can be 1-2s depending on OS
// should wait that long between test builds
// TODO: investigate this
var minMtimeResolution = 2000;

function waitForMtimeTick(done) {
  setTimeout(done, minMtimeResolution);
}

function cleanupTestOutputDir(done) {
  rimraf(testOutputDir, {disableGlob: true}, function(err) {
    if (err) done(err);

    execFile('mkdir', ['-p', testOutputDir], function(err) {
      if (err) done(err);
      done();
    });
  });
}

function makeBrowserify() {
  var browserify = require('browserify');
  var browserifyCache = require('../');

  var opts = xtend({cacheFile: path.join(testOutputDir, 'cache.json')}, browserifyCache.args);

  var b = browserify(opts);
  browserifyCache(b);

  return b;
}

module.exports = {
  waitForMtimeTick,
  minMtimeResolution,
  testOutputDir,
  projectRoot,
  cleanupTestOutputDir,
  makeBrowserify,
};
